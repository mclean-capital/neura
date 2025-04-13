import express from "express";
import http from "http";
import cors from "cors";
import { setupWebSocketServer } from "./websocket";
import { authMiddleware } from "./middleware/auth";
import { googleAuth, verifyAuth } from "./controllers/auth";
import config from "./config";

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Setup WebSocket server
setupWebSocketServer(server);

// Public routes
app.post("/api/auth/google", googleAuth);

// Protected routes
app.get("/api/auth/verify", authMiddleware, verifyAuth);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Error handler
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

// Start server
const port = config.port;
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔒 Authorized email: ${config.allowedEmail}`);

  if (config.isDev) {
    console.log(`⚙️ Running in development mode`);
  }
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
