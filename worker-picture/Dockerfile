# Flow-Chain-AI picture worker (phase 5 spec §6.2, phase 10 spec §3): FLUX.2 klein 4B and FLUX 3 klein through diffusers;
# the request's workflow picks the engine, and each endpoint is sent only one.
# The model's files live on the network volume (seeded by the `fetch-models` task), not in this image.
FROM python:3.11-slim
# (spec §3.1: the pinned diffusers commit needs torch>=2.6; the install line below is unchanged)
# PyTorch built for CUDA 12.8, with its CUDA libraries inside the wheels; the endpoint asks for hosts with it
# torchvision from the same index, so it matches that torch: FLUX 3's text-encoder processor (Qwen3-VL) holds a video
# processor that refuses to load without it (seen live, phase 10), and the library then leaves the tokenizer empty
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cu128
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
# both pipelines this worker is written for must be in the library that was installed, or the image is not pushed
RUN python -c "import runpod, boto3; from diffusers import Flux2KleinPipeline, ModularPipeline; import torchvision"
CMD ["python", "-u", "/handler.py"]
