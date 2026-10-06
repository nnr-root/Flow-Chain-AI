import { ApiError, json, route } from "@/server/http";
import { addMusic, listMusic } from "@/server/library";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json({ tracks: await listMusic() }));

export const POST = route({ write: true }, async (req) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError("validation", "send the file as a form (multipart/form-data)");
  }
  return json({ track: await addMusic(form) }, 201);
});
