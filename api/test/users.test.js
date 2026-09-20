import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBody,createBody,patchBody,syncBody} from '../src/users.js';
const assetId = '11111111-1111-4111-8111-111111111111';
test('googleBody requires a non-trivial idToken', () => {
  assert.equal(googleBody.safeParse({}).success, false);
  assert.equal(googleBody.safeParse({idToken: 'short'}).success, false);
  assert.equal(googleBody.safeParse({idToken: 'x'.repeat(20)}).success, true);
});
test('createBody title is optional but rejects blank/oversized strings', () => {
  assert.equal(createBody.parse({}).title, undefined);
  assert.equal(createBody.safeParse({title: '  '}).success, false);
  assert.equal(createBody.safeParse({title: 'x'.repeat(71)}).success, false);
  assert.equal(createBody.parse({title: '  My short  '}).title, 'My short');
});
test('patchBody rejects unknown fields and out-of-range values', () => {
  assert.equal(patchBody.safeParse({nope: 1}).success, false);
  assert.equal(patchBody.safeParse({clipCount: 6}).success, false);
  assert.equal(patchBody.safeParse({duration: -1}).success, false);
  assert.equal(patchBody.parse({title: 'ok'}).title, 'ok');
});
test('syncBody requires both ids as UUIDs', () => {
  assert.equal(syncBody.safeParse({sessionId: assetId}).success, false);
  assert.equal(syncBody.safeParse({sessionId: 'nope', jobId: assetId}).success, false);
  assert.equal(syncBody.safeParse({sessionId: assetId, jobId: assetId}).success, true);
});
