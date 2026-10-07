import { account, ledger } from "@/server/auth";
import { json, route } from "@/server/http";
import { multiTenant } from "@/server/tenant";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => {
  // a studio without accounts has nobody to report on: the pages ask, and learn that credit does not apply
  if (!multiTenant()) return json({ account: null, ledger: [] });
  return json({ account: await account(), ledger: await ledger() });
});
