// Team talk between the agents of one project, carried by the Agent Hub.
// An agent reaches a teammate by starting a paragraph of its answer with "@Name" (or "@team" for everyone);
// the cockpit sends that paragraph through the hub AS that agent. Pure helpers here; server.mjs does the I/O.

// The paragraphs of an answer that start with "@Name". `names`: the teammates' names (any case).
// Returns [{ to: <name as in names> | 'team', text }]. Text inside ``` code blocks is never a mention,
// and a mention of a name that is not a teammate is left alone (it is just text then).
// A message runs from its @Name to the next paragraph that starts with a teammate's @Name, or to the end of the
// answer, so a message of several paragraphs (a song, a list, code) goes whole. An @Name inside ``` code never
// starts one.
export function parseMentions(answer, names) {
  const byLower = new Map(names.map(n => [String(n).toLowerCase(), n]));
  const out = [];
  let cur = null, inCode = false, prevBlank = true;
  for (const line of String(answer || '').split('\n')) {
    const m = !inCode && prevBlank ? /^\s*@([A-Za-z0-9_-]{1,40})(?:[\s:,]+([\s\S]*))?$/.exec(line) : null;
    const key = m && m[1].toLowerCase();
    const to = m && (key === 'team' || key === 'all' ? 'team' : byLower.get(key));
    if (to) { cur = { to, lines: [m[2] || ''] }; out.push(cur); }
    else if (cur) cur.lines.push(line);
    if (/^\s*```/.test(line)) inCode = !inCode;
    prevBlank = !line.trim();
  }
  return out.map(c => ({ to: c.to, text: c.lines.join('\n').trim().slice(0, 4000) })).filter(c => c.text);
}

// What an answer says to the user: everything before its first @Name message (all of it when there is none).
export function ownPart(answer, names) {
  const byLower = new Set([...names.map(n => String(n).toLowerCase()), 'team', 'all']);
  const lines = String(answer || '').split('\n'), keep = [];
  let inCode = false, prevBlank = true;
  for (const line of lines) {
    const m = !inCode && prevBlank ? /^\s*@([A-Za-z0-9_-]{1,40})(?:[\s:,]|$)/.exec(line) : null;
    if (m && byLower.has(m[1].toLowerCase())) break;
    keep.push(line);
    if (/^\s*```/.test(line)) inCode = !inCode;
    prevBlank = !line.trim();
  }
  return keep.join('\n').trim().slice(0, 4000);
}

// What a new Claude Code session line holds for the mention reader: the text of an answer, or null.
// Only the agent's own answers count: not subagents (sidechain), not tool calls, not what was sent to it.
export function answerOfLine(line) {
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) return null;
  const text = o.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text ? { id: o.uuid || o.message.id || '', text } : null;
}

// The hint every team agent gets once, so it knows how to reach its teammates.
export function teamHint(names) {
  const list = names.length ? names.join(', ') : 'none yet';
  return `Your teammates in this project: ${list}. To reach one, start a paragraph of your answer with @Name `
    + '(for example "@REBE is the render done?"); @team reaches all of them. Everything from the @Name to the end of '
    + 'your answer (or to the next @Name paragraph) goes to them, so write what is for your user before it. '
    + 'Their answers come back to you the same way. '
    + 'Do not answer a teammate just to confirm, thank or acknowledge: that starts an endless back and forth.';
}

// The owner's own message: every "@Name" anywhere in it counts, as in a chat (not inside `code`, not in an
// e-mail address). `names`: the agents that can be named. Returns { names: [as in names], all: @team/@all
// was written, leading: the name the text starts with or '', words: what to type }. With one leading @Name
// and no other, the words are the text without it; otherwise the text stays as written.
export function ownerMentions(text, names) {
  const byLower = new Map(names.map(n => [String(n).toLowerCase(), n]));
  const plain = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = [], seen = new Set(); let all = false, count = 0;
  for (const m of plain.matchAll(/(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_-]{1,40})(?![A-Za-z0-9_.-]*[A-Za-z0-9_-])/g)) {
    const key = m[2].toLowerCase();
    if (key === 'team' || key === 'all') { all = true; count++; continue; }
    const n = byLower.get(key);
    if (!n) continue;
    count++;
    if (!seen.has(n)) { seen.add(n); found.push(n); }
  }
  const lead = /^\s*@([A-Za-z0-9_-]{1,40})[\s:,]+([\s\S]+)$/.exec(String(text || ''));
  const leadKey = lead?.[1].toLowerCase();
  const leading = lead ? (leadKey === 'team' || leadKey === 'all' ? 'team' : byLower.get(leadKey) || '') : '';
  const words = leading && count === 1 ? lead[2].trim() : String(text || '').trim();
  return { names: found, all, leading, words };
}

// A message that only confirms, thanks or says it waits ("confirmed.", "standing by.", "thanks, got it"): short,
// and made only of such words. Two in a row between agents is a loop with nothing in it.
const ACK_WORDS = new Set(['ok', 'okay', 'k', 'confirmed', 'confirm', 'acknowledged', 'ack', 'ready', 'standing', 'by', 'thanks',
  'thank', 'you', 'got', 'it', 'understood', 'noted', 'perfect', 'great', 'sounds', 'good', 'will', 'do', 'sure', 'yes', 'cool',
  'nice', 'roger', 'welcome', 'are', 'youre', 'all', 'set', 'received', 'agreed', 'same', 'here', 'too', 'waiting', 'gracias',
  'listo', 'vale', 'entendido', 'perfecto', 'de', 'nada', 'danke', 'alles', 'klar', 'gut']);
export function isAck(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60 || t.includes('\n')) return false;
  const words = t.toLowerCase().replace(/[’']/g, '').match(/[a-záéíóúñü]+/g) || [];
  return words.length > 0 && words.length <= 6 && words.every(w => ACK_WORDS.has(w));
}
