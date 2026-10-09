import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";

/*
 * The two emails the studio sends: the link that confirms an address, and the link to choose a new password
 * (phase 5 spec §4.2). They go out through whatever SMTP service the owner set (`SMTP_URL`, `MAIL_FROM`).
 * A test or a developer can have them written to a folder instead (`MAIL_DIR`) and read the link there.
 */

/**
 * Whether the studio can reach a mailbox. Where it cannot, an address is taken at its word and an account works
 * at once: right for a studio on the owner's own machine, and refused on a server by the setup command, since
 * an unconfirmed sign-up is how a welcome credit would be farmed.
 */
export const mailOn = (): boolean => !!process.env.SMTP_URL?.trim() || !!process.env.MAIL_DIR?.trim();

export type Mail = { to: string; subject: string; text: string; link: string };

const texts = {
  confirm: (link: string): Omit<Mail, "to" | "link"> => ({
    subject: "Confirm your email address for Flow Chain",
    text: `Open this link to confirm your email address and finish creating your Flow Chain account:\n\n${link}\n\nIt works for one day, in the browser you signed up with. If you did not sign up, ignore this email: nothing happens without the link.\n`,
  }),
  reset: (link: string): Omit<Mail, "to" | "link"> => ({
    subject: "Choose a new password for Flow Chain",
    text: `Open this link to choose a new password for your Flow Chain account:\n\n${link}\n\nIt works for one hour, in the browser you asked from. If you did not ask for it, ignore this email: your password stays as it is.\n`,
  }),
};

let transport: { url: string; send: Transporter } | undefined;

/** Sends one of the two emails. Throws when it could not be handed over; the caller decides what the visitor is told. */
export async function sendLink(kind: keyof typeof texts, to: string, link: string): Promise<void> {
  const mail: Mail = { to, link, ...texts[kind](link) };
  const dir = process.env.MAIL_DIR?.trim();
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ kind, ...mail }));
    return;
  }
  const url = process.env.SMTP_URL?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!url || !from) throw new Error("SMTP_URL and MAIL_FROM must both be set to send email");
  if (transport?.url !== url) transport = { url, send: nodemailer.createTransport(url) };
  await transport.send.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
}
