import { json, route } from "@/server/http";
import { removeSeries } from "@/server/series";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>({ write: true }, async (_req, ctx) => {
  await removeSeries((await ctx.params).id);
  return json({ ok: true });
});
