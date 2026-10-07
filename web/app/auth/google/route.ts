import { googleUrl } from "@/server/auth";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";
export const GET = route({ write: false, public: true }, async (req) =>
  new Response(null, { status: 302, headers: { location: await googleUrl(req, new URL(req.url).searchParams.get("next")), "cache-control": "no-store" } }),
);
