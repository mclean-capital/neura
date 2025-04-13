import http from "http";
import { IncomingMessage } from "http";
import WebSocket from "ws";
import geminiService from "./services/gemini";
import config from "./config";

// Simplified user tracking for WebSocket connections

interface WebSocketWithUser extends WebSocket {
  // Track connection ID for logging purposes only
  connectionId?: string;
}

interface WebSocketMessage {
  type: string;
  content?: string;
  done?: boolean;
}

/**
 * Setup WebSocket server
 * @param server HTTP server instance
 * @returns WebSocket server instance
 */
export function setupWebSocketServer(server: http.Server) {
  const wss = new WebSocket.Server({ server });

  // Generate connection IDs for logging
  let connectionCounter = 0;

  // Set up connection handling
  wss.on("connection", (ws: WebSocketWithUser, req: IncomingMessage) => {
    // Assign a connection ID for tracking
    const connectionId = `conn-${++connectionCounter}`;
    ws.connectionId = connectionId;

    console.log(`Client connected: ${connectionId}`);

    // Simple rate limiting
    let messageCount = 0;
    const messageCountResetInterval = setInterval(() => {
      messageCount = 0;
    }, 60000); // Reset every minute

    // Handle messages from client
    ws.on("message", async (message: WebSocket.Data) => {
      try {
        // Rate limiting check
        messageCount++;
        if (messageCount > 30) {
          // 30 messages per minute
          ws.send(
            JSON.stringify({
              type: "error",
              content: "Rate limit exceeded. Please try again later.",
            })
          );
          return;
        }

        // Parse message
        const data = JSON.parse(message.toString()) as WebSocketMessage;

        if (data.type === "prompt" && data.content) {
          // Log the request
          console.log(`Processing prompt request from ${ws.connectionId}`);

          // Get a stream from the Gemini service
          const stream = await geminiService.streamChat(data.content);

          // Handle the stream data
          stream.on("data", (chunk: Buffer | string) => {
            ws.send(
              JSON.stringify({
                type: "response",
                content: chunk.toString(),
                done: false,
              })
            );
          });

          stream.on("end", () => {
            ws.send(
              JSON.stringify({
                type: "response",
                content: "",
                done: true,
              })
            );
          });

          stream.on("error", (err: Error) => {
            ws.send(
              JSON.stringify({
                type: "error",
                content: `Error processing request: ${err.message}`,
              })
            );
          });
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              content: "Invalid request type",
            })
          );
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
        ws.send(
          JSON.stringify({
            type: "error",
            content: "Failed to process request",
          })
        );
      }
    });

    // Handle client disconnection
    ws.on("close", () => {
      console.log(`Client disconnected: ${ws.connectionId}`);
      clearInterval(messageCountResetInterval);
    });

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        content: "Connected to Gemini chat service",
      })
    );
  });

  return wss;
}
