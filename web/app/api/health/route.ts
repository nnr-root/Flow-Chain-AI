import { json, route } from "@/server/http";
import { studioHealth } from "@/server/jobs";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json(await studioHealth()));
