// Agent Cockpit — a small local control station for Claude Code agents.
// One Node process: keeps the roster, runs one Agent SDK session per agent,
// relays chat, approvals and context use to the browser over SSE.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COCKPIT_PORT || 4600);
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const TOKEN = process.env.COCKPIT_TOKEN || '';
const DATA_DIR = process.env.COCKPIT_DATA || path.join(ROOT, 'data');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const IDLE_CLOSE_MS = Number(process.env.COCKPIT_IDLE_MINUTES || 20) * 60_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY = 30 * 1024 * 1024;
const MAX_RESULT_CHARS = 6000;
// Agents run on the Claude login of this PC (your subscription). An API key in the
// environment would silently switch them to pay-per-use billing, so it is not passed on
// unless you ask for it with COCKPIT_ALLOW_API_KEY=1.
const ALLOW_API_KEY = process.env.COCKPIT_ALLOW_API_KEY === '1';
const LOGIN_HINT = 'This PC is not logged in to Claude. Open a terminal, run "claude", log in with your subscription, then send the message again.';

function agentEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-cockpit/0.1.0' };
  if (!ALLOW_API_KEY) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  return env;
}
// Turn what the engine reports about its login into one plain label.
function describeLogin(info) {
  if (!info) return null;
  const src = info.apiKeySource || '';
  const provider = info.apiProvider && info.apiProvider !== 'firstParty' ? info.apiProvider : '';
  if (provider) return { label: `via ${provider}`, api: true };
  if (src && src !== 'none' && src !== 'oauth') return { label: `API key (${src})`, api: true };
  return { label: info.subscriptionType ? `subscription · ${info.subscriptionType}` : 'Claude login', api: false };
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
    for (const a of raw.agents || []) if (projects.has(a.projectId)) agents.set(a.id, a);
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
    r = { status: 'idle', items: [], historyLoaded: false, pending: new Map(), q: null, input: null,
      live: [], queryCost: 0, ctx: null, commands: [], idleTimer: null, stopping: false, turns: 0 };
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
  return { id: p.id, name: p.name, cwd: p.cwd, cwdShort: shortPath(p.cwd), note: p.note || '', createdAt: p.createdAt };
}
function samePath(x, y) {
  const n = v => path.resolve(v).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(x).toLowerCase() === n(y).toLowerCase() : n(x) === n(y);
}
function teamBrief(a) {
  const p = projects.get(a.projectId);
  if (!p) return '';
  const mates = [...agents.values()].filter(x => x.projectId === p.id && x.id !== a.id).map(x => x.name);
  return `You are the agent named "${a.name}" in the project "${p.name}". The project folder is ${p.cwd}; keep your work inside it unless the user says otherwise.` +
    (mates.length ? ` Other agents working in this project: ${mates.join(', ')}. They may be changing files at the same time.` : '') +
    (p.note ? `\n\nProject notes from the user:\n${p.note}` : '');
}

