import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@src/db/client";
import { normalizeHashtags } from "@src/hashtags";
import { runFolder } from "../server/jobs/run-cli";
import { UUID } from "../server/tenant";
import { open, seal, vaultReady } from "./vault";

/*
 * The worker's side of publishing (phase 6 spec §6, §10): it alone exchanges a consent for a token, keeps the
 * token sealed, opens it, and uploads. A user's video goes to that user's own channel, in their name, because
 * they connected it on the platform's own consent page; the studio never asks for a password.
 *
 * Nothing that reaches this file through Redis is taken at its word: a post is looked up in the database, and
 * its run, its channel and its user must agree before anything is opened or sent.
 */

const GOOGLE_TOKEN = () => process.env.GOOGLE_TOKEN_URL?.trim() || "https://oauth2.googleapis.com/token";
/** (a test's stand-in answers here instead) */
const YOUTUBE = () => (process.env.YOUTUBE_API_BASE?.trim() || "https://www.googleapis.com").replace(/\/$/, "");

/** What is asked of the user at the consent page: to upload videos, and to read which channel it is. Nothing else. */
export const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

/** Something that went wrong in a way the user can be told, in the studio's own words. */
export class PublishRefused extends Error {}

export type Publisher = {
  /** Finishes connecting a channel: exchanges the consent's code and keeps what comes back, sealed. Returns the channel's name. */
  connect(userId: string, code: string, verifier: string, redirectUri: string): Promise<string>;
  /** Carries out a post: uploads the run's video to the channel. Records what became of it; never throws for a refusal. */
  post(postId: string): Promise<"posted" | "failed" | "skipped">;
  /**
   * Carries out the posts that have waited longer than `olderMs` for users whose files are on this disk: one
   * whose job never arrived (the queue was away when it was asked for) is not left waiting for ever.
   */
  sweep(olderMs: number, here: (userId: string) => boolean): Promise<void>;
};

type TokenAnswer = { access_token?: unknown; refresh_token?: unknown; scope?: unknown };

