"""Which SDXL checkpoint draws each style preset, and its negative prompt (2.4 spec §5.1)."""

REALVIS = "RealVisXL_V5.0_fp16.safetensors"
SDXL_BASE = "sd_xl_base_1.0.safetensors"
ANIMAGINE = "animagine-xl-4.0.safetensors"

CHECKPOINTS = {
    "photorealistic_8k": REALVIS,
    "cinematic_history": REALVIS,
    "cyberpunk": REALVIS,
    "dark_fantasy": REALVIS,
    "3d_render": SDXL_BASE,
    "anime": ANIMAGINE,
}

NEGATIVES = {
    REALVIS: "lowres, blurry, deformed, bad anatomy, extra fingers, text, watermark, logo, signature, jpeg artifacts",
    SDXL_BASE: "lowres, blurry, deformed, bad anatomy, text, watermark, logo, signature, jpeg artifacts",
    ANIMAGINE: (
        "lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, "
        "worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry"
    ),
}


def checkpoint_for(preset):
    """Runs scripted before style presets (no preset) use RealVisXL."""
    return CHECKPOINTS.get(preset, REALVIS)
