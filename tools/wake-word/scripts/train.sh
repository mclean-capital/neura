#!/usr/bin/env bash
# Train a wake word model from a config file.
#
# Usage: ./scripts/train.sh <config>
#   ./scripts/train.sh configs/jarvis.yaml
#   ./scripts/train.sh configs/neura.yaml
#
# Output: output/<name>/<name>.onnx

set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  echo "Usage: $0 <config.yaml>"
  echo ""
  echo "Available configs:"
  ls -1 configs/*.yaml 2>/dev/null | sed 's/^/  /'
  exit 1
fi

CONFIG="$1"
if [ ! -f "$CONFIG" ]; then
  echo "ERROR: Config file not found: $CONFIG"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "ERROR: Virtual environment not found. Run ./scripts/setup.sh first."
  exit 1
fi

source .venv/bin/activate

MODEL_NAME=$(grep "^model_name:" "$CONFIG" | awk '{print $2}')
echo "=== Training wake word: $MODEL_NAME ==="
echo "Config: $CONFIG"
echo "This will take ~30-45 minutes on Apple Silicon."
echo ""

livekit-wakeword run "$CONFIG"

ONNX_PATH="output/$MODEL_NAME/$MODEL_NAME.onnx"
if [ -f "$ONNX_PATH" ]; then
  echo ""
  echo "=== Training complete ==="
  echo "Model: $ONNX_PATH ($(du -h "$ONNX_PATH" | awk '{print $1}'))"
  echo ""
  echo "Deploy with:"
  echo "  ./scripts/deploy.sh $MODEL_NAME"
fi
