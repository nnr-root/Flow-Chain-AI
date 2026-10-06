import { describe, expect, it } from "vitest";
import { GET as kits, POST as createKit } from "@/app/api/brand-kits/route";
import { GET as kitLogo } from "@/app/api/brand-kits/[slug]/logo/route";
import { GET as music } from "@/app/api/music/route";
import { params, request, useStudio } from "./helpers";

useStudio();

describe("the library", () => {
  it("creates a kit from a form, lists it and serves its logo", async () => {
    const form = new FormData();
    form.set("name", "Acme");
    form.set("logo", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "logo.png"));
    const created = await createKit(request("/api/brand-kits", { body: form }), undefined);
    expect(created.status).toBe(201);
    expect((await (await kits(request("/api/brand-kits"), undefined)).json()).kits).toEqual([expect.objectContaining({ slug: "acme", name: "Acme" })]);
    const logo = await kitLogo(request("/api/brand-kits/acme/logo"), params({ slug: "acme" }));
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect((await kitLogo(request("/api/brand-kits/x/logo"), params({ slug: "../x" }))).status).toBe(404);
    const cross = await createKit(request("/api/brand-kits", { body: form, headers: { "sec-fetch-site": "cross-site" } }), undefined);
    expect(cross.status).toBe(403);
  });

  it("lists music", async () => {
    expect((await (await music(request("/api/music"), undefined)).json()).tracks).toEqual([]);
  });
});
