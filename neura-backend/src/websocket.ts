import http from "http";
import { Server, Socket } from "socket.io";
import geminiService from "./services/gemini";
import config from "./config";

interface ChatMessage {
  type: string;
  content?: string;
  audioData?: string;
  audioMimeType?: string;
  done?: boolean;
}

/**
 * Setup Socket.IO server
 * @param server HTTP server instance
 * @returns Socket.IO server instance
 */
export function setupWebSocketServer(server: http.Server) {
  const io = new Server(server, {
    cors: {
      origin: "*", // Configure as needed for production
      methods: ["GET", "POST"],
    },
  });

  // Generate connection IDs for logging
  let connectionCounter = 0;

  // Set up connection handling
  io.on("connection", (socket: Socket) => {
    // Assign a connection ID for tracking
    const connectionId = `conn-${++connectionCounter}`;

    console.log(`Client connected: ${connectionId}`);

    // Simple rate limiting
    let messageCount = 0;
    const messageCountResetInterval = setInterval(() => {
      messageCount = 0;
    }, 60000); // Reset every minute

    // Send welcome message
    socket.emit("connected", {
      content: "Connected to Gemini chat service",
    });

    // Handle prompt messages from client
    socket.on("prompt", async (data: { content: string }) => {
      try {
        // Rate limiting check
        messageCount++;
        if (messageCount > 30) {
          // 30 messages per minute
          socket.emit("error", {
            content: "Rate limit exceeded. Please try again later.",
          });
          return;
        }

        if (data.content) {
          // Process text prompt
          console.log(`Processing text prompt request from ${connectionId}`);
          const stream = await geminiService.streamChat(data.content);
          handleStreamResponse(stream, socket);
        } else {
          socket.emit("error", {
            content: "Invalid request: Missing content",
          });
        }
      } catch (error) {
        console.error("Error processing prompt:", error);
        socket.emit("error", {
          content: "Failed to process request",
        });
      }
    });

    // Handle audio messages from client
    socket.on(
      "audio",
      async (data: { audioData: string; audioMimeType: string }) => {
        try {
          // Rate limiting check
          messageCount++;
          if (messageCount > 30) {
            // 30 messages per minute
            socket.emit("error", {
              content: "Rate limit exceeded. Please try again later.",
            });
            return;
          }

          if (data.audioData && data.audioMimeType) {
            // Process audio prompt
            console.log(`Processing audio prompt request from ${connectionId}`);

            // Convert base64 string to buffer
            const audioBuffer = Buffer.from(data.audioData, "base64");

            // Call Gemini with audio data
            const stream = await geminiService.streamAudioChat({
              mimeType: data.audioMimeType,
              data: audioBuffer,
            });

            // Handle the response stream
            handleStreamResponse(stream, socket);
          } else {
            socket.emit("error", {
              content: "Invalid audio request: Missing required parameters",
            });
          }
        } catch (error) {
          console.error("Error processing audio:", error);
          socket.emit("error", {
            content: "Failed to process audio request",
          });
        }
      }
    );

    // Helper function to handle stream responses
    function handleStreamResponse(
      stream: NodeJS.ReadableStream,
      socket: Socket
    ) {
      stream.on("data", (chunk: Buffer | string) => {
        socket.emit("response", {
          content: chunk.toString(),
          done: false,
        });
      });

      stream.on("end", () => {
        socket.emit("response", {
          content: "",
          done: true,
        });
      });

      stream.on("error", (err: Error) => {
        socket.emit("error", {
          content: `Error processing request: ${err.message}`,
        });
      });
    }

    // Handle client disconnection
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${connectionId}`);
      clearInterval(messageCountResetInterval);
    });
  });

  return io;
}
