import { createDraft } from "@/server/actions";
import { body, json, route } from "@/server/http";
import { NewVideo } from "@/server/schemas";

export const POST = route({ write: true }, async (req) => json(await createDraft(NewVideo.parse(await body(req))), 202));
