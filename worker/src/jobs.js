// Project-scoped jobs (plan 013): footage comes from object storage through
// the local cache, exports go back to object storage. Legacy session jobs
// stay in index.js until the session endpoints are removed.
import {rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pool,transaction,dataDir} from './common.js';
import {exportVideo,transcribe,probe} from './media.js';
import {recordEvent,syncOverQuota,usage,markDeleting,COUNTED} from './storage-usage.js';
export const GRACE_DAYS=14;
export function createJobs({storage,cache}){
 async function sourceAssets(job,signal){
  const ids=[...new Set(job.payload.clips.map(c=>c.assetId))];
  const {rows}=await pool.query("select * from shorts.assets where id=any($1) and project_id=$2 and status in ('uploaded','ready')",[ids,job.project_id]);
  if(rows.length!==ids.length)throw new Error('A clip used by this job was deleted');
  const byId=new Map(rows.map(a=>[a.id,a]));
  return id=>cache.ensureLocal(byId.get(id),signal);
 }
 async function runProbe(job,signal){
  const {rows:[a]}=await pool.query('select * from shorts.assets where id=$1',[job.payload.assetId]);
  if(a?.status==='uploaded'){
   // Download failures are ours, not the user's: fail the job, keep the file.
   const path=await cache.ensureLocal(a,signal);
   let meta;
   try{meta=await probe(path,signal);}
   catch(e){
    if(signal?.aborted)throw e;
    const released=await transaction(async c=>{
     const {rows:[cur]}=await c.query("update shorts.assets set status='failed' where id=$1 and status='uploaded' returning *",[a.id]);
     if(cur)await recordEvent(c,{userId:cur.user_id,projectId:cur.project_id,assetId:cur.id,delta:-Number(cur.bytes),reason:'release'});
     await c.query("update shorts.jobs set status='failed',error=$2,finished_at=now() where id=$1",[job.id,'Not a supported video file']);
     return cur;
    });
    if(released){await storage.remove(a.object_key);await cache.drop(a.id);}
    return;
   }
   await pool.query("update shorts.assets set duration=$2,width=$3,height=$4,has_audio=$5,status='ready',ready_at=now() where id=$1 and status='uploaded'",[a.id,meta.duration,meta.width,meta.height,meta.audio]);
  }
  await pool.query("update shorts.jobs set status='completed',progress=100,finished_at=now() where id=$1",[job.id]);
 }
 async function runExport(job,{signal,onProgress}){
  const work=join(dataDir,'work',job.id);
  try{
   await exportVideo(await sourceAssets(job,signal),job.payload,work,{signal,onProgress});
   const output=join(work,'output.mp4');
   const {size}=await stat(output),meta=await probe(output,signal);
   const assetId=randomUUID(),key=storage.keyFor({userId:job.user_id,projectId:job.project_id,assetId,kind:'export'});
   await storage.upload(output,key,'video/mp4');
   try{
    await transaction(async c=>{
     const {rows:[user]}=await c.query('select community_sharing from shorts.users where id=$1 for update',[job.user_id]);
     const {rows:[project]}=await c.query("select id from shorts.projects where id=$1 and holder='user' for update",[job.project_id]);
     if(!project)throw new Error('Project was deleted during export');
     await c.query(`insert into shorts.assets(id,user_id,project_id,kind,provider,bucket,object_key,declared_bytes,bytes,content_type,status,community_shareable,job_id,duration,width,height,has_audio,ready_at)
      values($1,$2,$3,'export',$4,$5,$6,$7,$7,'video/mp4','ready',$8,$9,$10,$11,$12,$13,now())`,
      [assetId,job.user_id,job.project_id,storage.provider,storage.bucket,key,size,user.community_sharing,job.id,meta.duration,meta.width,meta.height,meta.audio]);
     await recordEvent(c,{userId:job.user_id,projectId:job.project_id,assetId,delta:size,reason:'verify'});
     await c.query("update shorts.jobs set status='completed',progress=100,result=$2,finished_at=now() where id=$1",[job.id,JSON.stringify({assetId})]);
     // Charged on completion, server-side (replaces POST /v1/projects/:id/sync).
     await c.query(`insert into shorts.customer_feature_usage(user_id,feature_key,used,reset_at) values($1,'exports',1,now()+interval '1 month')
      on conflict(user_id,feature_key) do update set
       used=case when customer_feature_usage.reset_at<now() then 1 else customer_feature_usage.used+1 end,
       reset_at=case when customer_feature_usage.reset_at<now() then now()+interval '1 month' else customer_feature_usage.reset_at end`,[job.user_id]);
     await c.query("update shorts.projects set status='completed',job_id=$2,build_charged=true,updated_at=now() where id=$1",[job.project_id,job.id]);
     // One export may push a user over; start the grace clock.
     await syncOverQuota(c,job.user_id,{clear:false});
    });
   }catch(e){await storage.remove(key).catch(()=>{});throw e;}
  }finally{await rm(work,{recursive:true,force:true});cache.unpinAll();}
 }
 async function runTranscribe(job,{signal,onProgress}){
  const work=join(dataDir,'work',job.id);
  try{
   const result=await transcribe(await sourceAssets(job,signal),job.payload,work,{signal,onProgress});
   await pool.query("update shorts.jobs set status='completed',progress=100,result=$2,finished_at=now() where id=$1",[job.id,JSON.stringify(result)]);
  }finally{await rm(work,{recursive:true,force:true});cache.unpinAll();}
 }
 async function run(job,options){
  if(job.kind==='probe')return runProbe(job,options.signal).finally(()=>cache.unpinAll());
  if(job.kind==='export')return runExport(job,options);
  return runTranscribe(job,options);
 }
 async function failed(job,message){
  await pool.query("update shorts.jobs set status='failed',error=$2,finished_at=now() where id=$1 and status<>'completed'",[job.id,message]);
  if(job.kind==='export')await pool.query("update shorts.projects set status='failed',updated_at=now() where id=$1 and job_id=$2",[job.project_id,job.id]);
 }
 // --- Maintenance (every few minutes, not per job) ---
 async function purge(){
  const {rows}=await pool.query("select * from shorts.assets where status='deleting' order by created_at limit 200");
  for(const a of rows){
   try{
    if(a.upload_id)await storage.abortMultipart(a.object_key,a.upload_id);
    await storage.remove(a.object_key);
    await cache.drop(a.id);
    await pool.query("update shorts.assets set status='deleted',upload_id=null,deleted_at=now() where id=$1 and status='deleting'",[a.id]);
   }catch(e){console.error(JSON.stringify({assetId:a.id,error:`purge: ${e.message}`}));}
  }
 }
 async function abandonUploads(){
  const {rows}=await pool.query("select * from shorts.assets where status='pending' and created_at<now()-interval '24 hours' limit 200");
  for(const a of rows){
   try{
    await storage.abortMultipart(a.object_key,a.upload_id);
    await transaction(async c=>{
     const {rows:[cur]}=await c.query("update shorts.assets set status='failed',upload_id=null where id=$1 and status='pending' returning *",[a.id]);
     if(cur)await recordEvent(c,{userId:cur.user_id,projectId:cur.project_id,assetId:cur.id,delta:-Number(cur.bytes),holder:cur.holder,reason:'release'});
    });
   }catch(e){console.error(JSON.stringify({assetId:a.id,error:`abandon: ${e.message}`}));}
  }
 }
 // Sources no clip points at anymore (removed from the edit, or uploaded and
 // never used). The 24 h grace covers undo and autosave lag.
 async function dropUnreferenced(){
  await transaction(async c=>{
   const {rows}=await c.query(`select a.* from shorts.assets a join shorts.projects p on p.id=a.project_id
    where a.kind='source' and a.holder='user' and a.status in ('uploaded','ready') and a.created_at<now()-interval '24 hours'
    and not exists(select 1 from jsonb_array_elements(coalesce(p.edit->'clips','[]'::jsonb)) cl where cl->>'assetId'=a.id::text)
    and not exists(select 1 from shorts.jobs j where j.project_id=a.project_id and j.status in ('queued','running'))
    for update of a skip locked limit 200`);
   for(const a of rows)await markDeleting(c,a);
  });
 }
 // Plan 013 decision 7: after the grace period, move a user's oldest projects
 // (sources + exports) off their quota into internal retention.
 async function internalize(){
  const {rows:users}=await pool.query(`select id from shorts.users where over_quota_since<now()-interval '${GRACE_DAYS} days'`);
  for(const {id:userId} of users){
   await transaction(async c=>{
    await c.query('select id from shorts.users where id=$1 for update',[userId]);
    let u=await usage(c,userId);
    if(u.overQuota){
     const {rows:projects}=await c.query(`select p.id from shorts.projects p where p.user_id=$1 and p.holder='user'
      and not exists(select 1 from shorts.jobs j where j.project_id=p.id and j.status in ('queued','running'))
      order by p.updated_at for update`,[userId]);
     for(const p of projects){
      const {rows:assets}=await c.query("update shorts.assets set holder='internal',retained_reason='over_quota',retained_at=now() where project_id=$1 and holder='user' and status=any($2) returning *",[p.id,COUNTED]);
      for(const a of assets){
       await recordEvent(c,{userId,projectId:p.id,assetId:a.id,delta:-Number(a.bytes),holder:'user',reason:'internalize'});
       await recordEvent(c,{userId,projectId:p.id,assetId:a.id,delta:Number(a.bytes),holder:'internal',reason:'internalize'});
      }
      await c.query("update shorts.projects set holder='internal',retained_at=now() where id=$1",[p.id]);
      u=await usage(c,userId);
      if(!u.overQuota)break;
     }
    }
    await syncOverQuota(c,userId,{set:false});
   });
  }
 }
 async function clearStaleOverQuota(){
  const {rows}=await pool.query('select id from shorts.users where over_quota_since is not null');
  for(const {id} of rows)await transaction(c=>syncOverQuota(c,id,{set:false}));
 }
 async function maintenance(){
  for(const step of [purge,abandonUploads,dropUnreferenced,internalize,clearStaleOverQuota]){
   try{await step();}catch(e){console.error(JSON.stringify({error:`${step.name}: ${e.message}`}));}
  }
 }
 return {run,failed,maintenance,purge,abandonUploads,dropUnreferenced,internalize,clearStaleOverQuota};
}
