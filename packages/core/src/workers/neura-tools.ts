/**
 * Phase 6 — Neura tool adapters for pi-coding-agent
 *
 * Adapts Neura's existing tools (time, memory, task, presence) into
 * pi-coding-agent's `AgentTool<TSchema>` shape so they can be registered on
 * a pi `AgentSession` via `createAgentSession({ customTools })`. Each adapter
 * is a thin wrapper around the existing Neura tool handler from
 * `packages/core/src/tools/`.
 *
 * **Workers do not get vision tools.** `describe_screen` /
 * `describe_camera` are intentionally excluded from the worker tool
 * set. Vision is an orchestrator concern — the user is looking at
 * their screen while talking to grok, and grok is the one that sees
 * the screen via its own voice-session `describe_screen` tool call.
 * When a worker needs visual context, grok captures the relevant
 * information and passes it into the worker's task description as
 * text. This keeps workers stateless with respect to the user's
 * physical environment and avoids threading a per-client watcher
 * delegate through the worker runtime.
 *
 * Key differences between Neura's native tool shape and pi's:
 *
 * 1. Parameter schemas: Neura uses plain JSON-schema-style objects;
 *    pi uses TypeBox schemas (runtime-validated + statically typed).
 *
 * 2. Result encoding: Neura's handlers return `{ result: ... }` or
 *    `{ error: ... }`; pi expects `{ content: [{type:'text',text:...}],
 *    details: ... }`. Errors are encoded by throwing (pi catches and
 *    emits `tool_execution_end` with `isError: true`) — this is pi's
 *    documented contract in `AgentTool.execute`.
 *
 * 3. Execution context: Neura's handlers take a `ToolCallContext` (memory
 *    handler, task handler, etc.) as an explicit parameter. Pi's
 *    `execute` signature is `(toolCallId, params, signal, onUpdate)` with
 *    no context argument. We close over the context in `buildNeuraTools()`
 *    and pass it to the Neura handlers internally.
 *
 * 4. Tool discovery: pi registers ALL tools up front on the session.
 *    Phase 6b removed per-skill filtering via `beforeToolCall` — workers
 *    now have full tool access, scoped by filesystem isolation (git
 *    worktrees) and prompt-level reversibility discipline. So
 *    `buildNeuraTools()` simply returns every tool.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Logger } from '@neura/utils/logger';
import { handleTimeTool } from '../tools/time-tools.js';
import { handleMemoryTool } from '../tools/memory-tools.js';
import { handleTaskTool } from '../tools/task-tools.js';
import { handlePresenceTool } from '../tools/presence-tools.js';
import type { ToolCallContext } from '../tools/types.js';

const log = new Logger('neura-tools');

/**
 * A pi AgentTool wired to a Neura handler. Exported as the workers-side
 * type for anything that needs to pass these around.
 */
export type NeuraAgentTool = AgentTool<TSchema, unknown>;

// ────────────────────────────────────────────────────────────────────
// TypeBox parameter schemas
// ────────────────────────────────────────────────────────────────────

const EmptyParams = Type.Object({});

const RememberFactParams = Type.Object({
  content: Type.String({ description: 'The fact to remember' }),
  category: Type.Optional(
    Type.String({
      description: "Category: 'project', 'technical', 'business', 'personal', or 'general'",
    })
  ),
  tags: Type.Optional(Type.String({ description: 'Comma-separated tags' })),
});

const RecallMemoryParams = Type.Object({
  query: Type.String({ description: 'What to search for in memory' }),
});

const UpdatePreferenceParams = Type.Object({
  preference: Type.String({ description: 'The behavioral preference to record' }),
  category: Type.Optional(
    Type.String({
      description:
        "Category: 'response_style', 'workflow', 'communication', 'technical', 'general'",
    })
  ),
});

const InvalidateFactParams = Type.Object({
  query: Type.String({
    description: 'Description of the fact to invalidate — will match the best stored fact',
  }),
});

const GetTimelineParams = Type.Object({
  days_back: Type.Optional(
    Type.String({ description: 'Number of days to look back (default: 7)' })
  ),
  entity: Type.Optional(Type.String({ description: 'Optional entity filter' })),
});

const CreateTaskParams = Type.Object({
  title: Type.String({ description: 'Short title for the task' }),
  priority: Type.Optional(
    Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
      description: "Priority level (default: 'medium')",
    })
  ),
  due_at: Type.Optional(
    Type.String({
      description: 'Due date/time in ISO 8601 format (e.g. 2026-04-08T15:00:00)',
    })
  ),
  description: Type.Optional(Type.String({ description: 'Optional longer description' })),
});

