# Flow-Chain-AI upscaling worker (phase 8 spec §8): SeedVR2 3B through its own command-line program.
# The model's files are in this image (the network volume has no room for them), checked by SHA-256.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git unzip && rm -rf /var/lib/apt/lists/*
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
# RIFE's program, pinned by commit (MIT), in a virtualenv of its own: its video reader fails under the numpy that
# SeedVR2's packages bring, so numpy is 1.23.5 there (the image's CUDA torch is reused through --system-site-packages).
# Its model (code and weights, one zip) is checked by SHA-256 and only the four wanted files are kept (phase 11 spec §3.1)
ARG RIFE_COMMIT=bbfd2ea90910789a860ea3e2b32a240cd577b75e
ARG RIFE_ZIP=https://huggingface.co/hzwer/RIFE/resolve/01fdc7e97404120c243c3ea7b427046e5dc7643e/RIFEv4.26_0921.zip
RUN git clone https://github.com/hzwer/Practical-RIFE /rife \
 && git -C /rife checkout ${RIFE_COMMIT} \
 && python -m venv --system-site-packages /rife/.venv \
 && /rife/.venv/bin/pip install --no-cache-dir numpy==1.23.5 sk-video==1.1.10 scipy==1.11.4 opencv-python-headless==4.11.0.86 tqdm \
 && mkdir -p /rife/train_log \
 && curl -fL --retry 5 --retry-all-errors -o /tmp/RIFEv4.26_0921.zip ${RIFE_ZIP} \
 && echo "1fa9b9cda3d9b8c3e301359e2595960902f97bf926c08598b0e9957a3f3f760e  /tmp/RIFEv4.26_0921.zip" | sha256sum -c - \
 && unzip -j -d /rife/train_log /tmp/RIFEv4.26_0921.zip RIFEv4.26_0921/flownet.pkl RIFEv4.26_0921/IFNet_HDv3.py RIFEv4.26_0921/RIFE_HDv3.py RIFEv4.26_0921/refine.py \
 && rm /tmp/RIFEv4.26_0921.zip
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
COPY check_rife.py /flowchain/check_rife.py
ENV PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
# the program this worker runs must be where it is called, or the image is not pushed
RUN test -f /seedvr2/inference_cli.py && test -f /rife/inference_video.py \
 && python -c "import runpod, boto3; from flowchain_upscale import weights, weights_rife; assert weights.present(); assert weights_rife.present()" \
 && /rife/.venv/bin/python /flowchain/check_rife.py
CMD ["python", "-u", "/handler.py"]
