import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { logger } from "../lib/logger.js";

const MAX_OUTPUT = 50_000;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;

export function createMcpServer() {
  const server = new McpServer({
    name: "neura",
    version: "1.0.0",
  });

  server.tool(
    "shell_execute",
    "Execute a shell command. Use for psql queries, file operations, and system commands.",
    { command: z.string().describe("The shell command to execute") },
    async ({ command }) => {
      logger.debug({ command }, "MCP: executing shell command");

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>((resolve) => {
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
            resolve({
              stdout: out,
              stderr: err,
              exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            });
          },
        );
      });

      const text = [
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
        `exit code: ${result.exitCode}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        isError: result.exitCode !== 0,
      };
    },
  );

  return server;
}
