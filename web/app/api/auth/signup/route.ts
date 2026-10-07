import { signUp } from "@/server/auth";
import { body, json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true, public: true }, async (req) => json(await signUp(req, await body(req))));
