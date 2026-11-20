// Starts a private cockpit for a test: its own port, data folder and Claude Code config folder,
// so no test touches a real roster, a real session or a real terminal window.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let nextPort = 4810 + Math.floor(Math.random() * 300);

export function tempDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-${name}-`)); }

// Claude Code keeps sessions in <config>/projects/<folder name with every other character turned into "-">.
export function sessionFolder(config, cwd) {
  const dir = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// Writes a session file the way Claude Code does. `turns` is a list of
// ['user', text] | ['assistant', text] | ['tool', name, input] | ['result', toolIndex, text] | ['raw-user', content]
export function writeSession(config, cwd, { id, title, turns }) {
  const lines = []; let parent = null; const toolIds = [];
  const base = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.328', gitBranch: 'main', timestamp: new Date().toISOString() });
  const push = o => { o.uuid = uid(); parent = o.uuid; lines.push(JSON.stringify(o)); };
  for (const t of turns) {
    if (t[0] === 'user') push({ ...base(), type: 'user', permissionMode: 'default', message: { role: 'user', content: t[1] } });
    else if (t[0] === 'raw-user') push({ ...base(), type: 'user', message: { role: 'user', content: t[1] } });
    else if (t[0] === 'assistant') push({ ...base(), type: 'assistant', message: { id: 'msg_' + seq, role: 'assistant', type: 'message', model: 'claude-haiku-5-5', content: [{ type: 'text', text: t[1] }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    else if (t[0] === 'tool') { const tid = 'toolu_' + (toolIds.length + 1); toolIds.push(tid); push({ ...base(), type: 'assistant', message: { id: 'msg_' + seq, role: 'assistant', type: 'message', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: tid, name: t[1], input: t[2] }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } }); }
    else if (t[0] === 'result') push({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolIds[t[1]], content: t[2] }] } });
  }
  if (title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }));
  const file = path.join(sessionFolder(config, cwd), id + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export async function startCockpit(extraEnv = {}) {
  const port = nextPort++, data = tempDir('data'), config = tempDir('config');
  const env = { ...process.env, COCKPIT_PORT: String(port), COCKPIT_DATA: data, CLAUDE_CONFIG_DIR: config, COCKPIT_HOST: '127.0.0.1', ...extraEnv };
  delete env.COCKPIT_TOKEN;
  let child;
  const boot = () => { child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: 'ignore' }); };
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const up = async () => {
    for (let i = 0; i < 60; i++) { try { if ((await call('GET', '/api/health')).status === 200) return; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 150)); }
    let log = ''; try { log = fs.readFileSync(path.join(data, 'cockpit.log'), 'utf8').split(/\r?\n/).slice(-8).join(' | '); } catch { /* none */ }
    throw new Error('cockpit did not start. Its log ends with: ' + log);
  };
  // The exit listener goes on before the shutdown request: a cockpit that exits quickly is never missed.
  const stop = async () => {
    const gone = new Promise(r => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000); });
    try { await call('POST', '/api/shutdown', {}); } catch { /* already gone */ }
    await gone;
  };
  boot(); await up();
  return { port, data, config, base, call, stop, restart: async () => { await stop(); boot(); await up(); } };
}

export async function until(fn, ms = 12000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 250)); }
  return last;
}

// A stand-in for the Agent Hub (ai-chat), in this process. It answers the routes the cockpit uses the way
// ai-chat's hub does (plan 1, poc/src/bridge/hub-routes.js), records every call, and can push frames.
// `elsewhere`: agent display names the hub reports as bound to another chat.
export async function startFakeHub({ token = 'app_test_token', elsewhere = [] } = {}) {
  const http = await import('node:http');
  const calls = [], streams = new Set();
  let n = 0;
  const bySession = new Map();
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const frame = (res, f) => res.write(`event: ${f.t}\ndata: ${JSON.stringify(f)}\n\n`);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || '' };
    calls.push(call);
    if (call.auth !== `Bearer ${token}`) return send(res, 401, { error: 'app_token_required', message: 'no' });
    const p = url.pathname;
    if (p === '/v1/app/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(res); req.on('close', () => streams.delete(res));
      return frame(res, { t: 'ready', appId: 'app_1' });
    }
    if (p === '/v1/app/conversations' && req.method === 'POST') return send(res, 201, { conversationId: `conv_${++n}` });
    if (p === '/v1/app/agents/by-session') {
      const id = bySession.get(`${call.query.harness}:${call.query.sessionId}`);
      return id ? send(res, 200, { agentId: id, displayName: '', conversationId: null }) : send(res, 404, { error: 'unknown_session', message: 'no' });
    }
    if (p === '/v1/app/agents' && req.method === 'POST') {
      const id = `agt_${++n}`; bySession.set(`${body.harness}:${body.sessionId}`, id); call.agentId = id;
      return send(res, 201, { agentId: id });
    }
    if (p === '/v1/app/bindings' && req.method === 'POST') {
      const reg = calls.find(c => c.agentId === body.agentId);
      if (reg && elsewhere.includes(reg.body.displayName)) return send(res, 409, { error: 'bound_elsewhere', message: 'in another chat', conversationId: 'conv_other' });
      return send(res, 200, { bound: true });
    }
    if (p === '/v1/app/routes' && req.method === 'POST') return send(res, 201, { routeId: `rte_${++n}` });
    if (/^\/v1\/app\/deliveries\/[^/]+\/outcome$/.test(p)) return send(res, 200, { ok: true });
    send(res, 404, { error: 'not_found', message: p });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token, calls,
    push: f => { for (const s of streams) frame(s, f); },
    streams: () => streams.size,
    dropStream: () => { for (const s of streams) s.destroy(); streams.clear(); },
    close: () => new Promise(r => { for (const s of streams) s.destroy(); server.close(r); }),
  };
}
