import { generate } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { GenerateBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>({ write: true }, async (req, ctx) =>
  json({ job: await generate((await ctx.params).id, GenerateBody.parse(await body(req)).approvedUsd) }, 202),
);
