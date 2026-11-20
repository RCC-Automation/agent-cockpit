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
import { HARNESSES, HARNESS_LABELS } from './harnesses.mjs';
import { hubConfig, createHubClient, deliveryText, outcomeFor } from './hub-client.mjs';

// Which tool runs an agent. Claude Code is the default; the others are read by harnesses.mjs.
const harnessOf = a => (a && HARNESSES[a.harness]) ? a.harness : 'claude';
const otherTool = a => harnessOf(a) !== 'claude' ? HARNESSES[a.harness] : null;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COCKPIT_PORT || 4600);
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const TOKEN = process.env.COCKPIT_TOKEN || '';
const TEST_MODE = process.env.COCKPIT_TEST === '1'; // a cockpit started by the test suite (test/helpers.mjs)
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
    saveTimer = null; // nothing pending any more (shutdown() writes only while one is)
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
    login: a.login || null, cost: r.watch.cost || 0, harness: harnessOf(a), harnessLabel: HARNESS_LABELS[harnessOf(a)],
    modelLive: otherTool(a) ? (r.watch.model || '') : '', profile: a.profile || '', hubTeam: a.hubTeam || null, liveSwitch: otherTool(a) ? !!otherTool(a).liveSwitch : true,
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
// A hub notice the cockpit typed for a teammate's message (hub-client.mjs deliveryText): a message card too.
const TEAM_NOTICE = /^\s*\[Team message (\S+) from (.+?)\. Read it with get_pending_messages\.\]\s*$/;
function parsePeer(t) {
  if (!t) return null;
  const n = TEAM_NOTICE.exec(t);
  if (n) return { from: n[2], text: `Team message ${n[1]}. ${n[2]} sent it through the Agent Hub; the agent reads it with get_pending_messages.` };
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
        // Visible thinking: the Claude app shows it between the steps, so the cockpit does too.
        else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) items.push({ k: 'text', id: `${m.uuid}:${i}`, text: b.thinking, thought: true });
        else if (b.type === 'tool_use') {
          const it = { k: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input, cwd), input: b.input, files: viewFiles(a, b.input), result: '', status: 'ok' };
          tools.set(b.id, it); items.push(it);
        }
      });
    } else if (m.type === 'system' && msg?.subtype === 'compact_boundary') {
      items.push({ k: 'note', id: m.uuid, text: 'Context was compacted here' });
    }
  }
  markArtifacts(items, a);
  // In a session that is still running, a last tool call without a result is still in progress.
  const tail = items[items.length - 1];
  if (live && tail && tail.k === 'tool' && !tail.result) tail.status = 'run';
  return items;
}

// Artifacts an agent published or opened get a card in the chat, like in the Claude app: name, what
// happened, and a link. The name comes from the call, from the page's <title>, or from an earlier call
// with the same link.
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
const titleCache = new Map();
function htmlTitle(file) {
  try {
    const st = fs.statSync(file), c = titleCache.get(file);
    if (c && c.mtime === st.mtimeMs) return c.title;
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(st.size, 65536));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(buf.toString('utf8'));
    const title = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
    titleCache.set(file, { mtime: st.mtimeMs, title });
    return title;
  } catch { return ''; }
}
// Names of artifacts seen in any session, kept across restarts, so an artifact that was only opened
// (the tool's answer carries no name) still shows its name.
const NAMES_FILE = path.join(DATA_DIR, 'artifact-names.json');
const artifactNames = new Map((() => { try { return Object.entries(JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'))); } catch { return []; } })());
let namesTimer = null;
function rememberName(url, title) {
  if (!url || !title || artifactNames.get(url) === title) return;
  artifactNames.set(url, title);
  clearTimeout(namesTimer);
  namesTimer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(NAMES_FILE, JSON.stringify(Object.fromEntries(artifactNames), null, 1)); } catch { /* next time */ } }, 2000);
}
function nameItems(items, names) {
  for (const it of items) if (it.artifact && it.artifact.title === 'Artifact' && names.has(it.artifact.url)) it.artifact.title = names.get(it.artifact.url);
  for (const it of items) if (it.k === 'text' && ARTIFACT_URL.test(it.text)) {
    const links = Object.fromEntries([...names].filter(([u]) => it.text.includes(u)));
    if (Object.keys(links).length) it.links = links;
  }
}
// Looks once through the other sessions of the same project folder for the call that published this link.
const nameLookups = new Set();
async function lookupName(url, a) {
  if (nameLookups.has(url)) return; nameLookups.add(url);
  const file = sessionFile(a); if (!file) return;
  const dir = path.dirname(file);
  let files = [];
  try { files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return; }
  for (const f of files) {
    let text; try { text = await fs.promises.readFile(f, 'utf8'); } catch { continue; }
    if (!text.includes(url)) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('"Artifact"')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b.type !== 'tool_use' || b.name !== 'Artifact' || !b.input || (b.input.action && b.input.action !== 'publish')) continue;
        const title = String(b.input.title || '').trim() || (typeof b.input.file_path === 'string' ? htmlTitle(b.input.file_path) : '');
        if (title && (b.input.url === url || line.includes(url))) rememberName(url, title);
      }
    }
    if (artifactNames.has(url)) break;
  }
  if (!artifactNames.has(url)) return;
  const r = rt(a.id);
  nameItems(r.items, artifactNames);
  broadcast({ t: 'reset', agentId: a.id });
}
function markArtifacts(items, a) {
  const known = new Map();
  for (const it of items) {
    if (it.k !== 'tool' || it.name !== 'Artifact' || !it.input) continue;
    const act = it.input.action || 'publish';
    if (act !== 'publish' && act !== 'open') continue;
    if (act === 'publish' && it.input.asset) continue;
    const url = (ARTIFACT_URL.exec(String(it.input.url || '')) || ARTIFACT_URL.exec(it.result || '') || [])[0] || '';
    let title = String(it.input.title || '').trim();
    if (!title && act === 'publish' && typeof it.input.file_path === 'string') title = htmlTitle(it.input.file_path);
    if (url && title) { known.set(url, title); rememberName(url, title); }
    it.artifact = { url, title: title || 'Artifact', action: act, description: String(it.input.description || '') };
  }
  // Cards whose name is in another call or another session, and artifact links in text, use the same names.
  const names = new Map([...artifactNames, ...known]);
  nameItems(items, names);
  if (a) for (const it of items) if (it.artifact && it.artifact.title === 'Artifact' && it.artifact.url) lookupName(it.artifact.url, a).catch(() => {});
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
function tailInfo(lines, cwd, side = false) {
  let info = null, cost = null, mode = null;
  for (let i = lines.length - 1; i >= 0 && !(info && cost != null && mode != null); i--) {
    if (!lines[i]) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (cost == null && o.type === 'cost-state' && typeof o.totalCostUSD === 'number') { cost = o.totalCostUSD; continue; }
    if (mode == null && o.type === 'user' && typeof o.permissionMode === 'string') mode = o.permissionMode;
    if (side && info) break;
    if (info || (o.isSidechain && !side) || o.isMeta || (o.type !== 'user' && o.type !== 'assistant')) continue;
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
      const tool = otherTool(a);
      const fresh = tool ? finishOther(a, (await tool.read(a.sessionId))?.items || []) : itemsFromHistory(await getSessionMessages(a.sessionId, { dir: a.cwd }), a, true);
      applyHistory(a, fresh, !r.historyLoaded);
      w.loadedMtime = at; r.historyLoaded = true;
    } catch (e) { if (process.env.COCKPIT_DEBUG) console.error(`[${a.name}] history:`, e.message); }
    finally { w.loading = null; }
  })();
  return w.loading;
}

