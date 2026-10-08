import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogueItem } from "@/lib/billing";
import { clipsClaimHolds, clipsCostUsd, Comparison, freshComparisons, mean, pricePerCreditDollar, quote, usdPerSecond } from "@/lib/site/calculator";

const item = (kind: "plan" | "topup", key: string, priceUsd: number, creditUsd: number): CatalogueItem => ({ priceId: `price_${key}`, kind, key, name: key, priceUsd, creditUsd });
const starter = item("plan", "starter", 19, 12);
const pro = item("plan", "pro", 49, 35);
const ten = item("topup", "topup-10", 10, 6);
const twentyFive = item("topup", "topup-25", 25, 16);
const all = [starter, pro, ten, twentyFive];
const names = (q: ReturnType<typeof quote>) => q?.buy.map((b) => `${b.times} × ${b.item.key}`);

describe("what a month of videos costs", () => {
  it("is the cheapest way in the catalogue to cover them", () => {
    // 10 videos at 32 cents use $3.20: one $10 top-up ($6 of credit) is cheaper than the $19 plan
    expect(quote(10, 0.32, all)).toEqual({ buy: [{ item: ten, times: 1 }], monthUsd: 10, creditUsd: 6, videos: 18, perVideoUsd: 1 });
    // 30 videos use $9.60: Starter's $12 for $19 beats two $10 top-ups ($20 for $12)
    expect(names(quote(30, 0.32, all))).toEqual(["1 × starter"]);
    expect(quote(30, 0.32, all)).toMatchObject({ monthUsd: 19, creditUsd: 12, videos: 37, perVideoUsd: 0.63 });
    // 60 videos use $19.20: Starter and a $25 top-up ($44) are cheaper than Pro ($49)
    expect(names(quote(60, 0.32, all))).toEqual(["1 × starter", "1 × topup-25"]);
    // 100 use $32: Pro covers them
    expect(names(quote(100, 0.32, all))).toEqual(["1 × pro"]);
    expect(quote(100, 0.32, all)?.perVideoUsd).toBe(0.49);
    // 200 use $64: Pro and top-ups beside it
    expect(names(quote(200, 0.32, all))).toEqual(["1 × pro", "2 × topup-25"]);
  });

  it("never quotes less credit than the videos use, to the hundredth of a cent", () => {
    for (let videos = 1; videos <= 250; videos++) {
      for (const each of [0.2292, 0.3169, 0.8124, 0.1, 0.3]) {
        const q = quote(videos, each, all)!;
        expect(Math.round(q.creditUsd * 10_000), `${videos} at ${each}`).toBeGreaterThanOrEqual(Math.round(videos * each * 10_000));
        expect(q.videos).toBeGreaterThanOrEqual(videos);
        expect(q.monthUsd).toBe(q.buy.reduce((sum, b) => sum + b.item.priceUsd * b.times, 0));
      }
    }
    // 0.1 + 0.2 covers 0.3: three videos at 10 cents are covered by 30 cents of credit
    expect(quote(3, 0.1, [item("topup", "tiny", 1, 0.3)])?.videos).toBe(3);
  });

  it("has nothing to say without a catalogue or without numbers", () => {
    expect(quote(10, 0.32, [])).toBeNull();
    expect(quote(0, 0.32, all)).toBeNull();
    expect(quote(1.5, 0.32, all)).toBeNull();
    expect(quote(10, 0, all)).toBeNull();
    expect(quote(10, Number.NaN, all)).toBeNull();
    // plans only: a month that no plan covers cannot be quoted, rather than quoted short
    expect(quote(200, 0.32, [starter, pro])).toBeNull();
    expect(names(quote(30, 0.32, [starter, pro]))).toEqual(["1 × starter"]);
  });

  it("knows what a dollar of credit costs, and a mean", () => {
    expect(pricePerCreditDollar(starter)).toBeCloseTo(1.5833, 4);
    expect(pricePerCreditDollar(pro)).toBe(1.4);
    expect(mean([0.3169, 0.2292])).toBe(0.2731);
    expect(mean([])).toBe(0);
  });
});

