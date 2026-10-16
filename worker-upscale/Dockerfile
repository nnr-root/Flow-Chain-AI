# Flow-Chain-AI upscaling worker (phase 8 spec §8): SeedVR2 3B through its own command-line program.
# The model's files are in this image (the network volume has no room for them), checked by SHA-256.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
# PyTorch built for CUDA 12.8, with its CUDA libraries inside the wheels; the endpoint asks for hosts with it
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cu128
# SeedVR2's program, pinned by commit (v2.5.24, the version the trial ran)
ARG SEEDVR2_COMMIT=4490bd1f482e026674543386bb2a4d176da245b9
RUN git clone https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler /seedvr2 \
 && git -C /seedvr2 checkout ${SEEDVR2_COMMIT} \
 && pip install --no-cache-dir -r /seedvr2/requirements.txt
ARG SEEDVR2_FILES=https://huggingface.co/numz/SeedVR2_comfyUI/resolve/09ced71023636e9bc8cdf9cdecfb2625d1e691e8
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /models/seedvr2 \
 && curl -fL --retry 5 --retry-all-errors -o /models/seedvr2/seedvr2_ema_3b_fp16.safetensors ${SEEDVR2_FILES}/seedvr2_ema_3b_fp16.safetensors \
 && curl -fL --retry 5 --retry-all-errors -o /models/seedvr2/ema_vae_fp16.safetensors ${SEEDVR2_FILES}/ema_vae_fp16.safetensors \
 && echo "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304  /models/seedvr2/seedvr2_ema_3b_fp16.safetensors" | sha256sum -c - \
 && echo "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1  /models/seedvr2/ema_vae_fp16.safetensors" | sha256sum -c -
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
# the program this worker runs must be where it is called, or the image is not pushed
RUN test -f /seedvr2/inference_cli.py && python -c "import runpod, boto3; from flowchain_upscale import weights; assert weights.present()"
CMD ["python", "-u", "/handler.py"]
