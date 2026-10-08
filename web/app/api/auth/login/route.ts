import { signIn } from "@/server/auth";
import { body, json, route } from "@/server/http";
import { limitAttempts } from "@/server/limits";

export const dynamic = "force-dynamic";
export const POST = route({ write: true, public: true }, async (req) => {
  limitAttempts(req, "auth");
  await signIn(await body(req));
  return json({ ok: true });
});
