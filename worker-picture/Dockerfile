# Flow-Chain-AI picture worker (phase 5 spec §6.2): FLUX.2 klein 4B through diffusers.
# The model's files live on the network volume (seeded by the `fetch-models` task), not in this image.
FROM python:3.11-slim
# PyTorch built for CUDA 12.8, with its CUDA libraries inside the wheels; the endpoint asks for hosts with it
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128
COPY requirements.txt /flowchain/requirements.txt
RUN pip install --no-cache-dir -r /flowchain/requirements.txt && pip freeze > /flowchain/versions.txt
COPY src/ /flowchain/src/
COPY handler.py /handler.py
ENV PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
# the pipeline this worker is written for must be in the library that was installed, or the image is not pushed
RUN python -c "import runpod, boto3; from diffusers import Flux2KleinPipeline"
CMD ["python", "-u", "/handler.py"]
