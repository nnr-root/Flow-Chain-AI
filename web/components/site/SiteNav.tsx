import Link from "next/link";

/** The marketing side's header. `signedIn`: the visitor already has a session, so the way in is the studio itself. */
export function SiteNav({ signedIn, sells, free = false }: { signedIn: boolean; sells: boolean; free?: boolean }) {
  return (
    <header className="mx-auto flex max-w-[84rem] items-baseline gap-5 px-6 pt-7 sm:gap-8 sm:px-10">
      <Link href="/" className="display whitespace-nowrap text-[1.6rem] leading-none" style={{ fontWeight: 520 }}>Flow Chain</Link>
      {/* on a phone there is room for the way in and little else: pricing is one line below, in the page */}
      <nav aria-label="Site" className="ml-auto flex items-baseline gap-5 whitespace-nowrap text-[0.95rem] sm:gap-7">
        {sells && <Link href="/pricing" className="hidden underline-offset-4 hover:underline sm:inline">Pricing</Link>}
        {signedIn ? (
          <a href="/" data-cta="nav-studio" className="rounded-md bg-ink px-4 py-2 font-medium text-paper hover:bg-stage">Open the studio</a>
        ) : (
          <>
            <a href="/login" className="underline-offset-4 hover:underline">Sign in</a>
            <a href="/signup?next=%2Fnew" data-cta="nav-signup" className="hidden rounded-md bg-ink px-4 py-2 font-medium text-paper hover:bg-stage sm:inline-block">{free ? "Make a free draft" : "Create an account"}</a>
          </>
        )}
      </nav>
    </header>
  );
}
