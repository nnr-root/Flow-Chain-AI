from flowchain_worker.workflows import clip_graph


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


def test_the_clip_graph_loads_nothing_but_the_clip_model():
    g = clip_graph({"prompt": "it runs", "width": 720, "height": 1280, "frames": 33}, seed=3, prefix="p", image_file="i.png")
    assert not [n for n in g.values() if n["class_type"] in ("CheckpointLoaderSimple", "IPAdapterModelLoader", "CLIPVisionLoader")]
