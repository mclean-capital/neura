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
from typing import Optional
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
    multimodal,
    stt
)
from livekit.agents.stt import SpeechEventType
from livekit.plugins import openai, deepgram

# Import local modules
from .instructions import instructions


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
        room_name = ctx.job.room.name if ctx.job.room else None
        logger.info(f"Agent entry point called for room: {room_name}")

        # Connect to the room
        await ctx.connect()
        logger.info("Connected to room successfully")

        # Initialize Deepgram STT with an improved configuration
        deepgram_stt = deepgram.STT(
            api_key=os.environ["DEEPGRAM_API_KEY"],
            model="nova-3-general",  # Latest model specified in the STTModels type
            language="en-US",
            smart_format=True,
            punctuate=True,
            interim_results=True,
            endpointing_ms=250,  # Increased from 50 for better utterance detection
            filler_words=True,
            profanity_filter=False,
        )

        logger.info(
            "Deepgram transcription initialized with nova-3-general model"
        )

        # Determine which instructions to use based on room name
        resolved_instructions = (
            instructions["DON"]
            if room_name and "don" in room_name.lower()
            else instructions["REIGN"]
        )

        # Create a more responsive voice assistant with Deepgram integration
        agent = multimodal.MultimodalAgent(
            model=openai.realtime.RealtimeModel(
                instructions=resolved_instructions,
                voice="alloy",
                temperature=0.7,
                max_response_output_tokens=2000,  # Use smaller values for shorter responses for faster interaction
                modalities=["text", "audio"],
                turn_detection={
                    "type": "server_vad",
                    "threshold": 0.5,  # Higher values require louder audio to activate, better for noisy environments.
                    "silence_duration_ms": 300,  # Duration of silence to detect speech stop (shorter = faster turn detection)
                    "prefix_padding_ms": 200,  # Amount of audio to include before detected speech.
                }
            )
        )

        # Create a transcription stream from Deepgram STT
        transcription_stream = deepgram_stt.stream()

        # Set up event handlers for agent
        agent.on("transcription", lambda transcription: 
            logger.info(f"Transcription: {transcription.text}")
        )

        agent.on("thinking", lambda: 
            logger.info("Agent is thinking...")
        )

        agent.on("response", lambda response: 
            logger.info(f"Agent response: {response}")
        )

        # Note: The transcription stream will be automatically utilized by the agent when it receives audio
        logger.info("Deepgram transcription stream ready for agent")

        # Set up the stream to capture speech events from Deepgram
        async def handle_speech_event():
            try:
                async for event in transcription_stream:
                    # Process transcription events from Deepgram
                    if (
                        event.type == SpeechEventType.FINAL_TRANSCRIPT and
                        event.alternatives and
                        len(event.alternatives) > 0
                    ):
                        transcript = event.alternatives[0].text
                        logger.info(f'Deepgram final transcript: "{transcript}"')
                        
                        # Send the transcription to the agent for processing
                        agent.process_transcription(event)
                        
                        # Publish the transcription to the room so it will show up in the frontend
                        if (
                            agent.linked_participant and
                            agent.linked_participant.identity and
                            ctx.room.local_participant
                        ):
                            # Find a track ID to associate the transcription with
                            track_id = "unknown"
                            if agent.linked_participant.track_publications.size > 0:
                                publication = next(iter(agent.linked_participant.track_publications.values()))
                                # Access the sid directly from the publication
                                track_id = getattr(publication, "sid", "unknown")

                            ctx.room.local_participant.publish_transcription({
                                "participant_identity": agent.linked_participant.identity,
                                "track_sid": track_id,
                                "segments": [
                                    {
                                        "text": transcript,
                                        "final": True,
                                        "id": f"deepgram-{int(asyncio.get_event_loop().time() * 1000)}",
                                        "start_time": 0,
                                        "end_time": 0,
                                        "language": "en-US",
                                    },
                                ],
                            })
                    elif (
                        event.type == SpeechEventType.INTERIM_TRANSCRIPT and
                        event.alternatives and
                        len(event.alternatives) > 0
                    ):
                        logger.info(
                            f'Deepgram interim transcript: "{event.alternatives[0].text}"'
                        )
            except Exception as error:
                logger.error(f"Error processing Deepgram transcription: {error}")

        # Start the speech event processor
        asyncio.create_task(handle_speech_event())

        # Start the agent
        logger.info("Starting agent...")
        if agent is None:
            logger.error("Agent is None, cannot start")
            return
        
        if ctx.room is None:
            logger.error("Room is None, cannot start agent")
            return
        
        try:
            # Don't await the start method - it returns None, not a coroutine
            agent.start(ctx.room)
            logger.info("Agent started successfully with Deepgram nova-3-general transcription")
        except Exception as e:
            logger.error(f"Error starting agent: {e}")
            raise
    except Exception as error:
        logger.error(f"Error in agent entry: {error}")


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
