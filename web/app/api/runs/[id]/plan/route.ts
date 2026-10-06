import { price } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { PlanBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** A read: pricing changes nothing. */
export const POST = route<Ctx>({ write: false }, async (req, ctx) =>
  json(await price((await ctx.params).id, PlanBody.parse(await body(req)))),
);
