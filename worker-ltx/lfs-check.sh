#!/usr/bin/env bash
# Checks at build time that the bytes downloaded are the file the pinned revision names.
#   lfs-check.sh <pointer git id> <size> <file or parts, in order...>
# The parts are read in the order given, as one file. The repository is gated, so its files' SHA-256 are not public;
# the git id of each file's LFS pointer is, and it is the SHA-1 of a text naming the SHA-256 and the size
# (weights.pointer_oid in Python; tests/test_weights.py runs this script).
set -euo pipefail
oid="$1"
size="$2"
shift 2
total=0
for part in "$@"; do
  total=$((total + $(wc -c < "$part")))
done
if [ "$total" != "$size" ]; then
  echo "lfs-check: $* is $total bytes, not $size" >&2
  exit 1
fi
sha=$(cat "$@" | sha256sum | cut -d' ' -f1)
got=$(printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$sha" "$size" | git hash-object --stdin)
if [ "$got" != "$oid" ]; then
  echo "lfs-check: $* is not the pinned file (pointer $got, want $oid)" >&2
  exit 1
fi
