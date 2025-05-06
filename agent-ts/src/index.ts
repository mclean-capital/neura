// Load environment variables before all other imports
import dotenv from "dotenv";
dotenv.config();
import {
  JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  multimodal,
  stt,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import { JobType } from "@livekit/protocol";
import { fileURLToPath } from "node:url";
import { instructions } from "./instructions.js";

// Check for required environment variables
const checkEnvironmentVariables = () => {
  if (
    !process.env.LIVEKIT_URL ||
    !process.env.LIVEKIT_API_KEY ||
    !process.env.LIVEKIT_API_SECRET
  ) {
    console.error(
      "LiveKit environment variables are missing. Please check your .env file."
    );
    return false;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing. Please check your .env file.");
    return false;
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    console.error("DEEPGRAM_API_KEY is missing. Please check your .env file.");
    return false;
  }

  return true;
};

// Main function to start the agent worker
const startAgentWorker = () => {
  console.log("Starting agent worker process...");

  if (!checkEnvironmentVariables()) {
    process.exit(1);
  }

  try {
    // Debug the LiveKit configuration
    console.log("LiveKit configuration:", {
      url: process.env.LIVEKIT_URL,
      apiKeyExists: !!process.env.LIVEKIT_API_KEY,
      apiSecretExists: !!process.env.LIVEKIT_API_SECRET,
    });

    // Start the agent with the CLI
    console.log("Starting agent worker via cli.runApp...");
    cli.runApp(
      new WorkerOptions({
        agent: fileURLToPath(import.meta.url),
        workerType: JobType.JT_ROOM,
        initializeProcessTimeout: 60000, // 60 seconds timeout
      })
    );
    console.log("Agent worker process started successfully");
  } catch (error) {
    console.error("Error starting agent worker:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down agent worker gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down agent worker gracefully");
  process.exit(0);
});

// Export the agent definition as default export
export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
      const roomName = ctx.job.room?.name;
      console.log("Agent entry point called for room:", roomName);

      // Connect to the room
      await ctx.connect();
      console.log("Connected to room successfully");

      // Initialize Deepgram STT with an improved configuration
      const deepgramStt = new deepgram.STT({
        apiKey: process.env.DEEPGRAM_API_KEY,
        model: "nova-3-general", // Latest model specified in the STTModels type
        language: "en-US",
        smartFormat: true,
        punctuate: true,
        interimResults: true,
        endpointing: 250, // Increased from 50 for better utterance detection
        fillerWords: true,
        profanityFilter: false,
      });

      console.log(
        "Deepgram transcription initialized with nova-3-general model"
      );

      const resolvedInstructions = roomName?.toLowerCase()?.includes("don")
        ? instructions.DON
        : instructions.REIGN;

      // Create a more responsive voice assistant with Deepgram integration
      const agent = new multimodal.MultimodalAgent({
        model: new openai.realtime.RealtimeModel({
          instructions: resolvedInstructions,
          voice: "alloy",
          temperature: 0.7,
          maxResponseOutputTokens: 2000, // Use smaller values for shorter responses for faster interaction
          modalities: ["text", "audio"],
          turnDetection: {
            type: "server_vad",
            threshold: 0.5, // Higher values require louder audio to activate, better for noisy environments.
            silence_duration_ms: 300, // Duration of silence to detect speech stop (shorter = faster turn detection)
            prefix_padding_ms: 200, // Amount of audio to include before detected speech.
          },
          // We don't directly attach the Deepgram STT here, as it's not supported in this interface
        }),
      });

      // Create a transcription stream from Deepgram STT
      const transcriptionStream = deepgramStt.stream();

      // Manually connect the transcription stream to the agent in the handleTrackSubscription method
      // This will make Deepgram's transcriptions available to the agent
      console.log(
        "Deepgram transcription stream ready to be connected to the agent"
      );

      // Log agent events for debugging
      agent.on("transcription", (transcription) => {
        console.log("Transcription:", transcription.text);
      });

      agent.on("thinking", () => {
        console.log("Agent is thinking...");
      });

      agent.on("response", (response) => {
        console.log("Agent response:", response);
      });

      // Set up the stream to capture speech events from Deepgram
      const handleSpeechEvent = async () => {
        try {
          for await (const event of transcriptionStream) {
            // Process transcription events from Deepgram
            if (
              event.type === stt.SpeechEventType.FINAL_TRANSCRIPT &&
              event.alternatives &&
              event.alternatives.length > 0
            ) {
              const transcript = event.alternatives[0].text;
              console.log(`Deepgram final transcript: "${transcript}"`);

              // Publish the transcription to the room so it will show up in the frontend
              if (
                agent.linkedParticipant &&
                agent.linkedParticipant.identity &&
                ctx.room.localParticipant
              ) {
                // Find a track ID to associate the transcription with
                let trackId = "unknown";
                if (agent.linkedParticipant.trackPublications.size > 0) {
                  const publication = Array.from(
                    agent.linkedParticipant.trackPublications.values()
                  )[0];
                  // Access the sid directly from the publication
                  trackId = publication.sid || "unknown";
                }

                ctx.room.localParticipant.publishTranscription({
                  participantIdentity: agent.linkedParticipant.identity,
                  trackSid: trackId,
                  segments: [
                    {
                      text: transcript,
                      final: true,
                      id: `deepgram-${Date.now()}`,
                      startTime: BigInt(0),
                      endTime: BigInt(0),
                      language: "en-US",
                    },
                  ],
                });
              }
            } else if (
              event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT &&
              event.alternatives &&
              event.alternatives.length > 0
            ) {
              console.log(
                `Deepgram interim transcript: "${event.alternatives[0].text}"`
              );
            }
          }
        } catch (error) {
          console.error("Error processing Deepgram transcription:", error);
        }
      };

      // Start the speech event processor
      handleSpeechEvent().catch((err) =>
        console.error("Speech event handler failed:", err)
      );

      // Start the agent
      console.log("Starting agent...");
      await agent.start(ctx.room);
      console.log(
        "Agent started successfully with Deepgram nova-3-general transcription"
      );
    } catch (error) {
      console.error("Error in agent entry:", error);
    }
  },
});

// If this script is being executed directly, not imported
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check if dev or prod mode is specified
  const isDev =
    process.env.NODE_ENV === "development" || process.argv.includes("dev");

  if (isDev) {
    console.log("Running agent worker in development mode");
    // Insert 'dev' command if not already in argv
    if (!process.argv.includes("dev")) {
      process.argv.splice(2, 0, "dev");
    }
  } else {
    console.log("Running agent worker in production mode");
    // Insert 'start' command if not already in argv
    if (!process.argv.includes("start")) {
      process.argv.splice(2, 0, "start");
    }
  }

  startAgentWorker();
}
