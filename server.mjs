// Agent Cockpit — a small local control station for Claude Code agents.
// One Node process: keeps the roster, opens one terminal window per agent, shows each chat by
// reading the session file, and writes by typing into the window.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COCKPIT_PORT || 4600);
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const TOKEN = process.env.COCKPIT_TOKEN || '';
const DATA_DIR = process.env.COCKPIT_DATA || path.join(ROOT, 'data');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY = 30 * 1024 * 1024;
const MAX_RESULT_CHARS = 6000;
// 'bypassPermissions' is the allow-all mode: the agent runs every command and edit without asking.
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];
// Agents run on the Claude login of this PC (your subscription). An API key in the
// environment would silently switch them to pay-per-use billing, so it is not passed on
// unless you ask for it with COCKPIT_ALLOW_API_KEY=1.
const ALLOW_API_KEY = process.env.COCKPIT_ALLOW_API_KEY === '1';

function agentEnv() {
  const env = { ...process.env };
  if (!ALLOW_API_KEY) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  // If the cockpit itself was started from inside a Claude Code session, these markers would make every
  // agent think it is a child of that session. A child session does not save its transcript, so the
  // cockpit could not show its chat.
  for (const k of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_NOTES_DIR',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  return env;
}
if (!LOOPBACK.has(HOST) && !TOKEN) {
  console.error('Refusing to start: COCKPIT_HOST is not local, so COCKPIT_TOKEN must be set.\n' +
    'This page can run commands on this PC. Never expose it without a token.');
  process.exit(1);
}

// ───────────────────────── roster (persisted) ─────────────────────────

/** @type {Map<string, any>} persisted projects: a name, a folder and the team that works in it */
const projects = new Map();
/** @type {Map<string, any>} persisted agent records */
const agents = new Map();
/** @type {Map<string, any>} in-memory runtime per agent */
const runtimes = new Map();

function loadRoster() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
    for (const p of raw.projects || []) projects.set(p.id, p);
    const bootedAt = Date.now() - os.uptime() * 1000;
    for (const a of raw.agents || []) {
      if (!projects.has(a.projectId)) continue;
      // A window opened before the PC last started cannot be open any more.
      if (a.term && (!a.term.openedAt || a.term.openedAt < bootedAt)) a.term.alive = false;
      // One rule: every agent lives in a terminal window. An agent saved as "inside the cockpit" becomes
      // a terminal agent with the same session, so nobody is stranded.
      if ((a.mode || 'own') !== 'watch') { a.mode = 'watch'; if (!a.title) a.title = a.name; delete a.interrupted; if (a.sessionId) a.last = 'Open terminal to continue it in its own window.'; }
      agents.set(a.id, a);
    }
  } catch { /* first run */ }
}
function rosterJson() {
  return JSON.stringify({ projects: [...projects.values()], agents: [...agents.values()] }, null, 2);
}
let saveTimer = null;
function saveRoster() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = ROSTER_FILE + '.tmp';
      fs.writeFileSync(tmp, rosterJson());
      fs.renameSync(tmp, ROSTER_FILE);
    } catch (e) { console.error('[roster] save failed:', e.message); }
  }, 150);
}

