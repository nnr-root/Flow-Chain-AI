import { signUp } from "@/server/auth";
import { body, json, route } from "@/server/http";
import { limitAttempts } from "@/server/limits";

export const dynamic = "force-dynamic";
export const POST = route({ write: true, public: true }, async (req) => {
  limitAttempts(req, "signup");
  return json(await signUp(req, await body(req)));
});
