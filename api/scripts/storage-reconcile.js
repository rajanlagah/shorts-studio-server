// Compares the bucket with shorts.assets and the storage ledger.
//   npm run storage:reconcile            report only
//   npm run storage:reconcile -- --fix   also delete orphan objects
// Orphans: objects with no row, or whose row is deleted/failed.
// Missing: rows uploaded/ready whose object is gone (report only).
// Ledger drift: users whose user-held ledger sum differs from counted usage.
import {pool} from '../src/common.js';
import {createStorage} from '../src/storage.js';
const storage=createStorage();
if(!storage.configured){console.error('Set the S3_* variables (see .env.example).');process.exit(1);}
const fix=process.argv.includes('--fix');
try{
 const {rows}=await pool.query('select id,object_key,status from shorts.assets where provider=$1 and bucket=$2',[storage.provider,storage.bucket]);
 const byKey=new Map(rows.map(r=>[r.object_key,r]));
 const seen=new Set(),orphans=[];
 for await(const o of storage.list('u/')){
  seen.add(o.key);
  const r=byKey.get(o.key);
  if(!r||r.status==='deleted'||r.status==='failed')orphans.push({...o,assetId:r?.id??null,status:r?.status??'no row'});
 }
 const missing=rows.filter(r=>['uploaded','ready'].includes(r.status)&&!seen.has(r.object_key));
 const {rows:drift}=await pool.query(`select u.id,
  coalesce((select sum(delta_bytes) from shorts.storage_events e where e.user_id=u.id and e.holder='user'),0)::bigint as ledger,
  coalesce((select sum(bytes) from shorts.assets a where a.user_id=u.id and a.holder='user' and a.status in ('pending','uploaded','ready')),0)::bigint as used
  from shorts.users u`);
 const drifted=drift.filter(r=>r.ledger!==r.used);
 console.log(`objects: ${seen.size}, rows: ${rows.length}`);
 console.log(`orphans: ${orphans.length} (${orphans.reduce((n,o)=>n+o.bytes,0)} bytes)`);
 for(const o of orphans)console.log(`  ${o.key}  ${o.bytes}  ${o.status}`);
 console.log(`missing: ${missing.length}`);
 for(const r of missing)console.log(`  ${r.id}  ${r.object_key}  ${r.status}`);
 console.log(`ledger drift: ${drifted.length} user(s)`);
 for(const r of drifted)console.log(`  ${r.id}  ledger=${r.ledger}  usage=${r.used}`);
 if(fix&&orphans.length){
  for(const o of orphans)await storage.remove(o.key);
  console.log(`removed ${orphans.length} orphan object(s)`);
 }
 process.exitCode=orphans.length&&!fix||missing.length||drifted.length?2:0;
}finally{await pool.end();}
