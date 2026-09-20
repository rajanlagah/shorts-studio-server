-- Adds Google-authenticated user accounts and a project metadata/history layer.
create table if not exists shorts.users (
 id uuid primary key, google_sub text not null unique,
 email text not null, name text, avatar_url text,
 plan text not null default 'free' check(plan in ('free','starter','pro')),
 builds_remaining integer default 3,
 builds_reset_at timestamptz not null default now()+interval '1 month',
 created_at timestamptz not null default now()
);
create table if not exists shorts.user_tokens (
 id uuid primary key, user_id uuid not null references shorts.users(id) on delete cascade,
 token_hash text not null,
 expires_at timestamptz not null default now()+interval '30 days',
 created_at timestamptz not null default now()
);
create index if not exists user_tokens_user on shorts.user_tokens(user_id);
create table if not exists shorts.projects (
 id uuid primary key, user_id uuid not null references shorts.users(id) on delete cascade,
 title text not null default 'Untitled short',
 status text not null default 'draft' check(status in ('draft','processing','completed','failed')),
 clip_count integer not null default 0,
 duration numeric not null default 0,
 thumbnail text,
 build_charged boolean not null default false,
 session_id uuid references shorts.sessions(id) on delete set null,
 job_id uuid references shorts.jobs(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists projects_user on shorts.projects(user_id, updated_at desc);
alter table shorts.users enable row level security;
alter table shorts.user_tokens enable row level security;
alter table shorts.projects enable row level security;

grant usage on schema shorts to shorts_backend;
grant select,insert,update,delete on shorts.users,shorts.user_tokens,shorts.projects to shorts_backend;
do $$
begin
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='users' and policyname='backend_users') then
  create policy backend_users on shorts.users for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='user_tokens' and policyname='backend_user_tokens') then
  create policy backend_user_tokens on shorts.user_tokens for all to shorts_backend using(true) with check(true);
 end if;
 if not exists (select 1 from pg_policies where schemaname='shorts' and tablename='projects' and policyname='backend_projects') then
  create policy backend_projects on shorts.projects for all to shorts_backend using(true) with check(true);
 end if;
end $$;