// ───────────────────────── helpers an agent started (subagents and workflows) ─────────────────────────
// Claude Code writes each helper's work to its own file next to the session:
//   <session>/subagents/agent-<id>.jsonl (+ .meta.json)                 a helper started with the Agent tool
//   <session>/subagents/workflows/<runId>/agent-<id>.jsonl, journal.jsonl  the helpers of one workflow run
// The cockpit only reads these files.
const SUB_FRESH_MS = 120_000;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function subAgentInfo(file, cwd) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const lines = readTail(file, st.size);
  const t = tailInfo(lines, cwd, true);
  let steps = 0, model = '', done = false, wait = 0;
  for (const l of lines) {
    if (!l.includes('"assistant"') && !l.includes('"user"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'user') { wait = 0; continue; }
    if (o.type !== 'assistant') continue;
    model = o.message?.model || model;
    const c = Array.isArray(o.message?.content) ? o.message.content : [];
    const tools = c.filter(b => b.type === 'tool_use');
    steps += tools.length;
    done = o.message?.stop_reason === 'end_turn' && !tools.length;
    // A helper waiting for a long command writes nothing until it ends, so it counts as working for as
    // long as that command may take.
    wait = tools.length ? Math.max(SUB_FRESH_MS, ...tools.map(b => Number(b.input?.timeout) || 0)) + 5 * 60_000 : 0;
  }
  return { mtime: Math.round(st.mtimeMs), steps, model, endTurn: done, wait, last: t.info ? t.info.text.replace(/\s+/g, ' ').slice(0, 200) : '' };
}
function subStatus(info, journal) {
  if (journal === 'failed') return 'failed';
  if (journal === 'done') return 'done';
  const fresh = Date.now() - info.mtime < (info.wait || SUB_FRESH_MS);
  if (info.endTurn) return 'done';
  if (fresh) return 'run';
  return 'stopped';
}
function listSubagents(a) {
  if (otherTool(a)) return [];
  const file = sessionFile(a); if (!file) return [];
  const base = path.join(path.dirname(file), path.basename(file, '.jsonl'));
  const dir = path.join(base, 'subagents'), runs = [];
  const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
  const one = (d, f, extra) => {
    const id = f.slice(6, -6), info = subAgentInfo(path.join(d, f), a.cwd);
    if (!info) return null;
    const meta = readJson(path.join(d, `agent-${id}.meta.json`)) || {};
    return { id, label: extra.label || meta.description || meta.agentType || 'helper', phase: extra.phase || meta.workflowPhase || '',
      type: meta.agentType || '', model: info.model.replace(/^claude-/, '') || meta.model || '', steps: info.steps, last: info.last,
      updatedAt: info.mtime, status: extra.status || subStatus(info, meta.finished ? 'done' : ''), toolUseId: meta.toolUseId || '',
      background: meta.requestShape === 'background' };
  };
  // Helpers started one by one with the Agent tool.
  const plain = ls(dir).filter(f => /^agent-[\w-]+\.jsonl$/.test(f)).map(f => one(dir, f, {})).filter(Boolean);
  if (plain.length) runs.push({ id: 'agents', kind: 'agents', name: 'Helpers', agents: plain.sort((x, y) => y.updatedAt - x.updatedAt) });
  // Workflow runs.
  const scripts = ls(path.join(base, 'workflows', 'scripts'));
  for (const wf of ls(path.join(dir, 'workflows'))) {
    const wd = path.join(dir, 'workflows', wf), journal = new Map(), order = [];
    let jt = 0;
    try {
      jt = fs.statSync(path.join(wd, 'journal.jsonl')).mtimeMs;
      for (const l of fs.readFileSync(path.join(wd, 'journal.jsonl'), 'utf8').split('\n')) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (!o.agentId) continue;
        if (o.type === 'started') { journal.set(o.agentId, { label: o.label, phase: o.phase, status: '' }); order.push(o.agentId); }
        else if (journal.has(o.agentId)) journal.get(o.agentId).status = o.type === 'failed' ? 'failed' : 'done';
      }
    } catch { /* no journal yet */ }
    const agentsHere = order.map(id => {
      const j = journal.get(id);
      const r = fs.existsSync(path.join(wd, `agent-${id}.jsonl`)) ? one(wd, `agent-${id}.jsonl`, { label: j.label, phase: j.phase }) : null;
      const s = r || { id, label: j.label, phase: j.phase, model: '', steps: 0, last: '', updatedAt: Math.round(jt), status: 'run' };
      if (j.status) s.status = j.status;
      return s;
    });
    const script = scripts.find(s => s.endsWith(`-${wf}.js`));
    const name = script ? script.slice(0, -(wf.length + 4)) : wf;
    const latest = Math.max(jt, ...agentsHere.map(x => x.updatedAt));
    const running = agentsHere.some(x => x.status === 'run') || Date.now() - jt < 15_000;
    runs.push({ id: wf, kind: 'workflow', name, updatedAt: Math.round(latest), status: running ? 'run' : agentsHere.some(x => x.status === 'failed') ? 'failed' : 'done', agents: agentsHere });
  }
  for (const r of runs) if (!r.updatedAt) r.updatedAt = Math.max(0, ...r.agents.map(x => x.updatedAt));
  return runs.sort((x, y) => (y.status === 'run') - (x.status === 'run') || y.updatedAt - x.updatedAt);
}
// The steps of one helper, shown like an agent's own chat.
function subagentItems(a, runId, subId) {
  if (otherTool(a)) return null;
  const file = sessionFile(a); if (!file || !/^[\w-]+$/.test(subId) || !/^[\w-]+$/.test(runId)) return null;
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', ...(runId === 'agents' ? [] : ['workflows', runId]));
  let text; try { text = fs.readFileSync(path.join(dir, `agent-${subId}.jsonl`), 'utf8'); } catch { return null; }
  const msgs = [];
  for (const l of text.split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (o.type === 'user' || o.type === 'assistant') msgs.push(o); } catch { /* half-written line */ } }
  const items = itemsFromHistory(msgs, a, true);
  // The first message is the task the helper was given, framed by the harness. Keep only the task.
  // A workflow helper gets two: the person's request that started the run, then the computed task.
  for (const it of items) {
    if (it.k !== 'user') break;
    it.text = it.text.replace(/^\[Workflow harness[^\]]*\][^\n]*\n/, '').replace(/^\s{2}/gm, '').trim(); it.task = true;
  }
  return items;
}

