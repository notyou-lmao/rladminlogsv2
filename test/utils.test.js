import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCaseNumber,
  parseChannelId,
  parseUserId,
  splitPipeArguments,
} from '../src/utils.js';

test('parses Discord mentions and raw IDs', () => {
  assert.equal(parseUserId('<@123456789012345678>'), '123456789012345678');
  assert.equal(parseUserId('<@!123456789012345678>'), '123456789012345678');
  assert.equal(parseUserId('123456789012345678'), '123456789012345678');
  assert.equal(parseChannelId('<#123456789012345678>'), '123456789012345678');
  assert.equal(parseUserId('not-a-user'), null);
});

test('parses case numbers and pipe-separated command details', () => {
  assert.equal(normalizeCaseNumber('#133'), 133);
  assert.equal(normalizeCaseNumber('133'), 133);
  assert.equal(normalizeCaseNumber('case-133'), null);
  assert.deepEqual(splitPipeArguments('7 days | left without approval', 2), [
    '7 days',
    'left without approval',
  ]);
  assert.deepEqual(
    splitPipeArguments('senior moderator | moderator | abuse of permissions', 3),
    ['senior moderator', 'moderator', 'abuse of permissions'],
  );
});
