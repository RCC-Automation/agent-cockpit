// The cockpit as a client of the Agent Hub (ai-chat's bridge). The hub delivers messages between agents;
// the cockpit carries them into the windows it opened. With no hub configured nothing here runs.
// Plan: docs/superpowers/plans/2026-11-20-cockpit-hub-client.md. Hub routes: ai-chat poc/src/bridge/hub-routes.js.

import fs from 'node:fs';
import path from 'node:path';

// Where the hub is and the app token the owner made for the cockpit (POST /v1/admin/apps on the hub).
// The token comes from COCKPIT_HUB_TOKEN or <data>/hub-token.txt; it is never logged or sent to the page.
export function hubConfig(dataDir) {
  const url = (process.env.COCKPIT_HUB_URL || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  let token = (process.env.COCKPIT_HUB_TOKEN || '').trim();
  if (!token) { try { token = fs.readFileSync(path.join(dataDir, 'hub-token.txt'), 'utf8').trim(); } catch { /* none */ } }
  return { url, token };
}

// A connection to the hub: `call` for its routes, and one live stream of frames that comes back by itself.
// state: 'connecting' | 'connected' | 'unreachable'. `call` never throws.
export function createHubClient({ url, token, onFrame, onState, fetchImpl = fetch, retryMs = 3000 }) {
  let state = 'connecting', error = '', stopped = false, ctrl = null, wait = retryMs, timer = null;
  const setState = (s, e = '') => { if (s === state && e === error) return; state = s; error = e; onState && onState(s, e); };
  const headers = extra => ({ authorization: `Bearer ${token}`, ...extra });

  async function call(method, p, body) {
    try {
      const res = await fetchImpl(url + p, { method, headers: headers(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      let json = null; try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, json };
    } catch (e) { return { status: 0, json: { error: 'unreachable', message: e.message } }; }
  }

  function retry(why) {
    if (stopped) return;
    setState('unreachable', why);
    clearTimeout(timer);
    timer = setTimeout(open, wait);
    wait = Math.min(wait * 2, 10_000);
  }

  // Reads `event:` / `data:` lines; each blank line ends one frame.
  async function open() {
    if (stopped) return;
    setState(state === 'connected' ? 'connecting' : state, error);
    ctrl = new AbortController();
    let res;
    try { res = await fetchImpl(url + '/v1/app/stream', { headers: headers({ accept: 'text/event-stream' }), signal: ctrl.signal }); }
    catch (e) { return retry(e.message); }
    if (!res.ok || !res.body) return retry(`the hub answered ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', data = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (!line && data) {
            let f = null; try { f = JSON.parse(data); } catch { /* not a frame */ }
            data = '';
            if (!f) continue;
            if (f.t === 'ready') { wait = retryMs; setState('connected'); }
            try { onFrame && onFrame(f); } catch { /* a handler error must not end the stream */ }
          }
        }
      }
    } catch (e) { if (!stopped) return retry(e.message); }
    retry('the hub ended the stream');
  }

  return {
    call,
    start() { stopped = false; open(); },
    stop() { stopped = true; clearTimeout(timer); try { ctrl && ctrl.abort(); } catch { /* gone */ } },
    state: () => ({ state, error }),
  };
}

// What is typed into a window for a hub delivery. A person's words go in as they are. Another agent's words
// never do: typed text carries the person's authority, so the window gets a notice and the agent reads the
// message itself with its bridge tools (the hub's rule, from om-studio's M4).
export function deliveryText(frame) {
  if (frame.senderHarness === 'human') return String(frame.content ?? '');
  return `[Team message ${frame.messageId} from ${frame.senderName || 'another agent'}. Read it with get_pending_messages.]`;
}

// The outcome reported to the hub for one typing result. A question in the window holds the delivery; a write
// whose result is unknown is "uncertain", which the hub never sends again.
export function outcomeFor(result, question) {
  if (result === 'sent') return { outcome: 'sent' };
  if (result === 'QUESTION') return { outcome: 'held', reason: 'question', question };
  if (/window is closed|no window|no terminal window/.test(result || '')) return { outcome: 'refused', reason: 'no_window' };
  if (/no answer from the helper/.test(result || '')) return { outcome: 'uncertain', reason: result };
  return { outcome: 'failed', reason: String(result || 'unknown') };
}