// Items from another tool's reader get the same extras as Claude Code's: a one-line summary and file previews.
function finishOther(a, items) {
  for (const it of items) if (it.k === 'tool') {
    const input = it.input && typeof it.input === 'object' ? it.input : { command: String(it.input || '') };
    it.summary = toolSummary(it.name, input, a.cwd); it.files = viewFiles(a, input); it.result = clip(it.result || '');
  }
  return items;
}
// An agent of another tool that the cockpit just started has no session id yet. Its session is the newest one
// in its folder that began after its window opened (Hermes: the one carrying its name).
// A session that carries the agent's name is its own whenever it is found; matching by start time only works
// soon after the window opened, so that is tried only then. Looked up at most every 15 s per agent.
const attachTried = new Map();
async function attachOther(a, tool) {
  if (!a.term || !a.term.openedAt) return;
  if (Date.now() - (attachTried.get(a.id) || 0) < 15_000) return;
  attachTried.set(a.id, Date.now());
  const used = new Set([...agents.values()].map(x => x.sessionId).filter(Boolean));
  let list; try { list = await tool.sessions(a.cwd, a.term.openedAt - 60_000); } catch { return; }
  const name = (a.title || a.name).toLowerCase();
  const fresh = Date.now() - a.term.openedAt < 30 * 60_000;
  if (list.some(x => 'profile' in x)) list = list.filter(x => (x.profile || '') === (a.profile || ''));
  const s = list.find(x => !used.has(x.sessionId) && x.title.toLowerCase() === name)
    || (fresh ? list.filter(x => !used.has(x.sessionId) && x.createdAt >= a.term.openedAt - 15_000).sort((x, y) => x.createdAt - y.createdAt)[0] : null);
  if (!s) return;
  a.sessionId = s.sessionId; a.hubAgentId = null; a.hubTeam = null; a.hubRouteId = null; saveRoster(); emitAgent(a);
  broadcast({ t: 'reset', agentId: a.id }); // the page loaded the empty chat before this session was found
}
async function pollOther(a, tool) {
  if (!a.sessionId) { await attachOther(a, tool); if (!a.sessionId) return; }
  const r = rt(a.id), w = r.watch;
  const stamp = await tool.stamp(a.sessionId);
  if (stamp == null) return;
  if (stamp !== w.stamp) {
    const got = await tool.read(a.sessionId); if (!got) return;
    w.stamp = stamp; w.mtime = got.mtime; w.info = got.info;
    if (got.model && got.model !== w.model) { w.model = got.model; emitAgent(a); }
  }
  if (Date.now() - r.viewedAt < 20_000 && w.loadedMtime !== w.mtime) await loadWatched(a);
  applyWatchState(a);
}

async function pollWatched(a) {
  const tool = otherTool(a);
  if (tool) return pollOther(a, tool);
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
  applyWatchState(a);
}
function applyWatchState(a) {
  const r = rt(a.id), w = r.watch;
  let s = watchState(w.info, Date.now() - w.mtime);
  if (!s) return;
  if (a.term && a.term.alive === false && (s[0] === 'work' || s[0] === 'need')) s = ['idle', 'Its terminal window is closed.'];
  // An agent with no open window is not running, so it is idle, even when its last word was an answer.
  if (s[0] === 'review' && !wakeState(a)) s = ['idle', s[1]];
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
        if (a.projectId !== p.id || a.mode !== 'watch' || harnessOf(a) !== 'claude') continue;
        const s = newest.get((a.title || a.name).toLowerCase());
        if (!s || s.sessionId === a.sessionId || used.has(s.sessionId)) continue;
        used.add(s.sessionId);
        a.sessionId = s.sessionId; a.hubAgentId = null; a.hubTeam = null; a.hubRouteId = null;
        const r = rt(a.id);
        r.watch = { mtime: 0, size: 0, info: null, cost: null, loadedMtime: -1 }; r.items = []; r.historyLoaded = false;
        saveRoster(); broadcast({ t: 'reset', agentId: a.id }); emitAgent(a);
      }
      if (p.autoImport !== false) { try { await importNamed(p, list); } catch { /* next scan */ } }
    }
  } finally { scanBusy = false; }
  syncHub().catch(() => {});
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
// The program and arguments a window runs: Claude Code, or another tool (harnesses.mjs).
function agentCommand(a, firstMessage) {
  const tool = otherTool(a);
  return tool ? { bin: tool.bin, args: tool.args(a, firstMessage), extra: '' } : { bin: 'claude', args: claudeArgs(a, firstMessage), extra: extraArgs() };
}
function terminalScript(a, firstMessage) {
  const c = agentCommand(a, firstMessage);
  return `$Host.UI.RawUI.WindowTitle = ${psQuote(termTitle(a))}; Set-Location -LiteralPath ${psQuote(a.cwd)}; ${c.bin} ${c.args.map(psQuote).join(' ')}${c.extra}`;
}
function shellLine(a, firstMessage) {
  const c = agentCommand(a, firstMessage);
  return `cd ${shQuote(a.cwd)} && ${c.bin} ${c.args.map(shQuote).join(' ')}${c.extra}`;
}

