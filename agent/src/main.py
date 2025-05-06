#!/usr/bin/env python3
"""
Main entry point for the agent service.
Python port of the TypeScript agent service.
"""

# Load environment variables before all other imports
import os
import sys
import asyncio
import signal
from typing import Optional, Union # Added Union
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# Import LiveKit components
from livekit.agents import (
    JobContext,
    WorkerOptions,
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
from livekit.plugins import openai, deepgram, silero # Silero for VAD

# Import local modules
from .instructions import instructions

# Define our custom agent based on the v1.0 VoiceAgent
class MyAgent(Agent): # Inherit from livekit.agents.Agent
    def __init__(self, 
                 job_ctx: JobContext, 
                 llm_plugin: Union[llm.LLM, llm.RealtimeModel], # Changed to Union for Py3.9
                 instructions_text: str, 
                 turn_detection_config: dict):
        # Initialize the base VoiceAgent.
        # STT and TTS will be picked up from the AgentSession.
        # If we wanted to override session STT/TTS, we could pass stt_plugin/tts_plugin here.
        super().__init__(
            instructions=instructions_text,
            llm=llm_plugin,
            turn_detection=turn_detection_config
        )
        self.job_ctx = job_ctx # For publishing transcriptions to frontend

        # Optional: Listen to internal agent events if needed for logging
        # self.on("thinking", lambda: logger.info("Agent is thinking..."))
        # self.on("response", lambda response_event: logger.info(f"Agent LLM response: {response_event}"))

    async def astart(self):
        """Called when the agent is added to a session and the session starts."""
        logger.info("MyAgent started in session. Initiating conversation.")
        # The initial greeting is now typically triggered by the session
        # For example, in agent_entry: await session.generate_reply(instructions="...")
        # Or we can trigger it here using self.session:
        await self.session.generate_reply(instructions="greet the user and ask about their day")

    # Override _on_tts_data to capture synthesized speech and publish it
    async def _on_tts_data(self, data: tts.tts): # Changed to tts.tts
        """Handles TTS data synthesized by this agent."""
        # Let the base class handle its logic first (e.g., playback)
        await super()._on_tts_data(data)

        logger.info(f"Agent synthesized speech: {data.text}")
        if self.job_ctx.room and self.job_ctx.room.local_participant:
            text_to_publish = data.text
            self.job_ctx.room.local_participant.publish_transcription({
                "participant_identity": "agent",
                "track_sid": "agent-track", # Consider using data.play_request_id or similar if available
                "segments": [
                    {
                        "text": text_to_publish,
                        "final": True,
                        "id": f"agent-speech-{int(asyncio.get_event_loop().time() * 1000)}",
                        "start_time": 0,
                        "end_time": 0,
                        "language": "en-US", # Assuming en-US, adjust if needed
                    },
                ],
            })
            logger.info(f"Published agent speech to frontend: {text_to_publish}")

    async def _on_stt_data(self, event: stt.stt): # Changed to stt.stt
        """Handles STT data received by the Agent class from AgentSession."""
        # The base Agent class's _on_stt_data likely handles calling self.process_transcription
        # if an LLM is configured. We just need to publish the transcript here.
        await super()._on_stt_data(event) # Call base class method first

        if event.type == SpeechEventType.FINAL_TRANSCRIPT and event.alternatives and len(event.alternatives) > 0:
            transcript = event.alternatives[0].text
            participant_identity = event.participant.identity if event.participant else "unknown_user"
            logger.info(f'User final transcript from {participant_identity}: "{transcript}"')

            # Publish user transcription to the frontend
            if self.job_ctx.room and self.job_ctx.room.local_participant and event.participant:
                track_sid = event.track_id if hasattr(event, 'track_id') and event.track_id else "user-track"
                self.job_ctx.room.local_participant.publish_transcription({
                    "participant_identity": participant_identity,
                    "track_sid": track_sid,
                    "segments": [
                        {
                            "text": transcript,
                            "final": True,
                            "id": f"user-stt-{int(asyncio.get_event_loop().time() * 1000)}",
                            "start_time": event.start_time if hasattr(event, 'start_time') else 0,
                            "end_time": event.end_time if hasattr(event, 'end_time') else 0,
                            "language": event.language if event.language else "en-US",
                        },
                    ],
                })
                logger.info(f"Published user transcript from {participant_identity} to frontend.")
        elif event.type == SpeechEventType.INTERIM_TRANSCRIPT and event.alternatives and len(event.alternatives) > 0:
            # Optionally publish interim results too
            logger.info(f'User interim transcript: "{event.alternatives[0].text}"')


def check_environment_variables() -> bool:
    """
    Check for required environment variables.
    Returns True if all required variables are present, False otherwise.
    """
    if (
        not os.environ.get("LIVEKIT_URL") or
        not os.environ.get("LIVEKIT_API_KEY") or
        not os.environ.get("LIVEKIT_API_SECRET")
    ):
        logger.error(
            "LiveKit environment variables are missing. Please check your .env file."
        )
        return False

    if not os.environ.get("OPENAI_API_KEY"):
        logger.error("OPENAI_API_KEY is missing. Please check your .env file.")
        return False

    if not os.environ.get("DEEPGRAM_API_KEY"):
        logger.error("DEEPGRAM_API_KEY is missing. Please check your .env file.")
        return False

    return True


def setup_signal_handlers():
    """Set up handlers for graceful shutdown."""
    
    def signal_handler(sig, frame):
        signal_name = "SIGTERM" if sig == signal.SIGTERM else "SIGINT"
        logger.info(f"{signal_name} received, shutting down agent worker gracefully")
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)


