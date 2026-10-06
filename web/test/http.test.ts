import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, body, errorResponse, guard, json, route } from "@/server/http";

const req = (headers: Record<string, string>, method = "POST") => new Request("http://127.0.0.1:3131/api/x", { method, headers });

describe("the origin guard", () => {
  it("answers loopback hosts only, so a DNS name pointed at this machine is refused", () => {
    for (const host of ["127.0.0.1:3131", "localhost:3131", "localhost", "[::1]:3131"]) {
      expect(() => guard(req({ host }, "GET"), { write: false })).not.toThrow();
    }
    expect(() => guard(req({ host: "evil.example:3131" }, "GET"), { write: false })).toThrow("only answers on localhost");
  });

  it("lets a write through only from the studio's own pages", () => {
    const host = "127.0.0.1:3131";
    expect(() => guard(req({ host, "sec-fetch-site": "same-origin" }), { write: true })).not.toThrow();
    // an older browser without fetch metadata: the Origin header must be the studio's own
    expect(() => guard(req({ host, origin: "http://127.0.0.1:3131" }), { write: true })).not.toThrow();
    const refused: Array<Record<string, string>> = [
      { host, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { host, "sec-fetch-site": "same-site" },
      { host, origin: "https://evil.example" },
      { host, origin: "null" },
      { host }, // curl or a script: no proof of where it comes from
    ];
    for (const headers of refused) {
      expect(() => guard(req(headers), { write: true })).toThrow("only be started from the studio itself");
    }
  });

  it("does not ask reads for an origin", () => {
    expect(() => guard(req({ host: "localhost:3131" }, "GET"), { write: false })).not.toThrow();
  });
});

describe("responses", () => {
  it("every error has the one shape, with its status, hint and extra data", async () => {
    const res = errorResponse(new ApiError("estimate_changed", "now $2.00", "confirm again", { totalUsd: 2 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "estimate_changed", message: "now $2.00", hint: "confirm again", totalUsd: 2 } });
  });

  it("a schema failure names the field; anything unexpected is a plain 500 without details", async () => {
    const bad = errorResponse(z.object({ topic: z.string() }).safeParse({}).error);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatchObject({ code: "validation", message: expect.stringContaining("topic") });
    const boom = errorResponse(new Error("/secret/path exploded"));
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("secret");
  });

  it("route() guards first and turns thrown errors into responses", async () => {
    const handler = route({ write: true }, () => json({ ok: true }));
    expect((await handler(req({ host: "127.0.0.1:3131" }), undefined)).status).toBe(403);
    expect(await (await handler(req({ host: "127.0.0.1:3131", "sec-fetch-site": "same-origin" }), undefined)).json()).toEqual({ ok: true });
    const failing = route({ write: false }, () => {
      throw new ApiError("not_found", "no run x");
    });
    expect((await failing(req({ host: "localhost" }, "GET"), undefined)).status).toBe(404);
  });

  it("body() takes JSON only", async () => {
    const post = (type: string, text: string) => new Request("http://127.0.0.1/api", { method: "POST", headers: { "content-type": type }, body: text });
    expect(await body(post("application/json; charset=utf-8", '{"a":1}'))).toEqual({ a: 1 });
    await expect(body(post("text/plain", '{"a":1}'))).rejects.toThrow("send JSON");
    await expect(body(post("application/json", "{nope"))).rejects.toThrow("not valid JSON");
  });
});