// Opens the window and remembers which process it is, so the cockpit can tell whether it is
// still open and can close it when asked. Windows that the person opened themselves are never touched.
// A tool may look something up before its command line is built (Hermes: which models Ollama has).
async function openTerminal(a, firstMessage) {
  const tool = otherTool(a);
  if (tool && tool.prepare) { try { await tool.prepare(a); } catch { /* the command line is built without it */ } }
  return openTerminalNow(a, firstMessage);
}
function openTerminalNow(a, firstMessage) {
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
  // The windows as they are when the list is asked for. tasklist can take seconds on a busy PC: a window
  // opened meanwhile (Open terminal, a reopen) is not in that list and must not be judged by it, or it is
  // marked closed while it runs and the cockpit later opens a second one for the same session.
  const asked = new Map(tracked.map(a => [a.id, a.term]));
  execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
    if (err) return;
    const live = new Map();
    for (const line of String(stdout).split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(line); if (m) live.set(Number(m[2]), m[1].toLowerCase()); }
    // Only ever marks a window as gone. A list taken just before Close window must not bring it back.
    for (const a of tracked) if (a.term && a.term === asked.get(a.id) && a.term.alive !== false && live.get(a.term.pid) !== a.term.image) setWindowAlive(a, false);
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
  const need = [...agents.values()].filter(a => (a.mode || 'own') === 'watch' && harnessOf(a) === 'claude' && !(termKnown(a) && a.term.alive !== false));
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
  // Only the last few lines with text are read: Claude Code puts the question's key hints at the bottom,
  // and the same words inside the conversation above (an agent quoting them) must not count.
  static bool ShowsQuestion() {
    IntPtr o = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (o == new IntPtr(-1)) return false;
    SCREEN_INFO i; bool q = false; int seen = 0;
    if (GetConsoleScreenBufferInfo(o, out i)) for (short y = i.win.B; y >= i.win.T && !q && seen < 4; y--) {
      var sb = new System.Text.StringBuilder(i.size.X + 1); uint n; COORD c; c.X = 0; c.Y = y;
      if (!ReadConsoleOutputCharacter(o, sb, (uint)i.size.X, c, out n)) continue;
      string line = sb.ToString(0, (int)Math.Min(n, (uint)sb.Length));
      if (line.Trim().Length == 0) continue;
      seen++;
      // Claude Code says "Enter to confirm" / "Esc to cancel"; Codex says "Press enter to continue".
      q = line.Contains("Enter to confirm") || line.Contains("Esc to cancel") || line.IndexOf("press enter to continue", StringComparison.OrdinalIgnoreCase) >= 0;
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
      // Two private characters stand for the arrow keys (menus without numbers are answered with them).
      if (c == (char)0xE001 || c == (char)0xE002) { r.KeyEvent.wVirtualKeyCode = c == (char)0xE001 ? (ushort)0x28 : (ushort)0x26; r.KeyEvent.UnicodeChar = (char)0; recs.Add(r); continue; }
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
  // The visible part of the window as text (base64, so line breaks survive the one-line answer), so the
  // cockpit can show a question that waits in the window.
  public static string Screen(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "";
    IntPtr o = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    var all = new System.Text.StringBuilder();
    if (o != new IntPtr(-1)) {
      SCREEN_INFO i;
      if (GetConsoleScreenBufferInfo(o, out i)) for (short y = i.win.T; y <= i.win.B; y++) {
        var sb = new System.Text.StringBuilder(i.size.X + 1); uint n; COORD c; c.X = 0; c.Y = y;
        if (ReadConsoleOutputCharacter(o, sb, (uint)i.size.X, c, out n)) all.Append(sb.ToString(0, (int)Math.Min(n, (uint)sb.Length)).TrimEnd()).Append('\\n');
      }
      CloseHandle(o);
    }
    FreeConsole();
    return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(all.ToString()));
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr w, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr w);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr w, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr w);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Brings the agent's window to the front. Nothing is typed into it. In Windows Terminal the console's own
  // window is hidden and owned by the terminal's window, so the owner is the one brought forward.
  public static string Focus(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "could not reach its window (" + Marshal.GetLastWin32Error() + ")";
    IntPtr w = GetConsoleWindow();
    FreeConsole();
    if (w == IntPtr.Zero) return "it has no window to show";
    IntPtr top = GetAncestor(w, 3);
    if (top != IntPtr.Zero) w = top;
    if (IsIconic(w)) ShowWindow(w, 9);
    // Windows lets only the program in front give the front away. Joining its input queue for a moment is
    // the usual way; a tap of Alt is the fallback when that is not enough.
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    SetForegroundWindow(w); BringWindowToTop(w);
    if (joined) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() != w) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(w);
    }
    return GetForegroundWindow() == w ? "shown" : "Windows did not let it come to the front";
  }
}`;

// One typing helper keeps running in the background. Starting PowerShell and compiling the helper took
// several seconds per message on this PC (every program start is scanned), so it is done once. Messages
// go through it one at a time, in order, so two sends can never mix their keys.
// Protocol, one line each way: "<req>|<pid>|<started>|<enter 0/1>|<check 0/1>|<text base64>" -> "<req>|<result>".
const TYPER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${TYPE_HELPER}
'@
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($null -ne ($l = [Console]::In.ReadLine())) {
  $f = $l.Split('|'); $r = ''
  try {
    $tp = [uint32]$f[1]; $p = Get-Process -Id $tp -ErrorAction SilentlyContinue; $s = 0
    if ($p) { try { $s = $p.StartTime.ToFileTimeUtc() } catch {} }
    if (-not $p -or "$s" -ne $f[2]) { $r = 'its window is closed' }
    elseif ($f[3] -eq 'S') { $r = 'SCREEN:' + [CockpitKeys]::Screen($tp) }
    elseif ($f[3] -eq 'F') { $r = [CockpitKeys]::Focus($tp) }
    else { $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($f[5])); $r = [CockpitKeys]::Send($tp, $text, $f[3] -eq '1', $f[4] -eq '1') }
  } catch { $r = 'typing into the window failed: ' + $_.Exception.Message }
  [Console]::Out.WriteLine($f[0] + '|' + $r); [Console]::Out.Flush()
}`;
const typer = { proc: null, ready: null, waiting: new Map(), seq: 0, chain: Promise.resolve() };
function typerStart() {
  if (typer.proc) return typer.ready;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64ps(TYPER_SCRIPT)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  typer.proc = proc;
  let buf = '', err = '', readyOk;
  typer.ready = new Promise((ok, fail) => {
    readyOk = ok;
    setTimeout(() => fail(new Error('the typing helper did not start in time')), 60000);
  });
  typer.ready.catch(() => {});
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l === 'READY') { readyOk(); continue; }
      const m = /^(\d+)\|(.*)$/.exec(l);
      if (m && typer.waiting.has(m[1])) { typer.waiting.get(m[1])(m[2]); typer.waiting.delete(m[1]); }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
  const gone = () => {
    if (typer.proc !== proc) return;
    typer.proc = null; typer.ready = null;
    const why = err.split('\n').find(x => x.trim() && !x.startsWith('#<'));
    for (const [, done] of typer.waiting) done('typing into the window failed: the helper stopped' + (why ? ' (' + why.trim().slice(0, 160) + ')' : ''));
    typer.waiting.clear();
  };
  proc.on('exit', gone); proc.on('error', gone);
  return typer.ready;
}
function typeOne(t, line, enter, check) {
  const run = async () => {
    try { await typerStart(); } catch (e) { if (typer.proc) typer.proc.kill(); return 'typing into the window failed: ' + e.message; }
    const id = String(++typer.seq);
    return new Promise(done => {
      const timer = setTimeout(() => { if (typer.waiting.delete(id)) { done('typing into the window failed: no answer from the helper'); if (typer.proc) typer.proc.kill(); } }, 20000 + line.length * 5);
      typer.waiting.set(id, r => { clearTimeout(timer); done(r); });
      typer.proc.stdin.write(`${id}|${Number(t.pid)}|${String(t.started).replace(/\D/g, '')}|${enter === 'S' || enter === 'F' ? enter : enter ? 1 : 0}|${check ? 1 : 0}|${Buffer.from(line, 'utf8').toString('base64')}\n`);
    });
  };
  const p = typer.chain.then(run, run);
  typer.chain = p.catch(() => {});
  return p;
}
// A window that has just opened is still starting Claude Code; keys typed then can lose their Enter
// (seen at 9 s, fine at 20 s). Wait until the window is old enough.
const WINDOW_WARMUP_MS = 20000;
async function typeIntoWindows(targets, line, enter, check) {
  // targets: [{ id, pid, started, openedAt }]; resolves to a Map of id -> 'sent' or the reason it failed
  const wait = Math.max(0, ...targets.map(t => (t.openedAt || 0) + WINDOW_WARMUP_MS - Date.now()));
  if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, WINDOW_WARMUP_MS)));
  const out = new Map();
  for (const t of targets) out.set(t.id, await typeOne(t, line, enter, check));
  return out;
}

