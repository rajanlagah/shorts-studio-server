import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCache} from '../src/cache.js';
function fake(sizes){
 const calls=[];
 return {calls,async download(key,path){calls.push(key);await writeFile(path,Buffer.alloc(sizes[key]));}};
}
const asset=(bytes,id=randomUUID())=>({id,bytes,object_key:`k/${id}`});
test('a second use of the same asset does not re-download',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const a=asset(10),storage=fake({[`k/${a.id}`]:10}),cache=createCache({root,maxBytes:1000,storage});
 const p1=await cache.ensureLocal(a),p2=await cache.ensureLocal(a);
 assert.equal(p1,p2);assert.equal(storage.calls.length,1);
});
test('a size mismatch re-downloads; a short download fails and leaves nothing behind',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const a=asset(10),storage=fake({[`k/${a.id}`]:10}),cache=createCache({root,maxBytes:1000,storage});
 await writeFile(join(root,`${a.id}.media`),Buffer.alloc(3));
 await cache.ensureLocal(a);assert.equal(storage.calls.length,1);
 const b=asset(10);storage.calls.length=0;
 const short=fake({[`k/${b.id}`]:4});
 await assert.rejects(createCache({root,maxBytes:1000,storage:short}).ensureLocal(b),/expected 10/);
 assert.deepEqual((await readdir(root)).filter(n=>n.startsWith(b.id)),[]);
});
test('eviction drops least-recently-used files but never a pinned one',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const [a,b,c,d]=[asset(40),asset(40),asset(40),asset(40)];
 const storage=fake(Object.fromEntries([a,b,c,d].map(x=>[x.object_key,40])));
 const cache=createCache({root,maxBytes:100,storage});
 const files=async()=>(await readdir(root)).map(n=>n.slice(0,-6)).sort();
 await cache.ensureLocal(a);await cache.ensureLocal(b);
 await utimes(join(root,`${a.id}.media`),new Date(0),new Date(0));
 cache.unpinAll();
 // Next job: c pushes the cache to 120 bytes; the least recently used (a) goes.
 await cache.ensureLocal(c);
 assert.deepEqual(await files(),[b.id,c.id].sort());
 // c is now the oldest file but still pinned by this job, so b goes instead.
 await utimes(join(root,`${c.id}.media`),new Date(0),new Date(0));
 await cache.ensureLocal(d);
 assert.deepEqual(await files(),[c.id,d.id].sort());
});
