#!/usr/bin/env bash
# Builds codie-spike for the phase 0 targets into dist/.
set -euo pipefail
cd "$(dirname "$0")"
for target in windows/amd64 darwin/arm64 darwin/amd64; do
  os=${target%/*}; arch=${target#*/}; ext=""; [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -o "dist/codie-spike-$os-$arch$ext" ./cmd/codie-spike
done
ls -l dist
