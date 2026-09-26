import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {featureDisplay} from '../src/users.js';
import {keyFor,contentDisposition} from '../src/storage.js';
const GiB=1024**3;
test('featureDisplay words storage in binary MB/GB',()=>{
 const f=limit=>featureDisplay({key:'storage_bytes',label:'Cloud storage',valueType:'limit',limit});
 assert.equal(f(524288000),'500 MB cloud storage');
 assert.equal(f(GiB),'1 GB cloud storage');
 assert.equal(f(2*GiB),'2 GB cloud storage');
 assert.equal(f(null),'Unlimited cloud storage');
});
test('storage keys are UUID-only and provider-agnostic',()=>{
 const [u,p,a]=[randomUUID(),randomUUID(),randomUUID()];
 assert.equal(keyFor({userId:u,projectId:p,assetId:a,kind:'source'}),`u/${u}/p/${p}/a/${a}`);
 assert.equal(keyFor({userId:u,projectId:p,assetId:a,kind:'export'}),`u/${u}/p/${p}/x/${a}.mp4`);
 assert.throws(()=>keyFor({userId:'../x',projectId:p,assetId:a,kind:'source'}));
 assert.equal(contentDisposition('attachment','Café short.mp4'),`attachment; filename="Caf short.mp4"; filename*=UTF-8''Caf%C3%A9%20short.mp4`);
});
