import { createVersion } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { VersionBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** Makes the run in another language: a new run, paid, at most what was approved. */
export const POST = route<Ctx>({ write: true }, async (req, ctx) =>
  json(await createVersion((await ctx.params).id, VersionBody.parse(await body(req))), 202),
);
