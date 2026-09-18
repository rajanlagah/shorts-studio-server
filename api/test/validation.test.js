import test from 'node:test';
import assert from 'node:assert/strict';
import {edit,uuid} from '../src/common.js';
const assetId='11111111-1111-4111-8111-111111111111';
test('rejects traversal and invalid UUIDs',()=>{assert.equal(uuid.safeParse('../etc/passwd').success,false);});
test('rejects reversed trim, excessive duration and captions past timeline',()=>{
 for(const body of [
 {clips:[{assetId,start:3,end:2}]},
 {clips:[{assetId,start:0,end:181}]},
 {clips:[{assetId,start:0,end:2}],captions:[{start:0,end:3,text:'Hi'}]}
 ])assert.equal(edit.safeParse(body).success,false);
});
test('allows reused assets and supplies default fit/captions',()=>{
 const p=edit.parse({clips:[{assetId,start:0,end:1},{assetId,start:2,end:3}]});
 assert.equal(p.clips[0].fit,'fit');assert.deepEqual(p.captions,[]);
});
