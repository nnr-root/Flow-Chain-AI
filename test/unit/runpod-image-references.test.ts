import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices, runpodRates } from "../../src/config.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { RunpodImage, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { makeImage, tempDir } from "../helpers/media.js";

function deps(api: FakeRunpodApi): RunpodDeps {
  let t = 0;
  return {
    client: new RunpodClient("k", { fetch: api.fetch }),
    r2: {} as unknown as R2,
    rates: runpodRates(Prices.parse({})),
    poll: { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t },
  };
}

async function pictures() {
  const dir = await tempDir();
  const a = join(dir, "a.png");
  const b = join(dir, "b.png");
  await makeImage(a, { width: 2048, height: 1024, color: "0x3366aa" });
  await makeImage(b, { width: 512, height: 512, color: "0xaa6633" });
  return { a, b };
}

describe("a keyframe request with several references", () => {
  it("sends them in order, shrunk to JPEGs, as a list, and not as the single field", async () => {
    const { a, b } = await pictures();
    const image = new RunpodImage(deps(new FakeRunpodApi(() => [])), { endpointId: "ep-f", workflow: "keyframe-flux3-klein", version: 1 });
    const job = await image.prepare({ prompt: "p", width: 1088, height: 1920, referenceImagePaths: [a, b] });
    const input = job.input as { workflow: string; references: string[] };
    expect(input.workflow).toBe("keyframe-flux3-klein@1");
    expect(input.references).toHaveLength(2);
    expect(job.input).not.toHaveProperty("reference");
    for (const r of input.references) expect(Buffer.from(r, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(input.references[0]).not.toBe(input.references[1]);
  });

  it("still sends the single field for the 4B worker, and neither field when there is no reference", async () => {
    const { a } = await pictures();
    const image = new RunpodImage(deps(new FakeRunpodApi(() => [])), { endpointId: "ep-k", workflow: "keyframe-klein", version: 1 });
    const one = await image.prepare({ prompt: "p", width: 1088, height: 1920, referenceImagePath: a });
    expect(typeof (one.input as { reference: string }).reference).toBe("string");
    expect(one.input).not.toHaveProperty("references");
    const none = await image.prepare({ prompt: "p", width: 1088, height: 1920 });
    expect(none.input).not.toHaveProperty("reference");
    expect(none.input).not.toHaveProperty("references");
  });
});
