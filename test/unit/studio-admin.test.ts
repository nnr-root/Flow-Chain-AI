import { describe, expect, it } from "vitest";
import { grantRefusal, grantSql, parseGrant, parseWelcome, welcomeSql } from "../../src/deploy/studio-admin.js";

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

  it("becomes one statement for the server's database, in which nothing the owner typed can end a string", () => {
    expect(grantSql({ email: "ann@example.com", usd: 5, note: "" })).toBe("select public.grant_credit($q$ann@example.com$q$, 5.0000::numeric, $q$$q$);\n");
    expect(grantSql({ email: "ann@example.com", usd: -2.5, note: "it's a refund; drop table users" })).toBe("select public.grant_credit($q$ann@example.com$q$, -2.5000::numeric, $q$it's a refund; drop table users$q$);\n");
    // a note that contains the quoting tag itself gets another tag, as often as it takes
    const sly = grantSql({ email: "ann@example.com", usd: 1, note: "x$q$); delete from ledger; --$qq$" });
    expect(sly).toBe("select public.grant_credit($q$ann@example.com$q$, 1.0000::numeric, $qqq$x$q$); delete from ledger; --$qq$$qqq$);\n");
    expect(() => grantSql({ email: "a@b.c", usd: Number.NaN, note: "" })).toThrow("not an amount");
  });

  it("says in the owner's words why the database refused", () => {
    const g = { email: "ann@example.com", usd: 5, note: "" };
    expect(grantRefusal("ERROR:  not_found\nCONTEXT:  PL/pgSQL function grant_credit", g)).toBe("no account with the address ann@example.com (they must sign up first)");
    expect(grantRefusal("ERROR:  invalid_amount", g)).toContain("the amount must be");
    expect(grantRefusal("ssh: connect to host: Connection refused", g)).toBeNull();
  });
});

describe("studio:welcome", () => {
  it("reads what a new account starts with, and the day's limit when one is given", () => {
    expect(parseWelcome(["--usd", "0.05"])).toEqual({ usd: 0.05 });
    expect(parseWelcome(["--cap", "10", "--usd", "0"])).toEqual({ usd: 0, capUsd: 10 });
    expect(welcomeSql({ usd: 0.05 })).toBe("update public.settings set welcome_credit_usd = 0.0500 returning welcome_credit_usd || ' ' || welcome_daily_cap_usd;\n");
    expect(welcomeSql({ usd: 0, capUsd: 10 })).toContain("set welcome_credit_usd = 0.0000, welcome_daily_cap_usd = 10.0000 returning");
  });

  it.each([
    [[], "--usd must be given"],
    [["--usd", "-1"], "--usd must be an amount from 0 to 5"],
    [["--usd", "50"], "--usd must be an amount from 0 to 5"],
    [["--usd", "0.05; drop table users"], "--usd must be an amount"],
    [["--usd", "0.05", "--cap", "lots"], "--cap must be an amount"],
    [["--usd", "0.05", "--yes"], "unknown option --yes"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseWelcome(argv)).toThrow(message);
  });
});
