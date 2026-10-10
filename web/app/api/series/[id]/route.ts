import { body, json, route } from "@/server/http";
import { changeSeries, removeSeries, SeriesChange } from "@/server/series";

type Ctx = { params: Promise<{ id: string }> };

/** A series' schedule and budget, or whether it is stopped: the standing approval is given and taken back here, by its owner. */
export const PATCH = route<Ctx>({ write: true }, async (req, ctx) => {
  await changeSeries((await ctx.params).id, SeriesChange.parse(await body(req)));
  return json({ ok: true });
});

export const DELETE = route<Ctx>({ write: true }, async (_req, ctx) => {
  await removeSeries((await ctx.params).id);
  return json({ ok: true });
});
