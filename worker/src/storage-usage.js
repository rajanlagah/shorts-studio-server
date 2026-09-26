// Storage accounting shared by the API and the worker (byte-identical copies).
// Usage is always a SUM over assets, never a stored counter; storage_events
// is the append-only history. Invariant, per user:
//   sum(storage_events.delta_bytes where holder='user') == usage().used
// so every change to an asset's counted bytes/status/holder must call
// recordEvent in the same transaction.
export const COUNTED=['pending','uploaded','ready'];
// Override, else plan row; missing or disabled means no storage at all.
// null = unlimited.
export async function storageLimit(c,userId){
 const {rows:[r]}=await c.query(`select coalesce(o.enabled,pf.enabled,false) as enabled,coalesce(o.config,pf.config) as config
  from shorts.users u
  left join shorts.plan_features pf on pf.plan_id=u.plan_id and pf.feature_key='storage_bytes'
  left join shorts.customer_feature_overrides o on o.user_id=u.id and o.feature_key='storage_bytes'
  where u.id=$1`,[userId]);
 if(!r?.enabled)return 0;
 const limit=r.config?.limit;
 return limit===null||limit===undefined?null:Number(limit);
}
export async function usedBytes(c,userId){
 const {rows:[r]}=await c.query("select coalesce(sum(bytes),0)::bigint as used from shorts.assets where user_id=$1 and holder='user' and status=any($2)",[userId,COUNTED]);
 return Number(r.used);
}
export async function usage(c,userId){
 const [used,limit]=[await usedBytes(c,userId),await storageLimit(c,userId)];
 return {used,limit,overQuota:limit!==null&&used>limit};
}
export async function projectBytes(c,projectIds){
 const out=new Map(projectIds.map(id=>[id,0]));
 if(!projectIds.length)return out;
 const {rows}=await c.query("select project_id,sum(bytes)::bigint as bytes from shorts.assets where project_id=any($1) and holder='user' and status=any($2) group by project_id",[projectIds,COUNTED]);
 for(const r of rows)out.set(r.project_id,Number(r.bytes));
 return out;
}
export async function recordEvent(c,{userId,projectId=null,assetId,delta,holder='user',reason}){
 await c.query('insert into shorts.storage_events(user_id,project_id,asset_id,delta_bytes,holder,reason) values($1,$2,$3,$4,$5,$6)',[userId,projectId,assetId,delta,holder,reason]);
}
// Over-quota flag: `set` starts the 14-day grace clock if over (and not
// already running); `clear` stops it once usage fits again.
export async function syncOverQuota(c,userId,{set=true,clear=true}={}){
 const u=await usage(c,userId);
 if(u.overQuota&&set)await c.query('update shorts.users set over_quota_since=coalesce(over_quota_since,now()) where id=$1',[userId]);
 if(!u.overQuota&&clear)await c.query('update shorts.users set over_quota_since=null where id=$1 and over_quota_since is not null',[userId]);
 return u;
}
// Moves an asset out of the user's counted total; used by every delete path.
export async function markDeleting(c,asset){
 const {rowCount}=await c.query("update shorts.assets set status='deleting' where id=$1 and status=any($2)",[asset.id,COUNTED]);
 if(rowCount)await recordEvent(c,{userId:asset.user_id,projectId:asset.project_id,assetId:asset.id,delta:-Number(asset.bytes),holder:asset.holder,reason:'delete'});
 return rowCount>0;
}
