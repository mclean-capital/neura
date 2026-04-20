/**
 * Redaction helpers for voice-facing tool results.
 *
 * The voice orchestrator reads tool results aloud. Any UUID that appears
 * in a structured result comes out as "e three zero three f f b two…"
 * letter by letter, which is both useless and grating. We strip or
 * collapse ID-shaped fields before handing results to the orchestrator.
 *
 * Workers and internal code paths still see the full shapes (via the
 * store queries and the raw DB). Only the voice-tool boundary redacts.
 */

import type { TaskCommentEntry, WorkItemEntry } from '@neura/types';

/**
 * Redact a task row for voice-facing surfaces. Removes `workerId` so
 * the TTS doesn't vocalize it. `id` is preserved because the model
 * genuinely needs it to chain tool calls (dispatch_worker, etc.) —
 * tool descriptions tell the model not to read it aloud.
 */
export function redactTaskForVoice(task: WorkItemEntry): Omit<WorkItemEntry, 'workerId'> & {
  hasActiveWorker: boolean;
} {
  const { workerId, ...rest } = task;
  return { ...rest, hasActiveWorker: workerId !== null };
}

/**
 * Redact a comment row for voice-facing surfaces. Collapses
 * `worker:<uuid>` authors to the stable alias `"worker"` so the model
 * can distinguish "worker said X" vs "user said Y" without reading the
 * UUID. `system`, `orchestrator`, `user` authors pass through.
 */
export function redactCommentForVoice(comment: TaskCommentEntry): TaskCommentEntry {
  if (comment.author.startsWith('worker:')) {
    return { ...comment, author: 'worker' };
  }
  return comment;
}
