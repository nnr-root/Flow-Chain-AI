import { listChannels } from "@/server/channels";
import { json, route } from "@/server/http";

export const GET = route({ write: false }, async () => json({ channels: await listChannels() }));
