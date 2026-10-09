"""The picture model, loaded once per worker. Nothing here writes a prompt or a file name to a log (phase 5 spec §8)."""

_pipe = None


def load(model_dir):
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import Flux2KleinPipeline

        _pipe = Flux2KleinPipeline.from_pretrained(model_dir, torch_dtype=torch.bfloat16, local_files_only=True).to("cuda")
    return _pipe


def picture(model_dir, prompt, width, height, seed, reference_path, out_path):
    """Makes one picture and saves it as PNG. With `reference_path`, the character in that portrait is kept."""
    import torch
    from PIL import Image

    pipe = load(model_dir)
    extra = {}
    if reference_path is not None:
        extra["image"] = [Image.open(reference_path).convert("RGB")]
    # the distilled model's own settings: four steps, no guidance
    image = pipe(
        prompt=prompt, width=width, height=height, num_inference_steps=4, guidance_scale=1.0,
        generator=torch.Generator("cuda").manual_seed(seed), **extra,
    ).images[0]
    image.convert("RGB").save(out_path, format="PNG")
