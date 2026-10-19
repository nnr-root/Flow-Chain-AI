# Phase 10 — FLUX 3 klein as the picture model, and reframe cuts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo subagents are dispatched only when the owner asks for them.

**Goal:** Add FLUX 3 klein as a second, selectable picture model behind its own profile (the 4B stays as the fallback), and make cuts feel related: every later keyframe is conditioned on a shared look anchor, and a `reframe` cut on a documentary, story or pov video is drawn from the previous keyframe.

**Architecture:** A new image profile `runpod-flux3-klein@1` (selected only when its endpoint and rates are configured) with its own worker engine on a separate endpoint; keyframes gain an ordered reference list (`referencesFor`) carried by a new `referenceImagePaths` field; a scene gains an optional `reframe` flag the script prompt offers only to types that may use it; the Gemini prompt upsampler and a copy/content check are new Gemini calls under `PROMPT_VERSION`; `eval:cuts` compares two finished runs for free.

**Tech Stack:** TypeScript (ESM, `.js` suffixes in `src/`, `scripts/`, `test/`), zod, vitest, Python (picture worker, `pytest` via `npm run test:worker`), ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-18-phase10-flux3-reframe-design.md` (read first; §12, written by Task 1, wins over earlier sections). Phase 9 spec `2026-10-18-phase9-prompt-audit-design.md` governs `PROMPT_VERSION`, the pin test and the eval conventions.

## Global Constraints

- **Never run** `npm run runpod:deploy`, `fetch-models`, `smoke*`, `npm run eval:prompts`, or anything that calls RunPod, Gemini, or Hugging Face with a token. Never download the gated weights. Tests never need any of them. (CLAUDE.md, "Rules that are never broken".)
- **Never read or print `.env`.** Environment values are passed through the owner's shell only.
- **Never commit** `.env`, `deploy/server.env`, `eval-out/`, `.superpowers/`, model weights.
- `test/unit/compat.test.ts` is never edited and must stay green; a run without references keeps every cache key it had (a test pins it, Task 6).
- New manifest fields are **optional**. Old runs keep their image profile (`runpod-klein@1`) and their keys.
- **A customer is shown credits, never dollars**; no customer-facing surface names a model or provider (`INTERNAL_NAMES` in `web/lib/engines.ts`, held by `web/test/names.test.ts`).
- The new profile is selectable **only** when `RUNPOD_PICTURE3_ENDPOINT` is set **and** all four rates are in `prices.json`; no invented prices.
- Every change to prompt text, an imported content file, the temperature table, or the text `visual.ts` adds **bumps `PROMPT_VERSION`** (`src/providers/prompt-version.ts`), adds a changelog line to the Phase 9 spec, and regenerates the pins (`UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts`, only after the bump). Current version: `2026-10-18.11`. This plan uses `.12` (Task 7), `.13` (Task 8), `.14` (Task 9).
- Count and split words only through `src/voice/words.ts`.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` + one sentence saying what is now true, then a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit on `main`; **never push** (a push needs the owner's click via AskUserQuestion).
- Tests are named as sentences about behaviour; a test for a fix must be shown to fail without the fix.
- **Three facts exist only after Task 1** and are copied from spec §3.1, never invented: the FLUX 3 call shape and the switch for its built-in upsampler (Task 3), the pinned `REVISION`, files, sizes and hashes (Task 3), and the upsampler's instructions (Task 8). A task that finds them missing in §3.1 stops and reports; it does not guess.
- Run `npm run typecheck` before each commit; Python changes also run `npm run test:worker` (needs `npm run setup:worker` once; if the venv is missing, say so and run the Python test file with the system `pytest` when available).

## File Structure

| Path | Responsibility |
|---|---|
| `src/config.ts` (modify) | env: `RUNPOD_PICTURE3_ENDPOINT`, `FLOWCHAIN_IMAGE_MODEL`, `FLOWCHAIN_CUT_REFERENCES`; prices: four optional FLUX 3 rates; `flux3Rates()` |
| `src/image-profiles.ts` (modify) | the new profile, `takesSeveralReferences()` |
| `src/providers/model-id.ts`, `new-run.ts` (modify) | workflow id; profile selection with the 4B fallback lever |
| `web/lib/engines.ts` (modify) | model names kept off customer surfaces |
| `worker-picture/src/flowchain_picture/contract.py`, `handler.py` (modify); `engine_flux3.py`, `weights_flux3.py` (new) | the FLUX 3 engine, multi-reference contract, weights |
| `src/deploy/runpod.ts`, `scripts/runpod-deploy.ts` (modify) | the FLUX 3 endpoint, HF token secret, bigger volume |
| `src/media/reference-image.ts` (new) | shrink a reference for transport |
| `src/providers/types.ts`, `runpod-providers.ts` (modify) | `referenceImagePaths` |
| `src/stages/references.ts` (new) | `referencesFor`, `reframes`, anchor/previous keyframe |
| `src/stages/keyframes.ts`, `reference.ts` (modify) | wiring, per-scene deps, cache keys |
| `src/manifest/schema.ts` (modify) | `request.cutReferences`, `SceneSpec.reframe` |
| `src/formats.ts` (modify) | `reframe` per type |
| `src/providers/gemini.ts`, `prompt-version.ts` (modify) | reframe rule, upsampler, extended check |
| `src/stages/script.ts` (modify) | allow/normalise `reframe` |
| `src/stages/upsample.ts` (new) | the upsampler call with its charge |
| `src/stages/inspect.ts` (modify) | references and content check |
| `src/eval/look.ts` (new), `scripts/eval-cuts.ts` (new) | look measure and the comparison |

---

### Task 1: Gate — the model's real interface, written into the spec

This task answers what the plan cannot guess. If it cannot, it stops the plan.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-18-phase10-flux3-reframe-design.md` (add §3.1 and §12)

**Interfaces:** Produces spec §3.1 with: the `diffusers` version that has `ModularPipeline`; the model card's usage snippet verbatim; the kwargs that switch the pipeline's own prompt upsampler off; the pinned `REVISION`, the files to download with sizes and SHA-256, and the chosen precision; and BFL's upsampler instructions (or "not public"). Produces §12 (deviations of this plan from the spec).

- [ ] **Step 1: Check which `diffusers` release has `ModularPipeline`**

```bash
python3 -m venv /tmp/f3venv
/tmp/f3venv/bin/pip install -q --no-deps "diffusers==0.41.0"
grep -rl "class ModularPipeline" /tmp/f3venv/lib/python3*/site-packages/diffusers | head -3
mkdir -p /tmp/f3dl && /tmp/f3venv/bin/pip download -q --no-deps --dest /tmp/f3dl diffusers
cd /tmp/f3dl && for w in *.whl; do unzip -q -o "$w" -d new; done; grep -rl "class ModularPipeline" new/diffusers | head -3; ls *.whl
```
Expected: the first `grep` prints a path or nothing; the second tells whether the newest release has it. Record both versions. If neither has it, go to Step 6 (BLOCKED).

- [ ] **Step 2: Read the model card's usage verbatim**

Use WebFetch on `https://huggingface.co/black-forest-labs/flux-3-image-klein` and on the GitHub repository it links for `scripts/cli.py`. Copy verbatim: the loading snippet, the generation call (argument names for prompt, size, steps, seed/generator, reference images), and how the prompt upsampler is enabled or disabled. Do not paraphrase code.

- [ ] **Step 3: Read the revision, files and hashes from the Hub's API**

WebFetch `https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein?blobs=true`. Record the `sha` (the revision to pin) and, for each file the pipeline needs, `size` and `lfs.sha256`. If the API answers 401 or hides the file list because the repository is gated, write that in §3.1 and stop at Step 6 with status NEEDS_CONTEXT: the owner supplies a token-authenticated listing (`huggingface-cli` output).

- [ ] **Step 4: Record the precision decision**

From the card: the smallest precision that fits a 32 GB card (BF16 31 GB peak, FP8 26 GB, NVFP4 25 GB at 1024²). Write which one the worker loads and the card's own words about hardware support for it. If the card does not say whether FP8/NVFP4 run on non-Blackwell cards, choose BF16 and say a 48 GB card is then needed.

- [ ] **Step 5: Find the upsampler's instructions**

WebFetch `https://huggingface.co/black-forest-labs/flux-3-image-klein-pup`. Copy verbatim any system prompt or template it documents. If it documents none, write "not public" in §3.1 and state the fallback (spec §3: host the 9B upsampler) as the amended plan for Task 8.

- [ ] **Step 6: Write §3.1 and §12 into the spec**

Add after §3:

```markdown
### 3.1 What the model pages say (read on <date> by task 1)

| | |
|---|---|
| `diffusers` with `ModularPipeline` | <version(s) found, or "none: BLOCKED"> |
| Load and call | <verbatim snippet> |
| Switching the built-in upsampler off | <kwargs, verbatim> |
| Revision to pin | <sha> |
| Files, sizes, SHA-256 | <table> |
| Precision the worker loads | <which, and why> |
| Upsampler instructions | <verbatim, or "not public"> |
```
and at the end of the spec:

```markdown
## 12. What the plan found and changed (a later section wins)

- `reframe` is optional in Gemini's answer too (not required): an answer without it means false, so no fake script has to change.
- A scene's reframe is normalised in code after the answer (false on scene 1, on a `continue` scene, on the first scene of a part, and everywhere when the run may not reframe), never sent back for a paid retry.
- `FLOWCHAIN_CUT_REFERENCES` is `on` or `off`, **default off**; the run freezes it as `request.cutReferences`. The owner sets it to `on` after `eval:cuts` shows a gain.
- `FLOWCHAIN_IMAGE_MODEL=klein4b` forces the 4B profile (the fallback lever); `flux3` insists on the new one and refuses to start a run if it is not ready.
- The Hugging Face token reaches the worker as a RunPod secret (`flowchain_hf_token`) the deploy script creates from the owner's shell `HF_TOKEN`; the volume grows to 80 GB when the FLUX 3 endpoint is configured.
- `eval:cuts` takes two finished runs (made with references on and off) and is free: it reads files and calls ffmpeg.
```
Fill every `<…>` with the real values from Steps 1 to 5; no placeholder may remain.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-18-phase10-flux3-reframe-design.md
git commit -m "docs: the FLUX 3 klein pipeline, revision, files and upsampler are written down from the model pages, and the plan's changes to the spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
If `ModularPipeline` was found in no release, commit what you have, do not continue, and report BLOCKED with the finding.

---

### Task 2: The profile, its configuration, its selection, and the names

**Files:**
- Modify: `src/config.ts` (Env, Prices, `flux3Rates`)
- Modify: `src/image-profiles.ts`
- Modify: `src/providers/model-id.ts`, `src/providers/new-run.ts`, `src/cli.ts:266`
- Modify: `src/stages/reference.ts:67`
- Modify: `web/lib/engines.ts` (`INTERNAL_NAMES`)
- Test: `test/unit/flux3-profile.test.ts`, `web/test/flux3-names.test.ts`

**Interfaces:**
- Produces: `flux3Rates(p: Prices): { usdPerSec: number; pictureSec: number; portraitSec: number; coldStartSec: number } | null`; `ImageProfileId` gains `"runpod-flux3-klein@1"`; `takesSeveralReferences(id: ImageProfileId | undefined): boolean`; `RUNPOD_WORKFLOWS.keyframe3`; `newRunProviders(env, clips?, prices?)`; Env: `RUNPOD_PICTURE3_ENDPOINT?: string`, `FLOWCHAIN_IMAGE_MODEL?: "flux3" | "klein4b"`, `FLOWCHAIN_CUT_REFERENCES: "on" | "off"` (default `"off"`).

- [ ] **Step 1: Write the failing tests**

`test/unit/flux3-profile.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Prices, flux3Rates, loadEnv } from "../../src/config.js";
import { IMAGE_PROFILES, imageProfileOf, takesReference, takesSeveralReferences } from "../../src/image-profiles.js";
import { newRunProviders } from "../../src/providers/new-run.js";

const rates = { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 };
const base = { GEMINI_API_KEY: "k", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "kf1", RUNPOD_CLIP_ENDPOINT: "cl1" };

describe("the FLUX 3 picture profile", () => {
  it("cannot be priced until all four rates are in the price table", () => {
    expect(flux3Rates(Prices.parse({}))).toBeNull();
    expect(flux3Rates(Prices.parse({ ...rates, runpodPicture3Sec: undefined }))).toBeNull();
    expect(flux3Rates(Prices.parse(rates))).toEqual({ usdPerSec: 0.0006, pictureSec: 24, portraitSec: 12, coldStartSec: 90 });
    expect(() => IMAGE_PROFILES["runpod-flux3-klein@1"].keyframeUsd(Prices.parse({}), { width: 1088, height: 1920 })).toThrow(/rates are not set/);
  });

  it("prices a picture, a portrait and a start from the measured seconds", () => {
    const p = Prices.parse(rates);
    const profile = imageProfileOf("runpod-flux3-klein@1");
    expect(profile.keyframeUsd(p, { width: 1088, height: 1920 })).toBeCloseTo(24 * 0.0006, 4);
    expect(profile.referenceUsd(p, { width: 1024, height: 1024 })).toBeCloseTo(12 * 0.0006, 4);
    expect(profile.runOverheadUsd(p)).toBeCloseTo(90 * 0.0006, 4);
  });

  it("takes a portrait like the 4B, and several references only itself", () => {
    expect(takesReference("runpod-flux3-klein@1")).toBe(true);
    expect(takesSeveralReferences("runpod-flux3-klein@1")).toBe(true);
    expect(takesSeveralReferences("runpod-klein@1")).toBe(false);
    expect(takesSeveralReferences(undefined)).toBe(false);
  });
});

describe("the picture model a new run is made with", () => {
  const ready = loadEnv({ ...base, RUNPOD_PICTURE3_ENDPOINT: "f3x" });
  const p = Prices.parse(rates);

  it("is the 4B klein while the new one is not set up", () => {
    expect(newRunProviders(loadEnv(base), "480p", p).imageProfile).toBe("runpod-klein@1");
    expect(newRunProviders(ready, "480p", Prices.parse({})).imageProfile).toBe("runpod-klein@1");
    expect(newRunProviders(ready, "480p").imageProfile).toBe("runpod-klein@1");
  });

  it("is FLUX 3 klein when its endpoint and rates are both set, on that endpoint", () => {
    const chosen = newRunProviders(ready, "480p", p);
    expect(chosen.imageProfile).toBe("runpod-flux3-klein@1");
    expect(chosen.image).toBe("runpod:f3x/keyframe-flux3-klein@1");
  });

  it("is the 4B again when the owner says so, whatever else is set", () => {
    const forced = loadEnv({ ...base, RUNPOD_PICTURE3_ENDPOINT: "f3x", FLOWCHAIN_IMAGE_MODEL: "klein4b" });
    expect(newRunProviders(forced, "480p", p).imageProfile).toBe("runpod-klein@1");
  });

  it("refuses to start a run when the owner insists on FLUX 3 and it is not ready", () => {
    const insist = loadEnv({ ...base, FLOWCHAIN_IMAGE_MODEL: "flux3" });
    expect(() => newRunProviders(insist, "480p", p)).toThrow(/FLOWCHAIN_IMAGE_MODEL=flux3/);
  });

  it("does not need the 4B endpoint when it makes the pictures on FLUX 3", () => {
    const { RUNPOD_KEYFRAME_ENDPOINT: _gone, ...without } = base;
    expect(newRunProviders(loadEnv({ ...without, RUNPOD_PICTURE3_ENDPOINT: "f3x" }), "480p", p).imageProfile).toBe("runpod-flux3-klein@1");
  });
});

describe("the cut references setting", () => {
  it("is off unless the owner turns it on", () => {
    expect(loadEnv(base).FLOWCHAIN_CUT_REFERENCES).toBe("off");
    expect(loadEnv({ ...base, FLOWCHAIN_CUT_REFERENCES: "on" }).FLOWCHAIN_CUT_REFERENCES).toBe("on");
  });
});
```

`web/test/flux3-names.test.ts` (the web tests import the site's code as `@/…`):
```ts
import { describe, expect, it } from "vitest";
import { namesInternals } from "@/lib/engines";

describe("what customers are never shown", () => {
  it("includes the new picture model's names", () => {
    for (const text of ["FLUX 3 klein", "klein 4B", "Qwen3-VL", "RUNPOD_PICTURE3_ENDPOINT"]) expect(namesInternals(text), text).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/unit/flux3-profile.test.ts web/test/flux3-names.test.ts`
Expected: FAIL (`flux3Rates` not exported, profile id unknown, "klein" not yet a name).

- [ ] **Step 3: Implement**

`src/config.ts`: in `Env` add after `RUNPOD_UPSCALE_ENDPOINT`:
```ts
  /** The FLUX 3 klein picture worker (phase 10 spec §3): new runs use it only while this and its prices are set. */
  RUNPOD_PICTURE3_ENDPOINT: z.string().min(1).optional(),
  /** `klein4b` forces the 4B picture worker (the fallback); `flux3` insists on the new one and refuses to start a run without it. */
  FLOWCHAIN_IMAGE_MODEL: z.enum(["flux3", "klein4b"]).optional(),
  /** Reframe cuts and the shared look reference (phase 10 spec §5): off until the owner's comparison says on. Frozen per run. */
  FLOWCHAIN_CUT_REFERENCES: z.enum(["on", "off"]).default("off"),
```
In `Prices` (after `runpodUpscaleColdStartSec`):
```ts
  // FLUX 3 klein (phase 10 spec §3): no default on purpose. The profile is not offered until the owner has measured
  // these on the real endpoint and set all four, so a customer is never charged from a guess.
  runpodPicture3UsdPerSec: z.number().positive().optional(),
  runpodPicture3Sec: z.number().positive().optional(),
  runpodPortrait3Sec: z.number().positive().optional(),
  runpodPicture3ColdStartSec: z.number().positive().optional(),
```
After `runpodRates`:
```ts
export type Flux3Rates = { usdPerSec: number; pictureSec: number; portraitSec: number; coldStartSec: number };

/** The FLUX 3 picture worker's rates, or null while any of the four is not set. */
export function flux3Rates(p: Prices): Flux3Rates | null {
  const { runpodPicture3UsdPerSec: usdPerSec, runpodPicture3Sec: pictureSec, runpodPortrait3Sec: portraitSec, runpodPicture3ColdStartSec: coldStartSec } = p;
  return usdPerSec === undefined || pictureSec === undefined || portraitSec === undefined || coldStartSec === undefined ? null : { usdPerSec, pictureSec, portraitSec, coldStartSec };
}
```
`src/image-profiles.ts`: add `"runpod-flux3-klein@1"` to the enum; import `flux3Rates`; add before the closing of `IMAGE_PROFILES`:
```ts
  /** FLUX 3 klein (phase 10 spec §3): priced by measured GPU seconds; it cannot be priced, so cannot be chosen, until the owner has set them. */
  "runpod-flux3-klein@1": {
    id: "runpod-flux3-klein@1",
    keyframeUsd: (p) => round4(rates3(p).pictureSec * rates3(p).usdPerSec),
    referenceUsd: (p) => round4(rates3(p).portraitSec * rates3(p).usdPerSec),
    runOverheadUsd: (p) => round4(rates3(p).coldStartSec * rates3(p).usdPerSec),
  },
```
with, above `IMAGE_PROFILES`:
```ts
function rates3(p: Prices) {
  const r = flux3Rates(p);
  if (!r) throw new Error("the FLUX 3 picture rates are not set in prices.json (runpodPicture3UsdPerSec, runpodPicture3Sec, runpodPortrait3Sec, runpodPicture3ColdStartSec)");
  return r;
}
```
`takesReference` becomes:
```ts
export const takesReference = (id: ImageProfileId | undefined): boolean => id === "runpod-sdxl@1" || id === "runpod-klein@1" || id === "runpod-flux3-klein@1";

/** Whether a profile's worker takes several reference images: only then are a look anchor and a reframe's picture sent (phase 10 spec §5). */
export const takesSeveralReferences = (id: ImageProfileId | undefined): boolean => id === "runpod-flux3-klein@1";
```
`src/providers/model-id.ts`, in `RUNPOD_WORKFLOWS` after `keyframe`:
```ts
  /** FLUX 3 klein (phase 10 spec §3): on its own endpoint, beside the 4B above. */
  keyframe3: { workflow: "keyframe-flux3-klein", version: 1 },
```
`src/providers/new-run.ts`: import `flux3Rates`; replace `newRunProviders` body's head:
```ts
export function newRunProviders(env: Env, clips: ClipQuality = "480p", prices?: Prices): NewRunProviders {
  const ready = Boolean(env.RUNPOD_PICTURE3_ENDPOINT) && prices !== undefined && flux3Rates(prices) !== null;
  if (env.FLOWCHAIN_IMAGE_MODEL === "flux3" && !ready) {
    throw new Error("FLOWCHAIN_IMAGE_MODEL=flux3 but FLUX 3 is not set up: set RUNPOD_PICTURE3_ENDPOINT and the four runpodPicture3* prices in prices.json");
  }
  const flux3 = ready && env.FLOWCHAIN_IMAGE_MODEL !== "klein4b";
  const needed = flux3 ? (["RUNPOD_CLIP_ENDPOINT"] as const) : (["RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT"] as const);
  const missing = needed.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(" and ")} not set; run npm run runpod:deploy first`);
  const { keyframe, keyframe3, clip } = RUNPOD_WORKFLOWS;
  return {
    image: flux3 ? runpodModelId(env.RUNPOD_PICTURE3_ENDPOINT!, keyframe3.workflow, keyframe3.version) : runpodModelId(env.RUNPOD_KEYFRAME_ENDPOINT!, keyframe.workflow, keyframe.version),
    video: runpodModelId(env.RUNPOD_CLIP_ENDPOINT!, clip.workflow, clip.version),
    imageProfile: flux3 ? "runpod-flux3-klein@1" : "runpod-klein@1",
    videoProfile: CLIP_QUALITIES[clips],
  };
}
```
(import `flux3Rates` from `../config.js` with the existing `Env, Prices, runpodRates` import.) `src/cli.ts:266`: `newRunProviders(env, o.clips, loadPrices())`.
`src/stages/reference.ts:67`: change `m.request.imageProfile === "runpod-klein@1"` to `m.request.imageProfile === "runpod-klein@1" || m.request.imageProfile === "runpod-flux3-klein@1"`.
`web/lib/engines.ts`: add `/klein/i, /qwen/i` to `INTERNAL_NAMES` (after `/\bflux\b/i,`).

- [ ] **Step 4: Run to see them pass; check nothing else moved**

Run: `npx vitest run test/unit/flux3-profile.test.ts test/unit/compat.test.ts web/test/flux3-names.test.ts web/test/names.test.ts && npm run typecheck`
Expected: PASS. `names.test.ts` scans pages and published files for the new names; if it finds "klein" or "qwen" in a page or published file, that file is a real finding: report it, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src web/lib web/test/flux3-names.test.ts test/unit/flux3-profile.test.ts
git commit -m "feat: FLUX 3 klein is a picture profile that is offered only when its endpoint and its measured prices are set, with the 4B kept as the fallback an owner can force

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The worker's FLUX 3 engine, its contract, and its weights

Uses the constants Task 1 wrote in spec §3.1. Python; tests run with the pipeline stubbed (no GPU, no download).

**Files:**
- Modify: `worker-picture/src/flowchain_picture/contract.py`, `handler.py`, `worker-picture/Dockerfile`, `worker-picture/requirements.txt`
- Create: `worker-picture/src/flowchain_picture/engine_flux3.py`, `weights_flux3.py`
- Test: `worker-picture/tests/test_flux3.py`

**Interfaces:**
- Produces: `contract.WORKFLOW_FLUX3 = "keyframe-flux3-klein@1"`, `contract.MAX_REFERENCES = 4`, `contract.ENGINES: dict[str, str]`; `validate()` returns for FLUX 3 a dict that has `"references": list[bytes]`; `engine_flux3.picture(model_dir, prompt, width, height, seed, reference_paths, out_path)`; `weights_flux3.present/verify/fetch` with the same shape as `weights`.

- [ ] **Step 1: Write the failing tests**

`worker-picture/tests/test_flux3.py`:
```python
import base64
import os

