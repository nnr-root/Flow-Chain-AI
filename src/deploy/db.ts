import { createHash } from "node:crypto";

/* The pure parts of the database commands (phase 5 spec §4.2): which migrations to apply, and the SQL that applies them. */

export type MigrationFile = { name: string; sql: string };
export type Applied = { name: string; sha256: string };

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const FILE = /^\d{14}_[a-z0-9_]+\.sql$/;

/** The table that remembers what was applied. Made by the first command that needs it. */
export const MIGRATIONS_TABLE = `create table if not exists public.schema_migrations (
  name text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now()
);`;

/** Reads the applied list as `psql -At` prints it: one `name sha256` line each. */
export function parseApplied(text: string): Applied[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, hash] = line.split(/\s+/);
    if (!FILE.test(name) || !/^[0-9a-f]{64}$/.test(hash ?? "")) throw new Error(`cannot read the list of applied migrations: ${JSON.stringify(line)}`);
    return { name, sha256: hash };
  });
}

/**
 * The files still to apply, oldest first. A database that has migrations is never guessed at: a file that was
 * applied and has since changed, one that was applied and is gone, or a new file that sorts before one already
 * applied, is refused — an applied migration is frozen, and every change is a new file.
 */
export function pendingMigrations(files: MigrationFile[], applied: Applied[]): MigrationFile[] {
  for (const file of files) if (!FILE.test(file.name)) throw new Error(`not a migration file name: ${file.name} (expected 14 digits, an underscore, a name, .sql)`);
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const done = new Map(applied.map((a) => [a.name, a.sha256]));
  for (const a of applied) {
    const file = sorted.find((f) => f.name === a.name);
    if (!file) throw new Error(`the database has ${a.name}, which is no longer among the migration files`);
    if (sha256(file.sql) !== a.sha256) throw new Error(`${a.name} was applied to this database and has changed since: an applied migration is never edited; put the change in a new file`);
  }
  const pending = sorted.filter((f) => !done.has(f.name));
  const last = applied.map((a) => a.name).sort().at(-1);
  const early = last ? pending.find((f) => f.name < last) : undefined;
  if (early) throw new Error(`${early.name} sorts before ${last}, which is already applied: give it a later date`);
  return pending;
}

/** One migration and the record of it, to be run as a single transaction (`psql --single-transaction`). */
export function migrationSql(file: MigrationFile): string {
  return `${file.sql.trimEnd()}\n\ninsert into public.schema_migrations (name, sha256) values ('${file.name}', '${sha256(file.sql)}');\n`;
}

/** The two roles the services connect as (they exist once the first migration ran) and their passwords. */
export function rolePasswordsSql(passwords: { web: string; worker: string }): string {
  for (const value of Object.values(passwords)) {
    // made by this code, never typed: letters, digits, - and _ only, so it needs no quoting anywhere it travels
    if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) throw new Error("a database password must be at least 16 letters, digits, - or _");
  }
  return `alter role studio_web login password '${passwords.web}';\nalter role studio_worker login password '${passwords.worker}';\n`;
}

/** A service's address of the database. */
export function databaseUrl(role: "studio_web" | "studio_worker" | "postgres", password: string, host: string, database = "flowchain"): string {
  return `postgres://${role}:${encodeURIComponent(password)}@${host}/${database}`;
}

/** The database a developer and the tests use: a container on this machine, with fixed passwords that protect nothing. */
export const LOCAL_DB = {
  container: "flowchain-db",
  image: "postgres:17",
  port: 54330,
  database: "flowchain",
  passwords: { owner: "flowchain-local-owner", web: "flowchain-local-web", worker: "flowchain-local-worker" },
} as const;

export const localUrls = (database: string = LOCAL_DB.database) => {
  const host = `127.0.0.1:${LOCAL_DB.port}`;
  return {
    owner: databaseUrl("postgres", LOCAL_DB.passwords.owner, host, database),
    web: databaseUrl("studio_web", LOCAL_DB.passwords.web, host, database),
    worker: databaseUrl("studio_worker", LOCAL_DB.passwords.worker, host, database),
  };
};

/** Whether an address is the local container's: the commands that wipe or seed refuse anything else. */
export function isLocalDatabase(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return /^postgres(ql)?:$/.test(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.port === String(LOCAL_DB.port);
}
