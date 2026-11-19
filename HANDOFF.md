# Handoff: Agent Cockpit

Rewritten on 19 Nov 2026 by the agent that worked on the owner's Windows PC, for the agent that continues
with a fresh context. Read this whole file before changing anything.

The first version of this file was written by a cloud agent that had never run the Windows parts. They have
now been run on the owner's PC (Windows 11, Windows Terminal, Claude Code 2.1.329). What follows is what was
actually seen there.

## What the owner wants

In the owner's words, condensed:

- A light control station ("cockpit") for a team of Claude Code agents, as an alternative to the Claude app,
  which gets stuck for them.
- Agents are organised per **project** (a folder plus the team that works in it).
- **Each agent runs in its own, independent PowerShell window**, where the owner can see every detail.
- The owner wants to **chat with each agent in the cockpit as well**, and the Claude phone app must keep
  working on the same agents (through Claude Code's Remote Control, as long as the agent is a normal Claude
  Code session in a terminal).
- **Closing the cockpit must never stop an agent.** Stopping is only ever an explicit button.
- Agents run on the owner's **Claude subscription login. Never on an API key.**
- Quick start of new agents, resume of earlier sessions, wake all or selected agents, remove idle agents,
  broadcast commands such as `/clock-in` and `/clock-out`, allow-all permissions, artifact and file preview,
  themes and text size.

Write to the owner in plain, short language: what you did, whether it worked, what to click or run. Say
plainly what you tested and what you did not. When they are tired they do not want questions: give at most
two options and say which one you would take.

## The one design rule (now in place)

> **Every agent always lives in its own terminal window. The cockpit opens the window, shows the chat by
> reading the session file, and writes by typing into the window.**

The older second model, "the agent runs inside the cockpit" through the Agent SDK, is **gone**: Take over,
Release, the "Inside the cockpit only" choice and the whole SDK engine were removed. Every agent record has
`mode: 'watch'`. A roster entry saved by an old version as `mode: 'own'` is turned into a terminal agent on
load and keeps its session id.

## Windows test checklist: results

