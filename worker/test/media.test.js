import test from 'node:test';
import assert from 'node:assert/strict';
import {ass,bgr,alpha,preWrap} from '../src/media.js';
import {LEGACY} from '../src/style.js';
import {edit} from '../src/common.js';
const assetId='11111111-1111-4111-8111-111111111111';
const style=(over={})=>({...structuredClone(LEGACY.classic),...over});
const hl=(over={})=>({...LEGACY.classic.highlight,enabled:true,...over});
const dialogues=out=>out.split('\n').filter(l=>l.startsWith('Dialogue:'));
const times=ds=>ds.map(d=>d.split(',').slice(1,3).join('-'));
test('bgr and alpha convert to ASS notation', () => {
  assert.equal(bgr('#7C3AED'), '&HED3A7C&');
  assert.equal(bgr('#ffd60a'), '&H0AD6FF&');
  assert.equal(alpha(1), '&H00&');
  assert.equal(alpha(0), '&HFF&');
  assert.equal(alpha(0.5), '&H80&');
});
test('legacy classic renders the old Default look as inline tags', () => {
  const out = ass([{start: 0, end: 2, text: 'Hello world'}], LEGACY.classic);
  const ds = dialogues(out);
  assert.equal(ds.length, 1);
  assert.match(ds[0], /^Dialogue: 1,0:00:00\.00,0:00:02\.00,Default,,0,0,0,,/);
  assert.match(ds[0], /\\an2\\pos\(540,1680\)/);
  assert.match(ds[0], /\\b1\\i0\\fnNoto Sans\\fs58/);
  assert.match(ds[0], /\\1c&HFFFFFF&/);
  assert.match(ds[0], /\\3c&H000000&\\bord3/);
  assert.match(ds[0], /\\shad0/);
  assert.match(ds[0], /}Hello world$/);
});
test('legacy highlight is the larger yellow variant', () => {
  const [d] = dialogues(ass([{start: 0, end: 1, text: 'hi'}], LEGACY.highlight));
  assert.match(d, /\\fs66/);
  assert.match(d, /\\1c&H0AD6FF&/);
});
test('box on emits a box layer 0 and a text layer 1', () => {
  const ds = dialogues(ass([{start: 0, end: 2, text: 'Hi there'}], style({box: {enabled: true, color: '#112233', opacity: 0.6, padding: 16}})));
  assert.equal(ds.length, 2);
  assert.match(ds[0], /^Dialogue: 0,.*,Box,/);
  assert.match(ds[0], /\\1a&HFF&/);
  assert.match(ds[0], /\\bord16/);
  assert.match(ds[0], /\\3c&H332211&\\3a&H66&/);
  assert.match(ds[1], /^Dialogue: 1,.*,Default,/);
});
test('highlight with no words splits the caption equally, one active word per event', () => {
  const ds = dialogues(ass([{start: 0, end: 3, text: 'one two three'}], style({highlight: hl({scale: 110})})));
  assert.deepEqual(times(ds), ['0:00:00.00-0:00:01.00', '0:00:01.00-0:00:02.00', '0:00:02.00-0:00:03.00']);
  for (const d of ds) assert.equal(d.match(/\\fscx110/g).length, 1);
  assert.match(ds[1], /\\1c&H0AD6FF&[^}]*\\fscx110\\fscy110} two/);
});
test('highlight uses real word timings and adds a leading gap event', () => {
  const ds = dialogues(ass([{start: 0, end: 2, text: 'a b', words: [{start: 0.5, end: 1}, {start: 1.2, end: 2}]}], style({highlight: hl({scale: 120})})));
  assert.deepEqual(times(ds), ['0:00:00.00-0:00:00.50', '0:00:00.50-0:00:01.20', '0:00:01.20-0:00:02.00']);
  assert.doesNotMatch(ds[0], /fscx120/);
});
test('words length mismatch falls back to an equal split', () => {
  const ds = dialogues(ass([{start: 0, end: 2, text: 'a b', words: [{start: 0.5, end: 2}]}], style({highlight: hl()})));
  assert.deepEqual(times(ds), ['0:00:00.00-0:00:01.00', '0:00:01.00-0:00:02.00']);
});
test('dim and word background tags', () => {
  const ds = dialogues(ass([{start: 0, end: 2, text: 'a b'}], style({highlight: hl({background: {enabled: true, color: '#7C3AED', opacity: 1}, dimOpacity: 0.5})})));
  assert.equal(ds.length, 4); // word background + text, per word
  assert.match(ds[0], /^Dialogue: 0,.*,Box,/);
  assert.match(ds[0], /\\3c&HED3A7C&\\3a&H00&[^}]*}a\{\\3a&HFF&/);
  assert.match(ds[1], /\\1a&H80&[^}]*} b$/);
});
test('per-caption override merges over the global style', () => {
  const out = ass([{start: 0, end: 1, text: 'x', style: {color: '#FF0000'}}], style({font: 'montserrat'}));
  assert.match(out, /\\fnMontserrat/);
  assert.match(out, /\\1c&H0000FF&/);
});
test('uppercase, position and pre-wrap', () => {
  const [d] = dialogues(ass([{start: 0, end: 1, text: 'hello there friend'}], style({uppercase: true, size: 160, position: {anchor: 'top', offset: 40}})));
  assert.match(d, /\\an8\\pos\(540,200\)\\q2/);
  assert.match(d, /}HELLO\\NTHERE\\NFRIEND$/);
  assert.deepEqual(preWrap('aaa bbb ccc', 58), ['aaa bbb ccc']);
  assert.deepEqual(preWrap('one\ntwo', 58), ['one', 'two']);
});
test('user text cannot inject override tags', () => {
  const out = ass([{start: 0, end: 1, text: 'a {\\b1} b'}], style({highlight: hl()}));
  assert.doesNotMatch(out, /\{\\b1\}/);
  assert.match(out, /\(／b1\)/);
});
test('schema: legacy default is the classic object; rejects bad styles', () => {
  const base = {clips: [{assetId, start: 0, end: 2}]};
  assert.deepEqual(edit.parse(base).captionStyle, LEGACY.classic);
  assert.deepEqual(edit.parse({...base, captionStyle: 'highlight'}).captionStyle, LEGACY.highlight);
  assert.deepEqual(edit.parse({...base, captionStyle: style({font: 'poppins'})}).captionStyle.font, 'poppins');
  assert.equal(edit.safeParse({...base, captionStyle: style({font: 'anton', weight: 700})}).success, false);
  assert.equal(edit.safeParse({...base, captionStyle: style({color: 'red'})}).success, false);
  assert.equal(edit.safeParse({...base, captionStyle: style({size: 500})}).success, false);
  assert.equal(edit.safeParse({...base, captionStyle: {...style(), extra: 1}}).success, false);
  // An override that makes the effective font/weight invalid is rejected.
  assert.equal(edit.safeParse({...base, captions: [{start: 0, end: 1, text: 'x', style: {font: 'anton'}}]}).success, false);
  assert.equal(edit.safeParse({...base, captions: [{start: 0, end: 1, text: 'x', style: {font: 'anton', weight: 400}, words: [{start: 0, end: 1}]}]}).success, true);
  assert.equal(edit.safeParse({...base, captions: [{start: 0, end: 1, text: 'x', style: {nope: 1}}]}).success, false);
});
test('whitespace-only caption emits nothing', () => {
  assert.equal(dialogues(ass([{start: 0, end: 1, text: '  '}], style({highlight: hl()}))).length, 0);
});
