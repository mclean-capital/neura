// Load environment variables before all other imports
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import logger from "morgan";
import http from "http";
import cors from "cors";
import config from "./config.js";
import api from "./api/index.js";

// Initialize Express app
const app = express();

// Middleware
// Define allowed origins
const allowedOrigins = [
  "https://neura-20293.web.app", // Production frontend
  "http://localhost:5173", // Default Vite dev server
  "http://127.0.0.1:5173", // Alternative Vite dev server
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // Add any other ports if your local setup uses them
];

const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) {
    // Allow requests with no origin OR from allowed origins
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      const msg =
        "The CORS policy for this site does not allow access from the specified Origin.";
      callback(new Error(msg), false);
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true,
};

// Apply configured CORS middleware
app.use(cors(corsOptions));
// app.options('*', cors(corsOptions)); // Keep this commented for now
app.use(express.json());

app.use(logger("dev"));
app.set("trust proxy", true);
// Use built-in Express middleware instead of body-parser
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ limit: "3mb", extended: true }));
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
