import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/*
 * Passwords and the secrets in cookies and emailed links (phase 5 spec §4.2). A password is kept as an scrypt
 * hash with its own salt and its parameters beside it, so they can be raised later without locking anyone out.
 * A session or a link is a random secret; the database keeps only its SHA-256.
 */

/** 2^15 rounds of 8 KiB blocks: about 32 MB and a tenth of a second per check on a server's core. */
const COST = { N: 1 << 15, r: 8, p: 1 };
const KEY_BYTES = 32;

const derive = (password: string, salt: Buffer, cost: typeof COST): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // NFKC: the same password typed on another keyboard or phone is the same bytes
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { ...cost, maxmem: 256 * cost.N * cost.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Whether `password` is the one `stored` was made from. A stored value that is not one of ours matches nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  // (bounded: a stored value must never be able to ask for more work or memory than this process can give)
  const sane = scheme === "scrypt" && Number.isInteger(cost.N) && cost.N >= 1 << 14 && cost.N <= 1 << 18 && (cost.N & (cost.N - 1)) === 0 && cost.r === 8 && cost.p === 1 && !!salt && !!key;
  if (!sane) return false;
  const expected = Buffer.from(key, "base64url");
  if (expected.length !== KEY_BYTES) return false;
  return timingSafeEqual(await derive(password, Buffer.from(salt, "base64url"), cost), expected);
}

/**
 * Does the work of a check against nothing. Signing in with an address that has no account must take as long as
 * signing in with a wrong password: otherwise the time it takes says which addresses have accounts.
 */
export async function spendCheck(password: string): Promise<void> {
  await derive(password, Buffer.alloc(16), COST);
}

/** A secret for a cookie or a link: 256 random bits, safe in a URL. */
export const newSecret = (): string => randomBytes(32).toString("base64url");

/** What the database keeps of a secret. */
export const hashOf = (secret: string): Buffer => createHash("sha256").update(secret).digest();
