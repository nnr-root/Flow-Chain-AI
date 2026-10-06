import { RenderProps } from "@src/media/remotion/props";
import { body, json, route } from "@/server/http";
import { preview, requireManifest } from "@/server/runs";
import { lookFlags, PropsBody } from "@/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** A read (nothing is saved), posted only because the pending look travels in the body. */
export const POST = route<Ctx>({ write: false }, async (req, ctx) => {
  const { id } = await ctx.params;
  const { look } = PropsBody.parse(await body(req));
  const { flags, brandDir } = await lookFlags(look);
  const { props, draft } = preview(await requireManifest(id), id, flags, brandDir);
  // the contract the render uses: never hand the Player props the composition would not accept
  return json({ props: RenderProps.parse(props), draft });
});
