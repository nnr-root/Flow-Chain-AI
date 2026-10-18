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

### 3.1 What the model pages say (read on 2026-10-18 by task 1)

Read without a token or a login. Sources, each at the revision named: the model card as rendered on
`https://huggingface.co/black-forest-labs/flux-3-image-klein` (its raw `README.md` answers 401: gated); the Hub API
`https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein?blobs=true` (answers 200 with the full file
list, sizes and LFS hashes; `"gated": "auto"`); BFL's reference code `github.com/black-forest-labs/flux-3-image-klein`
at commit `bfc8889a4497f846416f253a3972a1941ac698b9` (`README.md`, `scripts/cli.py`, `src/flux3/pup.py`); the
upsampler's card and files at `huggingface.co/black-forest-labs/flux-3-image-klein-pup` revision
`3f3edb52b2c55de0d49feab28598b68f7f8e4830` (not gated, Apache 2.0); and `diffusers` on GitHub at commit
`b800f828f3951c4d206e154411bcbfa693cd322e` (`docs/source/en/api/pipelines/flux3.md`,
`docs/source/en/quantization/bfl.md`, `src/diffusers/modular_pipelines/flux3/`). Files of the model repository other
than the listing (`modular_model_index.json`, `config.json`, `manifest.json`, the variants' manifests) answer 401
and were **not read**.

| | |
|---|---|
| `diffusers` with `ModularPipeline` | `ModularPipeline` itself is in `diffusers==0.41.0` (the pinned version, and the newest on PyPI on 2026-10-18: `modular_pipelines/modular_pipeline.py:1676`), but **no release has FLUX 3**: 0.41.0's `modular_pipelines/` has no `flux3` folder. FLUX 3 is on `main` only, added by `7ecb1e1b4fe5` "Flux3 image (#15046)" (2026-10-15) and `d42ebf9c6e0b` "FLUX.3 prompt upsampler block (#15058)" (2026-10-16); `main`'s `setup.py` still says `version="0.41.0.dev0"`. The model card says verbatim: `pip install git+https://github.com/huggingface/diffusers.git`. The worker pins `diffusers @ git+https://github.com/huggingface/diffusers.git@b800f828f3951c4d206e154411bcbfa693cd322e` (main when read). Its FLUX 3 modules import `Qwen3_5ForConditionalGeneration` and `Qwen3VLForConditionalGeneration` from `transformers` at module level; `Qwen3_5` first appears in `transformers` v5.2.0 (absent in v5.1.0 and every 4.x), so the worker needs `transformers>=5.2` (the upsampler was saved with 5.8.1). Minimum torch on that commit: `torch>=2.6`. |
| Load and call | The model card's snippet and the diffusers docs' call for several references, verbatim, are in "Load and call" below the table. Argument names (diffusers docs and the `Flux3DistilledAutoBlocks` docstring at the pinned commit): prompt `prompt` (one per call); references `image` ("`Image \| list`, *optional*: The reference image(s) of the edit, at most 10"); size `height`, `width` ("defaults to None or 1024, depending on the workflow ... defaults to the first reference image's aspect ratio at the default area", i.e. one megapixel); steps `num_inference_steps` ("`num_inference_steps` defaults to 16; the model is trained for 4 to 16 steps"); seed `generator`; output `output="images"` (a call returns the pipeline state). The distilled pipeline "has no `guider` and does not take `negative_prompt`". References: "Every reference keeps its own resolution (center-cropped to the 16-pixel grid; references above 16 megapixels are downscaled first)". |
| Switching the built-in upsampler off | There is **no keyword argument**. At the pinned `diffusers` commit the upsampler is a block of the pipeline: `Flux3DistilledAutoBlocks` runs `("prompt_upsampler", Flux3AutoPromptUpsampleStep())` first, and its docstring says "`prompt` goes through the prompt upsampler first; pop the `prompt_upsampler` step to encode it as given." The docs' way, verbatim, is in "Switching the upsampler off" below the table. "A pipeline built without the upsampler step ... loads about 20 GB." **Contradiction:** the model card says the opposite ("Diffusers runs neither on its own"; "a separate 9B model ... that the pipeline does not run on its own") and calls `pipe(prompt=caption, ...)` without popping. Which one the repository's `modular_model_index.json` follows was not readable (401). So the worker pops the block when present (`blocks.sub_blocks.pop("prompt_upsampler", None)`) and never loads the upsampler's components. In BFL's reference CLI the switch is `--no-pup` ("send the prompt as typed instead of upsampling it first; only for a prompt that already is an upsampler caption"); in `flux3.generate.generate` it is `pup=False`. |
| Revision to pin | `337337621b8526e120f2275d250242f4a6bedd75` (`black-forest-labs/flux-3-image-klein`, `lastModified` 2026-10-16T04:58:03Z) |
| Files, sizes, SHA-256 | See the table below. |
| Precision the worker loads | **BF16**, through the pipeline as above, on a card of **48 GB**. The model card's own words on hardware are only: "Peak GPU memory with the reference code, B200, 1024x1024, prompt upsampler off: 31 GB in BF16, 26 GB in FP8, 25 GB in NVFP4. The prompt upsampler adds about 28 GB on an 80 GB GPU." and "Quantized packages need a loader that supports their format; their file size is not a measure of total GPU memory use." The card does not say whether FP8 or NVFP4 run on non-Blackwell cards (so the plan's rule for that case applies: BF16). Elsewhere: BFL's reference README says "`--fp8` needs Ada, Hopper or Blackwell; `--nvfp4` needs Blackwell", measured "on a B200 at 1024x1024, text-to-image and an edit with one reference"; the diffusers quantization guide says `fp8r` runs fused on "CUDA GPU with compute capability 8.9 or higher" and `nvfp4` needs "Blackwell GPU (compute capability 10.0 or higher), a CUDA toolkit with `nvcc`, and `flashinfer-python` with `flashinfer-cubin` at the same version", and that "Only loading prequantized checkpoints is supported; pipeline-level loading is not" (they load through `Flux3Transformer2DModel.from_single_file(..., quantization_config=BFLQuantizationConfig(compute_dtype=torch.bfloat16))`). Why BF16: 31 GB peak leaves no margin on a 32 GB card, the figure was measured with BFL's code (not diffusers) and one reference (we send up to three), and BF16 is the one path the card's own snippet loads. `fp8r` (26 GB, compute capability 8.9 or higher) is the lever to a 32 GB card after the owner has measured BF16 (§8). |
| Upsampler instructions | **Public** (Apache 2.0): `system_prompts.json` in the upsampler repository (12,602 bytes, SHA-256 `b5da3ed8bc04ab59dbdb747930f7dbff847e868903fed8028f85ee1a4ac82fb4`), byte-identical to `src/flux3/pup_prompts.json` in the reference code and to `SYSTEM_PROMPTS` in diffusers' `prompt_upsampler.py`. Keys: `t2i`, `i2i`, `t2i_bbox`, `i2i_bbox`. The model card, verbatim: "Any other LLM can take its place: give it system_prompts["t2i"] (or "i2i" with the references) as the system prompt, the request as the user message, and pass the caption it returns as prompt." The `t2i` and `i2i` texts, the edit's user message and the decoding are copied below. So Gemini can take the upsampler's place; the fallback of §3 (hosting the 9B model) is not needed for Task 8. |

