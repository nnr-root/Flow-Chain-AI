import { finishCallback } from "@/server/auth";
import { route } from "@/server/http";
import { limitAttempts } from "@/server/limits";
import { siteOrigin } from "@/server/session";

export const dynamic = "force-dynamic";
export const GET = route({ write: false, public: true }, async (req) => {
  // every code is checked with the accounts service: not a thing to let one visitor do without end
  limitAttempts(req, "callback");
  return new Response(null, { status: 302, headers: { location: `${siteOrigin(req)}${await finishCallback(req)}`, "cache-control": "no-store" } });
});
