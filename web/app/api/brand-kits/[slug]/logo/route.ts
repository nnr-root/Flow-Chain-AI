import { join } from "node:path";
import { loadBrandKit } from "@src/brand";
import { ApiError, route } from "@/server/http";
import { kitDir, Slug } from "@/server/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ slug: string }> };

/** A kit's logo, for the pickers. */
export const GET = route<Ctx>({ write: false }, async (req, ctx) => {
  const slug = Slug.safeParse((await ctx.params).slug);
  if (!slug.success) throw new ApiError("not_found", "no such kit");
  const dir = kitDir(slug.data);
  const kit = await loadBrandKit(dir).catch(() => {
    throw new ApiError("not_found", "no such kit");
  });
  const { serveStatic } = await import("@/server/files");
  return serveStatic(req, join(dir, kit.logo));
});
