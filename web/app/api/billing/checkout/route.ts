import { checkout } from "@/server/billing/actions";
import { body, json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true }, async (req) => json(await checkout(req, await body(req))));
