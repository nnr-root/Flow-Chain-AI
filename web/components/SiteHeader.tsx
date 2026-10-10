import Link from "next/link";
import { usd } from "@/lib/api";

/** Who is looking: nobody, or a signed-in user with what they may still spend. `null` in a studio without accounts. */
export type HeaderAccount = { email: string; balanceUsd: number } | null;

const link = "underline-offset-4 hover:underline";
const solid = "rounded-full bg-signal px-4 py-2 font-bold text-paper hover:bg-ink";

/**
 * The one header of the whole site. What it offers depends on who is looking, never on which page they are on:
 * a visitor is offered the way in; someone in the studio is offered their videos, their kits and a new video.
 * `studio`: the links of the studio are shown (always, in a studio without accounts; with accounts, to a session).
 */
export function SiteHeader({ studio, account, sells, free = false }: { studio: boolean; account: HeaderAccount; sells: boolean; free?: boolean }) {
  return (
    <header className="mx-auto flex w-full max-w-[84rem] items-center gap-5 px-6 pt-6 sm:gap-7 sm:px-10">
      <Link href="/" className="display whitespace-nowrap text-[2.1rem] leading-none">Flow Chain</Link>
      <nav aria-label="Site" className="ml-auto flex items-center gap-5 whitespace-nowrap text-[0.95rem] sm:gap-7">
        {studio && (
          <>
            <Link href="/" className={link}>Videos</Link>
            <Link href="/brand-kits" className={`hidden sm:inline ${link}`}>Brand kits</Link>
          </>
        )}
        {sells && <Link href="/pricing" className={`hidden sm:inline ${link}`}>Pricing</Link>}
        {account && (
          <Link href="/account" className={link} data-testid="account-link" title={account.email}>
            <span data-testid="header-balance" className="figures font-bold">{usd(account.balanceUsd)}</span>
            <span className="hidden lg:inline">, {account.email}</span>
          </Link>
        )}
        {studio ? (
          <Link href="/new" data-cta="nav-new" className={solid}>New video</Link>
        ) : (
          <>
            <a href="/login" className={link}>Sign in</a>
            <a href="/signup?next=%2Fnew" data-cta="nav-signup" className={`hidden sm:inline-block ${solid}`}>{free ? "Make a free draft" : "Create an account"}</a>
          </>
        )}
      </nav>
    </header>
  );
}
