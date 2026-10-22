# Phase 11 — Smooth motion (60 fps as a paid per-run choice): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo subagents are dispatched only when the owner asks for them.

**Goal:** A run can be made for 60 fps: its clips are interpolated by the restorer worker (RIFE, inside the same job as the Full HD upscale when both are asked for), fitted to 60 and rendered at 60, as a paid choice priced from measured GPU seconds. The default stays at today's 30 fps.

**Architecture:** One frozen request field `fps: 60`, read through `fpsOf(request)` where the constant `FPS` is read today. The restorer worker (`worker-upscale/`) gets a new workflow `restore-video@1` (optional `short`, optional `interpolate: 2`, at least one) beside the unchanged `upscale-seedvr2@1`. The `upscale` stage sends `interpolate: 2` in its own job for a 60 fps Full HD run; a new paid `interpolate` stage handles 60 fps without Full HD; `fit` plays upscaled, else smoothed, else the raw clip.

**Tech Stack:** TypeScript (ESM, `.js` suffixes in `src/`, `scripts/`, `test/`; `@/…` in `web/`), zod, vitest, Python (`worker-upscale/`, `pytest` via `npm run test:worker`), ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-22-phase11-smooth-motion-design.md` (read first; §3.1 and §11, written by Task 1, win over earlier sections).

## Global Constraints

- **Never run** `npm run runpod:deploy`, `fetch-models`, `smoke*`, `npm run eval:prompts`, or anything that calls RunPod, Gemini or Hugging Face. Never download model weights. Tests never need any of them. (CLAUDE.md, "Rules that are never broken".)
- **Never read or print `.env`.** **Never commit** `.env`, `deploy/server.env`, `eval-out/`, `.superpowers/`, model weights.
- `test/unit/compat.test.ts` is never edited and must stay green. **A 30 fps run, and every run made before this phase, keeps exactly the cache keys, requests, prompts and schemas it had**: every new key, field and flag is added only for a run that asks for 60 fps, and a test per task pins it.
- New manifest fields are optional. `RunRequest.fps` is `z.literal(60).optional()`: 60 or absent, never 30.
- **No invented prices:** the four `runpodInterpolate*` / `runpodRestoreExtra*` rates have no defaults; a 60 fps run is refused, plainly, until all four are set in `prices.json`.
- **A customer is shown credits, never dollars**; no customer-facing surface names a model or provider (`INTERNAL_NAMES` in `web/lib/engines.ts`, held by `web/test/names.test.ts`).
- No Gemini prompt changes in this phase, so `PROMPT_VERSION` and the pins stay as they are (Task 7's form copy is not a model prompt).
- A `fit` over a 60 fps run, the chained-clip key and the seam frame read the run's frame rate from `ctx.fps`, never from the constant `FPS`.
- Count and split words only through `src/voice/words.ts`.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` + one sentence saying what is now true, then a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit on `main`; **never push**.
- Tests are named as sentences about behaviour; a test for a fix must be shown to fail without the fix.
- Run `npm run typecheck` before each commit; Python changes also run `npm run test:worker` (or `workers/.venv/bin/python -m pytest -q worker-upscale/tests`). Do not run `test/media` (a real-Chrome Remotion test there is a known load flake that takes 137 s alone; run it alone if a change touches rendering).

## File Structure

| Path | Responsibility |
|---|---|
| `src/config.ts` (modify) | `fpsOf`, four optional rates in `Prices`, `restoreRates()`, env `FLOWCHAIN_SMOOTH_MOTION` |
| `src/manifest/schema.ts` (modify) | `RunRequest.fps`, `StageName` + `"interpolate"`, `SceneState.smoothed` |
| `worker-upscale/…` (modify; `weights_rife.py` new) | `restore-video@1` contract, RIFE engine step, weights, Dockerfile |
| `src/providers/types.ts`, `runpod-providers.ts`, `factory.ts`, `model-id.ts`, `new-run.ts` (modify) | request shape, the restorer's own rate, workflow id, `newRunRestore` |
| `test/fakes/providers.ts` (modify) | the fake restorer handles `short` and `interpolate` |
| `src/stages/interpolate.ts` (new), `source.ts` (new) | the stage; which clip file a scene plays |
| `src/stages/upscale.ts`, `fit.ts`, `paths.ts`, `require.ts`, `index.ts` (modify) | wiring |
| `src/reroll.ts`, `src/versions.ts`, `src/studio/status.ts`, `web/lib/labels.ts` (modify) | reroll, inheritance, status, words |
| `src/cli.ts`, `web/server/{schemas,actions,config,runs}.ts`, `web/server/jobs/redis.ts`, `web/components/NewVideoForm.tsx`, `web/lib/engines.ts` (modify) | the choice end to end |
| `README.md`, `.env.example`, `CLAUDE.md` (modify) | the owner's manual and rules |

---

### Task 1: Gate — RIFE's real interface, written into the spec

If it cannot be established, this task stops the plan.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-22-phase11-smooth-motion-design.md` (add §3.1 and §11)

**Interfaces:** Produces spec §3.1 with: the RIFE implementation and its pinned commit; its licence; the command line to interpolate one video by a multiplier of 2 (verbatim); whether it supports an exact target frame rate (so 32 can go to 60 without the 64-to-60 thinning) and how; the weights to bake (file names, sizes, SHA-256, source URL pinned by revision); the dependencies it needs beyond what `worker-upscale` already installs (torch, torchvision, ffmpeg, git are there); GPU memory for 1080p; and whether it reads or writes audio. Produces §11, the deviations of this plan from the spec.

- [ ] **Step 1: Read the implementation**

Use WebFetch on `https://github.com/hzwer/Practical-RIFE` (README, the `inference_video.py` usage, `requirements.txt`, the LICENSE, the release notes naming the newest weights). Copy verbatim: the command to interpolate a video (`--video`, `--multi`, `--fps`, `--output`, `--model`, and any flag for fp16 or for scaling), the licence name, the commit hash of the default branch head, and the weights' download link and name. Do not paraphrase code or flags.

- [ ] **Step 2: Read the weights' hashes**

The weights are a zip or `.pkl`/`.py` set distributed through a link in the README (often Google Drive or a Hugging Face mirror). Find a source that can be pinned by revision and whose file sizes and SHA-256 are readable without a login or token: a Hugging Face model repository's Hub API (`https://huggingface.co/api/models/<repo>?blobs=true`, `lfs.sha256`) or the GitHub release asset's digest. If the only link is a Google Drive file with no checksum, record that in §3.1 and stop with status NEEDS_CONTEXT: the owner supplies the file's SHA-256. Also record which weights the clip worker already bakes (`workers/Dockerfile`, RIFE 4.9, 21 MB, MIT) — the restorer may use the same weights file if the implementation accepts it; say which is simplest and why.

- [ ] **Step 3: Answer the exact-rate question**

From the code (`inference_video.py`), say whether a target `--fps` produces frames at the requested rate by interpolating at fractional time steps, or only changes the container's rate. Quote the lines that decide it. If it supports an exact rate, record the command to take a 32 fps clip to 60 fps exactly; the plan's worker will then use `interpolate: 2` (fixed multiplier, 64 fps) and the exact-rate mode is recorded as a possible later change, not built.

- [ ] **Step 3b: Memory and speed**

Record from the README / issues what GPU memory 1080p needs and any tiling or `--scale` flag that lowers it; the worker's card is 24 GB (`DEFAULTS.upscaleGpus` in `src/deploy/runpod.ts`).

- [ ] **Step 4: Write §3.1 and §11 into the spec**

After §3, add `### 3.1 What RIFE's pages say (read on <date> by task 1)` containing a table and the verbatim command; every `<…>` filled with the real value. At the end of the spec add:

```markdown
## 11. What the plan found and changed (a later section wins)

- **The form's control is gated by an owner switch, not by prices.** The web server never reads `prices.json` (it is the CLI's), so `health.smooth` is `RUNPOD_UPSCALE_ENDPOINT` set **and** `FLOWCHAIN_SMOOTH_MOTION=on` (default off, set by the owner after the rates are measured), like `FLOWCHAIN_CUT_REFERENCES`. The CLI still refuses a 60 fps run without the four rates, in `newRunRestore`, and `createProviders` refuses it too, so a mis-set switch fails plainly and early.
- **One GPU rate for the restorer's new workflow.** `restore-video@1` jobs, with or without Full HD, are charged at `runpodInterpolateUsdPerSec`; the old `upscale-seedvr2@1` workflow keeps `upscaleUsdPerSec`. A Full HD run that does not ask for 60 fps keeps the old workflow, so its jobs and keys are unchanged.
- **The fake restorer** stands in for both steps; its interpolation doubles the frame rate with ffmpeg's `fps=` filter (frames repeated, which is enough to test the pipeline).
```
Add any further deviation the pages force. No placeholder may remain.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-22-phase11-smooth-motion-design.md
git commit -m "docs: RIFE's pinned version, command, weights and exact-rate mode are written down from its pages, and the plan's changes to the spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
If no RIFE implementation can be pinned with a verifiable weights hash, commit what you have, do not continue, and report BLOCKED or NEEDS_CONTEXT with the finding.

---

### Task 2: The frame rate of a run: the field, the helper, the three places that read it

**Files:**
- Modify: `src/manifest/schema.ts` (`RunRequest`), `src/config.ts`, `src/cli.ts` (`contextFor`, ~line 110), `web/server/runs.ts` (~line 137), `scripts/make-showcase.ts`
- Test: `test/unit/fps.test.ts`

**Interfaces:** Produces `fpsOf(request: { fps?: 60 }): number` in `src/config.ts`; `RunRequest.fps?: 60`.

