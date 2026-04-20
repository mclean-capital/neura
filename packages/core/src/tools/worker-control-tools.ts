/**
 * Phase 6 — Worker control tools (pause / resume / cancel).
 *
 * Tools Grok can call to manage background workers during a voice
 * session. The user's spoken intents ("pause", "hold on", "keep going",
 * "cancel that", etc.) are mapped to tool calls by Grok itself — not
 * by a programmatic keyword classifier — because the model reads
 * these tool descriptions plus the orchestrator skill's system-prompt
 * directives and figures out which one to call.
 *
 * Same pattern as `enter_mode` in `presence-tools.ts`: a pushy
 * description tells the model exactly when to call the tool, and the
 * handler does the actual work. See the `orchestrator-worker-control`
 * SKILL.md for the broader instructions that get injected into the
 * voice session system prompt.
 */

import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:worker-control');

export const workerControlToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'pause_worker',
    description:
      "Pause a running background worker so it stops after its current tool call finishes. The worker's conversation history is preserved and can be resumed later via `resume_worker`. Call this when the user signals they want to interrupt a running task temporarily — phrases like 'pause', 'hold on', 'hold on a second', 'wait', 'wait a sec', 'stop for a moment', 'stand by', 'one second'. Do NOT call this for ordinary conversation pauses or when the user is just thinking. If no worker is currently running, tell the user there's nothing to pause instead of calling this tool. The optional worker_id parameter targets a specific worker by id — omit it to pause the most recently dispatched active worker, which is usually what the user means.",
    parameters: {
      type: 'object',
      properties: {
        worker_id: {
          type: 'string',
          description: 'Optional specific worker id. Omit to target the most recent active worker.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'resume_worker',
    description:
      "Resume a previously paused worker so it continues where it left off. Call this when the user signals they want to pick the task back up — phrases like 'resume', 'continue', 'go ahead', 'keep going', 'carry on', 'I'm back', 'ok I'm back', 'where were we', 'back to it'. The worker's conversation history was preserved on pause so it remembers what it was doing. The optional worker_id parameter targets a specific paused worker — omit to resume the most recent paused worker, which is almost always what the user means. If no worker is currently paused, tell the user there's nothing to resume instead of calling this tool.",
    parameters: {
      type: 'object',
      properties: {
        worker_id: {
          type: 'string',
          description:
            'Optional specific worker id. Omit to target the most recent paused (idle_partial) worker.',
        },
        message: {
          type: 'string',
          description:
            "Optional extra context to include with the resume prompt (e.g. 'I'm back — the file you needed is /src/auth.ts'). Omit for a plain resume.",
        },
      },
    },
  },
  {
    type: 'function',
    name: 'cancel_worker',
    description:
      "Cancel a running or paused worker permanently. The worker's in-flight tool calls are aborted and its state is discarded — it cannot be resumed after cancel. Call this when the user signals they want to abort a task for good — phrases like 'cancel', 'cancel that', 'abort', 'never mind', 'forget it', 'stop for good', 'kill it', 'kill the worker'. This is DIFFERENT from `pause_worker`: pause is reversible, cancel is terminal. If the user's intent is ambiguous (e.g. they just said 'stop' with no further context), ask them to clarify whether they want to pause or cancel. The optional worker_id parameter targets a specific worker — omit to cancel the most recent active or paused worker.",
    parameters: {
      type: 'object',
      properties: {
        worker_id: {
          type: 'string',
          description: 'Optional specific worker id. Omit to target the most recent active worker.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'list_active_workers',
    description:
      "List every non-terminal background worker along with its id, status, skill name, and start time. Call this when the user asks what's running, when they ask about pausing/cancelling and you're not sure which worker they mean, or before calling pause/resume/cancel with no worker_id so you can confirm the target with the user.",
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

const WORKER_CONTROL_NAMES = new Set(workerControlToolDefs.map((d) => d.name));

export function isWorkerControlTool(name: string): boolean {
  return WORKER_CONTROL_NAMES.has(name);
}

export async function handleWorkerControlTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!WORKER_CONTROL_NAMES.has(name)) return null;
  if (!ctx.workerControl) return { error: 'Worker control not available' };

  // Voice-facing results strip workerId so the TTS doesn't narrate
  // UUIDs letter-by-letter. Internal operations already have the id
  // (the control handlers resolve "most recent" when worker_id is
  // omitted, which is the typical voice path).
  try {
    switch (name) {
      case 'pause_worker': {
        const workerId = args.worker_id as string | undefined;
        const result = await ctx.workerControl.pauseWorker(workerId);
        return {
          result: { paused: result.paused, ...(result.reason ? { reason: result.reason } : {}) },
        };
      }
      case 'resume_worker': {
        const workerId = args.worker_id as string | undefined;
        const message = args.message as string | undefined;
        const result = await ctx.workerControl.resumeWorker(workerId, message);
        return {
          result: { resumed: result.resumed, ...(result.reason ? { reason: result.reason } : {}) },
        };
      }
      case 'cancel_worker': {
        const workerId = args.worker_id as string | undefined;
        const result = await ctx.workerControl.cancelWorker(workerId);
        return {
          result: {
            cancelled: result.cancelled,
            ...(result.reason ? { reason: result.reason } : {}),
          },
        };
      }
      case 'list_active_workers': {
        const workers = await ctx.workerControl.listActive();
        return {
          result: {
            count: workers.length,
            workers: workers.map((w) => ({
              status: w.status,
              skillName: w.skillName,
              startedAt: w.startedAt,
            })),
          },
        };
      }
      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}
