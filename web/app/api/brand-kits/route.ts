import { json, route } from "@/server/http";
import { createKit, LIMITS, listKits } from "@/server/library";
import { boundedForm } from "@/server/limits";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json({ kits: await listKits() }));

export const POST = route({ write: true }, async (req) => {
  const form = await boundedForm(req, LIMITS.logo + LIMITS.font + LIMITS.portrait + 1024 * 1024);
  return json({ kit: await createKit(form) }, 201);
});
