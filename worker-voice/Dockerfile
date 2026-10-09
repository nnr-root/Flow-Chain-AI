# Flow-Chain-AI voice worker (phase 5 spec §6.1): VoxCPM2 for the speech, a Whisper model for the word times.
# Both models are inside the image: this worker needs no volume, so it can start in any data centre.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /flowchain/requirements.txt
# (torch stays the image's own build: it runs on every host this image's CUDA runs on)
RUN pip install --no-cache-dir -r /flowchain/requirements.txt
ENV HF_HOME=/flowchain/models
ARG WHISPER=large-v3-turbo
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('openbmb/VoxCPM2')" \
 && python -c "from faster_whisper.utils import download_model; download_model('${WHISPER}')"
# no network at run time: a model that is not in the image is an error at start, not a download in a job
ENV HF_HUB_OFFLINE=1 FLOWCHAIN_VOICE_WHISPER=${WHISPER}
COPY voices/ /flowchain/voices/
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
CMD ["python", "-u", "/handler.py"]
