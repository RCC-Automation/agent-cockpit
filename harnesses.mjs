// Agents from other tools than Claude Code: OpenAI Codex, opencode and Hermes.
// The cockpit treats them like a Claude Code agent: each runs in its own terminal window, the cockpit types
// into that window, and it shows the chat by reading what the tool saves on disk. Only the reading differs,
// so each tool gets a small reader here. Every reader only reads; nothing here writes to a tool's files.
//
// A reader gives:
//   sessions(cwd, since)   the tool's sessions in that folder: { sessionId, title, cwd, lastModified, createdAt }
//   read(sessionId)        { items, info, mtime } — the chat as cockpit items, what it does last, when it last changed
//   stamp(sessionId)       a cheap marker that changes whenever the session changes
//   args(a, firstMessage)  the command line that starts or resumes it in a window

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';

let sqlite = null;
async function db(file) {
  if (!sqlite) sqlite = await import('node:sqlite');
  return new sqlite.DatabaseSync(file, { readOnly: true });
}
const parse = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const sameDir = (x, y) => {
  if (!x || !y) return false;
  const n = v => path.resolve(String(v)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(x).toLowerCase() === n(y).toLowerCase() : n(x) === n(y);
};
const textOf = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(b => typeof b === 'string' ? b : b && (b.text ?? (b.type ? `[${b.type}]` : ''))).filter(Boolean).join('\n') : v == null ? '' : JSON.stringify(v);
// The last thing a chat shows, in the form the cockpit's status rules expect.
function infoFrom(items, busy) {
  const tail = items[items.length - 1];
  if (!busy && tail && tail.k === 'note' && tail.text === 'Stopped') return { kind: 'stopped', text: 'Interrupted in the terminal' };
  const last = [...items].reverse().find(i => i.k !== 'note');
  if (!last) return null;
  if (last.k === 'tool') return last.status === 'run' ? { kind: 'tool', text: `${last.name} ${textOf(last.input).slice(0, 160)}`.trim() } : busy ? { kind: 'result', text: '' } : { kind: 'text', text: '' };
  if (last.k === 'user') return { kind: 'user', text: last.text };
  if (last.k === 'text') return busy ? { kind: 'result', text: '' } : { kind: 'text', text: last.text };
  return null;
}

// A tool's model list, from its own command, cached for 10 minutes. Never throws: an empty list then.
const modelCache = new Map();
function listOf(bin, args, parseOut) {
  const c = modelCache.get(bin);
  if (c && Date.now() - c.at < 600_000) return c.list;
  // A fixed command line with no outside input: exec runs the tools' .cmd launchers on Windows too.
  const list = new Promise(resolve => exec(`${bin} ${args.join(' ')}`, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => {
    try { resolve(err ? [] : parseOut(String(out))); } catch { resolve([]); }
  }));
  modelCache.set(bin, { at: Date.now(), list });
  return list;
}

// ───────── OpenAI Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl ─────────
const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const CODEX_TAIL = 4 * 1024 * 1024; // some sessions are hundreds of MB; the chat shows the last part
const codexHeads = new Map(); // file -> { mtime, meta, title }
function codexFiles(since = 0) {
  const out = [];
  const walk = (d, depth) => {
    let names; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const f = path.join(d, n);
      if (depth < 3) { if (/^\d+$/.test(n)) walk(f, depth + 1); continue; }
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs >= since) out.push({ file: f, st });
    }
  };
  walk(CODEX_DIR, 0);
  return out;
}
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function readEnd(file, size, bytes) {
  const len = Math.min(size, bytes), fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); const lines = b.toString('utf8').split('\n'); if (size > len) lines.shift(); return lines; } finally { fs.closeSync(fd); }
}
function codexHead(file, st) {
  const c = codexHeads.get(file);
  if (c && c.size === st.size) return c;
  const head = readHead(file, 512 * 1024).split('\n');
  const meta = (parse(head[0]) || {}).payload || {};
  let title = '';
  for (const l of head.slice(1)) {
    if (!l.includes('UserMessage') && !l.includes('user_message')) continue;
    const o = parse(l); const p = o && o.payload;
    const t = p && (p.type === 'item_completed' && p.item?.type === 'UserMessage' ? textOf(p.item.content) : p.type === 'user_message' ? p.message : '');
    if (t && t.trim()) { title = t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).trim().replace(/\s+/g, ' ').slice(0, 120); break; }
  }
  const r = { size: st.size, meta, title };
  codexHeads.set(file, r);
  return r;
}
const codexById = new Map();
function codexFile(id) {
  const known = codexById.get(id);
  if (known && fs.existsSync(known)) return known;
  const hit = codexFiles().find(x => x.file.endsWith(`-${id}.jsonl`));
  if (hit) codexById.set(id, hit.file);
  return hit ? hit.file : null;
}
function codexItems(lines) {
  const items = [], calls = new Map();
  let busy = false, n = 0, model = '';
  for (const l of lines) {
    if (!l) continue;
    const o = parse(l); if (!o || !o.payload) continue;
    const p = o.payload, id = p.id || p.call_id || `c${n++}`;
    if (o.type === 'turn_context' && p.model) model = p.model;
    if (o.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') busy = true;
      else if (p.type === 'task_complete') busy = false;
      else if (p.type === 'turn_aborted') { busy = false; items.push({ k: 'note', id: `abort${n++}`, text: 'Stopped' }); }
      else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') { const t = textOf(p.item.content).trim(); if (t) items.push({ k: 'user', id: p.item.id || id, text: t, images: [] }); }
      else if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) items.push({ k: 'user', id: `u${n++}`, text: p.message.trim(), images: [] });
    } else if (o.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') { const t = textOf(p.content).trim(); if (t) items.push({ k: 'text', id, text: t }); }
      else if (p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) { const t = textOf(p.summary).trim(); if (t) items.push({ k: 'text', id, text: t, thought: true }); }
      else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
        const input = p.type === 'function_call' ? (parse(p.arguments) ?? p.arguments) : p.type === 'local_shell_call' ? p.action : p.input;
        const it = { k: 'tool', id: p.call_id || id, name: p.namespace ? `${p.namespace}.${p.name}` : (p.name || 'shell'), input, result: '', status: 'run' };
        calls.set(it.id, it); items.push(it);
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output' || p.type === 'local_shell_call_output') {
        const it = calls.get(p.call_id);
        if (it) { it.result = textOf(p.output); it.status = /"exit_code":\s*[1-9]|Exit code:\s*[1-9]/.test(it.result.slice(0, 600)) ? 'err' : 'ok'; }
      }
    } else if (o.type === 'compacted') items.push({ k: 'note', id: `cmp${n++}`, text: 'Context was compacted here' });
  }
  // Calls whose answer was never written (the turn ended) are not running any more.
  if (!busy) for (const it of calls.values()) if (it.status === 'run') it.status = 'ok';
  return { items, busy, model };
}
const codex = {
  id: 'codex', label: 'Codex', bin: 'codex',
  sessions(cwd, since = 0) {
    const out = [];
    for (const { file, st } of codexFiles(since)) {
      let h; try { h = codexHead(file, st); } catch { continue; }
      if (cwd && !sameDir(h.meta.cwd, cwd)) continue;
      if (h.meta.thread_source && h.meta.thread_source !== 'user') continue; // its own helpers and reviewers
      const id = h.meta.id || (/-([0-9a-f-]{36})\.jsonl$/.exec(file) || [])[1];
      if (!id) continue;
      codexById.set(id, file);
      out.push({ sessionId: id, title: h.title || '(untitled)', cwd: h.meta.cwd || '', lastModified: Math.round(st.mtimeMs), createdAt: Date.parse(h.meta.timestamp) || Math.round(st.birthtimeMs) });
    }
    return out.sort((x, y) => y.lastModified - x.lastModified);
  },
  stamp(id) { const f = codexFile(id); if (!f) return null; try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return null; } },
  read(id) {
    const f = codexFile(id); if (!f) return null;
    const st = fs.statSync(f);
    const { items, busy, model } = codexItems(readEnd(f, st.size, CODEX_TAIL));
    if (st.size > CODEX_TAIL) items.unshift({ k: 'note', id: 'older', text: 'Older messages are not shown: this session is very long.' });
    return { items, info: infoFrom(items, busy), mtime: st.mtimeMs, busy, model };
  },
  // The models Codex offers (its own list; hidden ones left out).
  models() { return listOf('codex', ['debug', 'models'], out => (JSON.parse(out).models || []).filter(m => m.visibility !== 'hide').map(m => m.slug)); },
  // A model can be chosen when a window starts or resumes; a running Codex window cannot switch by typed text.
  liveSwitch: false,
  args(a, first) {
    const args = a.sessionId ? ['resume', a.sessionId] : [];
    if (a.model) args.push('-m', a.model);
    if (first) args.push(first.replace(/\s+/g, ' ').trim());
    return args;
  },
};

