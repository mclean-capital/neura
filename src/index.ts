import { createApp } from "./server/app.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { checkConnection } from "./db/connection.js";

async function main() {
  const dbConnected = await checkConnection();
  if (dbConnected) {
    logger.info("Database connected");
  } else {
    logger.warn("Database not available — starting in degraded mode");
  }

  const app = createApp();

  app.listen(env.PORT, () => {
    logger.info(`Neura server running on port ${env.PORT}`);
    logger.info(`Health:  http://localhost:${env.PORT}/health`);
    logger.info(`Chat:    http://localhost:${env.PORT}/chat`);
    logger.info(`A2A:     http://localhost:${env.PORT}/.well-known/agent-card.json`);
    logger.info(`MCP:     http://localhost:${env.PORT}/mcp`);
    logger.info(`OpenAI:  http://localhost:${env.PORT}/v1/chat/completions`);
  });
}

main().catch((err) => {
  logger.fatal(err, "Failed to start Neura");
  process.exit(1);
});
