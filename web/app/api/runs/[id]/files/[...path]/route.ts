import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { resolvePublished, serveFile } from "@/server/files";
import { storedRunFile } from "@/server/store/tenant";
import { VIRTUAL } from "@src/studio/draft-media";
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
  const source = resolvePublished(runDir(id), published, shown);
  // A file of the run that this disk lacks (it was cleaned, or is still on its way back) is served from the
  // bucket: a link to that one file, for a few minutes, made only now that the run is known to be the caller's.
  const inRun = relative(runDir(id), source);
  if (!source.startsWith(VIRTUAL) && !inRun.startsWith("..") && !existsSync(source)) {
    const link = await storedRunFile(id, inRun.split(sep).join("/"));
    if (link) return new Response(null, { status: 302, headers: { location: link, "cache-control": "no-store" } });
  }
  return serveFile(req, source, m, id, shown);
});