export function publisher(db: Db, asUser: <T>(userId: string, work: () => Promise<T>) => Promise<T>, log: (message: string) => void): Publisher | null {
  const id = process.env.YOUTUBE_CLIENT_ID?.trim();
  const secret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
  // without the client and the key this worker publishes nothing, and says so once where the owner reads
  if (!id || !secret || !vaultReady()) return null;

  const token = async (form: Record<string, string>): Promise<TokenAnswer> => {
    const res = await fetch(GOOGLE_TOKEN(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, ...form }) });
    if (!res.ok) {
      // (the platform's own words stay in the worker's log; `invalid_grant` is the user having withdrawn the consent)
      const said = await res.text().catch(() => "");
      log(`worker: the token endpoint answered ${res.status}`);
      throw new PublishRefused(/invalid_grant/.test(said) ? "The channel is no longer connected. Connect it again on your account page." : "The channel could not be reached. Try again in a moment.");
    }
    return (await res.json()) as TokenAnswer;
  };

  async function connect(userId: string, code: string, verifier: string, redirectUri: string): Promise<string> {
    if (!UUID.test(userId)) throw new Error("the request names no user");
    const got = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
    // Without a refresh token nothing can be posted later; without the upload scope nothing at all. (A user can
    // untick a permission on the consent page.)
    if (typeof got.access_token !== "string" || typeof got.refresh_token !== "string") throw new PublishRefused("The channel gave no lasting permission. Connect it again and allow what is asked.");
    if (typeof got.scope === "string" && !got.scope.split(" ").includes("https://www.googleapis.com/auth/youtube.upload")) throw new PublishRefused("Uploading was not allowed. Connect the channel again and allow it.");
    const res = await fetch(`${YOUTUBE()}/youtube/v3/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${got.access_token}` } });
    if (!res.ok) throw new PublishRefused("The channel could not be read. Try again in a moment.");
    const channel = ((await res.json()) as { items?: Array<{ id?: unknown; snippet?: { title?: unknown } }> }).items?.[0];
    if (!channel || typeof channel.id !== "string") throw new PublishRefused("That Google account has no YouTube channel yet. Create one on YouTube, then connect it.");
    const title = typeof channel.snippet?.title === "string" ? channel.snippet.title : "";
    const { error } = await db.rpc("link_channel", { p_user_id: userId, p_provider: "youtube", p_external_id: channel.id, p_title: title, p_token: seal(got.refresh_token, userId) });
    if (error) throw error.message === "too_many_channels" ? new PublishRefused("An account can have five channels connected. Remove one first.") : new Error(`link_channel: ${error.message}`);
    log(`worker: connected a channel for ${userId}`);
    return title;
  }

  /** What a run is called and about, from its own manifest. */
  const about = (runId: string): { title: string; topic: string; hashtags: string[] } => {
    try {
      const m = JSON.parse(readFileSync(join(runFolder(runId), "manifest.json"), "utf8")) as { script?: { title?: unknown; hashtags?: unknown }; request?: { topic?: unknown } };
      // (the script's hashtags, put right once more: the manifest is a file, and what is posted goes out under the user's name)
      const hashtags = Array.isArray(m.script?.hashtags) ? normalizeHashtags(m.script.hashtags.filter((t): t is string => typeof t === "string")) : [];
      return { title: typeof m.script?.title === "string" ? m.script.title : "", topic: typeof m.request?.topic === "string" ? m.request.topic : "", hashtags };
    } catch {
      return { title: "", topic: "", hashtags: [] };
    }
  };

  async function upload(access: string, file: string, title: string, hashtags: string[]): Promise<string> {
    const meta = {
      // a title is at most 100 characters there, and may carry neither of these two signs. The description is the
      // video's hashtags (phase 7 spec §18) and the one that tells the platform it is a short; its tags are the
      // same words without the sign.
      snippet: {
        title: (title || "Untitled").replace(/[<>]/g, "").slice(0, 100),
        description: [...hashtags, "#Shorts"].join(" "),
        ...(hashtags.length ? { tags: hashtags.map((t) => t.slice(1)) } : {}),
        categoryId: "22",
      },
      // (made with generated pictures and voice: said to the platform, as its rules ask)
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    };
    const size = statSync(file).size;
    const begin = await fetch(`${YOUTUBE()}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "video/mp4", "x-upload-content-length": String(size) },
      body: JSON.stringify(meta),
    });
    const session = begin.headers.get("location");
    if (!begin.ok || !session) {
      log(`worker: an upload could not be begun (${begin.status})`);
      throw new PublishRefused(begin.status === 403 ? "YouTube refused the upload (the day's uploads may be used up). Try again tomorrow." : "YouTube did not take the upload. Try again in a moment.");
    }
    const sent = await fetch(session, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(size) }, body: await readFile(file) });
    const made = sent.ok ? ((await sent.json().catch(() => ({}))) as { id?: unknown }) : {};
    if (typeof made.id !== "string" || !/^[\w-]{5,20}$/.test(made.id)) {
      log(`worker: an upload was not finished (${sent.status})`);
      throw new PublishRefused("YouTube did not finish the upload. Try again in a moment.");
    }
    return made.id;
  }

  /** The posts being carried out right now: a post asked for twice (its job, and the sweep) is uploaded once. */
  const sending = new Set<string>();
  async function post(postId: string): Promise<"posted" | "failed" | "skipped"> {
    if (!UUID.test(postId) || sending.has(postId)) return "skipped";
    sending.add(postId);
    try {
      return await carryOut(postId);
    } finally {
      sending.delete(postId);
    }
  }

  async function sweep(olderMs: number, here: (userId: string) => boolean): Promise<void> {
    const { data, error } = await db.from("posts").select("id,user_id").eq("status", "queued").lt("created_at", new Date(Date.now() - olderMs).toISOString());
    if (error) throw new Error(`listing waiting posts: ${error.message}`);
    for (const p of (data ?? []) as Array<{ id: string; user_id: string }>) if (here(p.user_id)) await post(p.id);
  }

  async function carryOut(postId: string): Promise<"posted" | "failed" | "skipped"> {
    const found = await db.from("posts").select("id,user_id,run_id,channel_id,status").eq("id", postId).maybeSingle();
    if (found.error) throw new Error(`reading a post: ${found.error.message}`);
    const p = found.data as { id: string; user_id: string; run_id: string; channel_id: string; status: string } | null;
    // only what is waiting: a post that is there is not sent twice
    if (!p || p.status !== "queued") return "skipped";
    const record = async (status: "posted" | "failed", fields: { id?: string; error?: string } = {}) => {
      const { error } = await db.rpc("record_post", { p_id: p.id, p_status: status, p_external_id: fields.id ?? null, p_url: fields.id ? `https://www.youtube.com/shorts/${fields.id}` : null, p_error: fields.error ?? null });
      if (error) throw new Error(`record_post: ${error.message}`);
    };
    try {
      // the post's run and channel must both be its user's own, whatever asked for it
      const [channel, run] = await Promise.all([
        db.from("channels").select("id,user_id,token").eq("id", p.channel_id).maybeSingle(),
        db.from("runs").select("id,user_id").eq("id", p.run_id).maybeSingle(),
      ]);
      const c = channel.data as { user_id: string; token: Buffer } | null;
      if (!c || c.user_id !== p.user_id || (run.data as { user_id: string } | null)?.user_id !== p.user_id) throw new PublishRefused("The channel is no longer connected. Connect it again on your account page.");
      const { file, title, hashtags } = await asUser(p.user_id, async () => ({ file: join(runFolder(p.run_id), "final.mp4"), ...about(p.run_id) }));
      if (!existsSync(file)) throw new PublishRefused("This video is not finished, so there is nothing to publish yet.");
      const got = await token({ grant_type: "refresh_token", refresh_token: open(Buffer.from(c.token), p.user_id) });
      if (typeof got.access_token !== "string") throw new PublishRefused("The channel could not be reached. Try again in a moment.");
      const videoId = await upload(got.access_token, file, title, hashtags);
      await record("posted", { id: videoId });
      log(`worker: posted ${p.run_id} to a channel of ${p.user_id}`);
      return "posted";
    } catch (err) {
      // what the user is told is the studio's own sentence; anything else is the worker's to log
      const mine = err instanceof PublishRefused;
      if (!mine) log(`worker: could not post ${p.run_id}: ${err instanceof Error ? err.message : String(err)}`);
      await record("failed", { error: mine ? err.message : "The video could not be published. Try again in a moment." });
      return "failed";
    }
  }

  return { connect, post, sweep };
}
