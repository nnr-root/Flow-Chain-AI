import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/server/http";
import { boundedForm, clientOf, limitAttempts, resetAttempts } from "@/server/limits";

const req = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3131/x", { method: "POST", headers });

describe("who a request comes from", () => {
  it("is the address the proxy itself saw: the last one, whatever a client put in front of it", () => {
    expect(clientOf(req({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientOf(req({ "x-forwarded-for": "10.0.0.1, 198.51.100.7,  203.0.113.5 " }))).toBe("203.0.113.5");
    expect(clientOf(req())).toBe("local");
  });
});

describe("attempts per visitor", () => {
  beforeEach(() => resetAttempts());

  it("allows so many in a window, then refuses until the window is over", () => {
    const r = req({ "x-forwarded-for": "203.0.113.5" });
    for (let i = 0; i < 3; i++) limitAttempts(r, "auth", 3, 60_000, 1000);
    expect(() => limitAttempts(r, "auth", 3, 60_000, 2000)).toThrow(ApiError);
    try {
      limitAttempts(r, "auth", 3, 60_000, 2000);
    } catch (err) {
      expect(err).toMatchObject({ code: "busy", hint: "try again in 1 minute(s)" });
    }
    // another visitor, and another kind of attempt, have windows of their own
    limitAttempts(req({ "x-forwarded-for": "203.0.113.6" }), "auth", 3, 60_000, 2000);
    limitAttempts(r, "other", 3, 60_000, 2000);
    // and when the window is over, it starts again
    limitAttempts(r, "auth", 3, 60_000, 62_000);
  });
});

describe("an upload's size", () => {
  const form = (bytes: number) => {
    const f = new FormData();
    f.set("name", "x");
    f.set("file", new File([new Uint8Array(bytes)], "a.bin"));
    return f;
  };
  const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3131/x", { method: "POST", body, headers });

  it("is bounded before and while the form is read", async () => {
    const ok = await boundedForm(post(form(1000)), 5000);
    expect((ok.get("file") as File).size).toBe(1000);
    expect(ok.get("name")).toBe("x");
    // it says it is too large: refused without reading
    await expect(boundedForm(post("x", { "content-type": "multipart/form-data; boundary=x", "content-length": "999999" }), 5000)).rejects.toThrow("too large");
    await expect(boundedForm(post("x", { "content-type": "multipart/form-data; boundary=x", "content-length": "lots" }), 5000)).rejects.toThrow("too large");
    // it says nothing (or too little) and is too large: cut off at the limit
    await expect(boundedForm(post(form(20_000)), 5000)).rejects.toThrow("the upload is too large (at most 0 MB in all)");
    // not a form at all
    await expect(boundedForm(post(JSON.stringify({ a: 1 }), { "content-type": "application/json" }), 5000)).rejects.toThrow("send the file as a form");
    await expect(boundedForm(post("not a form", { "content-type": "multipart/form-data; boundary=x" }), 5000)).rejects.toThrow("send the file as a form");
  });
});