function publicAgent(a) {
  const r = rt(a.id);
  return {
    id: a.id, projectId: a.projectId, name: a.name, cwd: a.cwd, cwdShort: shortPath(a.cwd), model: a.model || '', modelResolved: a.modelResolved || '', permissionMode: a.permissionMode || 'default',
    sessionId: a.sessionId || null, status: r.status, last: a.last || '', updatedAt: a.updatedAt || a.createdAt,
    login: a.login || null, cost: (a.cost || 0) + r.queryCost, ctx: r.ctx ? r.ctx.percentage : (a.ctxPct ?? null), pending: r.pending.size, alive: !!r.q,
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
function setStatus(a, status, last) { rt(a.id).status = status; touch(a, last); }

function addItem(a, item) {
  const r = rt(a.id);
  if (!item.id) item.id = crypto.randomUUID();
  item.ts = item.ts || Date.now();
  r.items.push(item);
  broadcast({ t: 'item', agentId: a.id, item });
  return item;
}
function updateItem(a, item) { broadcast({ t: 'item', agentId: a.id, item }); }
function note(a, text) { return addItem(a, { k: 'note', text }); }

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
  const pick = i.file_path || i.path || i.command || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || i.notebook_path || '';
  let s = String(pick);
  if (cwd && s.length > cwd.length + 1 && s.startsWith(cwd) && /[\\/]/.test(s[cwd.length])) s = s.slice(cwd.length + 1);
  return s.replace(/\s+/g, ' ').slice(0, 200);
}

// Text the CLI writes into user turns that the person did not type.
function cleanUserText(t) {
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
function itemsFromHistory(messages, cwd) {
  const items = [];
  const tools = new Map();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message || {};
    const content = msg.content;
    if (m.type === 'user') {
      if (typeof content === 'string') {
        const text = cleanUserText(content);
        if (text) items.push({ k: 'user', id: m.uuid, text, images: [] });
        continue;
      }
      if (!Array.isArray(content)) continue;
      let text = ''; const images = [];
      for (const b of content) {
        if (b.type === 'text') text += (text ? '\n' : '') + cleanUserText(b.text);
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
          const it = { k: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input, cwd), input: b.input, result: '', status: 'ok' };
          tools.set(b.id, it); items.push(it);
        }
      });
    } else if (m.type === 'system' && msg?.subtype === 'compact_boundary') {
      items.push({ k: 'note', id: m.uuid, text: 'Context was compacted here' });
    }
  }
  return items;
}

async function ensureHistory(a) {
  const r = rt(a.id);
  if (r.historyLoaded) return;
  r.historyLoaded = true;
  if (!a.sessionId || r.items.length) return;
  try {
    const msgs = await getSessionMessages(a.sessionId, { dir: a.cwd });
    r.items = itemsFromHistory(msgs, a.cwd).concat(r.items);
  } catch (e) {
    r.items.unshift({ k: 'note', id: crypto.randomUUID(), text: 'Could not read earlier history: ' + e.message });
  }
}

// ───────────────────────── engine: one SDK session per agent ─────────────────────────

function makeQueue() {
  const buf = []; let wake = null; let closed = false;
  return {
    push(v) { buf.push(v); if (wake) { wake(); wake = null; } },
    close() { closed = true; if (wake) { wake(); wake = null; } },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length) yield buf.shift();
        if (closed) return;
        await new Promise(r => { wake = r; });
      }
    },
  };
}

function armIdleClose(a) {
  const r = rt(a.id);
  clearTimeout(r.idleTimer);
  if (!IDLE_CLOSE_MS) return;
  r.idleTimer = setTimeout(() => {
    if (r.q && r.status !== 'work' && r.status !== 'need') closeQuery(a, 'idle');
  }, IDLE_CLOSE_MS);
}

function closeQuery(a, why) {
  const r = rt(a.id);
  if (!r.q) return;
  try { r.input?.close(); r.q.close(); } catch { /* already gone */ }
  if (why === 'idle') console.log(`[${a.name}] process closed after idle; it resumes on the next message`);
}

function startQuery(a) {
  const r = rt(a.id);
  r.input = makeQueue();
  r.stopping = false;
  const options = {
    cwd: a.cwd,
    env: agentEnv(),
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: teamBrief(a) },
    permissionMode: a.permissionMode || 'default',
    canUseTool: (toolName, input, o) => askUser(a, toolName, input, o),
    stderr: d => { if (process.env.COCKPIT_DEBUG) process.stderr.write(`[${a.name}] ${d}`); },
  };
  if (a.model) options.model = a.model;
  if (process.env.COCKPIT_CLAUDE_PATH) options.pathToClaudeCodeExecutable = process.env.COCKPIT_CLAUDE_PATH;
  if (a.sessionId) options.resume = a.sessionId; else options.title = a.name;

  let q;
  try { q = query({ prompt: r.input, options }); }
  catch (e) { note(a, 'Could not start: ' + e.message); setStatus(a, 'failed', 'Could not start'); return; }
  r.q = q;
  emitAgent(a);

  (async () => {
    try { for await (const m of q) handleMessage(a, m); }
    catch (e) {
      if (!r.stopping) { note(a, 'Session ended with an error: ' + (e?.message || e)); setStatus(a, 'failed', 'Error: ' + (e?.message || e)); }
    } finally {
      if (r.q === q) {
        r.q = null; r.input = null;
        a.cost = (a.cost || 0) + r.queryCost; r.queryCost = 0;
        for (const p of r.pending.values()) p.cancel();
        if (r.status === 'work' || r.status === 'need') setStatus(a, 'idle', a.last);
        else { saveRoster(); emitAgent(a); }
      }
    }
  })();
}

