import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = readFile(".github/workflows/worker-image.yml", "utf8");
/** The text of one job, from its key to the next job (or the end). */
const job = async (name: string): Promise<string> => {
  const text = await workflow;
  const start = text.search(new RegExp(`^  ${name}:`, "m"));
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/^  [a-z0-9-]+:/m);
  return next < 0 ? rest : rest.slice(0, next);
};

describe("the worker image workflow, ltx job", () => {
  it("passes the Hugging Face token as a build secret and never as a build argument", async () => {
    const ltx = await job("ltx");
    expect(ltx).toMatch(/secrets:\s*\|?\s*\n?\s*hf_token=\$\{\{ secrets\.HF_TOKEN_LTX \}\}/);
    expect(ltx).not.toMatch(/build-args/);
    expect(await workflow).not.toMatch(/build-args[^]*HF_TOKEN_LTX/);
  });

  it("tags the image by the content of worker-ltx/ and is built when that folder changes", async () => {
    const ltx = await job("ltx");
    expect(ltx).toContain("l-$(git rev-parse HEAD:worker-ltx | cut -c1-12)");
    expect(ltx).toContain("flowchain-ltx");
    expect(ltx).toContain("context: worker-ltx");
    expect(await workflow).toMatch(/paths:.*"worker-ltx\/\*\*"/);
  });

  it("has room: a 150 minute limit and the runner's preinstalled toolchains removed first, without a third-party action", async () => {
    const ltx = await job("ltx");
    expect(ltx).toContain("timeout-minutes: 150");
    for (const dir of ["/usr/share/dotnet", "/usr/local/lib/android", "/opt/ghc", "/opt/hostedtoolcache/CodeQL"]) expect(ltx).toContain(`rm -rf ${dir}`);
    expect(ltx).not.toContain("free-disk-space");
  });
});
