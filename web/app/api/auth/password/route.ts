import { setPassword } from "@/server/auth";
import { body, json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true }, async (req) => {
  await setPassword(await body(req));
  return json({ ok: true });
});
