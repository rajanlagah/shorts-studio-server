// Project jobs + maintenance against a real Postgres and real ffmpeg, with
// storage faked. Skipped unless TEST_DATABASE_URL is set (see
// api/test/helpers/db.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {enabled,freshDatabase,createUser,fakeStorage,ledgerDrift} from '../../api/test/helpers/db.js';
test('project jobs and maintenance',{skip:!enabled&&'TEST_DATABASE_URL not set'},async t=>{
 const db=await freshDatabase(),temp=await mkdtemp(join(tmpdir(),'worker-jobs-'));
 process.env.DATABASE_URL=db.url;process.env.DATA_DIR=temp;
 const {pool}=await import('../src/common.js');
 const {run}=await import('../src/media.js');
 const {keyFor}=await import('../src/storage.js');
 const {createCache}=await import('../src/cache.js');
 const {createJobs}=await import('../src/jobs.js');
 t.after(async()=>{await pool.end();await db.drop();await rm(temp,{recursive:true,force:true});});
 // Objects "in storage" are local files here.
 const files=new Map(),storage=fakeStorage(keyFor);
 storage.download=async(key,path)=>copyFile(files.get(key),path);
 const cache=createCache({root:join(temp,'cache'),maxBytes:1024**3,storage});
 const jobs=createJobs({storage,cache});
 const video=join(temp,'clip.mp4'),junk=join(temp,'junk.bin');
 await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=320x240:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac','-shortest',video]);
 await writeFile(junk,'not a video at all');
 const {size:videoBytes}=await (await import('node:fs/promises')).stat(video);
 async function project(userId,{updatedAt='now()'}={}){
  const id=randomUUID();
  await pool.query(`insert into shorts.projects(id,user_id,updated_at) values($1,$2,${updatedAt})`,[id,userId]);
  return id;
 }
 // Inserts an asset plus the ledger events that would have produced it.
 async function asset({userId,projectId,file=video,status='ready',kind='source',createdAt='now()',bytes}){
  const id=randomUUID(),key=keyFor({userId,projectId,assetId:id,kind}),n=bytes??(await (await import('node:fs/promises')).stat(file)).size;
  files.set(key,file);storage.objects.set(key,n);
  await pool.query(`insert into shorts.assets(id,user_id,project_id,kind,provider,bucket,object_key,upload_id,declared_bytes,bytes,status,created_at) values($1,$2,$3,$4,'fake','test',$5,$6,$7,$7,$8,${createdAt})`,
   [id,userId,projectId,kind,key,status==='pending'?'up-1':null,n,status]);
  await pool.query("insert into shorts.storage_events(user_id,project_id,asset_id,delta_bytes,holder,reason) values($1,$2,$3,$4,'user','reserve')",[userId,projectId,id,n]);
  return {id,key};
 }
 async function job(userId,projectId,kind,payload){
  const id=randomUUID();
  await pool.query('insert into shorts.jobs(id,kind,payload,project_id,user_id,status) values($1,$2,$3,$4,$5,$6)',[id,kind,JSON.stringify(payload),projectId,userId,'running']);
  const {rows:[j]}=await pool.query('select * from shorts.jobs where id=$1',[id]);
  return j;
 }
 const one=async(sql,params)=>(await pool.query(sql,params)).rows[0];
 const noDrift=async()=>assert.deepEqual(await ledgerDrift(pool),[]);

 await t.test('probe: a real video becomes ready with metadata',async()=>{
  const u=await createUser(pool),p=await project(u.id),a=await asset({userId:u.id,projectId:p,status:'uploaded'});
  const j=await job(u.id,p,'probe',{assetId:a.id});
  await jobs.run(j,{});
  const row=await one('select status,width,height,has_audio,duration from shorts.assets where id=$1',[a.id]);
  assert.equal(row.status,'ready');assert.equal(row.width,320);assert.equal(row.height,240);assert.equal(row.has_audio,true);assert.ok(Number(row.duration)>1.5);
  assert.equal((await one('select status from shorts.jobs where id=$1',[j.id])).status,'completed');
 });
 await t.test('probe: a non-video is removed from storage, failed, and its bytes released',async()=>{
  const u=await createUser(pool),p=await project(u.id),a=await asset({userId:u.id,projectId:p,status:'uploaded',file:junk});
  const j=await job(u.id,p,'probe',{assetId:a.id});
  await jobs.run(j,{});
  assert.equal((await one('select status from shorts.assets where id=$1',[a.id])).status,'failed');
  assert.equal(storage.objects.has(a.key),false);
  assert.equal((await one('select status from shorts.jobs where id=$1',[j.id])).status,'failed');
  await noDrift();
 });
 await t.test('export: output stored, asset + event + exports counter + project status in one go; pushing over the limit starts the grace clock',async()=>{
  const u=await createUser(pool),p=await project(u.id),a=await asset({userId:u.id,projectId:p});
  // Limit just above the source, so the export itself tips the user over.
  await pool.query("insert into shorts.customer_feature_overrides(user_id,feature_key,enabled,config) values($1,'storage_bytes',true,$2)",[u.id,JSON.stringify({limit:videoBytes+10})]);
  await pool.query("update shorts.users set community_sharing=false where id=$1",[u.id]);
  const j=await job(u.id,p,'export',{clips:[{assetId:a.id,start:0,end:1.5,fit:'crop'}],captions:[]});
  await jobs.run(j,{onProgress:async()=>{}});
  const done=await one('select status,result from shorts.jobs where id=$1',[j.id]);
  assert.equal(done.status,'completed');
  const out=await one('select * from shorts.assets where id=$1',[done.result.assetId]);
  assert.equal(out.kind,'export');assert.equal(out.status,'ready');assert.equal(out.job_id,j.id);assert.equal(out.community_shareable,false);
  assert.equal(out.width,1080);assert.equal(out.height,1920);
  assert.equal(storage.objects.get(out.object_key),Number(out.bytes));
  assert.equal((await one("select used from shorts.customer_feature_usage where user_id=$1 and feature_key='exports'",[u.id])).used,1);
  const proj=await one('select status,job_id from shorts.projects where id=$1',[p]);
  assert.equal(proj.status,'completed');assert.equal(proj.job_id,j.id);
  assert.ok((await one('select over_quota_since from shorts.users where id=$1',[u.id])).over_quota_since);
  await noDrift();
 });
 await t.test('export into a deleted project removes the uploaded output',async()=>{
  const u=await createUser(pool),p=await project(u.id),a=await asset({userId:u.id,projectId:p});
  const j=await job(u.id,p,'export',{clips:[{assetId:a.id,start:0,end:1,fit:'fit'}],captions:[]});
  await pool.query("update shorts.projects set holder='internal' where id=$1",[p]);
  const before=new Set(storage.objects.keys());
  await assert.rejects(jobs.run(j,{onProgress:async()=>{}}),/deleted/);
  assert.deepEqual([...storage.objects.keys()].filter(k=>!before.has(k)),[]);
 });
 await t.test('internalization: oldest idle projects first, stops once under the limit',async()=>{
  const u=await createUser(pool);
  const [busy,old,mid,recent]=[await project(u.id,{updatedAt:"now()-interval '4 days'"}),await project(u.id,{updatedAt:"now()-interval '3 days'"}),await project(u.id,{updatedAt:"now()-interval '2 days'"}),await project(u.id)];
  for(const p of [busy,old,mid,recent])await asset({userId:u.id,projectId:p,bytes:100});
  await job(u.id,busy,'export',{clips:[]});
  await pool.query("insert into shorts.customer_feature_overrides(user_id,feature_key,enabled,config) values($1,'storage_bytes',true,'{\"limit\":250}')",[u.id]);
  await pool.query("update shorts.users set over_quota_since=now()-interval '15 days' where id=$1",[u.id]);
  await jobs.internalize();
  const {rows}=await pool.query('select id,holder,retained_at from shorts.projects where user_id=$1',[u.id]);
  const holder=Object.fromEntries(rows.map(r=>[r.id,r.holder]));
  assert.deepEqual([holder[busy],holder[old],holder[mid],holder[recent]],['user','internal','internal','user']);
  const internal=await one("select count(*)::int as n,min(retained_reason) as reason from shorts.assets where user_id=$1 and holder='internal'",[u.id]);
  assert.deepEqual(internal,{n:2,reason:'over_quota'});
  assert.equal((await one('select over_quota_since from shorts.users where id=$1',[u.id])).over_quota_since,null);
  const moved=await one("select sum(delta_bytes)::int as n from shorts.storage_events where user_id=$1 and holder='internal'",[u.id]);
  assert.equal(moved.n,200);
  await noDrift();
 });
 await t.test('grace period: a user over quota for under 14 days keeps everything',async()=>{
  const u=await createUser(pool),p=await project(u.id);
  await asset({userId:u.id,projectId:p,bytes:100});
  await pool.query("insert into shorts.customer_feature_overrides(user_id,feature_key,enabled,config) values($1,'storage_bytes',true,'{\"limit\":50}')",[u.id]);
  await pool.query("update shorts.users set over_quota_since=now()-interval '13 days' where id=$1",[u.id]);
  await jobs.internalize();
  assert.equal((await one('select holder from shorts.projects where id=$1',[p])).holder,'user');
 });
 await t.test('maintenance: unreferenced old sources, abandoned uploads, purge',async()=>{
  const u=await createUser(pool),p=await project(u.id);
  const used=await asset({userId:u.id,projectId:p,createdAt:"now()-interval '25 hours'"});
  const stray=await asset({userId:u.id,projectId:p,createdAt:"now()-interval '25 hours'"});
  const fresh=await asset({userId:u.id,projectId:p});
  const stale=await asset({userId:u.id,projectId:p,status:'pending',createdAt:"now()-interval '25 hours'"});
  await pool.query('update shorts.projects set edit=$2 where id=$1',[p,JSON.stringify({clips:[{assetId:used.id,start:0,end:1,fit:'fit'}],captions:[]})]);
  await jobs.dropUnreferenced();await jobs.abandonUploads();
  const status=async a=>(await one('select status from shorts.assets where id=$1',[a.id])).status;
  assert.deepEqual([await status(used),await status(stray),await status(fresh),await status(stale)],['ready','deleting','ready','failed']);
  await noDrift();
  await jobs.purge();
  assert.equal(await status(stray),'deleted');assert.equal(storage.objects.has(stray.key),false);
  assert.equal(storage.objects.has(used.key),true);
 });
});
