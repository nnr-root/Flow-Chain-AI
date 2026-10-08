import { json, route } from "@/server/http";
import { addMusic, LIMITS, listMusic } from "@/server/library";
import { boundedForm } from "@/server/limits";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json({ tracks: await listMusic() }));

export const POST = route({ write: true }, async (req) => {
  const form = await boundedForm(req, LIMITS.music + 1024 * 1024);
  return json({ track: await addMusic(form) }, 201);
});
