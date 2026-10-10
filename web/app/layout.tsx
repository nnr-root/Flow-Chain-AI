import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { multiTenant } from "@/lib/accounts";
import { billingOn } from "@/lib/billing";
import { DRAFT_CAP_USD } from "@/lib/credit";
import { headerAccount } from "@/server/page";
import { welcomeOffer } from "@/server/site/welcome";
import { montserrat, montserratDisplay } from "./typeface";
import "./theme.css";

export const metadata: Metadata = {
  title: "Flow Chain — a finished short video from one sentence",
  description: "Flow Chain writes the script, records the voice, generates the pictures and cuts a captioned short video to the words. You see the cost before anything is bought.",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "48x48" }], apple: "/apple-touch-icon.png" },
};

/*
 * The one layout of the whole site (phase 4 spec §14, §16): the pages a visitor reads and the studio a user works in
 * have the same typefaces, the same colours, the same header and the same foot. What the header offers depends
 * on who is looking, not on which page it is: a visitor is shown the way in, a user their studio.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const accounts = multiTenant();
  const me = await headerAccount();
  // without accounts the studio is its one owner's; with them, its links are for someone who is signed in
  const studio = !accounts || me !== null;
  // a new account is given credit for a first draft: only then does the way in say "free"
  const free = accounts && !me && (await welcomeOffer().catch(() => 0)) >= DRAFT_CAP_USD;
  // (`data-credits`: amounts are shown as credits where the studio has customers; the browser's side of `showsCredits`)
  return (
    <html lang="en" className={`${montserrat.variable} ${montserratDisplay.variable}`} data-credits={accounts ? "1" : undefined}>
      <body className="flex min-h-screen flex-col">
        <SiteHeader studio={studio} account={me ? { email: me.email, balanceUsd: me.balanceUsd } : null} sells={billingOn()} free={free} />
        <div className="flex-1">{children}</div>
        {accounts && <SiteFooter sells={billingOn()} signedIn={me !== null} />}
      </body>
    </html>
  );
}
