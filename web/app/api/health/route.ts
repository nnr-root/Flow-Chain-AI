import { health } from "@/server/config";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, () => json(health()));
