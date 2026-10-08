import { portal } from "@/server/billing/actions";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true }, async (req) => json(await portal(req)));
