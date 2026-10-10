import { body, json, route } from "@/server/http";
import { createSeries, listSeries, NewSeries } from "@/server/series";

export const GET = route({ write: false }, async () => json({ series: await listSeries() }));
export const POST = route({ write: true }, async (req) => json(await createSeries(NewSeries.parse(await body(req))), 201));
