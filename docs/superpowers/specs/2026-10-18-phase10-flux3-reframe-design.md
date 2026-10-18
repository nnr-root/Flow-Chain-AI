# Phase 10 — FLUX 3 klein as the picture model, and cuts that feel related (reframe)

Date: 2026-10-18. Status: design approved section by section; not built.

## 0. Where this sits

Item 1 of the owner's five-item list (phase 9 spec §0): "clips that read as one clip". The owner said what looks
separate: **cuts feel unrelated** and **the look changes** between clips (not motion restarting). They chose a
cut that feels related **by video type** (documentary, story, pov: the same place from a new angle; explainer,
list and others: the same visual world), and chose to build it directly on **FLUX 3 klein** (several reference
images), skipping the free colour-matching step ("Approach A"). A is not blocked by this design and stays possible later.

Two decisions of the owner's, recorded because they carry risk the spec accepts:

- **Switch the picture model to FLUX 3 klein** although its license is not Apache (§1). The owner read the
  license text and chose it; the spec keeps the old model as a fallback so a revoked license is a config change.
- **Build the reference approach before measuring it.** The measurement becomes an acceptance gate (§7) that decides
  whether references are on by default.

## 1. The license, as read (2026-10-18)

Read from the model's `LICENSE.md` through a summarising fetch; the owner reads the file itself before relying on it.

- **FLUX Kommunity License v.1.0.** A "Qualifying User" is "you, if at any time you together with your affiliates'
  gross annualized revenue is less than US$5,000,000". A Qualifying User may "use Outputs, including Outputs from
  Derivatives, for commercial purposes, and you may access and use the FLUX Model and Derivatives in a production
  environment solely for the purpose of generating such Outputs".