function finalizeLiveText(a, text) {
  const r = rt(a.id);
  const live = r.live.shift();
  if (live) { live.text = text; live.streaming = false; updateItem(a, live); return live; }
  return addItem(a, { k: 'text', text });
}

function handleMessage(a, m) {
  const r = rt(a.id);
  if (m.type === 'system') {
    if (m.subtype === 'init') {
      if (m.session_id && a.sessionId !== m.session_id) { a.sessionId = m.session_id; saveRoster(); }
      a.modelResolved = m.model;
      r.commands = m.slash_commands || [];
      a.commands = r.commands; saveRoster();
      broadcast({ t: 'commands', agentId: a.id, commands: r.commands });
      emitAgent(a);
      checkLogin(a, m.apiKeySource);
    } else if (m.subtype === 'compact_boundary') {
      const c = m.compact_metadata || {};
      const k = n => n ? Math.round(n / 1000) + 'k' : '?';
      note(a, `Context compacted (${c.trigger || 'manual'}) · ${k(c.pre_tokens)} → ${k(c.post_tokens)} tokens`);
      refreshContext(a);
    }
    return;
  }
  if (m.parent_tool_use_id) return; // inner work of subagents stays folded into their tool row

  if (m.type === 'stream_event') {
    const ev = m.event;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      const item = addItem(a, { k: 'text', text: '', streaming: true });
      r.live.push(item); r.liveCurrent = item;
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && r.liveCurrent) {
      r.liveCurrent.text += ev.delta.text;
      broadcast({ t: 'delta', agentId: a.id, id: r.liveCurrent.id, text: ev.delta.text });
    } else if (ev.type === 'content_block_stop') {
      r.liveCurrent = null;
    }
    return;
  }

  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'text') { if (b.text.trim() || r.live.length) { const it = finalizeLiveText(a, b.text); a.last = it.text; } }
      else if (b.type === 'tool_use') {
        if (b.name === 'AskUserQuestion') continue; // shown as a question card instead
        const sum = toolSummary(b.name, b.input, a.cwd);
        addItem(a, { k: 'tool', id: b.id, name: b.name, summary: sum, input: b.input, result: '', status: 'run' });
        a.last = `${b.name} ${sum}`;
      }
    }
    if (m.error) note(a, m.error === 'authentication_failed' ? LOGIN_HINT : 'Model error: ' + m.error);
    touch(a, a.last);
    return;
  }

  if (m.type === 'user') {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const it = r.items.find(x => x.k === 'tool' && x.id === b.tool_use_id);
      if (!it) continue;
      it.result = clip(textOfToolResult(b.content)); it.status = b.is_error ? 'err' : 'ok';
      updateItem(a, it);
    }
    return;
  }

  if (m.type === 'result') {
    r.queryCost = m.total_cost_usd || r.queryCost;
    r.live = []; r.liveCurrent = null;
    for (const it of r.items) if (it.k === 'tool' && it.status === 'run') { it.status = 'ok'; updateItem(a, it); }
    r.turns++;
    refreshContext(a);
    if (m.queued_turn_count > 0) { touch(a); return; }
    if (m.subtype === 'success' && !m.is_error) {
      setStatus(a, 'review', a.last || m.result || 'Finished');
    } else if (r.stopping) {
      r.stopping = false; note(a, 'Stopped by you'); setStatus(a, 'idle', 'Stopped by you');
    } else {
      const why = (m.errors && m.errors.join('; ')) || m.result || m.subtype;
      note(a, 'Turn failed: ' + why);
      if (/log ?in|authenticat|credential|api key|unauthori/i.test(String(why))) note(a, LOGIN_HINT);
      setStatus(a, 'failed', 'Failed: ' + why);
    }
    armIdleClose(a);
  }
}

