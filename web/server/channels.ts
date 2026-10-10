import { createHash } from "node:crypto";
import { z } from "zod";
import { newSecret } from "@src/auth/passwords";
import { OAUTH_COOKIE } from "@/lib/accounts";
import { type ChannelView, type CHANNEL_NOTES, type PostView, publishingOn } from "@/lib/publishing";
import { ApiError } from "./http";
import { runner } from "./jobs";
import { siteOrigin } from "./session";
import { scope, userDb, UUID } from "./tenant";

/*
 * The web app's side of publishing (phase 6 spec §6, §10): it sends a user to the platform's consent page, takes
 * the answer back, and asks for a video to be posted. It never sees what the consent is exchanged for: the code
 * goes to the worker, which alone holds the client's secret and the key the token is sealed with. All the web
 * app can learn of a channel is that it is connected and what it is called.
 */

const CONSENT = "https://accounts.google.com/o/oauth2/v2/auth";
/** Upload, and read which channel it is. (The same string the worker checks the answer against.) */
const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const Pending = z.object({ channel: z.literal(true), state: z.string().min(20), verifier: z.string().min(40), user: z.string() });

function on(): void {
  if (!publishingOn()) throw new ApiError("not_found", "this studio publishes nothing");
}
const jar = () => {
  const cookies = scope()?.cookies;
  if (!cookies) throw new Error("no request in scope: connecting a channel happens in a route");
  return cookies;
};
const me = (): string => {
  const id = scope()?.user?.id;
  if (!id) throw new ApiError("unauthenticated", "sign in first");
  return id;
};

/** The address of the consent page for the signed-in user; the answer comes back to /auth/youtube/callback. */
export function consentUrl(req: Request): string {
  on();
  // `state` ties the answer to this browser, `verifier` (PKCE) ties the code to it, and the user it was begun
  // for must still be the one signed in when it comes back.
  const pending = { channel: true as const, state: newSecret(), verifier: newSecret(), user: me() };
  jar().set(OAUTH_COOKIE, Buffer.from(JSON.stringify(pending)).toString("base64url"), 600);
  return `${CONSENT}?${new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID!.trim(), redirect_uri: `${siteOrigin(req)}/auth/youtube/callback`, response_type: "code", scope: SCOPES,
    // a token that lasts, asked for anew each time: without `consent` a second connection returns none
    access_type: "offline", prompt: "consent", include_granted_scopes: "false",
    state: pending.state, code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256",
  })}`;
}

/** Finishes the visit to the consent page. Returns which note the account page shows. */
export async function finishConsent(req: Request): Promise<keyof typeof CHANNEL_NOTES> {
  on();
  const url = new URL(req.url);
  const raw = jar().get(OAUTH_COOKIE);
  jar().clear(OAUTH_COOKIE);
  if (url.searchParams.get("error")) return "cancelled";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || code.length > 2000 || !state) return "incomplete";
  let pending: z.infer<typeof Pending>;
  try {
    pending = Pending.parse(JSON.parse(Buffer.from(raw ?? "", "base64url").toString("utf8")));
  } catch {
    return "incomplete";
  }
  const a = Buffer.from(state);
  const b = Buffer.from(pending.state);
  if (a.length !== b.length || !a.equals(b) || pending.user !== me()) return "incomplete";
  const answer = await runner().connectChannel(code, pending.verifier, `${siteOrigin(req)}/auth/youtube/callback`);
  return "title" in answer ? "connected" : "failed";
}

/** The signed-in user's connected channels: what each is called, and nothing that could post to it. */
export async function listChannels(): Promise<ChannelView[]> {
  if (!publishingOn()) return [];
  const { data, error } = await userDb().rpc("my_channels", {});
  if (error) throw new Error(`my_channels: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; provider: "youtube"; title: string }>).map((c) => ({ id: c.id, provider: c.provider, title: c.title }));
}

export async function unlinkChannel(id: string): Promise<void> {
  on();
  if (!UUID.test(id)) throw new ApiError("not_found", "no such channel");
  const { error } = await userDb().rpc("unlink_channel", { p_id: id });
  if (error) throw error.message === "not_found" ? new ApiError("not_found", "no such channel") : new Error(`unlink_channel: ${error.message}`);
}

/** What has been asked of a run's video, channel by channel. */
export async function postsOf(runId: string): Promise<PostView[]> {
  if (!publishingOn()) return [];
  const { data, error } = await userDb().from("posts").select("id,channel_id,status,url,error").eq("run_id", runId).order("created_at");
  if (error) throw new Error(`reading posts: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; channel_id: string; status: PostView["status"]; url: string | null; error: string | null }>).map((p) => ({ id: p.id, channelId: p.channel_id, status: p.status, url: p.url, error: p.error }));
}

const REFUSALS: Record<string, () => ApiError> = {
  not_found: () => new ApiError("not_found", "no such video or channel"),
  already_posted: () => new ApiError("validation", "this video is already on that channel"),
  post_pending: () => new ApiError("validation", "this video is being published to that channel"),
  unauthenticated: () => new ApiError("unauthenticated", "sign in first"),
};

/** Asks for one of the user's finished videos to be posted to one of their channels. The worker does it; the post's row says what became of it. */
export async function publishRun(runId: string, channelId: string): Promise<{ postId: string }> {
  on();
  if (!UUID.test(channelId)) throw REFUSALS.not_found();
  const { data, error } = await userDb().rpc("request_post", { p_run_id: runId, p_channel_id: channelId });
  if (error) throw REFUSALS[error.message]?.() ?? new Error(`request_post: ${error.message}`);
  const postId = String(data);
  // The post is on record. If the worker cannot be told right now, it finds the post itself within a few
  // minutes: the request is not lost, and is not refused for the queue being away.
  await runner().publish(postId).catch(() => {});
  return { postId };
}

/** Where a series' videos go, and whether its owner sees each one first. */
export async function setSeriesPublishing(seriesId: string, channelId: string | null, reviewFirst: boolean): Promise<void> {
  on();
  if (!UUID.test(seriesId) || (channelId !== null && !UUID.test(channelId))) throw new ApiError("not_found", "no such series or channel");
  const { error } = await userDb().rpc("set_series_publishing", { p_id: seriesId, p_channel_id: channelId, p_review_first: reviewFirst });
  if (error) throw error.message === "not_found" ? new ApiError("not_found", "no such series or channel") : new Error(`set_series_publishing: ${error.message}`);
}