- **No clause addresses hosting the model as a service for others.** The studio runs the model and sells the
  videos (Outputs); customers never receive the weights. That plausibly fits the output right, and is not granted in
  so many words. A written answer from BFL (https://bfl.ai/licensing) is the owner's to ask for.
- **§2.b:** a use not authorised "such as for a commercial activity" needs a license from BFL "in Company's sole
  discretion", possibly "a fee, royalty or other revenue share". Over US$5M revenue the studio needs one.
- **§2.e:** the user must "implement and maintain content filtering measures" **or** "ensure Output undergoes
  review for unlawful or infringing content before ... distribution". See §6.
- **§4.b:** the model, its Derivatives or any Output must not be used "to improve any other artificial intelligence
  model that performs any function similar to a FLUX Model". The studio feeds pictures to a video model as start
  frames; that is not a similar function, and the rule is recorded so nobody trains on the pictures.
- **§8.b:** BFL "may terminate this License, in whole or in part, at any time upon notice". On termination all
  use stops (§8.d). This is why the fallback in §3 exists.
- The note given to the owner ("may integrate into commercial products and SaaS", "or total investment raised",
  "Self-Hosted Commercial License") does not match the text above. This spec follows the text.

## 2. The model, as read

From the two model pages (`flux-3-image-klein`, `flux-3-image-klein-comfy`), also through a summary:

| | FLUX.2 klein 4B (today) | FLUX 3 klein |
|---|---|---|
| License | Apache 2.0 | FLUX Kommunity License v.1.0 |
| Pipeline | `Flux2KleinPipeline`, 4 steps, no guidance | `ModularPipeline.from_pretrained("black-forest-labs/flux-3-image-klein")`, 16 steps, no guidance (distilled); the base model is 50 steps, cfg 3.5 |
| GPU memory at 1024² | about 13 GB | 31 GB BF16, 26 GB FP8, 25 GB NVFP4, prompt upsampler off |
| Prompt upsampler | none | "Do not use the model without a prompt upsampler": `flux-3-image-klein-pup` (a 9B model, 6.7 to 18.8 GB; about +28 GB on an 80 GB card) "or custom LLM" |
| Text encoder | the pipeline's own | Qwen3-VL-4B-Instruct (4.9 to 8.9 GB) |
| Weights | the pipeline's own | transformer 5.3 to 11.1 GB; VAE `flux2-vae.safetensors` 0.3 GB |
| Reference images | one (our portrait) | up to 10 |
| Access | open | gated (accept terms, log in) |

## 3. The switch

- **A new image profile `runpod-flux3-klein@1`** next to `runpod-klein@1` in `src/image-profiles.ts`. A run keeps
  the profile it was made with (as today); old runs and their cache keys do not change. New runs use the new
  profile only while it is configured: its endpoint (`RUNPOD_PICTURE3_ENDPOINT`) is set **and** its rates are set
  in `prices.json`. Without both it is not offered. (No invented prices: a profile that cannot be priced cannot be
  chosen, and the customer is shown credits computed from rates the owner measured.)
- **A second engine in `worker-picture/`** (`engine_flux3.py` beside `engine.py`) on a **separate endpoint**. The 4B
  worker is not changed and stays deployable: it is the fallback if the license ends or the new model disappoints.
- **The prompt upsampler through Gemini.** The model card allows "custom LLM". The upsampler is a Gemini call kind
  of its own, `upsample`, with its prompt in `src/providers/gemini.ts` under `PROMPT_VERSION` and eval cases (phase
  9 spec §4, §6). Its exact instructions are taken from BFL's repository during task 7; if they cannot be
  reproduced with Gemini, the fallback is hosting `flux-3-image-klein-pup` on the same endpoint (about +28 GB), and
  this section is amended before any deploy. The upsampled prompt is never shown to a customer or logged (phase 5 §8).
- **The GPU:** a card of at least 32 GB, with the FP8 or NVFP4 weights. Which card, and the prices, are the
  owner's to set after measuring (§8).
- **`diffusers`:** the Dockerfile's build-time check (`import … Flux2KleinPipeline`) is extended to the FLUX 3
  pipeline, so an image whose library lacks it is not pushed. Whether the pinned `diffusers==0.41.0` ships
  `ModularPipeline` is checked in task 1 in a scratch virtual environment (free); if it does not, the pin moves and
  the 4B worker is retested.
- **Names:** "FLUX", "klein" and the profile id join `INTERNAL_NAMES` (`web/lib/engines.ts`); `names.test.ts`
  keeps them off every customer page (phase 5 §7).

## 4. Reframe cuts

- A scene stays `shot: "cut"` and gains an **optional** `reframe: boolean`: "the same place and moment as the
  previous scene, from a new angle or distance". Because it is still a cut, `needsKeyframe` (`visual.ts:11`),
  `modes.ts:34`, `--shots` (`store.ts:189`), the parts rule (`script.ts:188`) and Mode 2 do not change.
- In Gemini's answer (`LlmSceneSpec`) the field is required, like `showsCharacter`; in the stored `Script` it is
  optional and absent means false, so old scripts keep their prompts and hashes. For a type that may not reframe,
  or a profile that takes one reference, the prompt tells the model to answer `false` for every scene.
- **Which types may reframe** (`src/formats.ts`, a new field `reframe: boolean`): `documentary`, `story`, `pov`
  yes; `explainer`, `countdown`, `motivational`, `myth-busting`, `versus` no; no type chosen: no. The script prompt
  offers `reframe` only to a type that may, and only when the run's image profile takes several references.
- **Validation:** `reframe: true` is refused on scene 1, on a `continue` scene and on the first scene of a part
  (a part is written without seeing the part before it); the validator sends the answer back with the reason, as
  for other rules. The scene's `imagePrompt` still describes the new view.

## 5. References

- **What a keyframe is conditioned on** (at most 3 of the 10): the character portrait where the scene shows the
  character (as today); the **look anchor**, the run's first keyframe, for every later keyframe, to share light,
  palette and grain; and for a `reframe` scene, **the previous scene's keyframe**, meaning the most recent keyframe
  in the chain. A keyframe exists before any clip, so keyframes stay independent of clips and the worker's early
  start (`warmClipsEarly`) still works. The cost is a slight mismatch with the drifted last frame of Wan's clip.
- `referencesFor(manifest, scene)` is a pure function returning the ordered list, empty for a profile that takes
  one reference. `ImageRequest` gains `referenceImagePaths?: string[]`; `referenceImagePath` stays for the old
  profiles.
- **Transport:** a reference travels as base64 in the request body today (`runpod-providers.ts:162`). The new
  provider downscales each reference to at most 1024 px on its long side, JPEG, before sending; if the body would
  still pass RunPod's limit, references go through R2 by URL, as clips do (phase 5 §8). The worker removes what it
  fetched.
- **Cache keys:** the keyframe's inputs gain the SHA-256 of each reference, only when there are any, so every run
  without references keeps its key (the existing rule in `keyframes.ts:45`).
- **The copying risk:** the worker's prompt tells the model to take light and palette from the anchor and not to
  copy objects, poses or people (the phase 5 spec §9.12 found klein copies what it is shown). §7 measures it.

## 6. Safety

- **Content check (§2.e).** Every keyframe the new profile makes goes through the picture check (`inspect`) with
  one more fault: unlawful, unsafe or infringing content. That is a Gemini prompt change (version bump, eval
  cases). Whether this satisfies §2.e is the owner's decision; the spec does not claim it does.
- **Copy check.** `InspectRequest` gains optional `references: string[]`; when present the check also looks for
  "an object, pose or person copied from a reference". A flagged keyframe is made again with a new seed, as
  malformed ones are (phase 8 §9, at most twice).
- A key or a prompt is never logged; an upsampled prompt is never stored in the manifest.

## 7. Testing and the acceptance gate

All free, against stand-ins: the old profile's keys unchanged (`compat.test.ts` untouched, plus a new test pinning
a run without references); profile selection from the environment and `prices.json`; `referencesFor` (order, cap,
none for the old profile); the type table for every type; the validator for `reframe`; the script prompt (only
offered to a type that may); the worker's engine and payload contract with the pipeline stubbed (`npm run
test:worker`); provider transport (downscale, size); the extended `inspect` with the fake LLM; `names.test.ts`.

**The cuts comparison (`npm run eval:cuts`, the owner's command).** The same script and seed made twice, with and
without references; scored on look consistency (a pure, unit-tested colour-statistics distance between keyframes)
and copy faults (the extended `inspect`). Output goes to `eval-out/` (git-ignored). References are **on by
default only after** it shows a gain in consistency without more copy faults; the config flag
`FLOWCHAIN_CUT_REFERENCES=off` turns them off.

## 8. What only the owner can do

In order: accept the model's terms on Hugging Face and give a token; build the worker image and deploy the new
endpoint and seed the volume (`runpod:deploy`, `fetch-models`); measure seconds per picture and the card's price and
set them in `prices.json`; run `eval:cuts`; decide whether references are on; optionally ask BFL in writing about
hosting for customers. None of these is run by an agent (CLAUDE.md, "Rules that are never broken").

## 9. Order of work (one task and one commit each, a reviewer after each)

1. This spec; check `ModularPipeline` in the installed `diffusers` in a scratch venv.
2. The profile, the environment and `prices.json` gating, `INTERNAL_NAMES`, names test.
3. The worker's FLUX 3 engine and its multi-reference payload contract.
4. `referenceImagePaths`, the transport and the cache keys.
5. `referencesFor` and the keyframes stage.
6. `reframe` (schema, type table, script prompt and validator, `PROMPT_VERSION`, eval cases).
7. The prompt upsampler through Gemini.
8. The extended picture check and the content check.
9. The cuts comparison.

## 10. Risks

- `diffusers` may not ship `ModularPipeline` yet (task 1 finds out).
- 16 steps and a 32 GB-class card: slower and dearer pictures than today; the credit prices follow the measured rates.
- Reference copying is unmeasured until the owner's run; the gate protects the default.
- BFL can end the license on notice (§8.b); the 4B fallback is the answer.
- Gemini may not reproduce the upsampler's instructions; the fallback is hosting the 9B upsampler (§3).
- Base64 references may pass the request body limit (§5).
- The owner's revenue passing US$5M ends the Qualifying User right; the owner is told here once.

## 11. Not in scope

Colour-matching clips in `fit` (Approach A); bridged cuts (match cuts, flashes); changing Wan's clip conditioning;
the other three items on the list (upscale and 60 fps, lip sync and sound effects, trend discovery).
