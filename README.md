# Agent Cockpit

A small control station for your Claude Code agents. It runs on your own PC and opens in the browser.

- **Projects.** A project is a folder plus the team of agents that works in it.
- **New agent.** Name it, pick a model and permission mode, launch. No terminal needed.
- **Both at once.** An agent runs in its own PowerShell window, where you see every detail, and you talk to it in the
  cockpit chat as well. A message you send in the cockpit is typed into the agent's window. This works for windows
  the cockpit opened (New agent, Open terminal, Wake all). While the agent is busy, Claude Code queues the message.
- **Live view of your terminals.** Named Claude Code sessions that run in a terminal in the project folder appear in
  the roster by themselves, with chat and status live. A window you opened yourself can be watched but not written
  to; close it and use Open terminal to get both.
- **One rule.** Every agent lives in its own terminal window. The cockpit opens the window, shows the chat, and
  writes by typing into the window. No agent runs inside the cockpit.
- **Sessions.** Every earlier session of the folder can be added to the roster. Open terminal continues it in its own window.
- **Terminal windows.** New agents start in a PowerShell window by default. Reopen any agent in one with Open terminal.
  The window runs the normal Claude Code, and the cockpit shows the same agent live.
- **Chat.** Live streaming answers and images (attach, paste or drop). Commands, file reads and other tool calls are
  folded into one line between the messages; click it, or use Show all steps, to see them. Messages from other agents
  are shown apart from your own.
- **Wake all.** One click opens a PowerShell window for every agent of the project that is not running, one window
  per agent. Each continues its session and waits for you. Agents that are already running are left alone.
- **Team.** All agents of the project in one list with checkboxes. Wake only the ones you tick, or remove several
  at once, for example every agent that has been idle for three days. Removed agents are not added again automatically.
- **Permissions.** Per agent or for a whole project in Settings: ask before edits and commands, accept edits, plan
  first, or allow everything. Allow everything means the agent runs any command and changes or deletes any file
  without asking. It starts Claude Code with `--dangerously-skip-permissions`. The first window that starts this way
  would show Claude Code's own warning; the cockpit passes Claude Code the setting that records your acceptance, so
  windows it opens start without that question.
- **Artifacts and files.** An artifact an agent publishes, or a file it sends you, shows as a card in the chat. A click
  opens it next to the chat: pages, images, video, audio, PDF and text. Every image, page or document an agent read
  or wrote has a Preview button in its step.
- **Broadcast.** In Team, send one message or command, such as `/clock-in`, to every ticked agent. An agent in a
  PowerShell window gets it typed into its window, if the cockpit opened that window and the agent is waiting for
  input. Busy agents are left out and named, so nothing is typed into a window that is asking a question.
- **Microphone.** The Mic button in the chat box dictates into the message box: click, speak, click again to stop.
  The words appear as you speak and nothing is sent until you send it. It uses the speech recognition built into the
  browser, so it works in Chrome and Edge, needs an internet connection, and the audio goes to that browser's speech
  service. The dictation language is set in the Aa menu.
- **Look.** The Aa button sets the theme (light, dark, midnight, paper, high contrast, or follow the PC) and the
  text size. The choice is kept per browser.
- **Status.** Agents are sorted by what needs you: Needs you, Ready to review, Working, Failed, Idle.
- **Stop.** Only on request. Close window closes the PowerShell window of an agent the cockpit opened. Interrupt
  presses Esc in it. The cockpit never closes a window you opened yourself.

## Start

You need Node.js 18 or newer (`node -v`).

On Windows, double-click **`start.cmd`**. The first start installs what it needs, then the cockpit opens at
http://localhost:4600/. It runs in the background without a window of its own.

**Closing a window stops nothing.** You can close the browser and the start window. Agents in PowerShell windows are
independent of the cockpit and keep running even when the cockpit is shut down. To stop the cockpit itself, click
**Shut down** in the page or run **`stop.cmd`**.

| Script | What it does |
|---|---|
| `start.cmd` | Starts the cockpit in the background and opens the page. Safe to run when it is already running |
| `stop.cmd` | Stops the cockpit. Agents in PowerShell windows keep running |
| `restart.cmd` | Stops and starts it again |
| `update.cmd` | Stops it, gets the newest version with `git pull`, and starts it again |