async function checkLogin(a, apiKeySource) {
  const r = rt(a.id);
  let info = { apiKeySource };
  try { if (r.q) info = { apiKeySource, ...(await r.q.accountInfo()) }; } catch { /* older CLI */ }
  const login = describeLogin(info);
  if (!login) return;
  const changed = !a.login || a.login.label !== login.label;
  a.login = login; saveRoster(); emitAgent(a);
  if (login.api && changed) note(a, `Attention: this agent is billed through ${login.label}, not through your Claude subscription.`);
}

async function refreshContext(a) {
  const r = rt(a.id);
  if (!r.q) return r.ctx;
  try {
    const u = await r.q.getContextUsage();
    r.ctx = {
      percentage: Math.round(u.percentage), totalTokens: u.totalTokens, maxTokens: u.maxTokens, model: u.model,
      categories: (u.categories || []).filter(c => c.tokens > 0 && c.kind !== 'deferred')
        .map(c => ({ id: c.id || c.name, name: c.name, tokens: c.tokens, kind: c.kind })),
      memoryFiles: (u.memoryFiles || []).map(f => ({ path: shortPath(f.path), tokens: f.tokens })),
    };
    a.ctxPct = r.ctx.percentage; saveRoster(); emitAgent(a);
  } catch { /* older CLI or session already closed */ }
  return r.ctx;
}

// Approvals and questions: the SDK waits on this promise until the browser answers.
function askUser(a, toolName, input, o) {
  const r = rt(a.id);
  const id = crypto.randomUUID();
  const isAsk = toolName === 'AskUserQuestion';
  const item = isAsk
    ? { k: 'ask', id, questions: input.questions || [], state: 'pending' }
    : { k: 'perm', id, toolName, summary: toolSummary(toolName, input, a.cwd), input, title: o.title || '', description: o.description || '',
        reason: o.decisionReason || '', canAlways: !!(o.suggestions && o.suggestions.length), state: 'pending' };
  addItem(a, item);
  return new Promise(resolve => {
    const done = (result, state) => {
      if (!r.pending.delete(id)) return;
      item.state = state; updateItem(a, item);
      if (r.pending.size === 0 && r.status === 'need') setStatus(a, 'work', a.last); else emitAgent(a);
      resolve(result);
    };
    r.pending.set(id, {
      item,
      allow: always => done({ behavior: 'allow', updatedInput: input, ...(always && o.suggestions ? { updatedPermissions: o.suggestions } : {}) }, always ? 'always' : 'allowed'),
      deny: msg => done({ behavior: 'deny', message: msg || 'The user denied this action.' }, 'denied'),
      answer: answers => { item.answers = answers; done({ behavior: 'allow', updatedInput: { ...input, answers } }, 'answered'); },
      cancel: () => done({ behavior: 'deny', message: 'Cancelled.' }, 'cancelled'),
    });
    o.signal?.addEventListener('abort', () => r.pending.get(id)?.cancel(), { once: true });
    setStatus(a, 'need', isAsk ? (input.questions?.[0]?.question || 'Has a question') : (o.title || `Wants to use ${toolName}: ${item.summary}`));
  });
}

