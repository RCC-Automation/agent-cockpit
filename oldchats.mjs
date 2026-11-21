// "Bring back an old chat" lists only real chats that are not in the agent list.

// Claude Code starts short runs of its own (for example to summarise a session); they are no chats.
export function helperRun(firstPrompt) {
  return /^\s*Below is a conversation log from a Claude Code coding session/i.test(String(firstPrompt || ''));
}

// The agent a session already belongs to: its own session, or (by name) an older chat of an agent of this project,
// since an agent follows the newest session of its name. null when it is not in the agent list.
export function agentFor(session, agents, projectId) {
  const own = agents.find(a => a.sessionId && a.sessionId === session.sessionId);
  if (own) return own.name;
  const name = String(session.customTitle || '').trim().toLowerCase();
  if (!name) return null;
  const same = agents.find(a => a.projectId === projectId && String(a.name || '').toLowerCase() === name);
  return same ? same.name : null;
}
