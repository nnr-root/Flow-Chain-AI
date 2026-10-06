import { runEvents } from "@/server/events";
import { route } from "@/server/http";
import { readRun } from "@/server/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>({ write: false }, async (req, ctx) => {
  const { id } = await ctx.params;
  await readRun(id); // 404 for an unknown run before a stream is opened
  return new Response(runEvents(id, req.signal), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
  });
});
