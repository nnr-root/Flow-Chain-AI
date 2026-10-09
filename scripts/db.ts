/**
 * npm run db:start | db:stop | db:reset — the studio's database on this machine: Postgres in a container, for
 * development and the tests (phase 5 spec §4.2). Nothing here can reach a server: every command acts on the
 * local container by name.
 */
import { execa } from "execa";
import { migrate, migrationFiles, type Psql, setRolePasswords } from "../src/deploy/db-apply.js";
import { LOCAL_DB, localUrls } from "../src/deploy/db.js";

const { container, image, port, database, passwords } = LOCAL_DB;

const docker = async (args: string[], input?: string): Promise<string> => (await execa("docker", args, { input: input ?? "", stderr: "pipe" })).stdout;

const psqlIn = (db: string): Psql => async (sql, opts = {}) =>
  docker(["exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", ...(opts.tuples ? ["-At"] : []), ...(opts.transaction ? ["--single-transaction"] : [])], sql);

async function state(): Promise<"running" | "stopped" | "absent"> {
  const out = await docker(["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.State}}"]).catch(() => "");
  return out.trim() === "running" ? "running" : out.trim() ? "stopped" : "absent";
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // asked over TCP: the server first starts once on a socket only, to set itself up, and is not there yet
    if (await docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", database]).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the local database did not come up within a minute (docker logs flowchain-db)");
}

async function start(): Promise<void> {
  const now = await state();
  if (now === "absent") {
    // bound to this machine only; the volume keeps the data across restarts of the container
    await docker(["run", "-d", "--name", container, "-e", `POSTGRES_PASSWORD=${passwords.owner}`, "-e", `POSTGRES_DB=${database}`,
      "-p", `127.0.0.1:${port}:5432`, "-v", `${container}:/var/lib/postgresql/data`, image]);
  } else if (now === "stopped") await docker(["start", container]);
  await ready();
  await apply();
}

async function apply(): Promise<void> {
  const applied = await migrate(psqlIn(database), migrationFiles());
  await setRolePasswords(psqlIn(database), passwords);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "The database is up to date.");
}

async function reset(): Promise<void> {
  if ((await state()) !== "running") await start();
  const admin = psqlIn("postgres");
  await admin(`drop database if exists ${database} with (force);`);
  await admin(`create database ${database};`);
  await apply();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "start") {
    await start();
    console.log(`The local database is running on 127.0.0.1:${port} (${localUrls().owner.replace(/:[^:@]+@/, ":…@")}).`);
  } else if (command === "stop") {
    if ((await state()) === "running") await docker(["stop", container]);
    console.log("The local database is stopped (its data is kept).");
  } else if (command === "reset") {
    await reset();
    console.log("The local database was emptied and loaded again from db/migrations/.");
  } else {
    console.error("usage: npm run db:start | db:stop | db:reset");
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  const e = err as { stderr?: string; message?: string };
  console.error(e.stderr?.trim() || e.message || String(err));
  process.exit(1);
});
