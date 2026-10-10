const link = "underline-offset-4 hover:text-ink hover:underline";

/** The foot of every page: the name and what it is, then where things are, by kind. The year is the server's, at the time the page is made. */
export function SiteFooter({ sells, signedIn = false }: { sells: boolean; signedIn?: boolean }) {
  return (
    <footer className="mx-auto mt-28 w-full max-w-[84rem] px-6 pb-10 sm:px-10">
      <div className="ruled grid gap-x-10 gap-y-10 pt-10 text-[0.95rem] text-graphite sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div>
          <p className="display text-[1.4rem] leading-none text-ink">Flow Chain</p>
          <p className="mt-3 max-w-[20rem]">A finished short video from one sentence, with the cost shown before anything is bought.</p>
        </div>
        <nav aria-label="Product">
          <p className="printed text-ink">Product</p>
          <ul className="mt-3 space-y-2">
            <li><a href="/#how" className={link}>How it works</a></li>
            {sells && <li><a href="/pricing" className={link}>Pricing</a></li>}
            <li><a href="/#faq" className={link}>FAQ</a></li>
          </ul>
        </nav>
        <nav aria-label="Account">
          <p className="printed text-ink">Account</p>
          <ul className="mt-3 space-y-2">
            {signedIn ? (
              <>
                <li><a href="/" className={link}>Your videos</a></li>
                <li><a href="/account" className={link}>Credit and payments</a></li>
              </>
            ) : (
              <>
                <li><a href="/login" className={link}>Sign in</a></li>
                <li><a href="/signup?next=%2Fnew" className={link}>Create an account</a></li>
              </>
            )}
          </ul>
        </nav>
        <nav aria-label="Legal">
          <p className="printed text-ink">Legal</p>
          <ul className="mt-3 space-y-2">
            <li><a href="/terms" className={link}>Terms</a></li>
            <li><a href="/privacy" className={link}>Privacy</a></li>
          </ul>
        </nav>
      </div>
      <p className="mt-10 text-[0.85rem] text-graphite">© {new Date().getFullYear()} Flow Chain</p>
    </footer>
  );
}
