import { ApiError, json, route } from "@/server/http";
import { createKit, listKits } from "@/server/library";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json({ kits: await listKits() }));

export const POST = route({ write: true }, async (req) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError("validation", "send the kit as a form (multipart/form-data)");
  }
  return json({ kit: await createKit(form) }, 201);
});
