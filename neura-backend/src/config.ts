import dotenv from "dotenv";
import * as path from "path";
import { z } from "zod";

// Load environment variables from .env.local or .env file
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// Define schema for environment variables
const envSchema = z.object({
  // Server configuration
  PORT: z.string().default("3001"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),

  // Google Gemini API
  GEMINI_API_KEY: z.string().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // JWT Secret for session tokens
  JWT_SECRET: z.string().optional(),

  // Access restriction
  ALLOWED_EMAIL: z.string().optional(),

  // LiveKit configuration
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // OpenAI API Key for LiveKit agents
  OPENAI_API_KEY: z.string().optional(),
});

// Parse environment variables or throw error
const env = envSchema.safeParse(process.env);

if (!env.success) {
  console.error("❌ Invalid environment variables:", env.error.format());
  throw new Error("Invalid environment variables");
}

// Export validated config
export const config = {
  port: parseInt(env.data.PORT, 10),
  nodeEnv: env.data.NODE_ENV,
  frontendUrl: env.data.FRONTEND_URL || "http://localhost:3000",
  geminiApiKey: env.data.GEMINI_API_KEY || "",
  googleClientId: env.data.GOOGLE_CLIENT_ID || "",
  googleClientSecret: env.data.GOOGLE_CLIENT_SECRET || "",
  jwtSecret: env.data.JWT_SECRET || "",
  allowedEmail: env.data.ALLOWED_EMAIL || "",
  isDev: env.data.NODE_ENV === "development",
  livekit: {
    url: env.data.LIVEKIT_URL || "",
    apiKey: env.data.LIVEKIT_API_KEY || "",
    apiSecret: env.data.LIVEKIT_API_SECRET || "",
  },
  openai: {
    apiKey: env.data.OPENAI_API_KEY || "",
  },
};

export default config;
