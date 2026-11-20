// Team talk between the agents of one project, carried by the Agent Hub.
// An agent reaches a teammate by starting a paragraph of its answer with "@Name" (or "@team" for everyone);
// the cockpit sends that paragraph through the hub AS that agent. Pure helpers here; server.mjs does the I/O.

// The paragraphs of an answer that start with "@Name". `names`: the teammates' names (any case).
// Returns [{ to: <name as in names> | 'team', text }]. Text inside ``` code blocks is never a mention,
// and a mention of a name that is not a teammate is left alone (it is just text then).
export function parseMentions(answer, names) {
  const byLower = new Map(names.map(n => [String(n).toLowerCase(), n]));
  const out = [];
  const withoutCode = String(answer || '').replace(/```[\s\S]*?(```|$)/g, '\n\n');
  for (const para of withoutCode.split(/\n\s*\n/)) {
    const m = /^\s*@([A-Za-z0-9_-]{1,40})[\s:,]+([\s\S]+)$/.exec(para);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const to = key === 'team' || key === 'all' ? 'team' : byLower.get(key);
    const text = m[2].trim().slice(0, 4000);
    if (to && text) out.push({ to, text });
  }
  return out;
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
    + '(for example "@REBE is the render done?"); @team reaches all of them. Their answers come back to you the same way.';
}
