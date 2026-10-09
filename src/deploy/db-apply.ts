import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type MigrationFile, MIGRATIONS_TABLE, migrationSql, parseApplied, pendingMigrations, rolePasswordsSql } from "./db.js";

/*
 * Applying migrations (phase 5 spec §4.2). The database is always reached through `psql` inside its own
 * container — on this machine with `docker exec`, on the server with `docker compose exec` over ssh — so the
 * same steps run in both places, and the owner's password never leaves the machine the database is on.
 */

/** Runs SQL (given on stdin) and returns what it printed. `tuples`: rows only, unaligned. `transaction`: all or nothing. */
export type Psql = (sql: string, opts?: { tuples?: boolean; transaction?: boolean }) => Promise<string>;

export const MIGRATIONS_DIR = "db/migrations";

export function migrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies what is pending, each file in a transaction of its own with its record. Returns the names applied. */
export async function migrate(psql: Psql, files: MigrationFile[], opts: { waitMs?: number; pauseMs?: number } = {}): Promise<string[]> {
  // A database container that has just been started answers before it has finished making its database (it
  // sets itself up once, then starts again): the first statement is tried until it is really there.
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  for (;;) {
    try {
      await psql("select 1;");
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1000));
    }
  }
  await psql(MIGRATIONS_TABLE);
  const applied = parseApplied(await psql("select name || ' ' || sha256 from public.schema_migrations order by name;", { tuples: true }));
  const pending = pendingMigrations(files, applied);
  for (const file of pending) await psql(migrationSql(file), { transaction: true });
  return pending.map((f) => f.name);
}

export async function setRolePasswords(psql: Psql, passwords: { web: string; worker: string }): Promise<void> {
  await psql(rolePasswordsSql(passwords));
}
