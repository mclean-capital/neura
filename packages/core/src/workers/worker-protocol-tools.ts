/**
 * Phase 6b — Worker protocol tools.
 *
 * Pi AgentTool adapters for the 6-verb worker communication protocol from
 * docs/phase6b-task-driven-execution.md §Communication Protocol. Each verb
 * is a thin wrapper around `update_task` with a specific payload shape.
 * Workers get both these verbs AND the underlying `update_task` tool; the
 * verbs are preferred because they're easier for the LLM to call correctly
 * (narrower surface, explicit parameter shape per use case).
 *
 * | Verb                 | status transition       | comment type            |
 * | -------------------- | ----------------------- | ----------------------- |
 * | report_progress      | —                       | progress                |
 * | heartbeat            | —                       | heartbeat (pruned)      |
 * | request_clarification| → awaiting_clarification| clarification_request   |
 * | request_approval     | → awaiting_approval     | approval_request        |
 * | complete_task        | → done                  | result                  |
 * | fail_task            | → failed                | error                   |
 *
 * `request_clarification` and `request_approval` both synchronously block
 * the worker until the orchestrator posts a matching response comment (via
 * the ClarificationBridge). The bridge is demoted to a transport
 * optimization — the ticket (task row + task_comments) is the source of
 * truth; the bridge just fans a notification to the live voice session so
 * responses have zero artificial delay.
 *
 * Non-blocking verbs (progress, heartbeat, complete, fail) return
 * immediately after the update_task call.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Logger } from '@neura/utils/logger';
import type { TaskCommentUrgency } from '@neura/types';
import type { NeuraAgentTool } from './neura-tools.js';
import type { ClarificationBridge } from './clarification-bridge.js';
import type { TaskToolHandler } from '../tools/index.js';

const log = new Logger('worker-protocol-tools');

/** Default lease refresh window applied by every heartbeat. */
const LEASE_WINDOW_MS = 5 * 60_000;

// ────────────────────────────────────────────────────────────────────
// Parameter schemas
// ────────────────────────────────────────────────────────────────────

const ReportProgressParams = Type.Object({
  message: Type.String({ description: 'Short status update the user may hear read aloud.' }),
});

const HeartbeatParams = Type.Object({
  note: Type.Optional(
    Type.String({
      description: 'Optional short note. Heartbeats are pruned after your next real comment.',
    })
  ),
});

const RequestClarificationParams = Type.Object({
  question: Type.String({ description: 'Plain-language question to ask the user.' }),
  context: Type.Optional(
    Type.String({ description: "What you're trying to do and why you're stuck." })
  ),
  urgency: Type.Optional(
    Type.Union(
      [Type.Literal('low'), Type.Literal('normal'), Type.Literal('high'), Type.Literal('critical')],
      {
        description: "'critical' interrupts the orchestrator; default 'normal' waits in queue.",
      }
    )
  ),
});

const RequestApprovalParams = Type.Object({
  action: Type.String({
    description:
      'Plain-language summary of the destructive or hard-to-reverse action you want to take.',
  }),
  rationale: Type.Optional(
    Type.String({ description: 'Why this action is necessary and what the alternative is.' })
  ),
  urgency: Type.Optional(
    Type.Union(
      [Type.Literal('low'), Type.Literal('normal'), Type.Literal('high'), Type.Literal('critical')],
      { description: "Default 'normal'." }
    )
  ),
});

const CompleteTaskParams = Type.Object({
  summary: Type.String({
    description: 'What you did and confirmation the acceptance criteria were met.',
  }),
});

const FailTaskParams = Type.Object({
  reason: Type.String({ description: 'Human-readable description of what went wrong.' }),
  reason_code: Type.Union(
    [
      Type.Literal('impossible'),
      Type.Literal('already_done'),
      Type.Literal('user_aborted'),
      Type.Literal('hard_error'),
    ],
    {
      description:
        "Categorize the failure. 'impossible': precondition missing. 'already_done': detected no-op. 'user_aborted': user directed cessation. 'hard_error': exception/timeout.",
    }
  ),
});

