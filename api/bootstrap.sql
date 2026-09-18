-- Run ONCE in Supabase SQL Editor before npm run db:migrate.
-- Skip if shorts_backend already exists (for example, from schema.sql).
-- Replace the placeholder with your backend password; SQL-escape any apostrophe
-- by doubling it. Use this password, URL-encoded, in both runtime DATABASE_URLs.
create role shorts_backend login password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