const ListTasksParams = Type.Object({
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal('pending'),
        Type.Literal('in_progress'),
        Type.Literal('done'),
        Type.Literal('cancelled'),
        Type.Literal('failed'),
        Type.Literal('all'),
      ],
      { description: 'Filter by status (default: open tasks only)' }
    )
  ),
});

const TaskQueryParams = Type.Object({
  query: Type.String({ description: 'Task title (partial match) or ID' }),
});

const UpdateTaskParams = Type.Object({
  query: Type.String({ description: 'Task title (partial match) or ID to update' }),
  status: Type.Optional(
    Type.Union([
      Type.Literal('pending'),
      Type.Literal('in_progress'),
      Type.Literal('done'),
      Type.Literal('cancelled'),
      Type.Literal('failed'),
    ])
  ),
  priority: Type.Optional(
    Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])
  ),
  due_at: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

const EnterModeParams = Type.Object({
  mode: Type.Union([Type.Literal('passive'), Type.Literal('active')], {
    description: "'passive' to release the session, 'active' to re-engage",
  }),
});

// ────────────────────────────────────────────────────────────────────
// Result conversion
// ────────────────────────────────────────────────────────────────────

/**
 * Convert a Neura handler return value into pi's `AgentToolResult`. Errors
 * are thrown (pi's contract) — `content` + `details` is only for successful
 * calls. Unifying this across all adapters keeps the tool wrappers trivial.
 */
