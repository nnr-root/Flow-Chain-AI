import { z } from "zod";

/**
 * A word a worker heard in a clip it made (phase 15 spec §13.1): its times become caption timings, so a time that is not a
 * number, a negative one, or a word that ends before it starts is refused (it would place a caption wrongly). Its own
 * module, importing nothing of the studio's: the provider that checks an answer with it and the manifest that keeps the
 * answer both read it, and the manifest's schema imports too much to be imported by a provider.
 */
export const HeardWord = z.object({ text: z.string(), start: z.number().min(0), end: z.number() }).refine((w) => w.end >= w.start, "a word ends before it starts");
