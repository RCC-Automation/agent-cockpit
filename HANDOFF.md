# Handoff: Agent Cockpit

Written on 19 Nov 2026 by the agent that built this project in a cloud session, for the agent that continues
it on the owner's Windows PC. Read this whole file before changing anything.

## Why this handoff exists

The cockpit was built and tested in a Linux cloud container. The owner runs it on Windows. Every part that
opens, tracks or types into a PowerShell window was written **without ever running on Windows**, and those are
the parts the owner reports as not working. You are on the real machine, so you can run them, see the real
errors and fix them. That is your job.

## What the owner wants

In the owner's words, condensed:

- A light control station ("cockpit") for a team of Claude Code agents, as an alternative to the Claude app,
  which gets stuck for them.
- Agents are organised per **project** (a folder plus the team that works in it).
- **Each agent runs in its own, independent PowerShell window**, where the owner can see every detail.
- The owner wants to **chat with each agent in the cockpit as well**, and the Claude phone app must keep
  working on the same agents (it does, through Claude Code's Remote Control, as long as the agent is a normal
  Claude Code session in a terminal).
- **Closing the cockpit must never stop an agent.** Stopping is only ever an explicit button.
- Agents run on the owner's **Claude subscription login. Never on an API key.**
- Quick start of new agents, resume of earlier sessions, wake all or selected agents, remove idle agents,
  broadcast commands such as `/clock-in` and `/clock-out`, allow-all permissions, artifact and file preview,
  themes and text size.

The owner is not a programmer by trade in this conversation: write to them in plain language, say what to click
and what to run, and be explicit about what you tested and what you did not.

## The one design rule to move to

> **Every agent always lives in its own terminal window. The cockpit opens the window, shows the chat by
> reading the session file, and writes by typing into the window.**

The code still carries an older second model, "the agent runs inside the cockpit" (through the Claude Agent
SDK, no window). It exists because typing into a window came late. It is now the main source of confusion:
**Take over** moves an agent inside the cockpit, its window disappears, and the owner loses the agent they
were looking at. Step 1 below removes that model from the page.

## Your tasks, in order

### Step 1: simplify the page to the one rule

- Remove **Take over**, **Release**, and the "Inside the cockpit only" choice in New agent. A new agent always
  opens its own window.
- Agents that are currently `mode: 'own'` in a roster should become terminal agents (`mode: 'watch'`) on load,
  keeping their session id, so nobody is stranded.
- The per-agent actions become: **Open terminal** (when its window is closed), **Close window**, **Interrupt**,
  chat, **Remove**.
- An agent whose window the cockpit did not open stays watch-only, with a clear way to get both (close that
  window, click Open terminal). See "Ideas" for adopting such windows.
- Keep the SDK engine code in `server.mjs` until step 2 has shown that typing works on Windows. If it does,
  delete the engine (see "Code map") and the features that only exist there (approval cards, question cards,
  the context meter from `getContextUsage`). If typing cannot be made reliable, tell the owner before deciding.
- Update `README.md` to match.

### Step 2: make the Windows parts work, by running them

Work through "Windows test checklist" below. Fix what fails. Tell the owner the result of each item.

### Then

Ask the owner which of the open items in "Open decisions and ideas" they want next.

## How to work safely on this PC

The owner's real agents are running in PowerShell windows while you work. Do not disturb them.

- **Run your tests on a second cockpit**, never on the owner's running one:
  `COCKPIT_PORT=4700` and `COCKPIT_DATA=<a temp folder>`. In PowerShell:
  `$env:COCKPIT_PORT=4700; $env:COCKPIT_DATA="$env:TEMP\cockpit-test"; node server.mjs`
- **Use a throwaway test project folder** and your own test agents. Never open, close, or type into a window
  of one of the owner's agents. Never run `taskkill` on a process you did not start in the test.
- **Keep model use small.** Tests ran on the owner's subscription, and on 19 Nov Claude Code reported 95% of
  the weekly limit used. Use the `haiku` model and one-word replies for test turns.
- Typing into a window is only safe when that window is waiting at the Claude Code prompt. A window showing a
  question has a preselected answer, and Enter picks it. Two real examples: the folder trust question and the
  bypass-permissions warning both preselect **"No, exit"**.
- Commit small, with clear messages. Push when the owner asks or after a verified fix.

## Code map

Two files hold everything. No build step, one dependency (`@anthropic-ai/claude-agent-sdk`).

| File | What it is |
|---|---|
| `server.mjs` (about 1,540 lines) | One Node process: HTTP API, live events (SSE), roster, session watching, terminal windows, typing, broadcast, and the SDK engine |
| `public/index.html` (about 1,060 lines) | The whole page: styles, markup and plain JavaScript, no framework |
| `start.cmd`, `stop.cmd`, `restart.cmd`, `update.cmd` | Windows launchers. `start.cmd` runs the server hidden in the background |
| `data/` (not in git) | `roster.json`, `cockpit.log`, `allow-all.settings.json` |

Sections of `server.mjs`, in file order:

