import { finishCallback } from "@/server/auth";
import { route } from "@/server/http";
import { siteOrigin } from "@/server/session";

export const dynamic = "force-dynamic";
export const GET = route({ write: false, public: true }, async (req) =>
  new Response(null, { status: 302, headers: { location: `${siteOrigin(req)}${await finishCallback(req)}`, "cache-control": "no-store" } }),
);
