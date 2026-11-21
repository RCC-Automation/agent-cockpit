// The @mention rules (team.mjs). Run with:  node --test test/team.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, answerOfLine, teamHint, ownerMentions, ownPart, isAck } from '../team.mjs';

const names = ['REBE', 'Pancho', 'FABY'];

test('from a paragraph starting with @Name to the end of the answer goes to that teammate, any case', () => {
  assert.deepEqual(parseMentions('Done.\n\n@rebe is the render done?\n\nThanks.', names), [{ to: 'REBE', text: 'is the render done?\n\nThanks.' }]);
});

test('a message of several paragraphs goes whole, as GEMI sent a song', () => {
  const song = '@COCKPIT\nVerse 1\nline a\n\nChorus\nline b\n\nVerse 2\nline c';
  assert.deepEqual(parseMentions(song, ['COCKPIT']), [{ to: 'COCKPIT', text: 'Verse 1\nline a\n\nChorus\nline b\n\nVerse 2\nline c' }]);
});

test('code inside a message to a teammate goes with it', () => {
  assert.deepEqual(parseMentions('@REBE run this:\n\n```\nnpm test\n```', names), [{ to: 'REBE', text: 'run this:\n\n```\nnpm test\n```' }]);
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

// The owner's own messages: every @Name anywhere in the text counts (the owner writes like in a chat).
test("the owner's @Names count anywhere in the message", () => {
  const m = ownerMentions('@COCKPIT can you see this message? And you @gemi? what about you @LUNA', ['COCKPIT', 'GEMI', 'LUNA', 'REBE']);
  assert.deepEqual(m.names, ['COCKPIT', 'GEMI', 'LUNA']);
  assert.equal(m.leading, 'COCKPIT');
  assert.equal(m.all, false);
});

test("an owner's single leading @Name is taken off the words; with several the text stays as written", () => {
  assert.equal(ownerMentions('@REBE is the render done?', ['REBE']).words, 'is the render done?');
  assert.equal(ownerMentions('@REBE ask @FABY too', ['REBE', 'FABY']).words, '@REBE ask @FABY too');
  assert.equal(ownerMentions('hello @REBE', ['REBE']).words, 'hello @REBE');
});

test('@team anywhere, and what is not a mention for the owner', () => {
  assert.equal(ownerMentions('tell @team to stop', ['REBE']).all, true);
  const m = ownerMentions('mail me at raul@REBE.com or run `@REBE x`, @NOBODY', ['REBE']);
  assert.deepEqual(m.names, []);
  assert.equal(m.all, false);
});

// What an agent says to its user (shown in Team talk as its answer to the owner): the part before any @Name message.
test('the part of an answer for the user is what comes before the first @Name message', () => {
  assert.equal(ownPart('Here it is.\n\n@REBE is the render done?', names), 'Here it is.');
  assert.equal(ownPart('No teammate here, just me.', names), 'No teammate here, just me.');
  assert.equal(ownPart('@REBE only for you', names), '');
  assert.equal(ownPart('I asked @REBE already.', names), 'I asked @REBE already.');
});

// Two agents only confirming each other ("confirmed." "standing by.") is a loop; real work is not.
test('a short confirmation is an acknowledgement, real content is not', () => {
  for (const t of ['confirmed.', 'Standing by.', 'ready.', 'Acknowledged!', 'ok', 'Thanks, got it.', 'Understood 👍', 'Perfect, thank you!', 'Sounds good.', 'You are welcome.'])
    assert.equal(isAck(t), true, t);
  for (const t of ['Here is the chorus:\nOh, Noche de Muertos', 'ok, change line 3 to "sugar skulls"', 'Can you share the song?', 'Done: the render is at C:/out/film.mp4'])
    assert.equal(isAck(t), false, t);
});
