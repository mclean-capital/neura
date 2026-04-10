#!/usr/bin/env bash
# Deploy trained wake word model(s) to ~/.neura/models/
#
# Usage: ./scripts/deploy.sh <name>     Deploy a specific model
#        ./scripts/deploy.sh --all      Deploy all trained models
#
# Also deploys the infrastructure models (melspectrogram + embedding)
# on first run if they're not already installed.

set -euo pipefail
cd "$(dirname "$0")/.."

MODELS_DIR="${NEURA_HOME:-$HOME/.neura}/models"
mkdir -p "$MODELS_DIR"

# Deploy infrastructure models (mel + embedding) if needed
deploy_infra() {
  local VENV_RESOURCES=".venv/lib/python*/site-packages/livekit/wakeword/resources"

  for model in melspectrogram.onnx embedding_model.onnx; do
    if [ ! -f "$MODELS_DIR/$model" ]; then
      local src=$(ls $VENV_RESOURCES/$model 2>/dev/null | head -1)
      if [ -n "$src" ]; then
        cp "$src" "$MODELS_DIR/$model"
        echo "  Deployed infrastructure model: $model"
      else
        echo "  WARNING: $model not found in venv. Run ./scripts/setup.sh first."
      fi
    fi
  done
}

deploy_model() {
  local name="$1"
  local src="output/$name/$name.onnx"

  if [ ! -f "$src" ]; then
    echo "ERROR: Trained model not found: $src"
    echo "Train it first: ./scripts/train.sh configs/$name.yaml"
    return 1
  fi

  cp "$src" "$MODELS_DIR/$name.onnx"
  echo "  Deployed: $name.onnx ($(du -h "$MODELS_DIR/$name.onnx" | awk '{print $1}'))"
}

echo "=== Deploying wake word models ==="
echo "Target: $MODELS_DIR"
echo ""

deploy_infra

if [[ "${1:-}" == "--all" ]]; then
  for dir in output/*/; do
    name=$(basename "$dir")
    onnx="$dir/$name.onnx"
    if [ -f "$onnx" ]; then
      deploy_model "$name"
    fi
  done
else
  if [ $# -eq 0 ]; then
    echo "Usage: $0 <name>     Deploy a specific model"
    echo "       $0 --all      Deploy all trained models"
    echo ""
    echo "Trained models available:"
    for dir in output/*/; do
      name=$(basename "$dir")
      onnx="$dir/$name.onnx"
      if [ -f "$onnx" ]; then
        echo "  $name ($(du -h "$onnx" | awk '{print $1}'))"
      fi
    done 2>/dev/null
    echo ""
    echo "Installed models:"
    ls -1 "$MODELS_DIR"/*.onnx 2>/dev/null | while read f; do
      name=$(basename "$f" .onnx)
      case "$name" in
        melspectrogram|embedding_model) ;; # skip infra
        *) echo "  $name ($(du -h "$f" | awk '{print $1}'))" ;;
      esac
    done
    exit 1
  fi
  deploy_model "$1"
fi

echo ""
echo "=== Installed wake words ==="
ls -1 "$MODELS_DIR"/*.onnx 2>/dev/null | while read f; do
  name=$(basename "$f" .onnx)
  case "$name" in
    melspectrogram|embedding_model) ;; # skip infra
    *) echo "  $name" ;;
  esac
done
echo ""
echo "Set your wake word: NEURA_ASSISTANT_NAME=jarvis (or in ~/.neura/config.json)"
