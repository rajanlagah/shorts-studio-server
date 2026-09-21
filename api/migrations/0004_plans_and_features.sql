-- Replaces the plan enum + ad hoc builds_remaining quota with a normalized
-- plans/features schema. See plans/004-backend-plans-and-feature-flags.md
-- (frontend repo) for the full design rationale.

create table if not exists shorts.features (
 key text primary key,
 label text not null,
 value_type text not null check(value_type in ('boolean','limit','counter')),
 created_at timestamptz not null default now()
);

create table if not exists shorts.plans (
 id uuid primary key,
 slug text not null unique,
 name text not null,
 price_inr numeric(10,2) not null default 0,
 billing_interval text not null default 'month',
 sort_order integer not null default 0,
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);

create table if not exists shorts.plan_features (
 plan_id uuid not null references shorts.plans(id) on delete cascade,
 feature_key text not null references shorts.features(key),
 enabled boolean not null default false,
 config jsonb not null default '{}'::jsonb,
 primary key (plan_id, feature_key)
);

alter table shorts.users add column if not exists plan_id uuid references shorts.plans(id);
alter table shorts.users add column if not exists is_admin boolean not null default false;

create table if not exists shorts.customer_subscriptions (
 id uuid primary key,
 user_id uuid not null references shorts.users(id) on delete cascade,
 plan_id uuid not null references shorts.plans(id),
 started_at timestamptz not null default now(),
 ended_at timestamptz,
 status text not null default 'active' check(status in ('active','ended')),
 created_at timestamptz not null default now()
);
create index if not exists customer_subscriptions_user on shorts.customer_subscriptions(user_id, started_at desc);
create unique index if not exists customer_subscriptions_one_active on shorts.customer_subscriptions(user_id) where ended_at is null;

create table if not exists shorts.customer_feature_overrides (
 user_id uuid not null references shorts.users(id) on delete cascade,
 feature_key text not null references shorts.features(key),
 enabled boolean not null,
 config jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 primary key (user_id, feature_key)
);

create table if not exists shorts.customer_feature_usage (
 user_id uuid not null references shorts.users(id) on delete cascade,
 feature_key text not null references shorts.features(key),
 used integer not null default 0,
 reset_at timestamptz,
 primary key (user_id, feature_key)
);

alter table shorts.sessions add column if not exists user_id uuid references shorts.users(id) on delete cascade;

alter table shorts.features enable row level security;
alter table shorts.plans enable row level security;
alter table shorts.plan_features enable row level security;
alter table shorts.customer_subscriptions enable row level security;
alter table shorts.customer_feature_overrides enable row level security;
alter table shorts.customer_feature_usage enable row level security;

grant select,insert,update,delete on shorts.features,shorts.plans,shorts.plan_features,shorts.customer_subscriptions,shorts.customer_feature_overrides,shorts.customer_feature_usage to shorts_backend;
do $$
begin
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='features' and policyname='backend_features') then
  create policy backend_features on shorts.features for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='plans' and policyname='backend_plans') then
  create policy backend_plans on shorts.plans for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='plan_features' and policyname='backend_plan_features') then
  create policy backend_plan_features on shorts.plan_features for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='customer_subscriptions' and policyname='backend_customer_subscriptions') then
  create policy backend_customer_subscriptions on shorts.customer_subscriptions for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='customer_feature_overrides' and policyname='backend_customer_feature_overrides') then
  create policy backend_customer_feature_overrides on shorts.customer_feature_overrides for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='customer_feature_usage' and policyname='backend_customer_feature_usage') then
  create policy backend_customer_feature_usage on shorts.customer_feature_usage for all to shorts_backend using(true) with check(true);
 end if;
end $$;

insert into shorts.features (key,label,value_type) values
 ('auto_caption','Auto-generate captions','boolean'),
 ('sync_to_cloud','Sync to cloud','boolean'),
 ('max_shorts','Shorts per project','limit'),
 ('max_duration','Max export duration (seconds)','limit'),
 ('exports','Exports per month','counter')
on conflict (key) do nothing;

insert into shorts.plans (id,slug,name,price_inr,billing_interval,sort_order) values
 ('00000000-0000-4000-8000-000000000001','free','Free',0,'month',0),
 ('00000000-0000-4000-8000-000000000002','starter','Starter',375,'month',1),
 ('00000000-0000-4000-8000-000000000003','pro','Pro',575,'month',2)
on conflict (slug) do nothing;

insert into shorts.plan_features (plan_id,feature_key,enabled,config)
select p.id,f.key,f.enabled,f.config::jsonb from shorts.plans p
join (values
 ('free','auto_caption',false,'{}'),
 ('free','sync_to_cloud',false,'{}'),
 ('free','max_shorts',true,'{"limit":5}'),
 ('free','max_duration',true,'{"limit":60}'),
 ('free','exports',true,'{"limit":5,"resetInterval":"1 month"}'),
 ('starter','auto_caption',true,'{}'),
 ('starter','sync_to_cloud',true,'{}'),
 ('starter','max_shorts',true,'{"limit":15}'),
 ('starter','max_duration',true,'{"limit":180}'),
 ('starter','exports',true,'{"limit":null,"resetInterval":"1 month"}'),
 ('pro','auto_caption',true,'{}'),
 ('pro','sync_to_cloud',true,'{}'),
 ('pro','max_shorts',true,'{"limit":55}'),
 ('pro','max_duration',true,'{"limit":180}'),
 ('pro','exports',true,'{"limit":null,"resetInterval":"1 month"}')
) as f(slug,key,enabled,config) on f.slug=p.slug
on conflict (plan_id,feature_key) do nothing;

-- Existing users: map their enum plan to the new plan_id, open a
-- subscription row for audit history, and seed exports usage fresh
-- (design interview: reset everyone's quota on migration rather than
-- carry over builds_remaining, since there are no real paying customers
-- yet — see the /grill-me conversation this plan came from).
update shorts.users u set plan_id=p.id from shorts.plans p where u.plan_id is null and p.slug=u.plan;

insert into shorts.customer_subscriptions (id,user_id,plan_id)
select gen_random_uuid(),id,plan_id from shorts.users where plan_id is not null
on conflict do nothing;

insert into shorts.customer_feature_usage (user_id,feature_key,used,reset_at)
select id,'exports',0,now()+interval '1 month' from shorts.users where plan_id is not null
on conflict (user_id,feature_key) do nothing;

alter table shorts.users alter column plan_id set not null;
alter table shorts.users drop column if exists plan;
alter table shorts.users drop column if exists builds_remaining;
alter table shorts.users drop column if exists builds_reset_at;
