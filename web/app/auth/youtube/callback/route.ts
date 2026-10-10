import { finishConsent } from "@/server/channels";
import { route } from "@/server/http";
import { limitAttempts } from "@/server/limits";
import { siteOrigin } from "@/server/session";

export const dynamic = "force-dynamic";
/** Where the consent page sends the user back to: the account page then says, in the studio's own words, how it went. */
export const GET = route({ write: false }, async (req) => {
  // every code is checked with the platform: not a thing to let one visitor do without end
  limitAttempts(req, "callback");
  return new Response(null, { status: 302, headers: { location: `${siteOrigin(req)}/account?channel=${await finishConsent(req)}`, "cache-control": "no-store" } });
});
