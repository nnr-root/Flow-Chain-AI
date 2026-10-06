import { json, route } from "@/server/http";
import { stopJob } from "@/server/jobs";
import { runDir } from "@/server/runs";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>({ write: true }, async (_req, ctx) => {
  const { id } = await ctx.params;
  runDir(id);
  return json({ job: await stopJob(id) });
});
