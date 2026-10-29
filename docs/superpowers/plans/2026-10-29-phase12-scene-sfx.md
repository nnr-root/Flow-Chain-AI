# Phase 12 — scene sound effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the script names, per scene, up to two sounds from a closed synthesized library, and the render plays them at the scene's start, middle or end (a texture under the whole scene for a "bed" sound), with the edit's own sounds winning any clash.

**Architecture:** a pure vocabulary file (`src/sounds.ts`, no imports, safe for the browser) feeds the zod scene schema, the script prompt and the `SFX` table in `src/media/sfx.ts`. A new pure function `sceneSfxCues` turns a scene's cues into frames beside the existing `sfxCues`; `assembleRenderProps` publishes both lists in `audio.sfx`; `AudioLayer` plays a bed with a looped, faded `<Audio>`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes in `src/`), zod, Remotion, ffmpeg (`aevalsrc`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-phase12-scene-sfx-design.md` (a later section wins; see Rulings below for two places this plan sharpens it).

## Global Constraints

- Nothing that spends money or touches a real account runs. **`npm run make:sfx` is on the owner's click list** (CLAUDE.md): it is free but listed, so it runs only after the controller asks the owner (Task 1, Step 8). Tests never call it; they synthesize into a temp directory.
- Never edit `test/unit/compat.test.ts`. New manifest fields are **optional** so old runs load.
- Every change to a prompt bumps `PROMPT_VERSION` (`src/providers/prompt-version.ts`); `test/unit/prompt-pin.test.ts` fails without it. Accept a change with `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts` after the bump, and add a changelog line to `docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md`.
- Frame arithmetic goes through `framesAt(framesAt30, fps)` (`src/media/remotion/timeline.ts`); 30 fps output must equal what the same numbers give today.
- No customer-facing surface names a model or a provider (nothing here does). Do not add a sound list to the studio.
- Comments say why, in plain sentences, at the density of the file. Tests are sentences about behaviour; a test must be able to fail (check it fails without the fix).
- Commit messages: `feat:`/`fix:`/`docs:`/`test:` + one sentence saying what is now true; end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work is committed on `main`; **no push** (the owner's click).
- Pure logic separated from what acts; the pure part is tested.

## Rulings (where this plan sharpens the spec)

1. **Size of the library.** The spec's "about 24" is the design talk's number; its own list names 14 new sounds + 3 existing = **17**. This plan builds the 14 (hits: `footstep door knock glass beep clock heartbeat splash thunder`; beds: `rain wind crowd engine fire`). Task 4 corrects the spec's wording.
2. **Hits are at most 1.9 s long** (a hit's `<Audio>` is mounted for 2 s so a long video's hundreds of cuts do not each hold an audio tag). `thunder` is therefore 1.9 s with a quick decay. A test pins it.
3. **`at` on a bed is ignored**; a bed always runs from the scene's start (plus the leading transition's half window) to its end.
4. **Clash rule compares only against the edit's sounds** (hook impact, cut sounds), as the spec says; two scene hits near each other both play.

---

### Task 1: The vocabulary, the SFX table and the 14 recipes

