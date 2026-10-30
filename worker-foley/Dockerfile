# Flow-Chain-AI Foley worker (phase 14 spec §4): HunyuanVideo-Foley makes a scene's sound from a small video and a prompt.
# Every model file is in this image (plan Ruling 1: no network volume, so the endpoint can run in any data centre),
# checked by SHA-256. The image is about 25 GB; the first start on a host is slow.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git curl && rm -rf /var/lib/apt/lists/*
# PyTorch 2.8.0 built for CUDA 12.8, with its CUDA libraries inside the wheels. Pinned: the trial of 2026-10-30 ran on
# these, and torch 2.11 could not save a wav ("TorchCodec is required").
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
# The model's program, pinned by commit (head on 2026-10-31); its requirements pin the transformers fork SigLIP 2 needs.
# Its package is found through PYTHONPATH below (it is run from a clone, as the trial ran it).
ARG FOLEY_COMMIT=df7b005b5023df2a9b73e1d66dd51d452799884e
RUN git clone https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley /foley-src \
 && git -C /foley-src checkout ${FOLEY_COMMIT} \
 && pip install --no-cache-dir -r /foley-src/requirements.txt huggingface_hub
# The model's own three files, at one exact revision of its repository (the XL model is not wanted)
ARG FOLEY_FILES=https://huggingface.co/tencent/HunyuanVideo-Foley/resolve/3abd4e833b95b8db0fc9c687afc52483a48e9a97
# The program also loads SigLIP 2 and CLAP by name from the Hub: they are put in a Hub cache here, at one revision each,
# and the worker runs offline (the cache's "main" pointer is written by hand, since a download by commit writes none)
ENV HF_HOME=/models/foley/hf
RUN mkdir -p /models/foley \
 && curl -fL --retry 5 --retry-all-errors -o /models/foley/hunyuanvideo_foley.pth ${FOLEY_FILES}/hunyuanvideo_foley.pth \
 && curl -fL --retry 5 --retry-all-errors -o /models/foley/synchformer_state_dict.pth ${FOLEY_FILES}/synchformer_state_dict.pth \
 && curl -fL --retry 5 --retry-all-errors -o /models/foley/vae_128d_48k.pth ${FOLEY_FILES}/vae_128d_48k.pth \
 && python -c "from huggingface_hub import snapshot_download as d; d('google/siglip2-base-patch16-512', revision='a89f5c5093f902bf39d3cd4d81d2c09867f0724b'); d('laion/larger_clap_general', revision='ada0c23a36c4e8582805bb38fec3905903f18b41')" \
 && mkdir -p /models/foley/hf/hub/models--google--siglip2-base-patch16-512/refs /models/foley/hf/hub/models--laion--larger_clap_general/refs \
 && printf %s a89f5c5093f902bf39d3cd4d81d2c09867f0724b > /models/foley/hf/hub/models--google--siglip2-base-patch16-512/refs/main \
 && printf %s ada0c23a36c4e8582805bb38fec3905903f18b41 > /models/foley/hf/hub/models--laion--larger_clap_general/refs/main \
 && echo "2900021f8ee562a8175b2f1a3fafb06b9e9e848f11f4c6d4d5d72e126f7c0475  /models/foley/hunyuanvideo_foley.pth" | sha256sum -c - \
 && echo "8aff082f2df5c3bc52759db0c865c7ee772ae6400b860d1b7e90413f2defb67c  /models/foley/synchformer_state_dict.pth" | sha256sum -c - \
 && echo "07e6139ff33bd21ba8a7a7f40ed24aab13ac0d100cd686f8a9f3e03dc5251cb1  /models/foley/vae_128d_48k.pth" | sha256sum -c - \
 && echo "fe0e601c625e69eed8e73500d39e9b6164403fe03db8048e87913c3cefbbb3fe  /models/foley/hf/hub/models--google--siglip2-base-patch16-512/snapshots/a89f5c5093f902bf39d3cd4d81d2c09867f0724b/model.safetensors" | sha256sum -c - \
 && echo "314eb00cce6ad68d25237b8446b659ccdb136ed4672c1bca470f142f72455026  /models/foley/hf/hub/models--laion--larger_clap_general/snapshots/ada0c23a36c4e8582805bb38fec3905903f18b41/pytorch_model.bin" | sha256sum -c - \
 && printf %s 3abd4e833b95b8db0fc9c687afc52483a48e9a97 > /models/foley/.verified
ENV HF_HUB_OFFLINE=1 PYTHONPATH=/foley-src:/flowchain/src PYTHONUNBUFFERED=1
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
# the files this worker runs must be where it calls them, or the image is not pushed (no GPU needed for any of it)
RUN python -c "import runpod, boto3; from flowchain_foley import weights; assert weights.present()" \
 && python -c "from hunyuanvideo_foley.utils.model_utils import load_model, denoise_process; from hunyuanvideo_foley.utils.feature_utils import feature_process" \
 && test -f /foley-src/configs/hunyuanvideo-foley-xxl.yaml
CMD ["python", "-u", "/handler.py"]