function toAgentResult(handlerResult: Record<string, unknown> | null): AgentToolResult<unknown> {
  if (handlerResult == null) {
    throw new Error('Neura tool handler returned null');
  }
  if ('error' in handlerResult && handlerResult.error != null) {
    const raw = handlerResult.error;
    const message = typeof raw === 'string' ? raw : JSON.stringify(raw);
    throw new Error(message);
  }
  const details = 'result' in handlerResult ? handlerResult.result : handlerResult;
  // Text content is what the model consumes as the tool result. JSON
  // stringification is the uniform default; individual tools can override
  // if a prettier format would serve the model better (e.g. timeline
  // rendering as a bulleted list). For Phase 1 we keep it simple.
  const text = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

/**
 * Shared execute factory. Wraps a Neura handler, converts the result to
 * pi's shape, and logs errors for observability. The handler may be sync
 * or async — we handle both.
 */
function wrapHandler(
  toolName: string,
  handler: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
  ctx: ToolCallContext
): NeuraAgentTool['execute'] {
  return async (_toolCallId, params) => {
    try {
      const rawResult = await handler(toolName, params as Record<string, unknown>, ctx);
      return toAgentResult(rawResult);
    } catch (err) {
      log.error('tool adapter threw', { tool: toolName, err: String(err) });
      throw err;
    }
  };
}

// ────────────────────────────────────────────────────────────────────
// Tool factory
// ────────────────────────────────────────────────────────────────────

/**
 * Build the full array of pi `AgentTool` objects wired to Neura handlers.
 * Pi-runtime registers these on every `createAgentSession` via the
 * `customTools` option. Phase 6b removed per-skill permission enforcement;
 * workers get full access to this tool set.
 *
 * @param ctx Neura's tool call context (watcher, memory, task, presence
 *            handlers). Captured in each adapter's execute closure.
 */
export function buildNeuraTools(ctx: ToolCallContext): NeuraAgentTool[] {
  const tools: NeuraAgentTool[] = [];

  // ── Time ────────────────────────────────────────────────────────
  tools.push(
    makeTool({
      name: 'get_current_time',
      label: 'Current Time',
      description: 'Returns the current date and time in the server timezone.',
      parameters: EmptyParams,
      // handleTimeTool is synchronous, but pi's execute contract returns a
      // Promise — wrap the sync result.
      execute: (_toolCallId) => Promise.resolve(toAgentResult(handleTimeTool('get_current_time'))),
    })
  );

  // ── Memory ──────────────────────────────────────────────────────
  tools.push(
    makeTool({
      name: 'remember_fact',
      label: 'Remember Fact',
      description:
        'Store an important fact for long-term memory. Use when the user tells you something you should remember, or when you learn something important.',
      parameters: RememberFactParams,
      execute: wrapHandler('remember_fact', handleMemoryTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'recall_memory',
      label: 'Recall Memory',
      description:
        'Search long-term memory for relevant facts. Use when the user asks "do you remember...", references a previous session, or when you need stored context.',
      parameters: RecallMemoryParams,
      execute: wrapHandler('recall_memory', handleMemoryTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'update_preference',
      label: 'Update Preference',
      description:
        'Record a user preference about your behavior. Use when the user gives feedback like "be more concise" or "always explain your reasoning".',
      parameters: UpdatePreferenceParams,
      execute: wrapHandler('update_preference', handleMemoryTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'invalidate_fact',
      label: 'Invalidate Fact',
      description:
        'Mark a stored fact as no longer true. Use when the user says something is no longer accurate, like "I left that company" or "we changed the architecture".',
      parameters: InvalidateFactParams,
      execute: wrapHandler('invalidate_fact', handleMemoryTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'get_timeline',
      label: 'Get Timeline',
      description:
        'Get a chronological timeline of memory changes. Use when the user asks "what changed recently?" or "what happened this week?".',
      parameters: GetTimelineParams,
      execute: wrapHandler('get_timeline', handleMemoryTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'memory_stats',
      label: 'Memory Stats',
      description:
        'Get statistics about stored memories — total facts, categories, entities, and more. Use when the user asks about their memory state.',
      parameters: EmptyParams,
      execute: wrapHandler('memory_stats', handleMemoryTool, ctx),
    })
  );

  // ── Tasks ───────────────────────────────────────────────────────
  tools.push(
    makeTool({
      name: 'create_task',
      label: 'Create Task',
      description:
        'Create a task or reminder. Use when the user asks you to remember to do something, set a reminder, or track a to-do item.',
      parameters: CreateTaskParams,
      execute: wrapHandler('create_task', handleTaskTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'list_tasks',
      label: 'List Tasks',
      description:
        "List the user's tasks. Use when the user asks what's on their plate, what tasks they have, or wants to see their to-do list.",
      parameters: ListTasksParams,
      execute: wrapHandler('list_tasks', handleTaskTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'get_task',
      label: 'Get Task',
      description: 'Get details about a specific task by title or ID.',
      parameters: TaskQueryParams,
      execute: wrapHandler('get_task', handleTaskTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'update_task',
      label: 'Update Task',
      description:
        'Update an existing task. Use to change status (e.g. mark as done), priority, due date, or description.',
      parameters: UpdateTaskParams,
      execute: wrapHandler('update_task', handleTaskTool, ctx),
    })
  );

  tools.push(
    makeTool({
      name: 'delete_task',
      label: 'Delete Task',
      description: 'Delete a task permanently. Find the task by title or ID.',
      parameters: TaskQueryParams,
      execute: wrapHandler('delete_task', handleTaskTool, ctx),
    })
  );

  // ── Presence ────────────────────────────────────────────────────
  tools.push(
    makeTool({
      name: 'enter_mode',
      label: 'Enter Mode',
      description:
        "Transition the presence mode. Call this with 'passive' when the user explicitly ends the conversation (goodbye, thanks that's all, see you later). Call with 'active' to re-engage. Do NOT call for ordinary pauses or brief silence.",
      parameters: EnterModeParams,
      // handlePresenceTool is synchronous (callback deferred via setTimeout).
      execute: (_toolCallId, params) =>
        Promise.resolve(
          toAgentResult(handlePresenceTool('enter_mode', params as Record<string, unknown>, ctx))
        ),
    })
  );

  return tools;
}

/**
 * Small type-safe helper for building a NeuraAgentTool. Exists only to let
 * each tool's parameters infer through `Static<typeof schema>` without
 * writing the generic by hand. Pi's AgentTool type parameter is the schema,
 * so we pass it through.
 */
function makeTool<TSchemaT extends TSchema>(spec: {
  name: string;
  label: string;
  description: string;
  parameters: TSchemaT;
  execute: (
    toolCallId: string,
    params: Static<TSchemaT>,
    signal?: AbortSignal
  ) => Promise<AgentToolResult<unknown>>;
}): NeuraAgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: spec.execute as NeuraAgentTool['execute'],
  };
}

/**
 * The set of tool names exposed to pi AgentSessions. Used by tests for
 * coverage + by the validator to surface unknown tool names in a skill's
 * `allowed-tools` list.
 *
 * Note: vision tools (`describe_screen`, `describe_camera`) are NOT in
 * this list. Vision is owned by the orchestrator (grok), not workers.
 * See the file header for the rationale.
 */
export const NEURA_TOOL_NAMES: readonly string[] = [
  'get_current_time',
  'remember_fact',
  'recall_memory',
  'update_preference',
  'invalidate_fact',
  'get_timeline',
  'memory_stats',
  'create_task',
  'list_tasks',
  'get_task',
  'update_task',
  'delete_task',
  'enter_mode',
];
