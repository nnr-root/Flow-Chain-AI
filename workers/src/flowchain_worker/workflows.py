"""The ComfyUI API-format graph for a clip, built in code so every wiring choice is unit-tested (2.4 spec §5).

Node names and inputs follow ComfyUI's own nodes (UNETLoader, KSamplerAdvanced, WanImageToVideo, …) and
ComfyUI-Frame-Interpolation ("RIFE VFI"). The picture graph that used to be here went with its weights
(phase 5 spec §9.13): pictures are made by the picture worker.
"""

WAN_HIGH = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
WAN_LOW = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
WAN_LORA_HIGH = "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
WAN_LORA_LOW = "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
WAN_TEXT = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN_VAE = "wan_2.1_vae.safetensors"
WAN_NEGATIVE = (
    "static, still frame, blurry details, subtitles, overexposed, worst quality, low quality, jpeg artifacts, "
    "ugly, deformed, disfigured, extra fingers, poorly drawn hands, poorly drawn face, messy background"
)
RIFE_MULTIPLIER = 2


def clip_graph(req, *, seed, prefix, image_file):
    """Wan 2.2 I2V A14B (fp8) with the 4-step Lightning LoRAs (steps 4, split 2, cfg 1, euler/simple, shift 5),
    then RIFE ×2; frames are saved as PNGs and encoded by the handler."""
    sampler = {"noise_seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
               "positive": ["12", 0], "negative": ["12", 1]}
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": WAN_HIGH, "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": WAN_LOW, "weight_dtype": "default"}},
        "3": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": WAN_LORA_HIGH, "strength_model": 1.0}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": WAN_LORA_LOW, "strength_model": 1.0}},
        "5": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["3", 0], "shift": 5.0}},
        "6": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["4", 0], "shift": 5.0}},
        "7": {"class_type": "CLIPLoader", "inputs": {"clip_name": WAN_TEXT, "type": "wan"}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": req["prompt"], "clip": ["7", 0]}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": WAN_NEGATIVE, "clip": ["7", 0]}},
        "10": {"class_type": "VAELoader", "inputs": {"vae_name": WAN_VAE}},
        "11": {"class_type": "LoadImage", "inputs": {"image": image_file}},
        "12": {"class_type": "WanImageToVideo", "inputs": {
            "positive": ["8", 0], "negative": ["9", 0], "vae": ["10", 0], "width": req["width"], "height": req["height"],
            "length": req["frames"], "batch_size": 1, "start_image": ["11", 0]}},
        "13": {"class_type": "KSamplerAdvanced", "inputs": {
            "model": ["5", 0], "add_noise": "enable", **sampler, "latent_image": ["12", 2],
            "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"}},
        "14": {"class_type": "KSamplerAdvanced", "inputs": {
            "model": ["6", 0], "add_noise": "disable", **sampler, "latent_image": ["13", 0],
            "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"}},
        "15": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["10", 0]}},
        "16": {"class_type": "RIFE VFI", "inputs": {
            "ckpt_name": "rife49.pth", "frames": ["15", 0], "clear_cache_after_n_frames": 10, "multiplier": RIFE_MULTIPLIER,
            "fast_mode": True, "ensemble": True, "scale_factor": 1.0, "dtype": "float32", "torch_compile": False,
            "batch_size": 1}},
        "17": {"class_type": "SaveImage", "inputs": {"images": ["16", 0], "filename_prefix": prefix}},
    }
