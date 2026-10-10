import { multiTenant } from "./accounts";

/*
 * Publishing to a user's own channel (phase 6 spec §6, §10). It exists when the studio has accounts and a
 * client at the platform (`YOUTUBE_CLIENT_ID`): without them none of it is there, and nothing else changes.
 * The web app holds the client's public id only; the secret and the key tokens are sealed with are the worker's.
 */
export const publishingOn = (): boolean => multiTenant() && !!process.env.YOUTUBE_CLIENT_ID?.trim();

export type ChannelView = { id: string; provider: "youtube"; title: string };
export type PostView = { id: string; channelId: string; status: "queued" | "posted" | "failed"; url: string | null; error: string | null };

/** What the account page says after the visit to the consent page, by the name the address carries (never text taken from an address). */
export const CHANNEL_NOTES = {
  connected: "Your channel is connected. A finished video now has a Publish button on its page.",
  cancelled: "The channel was not connected: the permission was not given.",
  incomplete: "The channel was not connected: the answer from Google was not for this browser. Try again.",
  failed: "The channel could not be connected. Try again in a moment.",
} as const;
