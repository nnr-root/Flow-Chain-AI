from flowchain_worker.presets import ANIMAGINE, REALVIS, SDXL_BASE, checkpoint_for
from flowchain_worker.workflows import clip_graph, keyframe_graph, sdxl_base_size


def kf(**over):
    return {"prompt": "a fox", "width": 1088, "height": 1920, "preset": "cinematic_history", **over}


def by_class(graph, class_type):
    return [n for n in graph.values() if n["class_type"] == class_type]


def test_presets_pick_their_checkpoint():
    assert checkpoint_for("anime") == ANIMAGINE
    assert checkpoint_for("3d_render") == SDXL_BASE
    assert checkpoint_for("cyberpunk") == REALVIS
    assert checkpoint_for(None) == REALVIS


def test_keyframe_draws_at_the_sdxl_bucket_then_details_up_and_crops_to_the_target():
    g = keyframe_graph(kf(), seed=11, prefix="flowchain/j/out")
    assert sdxl_base_size(1088, 1920) == (768, 1344)
    assert g["5"]["inputs"] == {"width": 768, "height": 1344, "batch_size": 1}
    assert g["7"]["inputs"]["scale_by"] == 1.43
    assert g["8"]["inputs"]["denoise"] == 0.35 and g["8"]["inputs"]["latent_image"] == ["7", 0]
    assert g["10"]["inputs"] == {"image": ["9", 0], "upscale_method": "lanczos", "width": 1088, "height": 1920, "crop": "center"}
    assert [s["inputs"]["seed"] for s in by_class(g, "KSampler")] == [11, 11]
    assert all(s["inputs"]["steps"] == 8 and s["inputs"]["cfg"] == 1.0 and s["inputs"]["scheduler"] == "sgm_uniform"
               for s in by_class(g, "KSampler"))
    assert by_class(g, "SaveImage")[0]["inputs"]["filename_prefix"] == "flowchain/j/out"


def test_a_square_portrait_skips_the_detail_pass():
    g = keyframe_graph(kf(width=1024, height=1024), seed=1, prefix="p")
    assert "7" not in g and g["9"]["inputs"]["samples"] == ["6", 0]


def test_a_reference_conditions_both_samplers_through_ip_adapter_plus_face():
    g = keyframe_graph(kf(), seed=1, prefix="p", reference_file="flowchain/j-reference.png")
    assert g["11"]["inputs"] == {"image": "flowchain/j-reference.png"}
    ip = g["15"]["inputs"]
    assert ip["weight"] == 0.6 and ip["clip_vision"] == ["12", 0] and ip["model"] == ["2", 0]
    assert [s["inputs"]["model"] for s in by_class(g, "KSampler")] == [["15", 0], ["15", 0]]
    assert "15" not in keyframe_graph(kf(), seed=1, prefix="p")


def test_clip_uses_both_wan_experts_with_the_4_step_lightning_split_then_rife():
    req = {"prompt": "it runs", "width": 480, "height": 832, "frames": 49}
    g = clip_graph(req, seed=3, prefix="flowchain/j/out", image_file="flowchain/j-image.png")
    high, low = g["13"]["inputs"], g["14"]["inputs"]
    assert (high["model"], high["start_at_step"], high["end_at_step"], high["add_noise"]) == (["5", 0], 0, 2, "enable")
    assert (low["model"], low["start_at_step"], low["end_at_step"], low["add_noise"]) == (["6", 0], 2, 4, "disable")
    assert low["latent_image"] == ["13", 0] and high["latent_image"] == ["12", 2]
    assert [g[k]["inputs"]["shift"] for k in ("5", "6")] == [5.0, 5.0]
    assert g["12"]["inputs"]["length"] == 49 and g["12"]["inputs"]["width"] == 480
    assert g["16"]["class_type"] == "RIFE VFI" and g["16"]["inputs"]["multiplier"] == 2
    assert g["17"]["inputs"]["images"] == ["16", 0]
