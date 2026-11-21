// The folder chooser of New project: the PC lists its folders and makes new ones, so a folder is picked by
// tapping, on the computer and on the iPhone alike (a phone browser cannot see this PC's folders itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The folders inside `dir`, sorted by name, without hidden ones (".git", "$Recycle.Bin") and system folders.
export function listDirs(dir) {
  const full = path.resolve(dir);
  let names;
  try { names = fs.readdirSync(full, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Error(`Folder not found: ${full}`);
    throw new Error(`This folder cannot be opened: ${full}`);
  }
  const dirs = names
    .filter(d => !/^[.$]/.test(d.name) && !/^(System Volume Information|Recovery|PerfLogs)$/i.test(d.name))
    .filter(d => d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(full, d.name))))
    .map(d => ({ name: d.name, path: path.join(full, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(full);
  return { path: full, name: path.basename(full) || full, parent: parent === full ? null : parent, dirs };
}

// A new folder `name` inside `parent`. The name stays one plain folder name, valid on Windows too.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function makeDir(parent, name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || n.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(n) || RESERVED.test(n) || /[. ]$/.test(n)) {
    throw new Error('That folder name cannot be used. Use letters, numbers, spaces, - or _.');
  }
  const base = path.resolve(parent);
  if (!isDir(base)) throw new Error(`Folder not found: ${base}`);
  const full = path.join(base, n);
  if (fs.existsSync(full)) throw new Error(`A folder named "${n}" is already there.`);
  fs.mkdirSync(full);
  return full;
}

// Where the chooser starts and its shortcuts: home, Documents, GitHub folders, Desktop, and the drives.
export function places() {
  const home = os.homedir(), out = [];
  const add = (label, p) => { if (isDir(p) && !out.some(x => x.path.toLowerCase() === p.toLowerCase())) out.push({ label, path: p }); };
  add('Home', home);
  add('GitHub', path.join(home, 'Documents', 'GitHub'));
  add('GitHub', path.join(home, 'GitHub'));
  add('Documents', path.join(home, 'Documents'));
  add('Desktop', path.join(home, 'Desktop'));
  if (process.platform === 'win32') for (const l of 'CDEFGHIJ') add(`${l}:`, `${l}:\\`);
  else add('/', '/');
  return out;
}

// A picture the owner attached and the cockpit saved for a terminal agent (saveImages: <base>/<folder>/<time>-<n>.<ext>),
// so the chat can show it again. Anything else, or a file that is gone, gives null.
export function savedPicture(base, rel) {
  const m = /^([A-Za-z0-9_-]{1,80})[\/](\d{6,20}-\d{1,3}\.(?:png|jpe?g|gif|webp))$/i.exec(String(rel || ''));
  if (!m) return null;
  const full = path.join(path.resolve(base), m[1], m[2]);
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}
