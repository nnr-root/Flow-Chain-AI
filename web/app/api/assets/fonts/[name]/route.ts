import { join } from "node:path";
import { CAPTION_STYLES } from "@src/media/remotion/styles";
import { PRESETS } from "@src/presets";
import { roots } from "@/server/config";
import { serveStatic } from "@/server/files";
import { ApiError, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ name: string }> };

/** The fonts the caption styles and presets ship with, by exact file name. */
const BUNDLED = new Set([...Object.values(CAPTION_STYLES), ...Object.values(PRESETS).map((p) => p.caption)].map((s) => s.font.file));

/** A bundled caption font, for previews that have no run yet (the brand kit form). */
export const GET = route<Ctx>({ write: false }, async (req, ctx) => {
  const { name } = await ctx.params;
  if (!BUNDLED.has(name)) throw new ApiError("not_found", "no such font");
  return serveStatic(req, join(roots().fonts, name));
});
