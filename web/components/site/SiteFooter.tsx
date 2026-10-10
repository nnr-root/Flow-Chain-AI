/** The foot of every page. The year is the server's, at the time the page is made. */
export function SiteFooter({ sells, signedIn = false }: { sells: boolean; signedIn?: boolean }) {
  return (
    <footer className="mx-auto mt-24 flex w-full max-w-[84rem] flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hairline px-6 py-8 text-[0.9rem] text-graphite sm:px-10">
      <span>© {new Date().getFullYear()} Flow Chain</span>
      <nav aria-label="Footer" className="ml-auto flex flex-wrap gap-x-7 gap-y-2">
        {sells && <a href="/pricing" className="underline-offset-4 hover:underline">Pricing</a>}
        <a href="/terms" className="underline-offset-4 hover:underline">Terms</a>
        <a href="/privacy" className="underline-offset-4 hover:underline">Privacy</a>
        {!signedIn && <a href="/login" className="underline-offset-4 hover:underline">Sign in</a>}
      </nav>
    </footer>
  );
}
