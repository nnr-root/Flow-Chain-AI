/** The marketing side's footer. The year is the server's, at the time the page is made. */
export function SiteFooter({ sells }: { sells: boolean }) {
  return (
    <footer className="mx-auto mt-28 flex max-w-[84rem] flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hairline px-6 py-8 text-[0.9rem] text-graphite sm:px-10">
      <span>© {new Date().getFullYear()} Flow Chain</span>
      <nav aria-label="Footer" className="ml-auto flex gap-7">
        {sells && <a href="/pricing" className="underline-offset-4 hover:underline">Pricing</a>}
        <a href="/login" className="underline-offset-4 hover:underline">Sign in</a>
      </nav>
    </footer>
  );
}
