"""The FLUX 3 klein picture model, loaded once per worker (phase 10 spec §3.1). Nothing here writes a prompt or a file name to a log (phase 5 spec §8)."""

import os

_pipe = None
# the distilled model's own setting (spec §3.1: "defaults to 16; trained for 4 to 16 steps"), passed so a library default
# that changes cannot change the picture; the distilled pipeline has no guider and takes no negative prompt
STEPS = 16


def load(model_dir):
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import ModularPipeline

        # The pipeline's own prompt upsampler is a block that runs first; the client sends a prompt Gemini has already
        # upsampled, and a second pass would rewrite it (and load a 9B model). The diffusers docs remove the block
        # before building the pipeline (spec §3.1, "Switching the upsampler off"). model_dir is the volume's copy at the
        # pinned revision, so nothing is fetched.
        blocks = ModularPipeline.from_pretrained(model_dir).blocks
        blocks.sub_blocks.pop("prompt_upsampler", None)
        pipe = blocks.init_pipeline(model_dir)
        pipe.load_components(dtype=torch.bfloat16)
        # load_components() skips a component it cannot load and leaves it None; seen live, the tokenizer was one, and
        # the first picture failed in the text encoder. It is a processor whose files are in the text encoder's folder.
        if getattr(pipe, "tokenizer", None) is None:
            from transformers import AutoProcessor

            pipe.update_components(tokenizer=AutoProcessor.from_pretrained(os.path.join(model_dir, "text_encoder")))
        pipe.to("cuda")
        _pipe = pipe
    return _pipe


def picture(model_dir, prompt, width, height, seed, reference_paths, out_path):
    """Makes one picture and saves it as PNG. Each reference picture is passed, in order, as an image the model may draw on."""
    import torch
    from PIL import Image

    pipe = load(model_dir)
    extra = {}
    if reference_paths:
        extra["image"] = [Image.open(p).convert("RGB") for p in reference_paths]
    # height and width are always passed: without them an edit takes the first reference's shape at one megapixel
    image = pipe(
        prompt=prompt, height=height, width=width, num_inference_steps=STEPS,
        generator=torch.Generator().manual_seed(seed), output="images", **extra,
    )[0]
    image.convert("RGB").save(out_path, format="PNG")
