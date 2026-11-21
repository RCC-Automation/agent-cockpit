import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperRun, agentFor } from '../oldchats.mjs';

test("Claude Code's own summary runs are not chats", () => {
  assert.equal(helperRun('Below is a conversation log from a Claude Code coding session. Create a summary to help the next session'), true);
  assert.equal(helperRun('  below is a conversation log from a claude code coding session.'), true);
  assert.equal(helperRun('Read HANDOFF.md completely. Then do step 1'), false);
  assert.equal(helperRun(''), false);
});

test('a chat is taken when its session is an agent, or it carries the name of an agent of the project', () => {
  const agents = [{ name: 'COCKPIT', sessionId: 'new-1', projectId: 'p' }, { name: 'LUNA', sessionId: 'l-1', projectId: 'p' }, { name: 'REBE', sessionId: 'r-1', projectId: 'q' }];
  assert.equal(agentFor({ sessionId: 'old-9', customTitle: 'cockpit' }, agents, 'p'), 'COCKPIT', 'an older chat of the same agent');
  assert.equal(agentFor({ sessionId: 'l-1' }, agents, 'p'), 'LUNA');
  assert.equal(agentFor({ sessionId: 'x', customTitle: 'REBE' }, agents, 'p'), null, 'REBE belongs to another project');
  assert.equal(agentFor({ sessionId: 'x', customTitle: '' }, agents, 'p'), null);
});
