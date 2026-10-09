import { db } from "../db";

/** How long an answer is kept. (A test that switches the setting and looks at once sets WELCOME_OFFER_TTL_MS to 0.) */
const ttlMs = (): number => {
  const given = Number(process.env.WELCOME_OFFER_TTL_MS);
  return Number.isFinite(given) && given >= 0 && process.env.WELCOME_OFFER_TTL_MS?.trim() ? given : 60_000;
};
let cached: { at: number; offer: number } | undefined;

/**
 * What a new account would be given right now, in USD: 0 when the owner has not turned welcome credit on, when
 * the day's cap is reached, or when the database cannot be asked. The landing page promises a free draft only
 * when this covers one. Asked without a session — it is the same for every visitor — and at most once a minute.
 */
export async function welcomeOffer(now = Date.now()): Promise<number> {
  if (cached && now - cached.at < ttlMs()) return cached.offer;
  let offer = 0;
  try {
    const { data, error } = await db().rpc("welcome_offer");
    const value = Number(data);
    if (!error && Number.isFinite(value) && value > 0) offer = value;
  } catch {
    // no promise is made when the database cannot be asked
  }
  cached = { at: now, offer };
  return offer;
}

/** Tests only. */
export const forgetWelcomeOffer = (): void => {
  cached = undefined;
};
