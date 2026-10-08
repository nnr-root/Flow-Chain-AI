/* The pure parts of `npm run studio:grant` and `npm run db:migrate`: reading what the owner typed. */

export type Grant = { email: string; usd: number; note: string };

/** `--email <address> --usd <amount> [--note <text>]`. A negative amount takes credit back. */
export function parseGrant(argv: string[]): Grant {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const known = new Set(["--email", "--usd", "--note"]);
  const unknown = argv.filter((a, i) => a.startsWith("--") && !known.has(a) && !known.has(argv[i - 1] ?? ""));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(" ")}`);
  const email = value("--email")?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email must be the account's email address");
  const raw = value("--usd");
  const usd = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(usd) || usd === 0) throw new Error("--usd must be an amount other than 0 (for example 5, or -2.50 to take credit back)");
  if (Math.abs(usd) > 1000) throw new Error("--usd is more than $1000: grant it in smaller steps if that is really meant");
  return { email, usd: Math.round(usd * 10_000) / 10_000, note: value("--note")?.trim() ?? "" };
}

/** The project the admin commands act on: from `.env`, and `deploy/server.env` where it says otherwise. */
export function adminProject(env: Record<string, string | undefined>): { url: string; serviceKey: string } {
  const url = env.SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (in .env or deploy/server.env)");
  return { url, serviceKey };
}
