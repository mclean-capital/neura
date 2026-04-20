/**
 * Orchestrator-only tool: `read_log`.
 *
 * Reads a bounded tail from one of two Neura log sources:
 *
 *   - `core.log` — the core process's pino stream (platform events,
 *     auth errors, dispatch failures).
 *   - `agent/sessions/<sessionId>.jsonl` — pi's per-worker transcript
 *     (everything the worker said and did).
 *
 * Paths are sandboxed to `<neuraHome>/logs/` and `<neuraHome>/agent/sessions/`.
 * UUIDs are redacted from the returned entries so the voice model
 * doesn't read them aloud letter-by-letter.
 *
 * See the orchestrator SKILL.md ("Neura file map") for when to prefer
 * which source.
 */

import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:log');

export const logToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'read_log',
    description:
      "Call get_task FIRST — it returns the task's error/result comments and a sessionFile handle. Only call read_log when those comments don't explain the failure. Pick source='session' with the session_file from get_task to see what the worker actually did (tool calls, results, messages). Pick source='core' to see platform-level errors (auth failures, dispatch errors, pi exceptions). Entries return with UUIDs already redacted — paraphrase messages for the user; never read namespaces or raw JSON aloud.",
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['core', 'session'],
          description:
            "Symbolic source. 'core' reads ~/.neura/logs/core.log. 'session' reads a worker's per-session JSONL — requires session_file from get_task.",
        },
        session_file: {
          type: 'string',
          description:
            "Relative path like 'agent/sessions/<sessionId>.jsonl', obtained from get_task's sessionFile field. Required when source='session'.",
        },
        path: {
          type: 'string',
          description:
            'Advanced: relative path under ~/.neura/. Must resolve to a file under logs/ or agent/sessions/ — anything else is rejected for safety. Prefer source+session_file for normal use.',
        },
        worker_id: {
          type: 'string',
          description: 'Optional filter — keep only entries that mention this worker id.',
        },
        task_id: {
          type: 'string',
          description: 'Optional filter — keep only entries that mention this task id.',
        },
        lines: {
          type: 'number',
          description: 'Max entries to return. Default 30, max 100.',
        },
        include_info: {
          type: 'boolean',
          description:
            'Include info-level entries (progress, turn transitions). Default false — only warn/error/fatal. Text entries (pino-pretty output) always pass through regardless.',
        },
      },
      required: [],
    },
  },
];

const LOG_TOOL_NAMES = new Set(logToolDefs.map((d) => d.name));

export function isLogTool(name: string): boolean {
  return LOG_TOOL_NAMES.has(name);
}

export async function handleLogTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!LOG_TOOL_NAMES.has(name)) return null;
  if (!ctx.workerLogs) {
    return {
      error:
        'Log inspection is not available in this session. Use get_task for task-level error comments.',
    };
  }

  try {
    if (name === 'read_log') {
      const source = args.source as 'core' | 'session' | undefined;
      const sessionFile = args.session_file as string | undefined;
      const path = args.path as string | undefined;
      if (!source && !path) {
        return { error: 'read_log requires source or path' };
      }
      if (source === 'session' && !sessionFile) {
        return { error: "read_log with source='session' requires session_file" };
      }

      const workerId = args.worker_id as string | undefined;
      const taskId = args.task_id as string | undefined;
      const lines = args.lines as number | undefined;
      const includeInfo = args.include_info as boolean | undefined;

      const result = await ctx.workerLogs.read({
        ...(source ? { source } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(path ? { path } : {}),
        ...(workerId ? { workerId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(lines !== undefined ? { lines } : {}),
        ...(includeInfo !== undefined ? { includeInfo } : {}),
      });
      return { result };
    }
    return null;
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}