| Section | Notes |
|---|---|
| roster | `projects` and `agents` maps, saved to `data/roster.json`. Runtime state per agent in `rt(id)` |
| live events | `broadcast()` pushes SSE events: `agent`, `item`, `delta`, `reset`, `remove`, `project`, `commands`, `shutdown` |
| transcript to items | `itemsFromHistory()` turns a session's messages into chat items. `viewFiles()` and `serveView()` do file previews under `/view/…` |
| live view of sessions | `pollWatched()` follows a session file by size and time, `tailInfo()` reads what the session did last, `watchState()` derives Working / Ready to review / Needs you. `scanProjects()` adds named sessions and makes an agent follow the newest session with its name |
| terminal windows | `openTerminal()`, `checkWindows()`, `closeWindow()`, `claudeArgs()`, `allowAllSettingsFile()`. **Windows code here is untested** |
| engine | The SDK model: `startQuery()`, `handleMessage()`, `askUser()`, `sendMessage()`. Candidate for removal in step 1 |
| HTTP | `guard()` (loopback host check, origin check, optional token), routes, `uniqueName()`, `importNamed()` |
| broadcast and typing | `TYPE_HELPER` (C# compiled by PowerShell), `typeIntoWindows()`, `typeBlock()`, `typeToAgents()`, `broadcastTo()`. **Windows code here is untested** |
| start-up | `--stop`, `--ping`, `--wait` helper flags, `teeLog()`, `start()` with a retry for a port that is being released |

Agent record fields that matter: `mode` (`'watch'` = lives in a terminal, `'own'` = inside the cockpit),
`sessionId`, `title` (the Claude Code session name it follows), `permissionMode`, `term`
(`{ pid, started, image, alive, openedAt }` on Windows, `{ tmux, alive, openedAt }` with tmux).

Routes: `GET /api/health`, `/api/state`, `/api/events`, `/api/sessions`, `/api/folders`;
`POST /api/shutdown`, `/api/projects`, `/api/agents`; per project `POST /api/projects/:id`,
`…/import`, `…/wake`, `…/remove`, `…/broadcast`, and `DELETE /api/projects/:id`; per agent `GET items`,
`GET context`, `POST message`, `stop`, `interrupt`, `decision`, `settings`, `view`, `takeover`, `release`,
`terminal`, and `DELETE`.

Settings are environment variables, listed in `README.md`.

## What is verified, and how

Verified in the cloud container (Linux), against the real Claude Code 2.1.328:

- The Agent SDK runs sessions with the PC's Claude login. An `ANTHROPIC_API_KEY` in the environment is removed
  before agents start (`agentEnv()`), so they cannot fall back to API billing.
- Session files live in `~/.claude/projects/<folder>/<session id>.jsonl`. Lines of type `user` and `assistant`
  carry the conversation; `custom-title` carries the session name; `cost-state` the cost; `user` lines carry
  `permissionMode`. Reading them gives chat, status and the real permission mode.
- `claude --name X` names a session, and `listSessions()` returns that name as `customTitle`.
- **Typing into a real Claude Code screen works** (tested with tmux): type the text, wait about 0.6 s, press
  Enter. While the agent is busy, Claude Code queues the message and runs it next. Esc interrupts.
- **`--settings <file>` with `{"skipDangerousModePermissionPrompt": true}` removes the bypass-permissions
  warning.** Without it the warning appears on every start with "No, exit" preselected.
- Stop followed directly by start comes back (there was a race; `--stop` now waits until the port is free).
- Agents inside the cockpit stay there across a restart; one interrupted mid-turn offers Continue.
- A terminal (tmux session) the cockpit opened keeps running when the cockpit stops, and the cockpit finds it
  again after a restart.
- File preview: only folders of files an agent named in a tool call are served; agent-made pages are served
  with a `sandbox` content-security-policy so their scripts cannot call the cockpit's API.

Confirmed by the owner on Windows:

- `start.cmd` starts the cockpit and the page loads.
- Creating a project lists the folder's sessions; named sessions appear in the roster with live chat.
- A PowerShell window opens for an agent (their screenshot shows it hosted in **Windows Terminal**).

## Never run on Windows (written blind)

1. `openTerminal()`, Windows branch: `powershell -EncodedCommand` running `Start-Process … -PassThru` and
   returning `pid,startTime`. The owner did get a window, so the launch works, but pid and start time
   handling is unverified.
2. `checkWindows()`: decides "window open" by finding that pid with image `powershell.exe` in `tasklist`.
   Unverified with Windows Terminal as the host, where the visible window belongs to `WindowsTerminal.exe`.
3. `closeWindow()`: `taskkill /PID <pid> /T /F` after comparing the start time. Whether the Windows Terminal
   tab closes afterwards is unknown.
4. `TYPE_HELPER` and `typeIntoWindows()`: C# compiled with `Add-Type`, then `FreeConsole`, `AttachConsole(pid)`,
   `CreateFile("CONIN$")`, `WriteConsoleInput` with key events. **This is the heart of "chat from the cockpit"
   and it has never run.** Unknowns: whether it compiles under Windows PowerShell 5.1, whether attaching to a
   console hosted by Windows Terminal works, whether Claude Code accepts key events sent this way, whether the
   Enter after 600 ms submits.
5. `start.cmd` hidden background start, and whether windows opened by that hidden process stay when it exits.
6. `allowAllSettingsFile()` passed as `--settings '<path>'` through PowerShell quoting, especially a path with
   spaces.
7. `terminalScript()`: the PowerShell line that sets the title, changes folder and runs `claude`.

## What the owner reported as broken

- "Waking, taking control and so on is not working properly." No detail yet. Ask for it, or reproduce it.
- An agent "got lost": it turned into a Take over agent and its terminal was gone. Cause found and fixed in
  commit `eec2ae1`: every stop moved cockpit agents into terminal windows, and the new window sat on the
  bypass warning with "No, exit" preselected. Not re-verified on Windows.
- The bypass warning kept appearing. Fixed with the `--settings` file in commit `8fe0e2f`. Verified on Linux,
  not on Windows.

## Windows test checklist (step 2)

Use a second cockpit on port 4700 with its own data folder and a throwaway project.

1. **Start and stop.** `start.cmd` starts hidden; `node server.mjs --ping` returns 0; a second `start.cmd` only
   opens the page; `stop.cmd` stops it; `restart.cmd` comes back; `data\cockpit.log` is written.
2. **New agent.** A PowerShell window opens in the project folder running `claude --name <NAME>`. After the
   first message the roster entry attaches to the session (within about 15 s) and shows the chat.
3. **Window state.** The roster shows "window open". Close the window by hand: within about 10 s it shows
   "window closed". Check this with the default terminal set to Windows Terminal and to Windows Console Host.
4. **Close window** from the cockpit ends the agent and the tab or window goes away.
5. **Typing.** Send a chat message from the cockpit to a terminal agent. Check: the text arrives at the prompt,
   it is submitted, the reply shows in the cockpit. Then: a message while the agent is busy (expect "Queued"
   in the window), **Interrupt**, a message with accents and an emoji, a 2,000 character message, a slash
   command such as `/context` (watch what the command menu does with the Enter).
6. **Allow-all.** Set a test agent to "Allow everything", open its window: no warning screen, and the footer
   says bypass permissions is on. Repeat with a data folder whose path contains a space.
7. **Wake all and Team.** Several agents, some with open windows: only the sleeping ones get a window, one each.
8. **Broadcast.** A command to two waiting agents arrives in both windows.
9. **Independence.** Stop the cockpit: the agents' windows stay. Start it: the roster shows them as open.
10. **Phone.** With an agent in a cockpit-opened window, check with the owner that the Claude app still reaches
    it. Cockpit windows start plain `claude`; if the owner normally passes extra options, they belong in
    `COCKPIT_CLAUDE_ARGS`.

If `AttachConsole` typing cannot be made to work under Windows Terminal, options to try, in this order:
attach to the `claude` child process id instead of the PowerShell one; start windows with `conhost.exe`
explicitly; run each agent under a pseudo-console the cockpit owns (`node-pty`) and show the terminal in the
page. Tell the owner before choosing the last one, because it changes "its own PowerShell window".

## Things that tripped me up

- Playwright's `text=` and `has-text` match substrings. "Wake all" matched a button named "All", and a
  sentence containing "Open terminal" matched before the button. Use exact selectors.
- DOM `append(null)` writes the text "null". The page's `h()` helper filters nulls; direct `append` does not.
- A page-side `reset` event followed by a reload of items used to duplicate messages; `loadItems()` now shares
  one request and renders only into the thread it was started for.
- The cockpit's own tests (Playwright and shell scripts) lived in the cloud scratch folder and are **not in
  this repository**. There is no test suite here. Adding a small one for the server logic would pay off.
- On Linux and macOS, `COCKPIT_TERMINAL=tmux` gives a terminal the cockpit can type into. It is the only way
  the typing loop was tested end to end.

## Open decisions and ideas

- **Permanent teams.** The owner asked for a saved team they can talk to. Three concepts were presented and not
  yet chosen: (1) an address list, where a named group gets the same message; (2) a team room, one shared chat
  with answers collected and labelled; (3) a team with a lead agent who delegates. Recommended: save team
  definitions as seats in the project folder and build (1) first, shaped so (2) can sit on top.
- **Adopting windows the owner opened by hand**, so the cockpit can type into those too. Would need a way to map
  a running `claude` process to its session.
- **Context for terminal agents.** The context meter only exists for SDK agents. For terminal agents it could be
  computed from the `usage` fields in the session file.
- **From the first proposal, not built:** an inbox of everything waiting for the owner, a wall view, an ECC tab
  (the owner uses the Everything Claude Code plugin; fork at `RCC-Automation/ECC`), agent templates, voice
  input, handoff files (`/save-session`, `/resume-session`).
- **Queueing** a message for a busy terminal agent inside the cockpit and delivering it when the agent is free.

## Commit style

Imperative subject line, a short body saying what changed and why. Do not put model names in commits.
