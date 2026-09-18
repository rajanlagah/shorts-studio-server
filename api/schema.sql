-- Run ONCE using Supabase SQL Editor. Tables are backend-only.
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
-- Dedicated backend login: replace this placeholder BEFORE executing.
-- Use a fresh Supabase project or review existing role/schema names first.
create role shorts_backend login password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
grant usage on schema shorts to shorts_backend;
grant select,insert,update,delete on all tables in schema shorts to shorts_backend;
-- Direct PostgreSQL roles use grants; RLS policies restricted to backend role.
create policy backend_sessions on shorts.sessions for all to shorts_backend using(true) with check(true);
create policy backend_jobs on shorts.jobs for all to shorts_backend using(true) with check(true);
