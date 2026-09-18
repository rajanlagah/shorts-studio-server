# Database migrations

Run migrations once per deployment, from `api/`, before restarting PM2.
The worker shares this database and does not run migrations separately.
Node.js 22+ is required. No extra migration package is needed.

## First setup

1. In Supabase SQL Editor, run `bootstrap.sql` after replacing its password
   placeholder. If you already ran the legacy `schema.sql`, skip this step:
   the `shorts_backend` role already exists.
2. Create the separate migration configuration:

   ```bash
   cd api
   npm ci
   cp .env.migrations.example .env.migrations
   chmod 600 .env.migrations
   ```

3. Fill `MIGRATION_DATABASE_URL` with your Supabase **admin** connection.
   For a session pooler use username `postgres.PROJECT_REF`, port `5432`,
   and the project's database password. For a direct connection use username
   `postgres`. URL-encode the password. Do not use the transaction pooler.
   Keep TLS verification enabled; the example documents an optional provider CA.
4. Run:

   ```bash
   npm run db:migrate
   ```

Keep the existing runtime `DATABASE_URL` in `api/.env` and `worker/.env` set
to the restricted `shorts_backend` role. That role cannot perform migrations.
The migration command loads `.env.migrations`, not `.env`; the admin credentials
are not used by the API or worker. The migration env file is Git-ignored.

## Existing database

The initial migration uses conditional table/index/policy creation, so it can
adopt a database created by the unmodified legacy `schema.sql` without removing
sessions or jobs or changing the backend password. If you manually changed that
schema, review those differences first: conditional creation does not reconcile
existing column or policy definitions.

## Future changes

Add SQL files under `api/migrations/`, using consecutive zero-padded names such
as `0002_add_job_index.sql`. Never edit, rename, or delete an applied migration.
Run `npm run db:migrate` after pulling code and installing dependencies, before
restarting the services. Take a database backup before destructive schema changes.

The runner records file names and SHA-256 checksums in
`shorts_migrations.history`, rejects changed or missing applied files, and skips
already applied migrations. A transaction-level advisory lock serializes runs.
All pending migrations and their history records commit together or roll back
together on error. SQL files must not contain their own transaction commands or
operations that cannot run inside a transaction, such as `CREATE INDEX CONCURRENTLY`.
There is no automatic down migration: correct deployed changes with a new file.

Migrations do not run automatically at service startup. For Docker deployment,
run this command from the checkout on a host with Node.js; the runtime image
does not include migration tooling.