**Files:**
- Create: `src/sounds.ts`
- Modify: `src/media/sfx.ts`, `scripts/make-sfx.ts`, `src/doctor.ts:127`, `test/media/sfx.test.ts`
- Create: `test/unit/sounds.test.ts`
- Generated (Step 8, owner's click): `assets/sfx/*.mp3`

**Interfaces:**
- Produces (`src/sounds.ts`, imports nothing):
  ```ts
  export const EDIT_SOUNDS = ["impact", "whoosh", "pop"] as const;
  export const SCENE_SOUNDS = ["footstep","door","knock","glass","beep","clock","heartbeat","splash","thunder","rain","wind","crowd","engine","fire"] as const;
  export type SceneSound = (typeof SCENE_SOUNDS)[number];
  export const SCENE_SOUND_ABOUT: Record<SceneSound, string>; // short English description for the prompt
  ```
- Produces (`src/media/sfx.ts`):
  ```ts
  export type SfxName = (typeof EDIT_SOUNDS)[number] | SceneSound;
  export type SfxKind = "hit" | "bed";
  export const SFX: Record<SfxName, { file: string; baseGain: number; leadFrames: number; kind: SfxKind }>;
  ```
  The three existing entries keep their exact values and gain `kind: "hit"`. `sfxFiles` returns every file in `SFX`.
- Produces (`scripts/make-sfx.ts`): `RECIPES` gains 14 entries; `synthesizeSfx(outDir)` unchanged in signature.

- [ ] **Step 1: Write the failing vocabulary test** (`test/unit/sounds.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { SFX, sfxFiles } from "../../src/media/sfx.js";
import { EDIT_SOUNDS, SCENE_SOUNDS, SCENE_SOUND_ABOUT } from "../../src/sounds.js";
import { RECIPES } from "../../scripts/make-sfx.js";

describe("the sound vocabulary", () => {
  it("describes every scene sound the script may name, and no edit sound", () => {
    expect(Object.keys(SCENE_SOUND_ABOUT).sort()).toEqual([...SCENE_SOUNDS].sort());
    for (const s of SCENE_SOUNDS) expect(SCENE_SOUND_ABOUT[s].length).toBeGreaterThan(8);
    for (const e of EDIT_SOUNDS) expect((SCENE_SOUNDS as readonly string[]).includes(e)).toBe(false);
  });

  it("has a table entry and a recipe for every sound, with one file each", () => {
    const names = [...EDIT_SOUNDS, ...SCENE_SOUNDS];
    expect(Object.keys(SFX).sort()).toEqual([...names].sort());
    expect(RECIPES.map((r) => r.file).sort()).toEqual(sfxFiles("").map((f) => f.replace(/^\/?/, "")).sort());
    expect(new Set(RECIPES.map((r) => r.file)).size).toBe(RECIPES.length);
  });

  it("makes beds the textures that last a scene, and keeps every hit short enough to mount for two seconds", () => {
    const beds = Object.entries(SFX).filter(([, v]) => v.kind === "bed").map(([k]) => k).sort();
    expect(beds).toEqual(["crowd", "engine", "fire", "rain", "wind"]);
    for (const [name, v] of Object.entries(SFX)) {
      const r = RECIPES.find((x) => x.file === v.file)!;
      if (v.kind === "hit") expect(r.seconds, name).toBeLessThanOrEqual(1.9);
      else expect(r.seconds, name).toBeGreaterThanOrEqual(3);
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail** — `npx vitest run test/unit/sounds.test.ts` → fails (`src/sounds.js` missing).

- [ ] **Step 3: Write `src/sounds.ts`** with the exports above. `SCENE_SOUND_ABOUT` text, one line each, English, what the sound is and when it fits (e.g. `door: "a door shutting or slamming, once"`, `rain: "steady rain, under the whole scene"`, `beep: "one electronic beep of a device or alarm"`, `clock: "one clock tick"`, `heartbeat: "two low heartbeats"`, `crowd: "the murmur of a crowd, under the whole scene"`). A short comment says it imports nothing because the browser reads it through the schema.

- [ ] **Step 4: Rewrite the table in `src/media/sfx.ts`**

```ts
import { EDIT_SOUNDS, type SceneSound } from "../sounds.js";
export type SfxName = (typeof EDIT_SOUNDS)[number] | SceneSound;
export type SfxKind = "hit" | "bed";
export const SFX: Record<SfxName, { file: string; baseGain: number; leadFrames: number; kind: SfxKind }> = {
  impact: { file: "impact_boom.mp3", baseGain: 1, leadFrames: 0, kind: "hit" },
  whoosh: { file: "whoosh.mp3", baseGain: 0.8, leadFrames: 8, kind: "hit" },
  pop: { file: "pop.mp3", baseGain: 0.7, leadFrames: 0, kind: "hit" },
  footstep: { file: "footstep.mp3", baseGain: 0.7, leadFrames: 0, kind: "hit" },
  door: { file: "door.mp3", baseGain: 0.8, leadFrames: 0, kind: "hit" },
  knock: { file: "knock.mp3", baseGain: 0.8, leadFrames: 0, kind: "hit" },
  glass: { file: "glass.mp3", baseGain: 0.6, leadFrames: 0, kind: "hit" },
  beep: { file: "beep.mp3", baseGain: 0.5, leadFrames: 0, kind: "hit" },
  clock: { file: "clock.mp3", baseGain: 0.6, leadFrames: 0, kind: "hit" },
  heartbeat: { file: "heartbeat.mp3", baseGain: 0.9, leadFrames: 0, kind: "hit" },
  splash: { file: "splash.mp3", baseGain: 0.7, leadFrames: 0, kind: "hit" },
  thunder: { file: "thunder.mp3", baseGain: 0.8, leadFrames: 0, kind: "hit" },
  rain: { file: "rain.mp3", baseGain: 0.25, leadFrames: 0, kind: "bed" },
  wind: { file: "wind.mp3", baseGain: 0.3, leadFrames: 0, kind: "bed" },
  crowd: { file: "crowd.mp3", baseGain: 0.25, leadFrames: 0, kind: "bed" },
  engine: { file: "engine.mp3", baseGain: 0.2, leadFrames: 0, kind: "bed" },
  fire: { file: "fire.mp3", baseGain: 0.3, leadFrames: 0, kind: "bed" },
};
```
Keep the existing doc comment (extend it: "beds play under a whole scene at a low gain so the narration stays first"). `sfxFiles` keeps `Object.values(SFX).map(...)`. Update the unit test line in Step 1 if `sfxFiles("")` joins oddly: compare `Object.values(SFX).map((s) => s.file)` instead (use that; it is simpler and correct).

- [ ] **Step 5: Add the 14 recipes to `scripts/make-sfx.ts`** (same `Recipe` shape; `n` below means `(2*random(0)-1)`; write each expression out in full, no variables, as the file's existing recipes do). Starting formulas, to be tuned by ear later:

| file | seconds | expr | filters |
|---|---|---|---|
| footstep.mp3 | 0.25 | `min(1,t/0.003)*(0.6*sin(2*PI*90*t)*exp(-25*t)+0.4*n*exp(-60*t))` | `lowpass=f=1500` |
| door.mp3 | 0.6 | `min(1,t/0.004)*(0.8*sin(2*PI*70*t)*exp(-9*t)+0.5*n*exp(-30*t))` | `lowpass=f=1200` |
| knock.mp3 | 0.4 | `0.8*sin(2*PI*160*t)*min(1,t/0.002)*(exp(-45*t)+gte(t,0.18)*exp(-45*max(0,t-0.18)))` | — |
| glass.mp3 | 0.8 | `min(1,t/0.002)*0.3*(sin(2*PI*2400*t)+sin(2*PI*3100*t)+sin(2*PI*4200*t))*exp(-9*t)+0.3*n*exp(-80*t)` | — |
| beep.mp3 | 0.3 | `0.5*sin(2*PI*880*t)*min(1,t/0.005)*min(1,(0.3-t)/0.01)` | — |
| clock.mp3 | 0.1 | `n*exp(-120*t)` | `highpass=f=2000` |
| heartbeat.mp3 | 0.9 | `0.9*sin(2*PI*55*t)*(exp(-14*t)+0.7*gte(t,0.28)*exp(-14*max(0,t-0.28)))` | `lowpass=f=200,volume=2` |
| splash.mp3 | 0.9 | `n*exp(-5*t)*min(1,t/0.01)` | `highpass=f=400,lowpass=f=6000` |
| thunder.mp3 | 1.9 | `n*exp(-1.6*t)*min(1,t/0.25)` | `lowpass=f=220,volume=4` |
| rain.mp3 | 4 | `n*(0.7+0.3*sin(2*PI*0.5*t))` | `highpass=f=1500,lowpass=f=9000,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03` |
| wind.mp3 | 4 | `n*(0.6+0.4*sin(2*PI*0.5*t))` | `bandpass=f=400:width_type=h:w=500,volume=3,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03` |
| crowd.mp3 | 4 | `n*(0.6+0.2*sin(2*PI*1.25*t)+0.2*sin(2*PI*0.75*t))` | `bandpass=f=450:width_type=h:w=800,volume=3,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03` |
| engine.mp3 | 4 | `0.5*sin(2*PI*55*t)+0.3*sin(2*PI*110*t)+0.2*sin(2*PI*165*t)+0.1*n` | `lowpass=f=600,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03` |
| fire.mp3 | 4 | `n*(0.15+0.85*pow(random(1),12))` | `highpass=f=800,volume=2,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03` |

(Engine frequencies are whole cycles in 4 s, so its loop is seamless; the other beds are noise, which has no seam to hear, and fade 30 ms at both ends against a click.) Check each recipe runs through `synthesizeSfx` into a temp directory in Step 6; if ffmpeg rejects an expression, fix the expression, not the test.

- [ ] **Step 6: Test the recipes without touching `assets/`.** Add to `test/media/sfx.test.ts` a second `describe`:

```ts
describe("the sound recipes", () => {
  it("synthesize to the declared lengths, are not silent, and are identical when made twice", async () => {
    const a = await mkdtemp(join(tmpdir(), "sfx-a-"));
    const b = await mkdtemp(join(tmpdir(), "sfx-b-"));
    await synthesizeSfx(a);
    await synthesizeSfx(b);
    for (const r of RECIPES) {
      expect(await probeDuration(join(a, r.file)), r.file).toBeCloseTo(r.seconds, 1);
      const s = await samples(join(a, r.file));
      expect(Math.max(...s.map(Math.abs)), `${r.file} is silent`).toBeGreaterThan(0.02);
      expect((await readFile(join(a, r.file))).equals(await readFile(join(b, r.file))), `${r.file} differs between runs`).toBe(true);
    }
  }, 120_000);
});
```
(imports: `mkdtemp, readFile` from `node:fs/promises`, `tmpdir` from `node:os`, `RECIPES, synthesizeSfx` from `../../scripts/make-sfx.js`.) The existing `are all present` / lengths tests stay and cover the three originals once assets exist.

- [ ] **Step 7: Run** `npx vitest run test/unit/sounds.test.ts test/media/sfx.test.ts`; the new recipe test and the vocabulary tests pass; `are all present` fails only until Step 8. `doctor.ts:127`: change `detail: … "3 bundled"` to `` `${Object.keys(SFX).length} bundled` `` (import `SFX` there). Run `npm run typecheck`.

- [ ] **Step 8 (controller, owner's click):** ask the owner (AskUserQuestion) to allow `npm run make:sfx` (free, local ffmpeg; it rewrites `assets/sfx/*.mp3`, the three originals included — they must come out byte-identical; check with `git status`/`git diff --stat` that only new files appear). After a yes: run it, run `npx vitest run test/media/sfx.test.ts`, then commit.

- [ ] **Step 9: Commit**

```bash
git add src/sounds.ts src/media/sfx.ts scripts/make-sfx.ts src/doctor.ts test/unit/sounds.test.ts test/media/sfx.test.ts assets/sfx
git commit -m "feat: the library has fourteen more synthesized sounds, nine hits and five beds, in one vocabulary the script may choose from"
```

---

### Task 2: The script names sounds (schema, prompt, version)

**Files:**
- Modify: `src/manifest/schema.ts` (`SceneSpec`, ~line 56), `src/providers/gemini.ts` (`sceneRules`, ~line 129), `src/providers/prompt-version.ts`, `test/unit/prompt-pins.json` (regenerated), `docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md` (changelog line)
- Create: `test/unit/scene-sounds.test.ts`

**Interfaces:**
- Consumes: `SCENE_SOUNDS`, `SCENE_SOUND_ABOUT`, `SceneSound` from `src/sounds.ts` (Task 1).
- Produces: `SceneSpec.soundCues?: Array<{ sound: SceneSound; at: "start" | "middle" | "end" }>` (max 2); type `SceneSoundCue = NonNullable<SceneSpec["soundCues"]>[number]` exported from `schema.ts`. `LlmSceneSpec` inherits it unchanged (optional: silence is allowed).

- [ ] **Step 1: Write failing tests** (`test/unit/scene-sounds.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { LlmScript, SceneSpec } from "../../src/manifest/schema.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { SCENE_SOUNDS } from "../../src/sounds.js";
import { fakeScript } from "../fakes/providers.js";

const withCues = (cues: unknown) => ({ ...fakeScript(1).scenes[0], soundCues: cues });

describe("a scene's sound cues", () => {
  it("are optional, so a script written before them still loads", () => {
    expect(SceneSpec.safeParse(fakeScript(1).scenes[0]).success).toBe(true);
  });
  it("accept a sound from the vocabulary at start, middle or end", () => {
    expect(SceneSpec.safeParse(withCues([{ sound: "door", at: "middle" }])).success).toBe(true);
  });
  it("refuse a sound outside the vocabulary, a bad position and a third cue", () => {
    expect(SceneSpec.safeParse(withCues([{ sound: "laser", at: "start" }])).success).toBe(false);
    expect(SceneSpec.safeParse(withCues([{ sound: "door", at: "later" }])).success).toBe(false);
    expect(SceneSpec.safeParse(withCues(["door", "rain", "wind"].map((sound) => ({ sound, at: "start" })))).success).toBe(false);
  });
  it("are part of the answer Gemini is asked for", () => {
    expect(LlmScript.safeParse({ ...fakeScript(1), scenes: [withCues([{ sound: "rain", at: "start" }])] }).success).toBe(true);
    expect(JSON.stringify(scriptJsonSchema)).toContain("soundCues");
  });
});

describe("the script prompt", () => {
  it("lists every sound the script may name, and says silence is the default", () => {
    const p = buildScriptPrompt({ topic: "t", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" });
    for (const s of SCENE_SOUNDS) expect(p).toContain(s);
    expect(p).toMatch(/soundCues/);
    expect(p).toMatch(/empty/i);
  });
});
```
(If `scriptJsonSchema` is a function in `gemini.ts` rather than a value, call it the way `test/helpers/prompt-pins.ts` does and fix the last assertion of test 4 accordingly.)

- [ ] **Step 2: Run, see it fail** (`npx vitest run test/unit/scene-sounds.test.ts`).

- [ ] **Step 3: Schema.** In `src/manifest/schema.ts` import `SCENE_SOUNDS` and add to `SceneSpec`:

```ts
  /** Optional when stored: absent means none. Sounds the scene would have, from a closed library (phase 12 spec §2). */
  soundCues: z
    .array(z.object({ sound: z.enum(SCENE_SOUNDS), at: z.enum(["start", "middle", "end"]) }))
    .max(2)
    .optional()
    .describe("Up to 2 sounds this scene would clearly have, each with where it plays; leave empty or omit when unsure"),
```
and `export type SceneSoundCue = NonNullable<SceneSpec["soundCues"]>[number];`. Check `scriptJsonSchema`/Gemini's schema conversion accepts an optional array of enums (read how `LlmScript` becomes the response schema in `gemini.ts`); if the converter rejects it, adapt the converter, not the schema.

- [ ] **Step 4: Prompt.** In `sceneRules` in `src/providers/gemini.ts`, after the `suggestedTransition` line, add one rule built from the vocabulary:

```ts
    `- soundCues: up to two sounds this scene's picture clearly has a source for, each as {sound, at} with at "start", "middle" or "end" (a texture such as rain or wind plays under the whole scene, so its "at" does not matter). Choose only from: ${SCENE_SOUNDS.map((s) => `${s} (${SCENE_SOUND_ABOUT[s]})`).join("; ")}. Name a sound only when the frame shows what makes it; when unsure, leave the list empty. Silence is the default, and most scenes have none.`,
```

- [ ] **Step 5: Version and pins.** `PROMPT_VERSION = "2026-10-29.16"`. Then `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts` and `npx vitest run test/unit/prompt-pin.test.ts` (pass). Add a line to the changelog of the phase 9 spec for `2026-10-29.16` ("scene `soundCues` rule and the sound vocabulary added to the script prompt") in the style of its other lines.

- [ ] **Step 6: Run** `npx vitest run test/unit/scene-sounds.test.ts test/unit/prompt-pin.test.ts test/unit/compat.test.ts` and the script tests (`npx vitest run test/unit -t script` is too loose: run `npx vitest run test/unit test/stages` once; ≈ several minutes; re-run any timing-flaky file alone before believing a failure). `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/manifest/schema.ts src/providers/gemini.ts src/providers/prompt-version.ts test/unit/prompt-pins.json test/unit/scene-sounds.test.ts docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md
git commit -m "feat: the script may name up to two sounds a scene would have, from the library only, and silence is the default"
```

---

### Task 3: Frames, props and playing them

**Files:**
- Modify: `src/media/sfx.ts` (add `sceneSfxCues`, extend `SfxCuePlan`), `src/media/remotion/props.ts:113` (`SfxCue`), `src/media/remotion/timeline.ts` (`bedVolume`), `src/media/remotion/layers/AudioLayer.tsx`, `src/stages/build-render-props.ts:143-152`
- Modify tests: `test/unit/sfx-cues.test.ts`; the existing `build-render-props.test.ts` (find with `ls test/*/build-render-props.test.ts`); timeline tests where `framesAt`/`fadeInOpacity` are tested (find with `grep -ln fadeInOpacity test -r`)
- Create: `test/unit/scene-sfx.test.ts`

**Interfaces:**
- Consumes: `SceneSoundCue` (Task 2), `SFX` with `kind` (Task 1), `framesAt` (`timeline.ts`).
- Produces:
  ```ts
  // src/media/sfx.ts
  export type SfxCuePlan = { sound: SfxName; frame: number; gain: number; durationFrames?: number; fadeFrames?: number }; // durationFrames set = a bed
  export type SceneSfxInput = { from: number; frames: number; lead: number; cues: SceneSoundCue[] };
  export function sceneSfxCues(scenes: SceneSfxInput[], taken: SfxCuePlan[], opts: { gain: number; fps: number }): SfxCuePlan[];
  // src/media/remotion/props.ts
  SfxCue = z.object({ src, frame, gain, durationFrames: z.number().int().positive().optional(), fadeFrames: z.number().int().min(0).optional() })
  // src/media/remotion/timeline.ts
  export function bedVolume(frame: number, total: number, fade: number): number; // 0..1, ramps in and out over `fade` frames
  ```

- [ ] **Step 1: Failing tests for `sceneSfxCues`** (`test/unit/scene-sfx.test.ts`). Use scenes `{ from: 0, frames: 90, lead: 0 }` and `{ from: 90, frames: 90, lead: 5 }`, `opts = { gain: 1, fps: 30 }`:
  - `start` → frame `from + lead` (scene 2: 95); `middle` → `from + 45` (135); `end` → `from + frames - fps` (scene 1: 60); each minus `leadFrames` (0 for all scene sounds).
  - gain is `opts.gain * SFX[sound].baseGain` (e.g. `door` 0.8, with `gain: 0.5` → 0.4).
  - a hit within 5 frames (< 6) of a `taken` cue is dropped; one exactly 6 frames away plays; at fps 60 the window is 12 frames (`taken` frame 100, hit at 111 dropped, at 112 kept).
  - two cues of the same name in one scene collapse to one.
  - a bed returns one cue with `durationFrames = from + frames - start` and `fadeFrames = min(framesAt(15, fps), floor(durationFrames / 2))`, ignores `at`, is not dropped by the clash rule, and a second bed in the same scene is dropped (first wins).
  - a scene with no cues (or `cues: []`) yields nothing; output is sorted by `frame`.
  - 30 fps identity: a hit at `middle` for `frames: 91` lands on `from + 45` (floor).
  Run: fails (`sceneSfxCues` missing).

- [ ] **Step 2: Implement `sceneSfxCues`** in `src/media/sfx.ts`:

```ts
import { framesAt } from "./remotion/timeline.js";
import type { SceneSoundCue } from "../manifest/schema.js";

export type SceneSfxInput = { from: number; frames: number; lead: number; cues: SceneSoundCue[] };

/**
 * Where a scene's own sounds play (phase 12 spec §2). A hit lands on the scene's start (after the transition that
 * leads in), middle or last second; a bed runs under the whole scene. The edit's sounds (`taken`: the hook's impact
 * and the cuts') win a clash, so a door never lands on top of a whoosh.
 */
export function sceneSfxCues(scenes: SceneSfxInput[], taken: SfxCuePlan[], opts: { gain: number; fps: number }): SfxCuePlan[] {
  const clash = framesAt(6, opts.fps);
  const out: SfxCuePlan[] = [];
  for (const sc of scenes) {
    const end = sc.from + sc.frames;
    const start = Math.min(sc.from + sc.lead, end - 1);
    const seen = new Set<string>();
    let hasBed = false;
    for (const c of sc.cues) {
      if (seen.has(c.sound)) continue;
      seen.add(c.sound);
      const e = SFX[c.sound];
      if (e.kind === "bed") {
        if (hasBed) continue;
        hasBed = true;
        const durationFrames = end - start;
        out.push({ sound: c.sound, frame: start, gain: opts.gain * e.baseGain, durationFrames, fadeFrames: Math.min(framesAt(15, opts.fps), Math.floor(durationFrames / 2)) });
        continue;
      }
      const at = c.at === "start" ? start : c.at === "middle" ? sc.from + Math.floor(sc.frames / 2) : Math.max(start, end - opts.fps);
      const frame = Math.max(0, at - e.leadFrames);
      if (taken.some((t) => t.durationFrames === undefined && Math.abs(t.frame - frame) < clash)) continue;
      out.push({ sound: c.sound, frame, gain: opts.gain * e.baseGain });
    }
  }
  return out.sort((a, b) => a.frame - b.frame);
}
```
Extend `SfxCuePlan` with the two optional fields. `schema.ts` must not import `sfx.ts` (it does not; `sfx.ts` imports a type from `schema.ts`, erased at runtime). Run the Step 1 tests: pass.

- [ ] **Step 3: `bedVolume` + test.** In `timeline.ts`:

```ts
/** A bed's level at its own frame: ramps up over `fade` frames at the start and down over `fade` at the end. */
export function bedVolume(frame: number, total: number, fade: number): number {
  if (fade <= 0) return 1;
  return Math.max(0, Math.min(1, frame / fade, (total - frame) / fade));
}
```
Test (beside the existing timeline tests): `bedVolume(0,90,15)=0`, `(15,90,15)=1`, `(45,90,15)=1`, `(90,90,15)=0`, `(80,90,15)≈0.667`, `fade 0` → 1.

- [ ] **Step 4: Props and `AudioLayer`.** Extend `SfxCue` in `props.ts` (fields above, optional, with a doc line: "a cue with `durationFrames` is a bed: it loops under that many frames"). In `AudioLayer.tsx`, keep hits as they are and add the bed branch:

```tsx
{audio.sfx.map((cue, i) =>
  cue.durationFrames ? (
    <Sequence key={i} from={cue.frame} durationInFrames={cue.durationFrames} layout="none" name={`sfx ${i + 1}`}>
      {/* the volume curve gets the frame inside this Sequence; "extend" keeps it running across loops */}
      <Audio src={media(cue.src)} loop loopVolumeCurveBehavior="extend" volume={(f) => cue.gain * bedVolume(f, cue.durationFrames!, cue.fadeFrames ?? 0)} />
    </Sequence>
  ) : (
    <Sequence key={i} from={cue.frame} durationInFrames={fps * 2} layout="none" name={`sfx ${i + 1}`}>
      <Audio src={media(cue.src)} volume={cue.gain} />
    </Sequence>
  ),
)}
```
Update the component's doc comment (beds, hits at most 1.9 s). Import `bedVolume`.

- [ ] **Step 5: Wire `assembleRenderProps`** (`src/stages/build-render-props.ts`). Replace the `sfx:` expression:

```ts
const script = m.script; // (use whatever field `requireScript(m)` reads; a draft preview has it too; absent = no scene cues)
const edit = m.request.render.sfx ? sfxCues(boundaries, { hook: hook !== null, gain: m.request.render.sfxGain }) : [];
const own = m.request.render.sfx
  ? sceneSfxCues(
      scenes.map((s, i) => ({ from: s.from, frames: frames[i], lead: i === 0 ? 0 : boundaries[i - 1].halfWindow, cues: script?.scenes[i]?.soundCues ?? [] })),
      edit,
      { gain: m.request.render.sfxGain, fps },
    )
  : [];
// ...
sfx: [...edit, ...own].sort((a, b) => a.frame - b.frame).map((c) => ({
  src: publish(`sfx/${SFX[c.sound].file}`, join(opts.sfxDir, SFX[c.sound].file)),
  frame: c.frame,
  gain: c.gain,
  ...(c.durationFrames !== undefined ? { durationFrames: c.durationFrames, fadeFrames: c.fadeFrames } : {}),
})),
```
(Rename the local `edit` to `editCues`: `edit` is already the edit preset's name in `buildRenderProps` and a shadow would confuse. Check the real name of the manifest's script field with `grep -n "requireScript" src/stages/require.ts` and use it; do not call `requireScript` if it throws on a manifest without a script.)

- [ ] **Step 6: Tests for the wiring** (in the existing `build-render-props.test.ts`): (a) a manifest whose script has `soundCues: [{sound:"door", at:"middle"}, {sound:"rain", at:"start"}]` on scene 2 gets a `door` cue at the scene's midpoint and a `rain` cue with `durationFrames` = the scene's remaining frames, both with `src` under `sfx/` and registered in `files`; (b) `render.sfx = false` → `audio.sfx` is `[]`; (c) a manifest without `soundCues` yields exactly the cues it yielded before (compare to `sfxCues(...)` output, mapped); (d) at `fps: 60` the door cue's frame is the same *second* as at 30 (frame ×2). Reuse that file's existing manifest helpers.

- [ ] **Step 7: Run** `npx vitest run test/unit/scene-sfx.test.ts test/unit/sfx-cues.test.ts <build-render-props test> <timeline test> web/test/restyle.test.ts web/test/names.test.ts`. All pass (the restyle test proves the landing page's restyling still equals `previewProps`). `npm run typecheck`. Then render check, free: `npm run flowchain -- rerender 20261029-135614-f9188a` is allowed (rerender is free) but that run has no cues; instead run `npx vitest run test/media/remotion-render.test.ts` alone (slow, ≈ 140 s; known to time out under load, re-run alone).

- [ ] **Step 8: Commit**

```bash
git add src test web
git commit -m "feat: a scene's named sounds play at its start, middle or end, a texture runs under the whole scene, and the edit's own sounds win any clash"
```

---

### Task 4: Documents

**Files:**
- Modify: `docs/superpowers/specs/2026-10-29-phase12-scene-sfx-design.md`, `README.md` (the sound-effects part), `CLAUDE.md` (layout line for `src/media`/`assets/sfx`? and the specs table row)

- [ ] **Step 1: Spec.** Status → "built; the owner's steps (§6) are not done". Fix §1 "about 24" to "17 (14 new)". Add a closing section **§7 What was found and changed** listing the rulings of this plan (library size; hits ≤ 1.9 s; `at` ignored for beds; clash against the edit's sounds only) and anything a task found.
- [ ] **Step 2: README.** In the part that describes sound effects, say: the script may name up to two sounds a scene would have; the list; `--no-sfx` silences all; `make:sfx` rebuilds the library (owner's click); how to retune a recipe.
- [ ] **Step 3: CLAUDE.md.** Add the row `Scene sound effects: a closed synthesized library the script names | 2026-10-29-phase12-scene-sfx-design.md` to the specs table and one sentence under "How the pipeline is built": a scene's sounds come from `SCENE_SOUNDS` only; a new sound needs its recipe, its table entry, its `about` line and a `PROMPT_VERSION` bump.
- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run test/unit` once; then commit:

```bash
git add docs README.md CLAUDE.md
git commit -m "docs: the phase 12 spec and the manuals say how a scene's sounds are named, played and added"
```

---

## Self-review

- **Spec coverage:** §1 library/vocabulary/kinds → Task 1; §2 schema, prompt, version, optional field, cue frames, conflicts, beds, props, `--no-sfx`/gain → Tasks 2–3; §3 cost/studio/names → Global Constraints (no studio change; `names.test.ts` run in Task 3); §4 tests → each task's tests (closed vocabulary, prompt carries entries, `sceneSfxCues` cases, byte-identical rebuild, compat); §5 out of scope → not built; §6 owner steps → Task 4 README. Frozen-with-script: cues live in `script.scenes`, which the manifest already freezes; no new hash input is needed because a changed script is a changed `script` stage input — the implementer of Task 2 confirms by reading how `script` is hashed and records the finding in the spec §7 if it differs.
- **Placeholders:** the recipes are first formulas flagged "tune by ear" (a real owner step), each with a concrete expression; the only "find the real name" instructions are for a file path and a manifest field that the implementer must read, with the command to find them.
- **Types:** `SfxName`, `SfxKind`, `SfxCuePlan`, `SceneSfxInput`, `SceneSoundCue`, `bedVolume`, `SfxCue.durationFrames/fadeFrames` are named identically wherever used.