// The text a window shows now (Windows, a window the cockpit can type into), or '' when it cannot be read.
async function windowScreen(a) {
  if (process.platform !== 'win32' || !termKnown(a) || a.term.alive === false || a.term.tmux) return '';
  const r = await typeOne({ pid: a.term.pid, started: a.term.started }, '', 'S', false);
  if (!r.startsWith('SCREEN:')) return '';
  return Buffer.from(r.slice(7), 'base64').toString('utf8').replace(/\n{3,}/g, '\n\n').trim();
}
// A question in a window, read from its screen: the lines from the question's title to the bottom, and the
// numbered answers it offers.
function questionOf(screen) {
  const lines = screen.split('\n');
  let end = lines.length; while (end && !lines[end - 1].trim()) end--;
  const tail = lines.slice(Math.max(0, end - 18), end);
  const options = [];
  for (const l of tail) { const m = /^\s*(?:[(\[][^)\]]{0,2}[)\]]|[●○◉◯*>❯›-])?\s*(\d{1,2})[.)]\s+(.{1,80})$/.exec(l); if (m) options.push({ key: m[1], label: m[2].trim() }); }
  // The same test as the typing helper: a key hint in the last few lines means a question waits there.
  const asking = tail.filter(l => l.trim()).slice(-4).some(l => /Enter to confirm|Esc to cancel|press enter to continue/i.test(l));
  // A menu without numbers ("❯ No, exit" / "  Yes, I trust this folder"): the lines right above the key hint,
  // one of them marked as chosen. It is answered with the arrow keys (see 'POST answer', pick).
  let selected = null;
  if (asking && !options.length) {
    let i = tail.length - 1;
    while (i >= 0 && !/Enter to confirm|Esc to cancel|press enter to continue/i.test(tail[i])) i--;
    i--; while (i >= 0 && !tail[i].trim()) i--;
    const block = [];
    while (i >= 0 && tail[i].trim()) block.unshift(tail[i--]);
    const MARK = /^\s*[❯›>]\s+/;
    if (block.length >= 2 && block.length <= 9 && block.filter(l => MARK.test(l)).length === 1) {
      block.forEach((l, n) => { if (MARK.test(l)) selected = n; options.push({ key: '', label: l.replace(MARK, '').trim().slice(0, 80), pick: n }); });
    }
  }
  return { text: tail.join('\n').replace(/^\n+/, ''), options, asking, selected };
}

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13); // Enter alone, typed without the question check (an answer to a question)
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
  if (win.length) for (const [id, res] of await typeIntoWindows(win.map(a => ({ id: a.id, pid: a.term.pid, started: a.term.started, openedAt: a.term.adopted ? 0 : a.term.openedAt })), keys, enter, check)) out.set(id, res);
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
  // The models a tool offers, for the model menu of its agents.
  'GET /api/models': async (req, res, url) => {
    const tool = HARNESSES[url.searchParams.get('harness') || ''];
    if (!tool) return json(res, 200, { models: [] });
    let models = []; try { if (tool.models) models = await tool.models(); } catch { /* an empty menu, typed names still work */ }
    json(res, 200, { models, profiles: tool.profiles ? await tool.profiles() : null });
  },
  'GET /api/state': async (req, res) => {
    json(res, 200, { projects: [...projects.values()].map(publicProject), agents: [...agents.values()].map(publicAgent), home: os.homedir(), platform: process.platform, tokenRequired: !!TOKEN, hub: hubState() });
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
    const tool = HARNESSES[url.searchParams.get('harness') || ''];
    if (tool) {
      let list = []; try { list = await tool.sessions(dir || null); } catch (e) { return json(res, 200, { sessions: [], error: `${tool.label}: ${e.message}` }); }
      return json(res, 200, { sessions: list.slice(0, limit).map(s => ({ sessionId: s.sessionId, title: s.title, named: false, firstPrompt: s.title, cwd: s.cwd, cwdShort: shortPath(s.cwd), gitBranch: '', lastModified: s.lastModified, agent: inRoster.get(s.sessionId) || null, harness: tool.id, profile: s.profile })) });
    }
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
    if (imported) setTimeout(() => syncHub().catch(() => {}), 300);
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
      mode: 'watch', title: String(b.title || '').trim(), ...(HARNESSES[b.harness] ? { harness: b.harness } : {}),
      ...(b.harness === 'hermes' && /^[\w.-]{1,64}$/.test(String(b.profile || '')) ? { profile: String(b.profile) } : {}),
      last: b.sessionId ? 'Open terminal to continue it in its own window.' : 'Starting in a terminal window.',
    };
    if (a.title && proj.ignored) proj.ignored = proj.ignored.filter(t => t.toLowerCase() !== a.title.toLowerCase());
    agents.set(a.id, a); saveRoster(); setTimeout(() => syncHub().catch(() => {}), 500);
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
    try { await pollWatched(a); } catch { /* next round */ }
    await ensureHistory(a);
    json(res, 200, { items: r.items, commands: r.commands.length ? r.commands : (a.commands || []) });
  },
  // Helpers this agent started. With ?run=&sub= it gives that one helper's steps.
  'GET subagents': async (a, req, res, url) => {
    const run = url.searchParams.get('run'), sub = url.searchParams.get('sub');
    if (run && sub) {
      const items = subagentItems(a, run, sub);
      return items ? json(res, 200, { items }) : json(res, 404, { error: 'That helper\'s file is gone.' });
    }
    json(res, 200, { runs: listSubagents(a) });
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
    if (out === QUESTION) {
      // Show the question in the cockpit, so it can be answered here and the message sent after it.
      let question = null; try { const s = await windowScreen(a); if (s) question = questionOf(s); } catch { /* fall back to the plain refusal */ }
      return json(res, 409, { error: `${a.name}: ${QUESTION_WHY}.`, canForce: true, question });
    }
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
  // Switches the model of an agent of another tool. Hermes switches in its window ("/model <name>", this session
  // only). Codex and opencode take a model only when a window starts or resumes: the choice is saved, and with
  // reopen the cockpit closes the window it opened and resumes the same chat in a new one with that model.
  'POST model': async (a, req, res) => {
    const b = await readBody(req);
    const tool = otherTool(a), model = String(b.model || '').trim();
    if (!tool) return json(res, 400, { error: 'For a Claude Code agent the model is switched with /model.' });
    if (!model || /\s/.test(model) || model.length > 200) return json(res, 400, { error: 'Write a model name without spaces.' });
    if (tool.liveSwitch) {
      const block = typeBlock(a, false);
      if (block) return json(res, 409, { error: `${a.name}: ${block.why}.` });
      const out = (await typeToAgents([a], `/model ${model}`, true, true)).get(a.id);
      if (out === QUESTION) return json(res, 409, { error: `${a.name}: ${QUESTION_WHY}.` });
      if (out !== 'sent') return json(res, 502, { error: `${a.name}: ${out}.` });
      a.model = model; touch(a); nudgeWatch(a);
      return json(res, 200, { ok: true, applied: 'now' });
    }
    a.model = model; touch(a);
    if (!b.reopen) return json(res, 200, { ok: true, applied: 'next start' });
    if (!termKnown(a) || a.term.alive === false) return json(res, 200, { ok: true, applied: 'next start' });
    if (a.term.adopted) return json(res, 409, { error: `${a.name} runs in a window you opened yourself, so the cockpit does not close it. The new model applies when the cockpit opens its window.` });
    if (rt(a.id).status === 'work') return json(res, 409, { error: `${a.name} is working. Switch when it has finished, so nothing is cut off.` });
    await closeWindow(a);
    try { await openTerminal(a); } catch (e) { return json(res, 500, { error: e.message }); }
    touch(a, `Reopened with ${model}.`);
    json(res, 200, { ok: true, applied: 'reopened' });
  },
  // Moves a Hermes agent to another profile (its own config, model and chats). A chat cannot move between
  // profiles: the agent continues its chat of the same name in the new profile, or starts one there. With reopen,
  // the cockpit closes the window it opened and starts the agent in the new profile.
  'POST profile': async (a, req, res) => {
    const b = await readBody(req);
    if (harnessOf(a) !== 'hermes') return json(res, 400, { error: 'Only Hermes agents have profiles.' });
    const profile = String(b.profile || '');
    if (profile && !(await HARNESSES.hermes.profiles()).some(p => p.name === profile)) return json(res, 400, { error: `No Hermes profile "${profile}".` });
    if (profile === (a.profile || '')) return json(res, 200, { ok: true, applied: 'same' });
    if (b.reopen && termKnown(a) && a.term.alive !== false) {
      if (a.term.adopted) return json(res, 409, { error: `${a.name} runs in a window you opened yourself, so the cockpit does not close it.` });
      if (rt(a.id).status === 'work') return json(res, 409, { error: `${a.name} is working. Switch when it has finished, so nothing is cut off.` });
    }
    a.profile = profile; a.sessionId = null; a.model = ''; a.hubAgentId = null; a.hubTeam = null; a.hubRouteId = null;
    const r = rt(a.id); r.watch = { mtime: 0, size: 0, info: null, cost: null, loadedMtime: -1 }; r.items = []; r.historyLoaded = false; attachTried.delete(a.id);
    broadcast({ t: 'reset', agentId: a.id });
    if (!b.reopen || !termKnown(a) || a.term.alive === false) { touch(a, `Uses the Hermes profile ${profile || 'default'} when its window opens.`); return json(res, 200, { ok: true, applied: 'next start' }); }
    await closeWindow(a);
    try { await openTerminal(a); } catch (e) { return json(res, 500, { error: e.message }); }
    touch(a, `Reopened in the Hermes profile ${profile || 'default'}.`);
    json(res, 200, { ok: true, applied: 'reopened' });
  },
  // Answers a question that waits in the window: an answer with Enter, Enter alone, or Esc.
  'POST answer': async (a, req, res) => {
    const b = await readBody(req);
    const block = typeBlock(a, true);
    if (block) return json(res, 409, { error: `${a.name}: ${block.why}.` });
    const key = String(b.key || '');
    // A line of a menu without numbers: arrow keys from the chosen line to that one, then Enter. The screen is
    // read again first, so the moves count from what the window shows now.
    if (Number.isInteger(b.pick)) {
      if (a.term.tmux) return json(res, 409, { error: `${a.name}: pick the answer in its window.` });
      const q = questionOf(await windowScreen(a));
      if (!q.asking || q.selected == null || !q.options[b.pick]) return json(res, 409, { error: `${a.name}: the window does not show that menu any more.` });
      const d = b.pick - q.selected;
      const keys = (d > 0 ? '' : '').repeat(Math.abs(d));
      const r = (await typeIntoWindows([{ id: a.id, pid: a.term.pid, started: a.term.started, openedAt: 0 }], keys + '\r', false, false)).get(a.id);
      if (r !== 'sent') return json(res, 502, { error: `${a.name}: ${r}.` });
      nudgeWatch(a);
      return json(res, 200, { ok: true });
    }
    const out = key === 'esc' ? (await typeToAgents([a], ESC, false)).get(a.id)
      : key === 'enter' ? (await typeIntoWindows([{ id: a.id, pid: a.term.pid, started: a.term.started, openedAt: 0 }], '\r', false, false)).get(a.id)
      : (await typeToAgents([a], String(b.text || '').slice(0, 200), true, false)).get(a.id);
    if (out !== 'sent') return json(res, 502, { error: `${a.name}: ${out}.` });
    nudgeWatch(a);
    json(res, 200, { ok: true });
  },
  // What the window shows now, and the question in it if there is one.
  'GET screen': async (a, req, res) => {
    const s = await windowScreen(a);
    json(res, 200, { screen: s, question: s ? questionOf(s) : null });
  },
  // Brings the agent's terminal window to the front. Nothing is typed, so this also works for a window you
  // opened yourself, and while the agent is busy or asking a question.
  'POST focus': async (a, req, res) => {
    if (process.platform !== 'win32' || !termKnown(a) || a.term.alive === false || a.term.tmux) return json(res, 409, { error: `${a.name}: the cockpit cannot show this window. Find it in the taskbar.` });
    const out = await typeOne({ pid: a.term.pid, started: a.term.started }, '', 'F', false);
    if (out !== 'shown') return json(res, 502, { error: `${a.name}: ${out}.` });
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
  // Reading the session file at once means the newest message shows without waiting for the next round.
  'POST view': async (a, req, res) => { rt(a.id).viewedAt = Date.now(); try { await pollWatched(a); } catch { /* next round */ } json(res, 200, { ok: true }); },
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
  // The roster is saved shortly after every change, so it is written here only when a save is still pending.
  // A write can take seconds on this PC (the virus scanner checks it), and a restart should not wait for one.
  if (saveTimer) { clearTimeout(saveTimer); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ROSTER_FILE, rosterJson()); } catch { /* best effort */ } }
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

