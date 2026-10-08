import { describe, expect, it } from "vitest";
import { tooLittle } from "@/lib/balance";
import { DRAFT_CAP_USD, round4 } from "@/lib/credit";

describe("whether the credit covers an amount", () => {
  it("compares in ten-thousandths, the unit amounts are kept in", () => {
    expect(tooLittle(0.3, 0.1 + 0.2)).toBe(false); // 0.30000000000000004 is covered by 0.3
    expect(tooLittle(0.31, 0.31)).toBe(false);
    expect(tooLittle(0.3099, 0.31)).toBe(true);
    expect(tooLittle(0, DRAFT_CAP_USD)).toBe(true);
    expect(tooLittle(-0.2, 0.01)).toBe(true);
  });

  it("never stands in the way where credit does not apply, is not known yet, or nothing is needed", () => {
    expect(tooLittle(null, 5)).toBe(false);
    expect(tooLittle(1, undefined)).toBe(false);
    expect(tooLittle(-0.2, 0)).toBe(false); // free, even in debt
    expect(tooLittle(0, 0)).toBe(false);
  });

  it("rounds an amount to four decimals", () => {
    expect(round4(0.1 + 0.2)).toBe(0.3);
    expect(round4(0.12345)).toBe(0.1235);
  });
});
