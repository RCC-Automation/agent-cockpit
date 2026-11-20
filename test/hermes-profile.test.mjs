// A resumed Hermes chat whose old model is gone from Ollama starts with the profile's model (-m), so it can answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers.mjs';

let hermes, server;
before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'have-it:latest' }] })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const home = tempDir('hermes');
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const prof = path.join(home, 'profiles', 'local');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'config.yaml'), `model:\n  provider: custom\n  default: have-it:latest\n  base_url: ${base}\n`);
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: x\n');
  for (const f of [path.join(home, 'state.db'), path.join(prof, 'state.db')]) {
    const d = new DatabaseSync(f);
    d.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)');
    if (f.startsWith(prof)) {
      d.prepare('INSERT INTO sessions VALUES (?, ?)').run('s-gone', 'gone-model:latest');
      d.prepare('INSERT INTO sessions VALUES (?, ?)').run('s-same', 'have-it:latest');
    }
    d.close();
  }
  process.env.HERMES_HOME = home;
  ({ HARNESSES: { hermes } } = await import('../harnesses.mjs?' + Date.now()));
});
after(() => new Promise(r => server.close(r)));

test('a chat whose model Ollama lost starts with the profile model', async () => {
  const a = { id: 'A1', name: 'H', profile: 'local', sessionId: 's-gone' };
  await hermes.prepare(a);
  const args = hermes.args(a, '');
  assert.deepEqual(args.slice(-2), ['-m', 'have-it:latest']);
});

test('a chat whose model Ollama has is resumed as it is', async () => {
  const a = { id: 'A2', name: 'H', profile: 'local', sessionId: 's-same' };
  await hermes.prepare(a);
  assert.ok(!hermes.args(a, '').includes('-m'));
});

test('a model the owner picked always wins', async () => {
  const a = { id: 'A3', name: 'H', profile: 'local', sessionId: 's-gone', model: 'mine' };
  await hermes.prepare(a);
  assert.deepEqual(hermes.args(a, '').slice(-2), ['-m', 'mine']);
});
