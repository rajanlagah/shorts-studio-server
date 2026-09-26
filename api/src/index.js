import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,rm,stat,statfs} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {pool,transaction,dataDir,dir,assetPath,uuid,edit} from './common.js';
import users, {getCustomerFeatures,errorHandler} from './users.js';
import assets from './assets.js';
import {createStorage} from './storage.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const app=Fastify({logger:{redact:['req.headers.authorization']},bodyLimit:1024*1024,requestTimeout:120000,trustProxy:process.env.TRUST_PROXY==='true' ? 1 : false});
await mkdir(dataDir,{recursive:true});
// Registered before any plugin/route registration: Fastify freezes a child
// encapsulated context's inherited error handler at registration time, so
// setting this after `app.register(users)` would silently leave every route
// in users.js on Fastify's default {statusCode,error,message} error shape.
app.setErrorHandler(errorHandler);
await app.register(cors,{origin:(process.env.CORS_ORIGINS||'http://localhost:3000').split(','),methods:['GET','POST','PATCH','DELETE'],allowedHeaders:['Content-Type','Authorization']});
app.addHook('onSend',async(req,reply,payload)=>{if(!reply.hasHeader('Cache-Control'))reply.header('Cache-Control','no-store');return payload;});
await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
await app.register(multipart,{limits:{files:1,fields:0,fileSize:500*1024*1024,parts:1}});
await app.register(users);
await app.register(assets,{storage:createStorage()});
async function session(c,req){
 const id=uuid.parse(req.params.id);
 const {rows:[s]}=await c.query('select * from shorts.sessions where id=$1 for update',[id]);
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 if(!s || !timingSafeEqual(Buffer.from(hash(token)),Buffer.from(s.token_hash)))throw fail(404,'Session not found');
 if(new Date(s.expires_at)<new Date())throw fail(410,'Session expired');
 return s;
}
app.get('/health',async()=>({ok:true}));
app.get('/ready',async()=>{await pool.query('select 1');return {ok:true};});
app.post('/v1/sessions',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async(req,reply)=>{
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 if(!token)throw fail(401,'Missing token');
 const {rows:[tokenRow]}=await pool.query('select user_id from shorts.user_tokens where token_hash=$1 and expires_at>now()',[hash(token)]);
 if(!tokenRow)throw fail(401,'Invalid or expired token');
 const id=randomUUID(),sessionToken=randomBytes(32).toString('hex');
 await transaction(async c=>{
 await c.query('select pg_advisory_xact_lock(784321)');
 const {rows:[{count}]}=await c.query('select count(*) from shorts.sessions');
 if(Number(count)>=20)throw fail(503,'Server busy; try later');
 await c.query('insert into shorts.sessions(id,token_hash,user_id) values($1,$2,$3)',[id,hash(sessionToken),tokenRow.user_id]);
 });
 return reply.code(201).send({id,token:sessionToken,expiresInSeconds:7200});
});
app.post('/v1/sessions/:id/assets',async(req,reply)=>transaction(async c=>{
 const s=await session(c,req);
 if(s.assets.length>=5)throw fail(400,'Maximum 5 uploads per session');
 const fs=await statfs(dataDir);if(fs.bavail*fs.bsize<2*1024**3)throw fail(503,'Insufficient disk space');
 const file=await req.file();if(!file)throw fail(400,'One video file is required');
 const id=randomUUID(),path=assetPath(s.id,id);await mkdir(dir(s.id),{recursive:true});
 try{
 await pipeline(file.file,createWriteStream(path,{flags:'wx'}));
 if(file.file.truncated)throw fail(413,'File too large');
 const {size}=await stat(path);
 if(size===0 || s.assets.reduce((n,a)=>n+a.bytes,0)+size>500*1024*1024)throw fail(413,'Session limit is 500 MiB');
 const asset={id,bytes:size};
 await c.query("update shorts.sessions set assets=$2,expires_at=now()+interval '2 hours' where id=$1",[s.id,JSON.stringify([...s.assets,asset])]);
 return reply.code(201).send(asset);
 }catch(e){await rm(path,{force:true});throw e;}
}));
app.post('/v1/sessions/:id/jobs',async(req,reply)=>transaction(async c=>{
 const s=await session(c,req);
 const kind=req.body?.kind;if(!['export','transcribe'].includes(kind))throw fail(400,'kind must be export or transcribe');
 if(kind==='transcribe'){
 const features=await getCustomerFeatures(c,s.user_id);
 if(!features.auto_caption.enabled)throw Object.assign(fail(403,'Auto captions are not available on your plan.'),{feature_key:'auto_caption'});
 }
 const payload=edit.parse(req.body?.edit);
 if(payload.clips.some(x=>!s.assets.some(a=>a.id===x.assetId)))throw fail(400,'Unknown asset');
 // Serialize queue admission, cap global outstanding work and per-session tasks.
 await c.query('select pg_advisory_xact_lock(784322)');
 const {rows:[n]}=await c.query("select count(*) filter(where status in ('queued','running')) as active,count(*) filter(where session_id=$1) as own,count(*) filter(where session_id=$1 and status in ('queued','running')) as busy from shorts.jobs",[s.id]);
 if(Number(n.active)>=20 || Number(n.own)>=10 || Number(n.busy)>0)throw fail(429,'Queue or session job limit reached');
 const id=randomUUID();await c.query('insert into shorts.jobs(id,session_id,kind,payload) values($1,$2,$3,$4)',[id,s.id,kind,JSON.stringify(payload)]);
 await c.query("update shorts.sessions set expires_at=now()+interval '2 hours' where id=$1",[s.id]);
 return reply.code(202).send({id,status:'queued'});
}));
app.get('/v1/sessions/:id/jobs/:job',async(req)=>transaction(async c=>{
 const s=await session(c,req);const {rows:[job]}=await c.query('select id,kind,status,progress,result,error,created_at,finished_at from shorts.jobs where id=$1 and session_id=$2',[uuid.parse(req.params.job),s.id]);
 if(!job)throw fail(404,'Job not found');return {...job,expiresAt:s.expires_at};
}));
app.get('/v1/sessions/:id/jobs/:job/download',async(req,reply)=>{
 const path=await transaction(async c=>{
 const s=await session(c,req);const job=uuid.parse(req.params.job);
 const {rows:[j]}=await c.query("select id from shorts.jobs where id=$1 and session_id=$2 and kind='export' and status='completed'",[job,s.id]);
 if(!j)throw fail(404,'Export unavailable');
 // Give a download attempt time to finish; do not delete on first download.
 await c.query("update shorts.sessions set expires_at=greatest(expires_at,now()+interval '15 minutes') where id=$1",[s.id]);
 return join(dir(s.id),job,'output.mp4');
 });
 reply.header('Content-Disposition','attachment; filename="short.mp4"').header('Cache-Control','no-store').type('video/mp4');return reply.send(createReadStream(path));
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();await pool.end();process.exit(0);});
await app.listen({port:Number(process.env.PORT||3001),host:process.env.HOST||'0.0.0.0'});
