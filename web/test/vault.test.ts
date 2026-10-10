import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open, seal, vaultReady } from "../worker/vault";

describe("how a channel's token is kept", () => {
  const before = process.env.CHANNEL_KEY;
  beforeEach(() => {
    process.env.CHANNEL_KEY = Buffer.alloc(32, 5).toString("base64");
  });
  afterEach(() => {
    if (before === undefined) delete process.env.CHANNEL_KEY;
    else process.env.CHANNEL_KEY = before;
  });
  const USER = "11111111-1111-4111-8111-111111111111";

  it("opens what it sealed, for the user it was sealed for, and shows nothing of it meanwhile", () => {
    const sealed = seal("1//refresh-token-of-a-channel", USER);
    expect(sealed.toString("latin1")).not.toContain("refresh-token");
    expect(open(sealed, USER)).toBe("1//refresh-token-of-a-channel");
    // sealed twice it is not the same bytes: nothing is learned from two rows looking alike
    expect(seal("1//refresh-token-of-a-channel", USER).equals(sealed)).toBe(false);
  });

  it("does not open for another user, with another key, or once a byte was changed", () => {
    const sealed = seal("secret", USER);
    expect(() => open(sealed, "22222222-2222-4222-8222-222222222222")).toThrow();
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] ^= 1;
    expect(() => open(changed, USER)).toThrow();
    process.env.CHANNEL_KEY = Buffer.alloc(32, 6).toString("base64");
    expect(() => open(sealed, USER)).toThrow();
  });

  it("refuses to work without a key of the right size", () => {
    for (const bad of ["", "short", Buffer.alloc(16, 1).toString("base64")]) {
      process.env.CHANNEL_KEY = bad;
      expect(vaultReady()).toBe(false);
      expect(() => seal("x", USER)).toThrow("CHANNEL_KEY");
    }
  });
});
