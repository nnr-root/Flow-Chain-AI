import { unlinkChannel } from "@/server/channels";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Disconnects a channel: its token is deleted, and nothing more can be posted to it. (What is already there stays there.) */
export const DELETE = route<Ctx>({ write: true }, async (_req, ctx) => {
  await unlinkChannel((await ctx.params).id);
  return json({ ok: true });
});
