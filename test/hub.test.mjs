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
