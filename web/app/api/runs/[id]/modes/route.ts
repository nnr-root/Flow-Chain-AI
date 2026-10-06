import { setModes } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { ModesBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>({ write: true }, async (req, ctx) =>
  json(await setModes((await ctx.params).id, ModesBody.parse(await body(req)).modes)),
);
