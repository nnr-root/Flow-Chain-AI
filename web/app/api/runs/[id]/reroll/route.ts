import { reroll } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { RerollBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>({ write: true }, async (req, ctx) => {
  const { approvedUsd, ...target } = RerollBody.parse(await body(req));
  return json({ job: await reroll((await ctx.params).id, target, approvedUsd) }, 202);
});