async def agent_entry(ctx: JobContext):
    """
    Entry point for the agent. This is the equivalent of the 'entry' function
    in the TypeScript version.
    """
    try:
        room_name = ctx.job.room.name if ctx.job.room else "default_room"
        logger.info(f"Agent entry point called for room: {room_name}")

        # Connect JobContext to the room, similar to basic_agent.py example
        # This might handle default auto-subscription.
        await ctx.connect()
        logger.info("JobContext connected to room.")

        # Initialize Deepgram STT plugin
        deepgram_stt_plugin = deepgram.STT(
            api_key=os.environ["DEEPGRAM_API_KEY"],
            model="nova-3-general",
            language="en-US",
            smart_format=True,
            punctuate=True,
            interim_results=True, # MyAgent's _on_stt_data can handle interim if needed
            endpointing_ms=250,
            filler_words=True,
            profanity_filter=False,
        )
        logger.info("Deepgram STT plugin initialized.")

        # Initialize OpenAI TTS plugin (used by the parent Agent class if configured)
        # The MultimodalAgent's RealtimeModel also has its own TTS capabilities.
        # For simplicity, we'll let MultimodalAgent handle its TTS, but MyAgent could also use this.
        openai_tts_plugin = openai.TTS(api_key=os.environ["OPENAI_API_KEY"], voice="alloy") # This is fine for session
        logger.info("OpenAI TTS plugin initialized.")

        # LLM Plugin (OpenAI RealtimeModel)
        openai_llm_plugin = openai.realtime.RealtimeModel(
            # instructions are passed to MyAgent, then to super().__init__
            voice="alloy", # This is for the LLM's integrated TTS, if used by RealtimeModel directly
            temperature=0.7
            # max_response_output_tokens=2000, # Removed, not a valid param in v1.0 plugin
            # modalities=["text", "audio"] # Removed, also not a valid param in the installed v1.0 plugin
            # turn_detection for RealtimeModel is configured below for the Agent
        )
        logger.info("OpenAI RealtimeModel LLM plugin initialized.")

        # Determine which instructions to use
        resolved_instructions = (
            instructions["DON"]
            if room_name and "don" in room_name.lower()
            else instructions["REIGN"]
        )

        # Turn detection configuration for the Agent
        turn_detection_config = {
            "type": "server_vad",
            "threshold": 0.5,
            "silence_duration_ms": 300,
            "prefix_padding_ms": 200,
        }

        # Create our custom agent
        my_agent = MyAgent(
            job_ctx=ctx,
            llm_plugin=openai_llm_plugin,
            instructions_text=resolved_instructions,
            turn_detection_config=turn_detection_config
        )
        logger.info("MyAgent instance created.")

        # VAD plugin (optional but good practice for voice agents)
        vad_plugin = silero.VAD.load() # Use the load() class method as per examples
        logger.info("Silero VAD plugin initialized.")

        # Create AgentSession with plugins
        session = AgentSession(
            stt=deepgram_stt_plugin,
            tts=openai_tts_plugin,
            vad=vad_plugin,
            # LLM is configured on MyAgent instance directly
        )
        logger.info("AgentSession created with STT, TTS, VAD.")

        # Define RoomInputOptions - default might be okay for audio if ctx.connect() handles subscription.
        # If specific control is needed, we'd explore its parameters. For now, let's use defaults.
        room_input_options = RoomInputOptions() 

        # Define RoomOutputOptions - enabling transcription publishing is important for us
        room_output_options = RoomOutputOptions(transcription_enabled=True)

        # Start the agent session
        logger.info("Starting AgentSession with session.start()...")
        await session.start(
            room=ctx.room,
            agent=my_agent,
            room_input_options=room_input_options,
            room_output_options=room_output_options
        )
        # MyAgent.astart() will be called by the session, which then calls self.session.generate_reply().
        # The session will run until the job is complete or an error occurs.
        # cli.run_app manages the overall lifecycle.

        logger.info("AgentSession processing likely ongoing in background via cli.run_app.")

    except Exception as error:
        logger.error(f"Error in agent_entry: {error}", exc_info=True)
        # Re-raise the exception so it's caught by the worker CLI if necessary
        raise


def start_agent_worker():
    """
    Start the agent worker process. Equivalent to the startAgentWorker function
    in the TypeScript version.
    """
    logger.info("Starting agent worker process...")

    if not check_environment_variables():
        sys.exit(1)

    try:
        # Debug the LiveKit configuration
        logger.info("LiveKit configuration: %s", {
            "url": os.environ.get("LIVEKIT_URL"),
            "apiKeyExists": bool(os.environ.get("LIVEKIT_API_KEY")),
            "apiSecretExists": bool(os.environ.get("LIVEKIT_API_SECRET")),
        })

        # Start the agent with the CLI - use WorkerType.ROOM
        from livekit.agents import WorkerType
        logger.info("Starting agent worker via cli.run_app...")
        cli.run_app(
            WorkerOptions(
                entrypoint_fnc=agent_entry,
                worker_type=WorkerType.ROOM,  # Use WorkerType enum
                initialize_process_timeout=60000,  # 60 seconds timeout
            )
        )
        logger.info("Agent worker process started successfully")
    except Exception as error:
        logger.error(f"Error starting agent worker: {error}")
        sys.exit(1)


if __name__ == "__main__":
    setup_signal_handlers()
    
    # Check if dev or prod mode is specified
    is_dev = (
        os.environ.get("NODE_ENV") == "development" or 
        "dev" in sys.argv
    )

    if is_dev:
        logger.info("Running agent worker in development mode")
        # Insert 'dev' command if not already in argv
        if "dev" not in sys.argv:
            sys.argv.insert(1, "dev")
    else:
        logger.info("Running agent worker in production mode")
        # Insert 'start' command if not already in argv
        if "start" not in sys.argv:
            sys.argv.insert(1, "start")

    start_agent_worker()
