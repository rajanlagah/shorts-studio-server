import test from 'node:test';
import assert from 'node:assert/strict';
import {ass} from '../src/media.js';
test('classic style (default) renders Default, byte-identical to pre-plan output', () => {
  const out = ass([{start: 0, end: 2, text: 'Hello world'}]);
  assert.match(out, /Style: Default,Noto Sans,58/);
  assert.match(out, /Dialogue: 0,0:00:00\.00,0:00:02\.00,Default,,0,0,0,,Hello world/);
});
test('highlight style picks the Highlight style line', () => {
  const out = ass([{start: 0, end: 1, text: 'hi'}], 'highlight');
  assert.match(out, /Style: Highlight,Noto Sans,66,&H000AD6FF/);
  assert.match(out, /Dialogue: 0,0:00:00\.00,0:00:01\.00,Highlight,,0,0,0,,hi/);
});
