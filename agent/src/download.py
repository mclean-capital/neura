import logging

# Import LiveKit components
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    WorkerType,
    cli,
    # multimodal, # Removed in v1.0
    stt, # For stt.STT type hint
    Agent, # Import Agent from top-level livekit.agents
    AgentSession,
    # AudioData, # Removed as it seems unused with v1.0 VoiceAgent structure
    # STTData,   # Type hints use stt.stt
    # TTSData,   # Type hints use tts.tts
    RoomInputOptions,
    RoomOutputOptions, # Added for session.start()
    llm,       # For llm.LLM, llm.RealtimeModel type hints
    tts,       # For tts.TTS type hint
    vad,       # For VAD plugin type hint
)
# from livekit.agents.voice import Agent as VoiceAgent # Removed, using top-level Agent
from livekit.agents.stt import SpeechEventType      # For STT event types
from livekit.plugins import openai, deepgram, silero, google # Silero for VAD, Google for LLM
from livekit.plugins.turn_detector.english import EnglishModel # For client-side turn detection

logger = logging.getLogger("my-worker")
logger.setLevel(logging.INFO)

async def entrypoint(ctx: JobContext):
    logger.info("starting entrypoint")
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)
    logger.info("connected to the room")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, worker_type=WorkerType.ROOM))