function rt(id) {
  let r = runtimes.get(id);
  if (!r) {
    r = { status: 'idle', items: [], historyLoaded: false, commands: [], viewedAt: 0, watch: { mtime: 0, size: 0, info: null, cost: null, loadedMtime: -1 } };
    runtimes.set(id, r);
  }
  return r;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
function shortPath(p) {
  const h = os.homedir();
  return p && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

function publicProject(p) {
  return { id: p.id, name: p.name, cwd: p.cwd, cwdShort: shortPath(p.cwd), note: p.note || '', autoImport: p.autoImport !== false, permissionMode: p.permissionMode || 'default', createdAt: p.createdAt };
}
function samePath(x, y) {
  const n = v => path.resolve(v).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(x).toLowerCase() === n(y).toLowerCase() : n(x) === n(y);
}
function publicAgent(a) {
  const r = rt(a.id);
  return {
    id: a.id, projectId: a.projectId, name: a.name, mode: a.mode || 'own', cwd: a.cwd, cwdShort: shortPath(a.cwd), model: a.model || '', modelResolved: a.modelResolved || '', permissionMode: a.permissionMode || 'default',
    sessionId: a.sessionId || null, asleep: !wakeState(a), window: termKnown(a) ? (a.term.alive === false ? 'closed' : 'open') : null, talk: canTalk(a), adopted: !!(a.term && a.term.adopted && a.term.alive !== false), liveMode: r.watch.mode || null, status: r.status, last: a.last || '', updatedAt: a.updatedAt || a.createdAt,
    login: a.login || null, cost: r.watch.cost || 0,
  };
}

// ───────────────────────── live events (SSE) ─────────────────────────

const clients = new Set();
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}
function emitAgent(a) { broadcast({ t: 'agent', agent: publicAgent(a) }); }
function touch(a, last) {
  if (last != null) a.last = String(last).replace(/\s+/g, ' ').slice(0, 160);
  a.updatedAt = Date.now();
  saveRoster();
  emitAgent(a);
}

// ───────────────────────── transcript → items ─────────────────────────

function textOfToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[${b.type}]`).join('\n');
  }
  return JSON.stringify(content);
}
function clip(s, n = MAX_RESULT_CHARS) { return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s; }

function toolSummary(name, input, cwd) {
  const i = input || {};
  let pick = i.file_path || i.path || i.command || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || i.notebook_path || '';
  if (!pick && i.to && i.message) pick = `to ${i.to}: ${i.message}`;
  if (!pick) pick = Object.values(i).find(v => typeof v === 'string' && v.trim()) || '';
  let s = String(pick);
  if (cwd && s.length > cwd.length + 1 && s.startsWith(cwd) && /[\\/]/.test(s[cwd.length])) s = s.slice(cwd.length + 1);
  return s.replace(/\s+/g, ' ').slice(0, 200);
}

// Files an agent published, sent or worked with can be previewed in the page. Each gets a link under
// /view/<agent>/<folder>/<name>, so a page that refers to files next to it still finds them.
const VIEW_TYPES = {
  '.html': ['html', 'text/html; charset=utf-8'], '.htm': ['html', 'text/html; charset=utf-8'], '.svg': ['image', 'image/svg+xml'],
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.gif': ['image', 'image/gif'], '.webp': ['image', 'image/webp'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mov': ['video', 'video/quicktime'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.ogg': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'],
  '.pdf': ['pdf', 'application/pdf'], '.md': ['text', 'text/plain; charset=utf-8'], '.txt': ['text', 'text/plain; charset=utf-8'],
  '.json': ['text', 'text/plain; charset=utf-8'], '.csv': ['text', 'text/plain; charset=utf-8'], '.log': ['text', 'text/plain; charset=utf-8'],
};
// Files that travel with a page: served when a previewed page asks for them, never offered on their own.
const ASSET_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const b64url = t => Buffer.from(t, 'utf8').toString('base64url');
const pathKey = p => process.platform === 'win32' ? p.toLowerCase() : p;

function toolPaths(input) {
  const i = input || {}, out = [];
  for (const v of [i.file_path, i.path, i.notebook_path]) if (typeof v === 'string' && v.trim()) out.push(v.trim());
  if (Array.isArray(i.files)) for (const v of i.files) if (typeof v === 'string' && v.trim()) out.push(v.trim());
  return out;
}
function viewFiles(a, input) {
  const out = [];
  for (const raw of toolPaths(input)) {
    const full = path.resolve(a.cwd, expandHome(raw)), type = VIEW_TYPES[path.extname(full).toLowerCase()];
    if (type) out.push({ name: path.basename(full), kind: type[0], url: `/view/${a.id}/${b64url(path.dirname(full))}/${encodeURIComponent(path.basename(full))}` });
  }
  return out.length ? out : undefined;
}
// Only folders of files the agent itself named in a tool call are open for viewing.
function viewableDirs(a) {
  const dirs = new Set();
  for (const it of rt(a.id).items) {
    if (it.k !== 'tool' && it.k !== 'perm') continue;
    for (const raw of toolPaths(it.input)) dirs.add(pathKey(path.dirname(path.resolve(a.cwd, expandHome(raw)))));
  }
  return dirs;
}
function serveView(a, req, res, token, rest) {
  let dir = ''; try { dir = Buffer.from(token, 'base64url').toString('utf8'); } catch { /* bad link */ }
  if (!dir || !viewableDirs(a).has(pathKey(dir))) return json(res, 404, { error: 'This file is not part of the agent\'s work shown in the cockpit.' });
  let rel = ''; try { rel = decodeURIComponent(rest); } catch { /* bad link */ }
  const full = path.resolve(dir, rel), ext = path.extname(full).toLowerCase();
  const inside = pathKey(full).startsWith(pathKey(dir) + path.sep);
  const type = VIEW_TYPES[ext] ? VIEW_TYPES[ext][1] : ASSET_TYPES[ext];
  if (!rel || !inside || !type) return json(res, 404, { error: 'Not a file the cockpit can show.' });
  let st; try { st = fs.statSync(full); } catch { /* gone */ }
  if (!st || !st.isFile()) return json(res, 404, { error: 'The file no longer exists: ' + full });
  const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  // Pages and drawings made by an agent may contain scripts. They are shown as a separate, powerless
  // origin, so a script in them cannot use the cockpit's own controls.
  if (ext === '.html' || ext === '.htm' || ext === '.svg') headers['content-security-policy'] = 'sandbox allow-scripts allow-popups allow-forms allow-modals';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(full).pipe(res);
}

// Text the CLI writes into user turns that the person did not type.
// A message another agent sent to this one. It arrives as a user turn but the person did not type it.
function parsePeer(t) {
  if (!t) return null;
  const m = /<(cross-session-message|agent-message|teammate-message|peer-message)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(t);
  if (m) { const from = /\bfrom="([^"]*)"/.exec(m[2]); return { from: from ? from[1] : '', text: m[3].trim() }; }
  if (/permission laundering|Another Claude session sent a message/i.test(t)) return { from: '', text: t.replace(/<\/?system-reminder\b[^>]*>/g, '').trim() };
  return null;
}
function cleanUserText(t) {
  if (!t) return '';
  t = t.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return '';
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/);
    return (cmd[1] + ' ' + (args ? args[1] : '')).trim();
  }
  if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder|local-command-caveat|task-notification)/.test(t)) return '';
  if (/^Caveat: The messages below were generated by the user while running local commands/.test(t)) return '';
  return t;
}

// Build display items from a list of {type, message, parent_tool_use_id} records.
function itemsFromHistory(messages, a, live = false) {
  const cwd = a.cwd;
  const items = [];
  const tools = new Map();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message || {};
    const content = msg.content;
    if (m.type === 'user') {
      if (typeof content === 'string') {
        const peer = parsePeer(content);
        if (peer) { items.push({ k: 'peer', id: m.uuid, ...peer }); continue; }
        const text = cleanUserText(content);
        if (text) items.push({ k: 'user', id: m.uuid, text, images: [] });
        continue;
      }
      if (!Array.isArray(content)) continue;
      let text = ''; const images = [];
      for (const b of content) {
        if (b.type === 'text') {
          const peer = parsePeer(b.text);
          if (peer) items.push({ k: 'peer', id: `${m.uuid}:p${items.length}`, ...peer });
          else text += (text ? '\n' : '') + cleanUserText(b.text);
        }
        else if (b.type === 'image' && b.source?.type === 'base64') images.push({ mediaType: b.source.media_type, data: b.source.data });
        else if (b.type === 'tool_result') {
          const it = tools.get(b.tool_use_id);
          if (it) { it.result = clip(textOfToolResult(b.content)); it.status = b.is_error ? 'err' : 'ok'; }
        }
      }
      if (text.trim() || images.length) items.push({ k: 'user', id: m.uuid, text: text.trim(), images });
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      content.forEach((b, i) => {
        if (b.type === 'text' && b.text.trim()) items.push({ k: 'text', id: `${m.uuid}:${i}`, text: b.text });
        else if (b.type === 'tool_use') {
          const it = { k: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input, cwd), input: b.input, files: viewFiles(a, b.input), result: '', status: 'ok' };
          tools.set(b.id, it); items.push(it);
        }
      });
    } else if (m.type === 'system' && msg?.subtype === 'compact_boundary') {
      items.push({ k: 'note', id: m.uuid, text: 'Context was compacted here' });
    }
  }
  // In a session that is still running, a last tool call without a result is still in progress.
  const tail = items[items.length - 1];
  if (live && tail && tail.k === 'tool' && !tail.result) tail.status = 'run';
  return items;
}

const ensureHistory = a => loadWatched(a);

// ───────────────────────── live view of sessions that run in a terminal ─────────────────────────
// A watched agent is owned by a terminal. The cockpit never writes to it: it follows the session
// file Claude Code keeps on disk and shows chat and status from there.

const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const WATCH_MS = 2500, SCAN_MS = 15_000, TAIL_BYTES = 256 * 1024;
const IMPORT_DAYS = Number(process.env.COCKPIT_IMPORT_DAYS || 7);

function sessionFile(a) {
  const w = rt(a.id).watch;
  if (w.fileFor === a.sessionId && (w.file || Date.now() - w.fileCheckedAt < 30_000)) return w.file;
  let found = null;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, a.sessionId + '.jsonl');
      if (fs.existsSync(f)) { found = f; break; }
    }
  } catch { /* no sessions folder yet */ }
  w.file = found; w.fileFor = a.sessionId; w.fileCheckedAt = Date.now();
  return found;
}

function readTail(file, size) {
  const len = Math.min(size, TAIL_BYTES);
  if (len <= 0) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // the first line is probably cut in half
    return lines;
  } finally { fs.closeSync(fd); }
}

// What the session did last, read from the end of its file.
function tailInfo(lines, cwd) {
  let info = null, cost = null, mode = null;
  for (let i = lines.length - 1; i >= 0 && !(info && cost != null && mode != null); i--) {
    if (!lines[i]) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (cost == null && o.type === 'cost-state' && typeof o.totalCostUSD === 'number') { cost = o.totalCostUSD; continue; }
    if (mode == null && o.type === 'user' && typeof o.permissionMode === 'string') mode = o.permissionMode;
    if (info || o.isSidechain || o.isMeta || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const c = o.message?.content;
    if (o.type === 'assistant') {
      if (!Array.isArray(c)) continue;
      const tool = [...c].reverse().find(b => b.type === 'tool_use');
      const text = c.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (tool) {
        info = tool.name === 'AskUserQuestion'
          ? { kind: 'ask', text: tool.input?.questions?.[0]?.question || 'Has a question' }
          : { kind: 'tool', text: `${tool.name} ${toolSummary(tool.name, tool.input, cwd)}`.trim() };
      } else if (text) info = { kind: 'text', text };
    } else if (typeof c === 'string' || Array.isArray(c)) {
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) { info = { kind: 'result', text: '' }; continue; }
      const raw = typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join(' ');
      const peer = parsePeer(raw);
      if (peer) { info = { kind: 'user', text: 'a message from ' + (peer.from || 'another agent') }; continue; }
      const text = cleanUserText(raw);
      if (/^\[Request interrupted/.test(text)) info = { kind: 'stopped', text: 'Interrupted in the terminal' };
      else if (text) info = { kind: 'user', text };
      else if (Array.isArray(c) && c.some(b => b.type === 'image')) info = { kind: 'user', text: '(image)' };
    }
  }
  return { info, cost, mode };
}

function watchState(info, quiet) {
  if (!info) return null;
  const min = Math.max(1, Math.round(quiet / 60000));
  switch (info.kind) {
    case 'ask': return ['need', 'Question in the terminal: ' + info.text];
    case 'tool': return quiet > 90_000
      ? ['need', `Quiet for ${min} min at: ${info.text}. It may be waiting for your approval in the terminal.`]
      : ['work', info.text];
    case 'user': return quiet < 600_000 ? ['work', 'Working on: ' + info.text] : ['idle', info.text];
    case 'result': return quiet < 600_000 ? ['work', null] : ['idle', null];
    case 'stopped': return ['idle', info.text];
    default: return quiet < 12 * 3600_000 ? ['review', info.text] : ['idle', info.text];
  }
}

// Replace the chat of a watched agent with what is on disk, telling the browser only what changed.
function applyHistory(a, fresh, firstLoad) {
  const r = rt(a.id);
  const old = new Map(r.items.map(i => [i.id, i]));
  const ids = new Set(fresh.map(i => i.id));
  const rewritten = !old.size || r.items.some(i => !ids.has(i.id));
  r.items = fresh;
  if (rewritten) { if (!(firstLoad && !old.size)) broadcast({ t: 'reset', agentId: a.id }); return; }
  for (const it of fresh) {
    const o = old.get(it.id);
    if (!o || o.status !== it.status || (o.result || '').length !== (it.result || '').length || o.text !== it.text) broadcast({ t: 'item', agentId: a.id, item: it });
  }
}

async function loadWatched(a, force = false) {
  const r = rt(a.id), w = r.watch;
  if (w.loading) return w.loading;
  if (!force && w.loadedMtime === w.mtime && r.historyLoaded) return;
  const at = w.mtime;
  w.loading = (async () => {
    try {
      applyHistory(a, itemsFromHistory(await getSessionMessages(a.sessionId, { dir: a.cwd }), a, true), !r.historyLoaded);
      w.loadedMtime = at; r.historyLoaded = true;
    } catch (e) { if (process.env.COCKPIT_DEBUG) console.error(`[${a.name}] history:`, e.message); }
    finally { w.loading = null; }
  })();
  return w.loading;
}

async function pollWatched(a) {
  if (!a.sessionId) return; // started in a terminal, its session file does not exist yet
  const r = rt(a.id), w = r.watch, file = sessionFile(a);
  if (!file) return;
  let st; try { st = fs.statSync(file); } catch { w.fileFor = null; return; }
  if (st.mtimeMs !== w.mtime || st.size !== w.size) {
    w.mtime = st.mtimeMs; w.size = st.size;
    const t = tailInfo(readTail(file, st.size), a.cwd);
    if (t.info) w.info = t.info;
    if (t.cost != null) w.cost = t.cost;
    if (t.mode) w.mode = t.mode;
  }
  if (Date.now() - r.viewedAt < 20_000 && w.loadedMtime !== w.mtime) await loadWatched(a);
  let s = watchState(w.info, Date.now() - w.mtime);
  if (!s) return;
  if (a.term && a.term.alive === false && (s[0] === 'work' || s[0] === 'need')) s = ['idle', 'Its terminal window is closed.'];
  const last = s[1] == null ? (a.last || '') : s[1].replace(/\s+/g, ' ').slice(0, 200);
  const at = Math.round(w.mtime);
  if (r.status !== s[0] || a.last !== last || a.updatedAt !== at) {
    r.status = s[0]; a.last = last; a.updatedAt = at;
    saveRoster(); emitAgent(a);
  }
}

let watchBusy = false;
async function watchTick() {
  if (watchBusy) return; watchBusy = true;
  try { for (const a of [...agents.values()]) if (a.mode === 'watch') { try { await pollWatched(a); } catch { /* next tick */ } } }
  finally { watchBusy = false; }
}

// Keep the roster in step with the terminals: new named sessions appear by themselves, and a watched
// agent follows the newest session that carries its name (for example after /clear or a restart).
let scanBusy = false;
async function scanProjects() {
  if (scanBusy) return; scanBusy = true;
  try {
    for (const p of [...projects.values()]) {
      // Following an agent to its newest session always happens; only adding new agents can be switched off.
      if (p.autoImport === false && ![...agents.values()].some(a => a.projectId === p.id && a.mode === 'watch')) continue;
      let list; try { list = await listSessions({ dir: p.cwd, limit: 500 }); } catch { continue; }
      const newest = new Map();
      for (const s of list) {
        const t = (s.customTitle || '').trim().toLowerCase(); if (!t) continue;
        const prev = newest.get(t);
        if (!prev || (s.lastModified || 0) > (prev.lastModified || 0)) newest.set(t, s);
      }
      const used = new Set([...agents.values()].map(a => a.sessionId).filter(Boolean));
      for (const a of agents.values()) {
        if (a.projectId !== p.id || a.mode !== 'watch') continue;
        const s = newest.get((a.title || a.name).toLowerCase());
        if (!s || s.sessionId === a.sessionId || used.has(s.sessionId)) continue;
        used.add(s.sessionId);
        a.sessionId = s.sessionId;
        const r = rt(a.id);
        r.watch = { mtime: 0, size: 0, info: null, cost: null, loadedMtime: -1 }; r.items = []; r.historyLoaded = false;
        saveRoster(); broadcast({ t: 'reset', agentId: a.id }); emitAgent(a);
      }
      if (p.autoImport !== false) { try { await importNamed(p, list); } catch { /* next scan */ } }
    }
  } finally { scanBusy = false; }
}

// ───────────────────────── terminal windows ─────────────────────────
// Opens a real terminal window that runs Claude Code for an agent. The terminal then owns the
// session: the person types there, and the cockpit shows it live like any other watched agent.

const psQuote = v => "'" + String(v).replace(/'/g, "''") + "'";
const shQuote = v => "'" + String(v).replace(/'/g, `'\\''`) + "'";

// Allow-all is confirmed once in the cockpit. This settings file tells Claude Code that the person has
// accepted its own bypass-permissions warning, so each new window does not stop at that question.
function allowAllSettingsFile() {
  const file = path.join(DATA_DIR, 'allow-all.settings.json');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2)); } catch { /* the warning then simply shows */ }
  return file;
}
const termKnown = a => !!(a.term && (a.term.pid || a.term.tmux));
const TMUX = (process.env.COCKPIT_TERMINAL || '').toLowerCase() === 'tmux';

