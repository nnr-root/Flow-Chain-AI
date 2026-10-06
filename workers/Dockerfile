# Flow-Chain-AI RunPod worker (2.4 spec §4): RunPod's ComfyUI worker base + pinned custom nodes + our handler.
# Model weights live on the network volume (seeded by the `fetch-models` task), not in this image.
FROM runpod/worker-comfyui:5.10.0-base

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git curl && rm -rf /var/lib/apt/lists/*

# IP-Adapter (GPL-3.0) and frame interpolation (MIT), pinned by commit.
ARG IPADAPTER_COMMIT=a0f451a5113cf9becb0847b92884cb10cbdec0ef
ARG FRAME_INTERPOLATION_COMMIT=26545cc2dd95bc3d27f056016300673bdeee78f5
RUN git clone https://github.com/cubiq/ComfyUI_IPAdapter_plus /comfyui/custom_nodes/ComfyUI_IPAdapter_plus \
 && git -C /comfyui/custom_nodes/ComfyUI_IPAdapter_plus checkout ${IPADAPTER_COMMIT}
RUN git clone https://github.com/Fannovel16/ComfyUI-Frame-Interpolation /comfyui/custom_nodes/ComfyUI-Frame-Interpolation \
 && git -C /comfyui/custom_nodes/ComfyUI-Frame-Interpolation checkout ${FRAME_INTERPOLATION_COMMIT} \
 && /opt/venv/bin/pip install --no-cache-dir -r /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/requirements-no-cupy.txt

# RIFE 4.9 weights (21 MB) baked in, so the node never downloads at run time.
RUN mkdir -p /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife \
 && curl -fsSL -o /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/rife49.pth \
      https://huggingface.co/marduk191/rife/resolve/main/rife49.pth \
 && echo "e55fd00f3cc184e3c65961f4bb827a9da022e78eed36b055242c0ac30000d533  /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/rife49.pth" | sha256sum -c -

COPY requirements.txt /flowchain/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /flowchain/requirements.txt

COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
COPY models.json /flowchain/models.json
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src
