import { AuthForm } from "@/components/AuthForm";
import { googleOn, linkError, safeNext } from "@/lib/accounts";
import { accountsOnly } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; confirmed?: string }> }) {
  accountsOnly();
  const { next, error, confirmed } = await searchParams;
  // (our own words for a link opened in another browser than the one that asked for it: the address is confirmed, the visitor signs in here)
  return <AuthForm mode="login" next={safeNext(next)} error={linkError(error)} info={confirmed === "1" ? "Your email address is confirmed. Sign in to continue." : ""} google={googleOn()} />;
}
