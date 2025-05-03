// Load environment variables before all other imports
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import logger from "morgan";
import bodyParser from "body-parser";
import http from "http";
import cors from "cors";
import config from "./config.js";
import api from "./api/index.js";
import { startLivekitAgent } from "./services/livekit-openai-server.js";

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

app.use(logger("dev"));
app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ limit: "3mb", extended: true }));
app.disable("x-powered-by");

// Create HTTP server
const server = http.createServer(app);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api", api);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const port = config.port;
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔒 Authorized email: ${config.allowedEmail}`);

  if (config.isDev) {
    console.log(`⚙️ Running in development mode`);
  }

  // Start the LiveKit agent server
  startLivekitAgent();
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
