import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,uuid} from './common.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const googleBody=z.object({idToken:z.string().min(10)}).strict();
const createBody=z.object({title:z.string().trim().min(1).max(70)}).strict().partial();
const patchBody=z.object({
 title:z.string().trim().min(1).max(70).optional(),
 clipCount:z.number().int().min(0).max(5).optional(),
 duration:z.number().min(0).max(3600).optional(),
 thumbnail:z.string().max(200000).optional(),
}).strict();
const syncBody=z.object({sessionId:uuid,jobId:uuid}).strict();
export {googleBody,createBody,patchBody,syncBody};
const serializeUser=u=>({id:u.id,email:u.email,name:u.name,avatarUrl:u.avatar_url,plan:u.plan,buildsRemaining:u.builds_remaining,buildsResetAt:u.builds_reset_at});
const serializeProject=p=>({id:p.id,title:p.title,status:p.status,clipCount:p.clip_count,duration:Number(p.duration),thumbnail:p.thumbnail,sessionId:p.session_id,jobId:p.job_id,createdAt:p.created_at,updatedAt:p.updated_at});
// Auth boundary for real accounts; distinct from the anonymous editor session's 404/410 convention.
async function userAuth(c,req){
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 if(!token)throw fail(401,'Missing token');
 const {rows:[row]}=await c.query(
 "select u.* from shorts.user_tokens t join shorts.users u on u.id=t.user_id where t.token_hash=$1 and t.expires_at>now() for update of u",
 [hash(token)],
 );
 if(!row)throw fail(401,'Invalid or expired token');
 if(new Date(row.builds_reset_at)<new Date()){
 const resetTo=row.plan==='free'?3:null;
 await c.query("update shorts.users set builds_remaining=$2,builds_reset_at=now()+interval '1 month' where id=$1",[row.id,resetTo]);
 row.builds_remaining=resetTo;
 }
 return row;
}
export default async function users(app){
 app.post('/v1/auth/google',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async(req,reply)=>{
 if(!process.env.GOOGLE_CLIENT_ID)throw fail(503,'Google sign-in is not configured on the server');
 const {idToken}=googleBody.parse(req.body);
 const verify=await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`).catch(()=>null);
 if(!verify||!verify.ok)throw fail(401,'Invalid Google token');
 const payload=await verify.json();
 if(payload.aud!==process.env.GOOGLE_CLIENT_ID)throw fail(401,'Invalid Google token audience');
 if(payload.email_verified!=='true')throw fail(401,'Google email is not verified');
 return transaction(async c=>{
 await c.query('select pg_advisory_xact_lock(784324)');
 const {rows:[existing]}=await c.query('select id from shorts.users where google_sub=$1',[payload.sub]);
 const userId=existing?.id||randomUUID();
 if(existing)await c.query('update shorts.users set email=$2,name=$3,avatar_url=$4 where id=$1',[userId,payload.email,payload.name||null,payload.picture||null]);
 else await c.query('insert into shorts.users(id,google_sub,email,name,avatar_url) values($1,$2,$3,$4,$5)',[userId,payload.sub,payload.email,payload.name||null,payload.picture||null]);
 const token=randomBytes(32).toString('hex');
 await c.query('insert into shorts.user_tokens(id,user_id,token_hash) values($1,$2,$3)',[randomUUID(),userId,hash(token)]);
 const {rows:[user]}=await c.query('select * from shorts.users where id=$1',[userId]);
 return reply.code(201).send({token,user:serializeUser(user)});
 });
 });
 app.get('/v1/me',async req=>transaction(async c=>serializeUser(await userAuth(c,req))));
 app.post('/v1/logout',async(req,reply)=>{
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 await pool.query('delete from shorts.user_tokens where token_hash=$1',[hash(token)]);
 return reply.code(204).send();
 });
 app.get('/v1/projects',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {rows}=await c.query('select * from shorts.projects where user_id=$1 order by updated_at desc',[user.id]);
 return rows.map(serializeProject);
 }));
 app.post('/v1/projects',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {title}=createBody.parse(req.body||{});
 const id=randomUUID();
 await c.query('insert into shorts.projects(id,user_id,title) values($1,$2,$3)',[id,user.id,title||'Untitled short']);
 const {rows:[project]}=await c.query('select * from shorts.projects where id=$1',[id]);
 return reply.code(201).send(serializeProject(project));
 }));
 app.patch('/v1/projects/:id',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const patch=patchBody.parse(req.body||{});
 const {rows:[existing]}=await c.query('select id from shorts.projects where id=$1 and user_id=$2',[id,user.id]);
 if(!existing)throw fail(404,'Project not found');
 const sets=['updated_at=now()'],values=[id];
 for(const [col,key] of [['title','title'],['clip_count','clipCount'],['duration','duration'],['thumbnail','thumbnail']]){
 if(patch[key]===undefined)continue;
 values.push(patch[key]);
 sets.push(`${col}=$${values.length}`);
 }
 await c.query(`update shorts.projects set ${sets.join(',')} where id=$1`,values);
 const {rows:[project]}=await c.query('select * from shorts.projects where id=$1',[id]);
 return serializeProject(project);
 }));
 app.delete('/v1/projects/:id',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 await c.query('delete from shorts.projects where id=$1 and user_id=$2',[id,user.id]);
 return reply.code(204).send();
 }));
 app.post('/v1/projects/:id/sync',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const {sessionId,jobId}=syncBody.parse(req.body);
 const {rows:[project]}=await c.query('select * from shorts.projects where id=$1 and user_id=$2 for update',[id,user.id]);
 if(!project)throw fail(404,'Project not found');
 const {rows:[job]}=await c.query('select kind,status from shorts.jobs where id=$1 and session_id=$2',[jobId,sessionId]);
 if(!job)throw fail(404,'Job not found');
 const status=['queued','running'].includes(job.status)?'processing':job.status;
 let charged=project.build_charged;
 if(job.status==='completed'&&job.kind==='export'&&!project.build_charged){
 const {rows:[fresh]}=await c.query('select builds_remaining from shorts.users where id=$1 for update',[user.id]);
 if(fresh.builds_remaining!==null){
 if(fresh.builds_remaining<=0)throw fail(402,'No builds remaining on the Free plan. Upgrade to continue exporting.');
 await c.query('update shorts.users set builds_remaining=builds_remaining-1 where id=$1',[user.id]);
 }
 charged=true;
 }
 await c.query('update shorts.projects set status=$2,session_id=$3,job_id=$4,build_charged=$5,updated_at=now() where id=$1',[id,status,sessionId,jobId,charged]);
 const {rows:[updatedProject]}=await c.query('select * from shorts.projects where id=$1',[id]);
 const {rows:[updatedUser]}=await c.query('select * from shorts.users where id=$1',[user.id]);
 return {project:serializeProject(updatedProject),user:serializeUser(updatedUser)};
 }));
}