function sendMessage(a, text, images = []) {
  const r = rt(a.id);
  const content = [];
  for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
  if (text) content.push({ type: 'text', text });
  if (!content.length) return;
  addItem(a, { k: 'user', text, images });
  if (!r.q) startQuery(a);
  if (!r.q) return;
  clearTimeout(r.idleTimer);
  // Plain strings keep slash commands such as /compact working.
  r.input.push({ type: 'user', message: { role: 'user', content: images.length ? content : text }, parent_tool_use_id: null });
  setStatus(a, 'work', text.startsWith('/') ? `Running ${text.split(/\s/)[0]}` : 'Working on your message');
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

function uniqueName(want) {
  const base = (want || 'AGENT').trim().slice(0, 40) || 'AGENT';
  const taken = new Set([...agents.values()].map(a => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
}

// Adds every named Claude Code session of the project folder as an agent (newest session per name).
// Nothing is started: an imported agent only reads its history until you send it a message.
async function importNamed(proj) {
  const have = new Set([...agents.values()].map(a => a.sessionId).filter(Boolean));
  const taken = new Set([...agents.values()].filter(a => a.projectId === proj.id).map(a => a.name.toLowerCase()));
  const byName = new Map();
  for (const s of await listSessions({ dir: proj.cwd, limit: 500 })) {
    const title = (s.customTitle || '').trim();
    if (!title || have.has(s.sessionId) || taken.has(title.toLowerCase())) continue;
    const prev = byName.get(title.toLowerCase());
    if (!prev || (s.lastModified || 0) > (prev.lastModified || 0)) byName.set(title.toLowerCase(), s);
  }
  const added = [];
  for (const s of [...byName.values()].sort((x, y) => (y.lastModified || 0) - (x.lastModified || 0))) {
    let cwd = proj.cwd;
    try { if (s.cwd && fs.statSync(s.cwd).isDirectory()) cwd = path.resolve(s.cwd); } catch { /* keep the project folder */ }
    const a = { id: crypto.randomUUID(), projectId: proj.id, name: uniqueName(s.customTitle.trim()), cwd, model: '', permissionMode: 'default',
      sessionId: s.sessionId, createdAt: Date.now(), updatedAt: s.lastModified || Date.now(), cost: 0,
      last: 'Added from this folder. Close it in the terminal before you write to it here.' };
    agents.set(a.id, a); added.push(a); emitAgent(a);
  }
  if (added.length) saveRoster();
  return added;
}

const routes = {
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
    const p = { id: crypto.randomUUID(), name: String(b.name || '').trim().slice(0, 60) || path.basename(cwd) || cwd, cwd, note: String(b.note || '').slice(0, 4000), createdAt: Date.now() };
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
      id: crypto.randomUUID(), projectId: proj.id, name: uniqueName(b.name), cwd, model: String(b.model || '').trim(),
      permissionMode: ['default', 'acceptEdits', 'plan'].includes(b.permissionMode) ? b.permissionMode : 'default',
      sessionId: b.sessionId || null, createdAt: Date.now(), updatedAt: Date.now(), cost: 0,
      last: b.sessionId ? 'Resumed. Send a message to continue.' : 'Ready. Waiting for a task.',
    };
    agents.set(a.id, a); saveRoster();
    const r = rt(a.id);
    if (b.sessionId) await ensureHistory(a); else r.historyLoaded = true;
    note(a, b.sessionId ? `Resumed session ${b.sessionId.slice(0, 8)} in ${shortPath(cwd)}` : `Launched in ${shortPath(cwd)}`);
    emitAgent(a);
    if (b.firstMessage && String(b.firstMessage).trim()) sendMessage(a, String(b.firstMessage).trim());
    json(res, 200, { agent: publicAgent(a) });
  },
};

const agentRoutes = {
  'GET items': async (a, req, res) => {
    await ensureHistory(a);
    const r = rt(a.id);
    json(res, 200, { items: r.items, commands: r.commands.length ? r.commands : (a.commands || []) });
  },
  'POST message': async (a, req, res) => {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    const images = (Array.isArray(b.images) ? b.images : []).filter(i => i && /^image\/(png|jpeg|gif|webp)$/.test(i.mediaType) && typeof i.data === 'string').slice(0, 10);
    if (!text && !images.length) return json(res, 400, { error: 'Empty message' });
    await ensureHistory(a);
    sendMessage(a, text, images);
    json(res, 200, { ok: true });
  },
  'POST stop': async (a, req, res) => {
    const r = rt(a.id);
    if (r.q && (r.status === 'work' || r.status === 'need')) {
      r.stopping = true;
      for (const p of [...r.pending.values()]) p.cancel();
      try { await r.q.interrupt(); } catch { /* already idle */ }
    }
    json(res, 200, { ok: true });
  },
  'POST decision': async (a, req, res) => {
    const b = await readBody(req);
    const p = rt(a.id).pending.get(b.id);
    if (!p) return json(res, 404, { error: 'This request is no longer waiting.' });
    if (b.decision === 'allow') p.allow(false);
    else if (b.decision === 'always') p.allow(true);
    else if (b.decision === 'answer') p.answer(b.answers || {});
    else p.deny(b.message);
    json(res, 200, { ok: true });
  },
  'GET context': async (a, req, res) => {
    const r = rt(a.id);
    const ctx = await refreshContext(a);
    json(res, 200, { ctx: ctx || null, alive: !!r.q });
  },
  'POST settings': async (a, req, res) => {
    const b = await readBody(req);
    const r = rt(a.id);
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== a.name) a.name = uniqueName(b.name);
    if (['default', 'acceptEdits', 'plan'].includes(b.permissionMode) && b.permissionMode !== a.permissionMode) {
      a.permissionMode = b.permissionMode;
      if (r.q) { try { await r.q.setPermissionMode(a.permissionMode); } catch { /* applies on next start */ } }
    }
    if (typeof b.model === 'string' && b.model.trim() !== (a.model || '')) {
      a.model = b.model.trim();
      if (r.q) { try { await r.q.setModel(a.model || undefined); } catch { /* applies on next start */ } }
    }
    if (b.status === 'idle' && r.status === 'review') r.status = 'idle';
    touch(a);
    json(res, 200, { agent: publicAgent(a) });
  },
  // Removes the agent from the cockpit. The session file stays on disk and can be resumed again.
  'DELETE ': async (a, req, res) => {
    const r = rt(a.id);
    r.stopping = true;
    for (const p of [...r.pending.values()]) p.cancel();
    closeQuery(a);
    agents.delete(a.id); runtimes.delete(a.id); saveRoster();
    broadcast({ t: 'remove', agentId: a.id });
    json(res, 200, { ok: true });
  },
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
    const pm = /^\/api\/projects\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (pm) {
      const p = projects.get(pm[1]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim().slice(0, 60);
        if (typeof b.note === 'string') p.note = b.note.slice(0, 4000);
        saveRoster(); broadcast({ t: 'project', project: publicProject(p) });
        return json(res, 200, { project: publicProject(p) });
      }
      if (req.method === 'DELETE') {
        // Removes the project and its agents from the cockpit. Folders and session files are not touched.
        for (const a of [...agents.values()].filter(x => x.projectId === p.id)) {
          const r = rt(a.id); r.stopping = true;
          for (const q of [...r.pending.values()]) q.cancel();
          closeQuery(a); agents.delete(a.id); runtimes.delete(a.id);
          broadcast({ t: 'remove', agentId: a.id });
        }
        projects.delete(p.id); saveRoster();
        broadcast({ t: 'projectRemove', projectId: p.id });
        return json(res, 200, { ok: true });
      }
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

loadRoster();
server.listen(PORT, HOST, () => {
  const shown = LOOPBACK.has(HOST) ? 'localhost' : HOST;
  const url = `http://${shown}:${PORT}/`;
  console.log(`\n  Agent Cockpit is running:  ${url}${TOKEN ? '?token=…' : ''}`);
  console.log(`  ${projects.size} project(s), ${agents.size} agent(s) · data in ${DATA_DIR}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

function shutdown() {
  for (const a of agents.values()) { const r = rt(a.id); r.stopping = true; a.cost = (a.cost || 0) + r.queryCost; r.queryCost = 0; closeQuery(a); }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ROSTER_FILE, rosterJson()); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
