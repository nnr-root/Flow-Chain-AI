import { json, route } from "@/server/http";
import { logTail } from "@/server/jobs";
import { readRun } from "@/server/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>({ write: false }, async (_req, ctx) => {
  const { id } = await ctx.params;
  return json({ ...(await readRun(id)), log: await logTail(id) });
});
