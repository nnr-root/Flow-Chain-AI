import type { Metadata } from "next";
import Link from "next/link";
import { QueueBanner } from "@/components/QueueBanner";
import { usd } from "@/lib/api";
import { billingOn } from "@/lib/billing";
import { multiTenant } from "@/lib/accounts";
import { headerAccount } from "@/server/page";
import "./globals.css";

export const metadata: Metadata = { title: "Flow-Chain Studio", description: "Create, preview and render videos" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // with accounts, the studio's own links are for someone who is signed in
  const me = await headerAccount();
  const signedOut = multiTenant() && !me;
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3 text-sm">
            <Link href="/" className="text-base font-semibold tracking-tight">Flow-Chain Studio</Link>
            {!signedOut && (
              <>
                <Link href="/" className="text-dim hover:text-white">Videos</Link>
                <Link href="/brand-kits" className="text-dim hover:text-white">Brand kits</Link>
                {billingOn() && <Link href="/pricing" className="text-dim hover:text-white">Pricing</Link>}
                {me && (
                  <Link href="/account" className="ml-auto text-dim hover:text-white" data-testid="account-link">
                    <span data-testid="header-balance" className="font-medium text-white">{usd(me.balanceUsd)}</span> · {me.email}
                  </Link>
                )}
                <Link href="/new" className={`${me ? "" : "ml-auto "}rounded-lg bg-accent px-3 py-1.5 font-medium text-ink hover:brightness-110`}>New video</Link>
              </>
            )}
            {signedOut && billingOn() && (
              <>
                <Link href="/pricing" className="text-dim hover:text-white">Pricing</Link>
                <Link href="/login" className="ml-auto text-dim hover:text-white">Sign in</Link>
              </>
            )}
          </nav>
        </header>
        {!signedOut && <QueueBanner />}
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
