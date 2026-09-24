import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBody,createBody,patchBody,syncBody,projectEditBody} from '../src/users.js';
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
test('projectEditBody allows an empty edit and rejects unknown fields', () => {
  assert.equal(projectEditBody.safeParse({}).success, true);
  assert.deepEqual(projectEditBody.parse({}), {clips: [], captions: []});
  assert.equal(projectEditBody.safeParse({clips: [], captions: [], nope: 1}).success, false);
});
test('projectEditBody allows an empty caption (mid-typing) but rejects a bad time range', () => {
  const clip = {assetId: assetId, start: 0, end: 2, fit: 'fit'};
  assert.equal(projectEditBody.safeParse({clips: [clip], captions: [{start: 0, end: 1, text: ''}]}).success, true);
  assert.equal(projectEditBody.safeParse({clips: [clip], captions: [{start: 1, end: 1, text: 'x'}]}).success, false);
});
test('projectEditBody has a generous structural cap; real per-plan limits are enforced in the route handler, not here', () => {
  const clip = {assetId: assetId, start: 0, end: 1, fit: 'fit'};
  assert.equal(projectEditBody.safeParse({clips: Array(55).fill(clip), captions: []}).success, true);
  assert.equal(projectEditBody.safeParse({clips: Array(56).fill(clip), captions: []}).success, false);
  assert.equal(projectEditBody.safeParse({clips: [clip], captions: Array(501).fill({start: 0, end: 1, text: 'x'})}).success, false);
});
test('patchBody accepts an optional edit alongside the existing fields', () => {
  assert.equal(patchBody.safeParse({title: 'ok', edit: {clips: [], captions: []}}).success, true);
  assert.equal(patchBody.safeParse({edit: {clips: [{assetId: 'not-a-uuid', start: 0, end: 1}]}}).success, false);
});
test('projectEditBody round-trips a captionStyle object and caption style/words', async () => {
  const {LEGACY} = await import('../src/style.js');
  const body = {clips: [], captions: [{start: 0, end: 2, text: 'a b', style: {color: '#FF0000', outline: {width: 0}}, words: [{start: 0, end: 1}, {start: 1, end: 2}]}], captionStyle: {...LEGACY.classic, font: 'poppins'}};
  assert.deepEqual(projectEditBody.parse(body), body);
  assert.deepEqual(projectEditBody.parse({captionStyle: 'highlight'}).captionStyle, LEGACY.highlight);
  // Stored projects without a style stay style-less ("client default").
  assert.equal('captionStyle' in projectEditBody.parse({}), false);
  assert.equal(projectEditBody.safeParse({captionStyle: {...LEGACY.classic, size: 500}}).success, false);
});
