import { AuthForm } from "@/components/AuthForm";
import { safeNext } from "@/lib/supabase/settings";
import { accountsOnly } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  accountsOnly();
  const { next, error } = await searchParams;
  return <AuthForm mode="login" next={safeNext(next)} error={error} />;
}
