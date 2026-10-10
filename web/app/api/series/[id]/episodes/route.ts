import { json, route } from "@/server/http";
import { nextEpisode } from "@/server/series";

type Ctx = { params: Promise<{ id: string }> };

/** Starts the series' next video: a paid draft like any other (the script is held from the caller's credit). */
export const POST = route<Ctx>({ write: true }, async (_req, ctx) => json(await nextEpisode((await ctx.params).id), 202));
