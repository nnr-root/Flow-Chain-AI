import { existsSync } from "node:fs";
import { ApiError, json, route } from "@/server/http";
import { clearStaleLock } from "@/server/jobs";
import { runDir } from "@/server/runs";

type Ctx = { params: Promise<{ id: string }> };

/** After a hard kill: removes the pipeline's lock, only when nothing of this run is alive. */
export const POST = route<Ctx>({ write: true }, async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!existsSync(runDir(id))) throw new ApiError("not_found", `no run ${id}`);
  await clearStaleLock(id);
  return json({ ok: true });
});
