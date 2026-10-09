import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isAllowedHost, isLoopbackHost } from "@/lib/hosts";
import { ApiError, body, errorResponse, guard, json, route } from "@/server/http";
import { request } from "./helpers";

const req = (headers: Record<string, string>, method = "POST") => new Request("http://127.0.0.1:3131/api/x", { method, headers });

describe("the loopback host test", () => {
  it("accepts the machine's own names, with or without a port and in any case", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:3131", "localhost", "localhost:3131", "LOCALHOST:3131", "[::1]", "[::1]:3131"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("refuses every other name, however much it looks like one, and a missing header", () => {
    const foreign = [
      "evil.example", "evil.example:3131", "localhost.evil.example", "127.0.0.1.evil.example:3131", "evil.example:127.0.0.1",
      "127.0.0.2", "192.168.1.5:3131", "0.0.0.0:3131", "::1", "localhost:", "localhost:3131:3131", " localhost", "",
    ];
    for (const host of foreign) expect(isLoopbackHost(host), host).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe("the allowed-host rule on a server", () => {
  it("adds exactly the one configured public name to the machine's own, in any case and with any port", () => {
    for (const host of ["studio.example.com", "studio.example.com:443", "STUDIO.Example.com", "localhost:3131", "127.0.0.1"]) {
      expect(isAllowedHost(host, "studio.example.com"), host).toBe(true);
    }
    for (const host of ["evil.example", "studio.example.com.evil.example", "xstudio.example.com", "example.com", "", null, undefined]) {
      expect(isAllowedHost(host, "studio.example.com"), String(host)).toBe(false);
    }
  });

  it("without a configured name, or with an empty one, only the machine's own names pass", () => {
    for (const publicHost of [undefined, "", "  "]) {
      expect(isAllowedHost("studio.example.com", publicHost)).toBe(false);
      expect(isAllowedHost("", publicHost)).toBe(false);
      expect(isAllowedHost("localhost:3131", publicHost)).toBe(true);
    }
  });

  it("guard() reads the name from STUDIO_HOST and still requires a same-origin write", () => {
    const before = process.env.STUDIO_HOST;
    process.env.STUDIO_HOST = "studio.example.com";
    try {
      const get = (host: string) => new Request("http://web:3131/api/x", { headers: { host } });
      expect(() => guard(get("studio.example.com"), { write: false })).not.toThrow();
      expect(() => guard(get("other.example.com"), { write: false })).toThrow("does not answer for other.example.com");
      const post = (headers: Record<string, string>) => new Request("http://web:3131/api/x", { method: "POST", headers: { host: "studio.example.com", ...headers } });
      expect(() => guard(post({ "sec-fetch-site": "same-origin" }), { write: true })).not.toThrow();
      expect(() => guard(post({ origin: "https://studio.example.com" }), { write: true })).not.toThrow();
      expect(() => guard(post({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), { write: true })).toThrow("only be started from the studio itself");
    } finally {
      if (before === undefined) delete process.env.STUDIO_HOST;
      else process.env.STUDIO_HOST = before;
    }
  });
});

describe("the origin guard", () => {
  it("answers loopback hosts only, so a DNS name pointed at this machine is refused", () => {
    for (const host of ["127.0.0.1:3131", "localhost:3131", "localhost", "[::1]:3131"]) {
      expect(() => guard(req({ host }, "GET"), { write: false })).not.toThrow();
    }
    expect(() => guard(req({ host: "evil.example:3131" }, "GET"), { write: false })).toThrow("does not answer for evil.example");
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

  it("route() marks the handler it returns with whether it is a write", () => {
    const write = route({ write: true }, () => json({}));
    const read = route({ write: false }, () => json({}));
    expect((write as { write?: boolean }).write).toBe(true);
    expect((read as { write?: boolean }).write).toBe(false);
    expect(Object.keys(write)).toEqual([]);
  });

  it("body() takes JSON only", async () => {
    const post = (type: string, text: string) => new Request("http://127.0.0.1/api", { method: "POST", headers: { "content-type": type }, body: text });
    expect(await body(post("application/json; charset=utf-8", '{"a":1}'))).toEqual({ a: 1 });
    await expect(body(post("text/plain", '{"a":1}'))).rejects.toThrow("send JSON");
    await expect(body(post("application/json", "{nope"))).rejects.toThrow("not valid JSON");
  });
});

describe("a studio that is meant to have accounts and has none configured", () => {
  it("answers nothing at all, the health check included: it would otherwise be open to anyone", async () => {
    const { GET: ping } = await import("@/app/api/ping/route");
    const { GET: runs } = await import("@/app/api/runs/route");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    expect((await ping(request("/api/ping"), undefined)).status).toBe(200);
    process.env.STUDIO_AUTH = "accounts";
    try {
      for (const res of [await ping(request("/api/ping"), undefined), await runs(request("/api/runs"), undefined)]) {
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("has none configured");
      }
      const page = await proxy(new NextRequest("http://127.0.0.1:3131/", { headers: { host: "127.0.0.1:3131" } }));
      expect(page?.status).toBe(503);
      // with the proxy's own login in front there is nothing to refuse
      process.env.STUDIO_AUTH = "proxy";
      expect((await ping(request("/api/ping"), undefined)).status).toBe(200);
      expect(await proxy(new NextRequest("http://127.0.0.1:3131/", { headers: { host: "127.0.0.1:3131" } }))).toBeUndefined();
    } finally {
      delete process.env.STUDIO_AUTH;
    }
  });
});
