/* The pure parts of `npm run studio:grant` and `studio:welcome`: reading what the owner typed, and the SQL it becomes. */

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

/**
 * The grant as SQL for `psql`: one statement, printing the new balance. The address and the note are text the
 * owner typed, so each travels inside a dollar-quoted string whose tag is chosen not to occur in it — nothing
 * in them can end the string, whatever they contain.
 */
export function grantSql(grant: Grant): string {
  const quoted = (text: string): string => {
    let tag = "q";
    while (text.includes(`$${tag}$`)) tag += "q";
    return `$${tag}$${text}$${tag}$`;
  };
  if (!Number.isFinite(grant.usd)) throw new Error("not an amount");
  return `select public.grant_credit(${quoted(grant.email)}, ${grant.usd.toFixed(4)}::numeric, ${quoted(grant.note)});\n`;
}

/** What the database said when it refused, in the owner's words. */
export function grantRefusal(stderr: string, grant: Grant): string | null {
  if (/\bnot_found\b/.test(stderr)) return `no account with the address ${grant.email} (they must sign up first)`;
  if (/\binvalid_amount\b/.test(stderr)) return "the amount must be a number other than 0, to four decimals at most";
  return null;
}

export type Welcome = { usd: number; capUsd?: number };

/** `--usd <amount> [--cap <amount>]`: what a new account is given once its address is confirmed (0 = nothing), and the most given away in a day. */
export function parseWelcome(argv: string[]): Welcome {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const known = new Set(["--usd", "--cap"]);
  const unknown = argv.filter((a, i) => a.startsWith("--") && !known.has(a) && !known.has(argv[i - 1] ?? ""));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(" ")}`);
  const amount = (flag: string, max: number): number | undefined => {
    const raw = value(flag);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > max) throw new Error(`${flag} must be an amount from 0 to ${max}`);
    return Math.round(n * 10_000) / 10_000;
  };
  // (the database itself refuses more than $5 a new account: a slip here must not give credit for clips away)
  const usd = amount("--usd", 5);
  if (usd === undefined) throw new Error("--usd must be given: what a new account starts with (0 turns it off; 0.05 covers a couple of script drafts)");
  const capUsd = amount("--cap", 1000);
  return { usd, ...(capUsd === undefined ? {} : { capUsd }) };
}

/** Sets it, and prints what the setting is now as `welcome cap`. Both values are numbers this code made: nothing typed reaches the SQL. */
export function welcomeSql(welcome: Welcome): string {
  const sets = [`welcome_credit_usd = ${welcome.usd.toFixed(4)}`, ...(welcome.capUsd === undefined ? [] : [`welcome_daily_cap_usd = ${welcome.capUsd.toFixed(4)}`])];
  return `update public.settings set ${sets.join(", ")} returning welcome_credit_usd || ' ' || welcome_daily_cap_usd;\n`;
}
