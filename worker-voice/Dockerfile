# Flow-Chain-AI voice worker (phase 5 spec §6.1): VoxCPM2 for the speech, a Whisper model for the word times.
# Both models are inside the image: this worker needs no volume, so it can start in any data centre.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# PyTorch built for CUDA 12.8, with its CUDA libraries inside the wheels: the endpoint asks for hosts whose
# driver is at least that (an older driver runs this build on the CPU, which the first live check met).
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu128
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
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
# The voice library must be one that speaks from a reference clip: an older one installs without complaint and
# fails on the first line (the first live check met that too). Checked here, so such an image is never pushed.
RUN python -c "import inspect; from voxcpm import VoxCPM; assert 'reference_wav_path' in inspect.signature(VoxCPM._generate).parameters, 'this voxcpm cannot speak from a reference clip'"
CMD ["python", "-u", "/handler.py"]
