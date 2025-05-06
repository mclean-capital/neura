# LiveKit Agent Service (Python)

This is a Python implementation of the LiveKit Agent service, ported from TypeScript. It provides voice assistant functionality using LiveKit, Deepgram for speech-to-text, and OpenAI for the language model and text-to-speech.

## Prerequisites

- Python 3.9 or higher
- LiveKit server (can use LiveKit Cloud)
- OpenAI API key
- Deepgram API key

## Installation

1. Clone the repository
2. Set up environment variables:
   ```
   cp .env.example .env
   ```
3. Edit `.env` file with your API keys and LiveKit configuration
4. Run the setup script:
   ```
   ./run.sh --install
   ```

## Running the Service

### Development Mode

```bash
./run.sh dev
```

### Production Mode

```bash
./run.sh
```

## Docker Support

Build the Docker image:

```bash
docker build --no-cache -t neura-agent .
```

Run with Docker:

```bash
docker run -d -p 8081:8081 -it --env-file ./agent/.env neura-agent
```

## Configuration

The agent can be configured through environment variables:

- `LIVEKIT_URL`: The WebSocket URL of your LiveKit server
- `LIVEKIT_API_KEY`: Your LiveKit API key
- `LIVEKIT_API_SECRET`: Your LiveKit API secret
- `OPENAI_API_KEY`: Your OpenAI API key. Required if `MODEL_TYPE` is "openai" or as a fallback.
- `DEEPGRAM_API_KEY`: Your Deepgram API key
- `MODEL_TYPE`: (Optional) Specifies the LLM provider.
  - `"openai"` (default): Uses OpenAI's models. Requires `OPENAI_API_KEY`.
  - `"google"` or `"gemini"`: Uses Google's Gemini models. Requires `GOOGLE_API_KEY`.
- `GOOGLE_API_KEY`: Your Google API key for Gemini models. Required if `MODEL_TYPE` is "google" or "gemini" and you are not using Vertex AI for authentication.

## Features

- Speech-to-text via Deepgram
- Text processing via OpenAI
- Text-to-speech via OpenAI
- Voice activity detection
- Customizable instructions based on room name

## Project Structure

```
agent-py/
├── src/
│   ├── __init__.py
│   ├── main.py        # Main entry point
│   └── instructions.py # Agent instructions
├── .env.example       # Example environment variables
├── Dockerfile         # Docker configuration
├── requirements.txt   # Python dependencies
└── run.sh            # Convenience script for running the service
```
