import dotenv from "dotenv";
import path from "path";
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

  // Google Gemini API
  GEMINI_API_KEY: z.string({
    required_error: "GEMINI_API_KEY is required in the environment variables",
  }),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string({
    required_error: "GOOGLE_CLIENT_ID is required in the environment variables",
  }),
  GOOGLE_CLIENT_SECRET: z.string({
    required_error:
      "GOOGLE_CLIENT_SECRET is required in the environment variables",
  }),

  // JWT Secret for session tokens
  JWT_SECRET: z.string({
    required_error: "JWT_SECRET is required in the environment variables",
  }),

  // Access restriction
  ALLOWED_EMAIL: z.string({
    required_error: "ALLOWED_EMAIL is required in the environment variables",
  }),
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
  geminiApiKey: env.data.GEMINI_API_KEY,
  googleClientId: env.data.GOOGLE_CLIENT_ID,
  googleClientSecret: env.data.GOOGLE_CLIENT_SECRET,
  jwtSecret: env.data.JWT_SECRET,
  allowedEmail: env.data.ALLOWED_EMAIL,
  isDev: env.data.NODE_ENV === "development",
};

export default config;