- [ ] **Step 1: Write the failing tests**

`test/unit/fps.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FPS, fpsOf } from "../../src/config.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { createManifest } from "../../src/manifest/store.js";

describe("the frame rate of a run", () => {
  it("is the pipeline's 30 unless the run was made for 60", () => {
    expect(fpsOf({})).toBe(FPS);
    expect(FPS).toBe(30);
    expect(fpsOf({ fps: 60 })).toBe(60);
  });

  it("is a choice of 60 or nothing: a request never names 30 or any other rate", () => {
    const fps = RunRequest.shape.fps;
    expect(fps.safeParse(60).success).toBe(true);
    expect(fps.safeParse(undefined).success).toBe(true);
    for (const bad of [30, 24, 59, 120, "60", true]) expect(fps.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("is not in the request of a run that did not ask for it, so its saved manifest is what it was", () => {
    const m = createManifest("r", { topic: "foxes", aspect: "9:16", sceneCount: 2, voiceId: "v" }, { llm: "l", tts: "t", image: "i", video: "v" });
    expect(Object.keys(m.request)).not.toContain("fps");
    expect(JSON.stringify(m.request)).not.toContain("fps");
  });
});
```
(`createManifest`'s signature and the minimal request are used the same way in `test/unit/compat.test.ts`; adapt the literal if a required field is missing.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/unit/fps.test.ts`
Expected: FAIL (`fpsOf` is not exported; `RunRequest.shape.fps` is undefined).

- [ ] **Step 3: Implement**

`src/manifest/schema.ts`, in `RunRequest` next to `upscale`:
```ts
  /** Smooth motion (--fps 60, phase 11 spec §2): the run is made and rendered at 60 frames a second. Frozen; absent = 30. */
  fps: z.literal(60).optional(),
```
`src/config.ts`, after `FPS`:
```ts
/** The frame rate a run is fitted and rendered at: the pipeline's 30, or the 60 the run was made for (phase 11 spec §2). */
export const fpsOf = (request: { fps?: 60 }): number => request.fps ?? FPS;
```
`src/cli.ts`: in `contextFor` replace `fps: FPS,` with `fps: fpsOf(manifest.request),` and import `fpsOf` (keep the `FPS` import only if still used). `web/server/runs.ts`: replace `fps: FPS` with `fps: fpsOf(m.request)` (import `fpsOf` from `@src/config`, drop an unused `FPS`). `scripts/make-showcase.ts`: at the top of its main function after the manifest is loaded add `const fps = fpsOf(manifest.request);` and use `fps` instead of `FPS` on every line that converts frames to seconds or builds the context (lines ~43, 76, 78, 87).

- [ ] **Step 4: Run to see them pass; nothing else moved**

Run: `npx vitest run test/unit/fps.test.ts test/unit/compat.test.ts test/unit/showcase.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src scripts web/server/runs.ts test/unit/fps.test.ts
git commit -m "feat: a run's frame rate is a frozen choice of 60 or nothing, read through one helper where the constant was read

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The restorer worker: the `restore-video@1` contract, the RIFE step, its weights

Uses the facts Task 1 wrote in spec §3.1. Python; tests run with the engine stubbed (no GPU, no download).

**Files:**
- Modify: `worker-upscale/src/flowchain_upscale/contract.py`, `engine.py`, `worker-upscale/handler.py`, `worker-upscale/Dockerfile`, `worker-upscale/requirements.txt` (only if §3.1 says RIFE needs more)
- Create: `worker-upscale/src/flowchain_upscale/weights_rife.py`
- Test: `worker-upscale/tests/test_restore.py`

**Interfaces:**
- Produces: `contract.WORKFLOW_RESTORE = "restore-video@1"`, `contract.MULTIPLIERS = (2,)`; `contract.validate(inp)` returns for the new workflow `{"task", "video": bytes, "short": int | None, "interpolate": int | None}` and, for the old one, exactly what it returned before; `engine.steps(req) -> list[str]` (`["upscale"]`, `["interpolate"]` or `["upscale", "interpolate"]`); `engine.rife_command(src, out, multiplier, ...) -> list[str]`; `engine.interpolate(src, out, multiplier, run=subprocess.run)`; `weights_rife.present()`.

- [ ] **Step 1: Write the failing tests**

`worker-upscale/tests/test_restore.py`:
```python
import base64
import os
import sys
import types

import pytest

from flowchain_upscale import contract, engine, weights_rife

CLIP = base64.b64encode(b"mp4-bytes").decode()
OLD = {"task": "upscale", "workflow": "upscale-seedvr2@1", "video": CLIP, "short": 1080}
NEW = {"task": "upscale", "workflow": "restore-video@1", "video": CLIP, "short": 1080, "interpolate": 2}


def test_the_old_workflow_is_exactly_what_it_was():
    assert contract.validate(OLD) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080}
    with pytest.raises(contract.ContractError, match="unknown field"):
        contract.validate({**OLD, "interpolate": 2})
    with pytest.raises(contract.ContractError, match="short must be"):
        contract.validate({k: v for k, v in OLD.items() if k != "short"})


def test_the_new_workflow_takes_either_step_or_both():
    assert contract.validate(NEW) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080, "interpolate": 2}
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    assert contract.validate(only_up) == {"task": "upscale", "video": b"mp4-bytes", "short": 1080, "interpolate": None}
    only_rife = {k: v for k, v in NEW.items() if k != "short"}
    assert contract.validate(only_rife) == {"task": "upscale", "video": b"mp4-bytes", "short": None, "interpolate": 2}


@pytest.mark.parametrize(
    "change, why",
    [
        ({"short": None, "interpolate": None}, "at least one"),
        ({"interpolate": 3}, "interpolate must be"),
        ({"interpolate": True}, "interpolate must be"),
        ({"interpolate": "2"}, "interpolate must be"),
        ({"short": 2160}, "short must be"),
        ({"video": ""}, "between 1 byte"),
        ({"prompt": "x"}, "unknown field"),
        ({"workflow": "restore-video@2"}, "runs workflow"),
    ],
)
def test_refuses_what_is_not_the_new_contract(change, why):
    inp = {**NEW, **change}
    inp = {k: v for k, v in inp.items() if v is not None}
    with pytest.raises(contract.ContractError, match=why):
        contract.validate(inp)


def test_runs_the_steps_in_the_order_that_keeps_one_file_on_the_disk():
    assert engine.steps({"short": 1080, "interpolate": 2}) == ["upscale", "interpolate"]
    assert engine.steps({"short": 1080, "interpolate": None}) == ["upscale"]
    assert engine.steps({"short": None, "interpolate": 2}) == ["interpolate"]
    # a request of the old workflow has no interpolate key at all
    assert engine.steps({"short": 1080}) == ["upscale"]


def test_builds_the_interpolation_command_the_pages_show():
    cmd = engine.rife_command("/tmp/a.mp4", "/tmp/b.mp4", 2)
    joined = " ".join(cmd)
    # the exact flags are those recorded in spec §3.1; this pins that the multiplier, input and output are on the line
    assert "/tmp/a.mp4" in joined and "/tmp/b.mp4" in joined
    assert "2" in cmd
    assert cmd[0] == "python"


def test_says_why_when_the_interpolation_fails():
    class Done:
        returncode = 1
        stderr = "CUDA out of memory"
        stdout = ""

    with pytest.raises(RuntimeError, match="CUDA out of memory"):
        engine.interpolate("a", "b", 2, run=lambda *a, **k: Done())


def test_the_rife_weights_are_present_only_at_their_sizes(tmp_path):
    assert not weights_rife.present(str(tmp_path))
    for name, (size, _) in weights_rife.FILES.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            f.truncate(size)
    assert weights_rife.present(str(tmp_path))


def test_the_image_downloads_and_checks_exactly_these_rife_files():
    with open(__file__.rsplit("/tests/", 1)[0] + "/Dockerfile") as f:
        docker = f.read()
    assert weights_rife.COMMIT in docker
    for name, (_, digest) in weights_rife.FILES.items():
        assert digest in docker, name
```
Append to the same file (the handler fixture follows `worker-picture/tests/test_flux3.py`'s `worker` fixture; it also needs `from flowchain_upscale import storage`):
```python
from flowchain_upscale import storage

