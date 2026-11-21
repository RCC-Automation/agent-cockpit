import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirs, makeDir, places } from '../dirs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-dirs-'));

test('listDirs shows the folders only, sorted, without hidden ones, with the way up', () => {
  const root = tmp();
  for (const d of ['beta', 'Alpha', '.git', 'node_modules']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  const r = listDirs(root);
  assert.equal(r.path, root);
  assert.equal(r.parent, path.dirname(root));
  assert.deepEqual(r.dirs.map(d => d.name), ['Alpha', 'beta', 'node_modules']);
  assert.equal(r.dirs[0].path, path.join(root, 'Alpha'));
});

test('listDirs of a folder that does not exist says so', () => {
  assert.throws(() => listDirs(path.join(tmp(), 'nope')), /not found/i);
});

test('makeDir creates a new folder inside the given one and returns its path', () => {
  const root = tmp();
  const made = makeDir(root, '  My film  ');
  assert.equal(made, path.join(root, 'My film'));
  assert.ok(fs.statSync(made).isDirectory());
});

test('makeDir refuses names that would leave the folder or break Windows', () => {
  const root = tmp();
  for (const bad of ['', '   ', '..', '.', 'a/b', 'a\\b', 'x:y', 'what?', 'CON', 'trail.', 'x'.repeat(200)]) {
    assert.throws(() => makeDir(root, bad), /name/i, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('makeDir refuses a name that already exists', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'taken'));
  assert.throws(() => makeDir(root, 'taken'), /already/i);
});

test('places offers the home folder and only folders that exist', () => {
  const p = places();
  assert.ok(p.some(x => x.path === os.homedir()));
  for (const x of p) assert.ok(fs.statSync(x.path).isDirectory(), x.path);
});
