# syntax=docker/dockerfile:1
# Flow-Chain-AI LTX worker (phase 15 spec §2, §13.1): LTX-2.5's distilled pipeline makes a scene's clip with its sound from a
# start frame and a prompt; faster-whisper gives the words heard in it when the scene speaks.
# Every model file is in this image (no network volume, so the endpoint can run in any data centre), checked at build. The
# image is about 72 GB (LTX about 71 GB, Whisper 1.6 GB); the first start on a host is slow.
#
# LAYERS: GHCR documents a 10 GB limit per layer (a build can succeed and the push fail), so every weight file has a RUN of
# its own, and the two files over 9 GB (the transformer, 42 GB; the text encoder, 26 GB) are stored as byte ranges of
# 8.8 GB, one layer each: five for the transformer, three for the text encoder. The worker joins them on its own disk at
# a cold start (weights.assemble). A layer that deletes what an earlier one added does not shrink the image, so nothing is
# ever split or removed after it is downloaded. If a push still fails on a layer's size, split the ranges further (more RUN
# steps of fewer bytes, and weights.PART_BYTES to match; tests/test_weights.py holds the two together).
#
# THE TOKEN: Lightricks/LTX-2.5 is gated. The owner's Hugging Face token is given to the build as a BuildKit secret
#   docker build --secret id=hf_token,src=<a file holding the token> worker-ltx
# and read only inside the RUN steps that download; it is never an ARG or an ENV, which would stay in the image's history.
FROM runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git curl && rm -rf /var/lib/apt/lists/*
# the check that each download is the pinned file (see the script); first, so a change to anything below keeps the downloads
COPY lfs-check.sh /usr/local/bin/lfs-check

# The model's own files, at one exact revision of its repository (weights.REVISION; head on 2026-10-31). The Hub hides a gated
# file's SHA-256, so each file is checked against the git id of its LFS pointer, which the public file list gives.
ARG LTX_REVISION=49b093a39c19169a8a81721dcc541e07e945232f
ARG LTX_FILES=https://huggingface.co/Lightricks/LTX-2.5/resolve/${LTX_REVISION}
RUN mkdir -p /models/ltx/diffusion_models /models/ltx/text_encoders /models/ltx/vae /models/ltx/latent_upscale_models
# the distilled transformer: five byte ranges (a Hugging Face resolve link answers Range requests), one layer each ...
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 0-8799999999 -o /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part00 ${LTX_FILES}/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 8800000000-17599999999 -o /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part01 ${LTX_FILES}/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 17600000000-26399999999 -o /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part02 ${LTX_FILES}/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 26400000000-35199999999 -o /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part03 ${LTX_FILES}/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 35200000000-42018190583 -o /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part04 ${LTX_FILES}/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
# ... and a step that adds no content: the five together are the pinned file
RUN lfs-check 3ba48d13c75fd5df2e868aa8c07b0c5119a6116f 42018190584 /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part00 /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part01 /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part02 /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part03 /models/ltx/diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors.part04
# the Gemma 4 text encoder (its tokenizer and configuration are inside the file): three byte ranges
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 0-8799999999 -o /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part00 ${LTX_FILES}/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 8800000000-17599999999 -o /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part01 ${LTX_FILES}/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -r 17600000000-26263858181 -o /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part02 ${LTX_FILES}/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors
RUN lfs-check daa17e623c212be771de61b2db03216ca4deabd9 26263858182 /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part00 /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part01 /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part02
# the two VAEs and the spatial upscaler, whole
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -o /models/ltx/vae/ltx-2.5-video-vae-bf16.safetensors ${LTX_FILES}/vae/ltx-2.5-video-vae-bf16.safetensors \
 && lfs-check 4f679fe8f92b8758468fb51aae91d9fe996a4fec 1472223346 /models/ltx/vae/ltx-2.5-video-vae-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -o /models/ltx/vae/ltx-2.5-audio-vae-bf16.safetensors ${LTX_FILES}/vae/ltx-2.5-audio-vae-bf16.safetensors \
 && lfs-check 08403b5a5cf13570829b59c13ad3cafbff6b04e9 364866540 /models/ltx/vae/ltx-2.5-audio-vae-bf16.safetensors
RUN --mount=type=secret,id=hf_token,required=true curl -fsSL --retry 5 --retry-all-errors -H "Authorization: Bearer $(cat /run/secrets/hf_token)" -o /models/ltx/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors ${LTX_FILES}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors \
 && lfs-check cec7bee6186295d8120b8006785564c95027e526 995778752 /models/ltx/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors

# Whisper large-v3-turbo as CTranslate2 (the repository faster-whisper itself names for "large-v3-turbo"), public, at one
# revision; loaded from this folder, never by name
ARG WHISPER_REVISION=0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf
ARG WHISPER_FILES=https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/${WHISPER_REVISION}
RUN mkdir -p /models/whisper \
 && for f in config.json preprocessor_config.json tokenizer.json vocabulary.json model.bin; do curl -fsSL --retry 5 --retry-all-errors -o /models/whisper/$f ${WHISPER_FILES}/$f || exit 1; done \
 && echo "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da  /models/whisper/model.bin" | sha256sum -c -

# PyTorch 2.8.0 built for CUDA 12.8 (the base image's own; pinned again so nothing below can move it). The same pins are a
# constraints file, with transformers at 5.14.1: ltx-core allows 5.8 to 5.14 and names 5.14.1 the newest verified to build
# the Gemma 4 text encoder.
RUN python3.11 -m pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
RUN printf 'torch==2.8.0\ntorchvision==0.23.0\ntorchaudio==2.8.0\ntransformers==5.14.1\n' > /constraints.txt
# The model's program (ltx-core, ltx-pipelines), pinned by commit. e98f6d9 (2026-10-18) was the head of main on 2026-10-31,
# the day of the spike, which cloned the head and worked: it is the code that was tested. Installed from the checkout with
# pip under the constraints above, not with `uv sync`: the repository's `natten` extra pins torch 2.13 for CUDA 13.2, which
# this image does not use (the video VAE then runs its neighbourhood attention on the Triton/eager fallback).
ARG LTX_COMMIT=e98f6d927d83c92ef2be6aec76c8440b19306e39
RUN git clone https://github.com/Lightricks/LTX-2 /ltx-src \
 && git -C /ltx-src checkout ${LTX_COMMIT} \
 && python3.11 -m pip install --no-cache-dir -c /constraints.txt /ltx-src/packages/ltx-core /ltx-src/packages/ltx-pipelines
COPY requirements.txt /flowchain/requirements.txt
RUN python3.11 -m pip install --no-cache-dir -c /constraints.txt -r /flowchain/requirements.txt && python3.11 -m pip freeze > /flowchain/versions.txt

# The text encoder's tokenizer, configuration and processor must build offline from the file itself, or the first paid job
# fails instead of this build. The file is joined in /tmp and removed in the same step, so the layer holds nothing of it.
RUN cat /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part00 /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part01 /models/ltx/text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors.part02 > /tmp/te.safetensors \
 && { HF_HUB_OFFLINE=1 python3.11 -c "from ltx_core.text_encoders.gemma.gemma_assets import GemmaAssets, build_gemma_hf_config, build_gemma_hf_tokenizer, build_gemma_processor; a = GemmaAssets.load('/tmp/te.safetensors'); build_gemma_hf_config(a); build_gemma_processor(a, build_gemma_hf_tokenizer(a))"; s=$?; rm -f /tmp/te.safetensors; test $s -eq 0; } \
 || { echo "the text encoder's tokenizer or processor does not build offline from its file" >&2; exit 1; }
# Whisper loads offline from its folder (on the CPU here; the worker uses the card)
RUN HF_HUB_OFFLINE=1 python3.11 -c "from faster_whisper import WhisperModel; WhisperModel('/models/whisper', device='cpu', compute_type='int8')"
# The CLI takes the flags the spike used, and engine.py calls the program's functions with these parameters, by name: if the
# program ever differs, the build fails here rather than the first paid job
RUN python3.11 -m ltx_pipelines.distilled --help > /tmp/help.txt \
 && for flag in --chunk-pixel-frames --chunk-carry-frames --quantization --transformer-path --text-encoder-path --video-vae-path --audio-vae-path --spatial-upsampler-path --image; do grep -q -- "$flag" /tmp/help.txt || { echo "ltx_pipelines.distilled does not take $flag" >&2; exit 1; }; done \
 && rm /tmp/help.txt
RUN python3.11 -c "import inspect; from ltx_pipelines.distilled import DistilledPipeline; from ltx_pipelines.utils.model_paths import ModelPaths; from ltx_pipelines.utils.quantization_factory import QuantizationKind; from ltx_pipelines.utils.types import ImageConditioningInput; from ltx_pipelines.chunks import ChunkConfig, pipeline_output_from_chunks, split_decoded_chunks; from ltx_pipelines.utils.media_io import encode_video; from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number; \
want = {DistilledPipeline.__init__: ['model_paths', 'spatial_upsampler_path', 'loras', 'device', 'quantization'], DistilledPipeline.stream_chunks: ['prompt', 'seed', 'height', 'width', 'frame_rate', 'images', 'num_frames', 'vae_dtype', 'tiling_config', 'enhance_prompt', 'enhance_static_cache', 'color_space', 'generated_keyframes', 'decode_with_keyframes', 'chunk_config'], ModelPaths.from_split: ['transformer_path', 'text_encoder_path', 'video_vae_path', 'audio_vae_path'], ImageConditioningInput.at: ['path', 'frame_idx', 'strength'], ChunkConfig: ['chunk_pixel_frames', 'next_video_carry_frames'], encode_video: ['video', 'fps', 'audio', 'output_path', 'video_chunks_number', 'color_space', 'audio_sampling_rate', 'video_marker', 'audio_marker']}; \
bad = [f.__qualname__ for f, names in want.items() if not set(names) <= set(inspect.signature(f).parameters)]; \
assert not bad, 'the model program does not take the parameters engine.py passes: ' + ', '.join(bad); QuantizationKind('fp8-cast')"
RUN printf %s 49b093a39c19169a8a81721dcc541e07e945232f > /models/ltx/.verified

ENV HF_HUB_OFFLINE=1 PYTHONPATH=/flowchain/src PYTHONUNBUFFERED=1
COPY src/ /flowchain/src/
COPY handler.py /handler.py
# the files this worker runs must be where it calls them, or the image is not pushed (no GPU needed for any of it)
RUN python3.11 -c "import runpod, boto3, faster_whisper; from flowchain_ltx import engine, weights; assert weights.present(), 'the model files are not all where weights.py says, at their sizes'; assert weights.REVISION == open('/models/ltx/.verified').read()" \
 && python3.11 -c "import torch, torchvision, torchaudio; assert torch.__version__.startswith('2.8.0') and torchvision.__version__.startswith('0.23.0') and torchaudio.__version__.startswith('2.8.0')" \
 && test "$(git -C /ltx-src rev-parse HEAD)" = "e98f6d927d83c92ef2be6aec76c8440b19306e39"
CMD ["python3.11", "-u", "/handler.py"]
