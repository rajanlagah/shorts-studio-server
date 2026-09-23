-- www.shortmonk.com sign-in handoff + public plan catalog fields. See
-- plans/008-backend-handoff-login-and-public-plans.md (frontend repo).

-- Whether a user can get onto this plan from the UI today. Phase 1 (no
-- payments yet): only Free.
alter table shorts.plans add column if not exists is_available boolean not null default false;
update shorts.plans set is_available = true where slug = 'free';

-- Display order of features on pricing cards.
alter table shorts.features add column if not exists sort_order integer not null default 0;
update shorts.features set sort_order = x.n from (values
 ('exports',0),('max_shorts',1),('max_duration',2),('auto_caption',3),('sync_to_cloud',4)
) as x(key,n) where shorts.features.key = x.key;

-- One-time codes that carry a www sign-in over to the app. Only the hash is
-- stored; a code is consumed atomically by DELETE ... RETURNING.
create table if not exists shorts.auth_handoff_codes (
 code_hash text primary key,
 user_id uuid not null references shorts.users(id) on delete cascade,
 expires_at timestamptz not null default now() + interval '60 seconds',
 created_at timestamptz not null default now()
);
create index if not exists auth_handoff_codes_expires on shorts.auth_handoff_codes(expires_at);

alter table shorts.auth_handoff_codes enable row level security;
grant select,insert,update,delete on shorts.auth_handoff_codes to shorts_backend;
do $$
begin
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='auth_handoff_codes' and policyname='backend_auth_handoff_codes') then
  create policy backend_auth_handoff_codes on shorts.auth_handoff_codes for all to shorts_backend using(true) with check(true);
 end if;
end $$;
