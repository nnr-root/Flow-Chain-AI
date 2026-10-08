import { sessionClient } from "../session";

/**
 * What a new account would be given right now, in USD: 0 when the owner has not turned welcome credit on, when
 * the day's cap is reached, or when the database cannot be asked. The landing page promises a free draft only
 * when this is more than nothing. Asked without a session: it is the same for every visitor.
 */
export async function welcomeOffer(): Promise<number> {
  try {
    const { data, error } = await sessionClient({ getAll: () => [], setAll: () => {} }).rpc("welcome_offer");
    const offer = Number(data);
    return !error && Number.isFinite(offer) && offer > 0 ? offer : 0;
  } catch {
    return 0;
  }
}
