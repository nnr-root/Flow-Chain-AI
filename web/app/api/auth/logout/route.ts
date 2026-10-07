import { signOut } from "@/server/auth";
import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
export const POST = route({ write: true, public: true }, async () => {
  await signOut();
  return json({ ok: true });
});
