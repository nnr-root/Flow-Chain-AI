"""The LTX worker: a picture and a prompt in, a clip (and the words spoken in it) out (phase 15 spec §2)."""

# The image's PyTorch is built for CUDA 13.2 (torch 2.13.0+cu132, the stack the spike ran): a host whose driver is older
# shows no GPU. The endpoint's minCudaVersion is set from this (Task 3), so such a host never takes a job.
MIN_HOST_CUDA = "13.2"
