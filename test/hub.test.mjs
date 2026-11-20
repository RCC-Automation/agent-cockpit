// The cockpit as a client of the Agent Hub (docs/superpowers/plans/2026-11-20-cockpit-hub-client.md).
// A fake hub stands in for ai-chat; no test types into a window.
// Run with:  node --test test/hub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCockpit, startFakeHub, until } from './helpers.mjs';

const hubState = async c => (await c.call('GET', '/api/state')).json.hub;

test('with no hub configured the cockpit reports the hub off', async () => {
  const c = await startCockpit();
  try { assert.equal((await hubState(c)).state, 'off'); } finally { await c.stop(); }
});

test('the cockpit connects to the hub and shows it', async () => {
  const fake = await startFakeHub();
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    assert.ok(await until(async () => (await hubState(c)).state === 'connected'), 'connected');
    const s = fake.calls.find(x => x.path === '/v1/app/stream');
    assert.equal(s.auth, `Bearer ${fake.token}`);
  } finally { await c.stop(); await fake.close(); }
});

test('a dropped hub stream comes back', async () => {
  const fake = await startFakeHub();
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    assert.ok(await until(async () => fake.streams() === 1));
    fake.dropStream();
    assert.ok(await until(async () => (await hubState(c)).state !== 'connected', 5000), 'notices the drop');
    assert.ok(await until(async () => (await hubState(c)).state === 'connected' && fake.streams() === 1, 12000), 'back within 10 s');
  } finally { await c.stop(); await fake.close(); }
});

test('the hub token never reaches the page', async () => {
  const fake = await startFakeHub();
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    await until(async () => (await hubState(c)).state === 'connected');
    assert.ok(!(await c.call('GET', '/api/state')).text.includes(fake.token));
    assert.ok(!(await c.call('GET', '/')).text.includes(fake.token));
  } finally { await c.stop(); await fake.close(); }
});

// ── Task 3: one team conversation per project ──
import fs from 'node:fs';
import { tempDir, writeSession } from './helpers.mjs';

async function projectWithTwo(c, names = ['ALPHA', 'BETA']) {
  const cwd = tempDir('team');
  names.forEach((t, i) => writeSession(c.config, cwd, { id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i + 1}`, title: t, turns: [['user', 'hi'], ['assistant', 'ok']] }));
  const r = await c.call('POST', '/api/projects', { cwd });
  assert.equal(r.status, 200);
  return r.json.project;
}
const agentsNamed = async (c, n) => (await c.call('GET', '/api/state')).json.agents.find(a => a.name === n);

test('a project gets one team conversation, also after a restart', async () => {
  const fake = await startFakeHub();
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    await projectWithTwo(c);
    assert.ok(await until(async () => fake.calls.filter(x => x.path === '/v1/app/bindings').length === 2), 'both bound');
    assert.equal(fake.calls.filter(x => x.path === '/v1/app/conversations').length, 1);
    await c.restart();
    await until(async () => (await hubState(c)).state === 'connected');
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(fake.calls.filter(x => x.path === '/v1/app/conversations').length, 1, 'no second team chat after a restart');
  } finally { await c.stop(); await fake.close(); }
});

test('every project agent with a session is bound to the team chat', async () => {
  const fake = await startFakeHub();
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    await projectWithTwo(c);
    assert.ok(await until(async () => (await agentsNamed(c, 'ALPHA'))?.hubTeam === 'team' && (await agentsNamed(c, 'BETA'))?.hubTeam === 'team'));
    const conv = fake.calls.find(x => x.path === '/v1/app/conversations');
    const binds = fake.calls.filter(x => x.path === '/v1/app/bindings');
    assert.equal(binds.length, 2);
    assert.ok(binds.every(b => b.body.conversationId === 'conv_1'), JSON.stringify(binds.map(b => b.body)));
    assert.ok(conv.body.label.startsWith('cockpit: '));
    const reg = fake.calls.filter(x => x.path === '/v1/app/agents' && x.method === 'POST');
    assert.deepEqual(reg.map(r => r.body.harness), ['claude-code', 'claude-code']);
  } finally { await c.stop(); await fake.close(); }
});

test('an agent in another chat is left there and shown so', async () => {
  const fake = await startFakeHub({ elsewhere: ['BETA'] });
  const c = await startCockpit({ COCKPIT_HUB_URL: fake.url, COCKPIT_HUB_TOKEN: fake.token });
  try {
    await projectWithTwo(c);
    assert.ok(await until(async () => (await agentsNamed(c, 'BETA'))?.hubTeam === 'other'));
    assert.equal((await agentsNamed(c, 'ALPHA')).hubTeam, 'team');
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(fake.calls.filter(x => x.path === '/v1/app/bindings').length, 2, 'BETA is not tried again');
  } finally { await c.stop(); await fake.close(); }
});
