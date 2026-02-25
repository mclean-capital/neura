import { env } from "../env.js";

export function getAgentCard() {
  const baseUrl = `http://localhost:${env.PORT}`;

  return {
    name: "Neura",
    description: "A database-driven, self-configuring Personal AI Assistant",
    url: `${baseUrl}/a2a`,
    version: "1.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    skills: [
      {
        id: "general-chat",
        name: "General Chat",
        description:
          "General-purpose conversation with database-backed memory and self-configuration",
      },
      {
        id: "database-query",
        name: "Database Query",
        description: "Query and update the agent's PostgreSQL database",
      },
    ],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}
