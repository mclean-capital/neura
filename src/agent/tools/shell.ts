import { tool, jsonSchema } from "ai";
import { exec } from "child_process";
import { logger } from "../../lib/logger.js";

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\{.*\|.*\}/,
  /shutdown/,
  /reboot/,
  /init\s+0/,
  /halt\b/,
];

const MAX_OUTPUT = 50_000;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

export const shellExecute = tool({
  description:
    'Execute a shell command. Use this for running psql queries against the database, file operations, and system commands. For database access use: docker exec -i postgres psql -U postgres -d neura -t -A -c "SQL_QUERY"',
  inputSchema: jsonSchema<{ command: string }>({
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  }),
  execute: async ({ command }) => {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          stdout: "",
          stderr: "Blocked: command matches a dangerous pattern",
          exitCode: 1,
        };
      }
    }

    logger.debug({ command }, "Executing shell command");

    return new Promise((resolve) => {
      exec(
        command,
        {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          let out = stdout ?? "";
          if (out.length > MAX_OUTPUT) {
            out = out.substring(0, MAX_OUTPUT) + "\n... (output truncated)";
          }

          let err = stderr ?? "";
          if (err.length > MAX_OUTPUT) {
            err = err.substring(0, MAX_OUTPUT) + "\n... (error output truncated)";
          }

          const result = {
            stdout: out,
            stderr: err,
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          };
          logger.debug({ result }, "Shell command result");
          resolve(result);
        },
      );
    });
  },
});
