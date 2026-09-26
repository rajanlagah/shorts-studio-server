// Throwaway database for DB-backed tests. Set TEST_DATABASE_URL to a
// superuser connection on a disposable Postgres (roles shorts_backend, anon
// and authenticated must exist); tests using this are skipped without it.
import pg from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const migrate=fileURLToPath(new URL('../../scripts/migrate.js',import.meta.url));
export const enabled=Boolean(process.env.TEST_DATABASE_URL);
export async function freshDatabase(){
 const admin=process.env.TEST_DATABASE_URL,name=`shorts_test_${randomBytes(4).toString('hex')}`;
 const c=new pg.Client({connectionString:admin});await c.connect();await c.query(`create database ${name}`);await c.end();
 const url=new URL(admin);url.pathname=`/${name}`;
 execFileSync(process.execPath,[migrate],{env:{...process.env,MIGRATION_DATABASE_URL:url.toString()},stdio:'pipe'});
 return {url:url.toString(),async drop(){
  const c=new pg.Client({connectionString:admin});await c.connect();await c.query(`drop database if exists ${name} with (force)`);await c.end();
 }};
}
export const PLAN={free:'00000000-0000-4000-8000-000000000001',starter:'00000000-0000-4000-8000-000000000002',pro:'00000000-0000-4000-8000-000000000003'};
export async function createUser(pool,{plan='free',admin=false}={}){
 const id=randomUUID(),token=randomBytes(16).toString('hex');
 await pool.query('insert into shorts.users(id,google_sub,email,plan_id,is_admin) values($1,$2,$3,$4,$5)',[id,id,`${id}@test`,PLAN[plan],admin]);
 await pool.query('insert into shorts.user_tokens(id,user_id,token_hash) values($1,$2,$3)',[randomUUID(),id,createHash('sha256').update(token).digest('hex')]);
 return {id,token};
}
// In-memory stand-in for storage.js with the same interface.
export function fakeStorage(keyFor){
 const objects=new Map(),uploads=new Map();
 return {
  configured:true,provider:'fake',bucket:'test',keyFor,objects,uploads,
  async createMultipart(key){const id=randomUUID();uploads.set(id,{key,parts:new Map()});return id;},
  async presignPart(key,uploadId,n){return `https://storage.test/${key}?uploadId=${uploadId}&partNumber=${n}`;},
  // Test helper: what a browser PUT to a part URL does.
  putPart(uploadId,n,bytes){const u=uploads.get(uploadId);u.parts.set(n,bytes);return `"etag-${n}"`;},
  async completeMultipart(key,uploadId,parts){
   const u=uploads.get(uploadId);if(!u||u.key!==key)throw Object.assign(new Error('NoSuchUpload'),{name:'NoSuchUpload'});
   objects.set(key,parts.reduce((n,p)=>n+u.parts.get(p.partNumber),0));uploads.delete(uploadId);
  },
  async abortMultipart(key,uploadId){uploads.delete(uploadId);},
  async head(key){return objects.has(key)?{bytes:objects.get(key),contentType:'video/mp4'}:null;},
  async presignGet(key,{disposition,filename}){return `https://storage.test/${key}?d=${disposition}&f=${encodeURIComponent(filename)}`;},
  async download(){throw new Error('not in fake');},
  async upload(localPath,key){const {statSync}=await import('node:fs');objects.set(key,statSync(localPath).size);},
  async remove(key){objects.delete(key);},
  async *list(prefix=''){for(const [key,bytes] of objects)if(key.startsWith(prefix))yield {key,bytes};},
 };
}
// sum(user-held ledger deltas) must equal counted usage, for every user.
export async function ledgerDrift(pool){
 const {rows}=await pool.query(`select u.id,
  coalesce((select sum(delta_bytes) from shorts.storage_events e where e.user_id=u.id and e.holder='user'),0)::bigint as ledger,
  coalesce((select sum(bytes) from shorts.assets a where a.user_id=u.id and a.holder='user' and a.status in ('pending','uploaded','ready')),0)::bigint as used
  from shorts.users u`);
 return rows.filter(r=>r.ledger!==r.used);
}
