import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('worker and api style.js/common.js are byte-identical',()=>{
 assert.equal(read('../src/style.js'),read('../../api/src/style.js'));
 assert.equal(read('../src/common.js'),read('../../api/src/common.js'));
});
