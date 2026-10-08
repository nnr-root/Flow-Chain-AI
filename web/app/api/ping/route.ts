import { json, route } from "@/server/http";

export const dynamic = "force-dynamic";
/** "The web app is up": for the container's health check. Says nothing about anyone, so it needs no session, and asks nothing of the worker. */
export const GET = route({ write: false, public: true }, () => json({ ok: true }));
