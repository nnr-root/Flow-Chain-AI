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