function claudeArgs(a, firstMessage) {
  const args = [];
  if (a.sessionId) args.push('--resume', a.sessionId);
  else {
    args.push('--name', a.title || a.name);
    if (a.model) args.push('--model', a.model);
  }
  if (a.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions', '--settings', allowAllSettingsFile());
  else if (a.permissionMode && a.permissionMode !== 'default') args.push('--permission-mode', a.permissionMode);
  if (firstMessage) args.push(firstMessage.replace(/\s+/g, ' ').trim());
  return args;
}

const b64ps = t => Buffer.from(t, 'utf16le').toString('base64');
const termTitle = a => (a.title || a.name).replace(/[^\w .-]/g, '').slice(0, 40) || 'agent';
const extraArgs = () => { const e = (process.env.COCKPIT_CLAUDE_ARGS || '').trim(); return e ? ' ' + e : ''; };

// What the PowerShell window runs. It travels base64-encoded, so no quoting can break on the way.
function terminalScript(a, firstMessage) {
  return `$Host.UI.RawUI.WindowTitle = ${psQuote(termTitle(a))}; Set-Location -LiteralPath ${psQuote(a.cwd)}; claude ${claudeArgs(a, firstMessage).map(psQuote).join(' ')}${extraArgs()}`;
}
function shellLine(a, firstMessage) {
  return `cd ${shQuote(a.cwd)} && claude ${claudeArgs(a, firstMessage).map(shQuote).join(' ')}${extraArgs()}`;
}

// Opens the window and remembers which process it is, so the cockpit can tell whether it is
// still open and can close it when asked. Windows that the person opened themselves are never touched.
function openTerminal(a, firstMessage) {
  const env = agentEnv();
  const fail = (reject, what) => reject(new Error('Could not open a terminal window: ' + String(what || 'no answer').split('\n')[0]));
  const shell = process.env.COCKPIT_SHELL || 'powershell.exe';
  const useWt = (process.env.COCKPIT_TERMINAL || '').toLowerCase() === 'wt';
  a.term = null;
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32' && !useWt) {
      const outer = `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath ${psQuote(shell)} -ArgumentList @('-NoExit','-EncodedCommand',${psQuote(b64ps(terminalScript(a, firstMessage)))}) ` +
        `-WorkingDirectory ${psQuote(a.cwd)} -WindowStyle Normal -PassThru; $t = 0; try { $t = $p.StartTime.ToFileTimeUtc() } catch {}; Write-Output "$($p.Id),$t"`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64ps(outer)], { env, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        const m = /(\d+),(\d+)/.exec(String(stdout));
        if (err || !m) return fail(reject, err ? err.message : stderr);
        a.term = { pid: Number(m[1]), started: m[2], image: path.basename(shell).toLowerCase(), alive: true, openedAt: Date.now() };
        saveRoster(); resolve();
      });
    } else if (process.platform === 'win32') {
      exec(`wt.exe -w 0 new-tab --title "${termTitle(a)}" ${shell} -NoExit -EncodedCommand ${b64ps(terminalScript(a, firstMessage))}`, { cwd: a.cwd, env, windowsHide: true }, err => err ? fail(reject, err.message) : resolve());
    } else if (process.platform === 'darwin') {
      const line = shellLine(a, firstMessage);
      exec(`osascript -e ${shQuote(`tell application "Terminal" to do script ${JSON.stringify(line)}`)} -e ${shQuote('tell application "Terminal" to activate')}`, { env }, err => err ? fail(reject, err.message) : resolve());
    } else if (TMUX) {
      // One tmux session per agent. Look at it with:  tmux attach -t <name>
      const name = `cockpit-${termTitle(a).replace(/[^\w-]/g, '_')}-${a.id.slice(0, 6)}`;
      execFile('tmux', ['kill-session', '-t', name], () => {
        execFile('tmux', ['new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-c', a.cwd, shellLine(a, firstMessage)], { env }, err => {
          if (err) return fail(reject, err.message);
          a.term = { tmux: name, alive: true, openedAt: Date.now() }; saveRoster(); resolve();
        });
      });
    } else {
      const child = spawn(process.env.COCKPIT_TERMINAL || 'x-terminal-emulator', ['-e', 'bash', '-lc', shellLine(a, firstMessage) + '; exec bash'], { cwd: a.cwd, env, detached: true, stdio: 'ignore' });
      child.on('error', e => fail(reject, e.message));
      child.on('spawn', () => { a.term = { pid: child.pid, started: '0', image: '', alive: true, openedAt: Date.now() }; child.unref(); saveRoster(); resolve(); });
    }
  });
}