**Load and call**, from the model card ("Using with Diffusers"), verbatim; `upsample` is the card's own Transformers
function around the 9B upsampler, which the studio replaces with Gemini (Task 8):

```python
pipe = ModularPipeline.from_pretrained("black-forest-labs/flux-3-image-klein")
pipe.load_components(dtype=torch.bfloat16)
pipe.to("cuda")

caption = upsample('A chunky knitted diorama: three white cable-knit icebergs with tiny pale blue houses, a cream banner embroidered "KNITTED ICEBERG VILLAGE", a giant magenta knitted whale tail bursting from a yarn sea')
image = pipe(prompt=caption, generator=torch.Generator().manual_seed(1), output="images")[0]
image.save("knitted.png")

night = pipe(
    prompt=upsample("the same scene at night under a knitted full moon, embroidered stars above the peaks", [image]),
    image=image,
    generator=torch.Generator().manual_seed(1),
    output="images",
)[0]
night.save("knitted_night.png")
```

Several references and an explicit size, from the diffusers docs (`flux3.md`, "Image-to-image"), verbatim:

```python
combined = pipe(
    prompt="the fox from the first image sitting on the wooden bench from the second image",
    image=[image, bench],
    height=768,
    width=1360,
    output="images",
)[0]
```

**Switching the upsampler off**, from the diffusers docs ("Prompt upsampling"), verbatim; written for the base
repository, and the distilled one "loads like the base model":

