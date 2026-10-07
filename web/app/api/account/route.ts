import { account, ledger } from "@/server/auth";
import { ApiError, json, route } from "@/server/http";
import { multiTenant } from "@/server/tenant";

export const dynamic = "force-dynamic";
export const GET = route({ write: false }, async () => {
  if (!multiTenant()) throw new ApiError("not_found", "this studio has no accounts");
  return json({ account: await account(), ledger: await ledger() });
});
