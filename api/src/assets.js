// Project footage and exports in object storage (plan 013). Video bytes never
// pass through the API: the browser uploads parts to presigned URLs and
// downloads from presigned URLs. Quota checks run under userAuth's user-row
// lock, so concurrent requests from one user serialize.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction,uuid,edit} from './common.js';
import {userAuth,getCustomerFeatures,fail} from './users.js';
import {usage,recordEvent,syncOverQuota,markDeleting,COUNTED} from './storage-usage.js';
export const PART_SIZE=16*1024*1024;
const PART_TTL=900,GET_TTL=3600;
const MAX_ASSET_BYTES=2*1024**3;
const MiB=1024**2;
export const createAssetBody=z.object({bytes:z.number().int().min(1).max(MAX_ASSET_BYTES),contentType:z.string().max(100).regex(/^video\/[\w.+-]+$/)}).strict();
export const partsBody=z.object({partNumbers:z.array(z.number().int().min(1).max(10000)).min(1).max(200)}).strict();
export const completeBody=z.object({parts:z.array(z.object({partNumber:z.number().int().min(1).max(10000),etag:z.string().min(1).max(200)}).strict()).min(1).max(10000)}).strict();
export const jobBody=z.object({kind:z.enum(['export','transcribe']),edit:z.unknown()}).strict();
export const partCount=bytes=>Math.ceil(bytes/PART_SIZE);
const mb=n=>`${Math.max(0,n/MiB).toFixed(n<10*MiB?1:0)} MB`;
// Same rule as the frontend's download filename.
export const exportFilename=title=>`${(title||'').replace(/[^\p{L}\p{N}\s_-]/gu,'').trim()||'my-short'}.mp4`;
const storageDenied=message=>Object.assign(fail(403,message),{feature_key:'storage_bytes'});
const serializeAsset=a=>({id:a.id,kind:a.kind,status:a.status,bytes:Number(a.bytes),contentType:a.content_type,duration:a.duration===null?null:Number(a.duration),width:a.width,height:a.height,hasAudio:a.has_audio,createdAt:a.created_at});
async function ownProject(c,user,id){
 const {rows:[p]}=await c.query("select * from shorts.projects where id=$1 and user_id=$2 and holder='user'",[uuid.parse(id),user.id]);
 if(!p)throw fail(404,'Project not found');
 return p;
}
async function ownAsset(c,user,id,{lock=false}={}){
 const {rows:[a]}=await c.query(`select * from shorts.assets where id=$1 and user_id=$2 and holder='user'${lock?' for update':''}`,[uuid.parse(id),user.id]);
 if(!a||a.status==='deleted'||a.status==='deleting')throw fail(404,'File not found');
 return a;
}
const presignAll=async(storage,a,numbers)=>Promise.all(numbers.map(async partNumber=>({partNumber,url:await storage.presignPart(a.object_key,a.upload_id,partNumber,PART_TTL)})));
// Keyed by the bearer token so the limit is per user, not per shared IP.
const perUser=req=>req.headers.authorization||req.ip;
export default async function assets(app,{storage}){
 app.post('/v1/projects/:id/assets',{config:{rateLimit:{max:60,timeWindow:'1 hour'}}},async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const project=await ownProject(c,user,req.params.id);
 const {bytes,contentType}=createAssetBody.parse(req.body||{});
 const u=await usage(c,user.id);
 if(user.over_quota_since)throw storageDenied("You're over your storage limit. Delete clips or exports, or upgrade, to upload more.");
 if(u.limit!==null&&u.used+bytes>u.limit)throw storageDenied(`Not enough storage: this clip needs ${mb(bytes)}, you have ${mb(u.limit-u.used)} left.`);
 const id=randomUUID(),key=storage.keyFor({userId:user.id,projectId:project.id,assetId:id,kind:'source'});
 const uploadId=await storage.createMultipart(key,contentType);
 await c.query('insert into shorts.assets(id,user_id,project_id,kind,provider,bucket,object_key,upload_id,declared_bytes,bytes,content_type) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)',
 [id,user.id,project.id,'source',storage.provider,storage.bucket,key,uploadId,bytes,contentType]);
 await recordEvent(c,{userId:user.id,projectId:project.id,assetId:id,delta:bytes,reason:'reserve'});
 const a={object_key:key,upload_id:uploadId};
 const parts=await presignAll(storage,a,Array.from({length:partCount(bytes)},(_,i)=>i+1));
 reply.code(201);return {asset:{id,status:'pending',bytes},uploadId,partSize:PART_SIZE,parts,expiresAt:new Date(Date.now()+PART_TTL*1000).toISOString()};
 }));
 // Fresh part URLs after expiry or a page reload.
 app.post('/v1/assets/:id/parts',{config:{rateLimit:{max:120,timeWindow:'1 hour',keyGenerator:perUser}}},async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const a=await ownAsset(c,user,req.params.id);
 if(a.status!=='pending')throw fail(409,'This upload is already finished');
 const {partNumbers}=partsBody.parse(req.body||{});
 const n=partCount(Number(a.declared_bytes));
 if(partNumbers.some(p=>p>n))throw fail(400,`This upload has ${n} parts`);
 return {parts:await presignAll(storage,a,[...new Set(partNumbers)]),partSize:PART_SIZE,expiresAt:new Date(Date.now()+PART_TTL*1000).toISOString()};
 }));
 app.post('/v1/assets/:id/complete',async req=>{
 const {parts}=completeBody.parse(req.body||{});
 // Storage calls happen between two short transactions so the user row
 // isn't locked while B2 assembles a large file.
 const a=await transaction(async c=>{
 const user=await userAuth(c,req);
 const a=await ownAsset(c,user,req.params.id);
 if(a.status!=='pending')return a;
 const n=partCount(Number(a.declared_bytes));
 const numbers=parts.map(p=>p.partNumber).sort((x,y)=>x-y);
 if(numbers.length!==n||numbers.some((p,i)=>p!==i+1))throw fail(400,`Send all ${n} parts, numbered 1 to ${n}`);
 return a;
 });
 if(a.status!=='pending')return {asset:serializeAsset(a)};
 // A failed complete is fine if a concurrent /complete already finished it;
 // the object existing is what counts.
 await storage.completeMultipart(a.object_key,a.upload_id,[...parts].sort((x,y)=>x.partNumber-y.partNumber)).catch(()=>{});
 const head=await storage.head(a.object_key);
 if(!head)throw fail(400,'Upload is incomplete; retry the missing parts');
 return transaction(async c=>{
 const user=await userAuth(c,req);
 const {rows:[cur]}=await c.query('select * from shorts.assets where id=$1 and user_id=$2 for update',[a.id,user.id]);
 if(!cur||cur.status!=='pending'){
 if(cur&&['uploaded','ready'].includes(cur.status))return {asset:serializeAsset(cur)};
 throw fail(404,'File not found');
 }
 const declared=Number(cur.declared_bytes);
 if(head.bytes>declared||head.bytes===0){
 await c.query("update shorts.assets set status='failed',upload_id=null where id=$1",[cur.id]);
 await recordEvent(c,{userId:user.id,projectId:cur.project_id,assetId:cur.id,delta:-Number(cur.bytes),reason:'release'});
 // Purge the object after commit; a failed purge is caught by reconcile.
 setImmediate(()=>storage.remove(cur.object_key).catch(e=>req.log.error({assetId:cur.id,message:e.message},'Oversize object purge failed')));
 return {oversize:true};
 }
 await c.query("update shorts.assets set bytes=$2,status='uploaded',upload_id=null where id=$1",[cur.id,head.bytes]);
 await recordEvent(c,{userId:user.id,projectId:cur.project_id,assetId:cur.id,delta:head.bytes-Number(cur.bytes),reason:'verify'});
 await c.query('insert into shorts.jobs(id,kind,payload,project_id,user_id) values($1,$2,$3,$4,$5)',[randomUUID(),'probe',JSON.stringify({assetId:cur.id}),cur.project_id,user.id]);
 const {rows:[done]}=await c.query('select * from shorts.assets where id=$1',[cur.id]);
 return {asset:serializeAsset(done)};
 }).then(r=>{if(r.oversize)throw fail(413,'The uploaded file is larger than declared');return r;});
 });
 app.delete('/v1/assets/:id',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const a=await ownAsset(c,user,req.params.id,{lock:true});
 if(a.status==='failed'){await c.query("update shorts.assets set status='deleting' where id=$1",[a.id]);reply.code(204);return null;}
 if(a.project_id){
 const {rows:[busy]}=await c.query("select 1 from shorts.jobs where project_id=$1 and status in ('queued','running') and kind<>'probe' and payload->'clips' @> $2::jsonb limit 1",[a.project_id,JSON.stringify([{assetId:a.id}])]);
 if(busy)throw fail(409,'This file is being used by an export in progress');
 }
 // The worker aborts a pending multipart upload and purges the object.
 await markDeleting(c,a);
 await syncOverQuota(c,user.id,{set:false});
 reply.code(204);return null;
 }));
 app.get('/v1/assets/:id/url',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const disposition=req.query?.disposition==='attachment'?'attachment':'inline';
 const id=uuid.parse(req.params.id);
 const {rows:[a]}=await c.query('select a.*,p.title from shorts.assets a left join shorts.projects p on p.id=a.project_id where a.id=$1',[id]);
 const visible=a&&(user.is_admin||(a.user_id===user.id&&a.holder==='user'))&&['uploaded','ready'].includes(a.status);
 if(!visible)throw fail(404,'File not found');
 const url=await storage.presignGet(a.object_key,{disposition,filename:a.kind==='export'?exportFilename(a.title):'clip',expiresSec:GET_TTL});
 return {url,expiresAt:new Date(Date.now()+GET_TTL*1000).toISOString()};
 }));
 app.get('/v1/projects/:id/assets',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const p=await ownProject(c,user,req.params.id);
 // failed included so a client can tell a rejected file from footage it never uploaded.
 const {rows}=await c.query("select * from shorts.assets where project_id=$1 and kind='source' and holder='user' and status in ('pending','uploaded','ready','failed') order by created_at",[p.id]);
 return rows.map(serializeAsset);
 }));
 app.get('/v1/projects/:id/exports',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const p=await ownProject(c,user,req.params.id);
 const {rows}=await c.query("select id,job_id,bytes,duration,created_at from shorts.assets where project_id=$1 and kind='export' and holder='user' and status='ready' order by created_at desc",[p.id]);
 return rows.map(r=>({id:r.id,jobId:r.job_id,bytes:Number(r.bytes),duration:r.duration===null?null:Number(r.duration),createdAt:r.created_at}));
 }));
 app.post('/v1/projects/:id/jobs',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const p=await ownProject(c,user,req.params.id);
 const body=jobBody.parse(req.body||{});
 const payload=edit.parse(body.edit);
 const ids=[...new Set(payload.clips.map(x=>x.assetId))];
 const {rows:found}=await c.query("select id from shorts.assets where id=any($1) and project_id=$2 and user_id=$3 and holder='user' and status in ('uploaded','ready')",[ids,p.id,user.id]);
 if(found.length!==ids.length)throw fail(400,'Some clips are not uploaded yet');
 const features=await getCustomerFeatures(c,user.id);
 if(body.kind==='transcribe'&&!features.auto_caption.enabled)throw Object.assign(fail(403,'Auto captions are not available on your plan.'),{feature_key:'auto_caption'});
 if(features.max_shorts.limit!==null&&payload.clips.length>features.max_shorts.limit)
 throw Object.assign(fail(403,`Your plan allows up to ${features.max_shorts.limit} shorts per project.`),{feature_key:'max_shorts'});
 const duration=payload.clips.reduce((n,x)=>n+x.end-x.start,0);
 if(features.max_duration.limit!==null&&duration>features.max_duration.limit)
 throw Object.assign(fail(403,`Your plan allows up to ${features.max_duration.limit} seconds per export.`),{feature_key:'max_duration'});
 if(body.kind==='export'){
 if(!features.exports.enabled)throw Object.assign(fail(403,'Exporting is disabled for your plan.'),{feature_key:'exports'});
 if(features.exports.limit!==null&&features.exports.used>=features.exports.limit)
 throw Object.assign(fail(403,'No exports remaining this month. Upgrade to continue.'),{feature_key:'exports'});
 // The export itself is counted after the fact, so one export can push a
 // user slightly over; the worker then starts the grace clock.
 const u=await usage(c,user.id);
 if(user.over_quota_since||(u.limit!==null&&u.used>=u.limit))throw storageDenied('Your storage is full. Delete clips or old exports, or upgrade, to export.');
 }
 // Serialize queue admission; probes are quick and don't count.
 await c.query('select pg_advisory_xact_lock(784322)');
 const {rows:[n]}=await c.query("select count(*) filter(where status in ('queued','running') and kind<>'probe') as active,count(*) filter(where user_id=$1 and status in ('queued','running') and kind<>'probe') as busy from shorts.jobs",[user.id]);
 if(Number(n.active)>=20)throw fail(429,'Server busy; try again in a few minutes');
 if(Number(n.busy)>0)throw fail(429,'You already have an export or caption job running');
 const id=randomUUID();
 await c.query('insert into shorts.jobs(id,kind,payload,project_id,user_id) values($1,$2,$3,$4,$5)',[id,body.kind,JSON.stringify(payload),p.id,user.id]);
 if(body.kind==='export')await c.query("update shorts.projects set status='processing',job_id=$2,updated_at=now() where id=$1",[p.id,id]);
 reply.code(202);return {id,status:'queued'};
 }));
 app.get('/v1/projects/:id/jobs/:job',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const p=await ownProject(c,user,req.params.id);
 const {rows:[job]}=await c.query("select id,kind,status,progress,result,error,created_at,finished_at from shorts.jobs where id=$1 and project_id=$2 and kind<>'probe'",[uuid.parse(req.params.job),p.id]);
 if(!job)throw fail(404,'Job not found');
 return job;
 }));
}
