import { inCredits, showsCredits } from "./credit";
/** An error answer from the studio API, with its code so the UI can react to specific ones. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; hint?: string } } | null;
  if (!res.ok || data?.error) {
    const e = data?.error ?? { code: "internal", message: `the studio answered ${res.status}` };
    const { code, message, hint, ...rest } = e as { code: string; message: string; hint?: string };
    throw new ApiFailure(code, message, hint, rest);
  }
  return data as T;
}

export const getJson = <T>(url: string): Promise<T> => fetch(url, { cache: "no-store" }).then((r) => parse<T>(r));

export const sendJson = <T>(url: string, body: unknown = {}, method = "POST"): Promise<T> =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => parse<T>(r));

export const sendForm = <T>(url: string, form: FormData): Promise<T> => fetch(url, { method: "POST", body: form }).then((r) => parse<T>(r));

/** Real money, as a customer pays it: a plan's price, a payment. Always dollars. */
export const money = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/**
 * What something costs, or what there is to spend: credits where the studio has customers, dollars in the
 * owner's own studio (see `showsCredits`). Every cost, balance, cap and estimate on a page goes through this.
 */
export const amount = (usd: number): string => (showsCredits() ? inCredits(usd) : money(usd));

export const errorText = (err: unknown): string =>
  err instanceof ApiFailure ? `${err.message}${err.hint ? ` — ${err.hint}` : ""}` : err instanceof Error ? err.message : String(err);
