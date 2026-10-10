import { consentUrl } from "@/server/channels";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";
/** Sends the signed-in user to the platform's own consent page, to let the studio upload to their channel. */
export const GET = route({ write: false }, async (req) => new Response(null, { status: 302, headers: { location: consentUrl(req), "cache-control": "no-store" } }));