R2_ENV = {"R2_ACCOUNT_ID": "acc", "R2_BUCKET": "bkt", "R2_ACCESS_KEY_ID": "id", "R2_SECRET_ACCESS_KEY": "secret"}


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """handler.py with both engines, both sets of weights and R2 replaced by fakes, its scratch folder under tmp_path."""
    monkeypatch.setitem(sys.modules, "runpod", types.SimpleNamespace(serverless=types.SimpleNamespace(start=None)))
    import importlib.util

    spec = importlib.util.spec_from_file_location("upscale_handler_restore", os.path.join(os.path.dirname(__file__), "..", "handler.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(h, "TMP_DIR", str(tmp_path / "tmp"))
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    h.calls = []
    h.uploads = []
    h.fail = None

    def upscale(src, out, short, model_dir, dit):
        h.calls.append(("upscale", os.path.basename(src), os.path.basename(out), short))
        with open(out, "wb") as f:
            f.write(b"hd")

    def interpolate(src, out, multiplier):
        h.calls.append(("interpolate", os.path.basename(src), os.path.basename(out), multiplier))
        if h.fail:
            raise RuntimeError(h.fail)
        with open(out, "wb") as f:
            f.write(b"smooth")

    def upload(path, key, kind):
        h.uploads.append(open(path, "rb").read())
        return f"https://r2.example/{key}"

    monkeypatch.setattr(engine, "upscale", upscale)
    monkeypatch.setattr(engine, "interpolate", interpolate)
    monkeypatch.setattr(weights, "present", lambda *a: True)
    monkeypatch.setattr(weights_rife, "present", lambda *a: True)
    monkeypatch.setattr(storage, "upload", upload)
    h.tmp = tmp_path / "tmp"
    return h


def test_does_both_steps_on_the_workers_own_disk_and_uploads_one_file(worker):
    out = worker.handler({"id": "j1", "input": NEW})
    assert worker.calls == [("upscale", "j1-in.mp4", "j1-mid.mp4", 1080), ("interpolate", "j1-mid.mp4", "j1.mp4", 2)]
    assert worker.uploads == [b"smooth"]
    assert out["url"] == "https://r2.example/flowchain/j1.mp4"
    assert list(worker.tmp.iterdir()) == []


def test_does_only_the_step_asked_for(worker):
    only_rife = {k: v for k, v in NEW.items() if k != "short"}
    worker.handler({"id": "j2", "input": only_rife})
    assert worker.calls == [("interpolate", "j2-in.mp4", "j2.mp4", 2)]
    worker.calls.clear()
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    worker.handler({"id": "j3", "input": only_up})
    assert worker.calls == [("upscale", "j3-in.mp4", "j3.mp4", 1080)]


def test_an_old_workflow_request_only_ever_upscales(worker):
    worker.handler({"id": "j4", "input": OLD})
    assert worker.calls == [("upscale", "j4-in.mp4", "j4.mp4", 1080)]
    assert worker.uploads == [b"hd"]


def test_leaves_no_file_behind_when_the_interpolation_fails(worker):
    worker.fail = "boom"
    with pytest.raises(RuntimeError, match="boom"):
        worker.handler({"id": "j5", "input": NEW})
    assert list(worker.tmp.iterdir()) == []
    assert worker.uploads == []


def test_asks_for_rifes_files_only_when_it_will_use_them(worker, monkeypatch):
    monkeypatch.setattr(weights_rife, "present", lambda *a: False)
    assert "error" in worker.handler({"id": "j6", "input": NEW})
    only_up = {k: v for k, v in NEW.items() if k != "interpolate"}
    assert "url" in worker.handler({"id": "j7", "input": only_up})
```

- [ ] **Step 2: Run to see them fail**

Run: `workers/.venv/bin/python -m pytest -q worker-upscale/tests/test_restore.py`
Expected: FAIL (`weights_rife` and the new contract do not exist).

- [ ] **Step 3: Implement the contract**

`contract.py`: keep `WORKFLOW`, `MAX_VIDEO_BYTES`, `SHORT_SIDES`; add
```python
WORKFLOW_RESTORE = "restore-video@1"
# the multipliers a clip may be interpolated by: twice the frames is the one the studio sells (32 fps in, 64 out)
MULTIPLIERS = (2,)
```
Factor the video check into `_video(inp)` returning the bytes (same messages as now), then in `validate` after the `task` check:
```python
    workflow = inp.get("workflow")
    if workflow not in (WORKFLOW, WORKFLOW_RESTORE):
        raise ContractError(f"this worker runs workflow {WORKFLOW} or {WORKFLOW_RESTORE} for task upscale")
```
Hmm — the OLD test expects `match="runs workflow upscale-seedvr2@1"` for `upscale-seedvr2@2`. Keep that exact message for any workflow that is neither, i.e. `f"this worker runs workflow {WORKFLOW} for task upscale"` must still be a substring: use `f"this worker runs workflow {WORKFLOW} for task upscale (or {WORKFLOW_RESTORE})"`. For the old workflow: allowed fields `{"task","workflow","video","short"}`, `short` required, return `{"task","video","short"}` (no `interpolate` key). For the new: allowed `{"task","workflow","video","short","interpolate"}`; `short` optional (when present must be in `SHORT_SIDES` and not bool); `interpolate` optional (when present must be exactly `2`, not bool, an int: `interpolate must be 2`); at least one of them else `"at least one of short and interpolate is required"`; return `{"task","video","short": short-or-None,"interpolate": value-or-None}`. Adjust the test's `match` strings to the messages you write ("at least one", "interpolate must be", "short must be").

- [ ] **Step 4: Implement the engine and the weights**

`engine.py`: add (the command line and flags are exactly those recorded in spec §3.1; `RIFE_CLI` and the model folder are constants from `weights_rife`):
```python
from flowchain_upscale import weights_rife


def steps(req):
    """The steps a request asks for, in the order that keeps one file on the worker's disk: upscale, then interpolate."""
    out = []
    if req.get("short") is not None:
        out.append("upscale")
    if req.get("interpolate") is not None:
        out.append("interpolate")
    return out


def rife_command(src, out, multiplier, python="python"):
    """The command line for one clip (pure, so it is tested without a GPU)."""
    return [python, weights_rife.CLI, "--video", src, "--output", out, "--multi", str(multiplier)]  # flags from spec §3.1


def interpolate(src, out, multiplier, run=subprocess.run):
    """Runs it and raises with the end of its output when it fails; nothing is retried here."""
    done = run(rife_command(src, out, multiplier), capture_output=True, text=True)
    if done.returncode != 0:
        tail = (done.stderr or done.stdout or "")[-1500:]
        raise RuntimeError(f"RIFE failed ({done.returncode}): {tail}")
```
Replace the placeholder flags with §3.1's real ones (and add the model-folder flag, the half-precision flag and a `--scale` if §3.1 says 1080p needs it). `weights_rife.py`:
```python
"""RIFE's code and weights, baked into the image (phase 11 spec §3.1), checked by SHA-256 when the image is built."""

import os

COMMIT = "<the pinned commit from spec §3.1>"
CLI = "/rife/inference_video.py"
FOLDER = "/rife/train_log"
# what each must be (size, SHA-256), from spec §3.1
FILES = {<each weights file>: (<size>, "<sha256>")}


def present(folder=FOLDER):
    """Every file is there at its size (its hash was checked when the image was built)."""
    return all(os.path.exists(os.path.join(folder, name)) and os.path.getsize(os.path.join(folder, name)) == size for name, (size, _) in FILES.items())
```
Every `<…>` is filled from §3.1; none may remain. `Dockerfile`: after the SeedVR2 block add (adapt to §3.1)
```dockerfile
# RIFE's program, pinned by commit (MIT), and its weights, checked before the image can be pushed (phase 11 spec §3.1)
ARG RIFE_COMMIT=<commit>
RUN git clone https://github.com/hzwer/Practical-RIFE /rife && git -C /rife checkout ${RIFE_COMMIT} \
 && pip install --no-cache-dir -r /rife/requirements.txt \
 && mkdir -p /rife/train_log \
 && curl -fL --retry 5 --retry-all-errors -o /rife/train_log/<file> <pinned url> \
 && echo "<sha256>  /rife/train_log/<file>" | sha256sum -c -
```
and extend the final check line to `test -f /seedvr2/inference_cli.py && test -f /rife/inference_video.py && python -c "… assert weights.present(); from flowchain_upscale import weights_rife; assert weights_rife.present()"`. If `requirements.txt` of RIFE conflicts with the SeedVR2 pins (numpy, opencv), install it with `--no-deps` for the packages already present and say so in the report.

- [ ] **Step 5: Wire the handler**

`handler.py` — run the steps on distinct temp files so the upscaled file is the interpolation's input and every file is removed:
```python
    job_id = job["id"]
    src = os.path.join(TMP_DIR, f"{job_id}-in.mp4")
    mid = os.path.join(TMP_DIR, f"{job_id}-mid.mp4")
    out = os.path.join(TMP_DIR, f"{job_id}.mp4")
    try:
        with open(src, "wb") as f:
            f.write(req["video"])
        todo = engine.steps(req)
        current = src
        for k, step in enumerate(todo):
            target = out if k == len(todo) - 1 else mid
            if step == "upscale":
                engine.upscale(current, target, req["short"], weights.FOLDER, weights.DIT)
            else:
                engine.interpolate(current, target, req["interpolate"])
            current = target
        url = storage.upload(out, f"flowchain/{job_id}.mp4", "video/mp4")
    finally:
        for path in (src, mid, out):
            _remove(path)
```
Also change the model-presence check so a request that interpolates only does not require SeedVR2's files, and one that upscales does not require RIFE's: `if "upscale" in todo and not weights.present(): …; if "interpolate" in todo and not weights_rife.present(): …` (compute `todo` before the presence checks). Keep every existing error message.

- [ ] **Step 6: Run to see them pass**

Run: `npm run test:worker` (the whole suite: `workers/`, `worker-voice/`, `worker-picture/` and `worker-upscale/` must stay green; the old `test_upscale.py` unedited)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker-upscale
git commit -m "feat: the restorer worker interpolates a clip with RIFE after upscaling it, in the same job, under a new workflow that leaves the old one exactly as it was

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The provider, the restorer's own rate, the workflow id, and the fake

**Files:**
- Modify: `src/config.ts` (`Prices`, `restoreRates`), `src/providers/types.ts`, `src/providers/runpod-providers.ts` (`RunpodUpscale`), `src/providers/factory.ts`, `src/providers/model-id.ts`, `src/providers/new-run.ts`, `test/fakes/providers.ts` (`FakeUpscale`)
- Test: `test/unit/restore-provider.test.ts`

**Interfaces:**
- Produces: `UpscaleRequest = { videoPath: string; short?: number; interpolate?: 2 }`; `restoreRates(p: Prices): RestoreRates | null` with `RestoreRates = { usdPerSec: number; interpolateSecPerClipSec: number; coldStartSec: number; extraSecPerClipSec: number }`; `RUNPOD_WORKFLOWS.restore = { workflow: "restore-video", version: 1 }`; `newRunRestore(env: Env, prices: Prices, fullHd: boolean): string` (the model id a 60 fps run freezes into `models.upscale`).

- [ ] **Step 1: Write the failing tests**

`test/unit/restore-provider.test.ts`:
```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, Prices, restoreRates, runpodRates } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "../../src/providers/model-id.js";
import { newRunRestore } from "../../src/providers/new-run.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { RunpodUpscale, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { tempDir } from "../helpers/media.js";

const rates = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };
const env = loadEnv({
  GEMINI_API_KEY: "g", RUNPOD_API_KEY: "rk", RUNPOD_CLIP_ENDPOINT: "cl1", RUNPOD_KEYFRAME_ENDPOINT: "kf1", RUNPOD_UPSCALE_ENDPOINT: "up1",
  R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
});