From a terminal instead:

```bash
npm install
```

```bash
npm start
```

Started this way from a terminal, the cockpit runs in that terminal and stops with Ctrl+C.

## Login

No API key is needed. The cockpit runs the same Claude Code engine you use in the terminal, and that engine
uses the Claude login already stored on this PC, which is your subscription.

- If this PC is not logged in yet, run `claude` once in a terminal, log in, and send the message again.
- The chat header shows which login an agent uses, for example `subscription · max`.
- An `ANTHROPIC_API_KEY` in your environment is **not** passed to the agents, so they cannot switch to
  pay-per-use billing by accident. Set `COCKPIT_ALLOW_API_KEY=1` only if you want that.


## How it works

- Each agent is one Claude Code session started in its project folder. It loads your normal settings,
  `CLAUDE.md`, skills and plugins (including ECC), exactly as `claude` does in that folder.
- Every agent is told its own name, the project it belongs to, and who its teammates are.
- The roster is saved in `data/roster.json` and the cockpit's own log in `data/cockpit.log`. Chat history is read from Claude Code's own session files,
  so nothing is lost when the cockpit restarts.
- An agent's process is closed after 20 idle minutes to save memory. It resumes on your next message.
- A watched agent is read from the session file Claude Code keeps on disk. Its status is derived from that file:
  Working while it writes, Ready to review when it ended its turn, Needs you when it asked a question or has been
  quiet for 90 seconds in the middle of a tool call, which often means an approval is waiting in the terminal.
- The cockpit talks to an agent in a terminal window by typing into that window. To avoid answering a question by
  accident, it does not type while the agent shows a question, or, unless the agent runs in allow-all mode, while it is
  busy or may be asking for a permission. It tells you why and lets you type anyway.
- A window you opened by hand is found by its command line, for example `claude --resume REBE` or
  `claude --name REBE`, within about 20 seconds. The cockpit then shows it as open and can type into it. It never
  closes such a window. Windows only.
- Before typing, the cockpit reads the agent's window. If it shows a question or a menu (Enter to confirm, Esc to
  cancel), it does not type and tells you so.
- Emoji cannot be typed into a Windows console: they arrive as broken characters. The cockpit leaves them out of
  typed messages. Accented letters work.
- An agent saved by an older version as "inside the cockpit" becomes a terminal agent with the same session. Click Open terminal on it.
- When you start a session again under the same name, or use `/clear`, the watched agent follows the newest session with that name.
- Removing an agent or a project only removes it from the cockpit. Folders and session files are never deleted.

## Settings

Set these before starting, as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `COCKPIT_PORT` | `4600` | Port of the web page |
| `COCKPIT_HOST` | `127.0.0.1` | Address to listen on. Leave it unless you want to reach the cockpit from another device |
| `COCKPIT_TOKEN` | none | Password. Required when `COCKPIT_HOST` is not local |
| `COCKPIT_DATA` | `./data` | Where the roster is stored |
| `COCKPIT_CLAUDE_ARGS` | none | Extra arguments added to `claude` when the cockpit opens a terminal window |
| `COCKPIT_TERMINAL` | window | `wt` opens agents as tabs in Windows Terminal (the cockpit then cannot type into them). On Linux and macOS, `tmux` runs each agent in a tmux session the cockpit can type into |
| `COCKPIT_SHELL` | `powershell.exe` | The shell the terminal window runs, for example `pwsh.exe` |
| `COCKPIT_IMPORT_DAYS` | `7` | Named sessions used within this many days are shown automatically |
| `COCKPIT_ALLOW_API_KEY` | off | Set to `1` to let agents use an API key from the environment |
| `COCKPIT_DEBUG` | off | Print the agents' diagnostic output in the server window |

## Safety

This page can make agents run commands on this PC. By default it only answers on this PC itself.
To open it from a phone or another computer, set both `COCKPIT_HOST=0.0.0.0` and a `COCKPIT_TOKEN`,
then open `http://<pc-address>:4600/?token=<your token>` once on that device. Never expose it to the open internet.

Use Open terminal on a session only after closing any other window that runs it: a session should be driven from one place at a time.

## Not in this version yet

Inbox, Wall view, the ECC tab, agent templates, broadcast, voice input and handoff files.
ECC commands already work by typing `/` in the message box.
