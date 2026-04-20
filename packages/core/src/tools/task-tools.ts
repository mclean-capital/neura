/**
 * Phase 6b task + orchestration tools.
 *
 * Task CRUD (`create_task`, `list_tasks`, `get_task`, `update_task`,
 * `delete_task`) plus two new orchestration tools introduced by Phase 6b:
 *
 *   - `dispatch_worker(task_id)` — kicks off a worker against an existing
 *     task row. Replaces `run_skill` from Phase 6.
 *   - `get_system_state()` — single snapshot the orchestrator queries
 *     opportunistically to find out what needs attention.
 *
 * `update_task` is now the unified entry point for everything editable:
 * field changes, status transitions, and comment appends. Workers and the
 * orchestrator share the tool; the handler uses `ctx.actor` to scope which
 * actor may do what (see docs/phase6b-task-driven-execution.md §Concurrency).
 */

import type {
  TaskCommentType,
  TaskCommentUrgency,
  TaskContext,
  ToolDefinition,
  WorkItemPriority,
  WorkItemStatus,
} from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext, UpdateTaskPayload } from './types.js';
import { redactCommentForVoice, redactTaskForVoice } from './voice-redact.js';

const log = new Logger('tool:task');

const ALL_STATUSES: WorkItemStatus[] = [
  'pending',
  'awaiting_dispatch',
  'in_progress',
  'awaiting_clarification',
  'awaiting_approval',
  'paused',
  'done',
  'cancelled',
  'failed',
];

// 'heartbeat' is deliberately omitted — workers don't emit heartbeats
// anymore (pi's event stream drives lease refresh in pi-runtime). If
// a model tries to post one through update_task, the invariant layer's
// author allow-list rejects it too. The type still exists in
// TaskCommentType for read-back compatibility with legacy rows.
const COMMENT_TYPES: TaskCommentType[] = [
  'progress',
  'clarification_request',
  'approval_request',
  'clarification_response',
  'approval_response',
  'error',
  'result',
  'system',
  'deferred',
];

const URGENCIES: TaskCommentUrgency[] = ['low', 'normal', 'high', 'critical'];