import pytest

from flowchain_picture import contract, engine_flux3, weights_flux3

PNG = base64.b64encode(b"png-bytes").decode()
GOOD = {"task": "keyframe", "workflow": "keyframe-flux3-klein@1", "prompt": "a lighthouse at dusk", "width": 1088, "height": 1920, "seed": 7}


def test_takes_a_list_of_references_for_the_new_workflow():
    assert contract.validate(GOOD) == {"task": "keyframe", "prompt": "a lighthouse at dusk", "width": 1088, "height": 1920, "seed": 7}
    got = contract.validate({**GOOD, "references": [PNG, PNG]})
    assert got["references"] == [b"png-bytes", b"png-bytes"]


@pytest.mark.parametrize(
    "change, why",
    [
        ({"reference": PNG}, "unknown field"),
        ({"references": "not a list"}, "references must be a list"),
        ({"references": [PNG] * (contract.MAX_REFERENCES + 1)}, "at most"),
        ({"references": ["not base64!"]}, "not valid base64"),
        ({"references": [""]}, "between 1 byte"),
    ],
)
def test_refuses_what_is_not_the_new_contract(change, why):
    with pytest.raises(contract.ContractError, match=why):
        contract.validate({**GOOD, **change})


def test_the_old_workflow_still_refuses_a_list_and_each_workflow_names_its_engine():
    old = {**GOOD, "workflow": "keyframe-klein@1"}
    with pytest.raises(contract.ContractError, match="unknown field"):
        contract.validate({**old, "references": [PNG]})
    assert contract.ENGINES == {"keyframe-klein@1": "klein", "keyframe-flux3-klein@1": "flux3"}


