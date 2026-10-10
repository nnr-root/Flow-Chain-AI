import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * How a channel's token is kept (phase 6 spec §6): sealed with a key that exists in the worker's environment
 * only (`CHANNEL_KEY`, 32 bytes in base64). The database holds the sealed bytes; the web app can read neither
 * them nor the key. AES-256-GCM, so a sealed token that was changed or swapped for another user's does not open:
 * what it was sealed for (the user's id) is part of what is checked.
 */

const key = (): Buffer => {
  const raw = Buffer.from(process.env.CHANNEL_KEY?.trim() ?? "", "base64");
  if (raw.length !== 32) throw new Error("CHANNEL_KEY is not set, or is not 32 bytes in base64: this worker cannot keep or open a channel's token");
  return raw;
};

/** Whether this worker can keep and open tokens at all. */
export const vaultReady = (): boolean => Buffer.from(process.env.CHANNEL_KEY?.trim() ?? "", "base64").length === 32;

/** Seals `secret` for `owner` (the user's id): nonce (12), tag (16), ciphertext. */
export function seal(secret: string, owner: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(owner));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

/** Opens what `seal` made for the same owner; throws when it was sealed for someone else, with another key, or changed. */
export function open(sealed: Buffer, owner: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
}
