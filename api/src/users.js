import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,uuid,words,captionStyle} from './common.js';
import {captionStyleOverride} from './style.js';
import {usage,projectBytes,syncOverQuota,markDeleting,COUNTED} from './storage-usage.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const googleBody=z.object({idToken:z.string().min(10)}).strict();
const createBody=z.object({title:z.string().trim().min(1).max(70)}).strict().partial();
const editClip=z.object({assetId:uuid,start:z.number().min(0).max(3600),end:z.number().positive().max(3600),fit:z.enum(['fit','crop']).default('fit')}).strict().refine(c=>c.end>c.start);
const editCaption=z.object({start:z.number().min(0).max(180),end:z.number().positive().max(180),text:z.string().max(300),style:captionStyleOverride.optional(),words:words.optional()}).strict().refine(c=>c.end>c.start);
const projectEditBody=z.object({clips:z.array(editClip).max(55).default([]),captions:z.array(editCaption).max(500).default([]),captionStyle:captionStyle.optional()}).strict();
const patchBody=z.object({
 title:z.string().trim().min(1).max(70).optional(),
 clipCount:z.number().int().min(0).max(5).optional(),
 duration:z.number().min(0).max(3600).optional(),
 thumbnail:z.string().max(200000).optional(),
 edit:projectEditBody.optional(),
}).strict();
const syncBody=z.object({sessionId:uuid,jobId:uuid}).strict();
const adminPlanBody=z.object({planId:uuid}).strict();
const exchangeBody=z.object({code:z.string().min(20).max(100)}).strict();
const settingsBody=z.object({communitySharing:z.boolean()}).strict();
export {googleBody,createBody,patchBody,syncBody,projectEditBody,adminPlanBody,exchangeBody,settingsBody,fail};
// Registered by index.js (and tests) before any plugin, so every route shares it.
export function errorHandler(err,req,reply){const status=err.name==='ZodError'?400:err.statusCode||500;if(status>=500)req.log.error({message:err.message},'Request failed');const body={error:status>=500?'Internal server error':err.message};if(err.feature_key)body.featureKey=err.feature_key;reply.code(status).send(body);}
// Shared by every Google sign-in endpoint. Generous because many mobile users
// share one IP behind carrier NAT; the Google ID-token check bounds abuse.
const loginRateLimit={max:60,timeWindow:'1 hour'};
// The one place pricing wording lives, so www and the app never word the
// same limit differently.
function featureDisplay(f){
 if(f.valueType==='boolean')return f.label;
 const n=f.limit;
 if(f.key==='exports')return n===null?'Unlimited exports':`${n} exports / month`;
 if(f.key==='max_shorts')return n===null?'Unlimited shorts per project':`Up to ${n} shorts per project`;
 if(f.key==='storage_bytes')return n===null?'Unlimited cloud storage':`${formatBytes(n)} cloud storage`;
 if(f.key==='max_duration'){
 if(n===null)return 'No export length limit';
 return n>=120&&n%60===0?`Up to ${n/60} min per export`:`Up to ${n} sec per export`;
 }
 return n===null?`${f.label}: unlimited`:`${f.label}: ${n}`;
}
// Binary units labelled MB/GB, matching the frontend's formatBytes.
function formatBytes(n){
 const gb=n/1024**3;
 if(gb>=1)return `${Number(gb.toFixed(1))} GB`;
 return `${Number((n/1024**2).toFixed(1))} MB`;
}
// featureRows must already be ordered by features.sort_order.
function serializePlans(plans,featureRows){
 return plans.map(p=>({
 id:p.id,slug:p.slug,name:p.name,priceInr:Number(p.price_inr),billingInterval:p.billing_interval,isAvailable:p.is_available,
 features:featureRows.filter(r=>r.plan_id===p.id).map(r=>{
 const f={key:r.feature_key,label:r.label,valueType:r.value_type,enabled:r.enabled};
 if(r.value_type!=='boolean')f.limit=r.config?.limit??null;
 return {...f,display:featureDisplay(f)};
 }),
 }));
}
export {featureDisplay,serializePlans,formatBytes};
const serializeUser=(u,plan,features,storage)=>({id:u.id,email:u.email,name:u.name,avatarUrl:u.avatar_url,isAdmin:u.is_admin,plan,features,storage:{used:storage.used,limit:storage.limit},settings:{communitySharing:u.community_sharing},overQuotaSince:u.over_quota_since});
const serializeProject=(p,bytes=0)=>({id:p.id,title:p.title,status:p.status,clipCount:p.clip_count,duration:Number(p.duration),thumbnail:p.thumbnail,sessionId:p.session_id,jobId:p.job_id,bytes,createdAt:p.created_at,updatedAt:p.updated_at});
const serializeProjectDetail=(p,bytes)=>({...serializeProject(p,bytes),edit:p.edit||{clips:[],captions:[]}});
async function withBytes(c,p){return serializeProject(p,(await projectBytes(c,[p.id])).get(p.id));}
// The full /v1/me body; every endpoint that returns a user uses this.
async function userBody(c,userId){
 const {rows:[user]}=await c.query('select * from shorts.users where id=$1',[userId]);
 const {rows:[plan]}=await c.query('select id,slug,name,price_inr as "priceInr",billing_interval as "billingInterval" from shorts.plans where id=$1',[user.plan_id]);
 const features=await getCustomerFeatures(c,userId);
 return serializeUser(user,plan,features,await usage(c,userId));
}
export {userBody};
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
export {getCustomerFeatures,userAuth};
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
// After any plan change (admin today, the payments webhook later): restart or
// stop the over-quota grace clock, and put users whose new plan can't opt out
// back into the community showcase for future exports.
async function applyPlanChange(c,userId){
 await syncOverQuota(c,userId);
 const features=await getCustomerFeatures(c,userId);
 if(!features.community_opt_out?.enabled)await c.query('update shorts.users set community_sharing=true where id=$1',[userId]);
}
export {applyPlanChange};
async function verifyGoogleIdToken(idToken){
 if(!process.env.GOOGLE_CLIENT_ID)throw fail(503,'Google sign-in is not configured on the server');
 const verify=await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`).catch(()=>null);
 if(!verify||!verify.ok)throw fail(401,'Invalid Google token');
 const payload=await verify.json();
 if(payload.aud!==process.env.GOOGLE_CLIENT_ID)throw fail(401,'Invalid Google token audience');
 if(payload.email_verified!=='true')throw fail(401,'Google email is not verified');
 return payload;
}
async function upsertGoogleUser(c,payload){
 await c.query('select pg_advisory_xact_lock(784324)');
 const {rows:[freePlan]}=await c.query("select id from shorts.plans where slug='free'");
 const {rows:[existing]}=await c.query('select id from shorts.users where google_sub=$1',[payload.sub]);
 const userId=existing?.id||randomUUID();
 if(existing)await c.query('update shorts.users set email=$2,name=$3,avatar_url=$4 where id=$1',[userId,payload.email,payload.name||null,payload.picture||null]);
 else await c.query('insert into shorts.users(id,google_sub,email,name,avatar_url,plan_id) values($1,$2,$3,$4,$5,$6)',[userId,payload.sub,payload.email,payload.name||null,payload.picture||null,freePlan.id]);
 if(!existing)await c.query('insert into shorts.customer_subscriptions(id,user_id,plan_id) values($1,$2,$3)',[randomUUID(),userId,freePlan.id]);
 return userId;
}
// Mints a user token and returns the same {token,user} body as sign-in.
async function issueSession(c,userId){
 const token=randomBytes(32).toString('hex');
 await c.query('insert into shorts.user_tokens(id,user_id,token_hash) values($1,$2,$3)',[randomUUID(),userId,hash(token)]);
 return {token,user:await userBody(c,userId)};
}
export default async function users(app){
 app.post('/v1/auth/google',{config:{rateLimit:loginRateLimit}},async(req,reply)=>{
 const {idToken}=googleBody.parse(req.body);
 const payload=await verifyGoogleIdToken(idToken);
 return transaction(async c=>{
 const userId=await upsertGoogleUser(c,payload);
 reply.code(201);return await issueSession(c,userId);
 });
 });
 // www.shortmonk.com sign-in: returns a one-time code instead of a token; the
 // app trades it at /v1/auth/exchange, so no long-lived token is put in a URL.
 app.post('/v1/auth/google/handoff',{config:{rateLimit:loginRateLimit}},async(req,reply)=>{
 const {idToken}=googleBody.parse(req.body);
 const payload=await verifyGoogleIdToken(idToken);
 return transaction(async c=>{
 const userId=await upsertGoogleUser(c,payload);
 const code=randomBytes(32).toString('base64url');
 const {rows:[row]}=await c.query('insert into shorts.auth_handoff_codes(code_hash,user_id) values($1,$2) returning expires_at',[hash(code),userId]);
 reply.code(201);return {code,expiresAt:row.expires_at};
 });
 });
 app.post('/v1/auth/exchange',{config:{rateLimit:{max:60,timeWindow:'1 hour'}}},async(req,reply)=>{
 const {code}=exchangeBody.parse(req.body);
 // Outside the transaction so the sweep isn't rolled back by a 401 below.
 await pool.query('delete from shorts.auth_handoff_codes where expires_at<now()');
 return transaction(async c=>{
 // DELETE ... RETURNING is what makes a code single-use; keep it one statement.
 const {rows:[row]}=await c.query('delete from shorts.auth_handoff_codes where code_hash=$1 and expires_at>now() returning user_id',[hash(code)]);
 if(!row)throw fail(401,'This sign-in link has expired. Please sign in again.');
 reply.code(201);return await issueSession(c,row.user_id);
 });
 });
 app.get('/v1/me',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 return userBody(c,user.id);
 }));
 app.patch('/v1/me/settings',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {communitySharing}=settingsBody.parse(req.body||{});
 if(!communitySharing){
 const features=await getCustomerFeatures(c,user.id);
 if(!features.community_opt_out?.enabled)throw Object.assign(fail(403,'Upgrade to keep your shorts out of the community showcase.'),{feature_key:'community_opt_out'});
 // Opting out is retroactive; opting back in only affects future exports.
 await c.query("update shorts.assets set community_shareable=false where user_id=$1 and kind='export' and community_shareable",[user.id]);
 }
 await c.query('update shorts.users set community_sharing=$2 where id=$1',[user.id,communitySharing]);
 return userBody(c,user.id);
 }));
 app.post('/v1/logout',async(req,reply)=>{
 const token=req.headers.authorization?.replace(/^Bearer /,'')||'';
 await pool.query('delete from shorts.user_tokens where token_hash=$1',[hash(token)]);
 reply.code(204);return null;
 });
 app.get('/v1/projects',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {rows}=await c.query("select * from shorts.projects where user_id=$1 and holder='user' order by updated_at desc",[user.id]);
 const bytes=await projectBytes(c,rows.map(p=>p.id));
 return rows.map(p=>serializeProject(p,bytes.get(p.id)));
 }));
 app.post('/v1/projects',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const {title}=createBody.parse(req.body||{});
 const id=randomUUID();
 await c.query('insert into shorts.projects(id,user_id,title) values($1,$2,$3)',[id,user.id,title||'Untitled short']);
 const {rows:[project]}=await c.query('select * from shorts.projects where id=$1',[id]);
 reply.code(201);return serializeProject(project);
 }));
 app.get('/v1/projects/:id',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const {rows:[project]}=await c.query("select * from shorts.projects where id=$1 and user_id=$2 and holder='user'",[id,user.id]);
 if(!project)throw fail(404,'Project not found');
 return serializeProjectDetail(project,(await projectBytes(c,[id])).get(id));
 }));
 app.patch('/v1/projects/:id',async req=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const patch=patchBody.parse(req.body||{});
 const {rows:[existing]}=await c.query("select id from shorts.projects where id=$1 and user_id=$2 and holder='user'",[id,user.id]);
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
 return withBytes(c,project);
 }));
 app.delete('/v1/projects/:id',async(req,reply)=>transaction(async c=>{
 const user=await userAuth(c,req);
 const id=uuid.parse(req.params.id);
 const {rows:[project]}=await c.query("select id from shorts.projects where id=$1 and user_id=$2 and holder='user' for update",[id,user.id]);
 if(project){
 // The worker purges the objects; the rows keep object_key after
 // project_id is nulled by the delete below.
 const {rows:assets}=await c.query("select * from shorts.assets where project_id=$1 and holder='user' and status=any($2) for update",[id,COUNTED]);
 for(const a of assets)await markDeleting(c,a);
 await c.query('delete from shorts.projects where id=$1',[id]);
 await syncOverQuota(c,user.id,{set:false});
 }
 reply.code(204);return null;
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
 return {project:await withBytes(c,updatedProject),user:await userBody(c,user.id)};
 }));
 async function adminAuth(c,req){
 const user=await userAuth(c,req);
 if(!user.is_admin)throw fail(403,'Admin access required');
 return user;
 }
 app.get('/v1/plans',async(req,reply)=>{
 const {rows:plans}=await pool.query('select id,slug,name,price_inr,billing_interval,is_available from shorts.plans where is_active order by sort_order');
 const {rows:featureRows}=await pool.query('select pf.plan_id,pf.feature_key,pf.enabled,pf.config,f.label,f.value_type from shorts.plan_features pf join shorts.features f on f.key=pf.feature_key order by f.sort_order,f.key');
 reply.header('Cache-Control','public, max-age=300');
 return serializePlans(plans,featureRows);
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
 await applyPlanChange(c,customerId);
 return userBody(c,customerId);
 }));
 app.get('/v1/admin/storage',async req=>transaction(async c=>{
 await adminAuth(c,req);
 const {rows:[t]}=await c.query(`select
 coalesce(sum(bytes) filter(where holder='user' and status in ('uploaded','ready')),0)::bigint as user_bytes,
 count(*) filter(where holder='user' and status in ('uploaded','ready')) as user_assets,
 coalesce(sum(bytes) filter(where holder='internal' and status=any($1)),0)::bigint as internal_bytes,
 count(*) filter(where holder='internal' and status=any($1)) as internal_assets,
 coalesce(sum(bytes) filter(where status='pending'),0)::bigint as pending_bytes,
 coalesce(sum(bytes) filter(where kind='source' and holder='user' and status=any($1)),0)::bigint as source_bytes,
 coalesce(sum(bytes) filter(where kind='export' and holder='user' and status=any($1)),0)::bigint as export_bytes
 from shorts.assets`,[COUNTED]);
 const {rows:byPlan}=await c.query(`select p.slug,count(distinct u.id)::int as users,coalesce(sum(a.bytes) filter(where a.holder='user' and a.status=any($1)),0)::bigint as bytes
 from shorts.plans p left join shorts.users u on u.plan_id=p.id left join shorts.assets a on a.user_id=u.id group by p.slug,p.sort_order order by p.sort_order`,[COUNTED]);
 const {rows:top}=await c.query(`select u.id,u.email,sum(a.bytes)::bigint as bytes from shorts.assets a join shorts.users u on u.id=a.user_id
 where a.holder='user' and a.status=any($1) group by u.id,u.email order by bytes desc limit 20`,[COUNTED]);
 const topUsers=[];
 for(const r of top)topUsers.push({userId:r.id,email:r.email,bytes:Number(r.bytes),limit:(await usage(c,r.id)).limit});
 return {
 userHeld:{bytes:Number(t.user_bytes),assets:Number(t.user_assets)},
 internal:{bytes:Number(t.internal_bytes),assets:Number(t.internal_assets)},
 pending:{bytes:Number(t.pending_bytes)},
 byPlan:byPlan.map(r=>({slug:r.slug,users:r.users,bytes:Number(r.bytes)})),
 byKind:{source:Number(t.source_bytes),export:Number(t.export_bytes)},
 topUsers,
 };
 }));
 app.get('/v1/admin/customers/:id/storage',async req=>transaction(async c=>{
 await adminAuth(c,req);
 const customerId=uuid.parse(req.params.id);
 const {rows:[customer]}=await c.query('select id,over_quota_since from shorts.users where id=$1',[customerId]);
 if(!customer)throw fail(404,'Customer not found');
 const {rows}=await c.query(`select p.id,p.title,p.holder,p.retained_at,
 coalesce(sum(a.bytes) filter(where a.status=any($2)),0)::bigint as bytes,
 count(a.id) filter(where a.kind='source' and a.status=any($2))::int as sources,
 count(a.id) filter(where a.kind='export' and a.status=any($2))::int as exports
 from shorts.projects p left join shorts.assets a on a.project_id=p.id
 where p.user_id=$1 group by p.id order by p.updated_at desc`,[customerId,COUNTED]);
 return {
 userId:customerId,overQuotaSince:customer.over_quota_since,storage:await usage(c,customerId),
 projects:rows.map(r=>({id:r.id,title:r.title,holder:r.holder,retainedAt:r.retained_at,bytes:Number(r.bytes),sources:r.sources,exports:r.exports})),
 };
 }));
}
