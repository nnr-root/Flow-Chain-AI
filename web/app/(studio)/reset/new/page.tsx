import { AuthForm } from "@/components/AuthForm";
import { linkError, safeNext } from "@/lib/accounts";
import { accountsOnly } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  accountsOnly();
  const { next, error } = await searchParams;
  return <AuthForm mode="new-password" next={safeNext(next)} error={linkError(error)} />;
}