class FakePipe:
    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        from PIL import Image

        class Out:
            images = [Image.new("RGB", (kwargs["width"], kwargs["height"]), "red")]

        return Out()


def test_makes_a_picture_in_sixteen_steps_with_every_reference_in_order(tmp_path, monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(engine_flux3, "load", lambda model_dir: pipe)
    from PIL import Image

    refs = []
    for name, color in (("a.png", "blue"), ("b.png", "green")):
        path = tmp_path / name
        Image.new("RGB", (64, 64), color).save(path)
        refs.append(str(path))
    out = tmp_path / "out.png"
    engine_flux3.picture("/models/x", "a lighthouse", 256, 256, 5, refs, str(out))
    call = pipe.calls[0]
    assert call["prompt"] == "a lighthouse"
    assert call["num_inference_steps"] == 16
    assert [im.getpixel((0, 0)) for im in call["image"]] == [(0, 0, 255), (0, 128, 0)]
    assert "guidance_scale" not in call
    assert os.path.getsize(out) > 0


def test_asks_for_no_reference_images_when_there_are_none(tmp_path, monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(engine_flux3, "load", lambda model_dir: pipe)
    engine_flux3.picture("/models/x", "a lighthouse", 256, 256, 5, [], str(tmp_path / "o.png"))
    assert "image" not in pipe.calls[0]


def fake_sha(path):
    """The recorded prefix of the file's SHA-256: what a correct download would hash to."""
    return next(h for name, (_, h) in weights_flux3.BIG.items() if path.endswith(name))


def _sparse_files(target):
    for name, (size, _) in weights_flux3.BIG.items():
        path = os.path.join(target, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)  # the size without the bytes


def test_the_weights_are_present_only_when_every_file_has_its_size_and_the_marker_names_the_revision(tmp_path):
    root = str(tmp_path)
    assert not weights_flux3.present(root)
    _sparse_files(weights_flux3.folder(root))
    assert not weights_flux3.present(root)  # no marker yet: nothing has been checked
    weights_flux3.verify(root, sha256=fake_sha)
    assert weights_flux3.present(root)


def test_a_file_with_the_wrong_hash_is_refused(tmp_path):
    root = str(tmp_path)
    _sparse_files(weights_flux3.folder(root))
    with pytest.raises(ValueError, match="SHA-256 differs"):
        weights_flux3.verify(root, sha256=lambda path: "0000000000000000")


def test_fetch_downloads_when_missing_and_is_a_no_op_once_present(tmp_path):
    root = str(tmp_path)
    seen = []

    def download(target):
        seen.append(target)
        _sparse_files(target)

    first = weights_flux3.fetch(root, download=download, sha256=fake_sha)
    assert first["downloaded"] and len(seen) == 1
    again = weights_flux3.fetch(root, download=download, sha256=fake_sha)
    assert again["downloaded"] == [] and len(seen) == 1
```
(`verify` compares `sha256(path).startswith(start)`; `fake_sha` returns each file's recorded prefix, so a correct download verifies. If a recorded hash in `BIG` is not a plain prefix string, adapt `fake_sha`, not the production code.)

- [ ] **Step 2: Run to see them fail**

Run: `workers/.venv/bin/python -m pytest -q worker-picture/tests/test_flux3.py`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the contract**

`contract.py`: add after `WORKFLOW`:
```python
WORKFLOW_FLUX3 = "keyframe-flux3-klein@1"
# which engine answers which workflow: one image, two engines, each endpoint is sent only one workflow (phase 10 spec §3)
ENGINES = {WORKFLOW: "klein", WORKFLOW_FLUX3: "flux3"}
# the client sends at most three (portrait, look anchor, previous picture); one more is room, not a promise
MAX_REFERENCES = 4
```
Factor the image check out of `validate` and use it for both fields:
```python
def _image(value, name):
    if not isinstance(value, str):
        raise ContractError(f"{name} must be a base64 string")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ContractError(f"{name} is not valid base64") from err
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ContractError(f"{name} must be between 1 byte and 9 MB")
    return data
```
In `validate`, replace the workflow check and the field/reference handling:
```python
    workflow = inp.get("workflow")
    if workflow not in ENGINES:
        raise ContractError(f"this worker runs workflow {WORKFLOW} or {WORKFLOW_FLUX3} for task keyframe")
    flux3 = ENGINES[workflow] == "flux3"
    allowed = {"task", "workflow", "prompt", "width", "height", "seed", "preset", "references" if flux3 else "reference"}
    unknown = sorted(set(inp) - allowed)
    ...(prompt, width, height, seed, preset checks unchanged)...
    if flux3 and inp.get("references") is not None:
        refs = inp["references"]
        if not isinstance(refs, list):
            raise ContractError("references must be a list of base64 strings")
        if len(refs) > MAX_REFERENCES:
            raise ContractError(f"references must be at most {MAX_REFERENCES} images")
        req["references"] = [_image(r, "references") for r in refs]
    if not flux3 and inp.get("reference") is not None:
        req["reference"] = _image(inp["reference"], "reference")
```
(Keep every existing message the old tests match: "reference must be a base64 string", "reference is not valid base64", "reference must be between 1 byte and 9 MB" are produced by `_image` with `name="reference"`.)

- [ ] **Step 4: Implement the engine and the weights**

`engine_flux3.py`:
```python
"""The FLUX 3 klein picture model, loaded once per worker (phase 10 spec §3). Nothing here writes a prompt or a file name to a log (phase 5 spec §8)."""

_pipe = None
# the distilled model's own setting (spec §2): sixteen steps, and no guidance argument at all
STEPS = 16
# the arguments, from spec §3.1, that keep the pipeline's own prompt upsampler off: the client sends a prompt that
# Gemini has already upsampled, and a second upsampling would rewrite it again
NO_UPSAMPLER = {}


def load(model_dir):
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import ModularPipeline

        # loaded exactly as spec §3.1 shows
        _pipe = ModularPipeline.from_pretrained(model_dir, torch_dtype=torch.bfloat16, local_files_only=True).to("cuda")
    return _pipe


def picture(model_dir, prompt, width, height, seed, reference_paths, out_path):
    """Makes one picture and saves it as PNG. Each reference picture is passed, in order, as an image the model may draw on."""
    import torch
    from PIL import Image

    pipe = load(model_dir)
    extra = {}
    if reference_paths:
        extra["image"] = [Image.open(p).convert("RGB") for p in reference_paths]
    image = pipe(
        prompt=prompt, width=width, height=height, num_inference_steps=STEPS,
        generator=torch.Generator("cuda").manual_seed(seed), **NO_UPSAMPLER, **extra,
    ).images[0]
    image.convert("RGB").save(out_path, format="PNG")
```
Set `NO_UPSAMPLER` and the load line to exactly what spec §3.1 records (if §3.1 gives a different call shape, follow §3.1 and keep the test's assertions on what our code passes: prompt, steps, images in order, no `guidance_scale`).

`weights_flux3.py`: copy `weights.py`'s structure (`folder`, `present`, `_sha256`, `verify`, `fetch`, `MARKER`) and set the constants from spec §3.1:
```python
REPO = "black-forest-labs/flux-3-image-klein"
REVISION = "<the sha from spec §3.1>"
FOLDER = "flux3-klein"
PATTERNS = [<the file patterns from spec §3.1>]
BIG = {<each file the pipeline needs>: (<size>, "<first 16 hex of its SHA-256>"), ...}
```
and make `fetch`'s default download pass the token: `snapshot_download(REPO, revision=REVISION, allow_patterns=PATTERNS, local_dir=target, token=os.environ.get("HF_TOKEN"))`. Every value comes from §3.1; none is invented.

- [ ] **Step 5: Wire the handler by workflow**

`handler.py`: import `engine_flux3, weights_flux3`. Replace the body from `if req["task"] == "fetch-models"` on:
```python
    inp = job.get("input") or {}
    if req["task"] == "fetch-models":
        return (weights_flux3 if inp.get("only") == "keyframe3" else weights).fetch(VOLUME_MODELS)

    flux3 = contract.ENGINES[inp["workflow"]] == "flux3"
    wmod = weights_flux3 if flux3 else weights
    missing = storage.missing_env()
    if missing:
        return {"error": f"R2 is not set up on this worker; missing: {', '.join(missing)}"}
    if not wmod.present(VOLUME_MODELS):
        return {"error": "the picture model is not on the volume yet (run the fetch-models task: npm run runpod:deploy)"}

    job_id = job["id"]
    seed = req.get("seed", random.randrange(contract.MAX_SEED + 1))
    out = os.path.join(TMP_DIR, f"{job_id}.png")
    refs = []
    try:
        if flux3:
            for k, data in enumerate(req.get("references", [])):
                path = os.path.join(TMP_DIR, f"{job_id}-reference-{k}.png")
                with open(path, "wb") as f:
                    f.write(data)
                refs.append(path)
            engine_flux3.picture(wmod.folder(VOLUME_MODELS), req["prompt"], req["width"], req["height"], seed, refs, out)
        else:
            ref = None
            if "reference" in req:
                ref = os.path.join(TMP_DIR, f"{job_id}-reference.png")
                with open(ref, "wb") as f:
                    f.write(req["reference"])
                refs.append(ref)
            engine.picture(wmod.folder(VOLUME_MODELS), req["prompt"], req["width"], req["height"], seed, ref, out)
        url = storage.upload(out, f"flowchain/{job_id}.png", "image/png")
    finally:
        _remove(out)
        for path in refs:
            _remove(path)
    return {"url": url, "seed": seed, "executionMs": int((time.monotonic() - started) * 1000)}
```
`Dockerfile`: change the build-time check to `RUN python -c "import runpod, boto3; from diffusers import Flux2KleinPipeline, ModularPipeline"` and its comment; `requirements.txt`: set `diffusers==<the version from spec §3.1>` (if §3.1 says 0.41.0 already has `ModularPipeline`, leave it). If the pin moves, run the whole `test:worker` suite: the 4B engine's tests must still pass.

- [ ] **Step 6: Run to see them pass**

Run: `npm run test:worker` (or `workers/.venv/bin/python -m pytest -q worker-picture/tests`)
Expected: PASS, including the old `test_picture.py` unchanged.

- [ ] **Step 7: Commit**

```bash
git add worker-picture
git commit -m "feat: the picture worker has a FLUX 3 klein engine that takes a list of reference pictures, chosen by the request's workflow beside the unchanged 4B engine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Deploying the FLUX 3 endpoint (the plan only; the owner runs it)

**Files:**
- Modify: `src/deploy/runpod.ts`, `scripts/runpod-deploy.ts`
- Test: `test/unit/runpod-deploy.test.ts` (extend)

**Interfaces:**
- Produces: `NAMES.keyframe3`; `SECRET_NAMES.hfToken`; `DeployConfig.keyframe3Gpus?: string[]`, `hfToken?: string`; `DEFAULTS.volumeGbWithFlux3 = 80`; `Deployed.keyframe3EndpointId?`; `planDeploy(rest, { upscale?, picture3? })`; `fetchModels(..., only: "keyframe" | "clip" | "keyframe3")`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/runpod-deploy.test.ts` (inside the same file, after the existing `describe`, reusing `fakeRest` and `cfg`):
```ts
describe("runpod deploy of the FLUX 3 picture endpoint (phase 10 spec §3)", () => {
  const withFlux3 = { ...cfg, keyframe3Gpus: ["NVIDIA RTX 6000 Ada Generation"], hfToken: "hf_secret_value" };

  it("makes no FLUX 3 endpoint unless its cards are named, and plans none", async () => {
    const { rest, store } = fakeRest();
    expect((await applyDeploy(rest, cfg, () => {})).keyframe3EndpointId).toBeUndefined();
    expect(store.endpoints.map((e) => e.name)).not.toContain(NAMES.keyframe3);
    expect((await planDeploy(rest)).map((s) => s.name)).not.toContain(NAMES.keyframe3);
  });

  it("makes its endpoint on the picture worker's image and template, on the cards named, with the longer limit", async () => {
    const { rest, store } = fakeRest();
    expect((await planDeploy(rest, { picture3: true })).map((s) => s.name)).toContain(NAMES.keyframe3);
    const deployed = await applyDeploy(rest, withFlux3, () => {});
    const pictureTemplate = store.templates.find((t) => t.name === NAMES.pictureTemplate)!;
    const e = store.endpoints.find((x) => x.name === NAMES.keyframe3)!;
    expect(deployed.keyframe3EndpointId).toBe(e.id);
    expect(e).toMatchObject({ templateId: pictureTemplate.id, gpuTypeIds: ["NVIDIA RTX 6000 Ada Generation"], executionTimeoutMs: 300_000, workersMax: 1, flashboot: false, minCudaVersion: "12.8" });
    expect(e.networkVolumeId).toBe(deployed.volumeId);
  });

  it("gives the picture worker the Hugging Face token as a secret, never in plain text", async () => {
    const { rest, store, secrets } = fakeRest();
    await applyDeploy(rest, withFlux3, () => {});
    expect(secrets.has("flowchain_hf_token")).toBe(true);
    const pictureTemplate = store.templates.find((t) => t.name === NAMES.pictureTemplate)!;
    expect(pictureTemplate.env).toMatchObject({ HF_TOKEN: "{{ RUNPOD_SECRET_flowchain_hf_token }}" });
    expect(JSON.stringify(store)).not.toContain("hf_secret_value");
    // the clip worker's template does not get it
    expect(store.templates.find((t) => t.name === NAMES.template)!.env).not.toHaveProperty("HF_TOKEN");
  });

  it("asks the worker for the FLUX 3 weights by name", async () => {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { downloaded: ["w"], skipped: [] } }]);
    await fetchModels(new RunpodClient("k", { fetch: api.fetch }), "ep-f", "keyframe3", { pollMs: 1, sleep: async () => {} });
    expect(api.runs[0].input).toEqual({ task: "fetch-models", only: "keyframe3" });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/unit/runpod-deploy.test.ts`
Expected: FAIL (`NAMES.keyframe3` undefined, config field unknown).

- [ ] **Step 3: Implement**

`src/deploy/runpod.ts`:
- `NAMES`: add `keyframe3: "flowchain-keyframe-flux3",`.
- `SECRET_NAMES`: add `hfToken: "flowchain_hf_token"`.
- `DeployConfig`: add
```ts
  /** The FLUX 3 picture endpoint's cards (phase 10 spec §3): absent = no such endpoint is made or changed. The owner names them. */
  keyframe3Gpus?: string[];
  /** Hugging Face token for the gated FLUX 3 weights: stored as a RunPod secret, given only to the picture worker. */
  hfToken?: string;
```
- `DEFAULTS`: add `volumeGbWithFlux3: 80,` with the comment `// 47 GB as above, plus the FLUX 3 weights and text encoder (about 20 GB): grown first, never shrunk`.
- `Existing` type and `lookupExisting`: add `keyframe3?: Resource` and `keyframe3: findByName(endpoints, "endpoints", NAMES.keyframe3)`.
- `planDeploy(rest, opts: { upscale?: boolean; picture3?: boolean } = {})`: after the clip step add `...(opts.picture3 ? [step("endpoint", found.keyframe3, NAMES.keyframe3)] : []),`.
- `Deployed`: add `keyframe3EndpointId?: string`.
- `applyDeploy`: after the R2 secrets loop:
```ts
  if (cfg.hfToken && !(await rest.createSecret(SECRET_NAMES.hfToken, cfg.hfToken))) log(`secret ${SECRET_NAMES.hfToken} already exists (kept; delete it on RunPod to change it)`);
```
change `pictureBody` to carry the token for the picture template only:
```ts
  const pictureEnv = cfg.hfToken ? { ...env, HF_TOKEN: `{{ RUNPOD_SECRET_${SECRET_NAMES.hfToken} }}` } : env;
  const pictureBody = { imageName: cfg.pictureImage, containerDiskInGb: 20, env: pictureEnv };
```
after `clipEndpoint`:
```ts
  let keyframe3EndpointId: string | undefined;
  if (cfg.keyframe3Gpus?.length) {
    // sixteen steps on a bigger card: a job may take several times the 4B's, so the limit is longer
    const flux3 = endpoint(pictureTemplate.id, cfg.keyframe3Gpus, 300_000, { minCudaVersion: "12.8" });
    keyframe3EndpointId = (await upsert(rest, "endpoints", existing.keyframe3, NAMES.keyframe3, flux3, flux3)).id;
  }
```
include `existing.keyframe3` in the `movedVolume` array and `...(keyframe3EndpointId ? { keyframe3EndpointId } : {})` in the return. `fetchModels`: change `only: "keyframe" | "clip"` to `only: "keyframe" | "clip" | "keyframe3"`.
`scripts/runpod-deploy.ts`: in `cfg`: 
```ts
    ...(process.env.RUNPOD_PICTURE3_GPUS ? { keyframe3Gpus: process.env.RUNPOD_PICTURE3_GPUS.split(",").map((s) => s.trim()).filter(Boolean), hfToken: need("HF_TOKEN") } : {}),
```
and `volumeGb: process.env.RUNPOD_PICTURE3_GPUS ? DEFAULTS.volumeGbWithFlux3 : DEFAULTS.volumeGb,`; `planDeploy(rest, { upscale: Boolean(cfg.upscaleImage), picture3: Boolean(cfg.keyframe3Gpus) })`; write `RUNPOD_PICTURE3_ENDPOINT: deployed.keyframe3EndpointId` when present; extend `fetchAll` to take `deployed` with an optional `keyframe3EndpointId` and loop `[["keyframe", id], ["clip", id], ...(keyframe3EndpointId ? [["keyframe3", keyframe3EndpointId]] : [])] as const`. The `need("HF_TOKEN")` message names the variable only, never its value.

- [ ] **Step 4: Run to see them pass; commit**

Run: `npx vitest run test/unit/runpod-deploy.test.ts && npm run typecheck`
Expected: PASS; the existing deploy tests unchanged (the new config fields are optional).
```bash
git add src/deploy scripts/runpod-deploy.ts test/unit/runpod-deploy.test.ts
git commit -m "feat: the deploy makes the FLUX 3 picture endpoint when the owner names its cards, with the Hugging Face token as a secret only the picture worker gets

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sending several references: shrunk, in the request

**Files:**
- Create: `src/media/reference-image.ts`, `test/media/reference-image.test.ts`
- Modify: `src/providers/types.ts` (`ImageRequest`), `src/providers/runpod-providers.ts` (`RunpodImage.input`)
- Test: `test/unit/runpod-image-references.test.ts`

**Interfaces:**
- Produces: `shrinkReference(path: string, maxSide?: number): Promise<Buffer>` (JPEG, longest side at most `maxSide`, default 1024, never enlarged); `ImageRequest.referenceImagePaths?: string[]`; the request body gains `references: string[]` (base64) when given.

- [ ] **Step 1: Write the failing tests**

`test/media/reference-image.test.ts`:
```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { shrinkReference } from "../../src/media/reference-image.js";
import { makeImage, tempDir } from "../helpers/media.js";

async function sizeOf(bytes: Buffer, dir: string) {
  const file = join(dir, "check.jpg");
  await writeFile(file, bytes);
  const { width, height } = await probeVideo(file);
  return { width, height };
}

describe("a reference picture sent to the picture worker", () => {
  it("is shrunk so its longest side is at most 1024, keeping its shape", async () => {
    const dir = await tempDir();
    const big = join(dir, "big.png");
    await makeImage(big, { width: 2048, height: 1024 });
    expect(await sizeOf(await shrinkReference(big), dir)).toEqual({ width: 1024, height: 512 });
  });

  it("is never made larger", async () => {
    const dir = await tempDir();
    const small = join(dir, "small.png");
    await makeImage(small, { width: 320, height: 640 });
    expect(await sizeOf(await shrinkReference(small), dir)).toEqual({ width: 320, height: 640 });
  });
});
```
`test/unit/runpod-image-references.test.ts` (its `deps` mirrors the one in `test/unit/runpod-providers.test.ts`):
```ts
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
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/media/reference-image.test.ts test/unit/runpod-image-references.test.ts`
Expected: FAIL (module missing; field unknown).

- [ ] **Step 3: Implement**

`src/media/reference-image.ts`:
```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.js";

/**
 * A reference picture as it is sent to the picture worker (phase 10 spec §5): a JPEG whose longest side is at most
 * `maxSide`, never enlarged. Several full-size PNGs in one request body could pass RunPod's limit; a reference
 * is only there to carry a look, so this size loses nothing it is for.
 */
export async function shrinkReference(path: string, maxSide = 1024): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "flowchain-ref-"));
  const out = join(dir, "reference.jpg");
  try {
    await ffmpeg(["-y", "-i", path, "-vf", `scale=w=min(${maxSide}\\,iw):h=min(${maxSide}\\,ih):force_original_aspect_ratio=decrease`, "-q:v", "3", "-frames:v", "1", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```
`src/providers/types.ts`, in `ImageRequest` after `referenceImagePath`:
```ts
  /** Several reference pictures, in order (phase 10 spec §5): portrait, look anchor, previous picture. Only a profile that takes several reads this. */
  referenceImagePaths?: string[];
```
`src/providers/runpod-providers.ts`: import `shrinkReference` and, in `RunpodImage.input`, after the `reference` spread:
```ts
      ...(req.referenceImagePaths === undefined || req.referenceImagePaths.length === 0
        ? {}
        : { references: await Promise.all(req.referenceImagePaths.map(async (p) => (await shrinkReference(p)).toString("base64"))) }),
```

- [ ] **Step 4: Run to see them pass; commit**

Run: `npx vitest run test/media/reference-image.test.ts test/unit/runpod-image-references.test.ts test/unit && npm run typecheck`
Expected: PASS.
```bash
git add src test
git commit -m "feat: a keyframe request can carry several reference pictures, each shrunk to a JPEG of at most 1024 pixels so the request stays small

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: What a keyframe is conditioned on: `referencesFor`, per-scene dependencies, cache keys, the frozen setting

**Files:**
- Create: `src/stages/references.ts`
- Modify: `src/manifest/schema.ts` (`RunRequest.cutReferences`), `src/stages/keyframes.ts`, `src/cli.ts`, `src/studio/draft.ts`
- Test: `test/stages/references.test.ts`

**Interfaces:**
- Consumes: `takesSeveralReferences`, `referenceFor`, `needsKeyframe`, `paths.keyframe`.
- Produces: `RunRequest.cutReferences?: boolean`; `anchorScene(m)`, `previousKeyframeScene(m, scene)`, `reframes(m, scene)`, `referencesFor(m, scene): string[]` (run-relative); `SceneSpec.reframe` is read here as `m.script.scenes[i].reframe` and added in Task 7 (this task reads it through a typed accessor so Task 6 compiles first, see Step 3).

- [ ] **Step 1: Write the failing tests**

`test/stages/references.test.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { anchorScene, previousKeyframeScene, reframes, referencesFor } from "../../src/stages/references.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

async function flux3Run(opts: { cutReferences?: boolean; shots?: Array<"cut" | "continue">; reframe?: boolean[] } = {}) {
  const { ctx, fakes, dir } = await makeTestContext({ modes: [1, 1, 1, 1], shots: opts.shots ?? ["cut", "continue", "cut", "cut"] });
  const m = ctx.manifest;
  m.request.imageProfile = "runpod-flux3-klein@1";
  if (opts.cutReferences !== undefined) m.request.cutReferences = opts.cutReferences;
  m.script = fakeScript(4, { shots: opts.shots ?? ["cut", "continue", "cut", "cut"] }) as never;
  (opts.reframe ?? []).forEach((r, i) => ((m.script!.scenes[i] as { reframe?: boolean }).reframe = r));
  return { ctx, fakes, m, dir };
}

describe("which scene's picture is the anchor and which came before", () => {
  it("takes the first keyframe as the anchor, and the nearest earlier keyframe as the previous one", async () => {
    const { m } = await flux3Run();
    expect(anchorScene(m)).toBe(0);
    expect(previousKeyframeScene(m, 2)).toBe(0); // scene 1 continues scene 0: no keyframe of its own
    expect(previousKeyframeScene(m, 3)).toBe(2);
    expect(previousKeyframeScene(m, 0)).toBe(-1);
  });
});

describe("what a keyframe is conditioned on", () => {
  it("is nothing for a profile that takes one reference, whatever else is set", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, true, false] });
    m.request.imageProfile = "runpod-klein@1";
    expect(referencesFor(m, 2)).toEqual([]);
  });

  it("is only the portrait while cut references are off", async () => {
    const { m } = await flux3Run({ cutReferences: false, reframe: [false, false, true, false] });
    expect(referencesFor(m, 2).every((p) => !p.includes("keyframe"))).toBe(true);
  });

  it("adds the look anchor to every later keyframe when cut references are on, and not to the anchor itself", async () => {
    const { m } = await flux3Run({ cutReferences: true });
    expect(referencesFor(m, 0).filter((p) => p.includes("keyframe"))).toEqual([]);
    expect(referencesFor(m, 2).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png"]);
  });

  it("adds the previous keyframe for a reframe, after the anchor, and does not repeat the anchor", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, true, true] });
    expect(reframes(m, 2)).toBe(true);
    expect(referencesFor(m, 2).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png"]); // previous is the anchor itself
    expect(referencesFor(m, 3).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png", "images/keyframe_03.png"]);
  });

  it("never reframes scene 1, a continue scene, or a run that did not freeze cut references", async () => {
    const a = await flux3Run({ cutReferences: true, reframe: [true, true, false, false] });
    expect(reframes(a.m, 0)).toBe(false);
    expect(reframes(a.m, 1)).toBe(false); // a continue scene
    const b = await flux3Run({ cutReferences: false, reframe: [false, false, true, false] });
    expect(reframes(b.m, 2)).toBe(false);
  });
});

describe("the keyframe stage's dependencies and cache keys", () => {
  it("makes a keyframe wait for the anchor and, for a reframe, for the previous keyframe", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, false, true] });
    const deps = (scene: number) => keyframesStage.deps(m, scene).filter((d) => d.stage === "keyframes").map((d) => d.scene);
    expect(deps(0)).toEqual([]);
    expect(deps(2)).toEqual([0]);
    expect(deps(3)).toEqual([0, 2]);
  });

  it("adds no key to a run that takes one reference, so it keeps exactly the cache key it had", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], seed: 5 });
    const inputs = JSON.parse(JSON.stringify(await keyframesStage.inputsFor(ctx, 0)));
    expect(Object.keys(inputs).sort()).toEqual(["model", "prompt", "seed", "size"]);
  });

  it("puts the hash of each reference in the key of a run that has them, and none in the single field", async () => {
    const { ctx, dir } = await flux3Run({ cutReferences: true });
    await mkdir(`${dir}/images`, { recursive: true });
    await writeFile(`${dir}/images/keyframe_01.png`, "anchor bytes");
    const inputs = JSON.parse(JSON.stringify(await keyframesStage.inputsFor(ctx, 2)));
    expect(inputs.references).toHaveLength(1);
    expect(inputs).not.toHaveProperty("reference");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/stages/references.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/manifest/schema.ts`, in `RunRequest` after `imageProfile`:
```ts
  /** Reframe cuts and the shared look reference are in use (phase 10 spec §5); frozen at the start, absent = no; set only on a profile that takes several references. */
  cutReferences: z.boolean().optional(),
```
and in `SceneSpec` (this is the field Task 7 documents; adding the optional field here lets `references.ts` compile and keeps old scripts loading):
```ts
  /** Optional when stored: absent means false. A cut to the same place and moment as the previous scene, from a new view (phase 10 spec §4). */
  reframe: z.boolean().optional().describe("true on a cut scene that shows the same place and moment as the previous scene from a new angle or distance; false otherwise"),
```
`src/stages/references.ts`:
```ts
import { takesSeveralReferences } from "../image-profiles.js";
import type { Manifest } from "../manifest/schema.js";
import { paths } from "./paths.js";
import { referenceFor } from "./reference.js";
import { needsKeyframe } from "./visual.js";

/** The scene of the run's first keyframe: the look the others share (phase 10 spec §5). */
export const anchorScene = (m: Manifest): number => m.scenes.findIndex((s) => needsKeyframe(m, s.idx));

/** The nearest earlier scene that has a keyframe of its own, or -1. */
export function previousKeyframeScene(m: Manifest, scene: number): number {
  for (let j = scene - 1; j >= 0; j--) if (needsKeyframe(m, j)) return j;
  return -1;
}

/** Whether scene `scene` is a reframe: a cut to the same place from a new view, in a run that froze cut references. */
export function reframes(m: Manifest, scene: number): boolean {
  const s = m.script?.scenes[scene];
  return m.request.cutReferences === true && takesSeveralReferences(m.request.imageProfile) && scene > 0 && s?.shot === "cut" && s.reframe === true;
}

/**
 * The pictures scene `scene`'s keyframe is conditioned on, run-relative and in order: the character portrait
 * where the scene shows the character, the look anchor (every keyframe after the first), and for a reframe the
 * previous keyframe. Empty for a profile that takes one reference: it keeps its single portrait field.
 */
export function referencesFor(m: Manifest, scene: number): string[] {
  if (!takesSeveralReferences(m.request.imageProfile)) return [];
  const out: string[] = [];
  const portrait = referenceFor(m, scene);
  if (portrait) out.push(portrait);
  if (m.request.cutReferences === true) {
    const anchor = anchorScene(m);
    if (scene > anchor) out.push(paths.keyframe(anchor));
    if (reframes(m, scene)) {
      const prev = previousKeyframeScene(m, scene);
      if (prev >= 0 && prev !== anchor) out.push(paths.keyframe(prev));
    }
  }
  return out;
}

/** The keyframes scene `scene`'s keyframe must wait for: its anchor and, for a reframe, its previous picture. */
export function referenceScenes(m: Manifest, scene: number): number[] {
  if (!takesSeveralReferences(m.request.imageProfile) || m.request.cutReferences !== true) return [];
  const out: number[] = [];
  const anchor = anchorScene(m);
  if (scene > anchor) out.push(anchor);
  if (reframes(m, scene)) {
    const prev = previousKeyframeScene(m, scene);
    if (prev >= 0 && prev !== anchor) out.push(prev);
  }
  return out;
}
```
`src/stages/keyframes.ts`:
- imports: `takesSeveralReferences` from `../image-profiles.js`; `referencesFor, referenceScenes` from `./references.js`.
- `deps: (m, scene) => [ ...existing three entries..., ...(scene === undefined ? [] : referenceScenes(m, scene).map((s) => ({ stage: "keyframes" as const, scene: s }))) ]`.
- `inputsFor`: replace the `reference:` line with
```ts
    const several = takesSeveralReferences(ctx.manifest.request.imageProfile);
    const refs = several ? referencesFor(ctx.manifest, scene!) : [];
    ...
      // only runs with a reference key on it, so every other run keeps its cache key
      reference: !several && reference !== undefined ? await fileSha256(abs(ctx, reference)) : undefined,
      references: refs.length ? await Promise.all(refs.map((p) => fileSha256(abs(ctx, p)))) : undefined,
```
(keep `const reference = referenceFor(...)` above it.)
- `run`'s `prepare`: replace the reference lines with
```ts
          const several = takesSeveralReferences(ctx.manifest.request.imageProfile);
          const reference = referenceFor(ctx.manifest, i);
          const refs = several ? referencesFor(ctx.manifest, i).map((p) => abs(ctx, p)) : [];
          return ctx.providers.image.prepare({
            prompt,
            ...ctx.keyframeSize,
            seed: remake === 0 ? keyframeSeed(ctx.manifest, i) : seed,
            preset: effectivePreset(ctx.manifest)?.name,
            referenceImagePath: !several && reference !== undefined ? abs(ctx, reference) : undefined,
            referenceImagePaths: refs.length ? refs : undefined,
          });
```
`src/cli.ts` (in the request object near `imageProfile: providers.imageProfile,`): add
```ts
      // frozen with the run: reframe cuts and the shared look reference, only where the picture worker takes several references
      cutReferences: takesSeveralReferences(providers.imageProfile) && env.FLOWCHAIN_CUT_REFERENCES === "on" ? true : undefined,
```
(import `takesSeveralReferences` from `./image-profiles.js`). `src/studio/draft.ts:71`: next to `imageProfile: m.request.imageProfile,` add `cutReferences: m.request.cutReferences,`. Then `grep -rn "imageProfile:" src web --include='*.ts'` and add `cutReferences` wherever a request is copied from another request (not where a fresh one is built).

- [ ] **Step 4: Run to see them pass; run the stage suites**

Run: `npx vitest run test/stages/references.test.ts test/stages test/pipeline test/unit/compat.test.ts && npm run typecheck`
Expected: PASS. `compat.test.ts` untouched and green.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: a FLUX 3 keyframe is conditioned on the portrait, the run's look anchor and, for a reframe, the previous keyframe, waits for them, and keys its cache on them, while every other run keeps its key

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reframe in the script: the type table, the prompt, the normalisation, version `.12`

**Files:**
- Modify: `src/stages/references.ts` (`REFERENCE_NOTE`, `referenceNoteFor`), `src/stages/keyframes.ts` (uses it),
- Modify: `src/formats.ts` (type + all eight entries), `src/providers/types.ts` (`ScriptRequest.reframe?`), `src/providers/gemini.ts` (`sceneRules`), `src/stages/script.ts`, `src/providers/prompt-version.ts`, `docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md` (changelog), `test/helpers/prompt-pins.ts`, `test/unit/prompt-pins.json` (regenerated), `src/eval/cases.ts`
- Test: `test/unit/reframe-script.test.ts`

**Interfaces:**
- Produces: `VideoFormat.reframe: boolean`; `ScriptRequest.reframe?: boolean`; `allowsReframe(m: Manifest): boolean` exported from `src/stages/script.ts`.

- [ ] **Step 1: Write the failing tests**

`test/unit/reframe-script.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../src/formats.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { allowsReframe, scriptStage } from "../../src/stages/script.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const base = { topic: "The war that lasted 38 minutes", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("which types may reframe", () => {
  it("are the ones told in a place the viewer stays in: documentary, story and pov", () => {
    expect(FORMATS.filter((f) => f.reframe).map((f) => f.id).sort()).toEqual(["documentary", "pov", "story"]);
    expect(FORMATS).toHaveLength(8);
  });
});

describe("the script prompt", () => {
  it("offers reframe only when the run may use it", () => {
    expect(buildScriptPrompt({ ...base, format: "story", reframe: true })).toContain("- reframe: true on a");
    expect(buildScriptPrompt({ ...base, format: "story" })).not.toContain("reframe");
  });
});

async function runOf(opts: { format?: string; profile?: "runpod-flux3-klein@1" | "runpod-klein@1"; cutReferences?: boolean; answer: ReturnType<typeof fakeScript> }) {
  const { ctx, fakes } = await makeTestContext({ modes: "auto", sceneCount: 4, script: () => opts.answer });
  ctx.manifest.request.format = opts.format as never;
  ctx.manifest.request.imageProfile = opts.profile;
  ctx.manifest.request.cutReferences = opts.cutReferences;
  return { ctx, fakes };
}

describe("a run's permission to reframe", () => {
  it("needs a type that may, a picture profile that takes several references, and the frozen setting", async () => {
    const yes = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4) });
    expect(allowsReframe(yes.ctx.manifest)).toBe(true);
    for (const change of [{ format: "explainer" }, { profile: "runpod-klein@1" as const }, { cutReferences: false }]) {
      const no = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4), ...change });
      expect(allowsReframe(no.ctx.manifest), JSON.stringify(change)).toBe(false);
    }
  });

  it("is asked of the model only when allowed, and the question is part of the script's cache key only then", async () => {
    const off = await runOf({ format: "explainer", answer: fakeScript(4) });
    const on = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4) });
    expect(await scriptStage.inputsFor(off.ctx)).not.toHaveProperty("reframe");
    expect(await scriptStage.inputsFor(on.ctx)).toHaveProperty("reframe", true);
    await runPipeline(on.ctx, [scriptStage], auto);
    expect(on.fakes.llm.calls[0].reframe).toBe(true);
    await runPipeline(off.ctx, [scriptStage], auto);
    expect(off.fakes.llm.calls[0].reframe).toBeUndefined();
  });
});

describe("a reframe the model marked", () => {
  const marked = () => {
    const s = fakeScript(4, { shots: ["cut", "continue", "cut", "cut"] });
    s.scenes.forEach((sc) => ((sc as { reframe?: boolean }).reframe = true));
    return s;
  };

  it("is kept on a cut after the first scene, and put right everywhere else, without a paid retry", async () => {
    const { ctx, fakes } = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: marked() });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script!.scenes.map((s) => s.reframe)).toEqual([false, false, true, true]);
    expect(fakes.llm.calls).toHaveLength(1);
  });

  it("is dropped from every scene when the run may not reframe", async () => {
    const { ctx } = await runOf({ format: "explainer", answer: marked() });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script!.scenes.every((s) => s.reframe === undefined)).toBe(true);
  });
});
```

- [ ] **Step 1b: Write the failing tests for the look-reference note**

Append to `test/stages/references.test.ts` (it already has `flux3Run` and `keyframesStage`; extend its import from `../../src/stages/references.js` with `REFERENCE_NOTE, referenceNoteFor`):
```ts
describe("the note that goes with a look reference", () => {
  it("tells the picture model to take only the look from the pictures it was given, and only when it has a look anchor or a previous picture", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, true, false] });
    expect(referenceNoteFor(m, 0)).toBe("");
    expect(referenceNoteFor(m, 2)).toBe(REFERENCE_NOTE);
    expect(REFERENCE_NOTE).toContain("light, palette and grain");
    expect(REFERENCE_NOTE).toContain("do not copy");
    m.request.cutReferences = false;
    expect(referenceNoteFor(m, 2)).toBe("");
  });

  it("is part of the keyframe's cache key, so changing its wording makes the picture again", async () => {
    const { ctx } = await flux3Run({ cutReferences: true });
    const inputs = JSON.parse(JSON.stringify(await keyframesStage.inputsFor(ctx, 2)));
    expect(inputs.prompt).toContain(REFERENCE_NOTE);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/unit/reframe-script.test.ts test/stages/references.test.ts`
Expected: FAIL (`reframe` not on formats; `allowsReframe` missing).

- [ ] **Step 3: Implement**

`src/formats.ts`: in `VideoFormat` add
```ts
  /**
   * Whether the script may mark a cut as a reframe (phase 10 spec §4): the same place and moment from a new view,
   * drawn from the previous picture. Told in a place the viewer stays in: yes; a list or an argument: no.
   */
  reframe: boolean;
```
and in each of the eight entries add `reframe: <value>,` right after `goesWith`: `documentary: true`, `explainer: false`, `story: true`, `countdown: false`, `motivational: false`, `myth-busting: false`, `versus: false`, `pov: true`.
`src/providers/types.ts`, in `ScriptRequest` after `localize?`:
```ts
  /** The script may mark a cut as a reframe (phase 10 spec §4); absent = it may not and is not told of it. */
  reframe?: boolean;
```
`src/providers/gemini.ts`: above `sceneRules` add
```ts
const REFRAME_RULE =
  '- reframe: true on a "cut" scene that shows the same place and moment as the previous scene from a new angle or distance (its imagePrompt describes the new view, and keeps that place\'s light and surroundings the same); false for every other scene, and always false for scene 1, for a "continue" scene and for the first scene you write.';
```
and in the list returned by `sceneRules`, directly after the `shot:` line (and before the `continue` motion rule), add `...(req.reframe ? [REFRAME_RULE] : []),`.
`src/stages/script.ts`: imports `formatById` from `../formats.js`, `takesSeveralReferences` from `../image-profiles.js`, `Manifest` type. Add:
```ts
/** Whether a run's script may mark reframes: a type that may, a picture profile that takes several references, and the frozen setting (phase 10 spec §4). */
export function allowsReframe(m: Manifest): boolean {
  return formatById(m.request.format)?.reframe === true && takesSeveralReferences(m.request.imageProfile) && m.request.cutReferences === true;
}

/** Puts a model's reframe marks right, in code and not by a paid retry (phase 10 spec §12): only a cut after the first scene can be one. */
function settleReframes(scenes: Array<{ shot: string; reframe?: boolean }>, allowed: boolean): void {
  scenes.forEach((s, i) => {
    if (!allowed) delete s.reframe;
    else if (s.reframe !== undefined) s.reframe = s.reframe === true && s.shot === "cut" && i > 0;
  });
}
```
In `scriptStage.inputsFor` add `...(allowsReframe(ctx.manifest) ? { reframe: true } : {})` to the `asked` object (keys unchanged for everyone else). In `run`: build `req` with `...(allowsReframe(ctx.manifest) ? { reframe: true } : {})`; after the `script` is obtained and `shots`/first-scene rules are applied, call `settleReframes(script.scenes, allowsReframe(ctx.manifest))`; in `writeInParts`, where `part[0].shot = "cut"` is set, also `part[0].reframe = part[0].reframe === undefined ? undefined : false;`. (The last scene of `settleReframes` must run after parts are joined: call it in `run` after `writeInParts` returns, and also keep the per-part line so `i > 0` inside a joined list does not keep a part's first scene as a reframe.)
`src/stages/references.ts`, append:
```ts
/**
 * Said to the picture model beside a look reference (phase 10 spec §5). The model draws on every picture it is
 * given, and the 4B one copied whatever stood in a portrait (phase 5 spec §9.12): the anchor is for the look only.
 */
export const REFERENCE_NOTE = "Use the reference pictures only for light, palette and grain, and for the surroundings of the same place; do not copy their objects, poses or people.";

/** The note for scene `scene`'s picture prompt: only where it has a look anchor or a previous picture to draw on. */
export const referenceNoteFor = (m: Manifest, scene: number): string => (referencesFor(m, scene).some((p) => p.includes("keyframe")) ? REFERENCE_NOTE : "");
```
`src/stages/keyframes.ts`: import `referenceNoteFor`; in `inputsFor` change `prompt: imagePrompt(…)` to `prompt: withNote(imagePrompt(requireScript(ctx.manifest), scene!, effectivePreset(ctx.manifest), editById(ctx.manifest.request.edit)), referenceNoteFor(ctx.manifest, scene!))`, and in `run` change the `const prompt = imagePrompt(…)` the same way, with, above `keyframesStage`:
```ts
const withNote = (prompt: string, note: string): string => (note ? `${prompt} ${note}` : prompt);
```
`src/providers/prompt-version.ts`: `PROMPT_VERSION = "2026-10-18.12"`. Phase 9 spec changelog line:
```markdown
- `2026-10-18.12` — the script may mark a cut as a reframe (phase 10 spec §4): a new rule offered only to a documentary, story or pov run that takes several picture references; and a note, added only to a picture prompt that has a look reference, to take the look and copy nothing else; no prompt changes for any other run.
```
`test/helpers/prompt-pins.ts`: import `REFERENCE_NOTE` from `../../src/stages/references.js` and add entries
```ts
    "whole:reframe": buildScriptPrompt({ ...base, format: "story", reframe: true }),
    "references:note": REFERENCE_NOTE,
    "part:1:reframe": buildScriptPrompt({ ...base, timing: timed, format: "documentary", reframe: true, ask: { kind: "part", index: 1, partSec: [60, 60], outline, previous: ["Last line one."] } }),
```
Then `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts`, and add to `src/eval/cases.ts` two cases (inside `CASES`, with the factory `req(...)`; the eval request carries the flag):
```ts
  { id: "reframe-story", note: "a story run that may reframe: reframes only on cuts, same place, never scene 1", request: req("The lighthouse that kept counting", { niche: "scary-stories", format: "story", reframe: true, language: "en" }) },
  { id: "no-reframe-explainer", note: "an explainer is never offered reframe", request: req("Why the sky is blue", { niche: "space-science", format: "explainer", language: "en" }) },
```
(the `cases.test.ts` check that format/niche pairs are allowed still applies).

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run test/unit test/stages test/eval test/pipeline && npm run typecheck`
Expected: PASS, including the pin and changelog tests (`prompt-changelog.test.ts` demands the `.12` line).

- [ ] **Step 5: Commit**

```bash
git add src test docs
git commit -m "feat: a story, documentary or pov script on FLUX 3 may mark a cut as a reframe, which code puts right instead of sending back, and no other run is told of it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The prompt upsampler through Gemini (text-to-image and image-to-image), version `.13`

Rewritten after Task 1 (spec §3.1): BFL's upsampler has TWO instruction sets, `t2i` and `i2i`, and the edit one sees the reference pictures. If §3.1 ever says the instructions are "not public", stop and report; it does not.

**Files:**
- Modify: `src/providers/gemini.ts` (`UPSAMPLER_T2I`, `UPSAMPLER_I2I`, `upsampleInstructions`, `upsampleUserText`, `maxSideFor`, `GeminiLlm.upsample`), `src/providers/prompt-version.ts` (`TEMPERATURE.upsample`, version), `src/providers/types.ts` (`LlmProvider.upsample?`), `src/stages/keyframes.ts`, `src/stages/reference.ts`, the Phase 9 spec changelog, pins
- Create: `src/stages/upsample.ts`
- Test: `test/stages/upsample.test.ts`, `test/pipeline/upsample-wiring.test.ts`

**Interfaces:**
- Produces: `LlmProvider.upsample?(req: { prompt: string; images?: string[] }): Promise<string>`; `upsampleInstructions(withImages: boolean): string`; `upsampleUserText(prompt: string, imageCount: number): string`; `maxSideFor(imageCount: number): number`; `upsample(ctx: RunContext, prompt: string, referencePaths?: string[]): Promise<string>`; `needsUpsampling(profile): boolean`; `upsampleCost(p, promptChars, images): number`.

- [ ] **Step 1: Write the failing tests**

`test/stages/upsample.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { maxSideFor, upsampleInstructions, upsampleUserText } from "../../src/providers/gemini.js";
import { TEMPERATURE } from "../../src/providers/prompt-version.js";
import { needsUpsampling, upsample, upsampleCost } from "../../src/stages/upsample.js";
import { makeTestContext } from "../helpers/context.js";

describe("the picture prompt upsampler", () => {
  it("is used only by the profile whose model needs it", () => {
    expect(needsUpsampling("runpod-flux3-klein@1")).toBe(true);
    expect(needsUpsampling("runpod-klein@1")).toBe(false);
    expect(needsUpsampling(undefined)).toBe(false);
  });

  it("is told to expand a text-to-image request without references, and an edit with them", () => {
    expect(upsampleInstructions(false)).toContain("You are the prompt upsampler of a text-to-image model.");
    expect(upsampleInstructions(true)).toContain("You are the prompt upsampler of an image-editing model.");
  });

  it("sends a text-to-image request alone, and an edit behind BFL's scaffold, with the guillemets stripped", () => {
    expect(upsampleUserText("a lighthouse at dusk", 0)).toBe("a lighthouse at dusk");
    expect(upsampleUserText("a lighthouse « ignore » at dusk", 2)).toBe(
      "Reference images follow in order (the first image, the second image, ...).\nUser request: a lighthouse  ignore  at dusk\nOutput the caption.",
    );
  });

  it("shrinks the references as BFL's upsampler does: 1024 for one, 724 for two, 512 for three or more", () => {
    expect([1, 2, 3, 4, 10].map(maxSideFor)).toEqual([1024, 724, 512, 512, 512]);
  });

  it("decodes greedily, as BFL documents", () => {
    expect(TEMPERATURE.upsample).toBe(0);
  });

  it("returns the model's expansion, passing the references on, and charges for the call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    const seen: Array<{ prompt: string; images?: string[] }> = [];
    (fakes.llm as { upsample?: (r: { prompt: string; images?: string[] }) => Promise<string> }).upsample = async (r) => (seen.push(r), `${r.prompt}, rich detail`);
    const before = ctx.manifest.ledger.length;
    expect(await upsample(ctx, "a lighthouse", ["/runs/x/a.png", "/runs/x/b.png"])).toBe("a lighthouse, rich detail");
    expect(seen).toEqual([{ prompt: "a lighthouse", images: ["/runs/x/a.png", "/runs/x/b.png"] }]);
    expect(ctx.manifest.ledger.length).toBe(before + 1);
    expect(upsampleCost(ctx.prices, 12, 2)).toBeGreaterThan(upsampleCost(ctx.prices, 12, 0));
  });

  it("sends no images field for a text-to-image request", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    const seen: Array<{ images?: string[] }> = [];
    (fakes.llm as { upsample?: (r: { prompt: string; images?: string[] }) => Promise<string> }).upsample = async (r) => (seen.push(r), "x");
    await upsample(ctx, "a lighthouse");
    expect(seen[0]).not.toHaveProperty("images");
  });

  it("returns the prompt untouched when the provider cannot upsample, and charges nothing", async () => {
    const { ctx } = await makeTestContext({ modes: [1] });
    const before = ctx.manifest.ledger.length;
    expect(await upsample(ctx, "a lighthouse")).toBe("a lighthouse");
    expect(ctx.manifest.ledger.length).toBe(before);
  });

  it("stops the picture with a plain message, never the provider's text, when the model cannot be reached", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    (fakes.llm as { upsample?: () => Promise<string> }).upsample = async () => {
      throw new Error("503 from the provider with a secret body");
    };
    const failed = await upsample(ctx, "a lighthouse").catch((e: Error) => e);
    expect((failed as Error).message).toMatch(/prompt could not be expanded/);
    expect((failed as Error).message).not.toMatch(/secret body/);
  });
});
```
`test/pipeline/upsample-wiring.test.ts` (set up like `test/pipeline/cut-references.test.ts`: a FLUX 3 run with injected prices, `cutReferences: true`, `format = "story"`, characters set, a script with all scenes `cut` and `reframe` on scenes 3 and 4, run with `runPipeline(ctx, STAGES, auto)`; the fake LLM gets an `upsample` that records its request and returns `"UP:" + prompt`):
```ts
// asserts, each as its own test named as a sentence:
// 1. every picture bought on the FLUX 3 profile was upsampled first: each fakes.image.submits[k].prompt starts with "UP:" and the portrait's (the reference stage's) too
// 2. the portrait's request has NO images; scene 1's has [reference.png]; scene 2's [reference.png, keyframe_01.png]; scene 4's [reference.png, keyframe_01.png, keyframe_03.png] — compare basenames, in order
// 3. the picture prompt that was upsampled contains REFERENCE_NOTE for scenes 2-4 and not for the portrait or scene 1
// 4. a 4B-profile run (runpod-klein@1) never calls upsample and its submitted prompts do not start with "UP:"
```
Write these four tests out in full with the helpers `cut-references.test.ts` already uses (copy its `run()` helper and script construction); do not leave the comment block in place of code.

- [ ] **Step 2: Run to see them fail; then implement**

Run: `npx vitest run test/stages/upsample.test.ts test/pipeline/upsample-wiring.test.ts` → FAIL (module and exports missing).

`src/providers/prompt-version.ts`: `TEMPERATURE` gains `upsample: 0` (greedy; BFL's upsampler card: "greedy, `top_p` 0.95, `top_k` 20"); `PROMPT_VERSION = "2026-10-18.13"`; Phase 9 spec changelog:
```markdown
- `2026-10-18.13` — a new Gemini call, `upsample`, expands a picture prompt for the FLUX 3 picture model with BFL's own text-to-image or image-editing instructions, and sees the reference pictures when there are some (phase 10 spec §3, §3.1); greedy decoding; no other prompt changed.
```
`src/providers/types.ts`, in `LlmProvider`:
```ts
  /** Expands a picture prompt for a model that needs it, seeing its reference pictures (phase 10 spec §3). Optional: a provider without it leaves the prompt as it is. */
  upsample?(req: { prompt: string; images?: string[] }): Promise<string>;
```
`src/providers/gemini.ts`, add (the two constants are BFL's `system_prompts.json` `t2i` and `i2i` texts, copied character for character from spec §3.1; the `i2i` text contains the two characters backslash and `n` where the file's decoded string has them, so write them as `\\n` inside a template literal; the 46,000-character "external VLM" prompt set is not used because the model card names `system_prompts.json`):
```ts
const UPSAMPLER_T2I = `<the t2i text from spec §3.1, verbatim>`;
const UPSAMPLER_I2I = `<the i2i text from spec §3.1, verbatim>`;

/** BFL's instructions for the upsampler: the text-to-image set without references, the editing set with them. */
export const upsampleInstructions = (withImages: boolean): string => (withImages ? UPSAMPLER_I2I : UPSAMPLER_T2I);

/**
 * The user message: a text-to-image request alone; an edit behind BFL's scaffold (`I2I_SCAFFOLD[False]` in its
 * reference code). The request is text to expand, with « and » stripped, and sits only in the user message.
 */
export function upsampleUserText(prompt: string, imageCount: number): string {
  const request = prompt.replace(/[«»]/g, "");
  return imageCount === 0 ? request : `Reference images follow in order (the first image, the second image, ...).\nUser request: ${request}\nOutput the caption.`;
}

/** The longest side the upsampler sees a reference at (BFL's `MAX_PIXELS_BY_REFS`): 1024 for one, 724 for two, 512 for more. */
export const maxSideFor = (imageCount: number): number => (imageCount <= 1 ? 1024 : imageCount === 2 ? 724 : 512);
```
(Those `<…>` markers are the only data this plan cannot contain: replace them with §3.1's text; no marker may remain.) And in `GeminiLlm`:
```ts
  async upsample(req: { prompt: string; images?: string[] }): Promise<string> {
    const images = req.images ?? [];
    const side = maxSideFor(images.length);
    const parts = [
      ...(await Promise.all(images.map(async (path) => ({ inlineData: { mimeType: "image/jpeg", data: (await shrinkReference(path, side)).toString("base64") } })))),
      { text: upsampleUserText(req.prompt, images.length) },
    ];
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: { systemInstruction: upsampleInstructions(images.length > 0), temperature: TEMPERATURE.upsample, topP: 0.95, topK: 20, maxOutputTokens: 3584 },
    });
    const text = res.text?.trim();
    if (!text) throw new Error("Gemini returned an empty response");
    return text;
  }
```
(import `shrinkReference` from `../media/reference-image.js`; no presence penalty is set: some Gemini models refuse it, and the first real run will show the quality.)
`src/stages/upsample.ts`:
```ts
import type { Prices } from "../config.js";
import { round4 } from "../cost.js";
import type { ImageProfileId } from "../image-profiles.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import type { RunContext } from "./types.js";

/** Only the FLUX 3 profile's model is not to be used without an upsampler (phase 10 spec §2). */
export const needsUpsampling = (id: ImageProfileId | undefined): boolean => id === "runpod-flux3-klein@1";

/** What one expansion costs: the instructions (about 1,500 tokens) and the prompt in, each picture at about 260 tokens, a longer prompt out. */
export function upsampleCost(p: Pick<Prices, "llmPerMInputTokens" | "llmPerMOutputTokens">, promptChars: number, images: number): number {
  return round4((((promptChars / 4) + 1500 + images * 260) * p.llmPerMInputTokens + 500 * p.llmPerMOutputTokens) / 1e6);
}

/**
 * Expands a picture prompt, and charges for it. A provider without `upsample` (the test stand-ins) leaves the
 * prompt as it is. A model that cannot be reached stops the picture: the FLUX 3 model is not to be used without
 * its upsampler, and an unexpanded prompt would spend a picture's GPU seconds on a worse one. The message never
 * carries the provider's own text. The upsampled prompt is not stored (phase 10 spec §6).
 */
export async function upsample(ctx: RunContext, prompt: string, referencePaths: string[] = []): Promise<string> {
  const llm = ctx.providers.llm;
  if (!llm.upsample) return prompt;
  try {
    const expanded = await withRetry("prompt expansion", () => llm.upsample!({ prompt, ...(referencePaths.length ? { images: referencePaths } : {}) }), { timeoutMs: TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs, attempts: 2 });
    await ctx.charge(upsampleCost(ctx.prices, prompt.length, referencePaths.length));
    return expanded;
  } catch {
    throw new Error("the picture prompt could not be expanded for the picture model; resume the run to try again");
  }
}
```
Wire it. `src/stages/keyframes.ts` `prepare` (made `async`):
```ts
          const refsAbs = several ? referencesFor(ctx.manifest, i).map((p) => abs(ctx, p)) : [];
          const sent = needsUpsampling(ctx.manifest.request.imageProfile) ? await upsample(ctx, prompt, refsAbs) : prompt;
          ...prepare({ prompt: sent, ... })
```
(`prompt` is the text with the reference note already added by Task 7; `refsAbs` is the list `prepare` already builds, so build it once.) `src/stages/reference.ts` `run`: the portrait has no references:
```ts
      prepare: async () => image.prepare({ prompt: needsUpsampling(ctx.manifest.request.imageProfile) ? await upsample(ctx, req.prompt) : req.prompt, ...REFERENCE_SIZE, seed: req.seed, preset: req.preset }),
```
Pins: add to `test/helpers/prompt-pins.ts` `"upsample:t2i": upsampleInstructions(false) + "\n" + upsampleUserText("a lighthouse at dusk", 0)` and `"upsample:i2i": upsampleInstructions(true) + "\n" + upsampleUserText("a lighthouse at dusk", 2)`, import the two functions, then `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts` (only after the version bump). The `temperatures` pin moves because `upsample: 0` joins the table; that is the version's reason.

- [ ] **Step 3: Run to see them pass; commit**

Run: `npx vitest run test/stages test/unit test/pipeline test/eval && npm run typecheck`
Expected: PASS (the pipeline suite takes a minute).
```bash
git add src test docs
git commit -m "feat: a FLUX 3 picture prompt is expanded by Gemini with BFL's own text-to-image or editing instructions, which sees the reference pictures, before the picture is bought, and the call is charged and never stored

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The picture check also sees copying and unsafe content, version `.14`

**Files:**
- Modify: `src/providers/types.ts` (`InspectRequest`), `src/providers/gemini.ts` (`inspectPrompt`, `GeminiLlm.inspect`, `INSPECT_SCHEMA`), `src/stages/inspect.ts` (`Verdict`, `inspect`), `src/stages/keyframes.ts`, `prompt-version.ts`, the Phase 9 spec changelog, pins
- Test: `test/unit/inspect-references.test.ts`, `test/pipeline/keyframe-content.test.ts`

**Interfaces:**
- Produces: `InspectRequest.references?: string[]`, `InspectRequest.checkContent?: boolean`; `Verdict.unsafe: boolean` (default false); `inspect(ctx, images, expected, opts?: { references?: string[]; checkContent?: boolean })`.

- [ ] **Step 1: Write the failing tests**

`test/unit/inspect-references.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { inspectPrompt } from "../../src/providers/gemini.js";
import { Verdict } from "../../src/stages/inspect.js";

describe("the look at a picture", () => {
  it("also looks for what was copied from a reference, and says which pictures are references", () => {
    const p = inspectPrompt({ images: ["a.png"], expected: "a lighthouse", references: ["r1.png", "r2.png"] });
    expect(p).toContain("copied from a reference");
    expect(p).toContain("last 2 pictures");
  });
  it("does not mention references where there are none", () => {
    expect(inspectPrompt({ images: ["a.png"], expected: "a lighthouse" })).not.toContain("reference");
  });
  it("looks for unlawful, unsafe or infringing content only when asked", () => {
    expect(inspectPrompt({ images: ["a.png"], expected: "x", checkContent: true })).toContain("unlawful, unsafe or infringing");
    expect(inspectPrompt({ images: ["a.png"], expected: "x" })).not.toContain("unlawful");
  });
  it("reads an answer without the new field as safe", () => {
    expect(Verdict.parse({ ok: true, problems: [] }).unsafe).toBe(false);
    expect(Verdict.parse({ ok: false, problems: ["x"], unsafe: true }).unsafe).toBe(true);
  });
});
```
`test/pipeline/keyframe-content.test.ts` (the setup follows `test/pipeline/inspect.test.ts`):
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import type { InspectRequest } from "../../src/providers/types.js";
import { STAGES } from "../../src/stages/index.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

async function run(profile: "runpod-flux3-klein@1" | "runpod-klein@1") {
  const made = await makeTestContext({ modes: [2, 2], seed: 100 });
  made.ctx.manifest.request.imageProfile = profile;
  // the FLUX 3 profile cannot be priced without its four rates
  Object.assign(made.ctx.prices, { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 });
  return made;
}

describe("the look at a FLUX 3 picture for unsafe content (phase 10 spec §6)", () => {
  it("makes an unsafe picture again with another seed and uses the new one", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1");
    let first = true;
    fakes.llm.inspect = async (req) => {
      const bad = req.expected.includes("image 1") && first;
      if (bad) first = false;
      return bad ? { ok: false, problems: ["unsafe"], unsafe: true } : { ok: true, problems: [] };
    };
    await runPipeline(ctx, STAGES, auto);
    const made = fakes.image.submits.filter((r) => r.prompt.includes("image 1"));
    expect(made).toHaveLength(2);
    expect(new Set(made.map((r) => r.seed)).size).toBe(2);
    expect(ctx.manifest.scenes[0].keyframe).toBeDefined();
  });

  it("stops with a plain message when the last try is unsafe too, and keeps no keyframe file for it", async () => {
    const { ctx, fakes, dir } = await run("runpod-flux3-klein@1");
    fakes.llm.inspect = async () => ({ ok: false, problems: ["unsafe"], unsafe: true });
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/flagged as unsafe content/);
    expect(ctx.manifest.scenes[0].keyframe).toBeUndefined();
    expect(existsSync(join(dir, "images/keyframe_01.png"))).toBe(false);
  });

  it("still uses a merely malformed picture on the last try, but looks at that try too", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1");
    const seen: InspectRequest[] = [];
    fakes.llm.inspect = async (req) => (seen.push(req), req.expected.includes("image 1") ? { ok: false, problems: ["blur"] } : { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits.filter((r) => r.prompt.includes("image 1"))).toHaveLength(3);
    expect(seen.filter((r) => r.expected.includes("image 1"))).toHaveLength(3);
    expect(seen.every((r) => r.checkContent === true)).toBe(true);
    expect(ctx.manifest.scenes[0].keyframe).toBeDefined();
  });

  it("is never asked of the 4B profile", async () => {
    const { ctx, fakes } = await run("runpod-klein@1");
    const seen: InspectRequest[] = [];
    fakes.llm.inspect = async (req) => (seen.push(req), { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.checkContent !== true && r.references === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail; then implement**

Run: `npx vitest run test/unit/inspect-references.test.ts` → FAIL.

`src/providers/types.ts`: `InspectRequest = { images: string[]; expected: string; references?: string[]; checkContent?: boolean }`.
`src/providers/gemini.ts` `inspectPrompt`: after the existing fault list (before the "Style, colour…" closing line) add
```ts
    ...(req.references?.length ? [`- an object, a pose or a person that was copied from a reference picture instead of drawn for this description (the last ${req.references.length} pictures are the references the generator was given, not its result)`] : []),
    ...(req.checkContent ? ["- unlawful, unsafe or infringing content: sexual content, graphic violence, a recognisable real person or a brand's mark shown without cause. For this fault set unsafe to true"] : []),
```
`INSPECT_SCHEMA.properties` gains `unsafe: { type: "boolean" }` (not in `required`). `GeminiLlm.inspect` sends `[...req.images, ...(req.references ?? [])]` as the image parts. `src/stages/inspect.ts`: `Verdict = z.object({ ok: z.boolean(), problems: z.array(z.string()).default([]), unsafe: z.boolean().default(false) })`; `inspect(ctx, images, expected, opts = {})` passes `...opts` into `llm.inspect!({ images, expected, ...opts })`, charges `inspectCost(ctx.prices, images.length + (opts.references?.length ?? 0))`, and every fallback verdict is `{ ok: true, problems: [], unsafe: false }`.
`src/stages/keyframes.ts`, at the end of the loop body replace the `if (remake >= …) break; … verdict` block with
```ts
      const flux3 = takesSeveralReferences(m.request.imageProfile);
      const last = remake >= (MAX_REMAKES.keyframes ?? 0);
      // a picture is always looked at for content where the model asks for it (phase 10 spec §6), even on the last try
      if (last && !flux3) break;
      const refs = flux3 ? referencesFor(m, i).map((p) => abs(ctx, p)) : [];
      const verdict = await inspect(ctx, [file], expectedOf(requireScript(m), i), { references: refs.length ? refs : undefined, checkContent: flux3 });
      if (verdict.unsafe) {
        if (last) {
          // an unsafe picture is not kept: not on disk, and not in the manifest
          await rm(file, { force: true });
          ctx.manifest.scenes[i].keyframe = undefined;
          throw new Error(`the picture for scene ${i + 1} was flagged as unsafe content and was not used; change the topic or the wording and make the video again`);
        }
      } else if (verdict.ok || last) break;
      ctx.log(`keyframe scene ${i + 1} is ${verdict.unsafe ? "flagged" : "malformed"} (${verdict.problems.join("; ")}): making it again`);
      await noteRemake(ctx, i, "keyframes", remake + 1);
```
(the `m` variable is already defined above in `run`; import `rm` from `node:fs/promises`; `abs`, `referencesFor` and `takesSeveralReferences` are imported by Task 6.) `prompt-version.ts` `.14` + changelog:
```markdown
- `2026-10-18.14` — the picture check also looks for what was copied from a reference and, for the FLUX 3 profile, for unlawful, unsafe or infringing content (phase 10 spec §6).
```
Add pins `"inspect:references": inspectPrompt({ images: ["a.png"], expected: "x", references: ["r.png"], checkContent: true })` and regenerate.

- [ ] **Step 3: Run to see them pass; commit**

Run: `npx vitest run test/unit test/stages test/pipeline test/eval && npm run typecheck`
Expected: PASS.
```bash
git add src test docs
git commit -m "feat: the picture check also looks for copying from a reference and, for FLUX 3, for unsafe content, and an unsafe picture is made again and never used

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The cuts comparison (free) and the repo's rules

**Files:**
- Create: `src/eval/look.ts`, `test/eval/look.test.ts`, `scripts/eval-cuts.ts`
- Modify: `package.json`, `CLAUDE.md`

**Interfaces:**
- Produces: `parseStats(log: string): Look`, `lookDistance(a, b): number`, `consistency(looks): number`, `keyframeLook(path): Promise<Look>`, `Look = [yAvg, uAvg, vAvg, satAvg, contrast]` normalised to 0..1.

- [ ] **Step 1: Write the failing tests**

`test/eval/look.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consistency, keyframeLook, lookDistance, parseStats } from "../../src/eval/look.js";
import { makeImage, tempDir } from "../helpers/media.js";

const LOG = [
  "lavfi.signalstats.YLOW=40", "lavfi.signalstats.YAVG=120", "lavfi.signalstats.YHIGH=200",
  "lavfi.signalstats.UAVG=110", "lavfi.signalstats.VAVG=140", "lavfi.signalstats.SATAVG=51",
].join("\n");

describe("the look of a picture", () => {
  it("is read from ffmpeg's statistics as brightness, two colour axes, saturation and contrast, each from 0 to 1", () => {
    const look = parseStats(LOG);
    expect(look[0]).toBeCloseTo(120 / 255, 5);
    expect(look[1]).toBeCloseTo(110 / 255, 5);
    expect(look[2]).toBeCloseTo(140 / 255, 5);
    expect(look[3]).toBeCloseTo(51 / 255, 5);
    expect(look[4]).toBeCloseTo((200 - 40) / 255, 5);
  });

  it("refuses a log without the statistics, instead of reading zeros", () => {
    expect(() => parseStats("nothing here")).toThrow(/statistics/);
  });

  it("is the same for the same picture and different for pictures of different colours", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    await makeImage(a, { width: 64, height: 64, color: "0x3366aa" });
    await makeImage(b, { width: 64, height: 64, color: "0xaa6633" });
    const [la, lb, la2] = [await keyframeLook(a), await keyframeLook(b), await keyframeLook(a)];
    expect(lookDistance(la, la2)).toBe(0);
    expect(lookDistance(la, lb)).toBeGreaterThan(0.05);
  });
});

describe("how alike a run's pictures look", () => {
  it("is the mean distance between neighbours, lower when they look alike, and 0 for fewer than two", () => {
    const a: [number, number, number, number, number] = [0.5, 0.4, 0.5, 0.2, 0.6];
    const b: [number, number, number, number, number] = [0.5, 0.4, 0.5, 0.2, 0.6];
    const c: [number, number, number, number, number] = [0.9, 0.2, 0.7, 0.5, 0.2];
    expect(consistency([a])).toBe(0);
    expect(consistency([a, b, a])).toBe(0);
    expect(consistency([a, c, a])).toBeGreaterThan(consistency([a, b, a]));
  });
});
```

- [ ] **Step 2: Run to see them fail; then implement**

Run: `npx vitest run test/eval/look.test.ts` → FAIL.

`src/eval/look.ts`:
```ts
import { ffmpeg } from "../media/ffmpeg.js";

/** brightness, two colour axes, saturation, contrast: each from 0 to 1 (ffmpeg's signalstats, phase 10 spec §7). */
export type Look = [number, number, number, number, number];

const value = (log: string, key: string): number => {
  const m = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(log);
  if (!m) throw new Error(`ffmpeg's statistics for ${key} are missing from its answer`);
  return Number(m[1]);
};

/** The look from the text ffmpeg's `signalstats,metadata=print` writes. */
export function parseStats(log: string): Look {
  const [yLow, yAvg, yHigh, uAvg, vAvg, sat] = ["YLOW", "YAVG", "YHIGH", "UAVG", "VAVG", "SATAVG"].map((k) => value(log, k));
  return [yAvg / 255, uAvg / 255, vAvg / 255, sat / 255, (yHigh - yLow) / 255];
}

export async function keyframeLook(path: string): Promise<Look> {
  const log = await ffmpeg(["-i", path, "-vf", "scale=64:64,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"], { logLevel: "info" });
  return parseStats(log);
}

/** Euclidean distance between two looks. */
export function lookDistance(a: Look, b: Look): number {
  return Math.sqrt(a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0));
}

/** The mean distance between neighbouring pictures: lower is a more alike run; 0 for fewer than two. */
export function consistency(looks: readonly Look[]): number {
  if (looks.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < looks.length; i++) total += lookDistance(looks[i - 1], looks[i]);
  return total / (looks.length - 1);
}
```
If `ffmpeg()` returns stderr text only when asked with `logLevel: "info"` (see how `frameDiff` in `test/helpers/media.ts` reads its numbers) keep that call shape; if the statistics appear on a different stream, follow `frameDiff`'s way of reading them and say so in the report.

`scripts/eval-cuts.ts`:
```ts
/**
 * npm run eval:cuts -- <runWithReferences> <runWithout> [--runs <dir>]
 *
 * FREE (phase 10 spec §7): compares two finished runs of the same script and seed, one made with FLOWCHAIN_CUT_REFERENCES=on
 * and one with off, by how alike their keyframes look and by how many keyframes were made again. It reads files and
 * calls ffmpeg; it calls no provider. The owner makes the two runs (that is the paid part) and decides from this.
 */
import { join } from "node:path";
import { consistency, keyframeLook } from "../src/eval/look.js";
import { loadManifest } from "../src/manifest/store.js";

async function summary(runs: string, id: string) {
  const dir = join(runs, id);
  const m = await loadManifest(dir);
  const files = m.scenes.flatMap((s) => (s.keyframe ? [join(dir, s.keyframe.path)] : []));
  const looks = await Promise.all(files.map(keyframeLook));
  const remade = m.scenes.reduce((n, s) => n + (s.remade?.keyframes?.count ?? 0), 0);
  return { id, keyframes: files.length, consistency: consistency(looks), remade, profile: m.request.imageProfile, cutReferences: m.request.cutReferences === true };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--runs");
  const runs = at >= 0 ? argv[at + 1] : (process.env.RUNS_DIR ?? "./runs");
  const ids = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--runs");
  if (ids.length !== 2) {
    console.error("usage: npm run eval:cuts -- <runWithReferences> <runWithout> [--runs <dir>]");
    process.exit(1);
  }
  const [withRefs, without] = await Promise.all(ids.map((id) => summary(runs, id)));
  if (!withRefs.cutReferences || without.cutReferences) {
    console.error(`the first run must have been made with cut references on and the second with them off (found: ${withRefs.cutReferences}, ${without.cutReferences})`);
    process.exit(1);
  }
  for (const r of [withRefs, without]) console.log(`${r.id}: ${r.keyframes} keyframes, look distance between neighbours ${r.consistency.toFixed(4)} (lower is more alike), ${r.remade} made again, profile ${r.profile}`);
  const better = withRefs.consistency < without.consistency;
  const cleaner = withRefs.remade <= without.remade;
  console.log(better && cleaner ? "References look better and no worse in faults: set FLOWCHAIN_CUT_REFERENCES=on." : "References did not clearly win: keep FLOWCHAIN_CUT_REFERENCES=off, or make more runs.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```
(Confirm `loadManifest`'s real signature with `grep -n "export async function loadManifest" src/manifest/store.ts` and `scripts/make-showcase.ts`; adapt the single call, not the logic.)
`package.json` scripts, after `"eval:prompts"`: `"eval:cuts": "tsx scripts/eval-cuts.ts",`.
`CLAUDE.md`:
- Commands block: `npm run eval:cuts -- <runWith> <runWithout>   # free: compares two finished runs (cut references on / off) by look consistency`.
- "How the pipeline is built": a bullet — "**The picture model is chosen per run** (`request.imageProfile`): `runpod-flux3-klein@1` only while `RUNPOD_PICTURE3_ENDPOINT` and the four `runpodPicture3*` prices are set; `FLOWCHAIN_IMAGE_MODEL=klein4b` forces the Apache 2.0 4B (the fallback if BFL ends the license, phase 10 spec §1). A run keeps its profile. Its license is the FLUX Kommunity License v.1.0: revenue under US$5M, Outputs only; do not train on its pictures."
- "Where the reasons are" row: `| FLUX 3 klein as the picture model; reframe cuts and the shared look | 2026-10-18-phase10-flux3-reframe-design.md |`.
- "Rules that are never broken": add `fetch-models` for the FLUX 3 endpoint is part of `runpod:deploy` (already listed), and the owner's Hugging Face token is only ever passed through the shell.

- [ ] **Step 3: Run to see them pass; commit**

Run: `npx vitest run test/eval && npm run typecheck`
Expected: PASS. Run `npx tsx scripts/eval-cuts.ts` with no arguments: it prints the usage line and exits 1.
```bash
git add src/eval scripts/eval-cuts.ts test/eval package.json CLAUDE.md
git commit -m "feat: npm run eval:cuts compares two finished runs by how alike their keyframes look and how many were made again, for free, and CLAUDE.md records the picture model rules

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The owner's steps (not an agent's)

**Files:** none changed by an agent.

- [ ] **Step 1: The owner prepares access.** Accept the model's terms on Hugging Face (`black-forest-labs/flux-3-image-klein`), create a read token, and read `LICENSE.md` of the repository. Optionally email BFL (https://bfl.ai/licensing) to confirm in writing that a Qualifying User may run the model to generate Outputs for customers.

- [ ] **Step 2: The owner deploys.** With a card list naming 32 GB-class cards available in the volume's data centre:
```bash
RUNPOD_PICTURE3_GPUS="<card name>,<card name>" HF_TOKEN=<token> npm run runpod:deploy
```
This builds nothing: the image tag comes from the tree hash, so the worker image must be pushed first (the repo's existing flow for `worker-picture/`; the Dockerfile's build-time check fails the build if `ModularPipeline` is missing). The command prints its plan and asks to proceed.

- [ ] **Step 3: The owner measures and prices.** Run one real video with `FLOWCHAIN_IMAGE_MODEL=flux3` temporarily set (the profile is not offered until the prices exist, so first put provisional values in `prices.json` that are certainly above the real ones), read the seconds each picture, portrait and cold start took from the run's ledger, and then set `runpodPicture3UsdPerSec`, `runpodPicture3Sec`, `runpodPortrait3Sec`, `runpodPicture3ColdStartSec` to the measured numbers.

- [ ] **Step 4: The owner compares.** Make the same script and seed twice, once with `FLOWCHAIN_CUT_REFERENCES=off` and once with `on`, then `npm run eval:cuts -- <runOn> <runOff>`. If it says to, set `FLOWCHAIN_CUT_REFERENCES=on` in `.env`.

- [ ] **Step 5: Anything unexpected** (an error from the model call shape, an unsafe-content false positive, copying visible in the pictures) is written into the spec as a section on what was found, or fixed in a new task. It is never dropped.
