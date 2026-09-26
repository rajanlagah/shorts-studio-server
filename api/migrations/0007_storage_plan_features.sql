-- Plan limits for storage + every plan syncing to the cloud (plan 013,
-- decision 3). Apart from 0006 so it lands only with the storage code: the
-- pre-013 API words unknown limits as raw numbers on pricing cards, and the
-- pre-013 app shows a "Synced" badge whenever sync_to_cloud is on.
insert into shorts.plan_features (plan_id,feature_key,enabled,config)
select p.id,f.key,f.enabled,f.config::jsonb from shorts.plans p join (values
 ('free','storage_bytes',true,'{"limit":524288000}'),
 ('starter','storage_bytes',true,'{"limit":1073741824}'),
 ('pro','storage_bytes',true,'{"limit":2147483648}'),
 ('free','community_opt_out',false,'{}'),
 ('starter','community_opt_out',true,'{}'),
 ('pro','community_opt_out',true,'{}')
) as f(slug,key,enabled,config) on f.slug=p.slug
on conflict (plan_id,feature_key) do nothing;
update shorts.plan_features set enabled=true
 where feature_key='sync_to_cloud' and plan_id=(select id from shorts.plans where slug='free');
