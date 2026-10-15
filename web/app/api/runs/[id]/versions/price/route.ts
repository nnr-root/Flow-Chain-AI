import { versionPrice } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { VersionAsk } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** A read: what a version in another language would cost; nothing is made. */
export const POST = route<Ctx>({ write: false }, async (req, ctx) =>
  json(await versionPrice((await ctx.params).id, VersionAsk.parse(await body(req)))),
);
