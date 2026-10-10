import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A stand-in for Google's token endpoint and the YouTube Data API, for the studio's tests: no test reaches
 * Google. The worker is pointed at it with GOOGLE_TOKEN_URL and YOUTUBE_API_BASE. It keeps what it was sent, so
 * a test can see exactly what would have gone to the platform.
 */
export type FakeYouTube = {
  url: string;
  /** What a consent would hand back: the code to exchange, bound to the PKCE challenge the consent page was given. */
  consent(challenge: string, opts?: { scope?: string; refresh?: boolean; channel?: { id: string; title: string } | null }): string;
  /** Token requests as they arrived (form fields). */
  tokens: Array<Record<string, string>>;
  /** Uploads that were finished: who asked (the bearer), what it was called, and how many bytes came. */
  uploads: Array<{ bearer: string; meta: { snippet?: { title?: string; description?: string }; status?: Record<string, unknown> }; bytes: number; id: string }>;
  /** The next upload is refused with this status. */
  refuseNext?: number;
  /** Refresh tokens the "user" has withdrawn. */
  revoked: Set<string>;
  stop(): Promise<void>;
};

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((done) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => done(Buffer.concat(parts)));
  });

export async function startYouTube(): Promise<FakeYouTube> {
  const codes = new Map<string, { challenge: string; scope: string; refresh: boolean; channel: { id: string; title: string } | null }>();
  const access = new Map<string, { id: string; title: string } | null>();
  const sessions = new Map<string, { bearer: string; meta: FakeYouTube["uploads"][number]["meta"] }>();
  let n = 0;
  const fake: FakeYouTube = {
    url: "", tokens: [], uploads: [], revoked: new Set(),
    consent(challenge, opts = {}) {
      const code = `code-${++n}`;
      codes.set(code, {
        challenge, refresh: opts.refresh ?? true, channel: opts.channel === undefined ? { id: `UC-${n}`, title: "Test channel" } : opts.channel,
        scope: opts.scope ?? "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      });
      return code;
    },
    stop: () => new Promise((done) => server.close(() => done())),
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", fake.url);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (req.method === "POST" && url.pathname === "/token") {
        const form = Object.fromEntries(new URLSearchParams((await read(req)).toString()));
        fake.tokens.push(form);
        if (form.client_secret !== "yt-secret") return json(401, { error: "invalid_client" });
        if (form.grant_type === "authorization_code") {
          const c = codes.get(form.code);
          // a code is good once, and only with the verifier its challenge was made from
          codes.delete(form.code);
          if (!c || createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
          const token = `at-${++n}`;
          access.set(token, c.channel);
          return json(200, { access_token: token, scope: c.scope, ...(c.refresh ? { refresh_token: `rt-${form.code}` } : {}) });
        }
        if (form.grant_type === "refresh_token") {
          if (fake.revoked.has(form.refresh_token) || !form.refresh_token?.startsWith("rt-")) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          const token = `at-${++n}`;
          access.set(token, null);
          return json(200, { access_token: token });
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (!access.has(bearer) && !url.pathname.startsWith("/upload/session/")) return json(401, { error: { message: "Invalid Credentials" } });
      if (req.method === "GET" && url.pathname === "/youtube/v3/channels") {
        const channel = access.get(bearer);
        return json(200, { items: channel ? [{ id: channel.id, snippet: { title: channel.title } }] : [] });
      }
      if (req.method === "POST" && url.pathname === "/upload/youtube/v3/videos") {
        const meta = JSON.parse((await read(req)).toString() || "{}") as FakeYouTube["uploads"][number]["meta"];
        if (fake.refuseNext) {
          const status = fake.refuseNext;
          fake.refuseNext = undefined;
          return json(status, { error: { message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } });
        }
        const session = `s${++n}`;
        sessions.set(session, { bearer, meta });
        return json(200, {}, { location: `${fake.url}/upload/session/${session}` });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/upload/session/")) {
        const session = sessions.get(url.pathname.split("/").at(-1) ?? "");
        const body = await read(req);
        if (!session) return json(404, { error: { message: "no such session" } });
        const id = `vid${String(++n).padStart(8, "0")}`;
        fake.uploads.push({ ...session, bytes: body.length, id });
        return json(200, { id });
      }
      return json(404, { error: { message: "not found" } });
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
