# Agent Cockpit

A small local control station for Claude Code agents: one Node server (`server.mjs`) and one page
(`public/index.html`). No build step. See `README.md` for what it does and how to run it.

**Read `HANDOFF.md` before changing anything.** It holds the owner's goals, the code map, what is verified,
what was written blind for Windows, and the next tasks.

## Rules for working here

- The owner's own agents may be running in PowerShell windows on this PC. Never close, type into, or kill a
  window or process you did not start for a test.
- Test on a second cockpit, not the owner's running one: set `COCKPIT_PORT=4700` and `COCKPIT_DATA` to a temp
  folder, and use a throwaway project folder.
- Agents must run on the PC's Claude login, never on an API key.
- Keep test turns tiny (model `haiku`, one-word replies). They count against the owner's usage.
- Closing or restarting the cockpit must never stop an agent that lives in a terminal window.
- Tell the owner plainly what you ran and what you did not.

## Run

```bash
npm install
```

```bash
node server.mjs
```

Syntax check after edits: `node --check server.mjs`. The page's script can be checked by extracting the
`<script>` block and passing it to `new Function(...)`.
