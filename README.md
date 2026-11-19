# Agent Cockpit

A small control station for your Claude Code agents. It runs on your own PC and opens in the browser.

- **Projects.** A project is a folder plus the team of agents that works in it.
- **New agent.** Name it, pick a model and permission mode, launch. No terminal needed.
- **Live view of your terminals.** Named Claude Code sessions that run in a terminal in the project folder appear in
  the roster by themselves. You see their chat and status live. The cockpit does not write to them.
- **Take over.** Close an agent in its terminal, click Take over, and it continues in the cockpit with its full history.
  Release hands it back to a terminal.
- **Sessions.** Every earlier session of the folder can be watched or taken over.
- **Chat.** Live streaming answers, images (attach, paste or drop), tool activity you can expand.
- **Approvals and questions.** Allow once, always allow, or deny. Answer questions with one click.
- **Status.** Agents are sorted by what needs you: Needs you, Ready to review, Working, Failed, Idle.
- **Context.** A meter per agent, a breakdown of what fills it, and a Compact button.
- **Stop.** Interrupt an agent in the middle of a turn.

## Start

You need Node.js 18 or newer (`node -v`).

On Windows, double-click **`start.cmd`**. The first start installs what it needs, then the cockpit opens at
http://localhost:4600/.

From a terminal instead:

```bash
npm install
```

```bash
npm start
```

Keep the window open while you use the cockpit. Agents keep running when you close the browser tab.

## Login

No API key is needed. The cockpit runs the same Claude Code engine you use in the terminal, and that engine
uses the Claude login already stored on this PC, which is your subscription.

- If this PC is not logged in yet, run `claude` once in a terminal, log in, and send the message again.
- The chat header shows which login an agent uses, for example `subscription · max`.
- An `ANTHROPIC_API_KEY` in your environment is **not** passed to the agents, so they cannot switch to
  pay-per-use billing by accident. Set `COCKPIT_ALLOW_API_KEY=1` only if you want that.

To use your installed Claude Code instead of the bundled one, set `COCKPIT_CLAUDE_PATH` to its full path.

## How it works

- Each agent is one Claude Code session started in its project folder. It loads your normal settings,
  `CLAUDE.md`, skills and plugins (including ECC), exactly as `claude` does in that folder.
- Every agent is told its own name, the project it belongs to, and who its teammates are.
- The roster is saved in `data/roster.json`. Chat history is read from Claude Code's own session files,
  so nothing is lost when the cockpit restarts.
- An agent's process is closed after 20 idle minutes to save memory. It resumes on your next message.
- A watched agent is read from the session file Claude Code keeps on disk. Its status is derived from that file:
  Working while it writes, Ready to review when it ended its turn, Needs you when it asked a question or has been
  quiet for 90 seconds in the middle of a tool call, which often means an approval is waiting in the terminal.
- When you start a session again under the same name, or use `/clear`, the watched agent follows the newest session with that name.
- Removing an agent or a project only removes it from the cockpit. Folders and session files are never deleted.

## Settings

Set these before starting, as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `COCKPIT_PORT` | `4600` | Port of the web page |
| `COCKPIT_HOST` | `127.0.0.1` | Address to listen on. Leave it unless you want to reach the cockpit from another device |
| `COCKPIT_TOKEN` | none | Password. Required when `COCKPIT_HOST` is not local |
| `COCKPIT_IDLE_MINUTES` | `20` | Close an idle agent process after this many minutes. `0` keeps them alive |
| `COCKPIT_DATA` | `./data` | Where the roster is stored |
| `COCKPIT_CLAUDE_PATH` | bundled | Path to a Claude Code executable to use instead of the bundled one |
| `COCKPIT_IMPORT_DAYS` | `7` | Named sessions used within this many days are shown automatically |
| `COCKPIT_ALLOW_API_KEY` | off | Set to `1` to let agents use an API key from the environment |
| `COCKPIT_DEBUG` | off | Print the agents' diagnostic output in the server window |

## Safety

This page can make agents run commands on this PC. By default it only answers on this PC itself.
To open it from a phone or another computer, set both `COCKPIT_HOST=0.0.0.0` and a `COCKPIT_TOKEN`,
then open `http://<pc-address>:4600/?token=<your token>` once on that device. Never expose it to the open internet.

Take over a session only after closing it in the terminal: a session should be driven from one place at a time.

## Not in this version yet

Inbox, Wall view, the ECC tab, agent templates, broadcast, voice input and handoff files.
ECC commands already work by typing `/` in the message box.