afterEach(() => vi.unstubAllGlobals());

function deps(api: FakeRunpodApi): RunpodDeps {
  let t = 0;
  return { client: new RunpodClient("k", { fetch: api.fetch }), r2: {} as unknown as R2, rates: runpodRates(Prices.parse({})), poll: { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t } };
}

describe("the smooth-motion rates", () => {
  it("cannot be priced until all four are in the price table", () => {
    expect(restoreRates(Prices.parse({}))).toBeNull();
    expect(restoreRates(Prices.parse({ ...rates, runpodRestoreExtraSecPerClipSec: undefined }))).toBeNull();
    expect(restoreRates(Prices.parse(rates))).toEqual({ usdPerSec: 0.0009, interpolateSecPerClipSec: 6, coldStartSec: 20, extraSecPerClipSec: 8 });
  });

  it("refuses zero and negative rates", () => {
    expect(() => Prices.parse({ ...rates, runpodInterpolateUsdPerSec: 0 })).toThrow();
    expect(() => Prices.parse({ ...rates, runpodRestoreExtraSecPerClipSec: -1 })).toThrow();
  });
});

describe("the model a 60 fps run freezes", () => {
  it("is the restorer's new workflow on the restorer endpoint, whether or not the run is Full HD", () => {
    const p = Prices.parse(rates);
    expect(newRunRestore(env, p, false)).toBe("runpod:up1/restore-video@1");
    expect(newRunRestore(env, p, true)).toBe("runpod:up1/restore-video@1");
    expect(RUNPOD_WORKFLOWS.restore).toEqual({ workflow: "restore-video", version: 1 });
  });

  it("refuses plainly while the rates or the endpoint are missing", () => {
    expect(() => newRunRestore(env, Prices.parse({}), false)).toThrow(/smooth motion is not set up/);
    expect(() => newRunRestore(loadEnv({ GEMINI_API_KEY: "k" }), Prices.parse(rates), false)).toThrow(/RUNPOD_UPSCALE_ENDPOINT/);
  });
});

describe("the request the restorer is sent", () => {
  it("carries only the steps asked for, and the old request is exactly what it was", async () => {
    const dir = await tempDir();
    const clip = join(dir, "clip.mp4");
    await writeFile(clip, Buffer.from("mp4-bytes"));
    const video = Buffer.from("mp4-bytes").toString("base64");
    const restore = new RunpodUpscale(deps(new FakeRunpodApi(() => [])), { endpointId: "up1", workflow: "restore-video", version: 1 });
    expect((await restore.prepare({ videoPath: clip, short: 1080 })).input).toEqual({ task: "upscale", video, short: 1080, workflow: "restore-video@1" });
    expect((await restore.prepare({ videoPath: clip, interpolate: 2 })).input).toEqual({ task: "upscale", video, interpolate: 2, workflow: "restore-video@1" });
    expect((await restore.prepare({ videoPath: clip, short: 1080, interpolate: 2 })).input).toEqual({ task: "upscale", video, short: 1080, interpolate: 2, workflow: "restore-video@1" });
    const old = new RunpodUpscale(deps(new FakeRunpodApi(() => [])), { endpointId: "up1", workflow: "upscale-seedvr2", version: 1 });
    expect((await old.prepare({ videoPath: clip, short: 1080 })).input).toEqual({ task: "upscale", video, short: 1080, workflow: "upscale-seedvr2@1" });
  });
});

const modelsFor = (upscale: string) => ({ llm: "l", tts: "t", image: runpodModelId("ep-k", "keyframe-klein", 1), video: runpodModelId("ep-c", "clip-wan22-480p", 1), upscale });

async function charged(upscale: string, prices: Prices) {
  const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/k.mp4" }, executionTime: 20_000 }]);
  vi.stubGlobal("fetch", api.fetch);
  const p = createProviders(env, modelsFor(upscale), prices);
  const id = await p.upscale!.submit({ input: {} }, { signal: new AbortController().signal });
  return p.upscale!.wait(id, { timeoutMs: 60_000 });
}

describe("what a restorer job is charged", () => {
  it("is the restorer's own rate for the new workflow", async () => {
    const out = await charged(runpodModelId("up1", "restore-video", 1), Prices.parse(rates));
    expect(out.costUsd).toBe(0.018); // 20 s x $0.0009/s
  });

  it("is still the old Full HD rate for the old workflow, whether or not the smooth-motion rates are set", async () => {
    expect((await charged(runpodModelId("up1", "upscale-seedvr2", 1), Prices.parse(rates))).costUsd).toBe(0.0061); // 20 s x $0.000306/s = 0.00612
    expect((await charged(runpodModelId("up1", "upscale-seedvr2", 1), Prices.parse({}))).costUsd).toBe(0.0061);
  });

  it("refuses to build the restorer for a run whose smooth-motion rates were removed from prices.json", () => {
    expect(() => createProviders(env, modelsFor(runpodModelId("up1", "restore-video", 1)), Prices.parse({}))).toThrow(/smooth motion is not set up/);
  });
});
```
(`test/unit/runpod-image-rates.test.ts` from phase 10 is the model for the `charged` helper; `FakeRunpodApi`'s constructor takes a script of job statuses, as there. If `env` as built by `loadEnv` is rejected by `createProviders`' type, build the literal as that test does and add `FLOWCHAIN_SMOOTH_MOTION: "off" as const`.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/unit/restore-provider.test.ts`
Expected: FAIL (`restoreRates`, `newRunRestore` and the workflow id do not exist).

- [ ] **Step 3: Implement**

