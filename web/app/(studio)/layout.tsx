import { QueueBanner } from "@/components/QueueBanner";
import { multiTenant } from "@/lib/accounts";
import { headerAccount } from "@/server/page";

/** The studio's pages: the width they work in, and word of a queue or a worker that is away. */
export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  // (the sign-in pages are here too: a visitor without a session has no jobs to be told about)
  const signedOut = multiTenant() && !(await headerAccount());
  return (
    <>
      {!signedOut && <QueueBanner />}
      <main className="mx-auto max-w-[84rem] px-6 pb-16 pt-10 sm:px-10" data-surface="studio">{children}</main>
    </>
  );
}
