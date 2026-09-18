import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  console.error('Set MIGRATION_DATABASE_URL in api/.env.migrations (see .env.migrations.example).');
  process.exit(1);
}

const directory = new URL('../migrations/', import.meta.url);
const files = readdirSync(directory).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
const migrations = files.map(name => {
  const sql = readFileSync(new URL(name, directory), 'utf8');
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
});
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 15000,
  ...(process.env.MIGRATION_PG_CA_FILE ? {
    ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.MIGRATION_PG_CA_FILE, 'utf8') },
  } : {}),
});

try {
  await client.connect();
  // One transaction and connection: lock, DDL, and history commit together.
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query("SELECT pg_advisory_xact_lock(1936224114, 1)");
  await client.query('CREATE SCHEMA IF NOT EXISTS shorts_migrations');
  await client.query('REVOKE ALL ON SCHEMA shorts_migrations FROM PUBLIC, anon, authenticated, shorts_backend');
  await client.query(`CREATE TABLE IF NOT EXISTS shorts_migrations.history (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query('SELECT name, checksum FROM shorts_migrations.history ORDER BY name');
  // Applied files must remain an unchanged prefix of the migration sequence.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].name !== migrations[i]?.name || rows[i].checksum !== migrations[i]?.checksum) {
      throw new Error(`Migration history mismatch at ${rows[i].name}; restore applied files and append new migrations.`);
    }
  }
  const pending = migrations.slice(rows.length);
  for (const migration of pending) {
    console.log(`Applying ${migration.name}`);
    await client.query(migration.sql);
    await client.query('INSERT INTO shorts_migrations.history (name, checksum) VALUES ($1, $2)',
      [migration.name, migration.checksum]);
  }
  await client.query('COMMIT');
  console.log(pending.length ? `Applied ${pending.length} migration(s).` : 'Database is up to date.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // Do not print connection strings or raw server errors that could contain secrets.
  console.error('Migration failed; transaction rolled back. Check admin credentials, backend-role setup, and SQL files.');
  if (error.message.startsWith('Migration history mismatch')) console.error(error.message);
  if (error.code) console.error(`PostgreSQL/error code: ${error.code}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
