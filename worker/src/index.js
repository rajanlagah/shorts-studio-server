import {mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pool,transaction,dataDir,dir,assetPath} from './common.js';
import {exportVideo,transcribe} from './media.js';
import {createStorage} from './storage.js';
import {createCache} from './cache.js';
import {createJobs} from './jobs.js';
const controller=new AbortController();let stopping=false;
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopping=true;controller.abort();});
await mkdir(dataDir,{recursive:true});
const storage=createStorage();
const cache=createCache({root:join(dataDir,'cache'),maxBytes:Number(process.env.CACHE_MAX_BYTES||20*1024**3),storage});
const jobs=createJobs({storage,cache});
// Session advisory lock intentionally uses a dedicated PostgreSQL connection.
// Use Supabase DIRECT or SESSION pooler, never transaction pooler.
const lock=await pool.connect();
lock.on('error',()=>{controller.abort();process.exit(1);});
const {rows:[{locked}]}=await lock.query('select pg_try_advisory_lock(784323) as locked');
// Legacy session uploads live on this disk, and the footage cache and job
// queue assume one consumer; scaling out is a separate change.
if(!locked)throw new Error('Only one worker is allowed (shared local disk and footage cache)');
// A probe only reads metadata; rerun it rather than failing the upload.
await pool.query("update shorts.jobs set status='queued',progress=0 where status='running' and kind='probe'");
await pool.query("update shorts.projects p set status='failed' from shorts.jobs j where j.status='running' and j.kind='export' and j.project_id=p.id and p.job_id=j.id");
await pool.query("update shorts.jobs set status='failed',error='Worker restarted; submit a new job',finished_at=now() where status='running'");
await cache.sweep();
await rm(join(dataDir,'work'),{recursive:true,force:true});
async function cleanup(){
 await transaction(async c=>{
 const {rows}=await c.query("select s.id from shorts.sessions s where expires_at<now() and not exists(select 1 from shorts.jobs j where j.session_id=s.id and j.status in ('queued','running')) for update of s skip locked");
 for(const s of rows){await rm(dir(s.id),{recursive:true,force:true});await c.query('delete from shorts.sessions where id=$1',[s.id]);}
 });
}
const FAILED='Processing failed. Check the video format, trim times, or worker logs; then submit a new job.';
async function runSessionJob(job,signal,onProgress){
 const work=join(dir(job.session_id),job.id);
 try{
 const result=await (job.kind==='export'?exportVideo:transcribe)(id=>assetPath(job.session_id,id),job.payload,work,{signal,onProgress});
 // Delete intermediates, retain only finished MP4 until session expiry.
 for(const file of await readdir(work)){if(job.kind!=='export'||file!=='output.mp4')await rm(join(work,file),{force:true});}
 await transaction(async c=>{
 await c.query("update shorts.sessions set expires_at=now()+interval '1 hour' where id=$1",[job.session_id]);
 await c.query("update shorts.jobs set status='completed',progress=100,result=$2,finished_at=now() where id=$1",[job.id,JSON.stringify(result)]);
 });
 }catch(e){await rm(work,{recursive:true,force:true});throw e;}
}
const MAINTENANCE_MS=5*60*1000;
let lastMaintenance=0;
try{
 while(!stopping){
 try{
 await cleanup();
 if(storage.configured&&Date.now()-lastMaintenance>MAINTENANCE_MS){lastMaintenance=Date.now();await jobs.maintenance();}
 const job=await transaction(async c=>{
 // Probes are seconds long; don't queue them behind a 30-minute export.
 const {rows:[j]}=await c.query("select * from shorts.jobs where status='queued' order by (kind='probe') desc,created_at for update skip locked limit 1");
 if(j)await c.query("update shorts.jobs set status='running',progress=5 where id=$1",[j.id]);return j;
 });
 if(!job){await new Promise(r=>setTimeout(r,2000));continue;}
 const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30*60*1000)]);
 const onProgress=async progress=>{await pool.query('update shorts.jobs set progress=$2 where id=$1',[job.id,progress]);};
 try{
 if(job.session_id)await runSessionJob(job,signal,onProgress);
 else await jobs.run(job,{signal,onProgress});
 }catch(e){
 console.error(JSON.stringify({jobId:job.id,error:e.message}));
 if(job.session_id)await pool.query("update shorts.jobs set status='failed',error=$2,finished_at=now() where id=$1",[job.id,FAILED]);
 else await jobs.failed(job,FAILED);
 }
 }catch(e){console.error(JSON.stringify({error:e.message}));await new Promise(r=>setTimeout(r,3000));}
 }
}finally{lock.release();await pool.end();}
