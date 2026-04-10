# Wake Word Training

Train custom on-device wake word models for Neura. Models run via ONNX Runtime in the Node.js core server — no cloud API, ~5-20ms inference, zero cost.

Built on [livekit-wakeword](https://github.com/livekit/livekit-wakeword) (Apache 2.0).

## Quick Start

```bash
cd tools/wake-word

# 1. Setup (one-time): installs Python venv, livekit-wakeword, downloads training data
./scripts/setup.sh

# 2. Train: generates synthetic speech, trains Conv-Attention classifier (~45 min)
./scripts/train.sh configs/jarvis.yaml

# 3. Deploy: copies .onnx model to ~/.neura/models/
./scripts/deploy.sh jarvis

# 4. Use: set wake word in config or env
export NEURA_ASSISTANT_NAME=jarvis
```

## How It Works

### Pipeline

```
"hey jarvis" (text)
    ↓
VITS TTS synthesis (904 speaker blending × 3 speaking rates)
    ↓
5,000 positive clips + 5,000 adversarial negatives
    ↓
Augmentation (reverb, background noise, EQ distortion, 2 rounds)
    ↓
Feature extraction (mel spectrogram → speech embeddings, all ONNX)
    ↓
3-phase adaptive training (Conv-Attention classifier, 30K steps)
    ↓
Export to ONNX (~170 KB model)
    ↓
jarvis.onnx → ~/.neura/models/
```

### Runtime Inference

```
Microphone audio (24kHz PCM)
    ↓
Resample to 16kHz
    ↓
Mel spectrogram (melspectrogram.onnx, 1 MB)
    ↓
Speech embeddings (embedding_model.onnx, 1.3 MB)
    ↓
Classifier (jarvis.onnx, ~170 KB)
    ↓
Confidence score 0.0–1.0
    ↓
Score ≥ 0.5 → wake detected → activate voice session
```

## Creating a New Wake Word

### 1. Create a config

Copy an existing config and modify:

```bash
cp configs/jarvis.yaml configs/alfred.yaml
```

Edit `configs/alfred.yaml`:

```yaml
model_name: alfred
target_phrases: ['hey alfred']

# Add phonetically similar phrases that should NOT trigger
custom_negative_phrases:
  - 'alfred'
  - 'hey offered'
  - 'hey all fred'
  - 'hey alford'
  - 'hey halford'
  - 'that alfred'
  - 'the alfred'
```

**Tips for adversarial negatives:**

- Include the wake word without the prefix ("alfred" vs "hey alfred")
- Include phonetically similar words (rhymes, similar vowels/consonants)
- Include common phrases that sound similar with the prefix
- 10-15 negatives is a good starting point

### 2. Train

```bash
./scripts/train.sh configs/alfred.yaml
```

**What happens during training:**

| Stage    | Time       | What                                                                       |
| -------- | ---------- | -------------------------------------------------------------------------- |
| Generate | ~10-15 min | VITS TTS synthesizes 12,000 audio clips (positive + negative + background) |
| Augment  | ~5-10 min  | Adds room reverb, background noise, EQ distortion (2 rounds)               |
| Extract  | ~2-5 min   | Runs mel spectrogram + embedding ONNX models on all clips                  |
| Train    | ~15-20 min | 30K steps, 3-phase adaptive (full → refinement → fine-tuning)              |
| Export   | ~5 sec     | PyTorch → ONNX conversion                                                  |
| Eval     | ~1 min     | DET curve, false positives/hour, recall metrics                            |

### 3. Review results

After training, check `output/alfred/alfred_eval.json`:

```json
{
  "accuracy": 0.917,
  "recall": 0.835,
  "fpph": 1.9,
  "optimal_threshold": 0.8,
  "optimal_recall": 0.645,
  "optimal_fpph": 0.168
}
```

**Key metrics:**

- **Recall** — % of wake words correctly detected (higher = fewer misses)
- **FPPH** — false positives per hour (lower = fewer false triggers)
- **Accuracy** — overall classification accuracy

### 4. Deploy

```bash
./scripts/deploy.sh alfred
```

### 5. Configure

Set the wake word in `~/.neura/config.json`:

```json
{
  "assistantName": "alfred"
}
```

Or via environment variable:

```bash
export NEURA_ASSISTANT_NAME=alfred
```

## Improving Model Quality

### Download ACAV100M (recommended for production)

The setup script skips the 16 GB ACAV100M general speech dataset by default. Including it significantly reduces false positive rates:

```bash
./scripts/setup.sh --with-acav
```

Then retrain your models.

### Increase training data

For production models, increase `n_samples` and `steps`:

```yaml
n_samples: 20000 # was 5000
n_samples_val: 4000 # was 1000
steps: 100000 # was 30000
```

This increases training time to ~2-3 hours but produces more robust models.

### Add more adversarial negatives

The most impactful improvement is better adversarial negatives. Listen for what causes false positives in practice and add those phrases to `custom_negative_phrases`.

## File Structure

```
tools/wake-word/
  configs/               Training configs (one per wake word)
    jarvis.yaml
    neura.yaml
  scripts/               Shell scripts for the training pipeline
    setup.sh             One-time environment setup
    train.sh             Train a model from config
    deploy.sh            Copy model to ~/.neura/models/
  data/                  (gitignored) Downloaded training data
    piper/               VITS TTS model (~166 MB)
    backgrounds/         MUSAN background noise (~1.1 GB)
    rirs/                Room impulse responses (~8 MB)
    features/            ACAV100M features (optional, ~16 GB)
  output/                (gitignored) Training output
    jarvis/
      jarvis.onnx        Trained classifier model
      jarvis_eval.json   Evaluation metrics
      jarvis_det.png     DET curve plot
  .venv/                 (gitignored) Python virtual environment
```

## Installed Models

Models are stored at `~/.neura/models/`:

| File                   | Size    | Purpose                                   |
| ---------------------- | ------- | ----------------------------------------- |
| `melspectrogram.onnx`  | 1.0 MB  | Stage 1: audio → mel features (shared)    |
| `embedding_model.onnx` | 1.3 MB  | Stage 2: mel → speech embeddings (shared) |
| `jarvis.onnx`          | ~170 KB | Classifier: "hey jarvis"                  |
| `neura.onnx`           | ~170 KB | Classifier: "hey neura"                   |

The mel and embedding models are shared infrastructure — deployed once, used by all wake words. Only the classifier is wake-word-specific.

## Requirements

- Python 3.11+ (training only — not needed at runtime)
- espeak-ng, ffmpeg (training only)
- ~2 GB disk for training data (without ACAV100M)
- Apple Silicon Mac or CUDA GPU recommended (CPU works but slower)