```python
blocks = ModularPipeline.from_pretrained("black-forest-labs/flux-3-image-klein-base").blocks
pup_block = blocks.sub_blocks.pop("prompt_upsampler")

pup = pup_block.init_pipeline("black-forest-labs/flux-3-image-klein-base")
pup.load_components(dtype=torch.bfloat16)
pup.to("cuda")
caption = pup(prompt="A red fox in a snow-covered forest clearing at golden hour", output="prompt")

pipe = blocks.init_pipeline("black-forest-labs/flux-3-image-klein-base")
pipe.load_components(dtype={"vae": torch.float32, "default": torch.bfloat16})
pipe.to("cuda")
image = pipe(prompt=caption, generator=torch.Generator().manual_seed(0), output="images")[0]
```

The worker takes from this the first two lines and the last four (no `pup` pipeline), with
`black-forest-labs/flux-3-image-klein` (or its local copy at the pinned revision) for the repository, and
`dtype=torch.bfloat16` as the card's distilled snippet loads it. Whether the distilled model wants its VAE in float32,
as the base example loads it, is not stated.

**Files the worker downloads** (diffusers layout, revision `337337621b8526e120f2275d250242f4a6bedd75`; 20,320,964,852 bytes
in all). Sizes and SHA-256 are the Hub API's `size` and `lfs.sha256`; the API gives no SHA-256 for a file not stored in
LFS, so for those the git blob id (SHA-1 of the git blob) is given. The download is
`allow_patterns=["modular_model_index.json", "transformer/*", "vae/*", "text_encoder/*"]`. Not downloaded:
`model.safetensors` (11,097,404,512 bytes, BFL's single-file BF16 package, the same SHA-256 as `flux3-image-klein-bf16.safetensors` in the ComfyUI repository), `ae.safetensors`,
`config.json`, `manifest.json` (the reference code's layout, which the card's own `snapshot_download` fetches),
`variants/*`, and images.

| File | Bytes | SHA-256 (or git blob) |
|---|---|---|
| `modular_model_index.json` | 2,115 | not given (not in LFS); git blob `b0ce87edf5923b7ea2dbde5bf182a69c90d522a5` |
| `text_encoder/LICENSE` | 11,357 | not given (not in LFS); git blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` |
| `text_encoder/README.md` | 7,133 | not given (not in LFS); git blob `542417095b66d3fc13be22bbf6722928787b8ef4` |
| `text_encoder/chat_template.json` | 5,502 | not given (not in LFS); git blob `e49e75bdda104c8de941eb20e0b3765184fb27bc` |
| `text_encoder/config.json` | 1,505 | not given (not in LFS); git blob `22be8bb79043d39840ca5e70d7a2dab80311602c` |
| `text_encoder/generation_config.json` | 269 | not given (not in LFS); git blob `e116347d7ef42621c7a5957f82c015c38d939c1f` |
| `text_encoder/merges.txt` | 1,671,839 | not given (not in LFS); git blob `20024bfe7c83998e9aeaf98a0cd6a2ce6306c2f0` |
| `text_encoder/model-00001-of-00002.safetensors` | 4,967,229,296 | `30a01a0556622645a3cce87b655bbbbbc1f170c196099f1b666c93202c3339a9` |
| `text_encoder/model-00002-of-00002.safetensors` | 3,908,490,048 | `046296a2a387efb43b0c997d5833c789604d168834f6e0d3064bf7bb13d002a6` |
| `text_encoder/model.safetensors.index.json` | 64,742 | not given (not in LFS); git blob `3b52de97496e2f4501dfa92a87642f60db3e22a1` |
| `text_encoder/preprocessor_config.json` | 390 | not given (not in LFS); git blob `2ea84a437d448ff71b08df68fdd949d5cc4ebb64` |
| `text_encoder/tokenizer.json` | 7,032,403 | not given (not in LFS); git blob `c6cc1014128b19d1fc46b1d30a23e3b1d35db421` |
| `text_encoder/tokenizer_config.json` | 10,868 | not given (not in LFS); git blob `d3d3763207692c78780f4bf42d4dadf49a5c8012` |
| `text_encoder/video_preprocessor_config.json` | 385 | not given (not in LFS); git blob `3ba673a5ad7d4d13f54155ecd38b2a94a6dac8fe` |
| `text_encoder/vocab.json` | 2,776,833 | not given (not in LFS); git blob `4783fe10ac3adce15ac8f358ef5462739852c569` |
| `transformer/config.json` | 436 | not given (not in LFS); git blob `84626bbb88a60c8904542727b500b6cdce2b918c` |
| `transformer/diffusion_pytorch_model-00001-of-00002.safetensors` | 9,907,529,352 | `4f01de41470090586d7a25aa4aec93987724eae45db45b68de2b3f566f438a8b` |
| `transformer/diffusion_pytorch_model-00002-of-00002.safetensors` | 1,189,878,064 | `6f6217ab2c7ce5ef177ec202f79d4c2ddab78111c4645030c8828ec615d5f02c` |
| `transformer/diffusion_pytorch_model.safetensors.index.json` | 37,951 | not given (not in LFS); git blob `8f2daa0415e6bea35c8f7fb643058554050b3ed0` |
| `vae/config.json` | 808 | not given (not in LFS); git blob `2410d0e0a4b381022ad7ab0ac3007c3c8a5d010c` |
| `vae/diffusion_pytorch_model.safetensors` | 336,213,556 | `d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5` |

For the record, the FP8 lever (not downloaded now): `variants/fp8r/model.safetensors` 6,270,949,144 bytes, SHA-256
`30054053f630725b488aead9a81b422793cee18027856a16bd17b902ad612018`; `variants/nvfp4/model.safetensors` 5,277,674,144
bytes, SHA-256 `30b110b0675249cf0461247b4613240312c8064ccc4ef486f4d025c9ff65fb83`. There is no `tokenizer/` or
`scheduler/` folder in the repository; which folder each component loads from is in `modular_model_index.json`, which
answers 401 without a token (not read).

**The upsampler's `t2i` system prompt**, verbatim from `system_prompts.json`:

```text
You are the prompt upsampler of a text-to-image model. Expand the user's short request into ONE detailed, self-contained caption: the exact text the image model receives. Output only the caption, with no greetings, explanations, refusals, questions, Markdown, headings, JSON, coordinates, ids or angle-bracket tokens, and no quotes around it. If the input is not clearly an image request, caption a visualization of its concept. The request may begin with a "TARGET CANVAS: W:H" line: compose for that canvas (wide spreads content sideways, tall stacks it) and never mention the ratio or the canvas.

Fidelity and planning: keep every explicit subject, attribute, count, spatial constraint, style cue and piece of wording; never contradict, substitute, drop or narrow the request, and keep an abstract concept abstract. Decide everything left open as ONE concrete, consistent plan; never offer alternatives or hedge. Never re-express a stated constraint through another mechanism; add camera optics (depth of field, bokeh, blur) only when asked for or implied. Without a stated style, plan an actual photograph and open with the medium convention ("Full-color outdoor photograph, ...", "Full-color indoor photograph, ...", "Studio photograph, ...", "Close-up photograph, ..."); keep "Photorealistic" for renders, and turn "photorealistic" or "realistic" requests for photos into the photograph convention. Give a photograph a few ordinary, non-ideal specifics drawn from the scene's own objects instead of the stock-photo ideal. Do not invent names, brands, logos or celebrities; keep user-named ones. A long request keeps its content but not its wording: drop appraisal and sales vocabulary, turn moods into observable physical facts, and add only new concrete content with positions. Time of day is lighting, not rendered text.

Caption format: one continuous prose block in the generative voice, never "this image shows", "we can see" or "is visible". Lead with medium and style, then scene, lighting and camera, then the subjects with concrete colors, materials and state. Every person in focus gets an observable profile: ethnicity, gender, age range, skin tone ("fair skin", "brown skin"), hair and clothing. Make the layout reconstructable from words: frame-relative positions (frame-left, frame-right, upper, lower, foreground, midground, background), sentence-initial anchors ("On the left, ...", "In the background, ..."), relations (holds, faces, behind) and a consistent order; describe up to about ten instances one by one, beyond that give the exact count and arrangement. Out-of-focus or distant planes are shapes, colors and silhouettes, never identities or readable text, and the background takes about a sixth of the caption. Be definite: no hedging adverbs, no quality or emotion judgments, no closing sentence about mood; state negations as what is present. Rendered text: transcribe every wording verbatim inside double quotes in its original language and script, keep the line breaks of multi-line text, and give its typography, color and placement; author concrete, domain-correct wording when the request needs text it does not supply, and name canonical structures (calendar, keyboard, periodic table) exactly with their full layout. All prose is English; only quoted text keeps its language. Typical length is 100 to 350 words, more for complex scenes.

Output only the caption.
```

**The upsampler's `i2i` system prompt**, verbatim (`\n` in it is the two characters a backslash and `n`, as in the
file's decoded string):

```text
You are the prompt upsampler of an image-editing model. You see the reference image(s), attached in order (the first image, the second image, ...), and the user's short request. Expand it into ONE detailed, self-contained instruction: the caption the editing model receives together with the same images. Output only the instruction as one continuous English prose block, with no greetings, explanations, Markdown, JSON, coordinates, ids or angle-bracket tokens. Read a vague or conversational request as the most plausible edit of the supplied images.

Pick the voice by task shape. When one reference stays and gets bounded changes, write an imperative editing instruction on it ("Remove the ...", "Change the ... to ...", "Zoom in on ..."); a whole-image transformation opens with its scope ("Convert the entire image into ...", "Apply a ... filter over the entire scene", "Horizontally flip the entire image so that ...", "Shift the camera viewpoint to ...", then where the major elements should now be). When the references are drawn into a newly composed frame (combining subjects, a new scene, a garment, object or style donor), write a generation request ("Create a photograph of ...", "Create an anime-style illustration of ...", "Generate a new image featuring ...") that says what to take from each image, by ordinal, and what is newly generated.

Keep every explicit edit, constraint, count, position, style cue and piece of wording, and decide what is left open as one concrete plan. Ground everything in what is actually visible: identify each referent unambiguously by its real appearance, never mention content that is not there, and use every image the user attached. State every end state concretely (which color, how large, which pose, which material) and give new content enough appearance to be generated. Cover the knock-on effects of the change (shadows, reflections, occlusion, perspective, scale, lighting) and say what fills a removed region. A zoom-in names what stays in frame and which neighbors are cropped out; an outpainting continues the scene in the same medium. Describe the change, not the whole scene, and close an editing instruction with one compact clause naming what stays unchanged; transferred people keep their identity, face and accessories unless asked otherwise. Transcribe on-image text verbatim in its original language inside double quotes, with line breaks as \n, and match the original font, size and color when replacing it. Name recognizable public figures, brands and landmarks you can see. Directions are frame-relative; use no evaluative or quality words. Typical length is 50 to 150 words.

Output only the instruction.
```

**The edit's user message.** The images come first in the user message, one `{"type": "image", ...}` per reference,
then this text (reference code `I2I_SCAFFOLD[False]` in `src/flux3/pup.py`, and the upsampler card), where
`{instruction}` is the request:

```text
Reference images follow in order (the first image, the second image, ...).
User request: {instruction}
Output the caption.
```

Text-to-image sends the request alone as the user message. The `t2i` prompt allows an optional first line
`TARGET CANVAS: W:H` ("compose for that canvas ... and never mention the ratio or the canvas"); no code read adds it.

**Decoding**, upsampler card: "greedy, `top_p` 0.95, `top_k` 20, presence penalty 1.5 for text-to-image and 0 for
edits"; reference code `SAMPLING = {"temperature": 0.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "max_tokens": 3584}`,
`PRESENCE_PENALTY = {"t2i": 1.5, "i2i": 0.0}`; thinking off (`enable_thinking=False`). The upsampler resizes references
before it sees them: at most 1024² pixels for one reference, 724² for two, 512² for three to ten (`MAX_PIXELS_BY_REFS`).

**A second set, for external models.** BFL's reference README says, verbatim: "An external vision-language model can
also write the caption in place of the upsampler: give it the [system prompts](src/flux3/pup_prompts_external_vlm.json)
and pass its answer with `--no-pup`." That file (`src/flux3/pup_prompts_external_vlm.json` at commit
`bfc8889a4497f846416f253a3972a1941ac698b9`, 103,088 bytes, SHA-256
`361bb6e081d50e54a3dee9abf26327436a9386c83465f881c7848989232028be`) has the same four keys and much longer texts
(`t2i` 46,615 characters, `i2i` 6,194), each opening "Your name is FLUX 3, developed by Black Forest Labs." It is
too long to copy here; Task 8 chooses between it and `system_prompts.json` (the model card names the latter), and
fetches the file it chooses at that commit and checks the hash.

**Read against §2.** Parameters: the card says "5.6B" for the transformer; the Hub API counts 5,548,681,984 BF16
parameters and the diffusers docs say "5.5B". Steps: 16, and "trained for 4 to 16 steps". The base model's guidance:
3.5 on the card and in diffusers, "CFG 4" in BFL's README and `cli.py`. Memory: as §2 (31/26/25 GB), measured on a B200
with BFL's code; diffusers: "Loading everything in bf16 takes about 39 GB of weights ... A pipeline built without the
upsampler step ... loads about 20 GB". Reference limit: 10, confirmed in every source. License: as §1. Access:
gated with automatic approval (`"gated": "auto"`). Upsampler: 18.8 GB BF16, Apache 2.0, not gated.

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

## 12. What the plan found and changed (a later section wins)

- `reframe` is optional in Gemini's answer too (not required): an answer without it means false, so no fake script has to change.
- A scene's reframe is normalised in code after the answer (false on scene 1, on a `continue` scene, on the first scene of a part, and everywhere when the run may not reframe), never sent back for a paid retry.
- `FLOWCHAIN_CUT_REFERENCES` is `on` or `off`, **default off**; the run freezes it as `request.cutReferences`. The owner sets it to `on` after `eval:cuts` shows a gain.
- `FLOWCHAIN_IMAGE_MODEL=klein4b` forces the 4B profile (the fallback lever); `flux3` insists on the new one and refuses to start a run if it is not ready.
- The Hugging Face token reaches the worker as a RunPod secret (`flowchain_hf_token`) the deploy script creates from the owner's shell `HF_TOKEN`; the volume grows to 80 GB when the FLUX 3 endpoint is configured.
- `eval:cuts` takes two finished runs (made with references on and off) and is free: it reads files and calls ffmpeg.

Found by task 1 (§3.1), replacing what §3 assumed:

- **`diffusers`:** no release has FLUX 3, though 0.41.0 has `ModularPipeline`. The FLUX 3 engine's image pins
  `diffusers` to the git commit `b800f828f3951c4d206e154411bcbfa693cd322e` and `transformers>=5.2`. The 4B worker keeps
  `diffusers==0.41.0` and is not rebuilt; if the two engines ever share one image, the 4B is retested on the commit.
- **The GPU:** the worker loads BF16 on a 48 GB card, not FP8 or NVFP4 on a 32 GB one (the card does not say what
  runs where; 31 GB is no margin on 32 GB). `fp8r` on a card of compute capability 8.9 or higher is the later lever,
  after the owner measures.
- **The pipeline's own upsampler is a block, switched off by removing it** (`blocks.sub_blocks.pop("prompt_upsampler", None)`,
  then `blocks.init_pipeline(...)`), not by an argument. The worker never loads the 9B upsampler.
- **The worker always passes `height` and `width`:** without them an edit is made at one megapixel in the first
  reference's shape, which is the anchor or the portrait, not the video's frame.
- **The upsampler's instructions are public** (`system_prompts.json`, Apache 2.0, copied in §3.1), and the model card
  names "any other LLM" as a replacement. Task 8 uses them with Gemini; hosting the 9B upsampler is not needed.
