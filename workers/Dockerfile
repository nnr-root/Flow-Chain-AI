# Flow-Chain-AI RunPod worker (2.4 spec §4): RunPod's ComfyUI worker base + pinned custom nodes + our handler.
# The clip model's weights live on the network volume (seeded by the `fetch-models` task); what never changes
# with them (text encoder, VAE, RIFE) is in this image.
FROM runpod/worker-comfyui:5.10.0-base

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git curl && rm -rf /var/lib/apt/lists/*

# Frame interpolation (MIT), pinned by commit.
ARG FRAME_INTERPOLATION_COMMIT=26545cc2dd95bc3d27f056016300673bdeee78f5
RUN git clone https://github.com/Fannovel16/ComfyUI-Frame-Interpolation /comfyui/custom_nodes/ComfyUI-Frame-Interpolation \
 && git -C /comfyui/custom_nodes/ComfyUI-Frame-Interpolation checkout ${FRAME_INTERPOLATION_COMMIT} \
 && /opt/venv/bin/pip install --no-cache-dir -r /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/requirements-no-cupy.txt

# RIFE 4.9 weights (21 MB) baked in, so the node never downloads at run time.
RUN mkdir -p /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife \
 && curl -fsSL -o /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/rife49.pth \
      https://huggingface.co/marduk191/rife/resolve/main/rife49.pth \
 && echo "e55fd00f3cc184e3c65961f4bb827a9da022e78eed36b055242c0ac30000d533  /comfyui/custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/rife49.pth" | sha256sum -c -

# The text encoder (6.7 GB) and the VAE are read at every start of a worker: they are in the image, on the
# worker's own disk, and not on the network volume (phase 5 spec §9.13). Checked by SHA-256, so the image is
# never pushed with another file under the same name.
ARG WAN_FILES=https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files
RUN mkdir -p /comfyui/models/text_encoders /comfyui/models/vae \
 && curl -fL --retry 5 --retry-all-errors -o /comfyui/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors \
      ${WAN_FILES}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors \
 && curl -fL --retry 5 --retry-all-errors -o /comfyui/models/vae/wan_2.1_vae.safetensors \
      ${WAN_FILES}/vae/wan_2.1_vae.safetensors \
 && echo "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68  /comfyui/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" | sha256sum -c - \
 && echo "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b  /comfyui/models/vae/wan_2.1_vae.safetensors" | sha256sum -c -

COPY requirements.txt /flowchain/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /flowchain/requirements.txt

COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
COPY models.json /flowchain/models.json
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src
