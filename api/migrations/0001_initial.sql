-- Initial schema; also adopts an existing unmodified legacy schema.sql installation.
create schema if not exists shorts;
revoke all on schema shorts from public, anon, authenticated;
create table if not exists shorts.sessions (
 id uuid primary key, token_hash text not null,
 assets jsonb not null default '[]',
 expires_at timestamptz not null default now()+interval '2 hours',
 created_at timestamptz not null default now()
);
create table if not exists shorts.jobs (
 id uuid primary key, session_id uuid not null references shorts.sessions(id) on delete cascade,
 kind text not null check(kind in ('export','transcribe')),
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 payload jsonb not null, result jsonb, error text,
 progress integer not null default 0,
 created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists jobs_queue on shorts.jobs(status,created_at);
create index if not exists jobs_session on shorts.jobs(session_id);
alter table shorts.sessions enable row level security;
alter table shorts.jobs enable row level security;

grant usage on schema shorts to shorts_backend;
grant select,insert,update,delete on all tables in schema shorts to shorts_backend;
-- Direct PostgreSQL roles use grants; RLS policies restricted to backend role.
do $$
begin
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='sessions' and policyname='backend_sessions') then
  create policy backend_sessions on shorts.sessions for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='jobs' and policyname='backend_jobs') then
  create policy backend_jobs on shorts.jobs for all to shorts_backend using(true) with check(true);
 end if;
end $$;