describe("another company's price", () => {
  const luma = { name: "Luma", plan: "Plus", planUsdPerMonth: 30, creditsPerMonth: 10000, model: "Ray 3.14", resolution: "540p", creditsPerSecond: 10, source: "https://lumalabs.ai/pricing", checkedOn: "2026-10-08" };
  const today = new Date("2026-10-20T12:00:00Z");

  it("is shown only with a source, well-formed, and read within ninety days", () => {
    expect(freshComparisons([luma], today)).toEqual([luma]);
    expect(freshComparisons([luma], new Date("2027-01-06T00:00:00Z"))).toEqual([luma]); // the ninetieth day
    expect(freshComparisons([luma], new Date("2027-01-07T00:00:01Z"))).toEqual([]);
    for (const bad of [
      { ...luma, source: "" }, { ...luma, source: "http://lumalabs.ai/pricing" }, { ...luma, source: "lumalabs.ai" },
      { ...luma, checkedOn: "last week" }, { ...luma, checkedOn: "2026-10-21" }, // read "tomorrow"
      { ...luma, creditsPerSecond: 0 }, { ...luma, planUsdPerMonth: "30" }, { name: "Luma" }, null,
    ]) expect(freshComparisons([bad], today), JSON.stringify(bad)).toEqual([]);
    // one bad entry does not take the good ones with it
    expect(freshComparisons([{ ...luma, source: "" }, luma], today)).toEqual([luma]);
    expect(freshComparisons("not a list", today)).toEqual([]);
  });

  it("is worked out from its plan's price per credit", () => {
    expect(usdPerSecond(Comparison.parse(luma))).toBeCloseTo(0.03, 10);
    expect(clipsCostUsd(Comparison.parse(luma), 15)).toBe(0.45);
    expect(clipsCostUsd(Comparison.parse({ ...luma, name: "Runway", planUsdPerMonth: 15, creditsPerMonth: 625, creditsPerSecond: 6 }), 15)).toBe(2.16);
  });

  it("lets the page claim \"about what others charge for the clips\" only while the numbers bear it out", () => {
    const cheap = Comparison.parse(luma); // 3 cents a second: 15.5 s of clips for about 47 cents
    const dear = Comparison.parse({ ...luma, name: "Runway", planUsdPerMonth: 15, creditsPerMonth: 625, creditsPerSecond: 6 });
    // a video using 27 cents of credit, bought at the dearest rate here (the $10 top-up: $1.67 a dollar), is 46 cents
    expect(clipsClaimHolds(0.2731, 15.5, all, [cheap, dear])).toBe(true);
    // it is the cheapest of the others that decides, not the dearest
    expect(clipsClaimHolds(0.8124, 9.7, all, [cheap, dear])).toBe(false);
    expect(clipsClaimHolds(0.8124, 9.7, all, [dear])).toBe(true);
    // a little above is still "about"; well above is not
    expect(clipsClaimHolds(0.32, 15.5, all, [cheap])).toBe(true); // 53 cents against 47
    expect(clipsClaimHolds(0.36, 15.5, all, [cheap])).toBe(false); // 60 cents
    // nothing to compare, nothing claimed
    expect(clipsClaimHolds(0.2731, 15.5, all, [])).toBe(false);
    expect(clipsClaimHolds(0.2731, 15.5, [], [cheap])).toBe(false);
    expect(clipsClaimHolds(0, 15.5, all, [cheap])).toBe(false);
  });

  it("is, in the file the page reads, something the page may show today", () => {
    const entries = JSON.parse(readFileSync(join(__dirname, "../content/comparison.json"), "utf8")) as unknown[];
    expect(entries.length).toBeGreaterThan(0);
    // every entry is well-formed and sourced (whether it is still fresh depends on the day, and the page decides that)
    for (const entry of entries) expect(Comparison.safeParse(entry).success, JSON.stringify(entry)).toBe(true);
  });
});
