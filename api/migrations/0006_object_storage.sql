-- Durable footage/exports in object storage (Backblaze B2 via the S3 API) +
-- per-user storage quotas. See plans/013-backend-object-storage-and-quotas.md
-- (frontend repo). Additive only: safe to apply before the code ships. The
-- Free sync_to_cloud flip is 0007, applied at deploy time.

create table if not exists shorts.assets (
 id uuid primary key,
 -- restrict, not cascade: a user row must never vanish and orphan objects.
 user_id uuid not null references shorts.users(id) on delete restrict,
 project_id uuid references shorts.projects(id) on delete set null,
 kind text not null check(kind in ('source','export')),
 provider text not null, bucket text not null, object_key text not null unique,
 upload_id text,
 declared_bytes bigint not null,
 -- Reserved (= declared) while pending, the verified size afterwards.
 bytes bigint not null,
 content_type text,
 status text not null default 'pending'
   check(status in ('pending','uploaded','ready','failed','deleting','deleted')),
 holder text not null default 'user' check(holder in ('user','internal')),
 retained_reason text check(retained_reason in ('over_quota')),
 retained_at timestamptz,
 community_shareable boolean,
 job_id uuid,
 duration numeric, width integer, height integer, has_audio boolean,
 created_at timestamptz not null default now(),
 ready_at timestamptz, deleted_at timestamptz
);
create index if not exists assets_user on shorts.assets(user_id, status, holder);
create index if not exists assets_project on shorts.assets(project_id, kind, created_at desc);
create index if not exists assets_status on shorts.assets(status, created_at);

-- Append-only history of every change in counted bytes. For any user,
-- sum(delta_bytes where holder='user') equals their counted usage.
create table if not exists shorts.storage_events (
 id bigserial primary key,
 user_id uuid not null, project_id uuid, asset_id uuid not null,
 delta_bytes bigint not null,
 holder text not null check(holder in ('user','internal')),
 reason text not null check(reason in ('reserve','verify','release','delete','internalize')),
 created_at timestamptz not null default now()
);
create index if not exists storage_events_user on shorts.storage_events(user_id, created_at);

alter table shorts.users add column if not exists community_sharing boolean not null default true;
alter table shorts.users add column if not exists over_quota_since timestamptz;
alter table shorts.projects add column if not exists holder text not null default 'user'
  check(holder in ('user','internal'));
alter table shorts.projects add column if not exists retained_at timestamptz;

-- Project-scoped jobs; session jobs keep working until plan 014 ships.
alter table shorts.jobs alter column session_id drop not null;
alter table shorts.jobs add column if not exists project_id uuid references shorts.projects(id) on delete cascade;
alter table shorts.jobs add column if not exists user_id uuid references shorts.users(id) on delete cascade;
alter table shorts.jobs drop constraint if exists jobs_kind_check;
alter table shorts.jobs add constraint jobs_kind_check check(kind in ('export','transcribe','probe'));
alter table shorts.jobs drop constraint if exists jobs_owner;
alter table shorts.jobs add constraint jobs_owner check(session_id is not null or project_id is not null);
create index if not exists jobs_project on shorts.jobs(project_id);
create index if not exists jobs_user on shorts.jobs(user_id, status);

insert into shorts.features (key,label,value_type,sort_order) values
 ('storage_bytes','Cloud storage','limit',5),
 ('community_opt_out','Keep shorts out of the community showcase','boolean',6)
on conflict (key) do nothing;
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

alter table shorts.assets enable row level security;
alter table shorts.storage_events enable row level security;
grant select,insert,update,delete on shorts.assets,shorts.storage_events to shorts_backend;
grant usage on sequence shorts.storage_events_id_seq to shorts_backend;
do $$
begin
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='assets' and policyname='backend_assets') then
  create policy backend_assets on shorts.assets for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='storage_events' and policyname='backend_storage_events') then
  create policy backend_storage_events on shorts.storage_events for all to shorts_backend using(true) with check(true);
 end if;
end $$;