// ────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────

export interface WorkerProtocolToolsOptions {
  workerId: string;
  taskId: string;
  taskTools: TaskToolHandler;
  /**
   * Optional clarification bridge. When present, `request_clarification`
   * and `request_approval` synchronously await the user's next-turn
   * transcript via the bridge, then return it as the tool result. If
   * omitted, the worker posts the comment and the tool returns
   * immediately — the worker will need to wait for `clarification_response`
   * via its own polling mechanism. Passing the bridge is the intended
   * production wiring.
   */
  clarificationBridge?: ClarificationBridge;
}

/**
 * Build the 6 worker protocol verbs as pi AgentTools. Each is bound to
 * the given worker + task via closure so the worker can't accidentally
 * post to the wrong task.
 */
export function buildWorkerProtocolTools(options: WorkerProtocolToolsOptions): NeuraAgentTool[] {
  const { workerId, taskId, taskTools, clarificationBridge } = options;

  function textResult<T>(
    text: string,
    details: T
  ): {
    content: [{ type: 'text'; text: string }];
    details: T;
  } {
    return { content: [{ type: 'text', text }], details };
  }

  const tools: NeuraAgentTool[] = [];

  // ── report_progress ─────────────────────────────────────────────
  tools.push({
    name: 'report_progress',
    label: 'Report Progress',
    description:
      'Post a brief progress update. Surfaces to the user as ambient voice when a live session is attached. Use sparingly — one update per meaningful step.',
    parameters: ReportProgressParams,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Static<typeof ReportProgressParams>;
      const result = await taskTools.updateTask(taskId, {
        comment: { type: 'progress', content: params.message },
      });
      if (!result) throw new Error(`report_progress: task ${taskId} not found`);
      return textResult('Progress posted.', {
        taskId,
        workerId,
        commentId: result.comment?.id,
      });
    },
  });

  // ── heartbeat ──────────────────────────────────────────────────
  tools.push({
    name: 'heartbeat',
    label: 'Heartbeat',
    description:
      "Signal that you're still alive on a long-running task. Refreshes the worker's lease. Emit at least every 2 minutes when you expect to run long so the orchestrator doesn't treat you as crashed.",
    parameters: HeartbeatParams,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Static<typeof HeartbeatParams>;
      const newLease = new Date(Date.now() + LEASE_WINDOW_MS).toISOString();
      const result = await taskTools.updateTask(taskId, {
        comment: { type: 'heartbeat', content: params.note ?? 'still working' },
        fields: { leaseExpiresAt: newLease },
      });
      if (!result) throw new Error(`heartbeat: task ${taskId} not found`);
      return textResult('Heartbeat recorded.', {
        taskId,
        workerId,
        leaseExpiresAt: newLease,
      });
    },
  });

  // ── request_clarification ──────────────────────────────────────
  tools.push({
    name: 'request_clarification',
    label: 'Request Clarification',
    description:
      "Ask the user a blocking question when you can't decide from context alone. The user's answer is returned as the tool result so you can continue. Prefer resolving ambiguity from context first — only escalate when you genuinely cannot proceed.",
    parameters: RequestClarificationParams,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Static<typeof RequestClarificationParams>;
      const urgency: TaskCommentUrgency = params.urgency ?? 'normal';
      const content = params.context
        ? `${params.question}\n\n(context) ${params.context}`
        : params.question;

      const result = await taskTools.updateTask(taskId, {
        status: 'awaiting_clarification',
        comment: { type: 'clarification_request', content, urgency },
      });
      if (!result) throw new Error(`request_clarification: task ${taskId} not found`);

      // Transport optimization: when a live voice session is attached,
      // the bridge speaks the question and awaits the next user turn.
      // Without a bridge, the tool would just return after posting the
      // comment — the worker would have no way to observe the answer
      // and would spin or hang. Production always wires the bridge.
      if (!clarificationBridge) {
        log.warn('request_clarification without bridge — returning immediately', {
          workerId,
          taskId,
        });
        return textResult('Question posted. No live session to await answer.', {
          taskId,
          workerId,
          commentId: result.comment?.id,
        });
      }

      const answer = await clarificationBridge.askUser({
        workerId,
        question: params.question,
        context: params.context ?? '',
        urgency: urgency === 'critical' ? 'blocking' : 'background',
        signal,
      });
      return textResult(answer, {
        taskId,
        workerId,
        question: params.question,
        answer,
        commentId: result.comment?.id,
      });
    },
  });

  // ── request_approval ───────────────────────────────────────────
  tools.push({
    name: 'request_approval',
    label: 'Request Approval',
    description:
      'MANDATORY before any destructive or hard-to-reverse action outside your worktree (rm outside cwd, force-push, overwriting user files, sending external messages, spending money). Blocks until the user answers. The answer is returned as the tool result.',
    parameters: RequestApprovalParams,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Static<typeof RequestApprovalParams>;
      const urgency: TaskCommentUrgency = params.urgency ?? 'normal';
      const content = params.rationale
        ? `${params.action}\n\nReason: ${params.rationale}`
        : params.action;

      const result = await taskTools.updateTask(taskId, {
        status: 'awaiting_approval',
        comment: { type: 'approval_request', content, urgency },
      });
      if (!result) throw new Error(`request_approval: task ${taskId} not found`);

      if (!clarificationBridge) {
        log.warn('request_approval without bridge — returning immediately', {
          workerId,
          taskId,
        });
        return textResult('Approval request posted. No live session to await answer.', {
          taskId,
          workerId,
          commentId: result.comment?.id,
        });
      }

      const answer = await clarificationBridge.askUser({
        workerId,
        question: `Approval needed: ${params.action}`,
        context: params.rationale ?? '',
        urgency: urgency === 'critical' ? 'blocking' : 'background',
        signal,
      });
      return textResult(answer, {
        taskId,
        workerId,
        action: params.action,
        answer,
        commentId: result.comment?.id,
      });
    },
  });

  // ── complete_task ──────────────────────────────────────────────
  tools.push({
    name: 'complete_task',
    label: 'Complete Task',
    description:
      'Mark the task done with a final summary. The invariant layer rejects this if any clarification_request or approval_request comment is still unresolved — handle those first or switch to fail_task.',
    parameters: CompleteTaskParams,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Static<typeof CompleteTaskParams>;
      const result = await taskTools.updateTask(taskId, {
        status: 'done',
        comment: { type: 'result', content: params.summary },
      });
      if (!result) throw new Error(`complete_task: task ${taskId} not found`);
      return textResult('Task marked done.', {
        taskId,
        workerId,
        status: result.task.status,
        commentId: result.comment?.id,
      });
    },
  });

  // ── fail_task ──────────────────────────────────────────────────
  tools.push({
    name: 'fail_task',
    label: 'Fail Task',
    description:
      "Mark the task failed when you cannot complete it. Pick the reason_code that fits: 'impossible' (precondition missing), 'already_done' (no-op detected), 'user_aborted' (user said stop), 'hard_error' (exception/timeout).",
    parameters: FailTaskParams,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Static<typeof FailTaskParams>;
      const result = await taskTools.updateTask(taskId, {
        status: 'failed',
        comment: {
          type: 'error',
          content: params.reason,
          metadata: { reason_code: params.reason_code },
        },
      });
      if (!result) throw new Error(`fail_task: task ${taskId} not found`);
      return textResult('Task marked failed.', {
        taskId,
        workerId,
        reason_code: params.reason_code,
        commentId: result.comment?.id,
      });
    },
  });

  return tools;
}

/** Tool names exposed by {@link buildWorkerProtocolTools}. */
export const WORKER_PROTOCOL_TOOL_NAMES: readonly string[] = [
  'report_progress',
  'heartbeat',
  'request_clarification',
  'request_approval',
  'complete_task',
  'fail_task',
];