`src/config.ts`, in `Prices` after `runpodUpscaleColdStartSec`:
```ts
  // Smooth motion (phase 11 spec §4): no default on purpose. A 60 fps run is refused until the owner has measured these
  // on the restorer endpoint and set all four, so a customer is never charged from a guess.
  runpodInterpolateUsdPerSec: z.number().positive().optional(),
  runpodInterpolateSecPerClipSec: z.number().positive().optional(),
  runpodInterpolateColdStartSec: z.number().positive().optional(),
  runpodRestoreExtraSecPerClipSec: z.number().positive().optional(),
```
and
```ts
export type RestoreRates = { usdPerSec: number; interpolateSecPerClipSec: number; coldStartSec: number; extraSecPerClipSec: number };

/** The restorer's smooth-motion rates, or null while any of the four is not set. */
export function restoreRates(p: Prices): RestoreRates | null {
  const { runpodInterpolateUsdPerSec: usdPerSec, runpodInterpolateSecPerClipSec: interpolateSecPerClipSec, runpodInterpolateColdStartSec: coldStartSec, runpodRestoreExtraSecPerClipSec: extraSecPerClipSec } = p;
  return usdPerSec === undefined || interpolateSecPerClipSec === undefined || coldStartSec === undefined || extraSecPerClipSec === undefined
    ? null
    : { usdPerSec, interpolateSecPerClipSec, coldStartSec, extraSecPerClipSec };
}

/** The plain refusal every part of the pipeline gives while the rates are missing (one text, so it is one message to the owner). */
export const RESTORE_RATES_MISSING =
  "smooth motion is not set up: the four rates runpodInterpolateUsdPerSec, runpodInterpolateSecPerClipSec, runpodInterpolateColdStartSec and runpodRestoreExtraSecPerClipSec are not all set in prices.json";
```
Also add to `Env`: `FLOWCHAIN_SMOOTH_MOTION: z.enum(["on", "off"]).default("off"),` — and, because `Env` now requires the key in the inferred type, add `FLOWCHAIN_SMOOTH_MOTION: "off" as const` to any `Env` literal a test builds (the phase 10 task had the same consequence for `FLOWCHAIN_CUT_REFERENCES`; change only the literals that fail typecheck).
`src/providers/types.ts`: `export type UpscaleRequest = { videoPath: string; short?: number; interpolate?: 2 };`.
`src/providers/model-id.ts`: in `RUNPOD_WORKFLOWS` add `restore: { workflow: "restore-video", version: 1 },` with the comment "the restorer's new workflow (phase 11): Full HD and/or smooth motion in one job".
`src/providers/runpod-providers.ts`, `RunpodUpscale.input`:
```ts
  protected async input(req: UpscaleRequest) {
    return {
      task: "upscale",
      video: (await readFile(req.videoPath)).toString("base64"),
      ...(req.short === undefined ? {} : { short: req.short }),
      ...(req.interpolate === undefined ? {} : { interpolate: req.interpolate }),
    };
  }
```
(for the old request the object has the same three keys as before).
`src/providers/factory.ts`: the upscale provider is built with deps whose `rates.upscaleUsdPerSec` is the restorer's rate when its workflow is `RUNPOD_WORKFLOWS.restore.workflow`:
```ts
  const upscaleDeps = (workflow: string): RunpodDeps => {
    if (workflow !== RUNPOD_WORKFLOWS.restore.workflow) return runpodDeps();
    const r = restoreRates(prices);
    if (!r) throw new NonRetryableError(RESTORE_RATES_MISSING);
    return { ...runpodDeps(), rates: { ...runpodDeps().rates, upscaleUsdPerSec: r.usdPerSec } };
  };
```
and `new RunpodUpscale(upscaleDeps(upscaleRef.workflow), upscaleRef)` (a `retired` ref keeps its path).
`src/providers/new-run.ts`:
```ts
/** The endpoint a new run in smooth motion has its clips restored on (phase 11 spec §3, §4); refuses plainly while it is not set up. */
export function newRunRestore(env: Env, prices: Prices, _fullHd: boolean): string {
  if (!env.RUNPOD_UPSCALE_ENDPOINT) throw new Error("smooth motion is not set up in this studio: RUNPOD_UPSCALE_ENDPOINT is not set (npm run runpod:deploy)");
  if (!restoreRates(prices)) throw new Error(RESTORE_RATES_MISSING);
  const { restore } = RUNPOD_WORKFLOWS;
  return runpodModelId(env.RUNPOD_UPSCALE_ENDPOINT, restore.workflow, restore.version);
}
```
(import `restoreRates`, `RESTORE_RATES_MISSING` from `../config.js`; the unused `_fullHd` is kept so the call site documents that both cases share one model id — drop it if the compiler or the repo's lint objects, and say so.)
`test/fakes/providers.ts` — `FakeUpscale.render`:
```ts
  protected async render(req: UpscaleRequest, n: number, path: (name: string) => string) {
    const file = path(`hd_${n}.mp4`);
    const filters: string[] = [];
    if (req.short !== undefined) filters.push(`scale=-2:${req.short}`);
    // (a stand-in for RIFE: twice the frames a second, frames repeated; enough to test the pipeline)
    if (req.interpolate !== undefined) filters.push(`fps=${(await probeVideo(req.videoPath)).fps * req.interpolate}`);
    await ffmpeg(["-i", req.videoPath, ...(filters.length ? ["-vf", filters.join(",")] : []), "-pix_fmt", "yuv420p", file]);
    return { out: { url: pathToFileURL(file).href }, file };
  }
```
(import `probeVideo` from `../../src/media/ffmpeg.js`).

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run test/unit/restore-provider.test.ts test/unit/runpod-providers.test.ts test/pipeline/upscale.test.ts test/unit/compat.test.ts && npm run typecheck`
Expected: PASS (the Full HD pipeline test is unedited and green).

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: the restorer can be asked to interpolate, is charged at its own measured rate for that workflow, and cannot be chosen until the four rates are set

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The stages: `interpolate`, the combined `upscale` job, and what `fit` plays

**Files:**
- Create: `src/stages/interpolate.ts`, `src/stages/source.ts`
- Modify: `src/manifest/schema.ts` (`StageName`, `SceneState.smoothed`), `src/stages/paths.ts`, `src/stages/require.ts`, `src/stages/upscale.ts`, `src/stages/fit.ts`, `src/stages/index.ts`
- Test: `test/pipeline/smooth.test.ts`, `test/stages/source.test.ts`

**Interfaces:**
- Consumes: `restoreRates`, `RESTORE_RATES_MISSING`, `fpsOf`, `UpscaleRequest`.
- Produces: `isSmoothed(m: Manifest, i: number): boolean` (a 60 fps run without Full HD, Mode 1); `interpolateCost(p: Prices, seconds: number, first?: boolean): number`; `upscaleCost(p, seconds, first?, smooth?)`; `playedClip(m: Manifest, i: number): { stage: "clips" | "upscale" | "interpolate"; path: string }`; `paths.smoothed(i)`; `requireSmoothed`; `SceneState.smoothed?: { path; sourceUrl?; duration }`.

- [ ] **Step 1: Write the failing tests**

`test/pipeline/smooth.test.ts` (modelled on `test/pipeline/upscale.test.ts`):
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSha256 } from "../../src/manifest/hash.js";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { type RunOptions, planRun, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { fitStage } from "../../src/stages/fit.js";
import { STAGES } from "../../src/stages/index.js";
import { interpolateStage, isSmoothed } from "../../src/stages/interpolate.js";
import { upscaleStage } from "../../src/stages/upscale.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 11 spec §4: 60 fps. A moving clip is interpolated (and, in Full HD, upscaled in the same job) before it is fitted.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };

async function smoothRun(opts: { fullHd?: boolean } = {}) {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  const restore = new FakeUpscale(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, upscale: restore };
  Object.assign(made.ctx.prices, RATES);
  made.ctx.fps = 60;
  made.ctx.manifest.request.fps = 60;
  if (opts.fullHd) made.ctx.manifest.request.upscale = true;
  made.ctx.manifest.models.upscale = "runpod:ep-up/restore-video@1";
  return { ...made, restore };
}

describe("a run in smooth motion without Full HD", () => {
  it("interpolates every moving clip once, fits the smoothed one at 60, and pays for each", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits.map((r) => r.videoPath.split("/").at(-1))).toEqual(["clip_01.mp4", "clip_02.mp4"]);
    expect(restore.submits.every((r) => r.short === undefined && r.interpolate === 2)).toBe(true);
    const m = ctx.manifest;
    expect(m.scenes[0].smoothed?.path).toBe("clips/clip_01.60.mp4");
    expect(m.scenes[2].smoothed).toBeUndefined();
    expect(m.scenes[0].upscaled).toBeUndefined();
    expect(m.ledger.filter((e) => e.stage === "interpolate").map((e) => e.scene)).toEqual([0, 1]);
    // the first pays for the worker's start
    expect(m.ledger.find((e) => e.stage === "interpolate" && e.scene === 0)!.usd).toBeGreaterThan(m.ledger.find((e) => e.stage === "interpolate" && e.scene === 1)!.usd);
    // what is fitted is the smoothed clip, at the run's 60
    expect(((await fitStage.inputsFor(ctx, 0)) as { clip: string }).clip).toBe(await fileSha256(join(ctx.dir, "clips/clip_01.60.mp4")));
    const clip = await probeVideo(join(ctx.dir, "clips/clip_01.mp4"));
    expect((await probeVideo(join(ctx.dir, m.scenes[0].smoothed!.path))).fps).toBeCloseTo(clip.fps * 2, 0);
    expect((await probeVideo(join(ctx.dir, m.scenes[0].fitted!.path))).fps).toBe(60);
    // and a resume buys nothing again
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });

  it("interpolates a clip again only when the clip is made again", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.stage === "interpolate").map((i) => i.scene)).toEqual([1]);
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits).toHaveLength(3);
  });
});

describe("a run in Full HD and smooth motion", () => {
  it("does both in ONE job per clip and has no interpolate step of its own", async () => {
    const { ctx, restore } = await smoothRun({ fullHd: true });
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits).toHaveLength(2);
    expect(restore.submits.every((r) => r.short === 1080 && r.interpolate === 2)).toBe(true);
    const m = ctx.manifest;
    expect(m.scenes[0].upscaled).toBeDefined();
    expect(m.scenes[0].smoothed).toBeUndefined();
    expect(m.ledger.filter((e) => e.stage === "interpolate")).toEqual([]);
    const hd = await probeVideo(join(ctx.dir, m.scenes[0].upscaled!.path));
    expect(hd.height).toBe(1080);
    expect(hd.fps).toBeCloseTo((await probeVideo(join(ctx.dir, "clips/clip_01.mp4"))).fps * 2, 0);
  });

  it("costs more than the upscale alone, by the extra the rates say", async () => {
    const { ctx } = await smoothRun({ fullHd: true });
    const smooth = upscaleStage.estimateCostUsd(ctx, 0);
    ctx.manifest.request.fps = undefined;
    const plain = upscaleStage.estimateCostUsd(ctx, 0);
    expect(smooth).toBeGreaterThan(plain);
  });
});

describe("a run that did not ask for smooth motion", () => {
  it("has no interpolate step, and its upscale key has no interpolate in it", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    expect(isSmoothed(ctx.manifest, 0)).toBe(false);
    expect(interpolateStage.appliesTo!(ctx.manifest, 0)).toBe(false);
    ctx.manifest.request.upscale = true;
    ctx.manifest.models.upscale = "runpod:ep-up/upscale-seedvr2@1";
    const keys = Object.keys(await upscaleStage.inputsFor(ctx, 0));
    expect(keys.sort()).toEqual(["clip", "model", "short"]);
  });
});

describe("a 60 fps run whose rates are not set", () => {
  it("is refused plainly when it is priced, never charged from a guess", async () => {
    const { ctx } = await smoothRun();
    for (const key of Object.keys(RATES)) delete (ctx.prices as Record<string, unknown>)[key];
    expect(() => interpolateStage.estimateCostUsd(ctx, 0)).toThrow(/smooth motion is not set up/);
  });
});
```
`test/stages/source.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { playedClip } from "../../src/stages/source.js";
import { makeTestContext } from "../helpers/context.js";

describe("which clip file a scene plays", () => {
  it("is the raw clip, the full HD one, or the smoothed one, by what the run asked for", async () => {
    const { ctx } = await makeTestContext({ modes: [1] });
    const m = ctx.manifest;
    expect(playedClip(m, 0)).toEqual({ stage: "clips", path: "clips/clip_01.mp4" });
    m.request.upscale = true;
    expect(playedClip(m, 0)).toEqual({ stage: "upscale", path: "clips/clip_01.hd.mp4" });
    m.request.upscale = undefined;
    m.request.fps = 60;
    expect(playedClip(m, 0)).toEqual({ stage: "interpolate", path: "clips/clip_01.60.mp4" });
    m.request.upscale = true;
    // Full HD wins: the combined job's one file is the upscaled path
    expect(playedClip(m, 0)).toEqual({ stage: "upscale", path: "clips/clip_01.hd.mp4" });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/pipeline/smooth.test.ts test/stages/source.test.ts`
Expected: FAIL (modules and fields missing).

- [ ] **Step 3: Implement**

`src/manifest/schema.ts`: `StageName` gets `"interpolate"` right after `"upscale"`; `SceneState` after `upscaled`:
```ts
  /** The clip interpolated to twice its frame rate (phase 11 spec §4): what the fit plays in a 60 fps run that is not in full HD. */
  smoothed: z.object({ path: z.string(), sourceUrl: z.string().optional(), duration: z.number() }).optional(),
```
Update the doc comment of `Models.upscale` to say it is the restorer endpoint. `src/stages/paths.ts`: `smoothed: (i: number) => \`clips/clip_${n(i)}.60.mp4\`,`. `src/stages/require.ts`: `export const requireSmoothed = (s: SceneState) => need(s, "smoothed", "smoothed clip");`.
`src/stages/source.ts`:
```ts
import type { Manifest } from "../manifest/schema.js";
import { paths } from "./paths.js";

/**
 * The clip file a Mode 1 scene plays (phase 11 spec §4): the full HD one (which is also the 60 fps one in a run that
 * asked for both: one job made it), else the smoothed one, else the clip as it was made. Pure, so `fit` can key and read
 * the same file.
 */
export function playedClip(m: Manifest, i: number): { stage: "clips" | "upscale" | "interpolate"; path: string } {
  if (m.request.upscale === true) return { stage: "upscale", path: paths.upscaled(i) };
  if (m.request.fps === 60) return { stage: "interpolate", path: paths.smoothed(i) };
  return { stage: "clips", path: paths.clip(i) };
}
```
`src/stages/interpolate.ts` (mirror `upscale.ts`):
```ts
import type { Prices } from "../config.js";
import { RESTORE_RATES_MISSING, restoreRates } from "../config.js";
import { round4 } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { probeDuration } from "../media/ffmpeg.js";
import { download } from "../providers/download.js";
import { NonRetryableError, TIMEOUTS } from "../providers/retry.js";
import { videoProfileOf } from "../video-profiles.js";
import { isMode1 } from "./clips.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip } from "./require.js";
import type { Stage } from "./types.js";

/** The frame-rate multiplier a clip is interpolated by: 16 fps Wan, 32 after the clip worker's RIFE, 64 after this (phase 11 spec §0). */
export const INTERPOLATE = 2;

/** What interpolating `seconds` of clip costs: the GPU seconds measured for each second of clip, and the worker's start for the first one. */
export function interpolateCost(p: Prices, seconds: number, first = false): number {
  const r = restoreRates(p);
  if (!r) throw new Error(RESTORE_RATES_MISSING);
  return round4((seconds * r.interpolateSecPerClipSec + (first ? r.coldStartSec : 0)) * r.usdPerSec);
}

/** Only a moving clip of a 60 fps run that is not in full HD is interpolated on its own (in full HD the upscale job does it). */
export const isSmoothed = (m: Manifest, i: number): boolean => m.request.fps === 60 && m.request.upscale !== true && isMode1(m, i);

export const interpolateStage: Stage = {
  name: "interpolate",
  perScene: true,
  paid: true,
  appliesTo: isSmoothed,
  deps: (_m, scene) => [{ stage: "clips", scene }],
  async inputsFor(ctx, scene) {
    return { model: ctx.manifest.models.upscale, interpolate: INTERPOLATE, clip: await fileSha256(abs(ctx, requireClip(ctx.manifest.scenes[scene!]).path)) };
  },
  outputsFor: (_m, scene) => [paths.smoothed(scene!)],
  estimateCostUsd(ctx, scene) {
    const m = ctx.manifest;
    const s = m.scenes[scene!];
    const seconds = s.clip?.duration ?? videoProfileOf(m.request.videoProfile).clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY);
    const first = m.scenes.findIndex((x) => isSmoothed(m, x.idx)) === scene;
    return interpolateCost(ctx.prices, seconds, first);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const restore = ctx.providers.upscale;
    if (!restore) throw new NonRetryableError("this run asked for smooth motion, and no restorer endpoint is set for it");
    const clip = requireClip(m.scenes[i]);
    requireAudio(m.scenes[i]);
    const out = await outPath(ctx, paths.smoothed(i));
    const first = m.scenes.findIndex((x) => isSmoothed(m, x.idx)) === i;
    const result = await runProviderJob(ctx, i, "interpolate", {
      label: `smooth motion scene ${i + 1}`,
      costUsd: interpolateCost(ctx.prices, clip.duration, first),
      prepare: () => restore.prepare({ videoPath: abs(ctx, clip.path), interpolate: INTERPOLATE }),
      submit: (job, signal) => restore.submit(job, { signal }),
      wait: (id) => restore.wait(id, { timeoutMs: restore.waitMs ?? TIMEOUTS.video }),
      waitMs: restore.waitMs ?? TIMEOUTS.video,
      submitTimeoutMs: restore.submitMs,
    });
    await download(result.url, out);
    await result.remove?.();
    m.scenes[i].smoothed = { path: paths.smoothed(i), sourceUrl: result.url, duration: await probeDuration(out) };
  },
};
```
`src/stages/upscale.ts`: `upscaleCost(p, seconds, first = false, smooth = false)`: when `smooth`, `const r = restoreRates(p); if (!r) throw new Error(RESTORE_RATES_MISSING); return round4((seconds * (runpodRates(p).upscaleSecPerClipSec + r.extraSecPerClipSec) + (first ? r.coldStartSec : 0)) * r.usdPerSec);`; the stage's `estimateCostUsd` and `run` pass `m.request.fps === 60`; `inputsFor` returns `{ model, short: FULL_HD, clip: …, ...(ctx.manifest.request.fps === 60 ? { interpolate: INTERPOLATE } : {}) }` (import `INTERPOLATE` from `./interpolate.js`); `prepare: () => upscale.prepare({ videoPath: abs(ctx, clip.path), short: FULL_HD, ...(m.request.fps === 60 ? { interpolate: INTERPOLATE } : {}) })`; the label stays "full HD scene N".
`src/stages/fit.ts`: replace the `isUpscaled` special-casing with `playedClip`:
```ts
  deps: (m, scene) => [
    { stage: "clips", scene },
    // (the clip it plays may be the upscaled or the smoothed one: phase 8 spec §8, phase 11 spec §4)
    ...(playedClip(m, scene!).stage === "clips" ? [] : [{ stage: playedClip(m, scene!).stage, scene }]),
    ...m.scenes.slice(0, scene! + 1).map((s) => ({ stage: "silence" as const, scene: s.idx })),
  ],
  inputsFor: async (ctx, scene) => ({
    clip: await fileSha256(abs(ctx, playedClip(ctx.manifest, scene!).path)),
    …unchanged…
```
and in `run`: `const played = playedClip(ctx.manifest, i); const clip = played.stage === "upscale" ? requireUpscaled(state) : played.stage === "interpolate" ? requireSmoothed(state) : requireClip(state);`. A Mode 1 scene only: `fit` already applies only to Mode 1 (`appliesTo: isMode1`). `src/stages/index.ts`: import `interpolateStage` and insert it after `upscaleStage`.

- [ ] **Step 4: Run to see them pass; the old suites stay green**

Run: `npx vitest run test/pipeline/smooth.test.ts test/stages/source.test.ts test/pipeline/upscale.test.ts test/stages test/unit && npm run typecheck`
Expected: PASS; `test/pipeline/upscale.test.ts` and `compat.test.ts` unedited.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: a 60 fps run interpolates each moving clip in the restorer, inside the upscale job when it is in full HD, and the fit plays the file that job made

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Reroll, versions, the studio's step list and its words

**Files:**
- Modify: `src/reroll.ts`, `src/versions.ts`, `src/studio/status.ts`, `web/lib/labels.ts`
- Test: `test/pipeline/smooth-reroll.test.ts`, extend `test/pipeline/versions.test.ts` only by APPENDING a test (never editing an existing one)

**Interfaces:** `REROLLABLE` gains `"interpolate"`; `INHERITED` gains `"interpolate"`; `SCENE_STAGES` gains `"interpolate"`; `STAGE_LABELS.interpolate = "Smooth motion"`.

- [ ] **Step 1: Write the failing tests**

`test/pipeline/smooth-reroll.test.ts` (reuse `smoothRun` by exporting it from `test/pipeline/smooth.test.ts`? No: copy its 12-line helper into this file):
```ts
// (copy RATES and smoothRun from test/pipeline/smooth.test.ts)
describe("rerolling a smoothed clip", () => {
  it("asks again for that scene's interpolation only, and refuses a scene that has none", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    const asked = restore.submits.length;
    expect(() => bumpNonce(ctx.manifest, 3, "interpolate")).toThrow(/no smoothed clip/);
    bumpNonce(ctx.manifest, 1, "interpolate");
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits.length).toBe(asked + 1);
  });

  it("is refused on a run that did not ask for smooth motion, and in full HD (the upscale job does it)", async () => {
    const plain = await makeTestContext({ modes: [1] });
    expect(() => bumpNonce(plain.ctx.manifest, 1, "interpolate")).toThrow(/no smoothed clip/);
    const hd = await smoothRun({ fullHd: true });
    expect(() => bumpNonce(hd.ctx.manifest, 1, "interpolate")).toThrow(/no smoothed clip/);
  });
});

describe("the studio's list of a scene's steps", () => {
  it("shows the smooth-motion step only on a moving scene of a 60 fps run without full HD", async () => {
    const { ctx } = await smoothRun();
    expect(sceneStagesShown(ctx.manifest, 0)).toContain("interpolate");
    expect(sceneStagesShown(ctx.manifest, 2)).not.toContain("interpolate");
    ctx.manifest.request.upscale = true;
    expect(sceneStagesShown(ctx.manifest, 0)).not.toContain("interpolate");
    expect(sceneStagesShown(ctx.manifest, 0)).toContain("upscale");
    expect(STAGE_LABELS.interpolate).toBe("Smooth motion");
  });
});
```
`test/pipeline/smooth-version.test.ts` (a NEW file; the pattern is `test/pipeline/versions.test.ts`'s `finishedRun`/`versionOf`):
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveManifest } from "../../src/manifest/store.js";
import { type RunOptions, runPipeline, sealInherited } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { copySourceFiles, versionManifest, versionProblem } from "../../src/versions.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";
import { tempDir } from "../helpers/media.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };

/** A finished 60 fps English run of three scenes: a clip, a clip that carries on from it, and a still. */
async function finishedSmoothRun() {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  const restore = new FakeUpscale(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, upscale: restore };
  Object.assign(made.ctx.prices, RATES);
  made.ctx.fps = 60;
  made.ctx.manifest.request.fps = 60;
  made.ctx.manifest.request.language = "en";
  made.ctx.manifest.models.upscale = "runpod:ep-up/restore-video@1";
  await runPipeline(made.ctx, STAGES, auto);
  return { ...made, restore };
}

describe("a version in another language of a 60 fps video", () => {
  it("keeps the source's frame rate and its smoothed clips, and buys no interpolation again", async () => {
    const made = await finishedSmoothRun();
    const source = made.ctx.manifest;
    const bought = made.restore.submits.length;
    const manifest = versionManifest(source, { runId: "test-version", language: "de", voiceId: source.request.voiceId, ttsModel: "fake-tts", llmModel: "fake-llm" });
    expect(manifest.request.fps).toBe(60);
    const dir = await tempDir("flowchain-version-");
    await copySourceFiles(made.ctx.dir, dir);
    const ctx = { ...made.ctx, dir, manifest };
    await sealInherited(ctx, STAGES);
    await saveManifest(dir, manifest);
    await runPipeline(ctx, STAGES, auto);
    expect(made.restore.submits.length).toBe(bought);
    expect(manifest.scenes[0].smoothed?.path).toBe("clips/clip_01.60.mp4");
    expect(manifest.scenes[2].smoothed).toBeUndefined();
    expect(manifest.ledger.some((e) => e.stage === "interpolate")).toBe(false);
  });

  it("is refused while a moving clip of the source has not been smoothed yet", async () => {
    const made = await finishedSmoothRun();
    expect(versionProblem(made.ctx.manifest)).toBeNull();
    delete made.ctx.manifest.scenes[1].smoothed;
    expect(versionProblem(made.ctx.manifest)).toMatch(/./);
  });
});
```
(Adapt `versionProblem`'s call and the expected message to its real signature in `src/versions.ts`; the second test must fail if the new `unmade` clause is left out.)

- [ ] **Step 2: Run to see them fail; implement**

Run: `npx vitest run test/pipeline/smooth-reroll.test.ts` → FAIL.
`src/reroll.ts`: import `isSmoothed` from `./stages/interpolate.js`; `REROLLABLE` gains `"interpolate"`; next to the `upscale` check add
```ts
  if (stage === "interpolate" && !isSmoothed(m, idx)) {
    throw new Error(`scene ${sceneNumber} has no smoothed clip: only a moving clip of a 60 fps run that is not in full HD is smoothed on its own`);
  }
```
`src/versions.ts`: wherever `upscale` / `upscaled` is handled, do the same for `interpolate` / `smoothed` and carry `fps`: `INHERITED` gains `"interpolate"`; the `unmade` check gains `|| (s.mode === 1 && r.fps === 60 && r.upscale !== true && !s.smoothed)`; the scene copy gains `...(x.smoothed ? { smoothed: x.smoothed } : {})`; the new run's request copies `fps` the way it copies `upscale` (read lines ~20-40 and ~95-105 and the request construction; list every place you changed in the report). `src/studio/status.ts`: `SCENE_STAGES` gains `"interpolate"` after `"upscale"`; `sceneStagesShown` adds `&& (s !== "interpolate" || isSmoothed(m, idx))`. `web/lib/labels.ts`: `interpolate: "Smooth motion",`.

- [ ] **Step 3: Run to see them pass; commit**

Run: `npx vitest run test/pipeline/smooth-reroll.test.ts test/pipeline/versions.test.ts test/pipeline/upscale.test.ts test/unit && npm run typecheck`
Expected: PASS.
```bash
git add src web/lib test
git commit -m "feat: a smoothed clip can be rerolled, a version in another language keeps its source's smooth motion, and the studio lists the step

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The choice end to end: the CLI flag, the form, the queue, the health answer, the names

**Files:**
- Modify: `src/cli.ts`, `src/providers/new-run.ts` (`restorerFor`), `web/server/schemas.ts`, `web/server/actions.ts`, `web/server/config.ts`, `web/server/jobs/redis.ts`, `web/components/NewVideoForm.tsx`, `web/lib/engines.ts`, and every list that carries `RUNPOD_UPSCALE_ENDPOINT` to the web (found by grep, Step 3)
- Test: `web/test/smooth-choice.test.ts`, `web/test/smooth-names.test.ts`, `web/test/smooth-health.test.ts`, `test/unit/restorer-for.test.ts`

**Interfaces:**
- Produces: CLI `--fps 60`; `NewVideo.fps: 30 | 60` (default 30); `draftArgs` pushes `--fps 60`; `Health.smooth?: boolean`; `refusal()` allows exactly `--fps 60` in a draft.

- [ ] **Step 1: Write the failing tests**

`web/test/smooth-choice.test.ts` (follow `web/test/worker-commands.test.ts` and `web/test/schemas.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { refusal } from "@/server/jobs/redis";
import { draftArgs, NewVideo } from "@/server/schemas";

const run = "20261006-120000-abc001";

describe("the smooth-motion choice in a draft's command", () => {
  it("adds --fps 60 and nothing else for smooth motion, and nothing for the default", () => {
    expect(draftArgs(NewVideo.parse({ topic: "t" }), run)).not.toContain("--fps");
    const smooth = draftArgs(NewVideo.parse({ topic: "t", fps: 60 }), run);
    expect(smooth).toEqual(expect.arrayContaining(["--fps", "60"]));
    expect(refusal("runs", smooth)).toBeUndefined();
  });

  it("is a choice of 30 or 60 only, and an old recipe without it is the default", () => {
    expect(NewVideo.parse({ topic: "t" }).fps).toBe(30);
    for (const bad of [24, 59, 120, "60"]) expect(() => NewVideo.parse({ topic: "t", fps: bad })).toThrow();
  });

  it("goes with Full HD in one command", () => {
    const both = draftArgs(NewVideo.parse({ topic: "t", clips: "1080p", fps: 60 }), run);
    expect(both).toEqual(expect.arrayContaining(["--upscale", "--fps", "60"]));
    expect(refusal("runs", both)).toBeUndefined();
  });
});

describe("what the worker agrees to run", () => {
  const base = ["run", "--draft", "--yes", "--run-id", run, "--topic", "t"];
  it("takes --fps with exactly 60, once", () => {
    expect(refusal("runs", [...base, "--fps", "60"])).toBeUndefined();
    expect(refusal("runs", [...base, "--fps", "30"])).toMatch(/--fps/);
    expect(refusal("runs", [...base, "--fps", "60abc"])).toMatch(/--fps/);
    expect(refusal("runs", [...base, "--fps", "60", "--fps", "60"])).toBe("a draft may not repeat --fps");
    expect(refusal("runs", [...base, "--fps"])).toMatch(/--fps/);
  });
});
```
`web/test/smooth-names.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { namesInternals } from "@/lib/engines";

describe("what customers are never shown", () => {
  it("includes the restorer's model names, and not the English word", () => {
    for (const text of ["SeedVR2", "RIFE 4.9", "RIFE"]) expect(namesInternals(text), text).toBe(true);
    expect(namesInternals("a life rife with detail")).toBe(false);
  });
});
```
`test/unit/restorer-for.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadEnv, Prices } from "../../src/config.js";
import { restorerFor } from "../../src/providers/new-run.js";

const env = loadEnv({ GEMINI_API_KEY: "g", RUNPOD_UPSCALE_ENDPOINT: "up1" });
const prices = Prices.parse({ runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 });

describe("the restorer model a run freezes", () => {
  it("is none for a run that asked for neither", () => {
    expect(restorerFor({}, env, prices)).toBeUndefined();
  });

  it("is the old Full HD workflow for Full HD alone, and needs no smooth-motion rates, so its jobs and keys are unchanged", () => {
    expect(restorerFor({ upscale: true }, env, Prices.parse({}))).toBe("runpod:up1/upscale-seedvr2@1");
  });

  it("is the restorer's new workflow for smooth motion, with or without Full HD", () => {
    expect(restorerFor({ fps: "60" }, env, prices)).toBe("runpod:up1/restore-video@1");
    expect(restorerFor({ fps: "60", upscale: true }, env, prices)).toBe("runpod:up1/restore-video@1");
  });

  it("refuses smooth motion plainly while the rates are missing, before anything is bought", () => {
    expect(() => restorerFor({ fps: "60" }, env, Prices.parse({}))).toThrow(/smooth motion is not set up/);
  });
});
```
`web/test/smooth-health.test.ts` (the setup is `web/test/routes.test.ts`'s health test; `useStudio`, `request` come from `./helpers`):
```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { request, useStudio } from "./helpers";

const studio = useStudio();
const smooth = async (env: string) => {
  await writeFile(join(studio.root, ".env"), env);
  return JSON.parse(await (await health(request("/api/health"), undefined)).text()).smooth;
};

describe("the health answer's smooth motion", () => {
  it("is offered only when the restorer is set up AND the owner switched it on, and is absent otherwise", async () => {
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\n")).toBeUndefined();
    expect(await smooth("FLOWCHAIN_SMOOTH_MOTION=on\n")).toBeUndefined();
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=off\n")).toBeUndefined();
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=on\n")).toBe(true);
  });

  it("never says where the restorer is", async () => {
    await writeFile(join(studio.root, ".env"), "RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=on\n");
    expect(await (await health(request("/api/health"), undefined)).text()).not.toContain("secret");
  });
});
```
And a test that a draft that asks for smooth motion is refused while it is not offered (follow how `web/test/routes.test.ts` calls `createDraft` for the full HD refusal, if there is one; else call `createDraft` with `NewVideo.parse({ topic: "t", fps: 60 })` under `withKeys` and expect the validation error "smooth motion is not available in this studio yet").

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run web/test/smooth-choice.test.ts web/test/smooth-names.test.ts web/test/smooth-health.test.ts test/unit/restorer-for.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/cli.ts`: `Opts` gains `fps?: string;`; add `.addOption(new Option("--fps <n>", "smooth motion: every moving clip is interpolated and the video is rendered at 60 frames a second (phase 11 spec §2)").choices(["60"]))` beside `--upscale`; in the request add `...(o.fps === "60" ? { fps: 60 as const } : {})`; the models: `...(restorerFor(o, env, loadPrices()) ? { upscale: restorerFor(o, env, loadPrices())! } : {})`, where `restorerFor(opts: { fps?: string; upscale?: boolean }, env: Env, prices: Prices): string | undefined` is a new exported pure function in `src/providers/new-run.ts`: `fps === "60"` → `newRunRestore(env, prices, opts.upscale === true)`; else `upscale` → `newRunUpscale(env)`; else undefined (call it once and keep the result). `web/server/schemas.ts`: in `NewVideo` add `fps: z.union([z.literal(30), z.literal(60)]).default(30),` (documented: "60 = smooth motion, phase 11 spec §2"); in `draftArgs` after the `--upscale` line: `if (input.fps === 60) args.push("--fps", "60");`. `web/server/jobs/redis.ts`: `DRAFT_VALUED` gains `"--fps"`, and in the draft loop, right after the valued-option check: `if (option === "--fps" && list[i + 1] !== "60") return "a draft may carry --fps only as 60";` (place the check so `[..., "--fps"]` with no value and `--fps 30` both return a message containing `--fps`). `web/server/config.ts`: `Health` gains `/** Whether smooth motion (60 fps, phase 11 spec §2) can be offered: the restorer endpoint is set and the owner switched it on. Present only when true, so every studio without it answers exactly as before (the existing health test compares the whole answer). */ smooth?: boolean;` and in the returned object `...(env.RUNPOD_UPSCALE_ENDPOINT?.trim() && env.FLOWCHAIN_SMOOTH_MOTION?.trim() === "on" ? { smooth: true } : {}),`. `web/server/actions.ts`: destructure `smooth` from `studioHealthRaw()` and after the full HD check add `if (input.fps === 60 && !smooth) throw new ApiError("validation", "fps: smooth motion is not available in this studio yet");`. Find how `fullHd` travels from `health()` to `studioHealthRaw()`, `studioHealth()`, the public answer and `routes.test.ts` (grep `fullHd` in `web/`), and carry `smooth` the same way everywhere (the public answer says that a setting is missing, not which: `smooth` is a boolean like `fullHd`). **Then grep `RUNPOD_UPSCALE_ENDPOINT` across the whole repo** (`deploy/`, `src/deploy/server.ts`, `scripts/`, `web/server/`) and add `FLOWCHAIN_SMOOTH_MOTION` to every list or compose file that carries `RUNPOD_UPSCALE_ENDPOINT` to the web app or the worker; report each place. `web/lib/engines.ts`: `INTERNAL_NAMES` gains `/seedvr/i, /\bRIFE\b/,` (the second case-sensitive on purpose: "rife" is an English word). `web/components/NewVideoForm.tsx`: the form's state gets `fps: 30 as 30 | 60`; the posted body gets `fps: f.fps`; below the clip-quality block (shown for every kind of video, since a still is smoother at 60 too) add, only when `health.smooth`:
```tsx
          {health.smooth && (
            <div className="flex flex-wrap items-center gap-3 text-[0.95rem]">
              <span>Frame rate</span>
              <Segmented label="Frame rate" value={String(f.fps)} onChange={(v) => set("fps", v === "60" ? 60 : 30)}
                options={[{ value: "30", label: "Standard" }, { value: "60", label: "Smooth (60 fps)" }]} />
              <span className="text-[0.85rem] text-graphite" data-testid="fps-note">
                {f.fps === 60
                  ? "Moving clips get extra in-between frames and the final cut is made at 60 frames a second: smoother motion, and it takes about twice as long to put together."
                  : "Standard motion is already smoothed."}{" "}The draft shows the price before anything is made.
              </span>
            </div>
          )}
```
(read `Segmented`'s props in the file and adapt the value type; the existing `clips` control is the model.)

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run web/test test/unit && npm run typecheck`
Expected: PASS, including `web/test/names.test.ts` (pages and published files must not contain "SeedVR" or an upper-case "RIFE"; if one does, that is a real finding: report it, do not weaken the test) and the unedited `routes.test.ts`, `worker-commands.test.ts`, `schemas.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src web test
git commit -m "feat: smooth motion can be chosen from the command line and the studio's form, the queue agrees to exactly --fps 60, and the restorer's names stay off customer surfaces

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The owner's manual and the repo's rules

**Files:**
- Modify: `README.md`, `.env.example`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-22-phase11-smooth-motion-design.md` (the "built" status line)

- [ ] **Step 1: Write the docs**

`README.md`: next to the Full HD / RunPod section add a short section "Smooth motion (60 fps, optional)": what it is (60 frames a second; clips interpolated in the restorer worker, in the same job as Full HD when both are chosen; a choice made when a video is created, not for an existing one); the owner's steps in order — rebuild and push the restorer image (the `upscale` job of `worker-image.yml`), `npm run runpod:deploy` (prints its plan first), make one video with `npm run flowchain -- run … --fps 60`, read the GPU seconds per clip second from its ledger for interpolation alone and inside a Full HD job, set `runpodInterpolateUsdPerSec`, `runpodInterpolateSecPerClipSec`, `runpodInterpolateColdStartSec` and `runpodRestoreExtraSecPerClipSec` in `prices.json`, then set `FLOWCHAIN_SMOOTH_MOTION=on` to show the choice in the studio; the rollback (the previous restorer image tag: `RUNPOD_UPSCALE_IMAGE=ghcr.io/<owner>/flowchain-upscale:<previous tag>`; find the previous tag as `u-` + the first 12 characters of `git rev-parse <last commit before this phase>:worker-upscale` and verify the function that builds it, `upscaleImageTag` in `src/deploy/runpod.ts`). `.env.example`: a commented `FLOWCHAIN_SMOOTH_MOTION=` (`on` or `off`, default off). `CLAUDE.md`: a bullet under "How the pipeline is built" — "**A run may be made for 60 fps** (`request.fps`, frozen; `fpsOf()` is the only reader; phase 11 spec): its clips are interpolated by the restorer worker (RIFE, inside the Full HD upscale job when both are chosen, else the `interpolate` stage); never add a second place that reads the constant `FPS`; a 60 fps run is refused until the four `runpodInterpolate*`/`runpodRestoreExtra*` prices are set; it cannot be added to an existing run (chained clips are keyed on the frame rate)"; the layout row for `worker-upscale/` (it now does SeedVR2 and RIFE); the "Where the reasons are" row for the phase 11 spec; the Commands line `npm run flowchain -- run … --fps 60`.
Spec: set the status line to "built; the owner's steps (§7) are not done".

- [ ] **Step 2: Check and commit**

Run: `npm run typecheck && npx vitest run web/test/names.test.ts test/unit/compat.test.ts`
Expected: PASS.
```bash
git add README.md .env.example CLAUDE.md docs
git commit -m "docs: the owner's manual and the repo's rules say how smooth motion is set up, priced, switched on and rolled back

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The owner's steps (not an agent's)

**Files:** none changed by an agent.

- [ ] **Step 1:** Rebuild and push the restorer image (the `upscale` job of `worker-image.yml`), then `npm run runpod:deploy`; read its printed plan before proceeding. The build's final check fails the image if SeedVR2 or RIFE is missing.
- [ ] **Step 2:** Provisional prices: put values certainly above the real ones in `prices.json` (the four `runpodInterpolate*`/`runpodRestoreExtra*` keys), make one video with `--fps 60` and one with `--upscale --fps 60`, and read the real seconds from each job in the run's ledger. Replace the provisional prices with the measured numbers.
- [ ] **Step 3:** Judge the motion on both videos (fast action, faces, text-like detail), the file sizes, and the render time. Check that a platform accepts a 60 fps upload.
- [ ] **Step 4:** Set `FLOWCHAIN_SMOOTH_MOTION=on` to show the choice in the studio.
- [ ] **Step 5:** Anything unexpected (RIFE warping, the 64-to-60 thinning visible, a clip over the 9 MB limit, a memory error at 1080p) is written into the spec as a section on what was found, or fixed in a new task. It is never dropped.
