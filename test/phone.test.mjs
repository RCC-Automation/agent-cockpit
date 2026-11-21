// The iPhone through Tailscale Serve (see README "iPhone"). Serve publishes https://<pc>.<tailnet>.ts.net:<port>
// on the private tailnet and proxies it to the cockpit on 127.0.0.1, adding the Tailscale-User-Login header of the
// person whose device asked. The cockpit answers such a request only when data/phone.json names that exact
// address and that login. Run with:  node --test test/phone.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startCockpit } from './helpers.mjs';

let c;
const PHONE = { host: 'mypc.tail0000.ts.net', port: 8446, login: 'owner@example.com' };
const ADDR = `${PHONE.host}:${PHONE.port}`;
before(async () => { c = await startCockpit(); });
after(async () => { if (c) await c.stop(); });

const ask = (method, p, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: c.port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const fromPhone = (login = PHONE.login, extra = {}) => ({ host: ADDR, ...(login ? { 'tailscale-user-login': login } : {}), ...extra });
const writePhone = cfg => fs.writeFileSync(path.join(c.data, 'phone.json'), JSON.stringify(cfg));

test('without phone.json the tailnet address is refused', async () => {
  assert.equal(await ask('GET', '/api/state', fromPhone()), 403);
});

test("the owner's phone through Serve is let in", async () => {
  writePhone(PHONE);
  assert.equal(await ask('GET', '/api/state', fromPhone()), 200);
  assert.equal(await ask('GET', '/', fromPhone()), 200);
});

test('another tailnet login, or none, is refused', async () => {
  assert.equal(await ask('GET', '/api/state', fromPhone('someone@else.com')), 403);
  assert.equal(await ask('GET', '/api/state', fromPhone('')), 403);
});

test('another port or another name on the tailnet is refused', async () => {
  assert.equal(await ask('GET', '/api/state', { host: `${PHONE.host}:8447`, 'tailscale-user-login': PHONE.login }), 403);
  assert.equal(await ask('GET', '/api/state', { host: `other.tail0000.ts.net:${PHONE.port}`, 'tailscale-user-login': PHONE.login }), 403);
});

test("a write from the phone needs the phone's own origin", async () => {
  assert.equal(await ask('POST', '/api/team', fromPhone(PHONE.login, { origin: `https://${ADDR}` }), { project: 'none', text: '@X hi' }), 404, 'passes the guard (no such project)');
  assert.equal(await ask('POST', '/api/team', fromPhone(PHONE.login, { origin: 'https://evil.example' }), { project: 'none', text: '@X hi' }), 403);
});

test('removing phone.json shuts the phone out at once, without a restart', async () => {
  fs.rmSync(path.join(c.data, 'phone.json'));
  assert.equal(await ask('GET', '/api/state', fromPhone()), 403);
});

test('a phone.json without a login lets nobody in', async () => {
  writePhone({ host: PHONE.host, port: PHONE.port, login: '' });
  assert.equal(await ask('GET', '/api/state', fromPhone('')), 403);
  fs.rmSync(path.join(c.data, 'phone.json'));
});

test('phone.mjs takes the tailnet name and the login from tailscale status', async () => {
  const { phoneFromStatus } = await import('../phone.mjs');
  const st = { Self: { DNSName: 'MyPC.tail0000.ts.net.', UserID: 7 }, User: { 7: { LoginName: 'owner@example.com' } } };
  assert.deepEqual(phoneFromStatus(st, 8446), { host: 'mypc.tail0000.ts.net', port: 8446, login: 'owner@example.com' });
  assert.throws(() => phoneFromStatus({ Self: { DNSName: '', UserID: 7 }, User: {} }, 8446), /tailnet name/);
  assert.throws(() => phoneFromStatus({ Self: { DNSName: 'a.ts.net.', UserID: 7 }, User: {} }, 8446), /login/);
});
