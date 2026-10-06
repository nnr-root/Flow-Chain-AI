import { saveLook } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { RerenderBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** Saves the look without rendering (free): what a draft's "Save look" does. */
export const POST = route<Ctx>({ write: true }, async (req, ctx) => {
  await saveLook((await ctx.params).id, RerenderBody.parse(await body(req)).look);
  return json({ ok: true });
});
