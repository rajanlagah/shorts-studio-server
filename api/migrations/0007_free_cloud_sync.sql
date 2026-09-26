-- Every plan now stores footage in the cloud (plan 013, decision 3). Kept
-- apart from 0006 so it lands only when the storage code is deployed: the
-- pre-013 app shows a "Synced" badge whenever this is on.
update shorts.plan_features set enabled=true
 where feature_key='sync_to_cloud' and plan_id=(select id from shorts.plans where slug='free');