// ───────────────────────── Agent Hub ─────────────────────────
// With COCKPIT_HUB_URL set, the cockpit joins the hub (ai-chat) as an app: the agents of a project reach each
// other through it, and the cockpit carries its messages into the windows it opened.
let hub = null;
function hubState() { return hub ? hub.state() : { state: 'off', error: '' }; }
// The hub's frames for the windows this cockpit carries: a delivery to type, an answer to a question that held
// one, and an interrupt (Esc). A delivery is handled once, also when a reconnected stream sends it again.
const handledDeliveries = new Set();
const agentOfHub = id => [...agents.values()].find(a => a.hubAgentId === id);
function onHubFrame(f) {
  if (f.t === 'deliver') return carryDelivery(f).catch(e => console.error('[hub] delivery:', e.message));
  const a = f.agentId && agentOfHub(f.agentId);
  if (!a || !canTalk(a)) return;
  if (f.t === 'interrupt') return typeToAgents([a], ESC, false).catch(() => {});
  if (f.t === 'answer') {
    if (f.key === 'esc') return typeToAgents([a], ESC, false).catch(() => {});
    if (f.key === 'enter') return typeIntoWindows([{ id: a.id, pid: a.term.pid, started: a.term.started, openedAt: 0 }], ENTER, false, false).catch(() => {});
    if (typeof f.text === 'string' && f.text) return typeToAgents([a], f.text.slice(0, 200), true, false).catch(() => {});
  }
}
async function carryDelivery(f) {
  if (!f.deliveryId || handledDeliveries.has(f.deliveryId)) return;
  handledDeliveries.add(f.deliveryId);
  if (handledDeliveries.size > 500) handledDeliveries.delete(handledDeliveries.values().next().value);
  const a = agentOfHub(f.agentId);
  let report;
  // The same guard as a broadcast: on tmux, and while the agent asks a question, nothing is typed. The hub
  // holds the delivery and tries again.
  const block = a && canTalk(a) ? typeBlock(a, false) : null;
  if (!a || !canTalk(a)) report = { outcome: 'refused', reason: 'no_window' };
  else if (block) report = { outcome: 'held', reason: 'question', question: { text: `${a.name}: ${block.why}.`, options: [] } };
  else {
    const result = (await typeToAgents([a], deliveryText(f), true, true)).get(a.id);
    let question = null;
    if (result === QUESTION) { try { const s = await windowScreen(a); if (s) question = questionOf(s); } catch { /* the hold still stands */ } }
    report = outcomeFor(result, question);
    if (report.outcome === 'sent') nudgeWatch(a);
  }
  await hub.call('POST', `/v1/app/deliveries/${encodeURIComponent(f.deliveryId)}/outcome`, report);
}
// Each window this cockpit can type into is a route for its agent on the hub.
async function hubRoutes() {
  for (const a of [...agents.values()]) {
    if (!a.hubAgentId || a.hubRouteId || !canTalk(a) || a.hubTeam !== 'team') continue;
    const r = await hub.call('POST', '/v1/app/routes', { agentId: a.hubAgentId, kind: 'typing' });
    if (r.status === 201 && r.json?.routeId) { a.hubRouteId = r.json.routeId; saveRoster(); }
  }
}
function startHub() {
  const conf = hubConfig(DATA_DIR);
  if (!conf) return;
  hub = createHubClient({ url: conf.url, token: conf.token, onFrame: onHubFrame, onState: s => { broadcast({ t: 'hub', hub: hubState() }); if (s === 'connected') syncHub(); } });
  hub.start();
}
// The hub's name for each tool (an identity is found by tool and session id).
const HUB_HARNESS = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', hermes: 'hermes' };
// Each project gets one team conversation on the hub, and every agent of the project with a session is bound
// to it, so the agents of a project reach each other. An agent the hub reports in another chat stays there.
// A call that fails leaves the record as it was; the next run tries again.
let hubSyncBusy = false;
async function syncHub() {
  if (!hub || hub.state().state !== 'connected' || hubSyncBusy) return;
  hubSyncBusy = true;
  try {
    for (const p of [...projects.values()]) {
      const team = [...agents.values()].filter(a => a.projectId === p.id && a.sessionId && !a.hubAgentId);
      if (!team.length) continue;
      if (!p.hubConversationId) {
        const r = await hub.call('POST', '/v1/app/conversations', { label: `cockpit: ${p.name}` });
        if (r.status !== 201 || !r.json?.conversationId) continue;
        p.hubConversationId = r.json.conversationId; saveRoster();
      }
      for (const a of team) {
        if (!agents.has(a.id) || a.hubAgentId) continue;
        const harness = HUB_HARNESS[harnessOf(a)], sid = a.sessionId;
        let id = null;
        const f = await hub.call('GET', `/v1/app/agents/by-session?harness=${encodeURIComponent(harness)}&sessionId=${encodeURIComponent(sid)}`);
        if (f.status === 200) id = f.json?.agentId;
        else if (f.status === 404) {
          const r = await hub.call('POST', '/v1/app/agents', { displayName: a.name, harness, sessionId: sid });
          if (r.status === 200 || r.status === 201) id = r.json?.agentId;
        }
        if (!id || a.sessionId !== sid) continue;
        const b = await hub.call('POST', '/v1/app/bindings', { agentId: id, conversationId: p.hubConversationId });
        if (b.status === 200) a.hubTeam = 'team';
        else if (b.status === 409 && b.json?.error === 'bound_elsewhere') a.hubTeam = 'other';
        else continue;
        a.hubAgentId = id; saveRoster(); emitAgent(a);
      }
    }
    // The agent's own bridge tools may join after the cockpit made a stand-in for its session. The hub then
    // names the agent's own identity for that session: the cockpit puts it in the team (the hub hands the
    // stand-in's route and rights over to it) and follows it.
    for (const a of [...agents.values()]) {
      const p = projects.get(a.projectId);
      if (!a.hubAgentId || !a.hubTeam || !a.sessionId || !p?.hubConversationId) continue;
      const harness = HUB_HARNESS[harnessOf(a)], sid = a.sessionId, was = a.hubAgentId;
      const f = await hub.call('GET', `/v1/app/agents/by-session?harness=${encodeURIComponent(harness)}&sessionId=${encodeURIComponent(sid)}`);
      const id = f.status === 200 ? f.json?.agentId : null;
      // An agent that was in another chat and has since been moved into the team (by the owner, in ai-chat).
      if (a.hubTeam === 'other') {
        if (id && f.json?.conversationId === p.hubConversationId && a.hubAgentId === was) { a.hubAgentId = id; a.hubTeam = 'team'; saveRoster(); emitAgent(a); }
        continue;
      }
      if (!id || id === was) continue;
      const b = await hub.call('POST', '/v1/app/bindings', { agentId: id, conversationId: p.hubConversationId });
      if (b.status !== 200 || a.hubAgentId !== was || a.sessionId !== sid) continue;
      a.hubAgentId = id; saveRoster(); emitAgent(a);
    }
    await hubRoutes();
  } finally { hubSyncBusy = false; }
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
    // A test cockpit (COCKPIT_TEST=1) never looks for the person's own windows and does not warm up the typing
    // helper: it must not adopt, and so never type into, a real agent window, and the PowerShell helpers cost
    // a busy PC many seconds per start.
    if (!TEST_MODE) {
      setInterval(adoptWindows, 20000);
      setTimeout(adoptWindows, 4000);
      // Start the typing helper now, so the first message does not wait for it (it takes 10 to 45 s here).
      if (process.platform === 'win32') setTimeout(() => typerStart().catch(() => {}), 6000);
    }
    startHub();
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
