from flowchain_worker.comfy import output_files


def test_lists_saved_outputs_in_node_and_file_order():
    entry = {"outputs": {
        "17": {"images": [{"filename": "out_00001_.png", "subfolder": "flowchain/j", "type": "output"},
                          {"filename": "out_00002_.png", "subfolder": "flowchain/j", "type": "output"}]},
        "3": {"images": [{"filename": "preview.png", "subfolder": "", "type": "temp"}]},
    }}
    assert output_files(entry, "/comfyui/output") == [
        "/comfyui/output/flowchain/j/out_00001_.png",
        "/comfyui/output/flowchain/j/out_00002_.png",
    ]


def test_interrupt_posts_to_the_interrupt_endpoint(monkeypatch):
    from flowchain_worker import comfy

    seen = []

    class Res:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b""

    def fake_urlopen(req, timeout):
        seen.append((req.full_url, req.get_method()))
        return Res()

    monkeypatch.setattr(comfy.urllib.request, "urlopen", fake_urlopen)
    comfy.interrupt()
    assert seen == [("http://127.0.0.1:8188/interrupt", "POST")]