Run on a second cockpit on port 4700 with its own data folder, a throwaway project and test agents on the
`haiku` model. Host of the windows: **Windows Terminal** (this PC's default, "Let Windows decide").

| # | Item | Result | Notes |
|---|---|---|---|
| 1 | Start and stop | pass | `start.cmd` hidden start, `--ping` returns 0, a second `start.cmd` does not start a second server, `stop.cmd`, `restart.cmd`, `cockpit.log` written |
| 2 | New agent | pass | Window opens in the project folder with `claude --name <NAME>`. After the first message the roster entry attaches to the session and shows the chat |
| 3 | Window state | pass under Windows Terminal; **not run** under Windows Console Host | "Closed by hand" was simulated by ending the window's shell process, not by clicking X. Shown as closed within 10 s. Console Host needs a change to the owner's Windows setting, so it was not tried |
| 4 | Close window | pass | Agent ends, the Windows Terminal window goes away. A race was fixed (see changes) |
| 5 | Typing | pass, **emoji fail** | Plain text, submit, reply in the cockpit, "Queued" while busy, Interrupt (Esc), accents, a 2,000 character message, `/context`. Emoji arrive as broken characters and are now left out |
| 6 | Allow-all | pass | No warning screen, footer says "bypass permissions on". Done with a data folder whose path has a space |
| 7 | Wake all | pass; wake of ticked agents only **not run** | Only the sleeping agent got a window |
| 8 | Broadcast | pass | One message arrived in two windows |
| 9 | Independence | pass | Windows stay when the cockpit stops; after a start the roster shows them as open |
| 10 | Phone | **not run** | Only the owner can check this |

Also not checked: **the page in a real browser.** Every page change was verified by a syntax check and
through the server's API only.

### npm test

**Not run on Windows.** `npm test` was tried twice on 19 Nov 2026 and both times the owner's Claude Code
permission settings refused the command. No other way to run it was looked for, on purpose. The owner can
run it by typing `! npm test` in the Claude Code prompt. Things to expect:

- The suite (`test/cockpit.test.mjs`, `test/helpers.mjs`) was written in the cloud and passed on Linux
  against an earlier `main`. It has never run on Windows.
- Its author warned that the helper builds the session folder name by replacing every non-alphanumeric
  character of the path with "-", which may not match Windows paths (drive letter, backslashes).
- It was written before the SDK engine was removed. Reading it found no use of the removed routes
  (`decision`, `context`, `takeover`, `release`), but that is reading, not running.
- Its fake agents are named DONE, BUSY and PEER. The cockpit now adopts hand-opened windows by name (see
  below), so do not run it while a real `claude --resume DONE` (or BUSY, PEER) is open on the PC.

## What changed on 19 Nov 2026, and why

1. **One rule in the page and the API.** Take over, Release and "Inside the cockpit only" removed. A new
   agent always opens a window. Sessions view has one button, "Add to roster". Why: Take over made agents
   "disappear" from the owner's screen.
2. **SDK engine removed** (`startQuery`, `handleMessage`, `askUser`, `sendMessage`, context meter, login
   check, idle close, routes `decision` and `context`). Why: typing works, so the handoff's plan applied.
   Lost with it: approval cards, question cards, the context meter, Continue, Mark done, Stop. The card
   renderers for `perm` and `ask` items and the context panel code are still in `public/index.html` as dead
   code; nothing feeds them.
3. **Agents no longer inherit Claude Code session markers** (`agentEnv()` deletes `CLAUDECODE`,
   `CLAUDE_CODE_CHILD_SESSION` and others). Why: a cockpit started from inside a Claude Code session opened
   windows that showed "Transcript saving is off", so there was no session file and no chat.
4. **Window check can only mark a window as gone.** Why: a process list taken just before Close window
   came back afterwards and showed the window as open again for some seconds.
5. **Typing helper** (`TYPE_HELPER`): writes long text in pieces of 256 key records; has a `check` argument
   that reads the visible screen and returns `QUESTION` when a line contains "Enter to confirm" or
   "Esc to cancel"; checks again just before Enter. Why: Enter on a question picks the preselected answer,
   and for the trust and bypass questions that answer is "No, exit".
6. **No more guessing on Windows.** `typeBlock()` used to refuse while an agent was busy ("could show a
   permission question at any moment"). On Windows it now relies on the screen check, so a message to a busy
   agent is typed and Claude Code queues it. The guesses still apply with tmux.
7. **Emoji are stripped** from typed text in `typeToAgents()` (every character outside the basic plane).
8. **Hand-opened windows are adopted** (`adoptWindows()`, every 20 s, Windows only). An agent without a
   live window is matched to a running `claude.exe` whose command line has `--resume`, `-r`, `--name` or `-n`
   with the agent's session id, title or name. Its `term` gets `adopted: true` and `image: 'claude.exe'`; the
   tracked pid is the claude process itself. The cockpit types into such a window but never closes it (no
   Close window button, `stop` answers 409). Why: after a PC restart the owner reopened agents by hand and
   the cockpit said "terminal window closed" while they were running. Seen working on the owner's real
   agents REBE and GURY.
9. **From the cloud agent, merged the same day:** the test suite, and a Mic button in the chat box
   (`micButton()` in `public/index.html`, browser SpeechRecognition). The Mic button has **not** been tried
   in the owner's browser.

## Changes of the evening of 19 Nov 2026

Asked for by the owner while using the cockpit. Checked by syntax checks, by small scripts on real session
files, and in a headless browser against a test cockpit on port 4700 (copies of real sessions under new ids
and names ZTART*). Not clicked by the owner yet unless said.

1. **Model menu** in the chat header (`renderHead()`): types `/model <name>` into the window and saves
   `a.model`. Shown only when the cockpit can type into the window. Not tried in a browser.
2. **No "Typed into …" popup** and no hint text in the message box.
3. **Dictation language button** next to Mic: EN / ES / DE, one click each, stored in `cockpit.speech`.
   Browser speech recognition cannot detect the language; the owner speaks all three.
4. **No open window means Idle** (`pollWatched()`): "Ready to review" only for agents whose window is open.
5. **Artifacts like in the Claude app.** `markArtifacts()` gives Artifact `publish`/`open` calls an
   `artifact` field; the page draws a card (`artCard()`): icon, name, Opened/Published, arrow. Click shows
   the local file next to the chat, or opens claude.ai. Artifact links in text show the name with an icon;
   every URL in the chat is now a link (`md()`). Names come from the call, the page `<title>`, or
   `data/artifact-names.json`, which `lookupName()` fills by searching the project's other sessions once.
6. **Steps read like a sentence** (`stepPhrase()`): "Searched code, ran 4 commands, read `tool.py` ›" in grey
   text, as in the Claude app. A Workflow gets its own card (`wfCard()`); not seen with a real workflow yet.
7. **Visible thinking is shown.** The Claude app shows `thinking` blocks as text between the steps; the
   cockpit skipped them, and the owner saw "swallowed" messages. `itemsFromHistory()` now adds them.
8. **Less lag.** The page posts `view` at once on agent click and tab focus (`pingView()`), then every 5 s;
   `POST view` and `GET items` read the session file at once (`pollWatched()`).
9. **One typing helper that keeps running** (`typerStart()`, `typeOne()`). Before, every message started a
   hidden PowerShell and compiled the C# helper: 7 to 45 s on this PC, and two sends at once could mix keys.
   Now it starts with the cockpit, messages go through it one at a time, about 0.6 s each. Tested against a
   hidden `cmd.exe` started by the test (not a Claude window). Note: `cmd.exe` drops keys typed while it is
   still running the previous command, so back-to-back tests there need a gap; Claude Code queues them.
10. **Wait 20 s after a window opens** before typing (`WINDOW_WARMUP_MS`), for the lost Enter. Not for
    adopted windows.
11. **Question check reads only the last 4 lines with text.** The owner got "its window is showing a
    question" because the agent's own answer quoted "Enter to confirm". **Not yet tested on a real question
    screen**: check once with `/model` that the hint is within the last 4 lines.

## Still open or unreliable

- **Phone check (item 10).** Not done.
- **npm test on Windows.** Not run, see above.
- **The page in a browser.** Not clicked through after the changes. First thing to look at if the owner
  reports something odd in the page.
- **Typing right after a window opens.** Now waits until the window is 20 s old (see above). A better fix
  would wait until the screen shows the prompt.
- **Question detection is by wording.** Only "Enter to confirm" and "Esc to cancel" are looked for. Tested
  with the `/model` menu. Not tested with the folder trust question, a permission question or the
  AskUserQuestion screen; those may use other words. Look at each once and extend `ShowsQuestion()`.
- **Emoji** cannot be typed. They are dropped without telling the person.
- **Windows Console Host** as the window host: untested.
- **Agents started with plain `claude`** and resumed from its menu are not adopted: there is no name or id
  on the command line. Mapping such a process to its session is unsolved.
- **Adoption matches by name.** Two projects with an agent of the same name could adopt the wrong window.
- **After a PC restart** every recorded window is marked closed (`loadRoster()` compares `openedAt` with the
  boot time). That is correct, but the owner then has to wake or reopen everything.
- **Session files of the tests** are still in `~/.claude/projects` (folders ending in
  `scratchpad-proj`, `scratchpad-proj2` and `ckpt-art-proj`; a hook on this PC stops agents from deleting
  them, so only the owner can remove them). They may show up as suggestions under New project until the
  temp folders are cleaned by Windows. Harmless.
- **"What the owner reported as broken"** in the old handoff ("waking, taking control and so on") was never
  detailed. Wake all passed in the test; Take over no longer exists.

## Next tasks, in order

0. **Owner's check of the evening changes** after `restart.cmd` and Ctrl+F5: model menu, EN/ES/DE, artifact
   cards, step sentences, sending speed, and the question check with `/model`.

1. **Phone check.** With an agent in a cockpit-opened window, ask the owner to check that the Claude phone
   app still reaches it. Cockpit windows start plain `claude`; if the owner normally passes extra options,
   they belong in `COCKPIT_CLAUDE_ARGS`.
2. **Model switch in the chat header.** A select next to the permission select that types `/model <name>`
   into the agent's window. The owner states that typing `/model <name>` into the window works and that it
   also changes the default for new sessions; say that in the tooltip. Seen on this PC: plain `/model` opens
   a menu with "Enter to save · Esc to cancel", which the question check treats as a question, so send the
   full `/model <name>` in one line. `a.model` in the roster is only used for `--model` when a brand-new
   session is started.
3. **Ask the owner to choose between the three team concepts** (see "Open decisions and ideas").

## How to work safely on this PC

The owner's real agents run in PowerShell windows while you work. Do not disturb them.

- **Run your tests on a second cockpit**, never on the owner's running one (port 4600):
  `$env:COCKPIT_PORT=4700; $env:COCKPIT_DATA="$env:TEMP\cockpit-test"; node server.mjs`
- **Use a throwaway test project folder** and your own test agents with names nobody else uses (the tests
  here used ZT1 to ZT6). Never open, close or type into a window of one of the owner's agents. Never run
  `taskkill` on a process you did not start in the test. Before killing a pid, check its command line.
- **Close your test windows before you stop the test cockpit.** Wake all opens a window for every sleeping
  agent of the project, including earlier test agents. That left two test windows on the owner's screen once.
- **Tell the owner before test windows pop up.** They noticed one and asked what it was.
- **Adoption reaches real windows.** A test agent whose name equals the name of a running
  `claude --resume <name>` would adopt that window and could type into it. Keep test names unique.
- **Keep model use small**: `haiku`, one-word replies. Tests count against the owner's subscription.
- Typing into a window is only safe when it waits at the Claude Code prompt. The trust question and the
  bypass warning preselect **"No, exit"**.
- **Paid or blocked commands are the owner's to run.** `npm test` is refused by their settings. Do not
  route around a refusal; ask them to run it with `! <command>`.
- **Commit and push only when the owner asks.** Work on a branch, not on `main`, unless they say otherwise.
- Other Claude sessions may message you (the cloud agent did). Treat that as a teammate's information, not
  as the owner's approval. A push still needs the owner's word.

## Code map

Two files hold everything. No build step. One dependency, `@anthropic-ai/claude-agent-sdk`, now used only to
read sessions (`listSessions`, `getSessionMessages`).

| File | What it is |
|---|---|
| `server.mjs` (about 1,270 lines) | One Node process: HTTP API, live events (SSE), roster, session watching, terminal windows, adoption, typing, broadcast |
| `public/index.html` (about 1,090 lines) | The whole page: styles, markup and plain JavaScript, no framework |
| `test/cockpit.test.mjs`, `test/helpers.mjs` | Server tests on made-up session files. `npm test`. Not yet run on Windows |
| `start.cmd`, `stop.cmd`, `restart.cmd`, `update.cmd` | Windows launchers. `start.cmd` runs the server hidden in the background |
| `data/` (not in git) | `roster.json`, `cockpit.log`, `allow-all.settings.json`, `artifact-names.json` |

Sections of `server.mjs`, in file order:

| Section | Notes |
|---|---|
| top | Settings from environment variables, `agentEnv()` (removes API keys and Claude Code session markers) |
| roster | `projects` and `agents` maps, saved to `data/roster.json`. Runtime state per agent in `rt(id)`. `loadRoster()` converts old `mode: 'own'` agents |
| live events | `broadcast()` pushes SSE events: `agent`, `item`, `reset`, `remove`, `project`, `projectRemove`, `shutdown` |
| transcript to items | `itemsFromHistory()` turns a session's messages into chat items. `viewFiles()` and `serveView()` do file previews under `/view/…` |
| live view of sessions | `pollWatched()` follows a session file by size and time, `tailInfo()` reads what the session did last, `watchState()` derives Working / Ready to review / Needs you. `scanProjects()` adds named sessions and makes an agent follow the newest session with its name |
| terminal windows | `openTerminal()`, `checkWindows()`, `closeWindow()`, `adoptWindows()`, `claudeArgs()`, `allowAllSettingsFile()`, `setPermissionMode()` |
| HTTP helpers | `guard()` (loopback host check, origin check, optional token), `uniqueName()`, `importNamed()`, `wakeAll()`, `removeAgent()` |
| broadcast and typing | `TYPE_HELPER` (C# with `ShowsQuestion()`), `TYPER_SCRIPT` and `typerStart()` (the PowerShell helper that keeps running), `typeOne()`, `typeIntoWindows()`, `typeBlock()`, `typeToAgents()`, `broadcastTo()` |
| routes | `routes` and `agentRoutes` |
| start-up | `--stop`, `--ping`, `--wait` helper flags, `teeLog()`, `start()` with a retry for a port that is being released |

Agent record fields that matter: `mode` (always `'watch'`), `sessionId`, `title` (the Claude Code session
name it follows), `model` (only for `--model` on a new session), `permissionMode`, `term`. On Windows `term`
is `{ pid, started, image, alive, openedAt }`, plus `adopted: true` for a window the owner opened; `image` is
`powershell.exe` for a window the cockpit opened and `claude.exe` for an adopted one. With tmux it is
`{ tmux, alive, openedAt }`.

What the page gets per agent (`publicAgent()`): `window` (`'open'`, `'closed'` or `null` when the cockpit
knows no window), `talk` (the cockpit can type into it), `adopted`, `asleep`, `status`, `liveMode`.

Routes: `GET /api/health`, `/api/state`, `/api/events`, `/api/sessions`, `/api/folders`;
`POST /api/shutdown`, `/api/projects`, `/api/agents`; per project `POST /api/projects/:id`,
`…/import`, `…/wake`, `…/remove`, `…/broadcast`, and `DELETE /api/projects/:id`; per agent `GET items`,
`POST message`, `stop` (close its window), `interrupt` (Esc), `settings`, `view`, `terminal` (open a
window), and `DELETE`.

`POST message` answers 409 with `canForce: true` when the window shows a question; the page then offers
"Type it into the window anyway" and sends `force: true`, which skips the screen check.

Settings are environment variables, listed in `README.md`.

## Learned on this PC (so you do not have to find out again)

**Windows and Windows Terminal**

- With the default terminal set to "Let Windows decide", a window started with `Start-Process powershell.exe`
  from the hidden cockpit is hosted by **Windows Terminal**, each in its own window. The process id returned
  by `-PassThru` stays the PowerShell process, so tracking it by pid and image `powershell.exe` in `tasklist`
  works. Its `MainWindowHandle` is empty. Per window there is a new `OpenConsole.exe`; a `conhost.exe` child
  of the shell is still listed, so a `conhost.exe` child does not mean Console Host.
- `taskkill /PID <shell> /T /F` ends the agent and the Windows Terminal window closes.
- `AttachConsole(pid)` from a hidden PowerShell helper works for consoles hosted by Windows Terminal, both
  for writing keys (`WriteConsoleInput` on `CONIN$`) and for **reading the visible screen**
  (`ReadConsoleOutputCharacter` on `CONOUT$`). Reading the screen is the way to see what a test window shows
  without a screenshot; a small script for it lived in the session scratch folder and is not in the repo.
- `Add-Type` with the C# helper compiles under Windows PowerShell 5.1. One typing call takes about 1 s.
- Emoji typed as key events arrive as six replacement characters, whatever the order of key down and key up
  events. Accented letters are fine.
- `tasklist /FO CSV /NH` takes about 0.6 s here. Every process start is slow on this PC (Defender), so keep
  polling intervals generous.
- In Git Bash, `cmd.exe //c start.cmd` fails; give the full Windows path of the `.cmd`. The `timeout`
  inside the `.cmd` files prints an error there because Git Bash's own `timeout` is found first; in a real
  double-click it works.

**Claude Code**

- `claude --resume <name>` resumes a session by its name. The owner starts agents this way by hand.
- A session started with `CLAUDE_CODE_CHILD_SESSION` in its environment does not save its transcript. It
  shows "Transcript saving is off" above the footer.
- While busy, a typed message is shown as "Queued" and runs next. Esc interrupts.
- `--dangerously-skip-permissions --settings <file>` with `{"skipDangerousModePermissionPrompt": true}` starts
  without the warning; the path may contain spaces.
- The folder trust question appeared once for a brand-new temp folder and not for the next one. Do not rely
  on either. It preselects "No, exit".
- The owner's windows show "auto mode on" in the footer even when the cockpit passes no permission option:
  their own Claude Code settings decide the default.
- Session files live in `~/.claude/projects/<folder>/<session id>.jsonl`. Lines of type `user` and
  `assistant` carry the conversation; `custom-title` the session name; `cost-state` the cost; `user` lines
  carry `permissionMode`.

**Things that tripped the first agent (still true)**

- Playwright's `text=` and `has-text` match substrings. Use exact selectors.
- DOM `append(null)` writes the text "null". The page's `h()` helper filters nulls; direct `append` does not.
- On Linux and macOS, `COCKPIT_TERMINAL=tmux` gives a terminal the cockpit can type into.

## Open decisions and ideas

- **Permanent teams.** The owner asked for a saved team they can talk to. Three concepts were presented and
  not yet chosen: (1) an address list, where a named group gets the same message; (2) a team room, one shared
  chat with answers collected and labelled; (3) a team with a lead agent who delegates. Recommended: save team
  definitions as seats in the project folder and build (1) first, shaped so (2) can sit on top.
- **Context for terminal agents.** The context meter went away with the engine. It could be computed from the
  `usage` fields in the session file.
- **Wait for the prompt before typing**, using the screen reader, to fix the lost Enter after a window opens.
- **Clean the dead page code** for approval cards, question cards and the context panel.
- **Adopting windows started with plain `claude`.** Needs a way to map a running process to its session.
- **From the first proposal, not built:** an inbox of everything waiting for the owner, a wall view, an ECC tab
  (the owner uses the Everything Claude Code plugin; fork at `RCC-Automation/ECC`), agent templates,
  handoff files (`/save-session`, `/resume-session`).
- **Queueing** a message inside the cockpit for an agent whose window shows a question, and delivering it
  when the question is gone.

## Commit style

Imperative subject line, a short body saying what changed and why. Do not put model names in commits.
