// The phone's microphone: the page records, POST /api/transcribe turns the recording into text on this PC
// (Whisper, through transcribe-worker.py). Here a fake worker stands in. Run with:  node --test test/transcribe.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCockpit } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-transcriber.mjs');
let c;
before(async () => { c = await startCockpit({ COCKPIT_TRANSCRIBE_CMD: JSON.stringify([process.execPath, FAKE]) }); });
after(async () => { if (c) await c.stop(); });

const post = (q, type, body) => fetch(`${c.base}/api/transcribe${q}`, { method: 'POST', headers: { 'content-type': type }, body }).then(async r => ({ status: r.status, json: await r.json() }));

test('a recording comes back as text, in the chosen language', async () => {
  const r = await post('?lang=es-ES', 'audio/mp4', Buffer.alloc(1234, 1));
  assert.equal(r.status, 200);
  assert.equal(r.json.text, 'heard 1234 bytes in es');
});

test('two recordings at once each get their own text', async () => {
  const [a, b] = await Promise.all([post('', 'audio/webm', Buffer.alloc(10, 1)), post('?lang=de-DE', 'audio/webm;codecs=opus', Buffer.alloc(20, 1))]);
  assert.equal(a.json.text, 'heard 10 bytes in auto');
  assert.equal(b.json.text, 'heard 20 bytes in de');
});

test('only audio is taken, and not an empty one', async () => {
  assert.equal((await post('', 'text/plain', 'hello')).status, 415);
  assert.equal((await post('', 'audio/mp4', Buffer.alloc(0))).status, 400);
});

test('tapping the mic warms the model up, and the recording after it still comes back', async () => {
  const w = await fetch(`${c.base}/api/transcribe/warm`, { method: 'POST' });
  assert.equal(w.status, 202);
  const r = await post('', 'audio/mp4', Buffer.alloc(7, 1));
  assert.equal(r.json.text, 'heard 7 bytes in auto');
});
