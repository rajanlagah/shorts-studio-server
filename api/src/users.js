import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,uuid} from './common.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const googleBody=z.object({idToken:z.string().min(10)}).strict();
const createBody=z.object({title:z.string().trim().min(1).max(70)}).strict().partial();
const editClip=z.object({assetId:uuid,start:z.number().min(0).max(3600),end:z.number().positive().max(3600),fit:z.enum(['fit','crop']).default('fit')}).strict().refine(c=>c.end>c.start);
const editCaption=z.object({start:z.number().min(0).max(180),end:z.number().positive().max(180),text:z.string().max(300)}).strict().refine(c=>c.end>c.start);
const projectEditBody=z.object({clips:z.array(editClip).max(55).default([]),captions:z.array(editCaption).max(500).default([])}).strict();
const patchBody=z.object({
 title:z.string().trim().min(1).max(70).optional(),
 clipCount:z.number().int().min(0).max(5).optional(),
 duration:z.number().min(0).max(3600).optional(),
 thumbnail:z.string().max(200000).optional(),
 edit:projectEditBody.optional(),
}).strict();
const syncBody=z.object({sessionId:uuid,jobId:uuid}).strict();
const adminPlanBody=z.object({planId:uuid}).strict();
export {googleBody,createBody,patchBody,syncBody,projectEditBody,adminPlanBody};
const serializeUser=(u,plan,features)=>({id:u.id,email:u.email,name:u.name,avatarUrl:u.avatar_url,isAdmin:u.is_admin,plan,features});
const serializeProject=p=>({id:p.id,title:p.title,status:p.status,clipCount:p.clip_count,duration:Number(p.duration),thumbnail:p.thumbnail,sessionId:p.session_id,jobId:p.job_id,createdAt:p.created_at,updatedAt:p.updated_at});
const serializeProjectDetail=p=>({...serializeProject(p),edit:p.edit||{clips:[],captions:[]}});
async function getCustomerFeatures(c,userId){
 const {rows:catalog}=await c.query('select key,value_type from shorts.features');
 const {rows:planRows}=await c.query('select pf.feature_key,pf.enabled,pf.config from shorts.plan_features pf join shorts.users u on u.plan_id=pf.plan_id where u.id=$1',[userId]);
 const {rows:overrideRows}=await c.query('select feature_key,enabled,config from shorts.customer_feature_overrides where user_id=$1',[userId]);
 const {rows:usageRows}=await c.query('select feature_key,used,reset_at from shorts.customer_feature_usage where user_id=$1',[userId]);
 const usageByKey=new Map(usageRows.map(u=>[u.feature_key,u]));
 for(const f of catalog){
 if(f.value_type!=='counter')continue;
 const source=overrideRows.find(o=>o.feature_key===f.key)||planRows.find(p=>p.feature_key===f.key);
 const interval=source?.config?.resetInterval||'1 month';
 let usage=usageByKey.get(f.key);
 if(!usage){
 await c.query('insert into shorts.customer_feature_usage(user_id,feature_key,used,reset_at) values($1,$2,0,now()+$3::interval) on conflict(user_id,feature_key) do nothing',[userId,f.key,interval]);
 usage={feature_key:f.key,used:0,reset_at:new Date(Date.now()+2592000000).toISOString()};
 }else if(new Date(usage.reset_at)<new Date()){
 await c.query("update shorts.customer_feature_usage set used=0,reset_at=now()+$3::interval where user_id=$1 and feature_key=$2",[userId,f.key,interval]);
 usage={...usage,used:0,reset_at:new Date(Date.now()+2592000000).toISOString()};
 }
 usageByKey.set(f.key,usage);
 }
 const features={};
 for(const f of catalog){
 const override=overrideRows.find(o=>o.feature_key===f.key);
 const planRow=planRows.find(p=>p.feature_key===f.key);
 const source=override||planRow||{enabled:false,config:{}};
 const entry={enabled:source.enabled};
 if(f.value_type==='limit')entry.limit=source.config?.limit??null;
 if(f.value_type==='counter'){
 entry.limit=source.config?.limit??null;
 const usage=usageByKey.get(f.key);
 entry.used=usage?.used??0;
 entry.resetAt=usage?.reset_at??null;
 }
 features[f.key]=entry;
 }
 return features;
}
export {getCustomerFeatures};
// Auth boundary for real accounts; distinct from the anonymous editor session's 404/410 convention.
async function userAuth(c,req){
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 if(!token)throw fail(401,'Missing token');
 const {rows:[row]}=await c.query(
 "select u.* from shorts.user_tokens t join shorts.users u on u.id=t.user_id where t.token_hash=$1 and t.expires_at>now() for update of u",
 [hash(token)],
 );
 if(!row)throw fail(401,'Invalid or expired token');
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
 const {rows:[freePlan]}=await c.query("select id from shorts.plans where slug='free'");
 const {rows:[existing]}=await c.query('select id from shorts.users where google_sub=$1',[payload.sub]);
 const userId=existing?.id||randomUUID();
 if(existing)await c.query('update shorts.users set email=$2,name=$3,avatar_url=$4 where id=$1',[userId,payload.email,payload.name||null,payload.picture||null]);
 else await c.query('insert into shorts.users(id,google_sub,email,name,avatar_url,plan_id) values($1,$2,$3,$4,$5,$6)',[userId,payload.sub,payload.email,payload.name||null,payload.picture||null,freePlan.id]);
 if(!existing)await c.query('insert into shorts.customer_subscriptions(id,user_id,plan_id) values($1,$2,$3)',[randomUUID(),userId,freePlan.id]);
 const token=randomBytes(32).toString('hex');
 await c.query('insert into shorts.user_tokens(id,user_id,token_hash) values($1,$2,$3)',[randomUUID(),userId,hash(token)]);
 const {rows:[user]}=await c.query('select * from shorts.users where id=$1',[userId]);
 const {rows:[plan]}=await c.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where id=$1',[user.plan_id]);
 const features=await getCustomerFeatures(c,user.id);
 return reply.code(201).send({token,user:serializeUser(user,plan,features)});
 });
 });
 app.get('/v1/me',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {rows:[plan]}=await c.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where id=$1',[user.plan_id]);
 const features=await getCustomerFeatures(c,user.id);
 return serializeUser(user,plan,features);
 }));
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
 app.get('/v1/projects/:id',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const {rows:[project]}=await c.query('select * from shorts.projects where id=$1 and user_id=$2',[id,user.id]);
 if(!project)throw fail(404,'Project not found');
 return serializeProjectDetail(project);
 }));
 app.patch('/v1/projects/:id',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const patch=patchBody.parse(req.body||{});
 const {rows:[existing]}=await c.query('select id from shorts.projects where id=$1 and user_id=$2',[id,user.id]);
 if(!existing)throw fail(404,'Project not found');
 if(patch.edit){
 const features=await getCustomerFeatures(c,user.id);
 if(patch.edit.clips.length>0&&!features.max_shorts.enabled)throw fail(403,'max_shorts feature is disabled for your plan');
 if(features.max_shorts.limit!==null&&patch.edit.clips.length>features.max_shorts.limit)
 throw Object.assign(fail(403,`Your plan allows up to ${features.max_shorts.limit} shorts per project.`),{feature_key:'max_shorts'});
 const totalDuration=patch.edit.clips.reduce((n,c)=>n+(c.end-c.start),0);
 if(features.max_duration.limit!==null&&totalDuration>features.max_duration.limit)
 throw Object.assign(fail(403,`Your plan allows up to ${features.max_duration.limit} seconds per export.`),{feature_key:'max_duration'});
 }
 // When a full edit is saved, clipCount/duration are derived from it —
 // the frontend must not (and no longer needs to) send them separately
 // in the same call.
 if(patch.edit){
 patch.clipCount=patch.edit.clips.length;
 patch.duration=patch.edit.clips.reduce((n,cl)=>n+(cl.end-cl.start),0);
 }
 const sets=['updated_at=now()'],values=[id];
 for(const [col,key,serialize] of [['title','title'],['clip_count','clipCount'],['duration','duration'],['thumbnail','thumbnail'],['edit','edit',JSON.stringify]]){
 if(patch[key]===undefined)continue;
 values.push(serialize?serialize(patch[key]):patch[key]);
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
 const features=await getCustomerFeatures(c,user.id);
 if(!features.exports.enabled)throw Object.assign(fail(403,'Exporting is disabled for your plan.'),{feature_key:'exports'});
 if(features.exports.limit!==null&&features.exports.used>=features.exports.limit)
 throw Object.assign(fail(403,'No exports remaining this month. Upgrade to continue.'),{feature_key:'exports'});
 await c.query("update shorts.customer_feature_usage set used=used+1 where user_id=$1 and feature_key='exports'",[user.id]);
 charged=true;
 }
 await c.query('update shorts.projects set status=$2,session_id=$3,job_id=$4,build_charged=$5,updated_at=now() where id=$1',[id,status,sessionId,jobId,charged]);
 const {rows:[updatedProject]}=await c.query('select * from shorts.projects where id=$1',[id]);
 const {rows:[updatedUser]}=await c.query('select * from shorts.users where id=$1',[user.id]);
 const {rows:[plan]}=await c.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where id=$1',[updatedUser.plan_id]);
 const updatedFeatures=await getCustomerFeatures(c,user.id);
 return {project:serializeProject(updatedProject),user:serializeUser(updatedUser,plan,updatedFeatures)};
 }));
 async function adminAuth(c,req){
 const user=await userAuth(c,req);
 if(!user.is_admin)throw fail(403,'Admin access required');
 return user;
 }
 app.get('/v1/plans',async()=>{
 const {rows:plans}=await pool.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where is_active order by sort_order');
 const {rows:featureRows}=await pool.query('select pf.plan_id,pf.feature_key,pf.enabled,pf.config,f.value_type from shorts.plan_features pf join shorts.features f on f.key=pf.feature_key');
 return plans.map(p=>({
 ...p,
 features:Object.fromEntries(featureRows.filter(r=>r.plan_id===p.id).map(r=>{
 const entry={enabled:r.enabled};
 if(r.value_type!=='boolean')entry.limit=r.config?.limit??null;
 return [r.feature_key,entry];
 })),
 }));
 });
 app.patch('/v1/admin/customers/:id/plan',async req=>transaction(async c=>{
 await adminAuth(c,req);
 const customerId=uuid.parse(req.params.id);
 const {planId}=adminPlanBody.parse(req.body||{});
 const {rows:[plan]}=await c.query('select id from shorts.plans where id=$1 and is_active',[planId]);
 if(!plan)throw fail(404,'Plan not found');
 const {rows:[customer]}=await c.query('select id from shorts.users where id=$1 for update',[customerId]);
 if(!customer)throw fail(404,'Customer not found');
 await c.query('update shorts.customer_subscriptions set ended_at=now(),status=\'ended\' where user_id=$1 and ended_at is null',[customerId]);
 await c.query('insert into shorts.customer_subscriptions(id,user_id,plan_id) values($1,$2,$3)',[randomUUID(),customerId,planId]);
 await c.query('update shorts.users set plan_id=$2 where id=$1',[customerId,planId]);
 const {rows:[updatedUser]}=await c.query('select * from shorts.users where id=$1',[customerId]);
 const {rows:[updatedPlan]}=await c.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where id=$1',[planId]);
 const features=await getCustomerFeatures(c,customerId);
 return serializeUser(updatedUser,updatedPlan,features);
 }));
}
