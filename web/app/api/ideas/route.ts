import { body, json, route } from "@/server/http";
import { suggestIdeas } from "@/server/ideas";
import { IdeasInput } from "@/server/schemas";

export const POST = route({ write: true }, async (req) => json(await suggestIdeas(IdeasInput.parse(await body(req)))));
