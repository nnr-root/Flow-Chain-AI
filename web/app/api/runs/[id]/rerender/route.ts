import { rerender } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { RerenderBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>({ write: true }, async (req, ctx) =>
  json({ job: await rerender((await ctx.params).id, RerenderBody.parse(await body(req)).look) }, 202),
);
