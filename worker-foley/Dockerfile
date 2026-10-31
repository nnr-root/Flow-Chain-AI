# Flow-Chain-AI Foley worker (phase 14 spec §4): HunyuanVideo-Foley makes a scene's sound from a small video and a prompt.
# Every model file is in this image (plan Ruling 1: no network volume, so the endpoint can run in any data centre),
# checked by SHA-256. The image is about 25-30 GB; the first start on a host is slow.
#
# LAYERS: GHCR documents a 10 GB limit per layer (a build can succeed and the push fail), so every weight file has a RUN of
# its own, and the one file over 10 GB (hunyuanvideo_foley.pth, 10301204679 bytes) is stored as two byte ranges in two layers
# (review of 2026-10-30). The worker joins them on its own disk at a cold start (weights.assemble). A layer that deletes what
# an earlier one added does not shrink the image, so nothing is ever split or removed after it is downloaded.
# If a push still fails on a layer's size, split the ranges further (more RUN steps of fewer bytes, and weights.PARTS to match).
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git curl && rm -rf /var/lib/apt/lists/*
# PyTorch 2.8.0 built for CUDA 12.8, with its CUDA libraries inside the wheels. Pinned: the trial of 2026-10-30 ran on
# these, and torch 2.11 could not save a wav ("TorchCodec is required"). The same pins are a constraints file, so the
# model's requirements can never move them.
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
RUN printf 'torch==2.8.0\ntorchvision==0.23.0\ntorchaudio==2.8.0\n' > /constraints.txt
# The model's program, pinned by commit (head on 2026-10-31). Its requirements name a tag and a branch, which are
# rewritten to the commits they were on 2026-10-30 (transformers' SigLIP 2 tag, audiotools' master) and the build fails
# if the rewrite did not happen.
ARG FOLEY_COMMIT=df7b005b5023df2a9b73e1d66dd51d452799884e
RUN git clone https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley /foley-src \
 && git -C /foley-src checkout ${FOLEY_COMMIT} \
 && sed -i -e 's#transformers@v4.49.0-SigLIP-2#transformers@a957b7911a758d54597914b4479fe6e81424d64f#' -e 's#descriptinc/audiotools$#descriptinc/audiotools@348ebf2034ce24e2a91a553e3171cb00c0c71678#' /foley-src/requirements.txt \
 && grep -q 'transformers@a957b7911a758d54597914b4479fe6e81424d64f' /foley-src/requirements.txt \
 && grep -q 'audiotools@348ebf2034ce24e2a91a553e3171cb00c0c71678' /foley-src/requirements.txt \
 && pip install --no-cache-dir -c /constraints.txt -r /foley-src/requirements.txt huggingface_hub
# The model's own files, at one exact revision of its repository (the XL model is not wanted)
ARG FOLEY_FILES=https://huggingface.co/tencent/HunyuanVideo-Foley/resolve/3abd4e833b95b8db0fc9c687afc52483a48e9a97
RUN mkdir -p /models/foley
# the main model: two byte ranges (a Hugging Face resolve link answers Range requests), one layer each ...
RUN curl -fL --retry 5 --retry-all-errors -r 0-5199999999 -o /models/foley/hunyuanvideo_foley.pth.part00 ${FOLEY_FILES}/hunyuanvideo_foley.pth
RUN curl -fL --retry 5 --retry-all-errors -r 5200000000- -o /models/foley/hunyuanvideo_foley.pth.part01 ${FOLEY_FILES}/hunyuanvideo_foley.pth
# ... and a step that adds no content: the two halves together are the pinned file
RUN test "$(cat /models/foley/hunyuanvideo_foley.pth.part00 /models/foley/hunyuanvideo_foley.pth.part01 | sha256sum | cut -d' ' -f1)" = "2900021f8ee562a8175b2f1a3fafb06b9e9e848f11f4c6d4d5d72e126f7c0475"
RUN curl -fL --retry 5 --retry-all-errors -o /models/foley/synchformer_state_dict.pth ${FOLEY_FILES}/synchformer_state_dict.pth \
 && echo "8aff082f2df5c3bc52759db0c865c7ee772ae6400b860d1b7e90413f2defb67c  /models/foley/synchformer_state_dict.pth" | sha256sum -c -
RUN curl -fL --retry 5 --retry-all-errors -o /models/foley/vae_128d_48k.pth ${FOLEY_FILES}/vae_128d_48k.pth \
 && echo "07e6139ff33bd21ba8a7a7f40ed24aab13ac0d100cd686f8a9f3e03dc5251cb1  /models/foley/vae_128d_48k.pth" | sha256sum -c -
# SigLIP 2 and CLAP, which the program loads by name from the Hub: a Hub cache here, one revision each, and the worker
# runs offline (HF_HUB_OFFLINE below)
ENV HF_HOME=/models/foley/hf
RUN python -c "from huggingface_hub import snapshot_download as d; d('google/siglip2-base-patch16-512', revision='a89f5c5093f902bf39d3cd4d81d2c09867f0724b')" \
 && echo "fe0e601c625e69eed8e73500d39e9b6164403fe03db8048e87913c3cefbbb3fe  /models/foley/hf/hub/models--google--siglip2-base-patch16-512/snapshots/a89f5c5093f902bf39d3cd4d81d2c09867f0724b/model.safetensors" | sha256sum -c -
RUN python -c "from huggingface_hub import snapshot_download as d; d('laion/larger_clap_general', revision='ada0c23a36c4e8582805bb38fec3905903f18b41')" \
 && echo "314eb00cce6ad68d25237b8446b659ccdb136ed4672c1bca470f142f72455026  /models/foley/hf/hub/models--laion--larger_clap_general/snapshots/ada0c23a36c4e8582805bb38fec3905903f18b41/pytorch_model.bin" | sha256sum -c -
# a download by commit writes no "main" pointer, nor even a refs folder (the first CI build, 2026-10-31, found "Directory
# nonexistent"), and an offline load looks for refs/main
RUN mkdir -p /models/foley/hf/hub/models--google--siglip2-base-patch16-512/refs /models/foley/hf/hub/models--laion--larger_clap_general/refs \
 && printf %s a89f5c5093f902bf39d3cd4d81d2c09867f0724b > /models/foley/hf/hub/models--google--siglip2-base-patch16-512/refs/main \
 && printf %s ada0c23a36c4e8582805bb38fec3905903f18b41 > /models/foley/hf/hub/models--laion--larger_clap_general/refs/main
# The two encoders must load offline from the cache above, or the first paid job fails instead of this build: load them here
# the way load_model does with enable_offload=False (model_utils.py, the pinned commit), on the CPU, with HF_HUB_OFFLINE=1 (the Hub
# library then reads only its cache, as the worker does at run time).
RUN HF_HUB_OFFLINE=1 python -c "from transformers import AutoModel, AutoTokenizer, ClapTextModelWithProjection; AutoModel.from_pretrained('google/siglip2-base-patch16-512').to('cpu').eval(); AutoTokenizer.from_pretrained('laion/larger_clap_general'); ClapTextModelWithProjection.from_pretrained('laion/larger_clap_general').to('cpu')" \
 || { echo "the SigLIP 2 or CLAP encoder does not load offline from /models/foley/hf: check the cache and its refs/main files" >&2; exit 1; }
RUN printf %s 3abd4e833b95b8db0fc9c687afc52483a48e9a97 > /models/foley/.verified
ENV HF_HUB_OFFLINE=1 PYTHONPATH=/foley-src:/flowchain/src PYTHONUNBUFFERED=1
# engine.py calls the model program's functions with these parameters, by position and by name: if the program ever differs, the
# build fails here rather than the first paid job
RUN python -c "import inspect; from hunyuanvideo_foley.utils.model_utils import load_model, denoise_process; from hunyuanvideo_foley.utils.feature_utils import feature_process; want = {load_model: ['model_path', 'config_path', 'device', 'enable_offload', 'model_size'], feature_process: ['video_path', 'prompt', 'model_dict', 'cfg', 'neg_prompt'], denoise_process: ['visual_feats', 'text_feats', 'audio_len_in_s', 'model_dict', 'cfg', 'guidance_scale', 'num_inference_steps']}; bad = [f.__name__ for f, names in want.items() if list(inspect.signature(f).parameters)[:len(names)] != names]; assert not bad, 'the model program does not take the parameters engine.py passes: ' + ', '.join(bad)"
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -c /constraints.txt -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
# the files this worker runs must be where it calls them, or the image is not pushed (no GPU needed for any of it)
RUN python -c "import runpod, boto3; from flowchain_foley import weights; assert weights.present()" \
 && python -c "import torch, torchvision, torchaudio; assert torch.__version__.startswith('2.8.0') and torchvision.__version__.startswith('0.23.0') and torchaudio.__version__.startswith('2.8.0')" \
 && python -c "from hunyuanvideo_foley.utils.model_utils import load_model, denoise_process; from hunyuanvideo_foley.utils.feature_utils import feature_process" \
 && test -f /foley-src/configs/hunyuanvideo-foley-xxl.yaml
CMD ["python", "-u", "/handler.py"]
