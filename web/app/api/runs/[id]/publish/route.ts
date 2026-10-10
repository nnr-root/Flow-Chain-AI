import { z } from "zod";
import { listChannels, postsOf, publishRun } from "@/server/channels";
import { body, json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** The user's channels, and what has been asked of this video on each. */
export const GET = route<Ctx>({ write: false }, async (_req, ctx) => json({ channels: await listChannels(), posts: await postsOf((await ctx.params).id) }));

/** Asks for this video to be published to one of the user's own channels. */
export const POST = route<Ctx>({ write: true }, async (req, ctx) =>
  json(await publishRun((await ctx.params).id, z.object({ channelId: z.string() }).parse(await body(req)).channelId), 202),
);
