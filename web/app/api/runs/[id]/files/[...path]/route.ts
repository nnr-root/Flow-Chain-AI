import { resolvePublished, serveFile } from "@/server/files";
import { ApiError, route } from "@/server/http";
import { preview, type Preview, requireManifest, runDir } from "@/server/runs";
import { decodeLookToken, LOOK_PREFIX } from "@/lib/look-token";
import { Look, lookFlags } from "@/server/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; path: string[] }> };

export const GET = route<Ctx>({ write: false }, async (req, ctx) => {
  const { id, path: segments } = await ctx.params;
  const m = await requireManifest(id);
  // The Player asks with the same pending look it got its props for, so the same files are published. The look
  // travels as a leading "~<token>" path segment, not a query: the URL must still end in the file's extension
  // (Remotion's font loader reads the format from it).
  const [first, ...rest] = segments;
  const path = first?.startsWith(LOOK_PREFIX) ? rest : segments;
  let look: Look = {};
  if (first?.startsWith(LOOK_PREFIX)) {
    try {
      look = Look.parse(decodeLookToken(first).look ?? {});
    } catch {
      throw new ApiError("validation", "look: not a valid look");
    }
  }
  const { flags, brandDir } = await lookFlags(look);
  let shown: Preview | null = null;
  try {
    shown = preview(m, id, flags, brandDir);
  } catch {
    // no script yet: only the run's plain outputs can be served
  }
  const published = path.join("/");
  return serveFile(req, resolvePublished(runDir(id), published, shown), m, id, shown);
});