export const taskToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'create_task',
    description:
      'Create a new task. Use when the user asks you to do something actionable (file operations, research, code changes, reminders). Orchestrator uses create_task to brief a worker BEFORE dispatching — pair with dispatch_worker when the user confirms. Include `goal` whenever possible (what success looks like). The returned `id` is an internal handle for subsequent tool calls — NEVER speak it aloud; refer to the task by its title when talking to the user.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the task' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: "Priority level (default: 'medium')",
        },
        due_at: {
          type: 'string',
          description: 'Due date/time in ISO 8601 format (e.g., 2026-04-08T15:00:00)',
        },
        description: { type: 'string', description: 'Free-form description' },
        goal: {
          type: 'string',
          description: "User's success condition for this task (what 'done' looks like).",
        },
        context: {
          type: 'object',
          description:
            'Structured context for the worker. Freeform keys; common fields: references[], constraints[], acceptance_criteria[].',
        },
        related_skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill names (kebab-case) to load as reference documentation at dispatch.',
        },
        repo_path: {
          type: 'string',
          description: 'Absolute path to a user repo; triggers git-worktree-scoped dispatch.',
        },
        base_branch: {
          type: 'string',
          description: 'Branch for the worktree (default: HEAD).',
        },
      },
      required: ['title'],
    },
  },
  {
    type: 'function',
    name: 'list_tasks',
    description:
      "List the user's tasks. Filter by status array or needs_attention for blocked-on-user items. Default returns all non-terminal tasks.",
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_STATUSES, 'all'] },
          description: "Status filter. Pass ['all'] for every task; omit for non-terminal only.",
        },
        needs_attention: {
          type: 'boolean',
          description:
            'Shortcut for status in [awaiting_clarification, awaiting_approval] plus pending system_proactive tasks.',
        },
        source: {
          type: 'string',
          enum: ['user', 'system_proactive', 'discovery_loop'],
          description: 'Filter by task origin.',
        },
        since: {
          type: 'string',
          description: 'ISO timestamp; only return tasks updated after this.',
        },
        limit: { type: 'number', description: 'Max rows to return (default 100).' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_task',
    description:
      'Get full details about a specific task by title or ID. Includes all Phase 6b fields (goal, context, related_skills, worker_id, version).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task title (partial match) or ID' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'update_task',
    description:
      'Update a task: field changes, status transitions, and/or comment appends (unified with the worker protocol). Workers use this for report_progress / request_clarification / request_approval / complete_task / fail_task. Orchestrator uses it for user responses (clarification_response / approval_response) and field edits.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task title (partial match) or ID' },
        status: {
          type: 'string',
          enum: ALL_STATUSES,
          description: 'New status (subject to the transition matrix).',
        },
        comment: {
          type: 'object',
          description: 'Append a comment to the task timeline.',
          properties: {
            type: { type: 'string', enum: COMMENT_TYPES },
            content: { type: 'string' },
            urgency: { type: 'string', enum: URGENCIES },
            attachment_path: {
              type: 'string',
              description: 'Path to overflow content (use when body is >32KB).',
            },
            metadata: { type: 'object' },
          },
          required: ['type', 'content'],
        },
        fields: {
          type: 'object',
          description: 'Field updates.',
          properties: {
            title: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            description: { type: 'string' },
            due_at: { type: 'string' },
            goal: { type: 'string' },
            context: { type: 'object' },
            related_skills: { type: 'array', items: { type: 'string' } },
            repo_path: { type: 'string' },
            base_branch: { type: 'string' },
            worker_id: { type: 'string' },
            lease_expires_at: { type: 'string' },
          },
        },
        expect_version: {
          type: 'number',
          description:
            'Optimistic-lock guard: pass the version you read from get_task. Failure throws version_conflict.',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'delete_task',
    description: 'Delete a task permanently (cascades to its comments).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task title (partial match) or ID to delete' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'dispatch_worker',
    description:
      "Dispatch a worker to execute an existing task. The task must already have a clear goal + context — call create_task first, confirm with the user for non-trivial / destructive work, then dispatch. Progress flows via comments on the task (see get_task). When confirming to the user, speak naturally about the task ('Dispatching the worker now') — do NOT quote task IDs or worker IDs aloud, the TTS reads UUIDs letter by letter and it's jarring.",
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of an existing task to run.' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'get_system_state',
    description:
      "Single snapshot of what's happening: active workers, tasks blocked on user input, recent completions, upcoming deadlines, pending proactive items. Call opportunistically at conversation start and after long pauses. Empty arrays mean nothing needs attention.",
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

const TASK_NAMES = new Set(taskToolDefs.map((d) => d.name));

export function isTaskTool(name: string): boolean {
  return TASK_NAMES.has(name);
}

export async function handleTaskTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!TASK_NAMES.has(name)) return null;

  try {
    switch (name) {
      case 'create_task': {
        if (!ctx.taskTools) return { error: 'Task system not available' };
        const title = args.title as string;
        const priority = (args.priority as WorkItemPriority) ?? 'medium';
        const id = await ctx.taskTools.createTask(title, priority, {
          description: args.description as string | undefined,
          dueAt: args.due_at as string | undefined,
          goal: args.goal as string | undefined,
          context: args.context as TaskContext | undefined,
          relatedSkills: args.related_skills as string[] | undefined,
          repoPath: args.repo_path as string | undefined,
          baseBranch: args.base_branch as string | undefined,
        });
        return { result: { created: true, id, title } };
      }

      case 'list_tasks': {
        if (!ctx.taskTools) return { error: 'Task system not available' };
        const filter = {
          status: args.status as WorkItemStatus | WorkItemStatus[] | 'all' | undefined,
          source: args.source as 'user' | 'system_proactive' | 'discovery_loop' | undefined,
          needsAttention: args.needs_attention as boolean | undefined,
          since: args.since as string | undefined,
          limit: args.limit as number | undefined,
        };
        const tasks = await ctx.taskTools.listTasks(filter);
        return {
          result: {
            count: tasks.length,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              dueAt: t.dueAt,
              goal: t.goal,
              source: t.source,
              version: t.version,
              // workerId deliberately omitted from the voice-facing
              // listing — TTS reads UUIDs letter-by-letter. Callers
              // that need the worker id should go through
              // list_active_workers (which runs internal tool calls
              // that don't narrate).
              hasActiveWorker: t.workerId !== null,
            })),
          },
        };
      }

      case 'get_task': {
        if (!ctx.taskTools) return { error: 'Task system not available' };
        const query = args.query as string;
        const task = await ctx.taskTools.getTask(query);
        if (!task) return { result: { found: false } };
        // Include recent comments so the orchestrator can see worker
        // progress, results, and error details.
        //
        // Ordering matters: listComments naively returns the OLDEST
        // rows under LIMIT. For a long-running task with many
        // progress/heartbeat entries that would truncate the final
        // result/error — the very thing the caller asked about. So
        // we fetch most-recent-first, exclude heartbeats (high noise,
        // low information), then reverse to chronological order for
        // natural narration.
        let comments: Awaited<ReturnType<typeof ctx.taskTools.listTaskComments>> = [];
        try {
          const recentDesc = await ctx.taskTools.listTaskComments(task.id, {
            limit: 50,
            order: 'desc',
            excludeTypes: ['heartbeat'],
          });
          comments = recentDesc.reverse();
        } catch (err) {
          log.error('failed to load task comments for get_task', {
            taskId: task.id,
            err: String(err),
          });
        }
        return {
          result: {
            found: true,
            task: redactTaskForVoice(task),
            comments: comments.map(redactCommentForVoice),
          },
        };
      }

      case 'update_task': {
        if (!ctx.taskTools) return { error: 'Task system not available' };
        const query = args.query as string;
        const payload: UpdateTaskPayload = {};
        if (args.status !== undefined) payload.status = args.status as WorkItemStatus;
        if (args.expect_version !== undefined)
          payload.expectVersion = args.expect_version as number;
        if (args.comment !== undefined) {
          const c = args.comment as Record<string, unknown>;
          payload.comment = {
            type: c.type as TaskCommentType,
            content: c.content as string,
            ...(c.urgency !== undefined ? { urgency: c.urgency as TaskCommentUrgency } : {}),
            ...(c.metadata !== undefined
              ? { metadata: c.metadata as Record<string, unknown> }
              : {}),
            ...(c.attachment_path !== undefined
              ? { attachmentPath: c.attachment_path as string }
              : {}),
          };
        }
        if (args.fields !== undefined) {
          const f = args.fields as Record<string, unknown>;
          payload.fields = {
            ...(f.title !== undefined ? { title: f.title as string } : {}),
            ...(f.priority !== undefined ? { priority: f.priority as WorkItemPriority } : {}),
            ...(f.description !== undefined ? { description: f.description as string | null } : {}),
            ...(f.due_at !== undefined ? { dueAt: f.due_at as string | null } : {}),
            ...(f.goal !== undefined ? { goal: f.goal as string | null } : {}),
            ...(f.context !== undefined ? { context: f.context as TaskContext | null } : {}),
            ...(f.related_skills !== undefined
              ? { relatedSkills: f.related_skills as string[] }
              : {}),
            ...(f.repo_path !== undefined ? { repoPath: f.repo_path as string | null } : {}),
            ...(f.base_branch !== undefined ? { baseBranch: f.base_branch as string | null } : {}),
            ...(f.worker_id !== undefined ? { workerId: f.worker_id as string | null } : {}),
            ...(f.lease_expires_at !== undefined
              ? { leaseExpiresAt: f.lease_expires_at as string | null }
              : {}),
          };
        }
        const updated = await ctx.taskTools.updateTask(query, payload);
        if (!updated) return { result: { found: false } };
        return {
          result: {
            updated: true,
            version: updated.version,
            status: updated.task.status,
            comment: updated.comment,
          },
        };
      }

      case 'delete_task': {
        if (!ctx.taskTools) return { error: 'Task system not available' };
        const query = args.query as string;
        const deleted = await ctx.taskTools.deleteTask(query);
        if (!deleted) return { result: { found: false } };
        return { result: { deleted: true } };
      }

      case 'dispatch_worker': {
        if (!ctx.workerDispatch) return { error: 'Worker dispatch not available' };
        const taskId = args.task_id as string;
        const outcome = await ctx.workerDispatch.dispatchWorker(taskId);
        if ('error' in outcome) return { error: outcome.error };
        // workerId is deliberately NOT returned. The voice model reads
        // tool results aloud verbatim, and a UUID comes out as
        // "e three zero three f f b two…" letter by letter. Worker
        // control tools (pause/resume/cancel) default to "most recent,"
        // so the voice flow never needs a workerId. Worker lookups that
        // genuinely need an id go through list_active_workers.
        return {
          result: {
            dispatched: true,
            message: `Worker dispatched. You'll hear progress updates as it works.`,
          },
        };
      }

      case 'get_system_state': {
        if (!ctx.systemState) return { error: 'System state not available' };
        const snapshot = await ctx.systemState.getSystemState();
        return { result: snapshot };
      }

      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}
