// The @mention rules (team.mjs). Run with:  node --test test/team.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, answerOfLine, teamHint } from '../team.mjs';

const names = ['REBE', 'Pancho', 'FABY'];

test('a paragraph starting with @Name goes to that teammate, any case', () => {
  assert.deepEqual(parseMentions('Done.\n\n@rebe is the render done?\n\nThanks.', names), [{ to: 'REBE', text: 'is the render done?' }]);
});

test('@team and @all reach everyone', () => {
  assert.deepEqual(parseMentions('@team stand-up in 5', names), [{ to: 'team', text: 'stand-up in 5' }]);
  assert.deepEqual(parseMentions('@all: stop', names), [{ to: 'team', text: 'stop' }]);
});

test('several mentions, one per paragraph', () => {
  assert.deepEqual(parseMentions('@REBE a\n\n@Pancho, b', names), [{ to: 'REBE', text: 'a' }, { to: 'Pancho', text: 'b' }]);
});

test('a name that is not a teammate, a mention mid-sentence, and code are left alone', () => {
  assert.deepEqual(parseMentions('@NOBODY hi', names), []);
  assert.deepEqual(parseMentions('I asked @REBE already.', names), []);
  assert.deepEqual(parseMentions('```\n@REBE rm -rf /\n```', names), []);
  assert.deepEqual(parseMentions('@REBE', names), [], 'a bare name with nothing to say is no message');
});

test('only the agent\'s own answers are read from a session line', () => {
  const line = o => JSON.stringify(o);
  assert.deepEqual(answerOfLine(line({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: '@REBE hi' }] } })), { id: 'u1', text: '@REBE hi' });
  assert.equal(answerOfLine(line({ type: 'assistant', isSidechain: true, uuid: 'u2', message: { content: [{ type: 'text', text: '@REBE hi' }] } })), null, 'a subagent');
  assert.equal(answerOfLine(line({ type: 'user', uuid: 'u3', message: { content: '@REBE hi' } })), null, 'what was sent to it');
  assert.equal(answerOfLine(line({ type: 'assistant', uuid: 'u4', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })), null);
  assert.equal(answerOfLine('{half a line'), null);
});

test('the hint names the teammates and the rule', () => {
  const h = teamHint(['REBE', 'FABY']);
  assert.match(h, /REBE, FABY/);
  assert.match(h, /@Name/);
  assert.match(h, /@team/);
});