function setWindowAlive(a, alive) {
  if (!a.term || a.term.alive === alive) return;
  a.term.alive = alive; saveRoster(); emitAgent(a);
}
// Which of the windows the cockpit opened are still there.
function checkWindows() {
  for (const a of [...agents.values()].filter(x => x.term && x.term.tmux && x.term.alive !== false)) execFile('tmux', ['has-session', '-t', a.term.tmux], err => setWindowAlive(a, !err));
  const tracked = [...agents.values()].filter(a => a.term && a.term.pid && a.term.alive !== false);
  if (!tracked.length) return;
  if (process.platform !== 'win32') {
    for (const a of tracked) { let alive = true; try { process.kill(a.term.pid, 0); } catch { alive = false; } setWindowAlive(a, alive); }
    return;
  }
  execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
    if (err) return;
    const live = new Map();
    for (const line of String(stdout).split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(line); if (m) live.set(Number(m[2]), m[1].toLowerCase()); }
    // Only ever marks a window as gone. A list taken just before Close window must not bring it back.
    for (const a of tracked) if (a.term && a.term.alive !== false && live.get(a.term.pid) !== a.term.image) setWindowAlive(a, false);
  });
}
// Closes a window the cockpit opened, together with the Claude Code running in it.
function closeWindow(a) {
  const t = a.term;
  if (!termKnown(a) || t.alive === false || t.adopted) return Promise.resolve(false); // a window the person opened is never closed
  return new Promise(resolve => {
    const done = ok => { setWindowAlive(a, false); resolve(ok); };
    if (t.tmux) return execFile('tmux', ['kill-session', '-t', t.tmux], () => done(true));
    if (process.platform !== 'win32') {
      try { process.kill(-t.pid, 'SIGTERM'); } catch { try { process.kill(t.pid, 'SIGTERM'); } catch { /* already gone */ } }
      return done(true);
    }
    // Only if it is still the very process the cockpit started (same id and same start time).
    const script = `$p = Get-Process -Id ${Number(t.pid)} -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } else { $s = 0; try { $s = $p.StartTime.ToFileTimeUtc() } catch {}; ` +
      `if ("$s" -eq '${String(t.started).replace(/\D/g, '')}') { & taskkill.exe /PID ${Number(t.pid)} /T /F | Out-Null; 'closed' } else { 'other' } }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64ps(script)], { windowsHide: true, timeout: 20000 }, (err, stdout) => done(!err && /closed|gone/.test(String(stdout))));
  });
}

// Finds windows the person opened by hand (Windows only). An agent without a window of its own is matched
// to a running Claude Code whose command line resumes or names its session, for example
// "claude --resume REBE". The cockpit then shows that window as open and can type into it. It tracks the
// claude process itself, and it never closes such a window.
let adoptBusy = false;
function adoptWindows() {
  if (process.platform !== 'win32' || adoptBusy) return;
  const need = [...agents.values()].filter(a => (a.mode || 'own') === 'watch' && !(termKnown(a) && a.term.alive !== false));
  if (!need.length) return;
  adoptBusy = true;
  const script = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $s = 0; try { $s = (Get-Process -Id $_.ProcessId -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch {}; ` +
    `Write-Output ("$($_.ProcessId)|$s|" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))) }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64ps(script)], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
    adoptBusy = false;
    if (err) return;
    const taken = new Set([...agents.values()].filter(a => termKnown(a) && a.term.alive !== false).map(a => a.term.pid));
    const procs = [];
    for (const l of String(stdout).split(/\r?\n/)) {
      const m = /^(\d+)\|(\d+)\|(\S*)$/.exec(l.trim());
      if (!m || m[2] === '0' || taken.has(Number(m[1]))) continue;
      const cmd = Buffer.from(m[3], 'base64').toString('utf8');
      if (/--output-format|--print|\s-p\s/.test(cmd)) continue; // not a window someone sits at
      const keys = [];
      for (const k of cmd.matchAll(/(?:--resume|-r|--name|-n)[ =]+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) keys.push((k[1] || k[2] || k[3]).toLowerCase());
      if (keys.length) procs.push({ pid: Number(m[1]), started: m[2], keys });
    }
    procs.sort((x, y) => (BigInt(y.started) > BigInt(x.started) ? 1 : -1)); // newest first
    for (const a of need) {
      if (!agents.has(a.id) || (termKnown(a) && a.term.alive !== false)) continue;
      const mine = [a.sessionId, a.title, a.name].filter(Boolean).map(v => String(v).toLowerCase());
      const p = procs.find(x => !x.used && x.keys.some(k => mine.includes(k)));
      if (!p) continue;
      p.used = true;
      a.term = { pid: p.pid, started: p.started, image: 'claude.exe', alive: true, openedAt: Date.now(), adopted: true };
      saveRoster(); emitAgent(a);
    }
  });
}

// Changes how much an agent may do without asking. It applies the next time the cockpit opens the
// agent's terminal window.
function setPermissionMode(a, mode) {
  if (!PERMISSION_MODES.includes(mode) || mode === (a.permissionMode || 'default')) return;
  a.permissionMode = mode;
  saveRoster(); emitAgent(a);
}

// ───────────────────────── HTTP ─────────────────────────

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function cookieToken(req) {
  const m = /(?:^|;\s*)cockpit=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function guard(req, res, url) {
  const hostName = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(HOST) && !LOOPBACK.has(hostName)) { json(res, 403, { error: 'Host not allowed' }); return false; }
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin) {
      let oh = ''; try { oh = new URL(origin).host; } catch { /* bad origin */ }
      if (oh !== req.headers.host) { json(res, 403, { error: 'Cross-site request refused' }); return false; }
    }
  }
  if (!TOKEN) return true;
  const given = url.searchParams.get('token');
  if (given && safeEqual(given, TOKEN)) {
    res.setHeader('set-cookie', `cockpit=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return true;
  }
  if (safeEqual(cookieToken(req), TOKEN)) return true;
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Cockpit is protected. Open it once as  http://<this-pc>:' + PORT + '/?token=<your COCKPIT_TOKEN>');
  return false;
}

function uniqueName(want, projectId) {
  const base = (want || 'AGENT').trim().slice(0, 40) || 'AGENT';
  const taken = new Set([...agents.values()].filter(a => a.projectId === projectId).map(a => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
}

// Adds every named Claude Code session of the project folder as an agent (newest session per name).
// Nothing is started: an imported agent only reads its history until you send it a message.
async function importNamed(proj, list) {
  const have = new Set([...agents.values()].map(a => a.sessionId).filter(Boolean));
  const taken = new Set([...agents.values()].filter(a => a.projectId === proj.id).flatMap(a => [a.name.toLowerCase(), (a.title || '').toLowerCase()]));
  const ignored = new Set((proj.ignored || []).map(t => t.toLowerCase()));
  const since = Date.now() - IMPORT_DAYS * 86_400_000;
  const byName = new Map();
  for (const s of list || await listSessions({ dir: proj.cwd, limit: 500 })) {
    const title = (s.customTitle || '').trim(), key = title.toLowerCase();
    if (!title || have.has(s.sessionId) || taken.has(key) || ignored.has(key) || (s.lastModified || 0) < since) continue;
    const prev = byName.get(key);
    if (!prev || (s.lastModified || 0) > (prev.lastModified || 0)) byName.set(key, s);
  }
  const added = [];
  for (const s of [...byName.values()].sort((x, y) => (y.lastModified || 0) - (x.lastModified || 0))) {
    let cwd = proj.cwd;
    try { if (s.cwd && fs.statSync(s.cwd).isDirectory()) cwd = path.resolve(s.cwd); } catch { /* keep the project folder */ }
    const title = s.customTitle.trim();
    const a = { id: crypto.randomUUID(), projectId: proj.id, mode: 'watch', title, name: uniqueName(title, proj.id), cwd, model: '', permissionMode: proj.permissionMode || 'default',
      sessionId: s.sessionId, createdAt: Date.now(), updatedAt: s.lastModified || Date.now(), cost: 0, last: '' };
    agents.set(a.id, a); added.push(a); emitAgent(a);
  }
  if (added.length) saveRoster();
  return added;
}

// Opens a terminal window, one per agent, for every agent of the project that is not running.
// An agent that looks active is left alone, so no session ends up with two windows.
function wakeState(a) {
  if ((a.mode || 'own') !== 'watch') return 'inside the cockpit';
  if (termKnown(a) && a.term.alive !== false) return 'window is open';
  const mtime = rt(a.id).watch.mtime;
  if (mtime && Date.now() - mtime < 180_000) return 'active in the last three minutes';
  return null;
}
async function wakeAll(p, ids) {
  const opened = [], skipped = [], failed = [];
  const only = Array.isArray(ids) ? new Set(ids) : null;
  for (const a of [...agents.values()].filter(x => x.projectId === p.id && (!only || only.has(x.id)))) {
    const why = wakeState(a);
    if (why) { skipped.push({ name: a.name, why }); continue; }
    try { await openTerminal(a); touch(a, a.sessionId ? 'Opened in a terminal window.' : 'Starting in a terminal window.'); opened.push(a.name); }
    catch (e) { failed.push({ name: a.name, why: e.message }); }
    await new Promise(done => setTimeout(done, 400));
  }
  return { opened, skipped, failed };
}

// Takes an agent off the roster. Its session file and its terminal window are left alone. Only an
// agent that runs inside the cockpit stops, because the cockpit is what runs it.
function removeAgent(a) {
  const r = rt(a.id);
  const proj = projects.get(a.projectId);
  if (proj && a.title) proj.ignored = [...new Set([...(proj.ignored || []), a.title])]; // do not re-add it automatically
  agents.delete(a.id); runtimes.delete(a.id);
  broadcast({ t: 'remove', agentId: a.id });
}

// ───────────────────────── broadcast ─────────────────────────
// One message or command for several agents. An agent the cockpit runs gets it directly. An agent in a
// terminal window gets it typed into that window, which works only for windows the cockpit opened
// (Windows only) and only while the agent waits for input: typing into a window that is showing a
// permission question could answer that question by accident.

const TYPE_HELPER = `
using System; using System.Runtime.InteropServices; using System.Threading;
public static class CockpitKeys {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct SCREEN_INFO { public COORD size; public COORD cur; public ushort attr; public SMALL_RECT win; public COORD max; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out SCREEN_INFO i);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr h, System.Text.StringBuilder sb, uint len, COORD at, out uint read);
  // True when the window shows a question with a preselected answer (trust this folder, a permission,
  // the bypass warning). Enter would pick that answer, so nothing is typed.
  static bool ShowsQuestion() {
    IntPtr o = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (o == new IntPtr(-1)) return false;
    SCREEN_INFO i; bool q = false;
    if (GetConsoleScreenBufferInfo(o, out i)) for (short y = i.win.T; y <= i.win.B && !q; y++) {
      var sb = new System.Text.StringBuilder(i.size.X + 1); uint n; COORD c; c.X = 0; c.Y = y;
      if (!ReadConsoleOutputCharacter(o, sb, (uint)i.size.X, c, out n)) continue;
      string line = sb.ToString(0, (int)Math.Min(n, (uint)sb.Length));
      q = line.Contains("Enter to confirm") || line.Contains("Esc to cancel");
    }
    CloseHandle(o); return q;
  }
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public int bKeyDown; [FieldOffset(4)] public ushort wRepeatCount; [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode; [FieldOffset(10)] public char UnicodeChar; [FieldOffset(12)] public uint dwControlKeyState; }
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }
  static bool Keys(IntPtr h, string text) {
    var recs = new System.Collections.Generic.List<INPUT_RECORD>();
    for (int i = 0; i < text.Length; i++) for (int d = 0; d < 2; d++) {
      char c = text[i];
      var r = new INPUT_RECORD(); r.EventType = 1; r.KeyEvent.bKeyDown = d == 0 ? 1 : 0; r.KeyEvent.wRepeatCount = 1;
      r.KeyEvent.wVirtualKeyCode = c == '\\r' ? (ushort)13 : c == (char)27 ? (ushort)27 : (ushort)0; r.KeyEvent.UnicodeChar = c; recs.Add(r); }
    // In pieces, so a long message does not overrun the console's input buffer.
    bool ok = true; uint n;
    for (int at = 0; ok && at < recs.Count; at += 256) {
      var part = recs.GetRange(at, Math.Min(256, recs.Count - at)).ToArray();
      ok = WriteConsoleInput(h, part, (uint)part.Length, out n);
      if (recs.Count > 256) Thread.Sleep(15);
    }
    return ok;
  }
  // Types the text into the console of the given process and, if asked, waits a moment and presses Enter.
  public static string Send(uint pid, string text, bool enter, bool check) {
    FreeConsole();
    if (!AttachConsole(pid)) return "could not reach its window (" + Marshal.GetLastWin32Error() + ")";
    if (check && ShowsQuestion()) { FreeConsole(); return "QUESTION"; }
    IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { FreeConsole(); return "could not open its input (" + Marshal.GetLastWin32Error() + ")"; }
    bool ok = Keys(h, text);
    if (enter) {
      Thread.Sleep(600);
      // A question that came up in the meantime: Enter is not pressed. The text stays at the prompt.
      if (check && ShowsQuestion()) { CloseHandle(h); FreeConsole(); return "QUESTION"; }
      ok = ok && Keys(h, "\\r");
    }
    CloseHandle(h); FreeConsole();
    return ok ? "sent" : "typing failed (" + Marshal.GetLastWin32Error() + ")";
  }
}`;

function typeIntoWindows(targets, line, enter, check) {
  // targets: [{ id, pid, started }]; resolves to a Map of id -> 'sent' or the reason it failed
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${TYPE_HELPER}\n'@\n$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(line, 'utf8').toString('base64')}'))\n` +
    targets.map(t => `$p = Get-Process -Id ${Number(t.pid)} -ErrorAction SilentlyContinue; $s = 0; if ($p) { try { $s = $p.StartTime.ToFileTimeUtc() } catch {} }\n` +
      `if (-not $p) { Write-Output '${t.id}|its window is closed' } elseif ("$s" -ne '${String(t.started).replace(/\D/g, '')}') { Write-Output '${t.id}|its window is closed' } else { Write-Output ('${t.id}|' + [CockpitKeys]::Send(${Number(t.pid)}, $text, $${enter ? 'true' : 'false'}, $${check ? 'true' : 'false'})) }`).join('\n');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64ps(script)], { windowsHide: true, timeout: 60000 + targets.length * 3000 }, (err, stdout, stderr) => {
      const out = new Map();
      for (const l of String(stdout).split(/\r?\n/)) { const m = /^([0-9a-f-]{36})\|(.*)$/.exec(l.trim()); if (m) out.set(m[1], m[2]); }
      const why = err ? String(stderr || err.message).split('\n').find(x => x.trim() && !x.startsWith('#<')) || 'the helper did not run' : '';
      for (const t of targets) if (!out.has(t.id)) out.set(t.id, 'typing into the window failed' + (why ? ': ' + why.trim().slice(0, 160) : ''));
      resolve(out);
    });
  });
}

const ESC = String.fromCharCode(27);
function canTalk(a) {
  return (a.mode || 'own') === 'watch' && termKnown(a) && a.term.alive !== false && (!!a.term.tmux || process.platform === 'win32');
}
// Why the cockpit should not type into an agent's window right now, or null when it is fine.
// 'hard' reasons cannot be overruled; the others guard against answering a question by accident.
function typeBlock(a, force) {
  if (!termKnown(a) || a.term.alive === false) return { why: 'it has no terminal window opened by the cockpit. Use Open terminal first', hard: true };
  if (!a.term.tmux && process.platform !== 'win32') return { why: 'typing into a terminal window needs Windows, or tmux on other systems', hard: true };
  if (force) return null;
  const r = rt(a.id), info = r.watch.info, mode = r.watch.mode || a.permissionMode;
  if (r.status === 'need' && info && info.kind === 'ask') return { why: 'it is asking a question in its window, and typed text would answer that question', hard: false };
  // On Windows the typing helper reads the window and sees whether a question is really showing, so no
  // guessing is needed there. A busy agent simply queues the message.
  if (process.platform === 'win32' && !a.term.tmux) return null;
  if (mode !== 'bypassPermissions' && r.status === 'need') return { why: 'it may be showing a permission question in its window, and Enter would answer it', hard: false };
  if (mode !== 'bypassPermissions' && r.status === 'work') return { why: 'it is busy and could show a permission question at any moment', hard: false };
  return null;
}
// Types one line into the windows of the given agents. Resolves to a Map of agent id -> 'sent' or the reason.
const QUESTION = 'QUESTION', QUESTION_WHY = 'its window is showing a question, and Enter would pick the preselected answer. Answer it in the window first';
async function typeToAgents(list, text, enter = true, check = false) {
  const line = enter ? text.replace(/\s+/g, ' ').trim() : text;
  const out = new Map();
  const tm = list.filter(a => a.term.tmux), win = list.filter(a => !a.term.tmux);
  for (const a of tm) {
    out.set(a.id, await new Promise(resolve => {
      const keys = line === ESC ? ['send-keys', '-t', a.term.tmux, 'Escape'] : ['send-keys', '-t', a.term.tmux, '-l', '--', line];
      execFile('tmux', keys, err => {
        if (err) return resolve('could not reach its tmux session');
        if (!enter) return resolve('sent');
        setTimeout(() => execFile('tmux', ['send-keys', '-t', a.term.tmux, 'Enter'], e2 => resolve(e2 ? 'could not press Enter in its tmux session' : 'sent')), 600);
      });
    }));
  }
  // Tested on Windows 11: the console turns an emoji typed as keys into broken characters, whatever the
  // order of the key events. Accented letters are fine. So emoji are left out of typed text.
  const keys = line.replace(/[\u{10000}-\u{10FFFF}]️?/gu, '').replace(/ {2,}/g, ' ');
  if (win.length) for (const [id, res] of await typeIntoWindows(win.map(a => ({ id: a.id, pid: a.term.pid, started: a.term.started })), keys, enter, check)) out.set(id, res);
  return out;
}
function nudgeWatch(a) { rt(a.id).viewedAt = Date.now(); for (const ms of [900, 2200, 4500]) setTimeout(() => pollWatched(a).catch(() => {}), ms); }

async function broadcastTo(p, ids, text) {
  const only = new Set(Array.isArray(ids) ? ids : []);
  const sent = [], skipped = [], typing = [];
  for (const a of [...agents.values()].filter(x => x.projectId === p.id && only.has(x.id))) {
    const block = typeBlock(a, false);
    if (block) { skipped.push({ name: a.name, why: block.why }); continue; }
    typing.push(a);
  }
  if (typing.length) {
    const res = await typeToAgents(typing, text, true, true);
    for (const a of typing) { const out = res.get(a.id); if (out === 'sent') { sent.push(a.name); nudgeWatch(a); } else skipped.push({ name: a.name, why: out === QUESTION ? QUESTION_WHY : out }); }
  }
  return { sent, skipped };
}

// Stops the cockpit itself. Nothing changes about where an agent lives: agents in terminal windows
// keep running, and agents that run inside the cockpit stay cockpit agents. They pause, and one that
// was in the middle of a turn is marked so the page can offer to continue it after the next start.

const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, app: 'agent-cockpit' }),
  'POST /api/shutdown': async (req, res) => {
    await readBody(req);
    const paused = [...agents.values()].filter(a => (a.mode || 'own') !== 'watch' && ['work', 'need'].includes(rt(a.id).status)).map(a => a.name);
    json(res, 200, { ok: true, paused });
    broadcast({ t: 'shutdown' });
    console.log('Shut down on request.' + (paused.length ? ' Interrupted in the middle of a turn: ' + paused.join(', ') : ''));
    setTimeout(shutdown, 500);
  },
  'GET /api/state': async (req, res) => {
    json(res, 200, { projects: [...projects.values()].map(publicProject), agents: [...agents.values()].map(publicAgent), home: os.homedir(), platform: process.platform, tokenRequired: !!TOKEN });
  },

  'GET /api/events': async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
  },

  // Previous Claude Code sessions on this PC, for "Resume".
  'GET /api/sessions': async (req, res, url) => {
    const proj = projects.get(url.searchParams.get('projectId') || '');
    const dir = proj ? proj.cwd : expandHome(url.searchParams.get('dir') || '');
    const limit = Math.min(Number(url.searchParams.get('limit') || 60), 300);
    const inRoster = new Map([...agents.values()].filter(a => a.sessionId).map(a => [a.sessionId, a.name]));
    const list = await listSessions(dir ? { dir, limit } : { limit });
    json(res, 200, { sessions: list.map(s => ({
      sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || '(untitled)', named: !!s.customTitle,
      firstPrompt: (s.firstPrompt || '').slice(0, 200), cwd: s.cwd || '', cwdShort: shortPath(s.cwd || ''), gitBranch: s.gitBranch || '',
      lastModified: s.lastModified, agent: inRoster.get(s.sessionId) || null,
    })) });
  },

  // Folders that already hold Claude Code sessions, to suggest as projects.
  'GET /api/folders': async (req, res) => {
    const seen = new Map();
    try {
      for (const s of await listSessions({ limit: 500 })) {
        if (!s.cwd) continue;
        const e = seen.get(s.cwd) || { last: 0, count: 0 };
        e.last = Math.max(e.last, s.lastModified || 0); e.count++;
        seen.set(s.cwd, e);
      }
    } catch { /* none yet */ }
    const taken = [...projects.values()].map(p => p.cwd);
    const folders = [...seen.entries()].sort((x, y) => y[1].last - x[1].last)
      .filter(([p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
      .filter(([p]) => !taken.some(t => samePath(t, p)));
    json(res, 200, { folders: folders.slice(0, 40).map(([p, e]) => ({ path: p, short: shortPath(p), sessions: e.count, last: e.last })) });
  },

  'POST /api/projects': async (req, res) => {
    const b = await readBody(req);
    if (!String(b.cwd || '').trim()) return json(res, 400, { error: 'Choose the project folder.' });
    const cwd = path.resolve(expandHome(String(b.cwd).trim()));
    let st; try { st = fs.statSync(cwd); } catch { /* missing */ }
    if (!st || !st.isDirectory()) return json(res, 400, { error: `Folder not found: ${cwd}` });
    const dup = [...projects.values()].find(p => samePath(p.cwd, cwd));
    if (dup) return json(res, 200, { project: publicProject(dup), existing: true, imported: 0 });
    const p = { id: crypto.randomUUID(), name: String(b.name || '').trim().slice(0, 60) || path.basename(cwd) || cwd, cwd, note: String(b.note || '').slice(0, 4000), autoImport: b.importNamed !== false, ignored: [], createdAt: Date.now() };
    projects.set(p.id, p); saveRoster();
    broadcast({ t: 'project', project: publicProject(p) });
    let imported = 0;
    if (b.importNamed !== false) { try { imported = (await importNamed(p)).length; } catch (e) { console.error('[import]', e.message); } }
    json(res, 200, { project: publicProject(p), imported });
  },

  // New agent, or resume a previous session as an agent (body.sessionId).
  'POST /api/agents': async (req, res) => {
    const b = await readBody(req);
    const proj = projects.get(b.projectId);
    if (!proj) return json(res, 400, { error: 'Choose a project first.' });
    // A resumed session keeps the folder it was recorded in (the project folder or one of its worktrees).
    let cwd = proj.cwd;
    if (b.sessionId && b.cwd) { try { if (fs.statSync(b.cwd).isDirectory()) cwd = path.resolve(b.cwd); } catch { /* fall back to the project folder */ } }
    if (b.sessionId) {
      const dup = [...agents.values()].find(a => a.sessionId === b.sessionId);
      if (dup) return json(res, 200, { agent: publicAgent(dup), existing: true });
    }
    const a = {
      id: crypto.randomUUID(), projectId: proj.id, name: uniqueName(b.name, proj.id), cwd, model: String(b.model || '').trim(),
      permissionMode: PERMISSION_MODES.includes(b.permissionMode) ? b.permissionMode : (proj.permissionMode || 'default'),
      sessionId: b.sessionId || null, createdAt: Date.now(), updatedAt: Date.now(), cost: 0,
      mode: 'watch', title: String(b.title || '').trim(),
      last: b.sessionId ? 'Open terminal to continue it in its own window.' : 'Starting in a terminal window.',
    };
    if (a.title && proj.ignored) proj.ignored = proj.ignored.filter(t => t.toLowerCase() !== a.title.toLowerCase());
    agents.set(a.id, a); saveRoster();
    const r = rt(a.id);
    if (b.sessionId) { a.last = ''; emitAgent(a); return json(res, 200, { agent: publicAgent(a) }); } // resumed: shown live, Open terminal gives it a window
    // A new agent: the terminal creates the session. The roster shows a placeholder that attaches to it by name.
    const first = String(b.firstMessage || '').trim();
    a.title = a.name;
    emitAgent(a);
    try { await openTerminal(a, first.length <= 1500 ? first : ''); }
    catch (e) { agents.delete(a.id); runtimes.delete(a.id); saveRoster(); broadcast({ t: 'remove', agentId: a.id }); return json(res, 500, { error: e.message }); }
    saveRoster();
    for (const ms of [4000, 9000]) setTimeout(scanProjects, ms);
    json(res, 200, { agent: publicAgent(a), hint: first.length > 1500 ? 'The first message was too long to pass along. Paste it in the terminal.' : '' });
  },
};

const agentRoutes = {
  'GET items': async (a, req, res) => {
    const r = rt(a.id);
    r.viewedAt = Date.now();
    await ensureHistory(a);
    json(res, 200, { items: r.items, commands: r.commands.length ? r.commands : (a.commands || []) });
  },
  'POST message': async (a, req, res) => {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    const images = (Array.isArray(b.images) ? b.images : []).filter(i => i && /^image\/(png|jpeg|gif|webp)$/.test(i.mediaType) && typeof i.data === 'string').slice(0, 10);
    if (!text && !images.length) return json(res, 400, { error: 'Empty message' });
    const block = typeBlock(a, b.force === true);
    if (block) return json(res, 409, { error: `${a.name}: ${block.why}.`, canForce: !block.hard });
    let line = text;
    if (images.length) {
      // A terminal cannot take a pasted image from here, so the image is saved and the agent is told where it is.
      const dir = path.join(os.tmpdir(), 'agent-cockpit', a.id); fs.mkdirSync(dir, { recursive: true });
      const paths = images.map((im, n) => { const f = path.join(dir, `${Date.now()}-${n}.${im.mediaType.split('/')[1].replace('jpeg', 'jpg')}`); fs.writeFileSync(f, Buffer.from(im.data, 'base64')); return f; });
      line = (line ? line + ' ' : '') + paths.map(f => `[Look at this image: ${f}]`).join(' ');
    }
    const out = (await typeToAgents([a], line, true, b.force !== true)).get(a.id);
    if (out === QUESTION) return json(res, 409, { error: `${a.name}: ${QUESTION_WHY}.`, canForce: true });
    if (out !== 'sent') return json(res, 502, { error: `${a.name}: ${out}.` });
    nudgeWatch(a);
    json(res, 200, { ok: true, typed: true });
  },
  // Closes the agent's terminal window, which ends the agent. Only for a window the cockpit opened.
  'POST stop': async (a, req, res) => {
    if (!termKnown(a) || a.term.alive === false || a.term.adopted) return json(res, 409, { error: `The cockpit did not open a window for ${a.name}, so it cannot close one. Close its terminal window yourself.` });
    await closeWindow(a);
    rt(a.id).status = 'idle'; touch(a, 'Stopped. Its terminal window was closed.');
    json(res, 200, { ok: true });
  },
  // Esc in the agent's window: Claude Code stops what it is doing and waits for you.
  'POST interrupt': async (a, req, res) => {
    const block = typeBlock(a, true);
    if (block) return json(res, 409, { error: `${a.name}: ${block.why}.` });
    const out = (await typeToAgents([a], ESC, false)).get(a.id);
    if (out !== 'sent') return json(res, 502, { error: `${a.name}: ${out}.` });
    nudgeWatch(a);
    json(res, 200, { ok: true });
  },
  'POST settings': async (a, req, res) => {
    const b = await readBody(req);
    const r = rt(a.id);
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== a.name) a.name = uniqueName(b.name, a.projectId);
    if (typeof b.permissionMode === 'string') await setPermissionMode(a, b.permissionMode);
    if (typeof b.model === 'string' && b.model.trim() !== (a.model || '')) {
      a.model = b.model.trim();
    }
    if (b.status === 'idle' && r.status === 'review') r.status = 'idle';
    touch(a);
    json(res, 200, { agent: publicAgent(a) });
  },
  // The browser says it is looking at this agent, so its chat is kept up to date.
  'POST view': async (a, req, res) => { rt(a.id).viewedAt = Date.now(); json(res, 200, { ok: true }); },
  // Opens a terminal window running this agent. The terminal owns the session from then on.
  'POST terminal': async (a, req, res) => {
    try { await openTerminal(a); } catch (e) { return json(res, 500, { error: e.message }); }
    touch(a, a.sessionId ? 'Opened in a terminal window.' : 'Starting in a terminal window.');
    json(res, 200, { agent: publicAgent(a) });
  },
  // Removes the agent from the cockpit. The session file stays on disk and can be resumed again.
  'DELETE ': async (a, req, res) => { removeAgent(a); saveRoster(); json(res, 200, { ok: true }); },
};

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400); return res.end(); }
  if (!guard(req, res, url)) return;
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    }
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return await routes[key](req, res, url);
    const im = /^\/api\/projects\/([0-9a-f-]{36})\/import$/.exec(url.pathname);
    if (im && req.method === 'POST') {
      const p = projects.get(im[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      return json(res, 200, { imported: (await importNamed(p)).length });
    }
    const rm = /^\/api\/projects\/([0-9a-f-]{36})\/remove$/.exec(url.pathname);
    if (rm && req.method === 'POST') {
      const p = projects.get(rm[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      const b = await readBody(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids : []);
      const gone = [...agents.values()].filter(a => a.projectId === p.id && ids.has(a.id));
      for (const a of gone) removeAgent(a);
      saveRoster();
      return json(res, 200, { removed: gone.map(a => a.name) });
    }
    const bc = /^\/api\/projects\/([0-9a-f-]{36})\/broadcast$/.exec(url.pathname);
    if (bc && req.method === 'POST') {
      const p = projects.get(bc[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'Write the message or command to send.' });
      return json(res, 200, await broadcastTo(p, b.ids, text.slice(0, 4000)));
    }
    const wk = /^\/api\/projects\/([0-9a-f-]{36})\/wake$/.exec(url.pathname);
    if (wk && req.method === 'POST') {
      const p = projects.get(wk[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      const b = await readBody(req);
      return json(res, 200, await wakeAll(p, b.ids));
    }
    const pm = /^\/api\/projects\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (pm) {
      const p = projects.get(pm[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim().slice(0, 60);
        if (typeof b.note === 'string') p.note = b.note.slice(0, 4000);
        if (typeof b.autoImport === 'boolean') p.autoImport = b.autoImport;
        if (PERMISSION_MODES.includes(b.permissionMode)) {
          p.permissionMode = b.permissionMode; // the team's setting: every agent of the project gets it
          for (const a of [...agents.values()].filter(x => x.projectId === p.id)) await setPermissionMode(a, b.permissionMode);
        }
        saveRoster(); broadcast({ t: 'project', project: publicProject(p) });
        return json(res, 200, { project: publicProject(p) });
      }
      if (req.method === 'DELETE') {
        // Removes the project and its agents from the cockpit. Folders and session files are not touched.
        for (const a of [...agents.values()].filter(x => x.projectId === p.id)) {
          agents.delete(a.id); runtimes.delete(a.id);
          broadcast({ t: 'remove', agentId: a.id });
        }
        projects.delete(p.id); saveRoster();
        broadcast({ t: 'projectRemove', projectId: p.id });
        return json(res, 200, { ok: true });
      }
    }
    const vw = /^\/view\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url.pathname);
    if (vw && req.method === 'GET') {
      const a = agents.get(vw[1]);
      if (!a) return json(res, 404, { error: 'Agent not found' });
      await ensureHistory(a);
      return serveView(a, req, res, vw[2], vw[3]);
    }
    const m = /^\/api\/agents\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(url.pathname);
    if (m) {
      const a = agents.get(m[1]);
      if (!a) return json(res, 404, { error: 'Agent not found' });
      const h = agentRoutes[`${req.method} ${m[2] || ''}`];
      if (h) return await h(a, req, res, url);
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) json(res, 500, { error: e.message || 'Server error' });
  }
});

function shutdown() {
  // Nothing to stop: every agent lives in its own terminal window and keeps running.
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ROSTER_FILE, rosterJson()); } catch { /* best effort */ }
  process.exit(0);
}

const shownUrl = () => `http://${LOOPBACK.has(HOST) ? 'localhost' : HOST}:${PORT}/`;
function openBrowser(url) {
  exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`, () => {});
}
// Talks to a cockpit that is already running on this PC (used by --stop, --ping and --wait).
function localCall(method, p, body, timeout = 4000) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout, headers: {
      host: `localhost:${PORT}`,
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      ...(TOKEN ? { cookie: `cockpit=${encodeURIComponent(TOKEN)}` } : {}) } }, res => {
      let out = ''; res.on('data', c => { out += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch { /* not ours */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
const isUp = async () => { const r = await localCall('GET', '/api/health'); return !!(r && r.status === 200 && r.json && r.json.app === 'agent-cockpit'); };

// The cockpit also writes what it prints to data/cockpit.log, because it normally runs without a window.
function teeLog() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, 'cockpit.log');
    try { if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.old'); } catch { /* no log yet */ }
    const out = fs.createWriteStream(file, { flags: 'a' });
    out.on('error', () => {});
    for (const k of ['log', 'error']) {
      const orig = console[k].bind(console);
      console[k] = (...args) => {
        orig(...args);
        const text = args.map(x => typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x)).join(' ').trim();
        if (text) out.write(`[${new Date().toISOString()}] ${text}\n`);
      };
    }
  } catch { /* logging is optional */ }
}

function start() {
  teeLog();
  let tries = 0;
  const onListening = () => {
    loadRoster();
    setInterval(watchTick, WATCH_MS);
    setInterval(scanProjects, SCAN_MS);
    setInterval(checkWindows, 8000);
    setTimeout(scanProjects, 800);
    setTimeout(checkWindows, 1500);
    setInterval(adoptWindows, 20000);
    setTimeout(adoptWindows, 4000);
    console.log(`\n  Agent Cockpit is running:  ${shownUrl()}${TOKEN ? '?token=…' : ''}`);
    console.log(`  ${projects.size} project(s), ${agents.size} agent(s) · data in ${DATA_DIR}`);
    console.log('  Agents in terminal windows keep running when the cockpit stops.');
    console.log('  Stop the cockpit with Shut down in the page, with stop.cmd, or with Ctrl+C here.\n');
    if (process.argv.includes('--open')) openBrowser(shownUrl());
  };
  server.on('error', async e => {
    if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); }
    // The port is taken. Either a cockpit is running, or one is just shutting down (a restart).
    // Give a cockpit that is going down a few seconds to release the port before deciding.
    tries++;
    await new Promise(done => setTimeout(done, 700));
    if (tries >= 8 || (tries >= 4 && await isUp())) {
      if (await isUp()) { console.log(`Cockpit is already running at ${shownUrl()}`); if (process.argv.includes('--open')) openBrowser(shownUrl()); return setTimeout(() => process.exit(0), 400); }
      console.error(`Port ${PORT} is used by another program. Set COCKPIT_PORT to a free port.`); process.exit(1);
    }
    server.listen(PORT, HOST);
  });
  server.on('listening', onListening);
  server.listen(PORT, HOST);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv.includes('--stop')) {
  const r = await localCall('POST', '/api/shutdown', {}, 30000);
  if (r && r.status === 200) console.log('Cockpit stopped.' + (r.json && r.json.paused && r.json.paused.length ? ' Interrupted in the middle of a turn: ' + r.json.paused.join(', ') + '. They offer Continue after the next start.' : ''));
  else console.log('Cockpit was not running.');
  // Return only when it is really gone, so a start right after this finds the port free.
  for (let i = 0; i < 60 && await isUp(); i++) await new Promise(done => setTimeout(done, 250));
  process.exit(0);
} else if (process.argv.includes('--ping')) {
  process.exit(await isUp() ? 0 : 1);
} else if (process.argv.includes('--wait')) {
  for (let i = 0; i < 40; i++) {
    if (await isUp()) { console.log(`  Cockpit is running: ${shownUrl()}`); process.exit(0); }
    await new Promise(done => setTimeout(done, 500));
  }
  process.exit(1);
} else {
  start();
}
