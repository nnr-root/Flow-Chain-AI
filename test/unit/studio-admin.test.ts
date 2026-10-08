import { describe, expect, it } from "vitest";
import { adminProject, parseGrant } from "../../src/deploy/studio-admin.js";

describe("studio:grant", () => {
  it("reads an address, an amount and an optional note", () => {
    expect(parseGrant(["--email", "Ann@Example.com", "--usd", "5"])).toEqual({ email: "ann@example.com", usd: 5, note: "" });
    expect(parseGrant(["--usd", "-2.50", "--note", "refund of a failed run", "--email", "ann@example.com"])).toEqual({ email: "ann@example.com", usd: -2.5, note: "refund of a failed run" });
    expect(parseGrant(["--email", "ann@example.com", "--usd", "0.12345"]).usd).toBe(0.1235);
  });

  it.each([
    [["--usd", "5"], "--email must be"],
    [["--email", "not-an-address", "--usd", "5"], "--email must be"],
    [["--email", "ann@example.com"], "--usd must be"],
    [["--email", "ann@example.com", "--usd", "0"], "--usd must be"],
    [["--email", "ann@example.com", "--usd", "five"], "--usd must be"],
    [["--email", "ann@example.com", "--usd", "5000"], "more than $1000"],
    [["--email", "ann@example.com", "--usd", "5", "--yes"], "unknown option --yes"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseGrant(argv)).toThrow(message);
  });

  it("needs the project and its service key", () => {
    expect(adminProject({ SUPABASE_URL: " https://abc.supabase.co ", SUPABASE_SERVICE_ROLE_KEY: "service" })).toEqual({ url: "https://abc.supabase.co", serviceKey: "service" });
    expect(() => adminProject({ SUPABASE_URL: "https://abc.supabase.co" })).toThrow("must be set");
  });
});
