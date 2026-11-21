// Server tests that need no Claude login, no model and no terminal: they run against made-up session files.
// Run with:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startCockpit, tempDir, writeSession, until } from './helpers.mjs';

let c, proj, cwd;
const agentsOf = async () => (await c.call('GET', '/api/state')).json.agents;
const byName = async n => (await agentsOf()).find(a => a.name === n);

before(async () => {
  c = await startCockpit();
  cwd = tempDir('project');
  fs.writeFileSync(path.join(cwd, 'report.html'), '<h1>Report</h1>');
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 'next to the report');
  writeSession(c.config, cwd, { id: '11111111-1111-4111-8111-111111111111', title: 'DONE', turns: [
    ['user', 'Write the report.'], ['tool', 'Write', { file_path: path.join(cwd, 'report.html'), content: '<h1>Report</h1>' }], ['result', 0, 'ok'], ['assistant', 'The **report** is written.']] });
  writeSession(c.config, cwd, { id: '22222222-2222-4222-8222-222222222222', title: 'BUSY', turns: [
    ['user', 'Run the build.'], ['tool', 'Bash', { command: 'npm run build' }]] });
  writeSession(c.config, cwd, { id: '33333333-3333-4333-8333-333333333333', title: 'PEER', turns: [
    ['raw-user', '<cross-session-message from="PANCHO">The slot is free.</cross-session-message>'], ['assistant', 'Thanks.']] });
  writeSession(c.config, cwd, { id: '44444444-4444-4444-8444-444444444444', turns: [['user', 'A session without a name.'], ['assistant', 'ok']] });
});
after(async () => { await c.stop(); });

test('answers on its own address only, and refuses requests from other sites', async () => {
  assert.equal((await c.call('GET', '/api/health')).status, 200);
  const foreignHost = await new Promise(resolve => http.get({ host: '127.0.0.1', port: c.port, path: '/api/state', headers: { host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }));
  assert.equal(foreignHost, 403);
  assert.equal((await c.call('POST', '/api/projects', { cwd }, { origin: 'http://evil.example' })).status, 403);
});

test('a project needs a folder that exists', async () => {
  const r = await c.call('POST', '/api/projects', { cwd: path.join(cwd, 'missing') });
  assert.equal(r.status, 400);
});

test('creating a project adds its named sessions as terminal agents, and only those', async () => {
  const r = await c.call('POST', '/api/projects', { cwd, name: 'Demo' });
  assert.equal(r.status, 200); proj = r.json.project;
  assert.equal(r.json.imported, 3);
  const names = (await agentsOf()).map(a => a.name).sort();
  assert.deepEqual(names, ['BUSY', 'DONE', 'PEER']);
  for (const a of await agentsOf()) { assert.equal(a.mode, 'watch'); assert.equal(a.window, null); assert.equal(a.talk, false); }
  assert.equal((await c.call('POST', '/api/projects', { cwd })).json.existing, true);
});

test('status comes from what the session did last', async () => {
  const done = await until(async () => { const a = await byName('DONE'); return a.status === 'review' ? a : null; });
  assert.ok(done, 'a session that ended its turn is ready to review');
  assert.match(done.last, /report/);
  const busy = await until(async () => { const a = await byName('BUSY'); return a.status === 'work' ? a : null; });
  assert.ok(busy, 'a session in the middle of a tool call is working');
  assert.match(busy.last, /Bash npm run build/);
});

test('the chat is rebuilt from the session file', async () => {
  const done = await byName('DONE');
  const items = (await c.call('GET', `/api/agents/${done.id}/items`)).json.items;
  assert.deepEqual(items.map(i => i.k), ['user', 'tool', 'text']);
  assert.equal(items[1].summary, 'report.html', 'paths inside the project are shown relative to it');
  assert.equal(items[1].files[0].kind, 'html');
  const peer = await byName('PEER');
  const pi = (await c.call('GET', `/api/agents/${peer.id}/items`)).json.items;
  assert.equal(pi[0].k, 'peer'); assert.equal(pi[0].from, 'PANCHO'); assert.equal(pi[0].text, 'The slot is free.');
});

test('a file an agent wrote can be previewed, sandboxed, and nothing outside its folder can', async () => {
  const done = await byName('DONE');
  const items = (await c.call('GET', `/api/agents/${done.id}/items`)).json.items;
  const url = items[1].files[0].url;
  const ok = await c.call('GET', url);
  assert.equal(ok.status, 200); assert.match(ok.text, /Report/);
  assert.match(ok.headers.get('content-security-policy') || '', /^sandbox/);
  const outside = tempDir('outside'); fs.writeFileSync(path.join(outside, 'private.txt'), 'not the agent\'s');
  const escape = url.replace(/[^/]+$/, encodeURIComponent('../' + path.basename(outside) + '/private.txt'));
  assert.equal((await c.call('GET', escape)).status, 404, 'no stepping out of the folder');
  assert.equal((await c.call('GET', url.replace(/[^/]+$/, 'secret.txt'))).status, 200, 'a file next to it in the same folder is reachable, by design');
  const other = url.replace(/\/view\/([^/]+)\/[^/]+\//, (m, id) => `/view/${id}/${Buffer.from('/etc').toString('base64url')}/`).replace(/[^/]+$/, 'hosts.txt');
  assert.equal((await c.call('GET', other)).status, 404, 'no other folder');
});

test('the cockpit does not type into a window it did not open', async () => {
  const done = await byName('DONE');
  const r = await c.call('POST', `/api/agents/${done.id}/message`, { text: 'hello' });
  assert.equal(r.status, 409); assert.match(r.json.error, /Open terminal/); assert.equal(r.json.canForce, false);
  const stop = await c.call('POST', `/api/agents/${done.id}/stop`);
  assert.equal(stop.status, 409, 'and it cannot close one either');
});

test('a removed agent stays removed, and the roster survives a restart', async () => {
  const busy = await byName('BUSY');
  const r = await c.call('POST', `/api/projects/${proj.id}/remove`, { ids: [busy.id] });
  assert.deepEqual(r.json.removed, ['BUSY']);
  assert.equal((await c.call('POST', `/api/projects/${proj.id}/import`)).json.imported, 0, 'it is not added again automatically');
  await c.restart();
  const names = (await agentsOf()).map(a => a.name).sort();
  assert.deepEqual(names, ['DONE', 'PEER']);
  assert.equal((await c.call('GET', '/api/state')).json.projects[0].name, 'Demo');
});

test('permissions can be set for the whole team', async () => {
  const r = await c.call('POST', `/api/projects/${proj.id}`, { permissionMode: 'bypassPermissions' });
  assert.equal(r.json.project.permissionMode, 'bypassPermissions');
  for (const a of await agentsOf()) assert.equal(a.permissionMode, 'bypassPermissions');
  assert.equal((await c.call('POST', `/api/projects/${proj.id}`, { permissionMode: 'nonsense' })).json.project.permissionMode, 'bypassPermissions', 'unknown modes are ignored');
});