// ───────── opencode: ~/.local/share/opencode/opencode.db ─────────
const OPENCODE_DB = process.env.OPENCODE_DB || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
const opencode = {
  id: 'opencode', label: 'opencode', bin: 'opencode',
  async sessions(cwd, since = 0) {
    if (!fs.existsSync(OPENCODE_DB)) return [];
    const d = await db(OPENCODE_DB);
    try {
      return d.prepare('SELECT id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND time_updated >= ? ORDER BY time_updated DESC LIMIT 300').all(since)
        .filter(s => !cwd || sameDir(s.directory, cwd))
        .map(s => ({ sessionId: s.id, title: s.title || '(untitled)', cwd: path.resolve(s.directory), lastModified: s.time_updated, createdAt: s.time_created }));
    } finally { d.close(); }
  },
  async stamp(id) {
    if (!fs.existsSync(OPENCODE_DB)) return null;
    const d = await db(OPENCODE_DB);
    try { const r = d.prepare('SELECT (SELECT time_updated FROM session WHERE id = ?) s, (SELECT MAX(time_updated) FROM part WHERE session_id = ?) p').get(id, id); return r && r.s ? `${r.s}:${r.p || 0}` : null; }
    finally { d.close(); }
  },
  async read(id) {
    if (!fs.existsSync(OPENCODE_DB)) return null;
    const d = await db(OPENCODE_DB);
    try {
      const s = d.prepare('SELECT time_updated FROM session WHERE id = ?').get(id); if (!s) return null;
      const msgs = d.prepare('SELECT id, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id);
      const parts = d.prepare('SELECT id, message_id, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(id);
      const byMsg = new Map();
      let mtime = s.time_updated;
      for (const p of parts) { if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []); byMsg.get(p.message_id).push(p); mtime = Math.max(mtime, p.time_updated); }
      const items = []; let busy = false, model = '';
      for (const m of msgs) {
        const md = parse(m.data) || {}; mtime = Math.max(mtime, m.time_updated);
        const mp = md.model?.providerID || md.providerID, mi = md.model?.modelID || md.modelID;
        if (mi) model = mp ? `${mp}/${mi}` : mi;
        if (md.role === 'assistant') busy = !md.time?.completed && !md.error;
        for (const p of byMsg.get(m.id) || []) {
          const pd = parse(p.data) || {};
          if (pd.type === 'text' && pd.text && pd.text.trim() && !pd.synthetic) items.push(md.role === 'user' ? { k: 'user', id: p.id, text: pd.text.trim(), images: [] } : { k: 'text', id: p.id, text: pd.text });
          else if (pd.type === 'reasoning' && pd.text && pd.text.trim()) items.push({ k: 'text', id: p.id, text: pd.text, thought: true });
          else if (pd.type === 'tool') {
            const st = pd.state || {};
            items.push({ k: 'tool', id: pd.callID || p.id, name: pd.tool || 'tool', input: st.input || {}, result: textOf(st.output ?? st.error ?? ''), status: st.status === 'error' ? 'err' : st.status === 'completed' ? 'ok' : 'run' });
          }
        }
        if (md.role === 'assistant' && md.error) items.push({ k: 'note', id: `${m.id}:err`, text: 'Error: ' + (md.error.data?.message || md.error.name || 'the turn failed') });
      }
      if (!busy) for (const it of items) if (it.k === 'tool' && it.status === 'run') it.status = 'ok';
      return { items, info: infoFrom(items, busy), mtime, busy, model };
    } finally { d.close(); }
  },
  models() { return listOf('opencode', ['models'], out => out.split(/\r?\n/).map(l => l.trim()).filter(l => /^[\w.-]+\/\S+$/.test(l))); },
  liveSwitch: false,
  args(a, first) {
    const args = a.sessionId ? ['-s', a.sessionId] : [];
    if (a.model) args.push('-m', a.model);
    if (first) args.push('--prompt', first.replace(/\s+/g, ' ').trim());
    return args;
  },
};

// ───────── Hermes: %LOCALAPPDATA%\hermes\state.db, and one state.db per profile in profiles\<name> ─────────
// A profile is an isolated Hermes (its own config, model, skills and chats). `hermes -p <name>` runs in it.
const HERMES_HOME = process.env.HERMES_HOME || [path.join(process.env.LOCALAPPDATA || '', 'hermes'), path.join(os.homedir(), '.hermes')].find(d => d && fs.existsSync(path.join(d, 'state.db'))) || path.join(os.homedir(), '.hermes');
const HERMES_DB = path.join(HERMES_HOME, 'state.db');
// Sessions a person can resume in a window; not cron, bots or the API. A chat in a terminal is saved as 'local'.
const HERMES_SOURCES = "('local', 'cli', 'tui', 'desktop')";
const PROFILE_NAME = /^[\w.-]{1,64}$/;
const hermesDb = profile => profile ? path.join(HERMES_HOME, 'profiles', profile, 'state.db') : HERMES_DB;
// The default Hermes ('') and every profile that has its own chats.
function hermesHomes() {
  const out = [{ profile: '', file: HERMES_DB }];
  let names = []; try { names = fs.readdirSync(path.join(HERMES_HOME, 'profiles')); } catch { /* no profiles */ }
  for (const n of names) if (PROFILE_NAME.test(n) && fs.existsSync(hermesDb(n))) out.push({ profile: n, file: hermesDb(n) });
  return out.filter(h => fs.existsSync(h.file));
}
// The model a profile's config names (model: / default: in its config.yaml).
function profileModel(profile) {
  const file = profile ? path.join(HERMES_HOME, 'profiles', profile, 'config.yaml') : path.join(HERMES_HOME, 'config.yaml');
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return { model: '', baseUrl: '' }; }
  const block = (/^model:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(text) || [])[1] || '';
  const val = key => ((new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n#]+)`, 'm').exec(block) || [])[1] || '').trim();
  return { model: val('default'), baseUrl: val('base_url') };
}
// The models a local Ollama has, or null when none answers on that address (then nothing is marked).
async function ollamaModels(baseUrl) {
  const root = (baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(root)) return null;
  try { const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(1500) }); if (!r.ok) return null; return new Set(((await r.json()).models || []).map(m => m.name)); }
  catch { return null; }
}
// Which profile holds a session: remembered once found.
const hermesWhere = new Map();
// Agent id -> the model its window must start with, because its chat's own model is gone (see prepare).
const modelFix = new Map();
async function hermesFind(id) {
  if (hermesWhere.has(id)) return hermesWhere.get(id);
  for (const h of hermesHomes()) {
    const d = await db(h.file);
    try { if (d.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) { hermesWhere.set(id, h.file); return h.file; } }
    finally { d.close(); }
  }
  return null;
}
const hermes = {
  id: 'hermes', label: 'Hermes', bin: 'hermes',
  // Every profile's sessions; each carries its `profile` ('' for the default Hermes).
  async sessions(cwd, since = 0) {
    const out = [];
    for (const h of hermesHomes()) {
      let d; try { d = await db(h.file); } catch { continue; }
      try {
        for (const s of d.prepare(`SELECT s.id, s.title, s.cwd, s.started_at, COALESCE((SELECT MAX(timestamp) FROM messages m WHERE m.session_id = s.id), s.last_activity_at, s.started_at) last
          FROM sessions s WHERE s.source IN ${HERMES_SOURCES} AND s.parent_session_id IS NULL ORDER BY last DESC LIMIT 300`).all()) {
          // Hermes often saves no folder for a terminal chat; such a session is offered in every folder.
          if (s.last * 1000 < since || (cwd && s.cwd && !sameDir(s.cwd, cwd))) continue;
          hermesWhere.set(s.id, h.file);
          out.push({ sessionId: s.id, title: s.title || '(untitled)', cwd: s.cwd || '', lastModified: Math.round(s.last * 1000), createdAt: Math.round(s.started_at * 1000), profile: h.profile });
        }
      } catch { /* a profile whose database is older or locked: skipped */ } finally { d.close(); }
    }
    return out.sort((x, y) => y.lastModified - x.lastModified);
  },
  async stamp(id) {
    const file = await hermesFind(id); if (!file) return null;
    const d = await db(file);
    try { const r = d.prepare('SELECT MAX(id) n, COUNT(*) c, (SELECT ended_at FROM sessions WHERE id = ?) e FROM messages WHERE session_id = ?').get(id, id); return r ? `${r.n}:${r.c}:${r.e || ''}` : null; }
    finally { d.close(); }
  },
  async read(id) {
    const file = await hermesFind(id); if (!file) return null;
    const d = await db(file);
    try {
      const s = d.prepare('SELECT started_at, ended_at, last_activity_at, model FROM sessions WHERE id = ?').get(id); if (!s) return null;
      const rows = d.prepare('SELECT id, role, content, tool_calls, tool_call_id, tool_name, timestamp, finish_reason, reasoning_content, reasoning FROM messages WHERE session_id = ? AND active = 1 ORDER BY id').all(id);
      const items = [], calls = new Map();
      let mtime = (s.last_activity_at || s.started_at) * 1000, waiting = false;
      for (const r of rows) {
        mtime = Math.max(mtime, r.timestamp * 1000);
        if (r.role === 'user') { const t = textOf(parse(r.content) ?? r.content).trim(); if (t) items.push({ k: 'user', id: `h${r.id}`, text: t, images: [] }); waiting = true; }
        else if (r.role === 'assistant') {
          const think = r.reasoning_content || r.reasoning;
          if (think && String(think).trim()) items.push({ k: 'text', id: `h${r.id}:r`, text: String(think), thought: true });
          const t = textOf(parse(r.content) ?? r.content).trim(); if (t) items.push({ k: 'text', id: `h${r.id}`, text: t });
          for (const c of parse(r.tool_calls) || []) {
            const it = { k: 'tool', id: c.id || c.call_id || `h${r.id}:t${calls.size}`, name: c.function?.name || c.name || 'tool', input: parse(c.function?.arguments) ?? c.function?.arguments ?? {}, result: '', status: 'run' };
            calls.set(it.id, it); items.push(it);
          }
          waiting = r.finish_reason === 'tool_calls' || (!t && !r.finish_reason);
        } else if (r.role === 'tool') {
          const it = calls.get(r.tool_call_id);
          if (it) { it.result = textOf(parse(r.content) ?? r.content); it.status = 'ok'; }
          waiting = true;
        }
      }
      const busy = waiting && !s.ended_at;
      if (!busy) for (const it of calls.values()) if (it.status === 'run') it.status = 'ok';
      return { items, info: s.ended_at && !items.length ? null : infoFrom(items, busy), mtime, busy, model: s.model || '' };
    } finally { d.close(); }
  },
  // The profiles to choose from: the default Hermes and each profile folder, with the model its config names.
  // A profile whose model is on a local Ollama that does not have it is marked `missing`: Hermes cannot answer there.
  async profiles() {
    let names = []; try { names = fs.readdirSync(path.join(HERMES_HOME, 'profiles')).filter(n => PROFILE_NAME.test(n) && fs.existsSync(path.join(HERMES_HOME, 'profiles', n, 'config.yaml'))); } catch { /* none */ }
    const tags = new Map(), out = [];
    for (const name of ['', ...names.sort()]) {
      const { model, baseUrl } = profileModel(name);
      if (baseUrl && !tags.has(baseUrl)) tags.set(baseUrl, await ollamaModels(baseUrl));
      const have = baseUrl ? tags.get(baseUrl) : null;
      out.push({ name, model, missing: !!(have && model && !have.has(model) && !have.has(model + ':latest')) });
    }
    return out;
  },
  // Hermes switches model with "/model <name>" typed in its window (for this session only).
  liveSwitch: true,
  // A resumed Hermes chat goes back to the model it used last, not the one its profile names now. When that
  // old model is gone from Ollama (renamed, deleted) the chat could never answer again: every message comes
  // back "not processed". Then the window is started with -m and the profile's model, which Ollama has.
  async prepare(a) {
    modelFix.delete(a.id);
    if (a.model || !a.sessionId) return;
    const file = await hermesFind(a.sessionId); if (!file) return;
    const d = await db(file);
    let stored = ''; try { stored = (d.prepare('SELECT model FROM sessions WHERE id = ?').get(a.sessionId) || {}).model || ''; } finally { d.close(); }
    const { model, baseUrl } = profileModel(a.profile && PROFILE_NAME.test(a.profile) ? a.profile : '');
    if (!stored || !model || stored === model) return;
    const have = await ollamaModels(baseUrl); if (!have) return;
    const has = m => have.has(m) || have.has(m + ':latest');
    if (!has(stored) && has(model)) modelFix.set(a.id, model);
  },
  // A new Hermes session is created under the agent's name, so the cockpit can find it again by that name.
  // `-p <profile>` comes before the subcommand, as Hermes reads it first.
  args(a, first) {
    const args = a.profile && PROFILE_NAME.test(a.profile) ? ['-p', a.profile, 'chat'] : ['chat'];
    if (a.sessionId) args.push('--resume', a.sessionId);
    else args.push('--continue', a.title || a.name, '--create-if-missing');
    if (a.model) args.push('-m', a.model);
    else if (modelFix.has(a.id)) args.push('-m', modelFix.get(a.id));
    if (first) args.push('-q', first.replace(/\s+/g, ' ').trim());
    return args;
  },
};

export const HARNESSES = { codex, opencode, hermes };
export const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', hermes: 'Hermes' };
