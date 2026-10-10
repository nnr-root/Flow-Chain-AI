import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import measured from "@/content/measured.json";
import { amount, money } from "@/lib/api";
import { credits, CREDITS_PER_USD, inCredits, usdOfCredits } from "@/lib/credit";
import { fullyGeneratedMinutes, minutesOnSale } from "@/lib/site/calculator";
import { SHOWCASES } from "@/lib/site/showcases";
import { parsePlans } from "@src/deploy/stripe-setup";

describe("credits: the unit a customer is shown", () => {
  const before = process.env.DATABASE_URL;
  afterEach(() => {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  });

  it("are the same amount as the dollars of cost everything else counts in, at one rate", () => {
    expect(CREDITS_PER_USD).toBe(2000);
    expect([credits(0.0055), credits(0.141), credits(2.5), credits(0)]).toEqual([11, 282, 5000, 0]);
    expect([inCredits(0.0005), inCredits(0.141), inCredits(22.5)]).toEqual(["1 credit", "282 credits", "45,000 credits"]);
    // typed in credits, kept in dollars to four decimals, and back
    expect(usdOfCredits(1000)).toBe(0.5);
    expect(credits(usdOfCredits(777))).toBe(777);
  });

  it("are what a studio with customers shows; the owner's own studio shows its bill in dollars", () => {
    process.env.DATABASE_URL = "postgres://x";
    expect([amount(0.31), amount(0.0055), amount(18)]).toEqual(["620 credits", "11 credits", "36,000 credits"]);
    delete process.env.DATABASE_URL;
    expect([amount(0.31), amount(0.0055)]).toEqual(["$0.31", "$0.0055"]);
    // real money is always dollars: a plan's price, a payment
    process.env.DATABASE_URL = "postgres://x";
    expect(money(19)).toBe("$19.00");
  });
});

describe("what is on sale", () => {
  const plans = parsePlans(readFileSync(resolve("billing/plans.json"), "utf8"));
  const perScene = SHOWCASES.reduce((sum, s) => sum + s.receipt.seconds / s.receipt.scenes, 0) / SHOWCASES.length;
  const today = new Date("2026-10-10T12:00:00Z");

  it("is three plans whose credits are round numbers, each cheaper per credit than the one before, and top-ups dearer than any plan", () => {
    const sold = plans.filter((p) => p.kind === "plan");
    expect(sold.map((p) => [p.key, p.priceUsd, credits(p.creditUsd)])).toEqual([["starter", 19, 5000], ["creator", 39, 15000], ["pro", 89, 45000]]);
    const perCredit = (p: { priceUsd: number; creditUsd: number }) => p.priceUsd / credits(p.creditUsd);
    expect(perCredit(sold[1])).toBeLessThan(perCredit(sold[0]));
    expect(perCredit(sold[2])).toBeLessThan(perCredit(sold[1]));
    for (const topup of plans.filter((p) => p.kind === "topup")) {
      expect(credits(topup.creditUsd) % 1000).toBe(0);
      expect(perCredit(topup)).toBeGreaterThan(perCredit(sold[0]));
    }
  });

  it("covers at least the minutes each plan is built around, by the measured cost of a fully generated video", () => {
    const minutes = plans.filter((p) => p.kind === "plan").map((p) => fullyGeneratedMinutes(p.creditUsd, measured, perScene, today));
    // five, fifteen and forty-five minutes are the plans' design; what is said on the page is what the figures give
    expect(minutes[0]).toBeGreaterThanOrEqual(5);
    expect(minutes[1]).toBeGreaterThanOrEqual(15);
    expect(minutes[2]).toBeGreaterThanOrEqual(45);
    expect(minutes[0]).toBeLessThan(8);
  });

  it("says nothing about minutes when the measurement is old, missing or malformed, or the amount covers less than one", () => {
    expect(fullyGeneratedMinutes(2.5, measured, perScene, new Date("2027-02-01T00:00:00Z"))).toBeNull();
    expect(fullyGeneratedMinutes(2.5, {}, perScene, today)).toBeNull();
    expect(fullyGeneratedMinutes(2.5, { fullyGenerated: { ...measured.fullyGenerated, usd: 0 } }, perScene, today)).toBeNull();
    expect(fullyGeneratedMinutes(2.5, measured, 0, today)).toBeNull();
    expect(fullyGeneratedMinutes(0.05, measured, perScene, today)).toBeNull();
    expect(minutesOnSale([{ priceId: "price_a", creditUsd: 2.5 }], measured, [], today)).toEqual({ price_a: null });
    // worked out, and never rounded up: twice the credit is at least twice the minutes less one
    const one = fullyGeneratedMinutes(2.5, measured, perScene, today)!;
    expect(fullyGeneratedMinutes(5, measured, perScene, today)).toBeGreaterThanOrEqual(one * 2);
    expect(fullyGeneratedMinutes(5, measured, perScene, today)).toBeLessThanOrEqual(one * 2 + 1);
  });
});
