// Upload/quota/ledger behaviour against a real Postgres with storage faked.
// Skipped unless TEST_DATABASE_URL is set (see test/helpers/db.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {enabled,freshDatabase,createUser,fakeStorage,ledgerDrift,PLAN} from './helpers/db.js';
const MiB=1024**2,GiB=1024**3;
// src modules are imported inside the test: common.js opens its pool from
// DATABASE_URL at import time, which is set to the fresh database first.
test('storage API',{skip:!enabled&&'TEST_DATABASE_URL not set'},async t=>{
 const db=await freshDatabase();
 process.env.DATABASE_URL=db.url;
 const {default:Fastify}=await import('fastify');
 const {pool}=await import('../src/common.js');
 const {default:users,errorHandler}=await import('../src/users.js');
 const {default:assets,PART_SIZE}=await import('../src/assets.js');
 const {keyFor}=await import('../src/storage.js');
 const storage=fakeStorage(keyFor);
 const app=Fastify();app.setErrorHandler(errorHandler);
 await app.register(users);await app.register(assets,{storage});
 t.after(async()=>{await app.close();await pool.end();await db.drop();});
 const call=async(user,method,url,payload)=>{const r=await app.inject({method,url,payload,headers:user?{authorization:`Bearer ${user.token}`}:{}});return {status:r.statusCode,body:r.body?JSON.parse(r.body):null};};
 const project=async user=>(await call(user,'POST','/v1/projects',{title:'Trip ✈ day!'})).body.id;
 // Full browser flow: intent → PUT parts → complete. `actual` defaults to declared.
 async function upload(user,projectId,bytes,actual=bytes){
  const r=await call(user,'POST',`/v1/projects/${projectId}/assets`,{bytes,contentType:'video/mp4'});
  if(r.status!==201)return r;
  // Full parts, with whatever is left (more or less than declared) in the last.
  const last=r.body.parts.length-1;
  const parts=r.body.parts.map((p,i)=>({partNumber:p.partNumber,etag:storage.putPart(r.body.uploadId,p.partNumber,i<last?PART_SIZE:actual-last*PART_SIZE)}));
  const done=await call(user,'POST',`/v1/assets/${r.body.asset.id}/complete`,{parts});
  return {...done,id:r.body.asset.id};
 }
 const edit=(assetId)=>({clips:[{assetId,start:0,end:5,fit:'fit'}],captions:[]});
 const noDrift=async()=>assert.deepEqual(await ledgerDrift(pool),[]);

 await t.test('Free: 499 MiB used + 2 MiB upload is refused with storage_bytes',async()=>{
  const u=await createUser(pool),p=await project(u);
  assert.equal((await upload(u,p,499*MiB)).status,200);
  const r=await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:2*MiB,contentType:'video/mp4'});
  assert.equal(r.status,403);assert.equal(r.body.featureKey,'storage_bytes');
  assert.match(r.body.error,/needs 2\.0 MB, you have 1\.0 MB left/);
  const me=await call(u,'GET','/v1/me');
  assert.deepEqual(me.body.storage,{used:499*MiB,limit:524288000});
  assert.deepEqual(me.body.settings,{communitySharing:true});
  assert.equal(me.body.overQuotaSince,null);
  const list=await call(u,'GET','/v1/projects');assert.equal(list.body[0].bytes,499*MiB);
  await noDrift();
 });
 await t.test('Pro: a 1.5 GiB upload fits',async()=>{
  const u=await createUser(pool,{plan:'pro'}),p=await project(u);
  assert.equal((await upload(u,p,1.5*GiB)).status,200);
  await noDrift();
 });
 await t.test('two concurrent intents that fit alone but not together: exactly one 201',async()=>{
  const u=await createUser(pool),p=await project(u);
  const rs=await Promise.all([1,2].map(()=>call(u,'POST',`/v1/projects/${p}/assets`,{bytes:300*MiB,contentType:'video/mp4'})));
  assert.deepEqual(rs.map(r=>r.status).sort(),[201,403]);
  await noDrift();
 });
 await t.test('complete: bigger than declared → 413, failed, reservation released; smaller shrinks',async()=>{
  const u=await createUser(pool),p=await project(u);
  const big=await upload(u,p,10*MiB,11*MiB);
  assert.equal(big.status,413);
  const {rows:[a]}=await pool.query('select status from shorts.assets where id=$1',[big.id]);assert.equal(a.status,'failed');
  assert.equal((await call(u,'GET','/v1/me')).body.storage.used,0);
  const small=await upload(u,p,10*MiB,4*MiB);
  assert.equal(small.status,200);assert.equal(small.body.asset.bytes,4*MiB);assert.equal(small.body.asset.status,'uploaded');
  assert.equal((await call(u,'GET','/v1/me')).body.storage.used,4*MiB);
  const {rows:probes}=await pool.query("select payload from shorts.jobs where kind='probe' and user_id=$1",[u.id]);
  assert.deepEqual(probes.map(j=>j.payload.assetId),[small.id]);
  // Completing twice is harmless.
  assert.equal((await call(u,'POST',`/v1/assets/${small.id}/complete`,{parts:[{partNumber:1,etag:'x'}]})).status,200);
  await noDrift();
 });
 await t.test('complete requires every part',async()=>{
  const u=await createUser(pool),p=await project(u);
  const r=await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:40*MiB,contentType:'video/mp4'});
  assert.equal(r.body.parts.length,3);
  assert.equal((await call(u,'POST',`/v1/assets/${r.body.asset.id}/complete`,{parts:[{partNumber:1,etag:'a'},{partNumber:3,etag:'c'}]})).status,400);
  const fresh=await call(u,'POST',`/v1/assets/${r.body.asset.id}/parts`,{partNumbers:[2,3]});
  assert.equal(fresh.status,200);assert.deepEqual(fresh.body.parts.map(x=>x.partNumber),[2,3]);
  assert.equal((await call(u,'POST',`/v1/assets/${r.body.asset.id}/parts`,{partNumbers:[4]})).status,400);
  const other=await createUser(pool);
  assert.equal((await call(other,'POST',`/v1/assets/${r.body.asset.id}/parts`,{partNumbers:[1]})).status,404);
 });
 await t.test('delete frees quota at once; an asset used by an active export → 409',async()=>{
  const u=await createUser(pool),p=await project(u);
  const a=await upload(u,p,20*MiB),b=await upload(u,p,30*MiB);
  const job=await call(u,'POST',`/v1/projects/${p}/jobs`,{kind:'export',edit:edit(a.id)});
  assert.equal(job.status,202);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/jobs`,{kind:'export',edit:edit(b.id)})).status,429);
  assert.equal((await call(u,'DELETE',`/v1/assets/${a.id}`)).status,409);
  assert.equal((await call(u,'DELETE',`/v1/assets/${b.id}`)).status,204);
  assert.equal((await call(u,'GET','/v1/me')).body.storage.used,20*MiB);
  assert.equal((await call(u,'GET',`/v1/assets/${b.id}/url`)).status,404);
  const url=await call(u,'GET',`/v1/assets/${a.id}/url?disposition=inline`);assert.equal(url.status,200);assert.ok(url.body.expiresAt);
  const st=await call(u,'GET',`/v1/projects/${p}/jobs/${job.body.id}`);assert.equal(st.body.status,'queued');
  await noDrift();
 });
 await t.test('jobs: clips must be uploaded assets of this project; transcribe needs auto_caption',async()=>{
  const u=await createUser(pool),p=await project(u),q=await project(u);
  const a=await upload(u,q,5*MiB);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/jobs`,{kind:'export',edit:edit(a.id)})).status,400);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/jobs`,{kind:'export',edit:edit(randomUUID())})).status,400);
  const tr=await call(u,'POST',`/v1/projects/${q}/jobs`,{kind:'transcribe',edit:edit(a.id)});
  assert.equal(tr.status,403);assert.equal(tr.body.featureKey,'auto_caption');
 });
 await t.test('project delete marks its footage deleting and frees quota',async()=>{
  const u=await createUser(pool),p=await project(u);
  const a=await upload(u,p,50*MiB);
  assert.equal((await call(u,'DELETE',`/v1/projects/${p}`)).status,204);
  const {rows:[row]}=await pool.query('select status,project_id,object_key from shorts.assets where id=$1',[a.id]);
  assert.equal(row.status,'deleting');assert.equal(row.project_id,null);assert.ok(row.object_key);
  assert.equal((await call(u,'GET','/v1/me')).body.storage.used,0);
  await noDrift();
 });
 await t.test('downgrade over the limit starts the grace clock and blocks uploads and exports; deleting clears it',async()=>{
  const admin=await createUser(pool,{admin:true}),u=await createUser(pool,{plan:'pro'}),p=await project(u);
  const a=await upload(u,p,400*MiB),b=await upload(u,p,300*MiB);
  const down=await call(admin,'PATCH',`/v1/admin/customers/${u.id}/plan`,{planId:PLAN.free});
  assert.equal(down.status,200);assert.ok(down.body.overQuotaSince);assert.equal(down.body.storage.used,700*MiB);
  const up=await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:MiB,contentType:'video/mp4'});
  assert.equal(up.status,403);assert.equal(up.body.featureKey,'storage_bytes');
  const ex=await call(u,'POST',`/v1/projects/${p}/jobs`,{kind:'export',edit:edit(a.id)});
  assert.equal(ex.status,403);assert.equal(ex.body.featureKey,'storage_bytes');
  assert.equal((await call(u,'DELETE',`/v1/assets/${b.id}`)).status,204);
  assert.equal((await call(u,'GET','/v1/me')).body.overQuotaSince,null);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:MiB,contentType:'video/mp4'})).status,201);
  const report=await call(admin,'GET','/v1/admin/storage');
  assert.equal(report.status,200);assert.ok(report.body.userHeld.bytes>=400*MiB);
  const per=await call(admin,'GET',`/v1/admin/customers/${u.id}/storage`);
  assert.equal(per.body.projects[0].sources,2); // a + the pending 1 MiB upload
  assert.equal((await call(u,'GET','/v1/admin/storage')).status,403);
  await noDrift();
 });
 await t.test('community setting: Free cannot opt out; Pro opt-out is retroactive; downgrade re-enables',async()=>{
  const admin=await createUser(pool,{admin:true});
  const free=await createUser(pool);
  const r=await call(free,'PATCH','/v1/me/settings',{communitySharing:false});
  assert.equal(r.status,403);assert.equal(r.body.featureKey,'community_opt_out');
  const pro=await createUser(pool,{plan:'pro'}),p=await project(pro);
  const exportId=randomUUID();
  await pool.query("insert into shorts.assets(id,user_id,project_id,kind,provider,bucket,object_key,declared_bytes,bytes,status,community_shareable) values($1,$2,$3,'export','fake','test',$4,1,1,'ready',true)",[exportId,pro.id,p,`x/${exportId}`]);
  await pool.query("insert into shorts.storage_events(user_id,project_id,asset_id,delta_bytes,holder,reason) values($1,$2,$3,1,'user','verify')",[pro.id,p,exportId]);
  const ok=await call(pro,'PATCH','/v1/me/settings',{communitySharing:false});
  assert.equal(ok.status,200);assert.equal(ok.body.settings.communitySharing,false);
  const {rows:[e]}=await pool.query('select community_shareable from shorts.assets where id=$1',[exportId]);assert.equal(e.community_shareable,false);
  const list=await call(pro,'GET',`/v1/projects/${p}/exports`);
  assert.deepEqual(list.body.map(x=>x.id),[exportId]);
  const dl=await call(pro,'GET',`/v1/assets/${exportId}/url?disposition=attachment`);
  assert.match(dl.body.url,/d=attachment&f=Trip%20%20day\.mp4/);
  await call(admin,'PATCH',`/v1/admin/customers/${pro.id}/plan`,{planId:PLAN.free});
  assert.equal((await call(pro,'GET','/v1/me')).body.settings.communitySharing,true);
  await noDrift();
 });
 await t.test('internalized projects are hidden from the user',async()=>{
  const u=await createUser(pool),p=await project(u);
  await pool.query("update shorts.projects set holder='internal' where id=$1",[p]);
  assert.equal((await call(u,'GET',`/v1/projects/${p}`)).status,404);
  assert.deepEqual((await call(u,'GET','/v1/projects')).body,[]);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:MiB,contentType:'video/mp4'})).status,404);
 });
 await t.test('validation: only video content types, bounded sizes',async()=>{
  const u=await createUser(pool),p=await project(u);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:MiB,contentType:'text/html'})).status,400);
  assert.equal((await call(u,'POST',`/v1/projects/${p}/assets`,{bytes:3*GiB,contentType:'video/mp4'})).status,400);
  assert.equal((await call(null,'POST',`/v1/projects/${p}/assets`,{bytes:MiB,contentType:'video/mp4'})).status,401);
 });
});
