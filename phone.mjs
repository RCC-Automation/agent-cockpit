// Opens the cockpit to your iPhone (or any device of yours) through Tailscale Serve, and closes it again.
//   node phone.mjs on      publish https://<this-pc>.<tailnet>.ts.net:8446 on your tailnet and let your login in
//   node phone.mjs off     take it away again
//   node phone.mjs status  show the address, or that it is off
// Serve is tailnet only (never Funnel): nothing reaches the internet. The cockpit lets a request from that
// address in only when Tailscale says it comes from the same login as this PC's (data/phone.json).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.COCKPIT_DATA || path.join(ROOT, 'data'));
const COCKPIT_PORT = Number(process.env.COCKPIT_PORT || 4600);
const PHONE_PORT = Number(process.env.COCKPIT_PHONE_PORT || 8446);
const FILE = path.join(DATA_DIR, 'phone.json');

// What phone.json holds, from `tailscale status --json`: this PC's tailnet name and the login it runs under.
export function phoneFromStatus(status, port) {
  const self = status?.Self;
  const host = String(self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  const login = status?.User?.[self?.UserID]?.LoginName || '';
  if (!/^[a-z0-9.-]+\.ts\.net$/.test(host)) throw new Error('Tailscale did not report a tailnet name for this PC. Is it logged in? Run: tailscale status');
  if (!login) throw new Error('Tailscale did not report the login of this PC.');
  return { host, port, login };
}

function tailscaleExe() {
  for (const c of ['tailscale', 'C:\Program Files\Tailscale\tailscale.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  throw new Error('Tailscale is not installed on this PC. Get it from https://tailscale.com/download and log in.');
}
const run = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The port must be free for the cockpit, or already the cockpit's.
function portTaken(exe) {
  let st; try { st = JSON.parse(run(exe, ['serve', 'status', '--json'])); } catch { return ''; }
  for (const [hp, web] of Object.entries(st?.Web || {})) {
    if (!hp.endsWith(`:${PHONE_PORT}`)) continue;
    const target = Object.values(web?.Handlers || {})[0]?.Proxy || '';
    if (!target.includes(`:${COCKPIT_PORT}`)) return target || 'something else';
  }
  return '';
}

function main(cmd) {
  const exe = tailscaleExe();
  if (cmd === 'on') {
    const cfg = phoneFromStatus(JSON.parse(run(exe, ['status', '--json'])), PHONE_PORT);
    const other = portTaken(exe);
    if (other) throw new Error(`Port ${PHONE_PORT} of your tailnet address already goes to ${other}. Pick another: set COCKPIT_PHONE_PORT and run again.`);
    run(exe, ['serve', '--bg', '--yes', '--https', String(PHONE_PORT), `http://127.0.0.1:${COCKPIT_PORT}`]);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`\n  The cockpit is open to your own devices at:\n\n    https://${cfg.host}:${PHONE_PORT}/\n`);
    console.log('  Open it in Safari on your iPhone (Tailscale on), then Share > Add to Home Screen.');
    console.log('  Only devices logged in to your Tailscale account get in. To close it again: phone.cmd off\n');
  } else if (cmd === 'off') {
    try { run(exe, ['serve', '--https', String(PHONE_PORT), 'off']); } catch { /* it was not on */ }
    fs.rmSync(FILE, { force: true });
    console.log('\n  The cockpit is closed to other devices again. It still works on this PC.\n');
  } else {
    let cfg = null; try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* off */ }
    console.log(cfg ? `\n  On: https://${cfg.host}:${cfg.port}/\n` : '\n  Off. Run phone.cmd on to open the cockpit to your iPhone.\n');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv[2] || 'status'); }
  catch (e) { console.error('\n  ' + e.message + '\n'); process.exit(1); }
}
