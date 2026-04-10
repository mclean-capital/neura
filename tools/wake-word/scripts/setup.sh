#!/usr/bin/env bash
# Setup the wake word training environment.
# Run once before training your first model.
#
# Usage: ./scripts/setup.sh [--with-acav]
#   --with-acav  Download the 16 GB ACAV100M dataset for lower false positive rates.
#                Without it, training is faster but models may have slightly higher FPPH.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Wake Word Training Setup ==="

# 1. System dependencies
echo "Checking system dependencies..."
for cmd in python3 espeak-ng ffmpeg; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Install it:"
    case "$cmd" in
      python3)  echo "  brew install python@3.12  (or use pyenv/conda)" ;;
      espeak-ng) echo "  brew install espeak-ng" ;;
      ffmpeg)    echo "  brew install ffmpeg" ;;
    esac
    exit 1
  fi
done
echo "  python3:   $(python3 --version)"
echo "  espeak-ng: $(espeak-ng --version 2>&1 | head -1)"
echo "  ffmpeg:    $(ffmpeg -version 2>&1 | head -1)"

# 2. Python venv
if [ ! -d ".venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv
fi
source .venv/bin/activate

# 3. Install livekit-wakeword with training extras
echo "Installing livekit-wakeword[train,eval,export]..."
pip install -q "livekit-wakeword[train,eval,export]"

# 4. Fix webrtcvad on Apple Silicon (Rosetta shell compiles x86_64 by default)
if [ "$(uname -m)" = "arm64" ] || python3 -c "import platform; exit(0 if platform.machine()=='arm64' else 1)" 2>/dev/null; then
  echo "Rebuilding webrtcvad for arm64..."
  ARCHFLAGS="-arch arm64" pip install --force-reinstall --no-cache-dir --no-binary :all: webrtcvad -q
fi

# 5. Download training data
SKIP_FLAG="--skip-acav"
if [[ "${1:-}" == "--with-acav" ]]; then
  SKIP_FLAG=""
  echo "Downloading training data (including ACAV100M ~16 GB)..."
else
  echo "Downloading training data (skipping ACAV100M, use --with-acav for full dataset)..."
fi
livekit-wakeword setup $SKIP_FLAG

echo ""
echo "=== Setup complete ==="
echo "Next: Train a wake word model:"
echo "  source .venv/bin/activate"
echo "  livekit-wakeword run configs/jarvis.yaml"
