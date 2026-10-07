import { requestReset } from "@/server/auth";
import { body, json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true, public: true }, async (req) => {
  await requestReset(req, await body(req));
  return json({ ok: true });
});
