import { describe, expect, it } from "vitest";
import { migrate, migrationFiles, type Psql } from "../../src/deploy/db-apply.js";
import { databaseUrl, isLocalDatabase, localUrls, migrationSql, parseApplied, pendingMigrations, rolePasswordsSql, sha256 } from "../../src/deploy/db.js";

const file = (name: string, sql = `-- ${name}\nselect 1;\n`) => ({ name, sql });
const A = file("20261006000001_accounts.sql");
const B = file("20261007000001_tenancy.sql");
const C = file("20261008000001_billing.sql");
const applied = (...files: Array<{ name: string; sql: string }>) => files.map((f) => ({ name: f.name, sha256: sha256(f.sql) }));

describe("which migrations to apply", () => {
  it("applies everything to an empty database, oldest first, whatever order the files come in", () => {
    expect(pendingMigrations([C, A, B], []).map((f) => f.name)).toEqual([A.name, B.name, C.name]);
  });

  it("applies only what is new, and nothing when the database is up to date", () => {
    expect(pendingMigrations([A, B, C], applied(A, B))).toEqual([C]);
    expect(pendingMigrations([A, B, C], applied(A, B, C))).toEqual([]);
  });

  it("refuses an applied file that has changed: every change is a new file", () => {
    const edited = { ...B, sql: `${B.sql}alter table x add y int;\n` };
    expect(() => pendingMigrations([A, edited, C], applied(A, B))).toThrow(`${B.name} was applied to this database and has changed since`);
    // a single space is a change too: what is on the server is exactly what was applied
    expect(() => pendingMigrations([A, { ...B, sql: `${B.sql} ` }], applied(A, B))).toThrow("has changed since");
  });

  it("refuses a database that has a migration the files no longer have, and a new file dated before an applied one", () => {
    expect(() => pendingMigrations([A, C], applied(A, B))).toThrow(`the database has ${B.name}, which is no longer among the migration files`);
    expect(() => pendingMigrations([A, B, C], applied(A, C))).toThrow(`${B.name} sorts before ${C.name}, which is already applied`);
  });

  it("takes only files named like migrations", () => {
    for (const name of ["tenancy.sql", "2026_tenancy.sql", "20261007000001_Tenancy.sql", "20261007000001_tenancy.txt", "../20261007000001_x.sql"]) {
      expect(() => pendingMigrations([file(name)], []), name).toThrow("not a migration file name");
    }
  });

  it("reads the applied list as psql prints it, and refuses a line that is not one", () => {
    expect(parseApplied(`${A.name} ${sha256(A.sql)}\n${B.name} ${sha256(B.sql)}\n\n`)).toEqual(applied(A, B));
    expect(parseApplied("")).toEqual([]);
    expect(() => parseApplied("ERROR: relation does not exist")).toThrow("cannot read the list of applied migrations");
    expect(() => parseApplied(`${A.name} not-a-hash`)).toThrow("cannot read");
  });

  it("records a migration in the same transaction that applies it", () => {
    const sql = migrationSql(A);
    expect(sql.startsWith(A.sql.trimEnd())).toBe(true);
    expect(sql).toContain(`insert into public.schema_migrations (name, sha256) values ('${A.name}', '${sha256(A.sql)}');`);
  });
});

describe("applying them", () => {
  /** A database that remembers what it was told, through the same narrow door the real ones are reached by. */
  function fakeDatabase(have: Array<{ name: string; sql: string }> = []) {
    const rows = applied(...have);
    const calls: Array<{ sql: string; transaction: boolean }> = [];
    const psql: Psql = async (sql, opts = {}) => {
      calls.push({ sql, transaction: !!opts.transaction });
      if (sql.startsWith("select name")) return rows.map((r) => `${r.name} ${r.sha256}`).join("\n");
      const recorded = /values \('([^']+)', '([0-9a-f]{64})'\)/.exec(sql);
      if (recorded) rows.push({ name: recorded[1], sha256: recorded[2] });
      return "";
    };
    return { psql, calls, rows };
  }

  it("makes the record table first, then applies each pending file in a transaction of its own", async () => {
    const db = fakeDatabase([A]);
    expect(await migrate(db.psql, [A, B, C])).toEqual([B.name, C.name]);
    expect(db.calls[1].sql).toContain("create table if not exists public.schema_migrations");
    expect(db.calls.filter((c) => c.transaction).map((c) => c.sql.split("\n")[0])).toEqual([`-- ${B.name}`, `-- ${C.name}`]);
    // and a second run finds nothing to do
    expect(await migrate(db.psql, [A, B, C])).toEqual([]);
  });

  it("waits for a database that is still starting, and gives up with its own words when it never comes", async () => {
    const db = fakeDatabase();
    let refusals = 3;
    const slow: Psql = async (sql, opts) => {
      if (refusals-- > 0) throw new Error('FATAL:  database "flowchain" does not exist');
      return db.psql(sql, opts);
    };
    expect(await migrate(slow, [A], { pauseMs: 1 })).toEqual([A.name]);
    await expect(migrate(async () => { throw new Error("FATAL:  the database system is starting up"); }, [A], { waitMs: 20, pauseMs: 5 })).rejects.toThrow("starting up");
  });

  it("applies nothing at all when the database and the files disagree", async () => {
    const db = fakeDatabase([A, B]);
    await expect(migrate(db.psql, [A, { ...B, sql: "-- changed\n" }, C])).rejects.toThrow("has changed since");
    expect(db.calls.some((c) => c.transaction)).toBe(false);
  });

  it("the repository's own files are named, ordered and readable as migrations", () => {
    const files = migrationFiles();
    expect(files.map((f) => f.name)).toEqual(["20261006000001_accounts.sql", "20261007000001_tenancy.sql", "20261008000001_billing.sql"]);
    expect(pendingMigrations(files, []).length).toBe(3);
    // no secret is ever in a migration: roles get their passwords from the setup command
    for (const f of files) expect(f.sql, f.name).not.toMatch(/\bpassword\s+'/i);
  });
});

describe("addresses and passwords", () => {
  it("sets the two service roles' passwords, and takes only passwords that need no quoting", () => {
    expect(rolePasswordsSql({ web: "web-password-0123456789ab", worker: "worker-password-012345678" })).toBe(
      "alter role studio_web login password 'web-password-0123456789ab';\nalter role studio_worker login password 'worker-password-012345678';\n",
    );
    for (const bad of ["short", "has'quote-0123456789abcdef", "has space 0123456789abcdef", "semi;colon-0123456789abcdef"]) {
      expect(() => rolePasswordsSql({ web: bad, worker: "worker-password-012345678" }), bad).toThrow("a database password must be");
    }
  });

  it("builds each role's address, and knows the local database from any other", () => {
    expect(databaseUrl("studio_web", "p-w_1", "db:5432")).toBe("postgres://studio_web:p-w_1@db:5432/flowchain");
    const local = localUrls();
    expect(new Set(Object.values(local)).size).toBe(3);
    for (const url of Object.values(local)) expect(isLocalDatabase(url)).toBe(true);
    expect(isLocalDatabase("postgres://studio_web:x@db:5432/flowchain")).toBe(false);
  });
});
