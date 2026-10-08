/**
 * npm run studio:grant -- --email <address> --usd <amount> [--note <text>]: adds credit to an account.
 * npm run db:migrate: applies supabase/migrations/ to the project's database (SUPABASE_DB_URL).
 * Both act on the Supabase project named in .env (deploy/server.env overrides it), with the service role.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { execa } from "execa";
import { adminProject, parseGrant } from "../src/deploy/studio-admin.js";

function readEnv(path: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const env = { ...readEnv(".env"), ...readEnv("deploy/server.env"), ...process.env };
  if (command === "grant") {
    const grant = parseGrant(args);
    const { url, serviceKey } = adminProject(env);
    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.rpc("grant_credit", { p_email: grant.email, p_amount_usd: grant.usd, p_note: grant.note });
    if (error) throw new Error(error.message === "not_found" ? `no account with the address ${grant.email} (they must sign up first)` : error.message);
    console.log(`${grant.usd > 0 ? "Added" : "Took back"} $${Math.abs(grant.usd).toFixed(2)}: ${grant.email} now has $${Number(data).toFixed(4)}.`);
    return;
  }
  if (command === "migrate") {
    const dbUrl = env.SUPABASE_DB_URL?.trim();
    if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set: the project's connection string (Supabase dashboard → Connect), in .env");
    // the connection string holds the database password: it goes in the environment, never on the command line
    await execa("sh", ["-c", 'exec npx supabase db push --db-url "$SUPABASE_DB_URL"'], { env: { ...process.env, SUPABASE_DB_URL: dbUrl }, stdio: "inherit" });
    return;
  }
  console.error("usage: npm run studio:grant -- --email <address> --usd <amount> [--note <text>] | npm run db:migrate");
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
