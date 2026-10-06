import { json, route } from "@/server/http";
import { listRuns } from "@/server/runs";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => json({ runs: await listRuns() }));
