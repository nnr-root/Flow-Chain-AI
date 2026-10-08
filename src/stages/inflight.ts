import { saveManifest } from "../manifest/store.js";
import type { RunContext } from "./types.js";

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/**
 * Runs a provider call that is paid for when it answers (narration, the script), with its expected cost on
 * record while it is in flight.
 *
 * The pipeline's own ledger only learns of the cost when the answer is back. If the process is ended while the
 * request is on its way — the run was stopped, the machine went down — the provider has the request and bills
 * it, and nothing here would ever say so; whoever accounts for the run's spend from outside reads `inFlight`
 * for exactly that. A call that fails takes its entry away again (a failure the provider answered is not
 * billed). A call that succeeds drops its entry in memory only: the caller charges next, and that save writes
 * the ledger entry and the entry's removal together, so there is no moment on disk at which the call is in
 * neither. An entry found left over from an earlier process is moved to `abandonedUsd` before the call is
 * made again.
 */
export async function withExpectedSpend<T>(ctx: RunContext, key: string, usd: number, call: () => Promise<T>): Promise<T> {
  const m = ctx.manifest;
  const left = m.inFlight?.[key];
  if (left !== undefined && left > 0) m.abandonedUsd = round4((m.abandonedUsd ?? 0) + left);
  m.inFlight = { ...m.inFlight, [key]: usd };
  await saveManifest(ctx.dir, m);
  const drop = () => {
    const { [key]: _done, ...rest } = m.inFlight ?? {};
    m.inFlight = Object.keys(rest).length > 0 ? rest : undefined;
  };
  try {
    const answer = await call();
    drop(); // saved by the charge that follows
    return answer;
  } catch (err) {
    drop();
    await saveManifest(ctx.dir, m);
    throw err;
  }
}
