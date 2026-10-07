import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { multiTenant } from "@/lib/supabase/settings";
import { type Account, account } from "./auth";
import { sessionClient, sessionUser } from "./session";
import { inScope } from "./tenant";

/* What a page (a server component) needs: its data loaded for the signed-in user. Routes get the same from route(). */

// once per request: the layout and the page both ask who is signed in
const pageSession = cache(async () => {
  const jar = await cookies();
  // a page cannot set cookies; the proxy has refreshed the session before the page runs
  const client = sessionClient({ getAll: () => jar.getAll(), setAll: () => {} });
  return { client, user: await sessionUser(client) };
});

/** Loads a page's data for the signed-in user. Without accounts it simply runs; without a session it goes to the login page. */
export async function forUser<T>(work: () => Promise<T>): Promise<T> {
  if (!multiTenant()) return work();
  const { client, user } = await pageSession();
  if (!user) redirect("/login");
  return inScope({ user, db: client }, work);
}

/** The header's account: null without accounts or when nobody is signed in. */
export async function headerAccount(): Promise<Account | null> {
  if (!multiTenant()) return null;
  const { client, user } = await pageSession();
  if (!user) return null;
  return inScope({ user, db: client }, account).catch(() => null);
}

/** For the pages that only exist in a studio with accounts. */
export function accountsOnly(): void {
  if (!multiTenant()) notFound();
}
