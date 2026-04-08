import type {
  ToolDefinition,
  VisionToolArgs,
  FactEntry,
  WorkItemEntry,
  TimelineEntry,
  MemoryStats,
} from '@neura/types';
import { Logger } from '@neura/utils/logger';

const log = new Logger('tool');

const MEMORY_TOOL_NAMES = new Set([
  'remember_fact',
  'recall_memory',
  'update_preference',
  'invalidate_fact',
  'get_timeline',
  'memory_stats',
]);
const PRESENCE_TOOL_NAMES = new Set(['enter_mode']);
const TASK_TOOL_NAMES = new Set([
  'create_task',
  'list_tasks',
  'get_task',
  'update_task',
  'delete_task',
]);

/** Return tool definitions, excluding unavailable tool groups. */
export function getToolDefs(options: {
  includeMemory: boolean;
  includePresence: boolean;
  includeTasks: boolean;
}) {
  return toolDefs.filter((t) => {
    if (MEMORY_TOOL_NAMES.has(t.name) && !options.includeMemory) return false;
    if (PRESENCE_TOOL_NAMES.has(t.name) && !options.includePresence) return false;
    if (TASK_TOOL_NAMES.has(t.name) && !options.includeTasks) return false;
    return true;
  });
}

export interface MemoryToolHandler {
  storeFact(content: string, category: string, tags: string[], sessionId?: string): Promise<string>;
  recall(query: string, limit?: number): Promise<FactEntry[]>;
  storePreference(preference: string, category: string, sessionId?: string): Promise<void>;
  invalidateFact(query: string): Promise<string | null>;
  getTimeline(daysBack: number, entityFilter?: string): Promise<TimelineEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
}

export interface TaskToolHandler {
  createTask(
    title: string,
    priority: string,
    options?: { description?: string; dueAt?: string; sourceSessionId?: string }
  ): Promise<string>;
  listTasks(status?: string): Promise<WorkItemEntry[]>;
  getTask(idOrTitle: string): Promise<WorkItemEntry | null>;
  updateTask(idOrTitle: string, updates: Record<string, unknown>): Promise<boolean>;
  deleteTask(idOrTitle: string): Promise<boolean>;
}

export const toolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'describe_camera',
    description:
      "Analyze the user's camera feed. Use when the user asks you to look at something, describe what you see, or asks any visual question about their surroundings.",
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: "Optional focus area (e.g., 'the object they're holding', 'the person')",
        },
        detail: {
          type: 'string',
          description:
            "Level of detail: 'brief' for quick glance (1-2 sentences), 'detailed' for thorough explanation",
        },
      },
    },
  },
  {
    type: 'function',
    name: 'describe_screen',
    description:
      "Analyze the user's shared screen. Use when the user asks about what's on their screen, asks you to read text, review code, or look at their display.",
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: "Optional focus area (e.g., 'the code', 'the error message', 'the chart')",
        },
        detail: {
          type: 'string',
          description:
            "Level of detail: 'brief' for quick glance (1-2 sentences), 'detailed' for thorough explanation",
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_current_time',
    description: 'Returns the current date and time in the server timezone',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'remember_fact',
    description:
      'Store an important fact for long-term memory. Use when the user tells you something you should remember, or when you learn something important.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember' },
        category: {
          type: 'string',
          description: "Category: 'project', 'technical', 'business', 'personal', or 'general'",
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags for categorization',
        },
      },
      required: ['content'],
    },
  },
  {
    type: 'function',
    name: 'recall_memory',
    description:
      'Search long-term memory for relevant facts. Use when the user asks "do you remember...", references a previous session, or when you need stored context.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'update_preference',
    description:
      'Record a user preference about your behavior. Use when the user gives feedback like "be more concise", "always explain your reasoning", etc.',
    parameters: {
      type: 'object',
      properties: {
        preference: {
          type: 'string',
          description: 'The behavioral preference',
        },
        category: {
          type: 'string',
          description:
            "Category: 'response_style', 'workflow', 'communication', 'technical', or 'general'",
        },
      },
      required: ['preference'],
    },
  },
  {
    type: 'function',
    name: 'invalidate_fact',
    description:
      'Mark a stored fact as no longer true. Use when the user says something is no longer accurate, like "I left that company" or "we changed the architecture".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Description of the fact to invalidate — will search and invalidate the best match',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_timeline',
    description:
      'Get a chronological timeline of memory changes. Use when the user asks "what changed recently?" or "what happened this week?".',
    parameters: {
      type: 'object',
      properties: {
        days_back: {
          type: 'string',
          description: 'Number of days to look back (default: 7)',
        },
        entity: {
          type: 'string',
          description: 'Optional: filter by entity name (e.g. a person or project)',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'memory_stats',
    description:
      'Get statistics about stored memories — total facts, categories, entities, and more. Use when the user asks about their memory state.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'enter_mode',
    description:
      "Transition the presence mode. Call with 'passive' when the conversation has naturally ended, when the user says goodbye/thanks, or when you detect the user is no longer speaking to you. Call with 'active' only if needed to re-engage.",
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['passive', 'active'],
          description: "'passive' to stop listening actively, 'active' to re-engage",
        },
      },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'create_task',
    description:
      'Create a task or reminder. Use when the user asks you to remember to do something, set a reminder, or track a to-do item.',
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
        description: { type: 'string', description: 'Optional longer description' },
      },
      required: ['title'],
    },
  },
  {
    type: 'function',
    name: 'list_tasks',
    description:
      "List the user's tasks. Use when the user asks what's on their plate, what tasks they have, or wants to see their to-do list.",
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'cancelled', 'failed', 'all'],
          description: "Filter by status (default: open tasks only — 'pending' and 'in_progress')",
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_task',
    description: 'Get details about a specific task by title or ID.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Task title (partial match) or ID',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'update_task',
    description:
      'Update an existing task. Use to change status (e.g., mark as done), priority, due date, or description. Find the task by title or ID.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task title (partial match) or ID to update' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'cancelled', 'failed'],
          description: 'New status',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'New priority',
        },
        due_at: { type: 'string', description: 'New due date/time in ISO 8601 format' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'delete_task',
    description: 'Delete a task permanently. Find the task by title or ID.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task title (partial match) or ID to delete' },
      },
      required: ['query'],
    },
  },
];

/** Callback for presence mode changes triggered by AI tool calls */
export type EnterModeHandler = (mode: 'passive' | 'active') => void;

/** Context object passed to handleToolCall — replaces positional params */
export interface ToolCallContext {
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
  memoryTools?: MemoryToolHandler;
  enterMode?: EnterModeHandler;
  taskTools?: TaskToolHandler;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown>> {
  log.info(`${name}`, { args });

  switch (name) {
    case 'describe_camera': {
      const { focus, detail } = args as VisionToolArgs;
      const parts = ['Describe what you see from the camera.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detail === 'detailed') parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await ctx.queryWatcher(parts.join(' '), 'camera');
      return { result: description };
    }

    case 'describe_screen': {
      const { focus, detail } = args as VisionToolArgs;
      const parts = ['Describe what you see on the shared screen.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detail === 'detailed') parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await ctx.queryWatcher(parts.join(' '), 'screen');
      return { result: description };
    }

    case 'get_current_time': {
      const now = new Date();
      return {
        result: {
          time: now.toLocaleTimeString(),
          date: now.toLocaleDateString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };
    }

    case 'remember_fact': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const content = args.content as string;
        const category = (args.category as string) || 'general';
        const tagsStr = (args.tags as string) || '';
        const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : [];
        const id = await ctx.memoryTools.storeFact(content, category, tags);
        return { result: { stored: true, id } };
      } catch (err) {
        log.error('remember_fact failed', { err: String(err) });
        return { error: `Failed to store fact: ${String(err)}` };
      }
    }

    case 'recall_memory': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const query = args.query as string;
        const facts = await ctx.memoryTools.recall(query);
        return {
          result: {
            facts: facts.map((f) => ({
              content: f.content,
              category: f.category,
              tags: f.tags,
            })),
          },
        };
      } catch (err) {
        log.error('recall_memory failed', { err: String(err) });
        return { error: `Failed to recall: ${String(err)}` };
      }
    }

    case 'update_preference': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const preference = args.preference as string;
        const category = (args.category as string) || 'general';
        await ctx.memoryTools.storePreference(preference, category);
        return { result: { stored: true } };
      } catch (err) {
        log.error('update_preference failed', { err: String(err) });
        return { error: `Failed to store preference: ${String(err)}` };
      }
    }

    case 'invalidate_fact': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const query = args.query as string;
        const factId = await ctx.memoryTools.invalidateFact(query);
        if (factId) {
          return { result: { invalidated: true, factId } };
        }
        return { result: { invalidated: false, message: 'No matching fact found' } };
      } catch (err) {
        log.error('invalidate_fact failed', { err: String(err) });
        return { error: `Failed to invalidate fact: ${String(err)}` };
      }
    }

    case 'get_timeline': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const daysBack = parseInt((args.days_back as string) || '7', 10);
        const entity = args.entity as string | undefined;
        const entries = await ctx.memoryTools.getTimeline(daysBack, entity);
        return {
          result: {
            entries: entries.map((e) => ({
              type: e.type,
              timestamp: e.timestamp,
              content: e.content,
              entity: e.entityName,
            })),
            count: entries.length,
          },
        };
      } catch (err) {
        log.error('get_timeline failed', { err: String(err) });
        return { error: `Failed to get timeline: ${String(err)}` };
      }
    }

    case 'memory_stats': {
      if (!ctx.memoryTools) return { error: 'Memory system not available' };
      try {
        const stats = await ctx.memoryTools.getMemoryStats();
        return { result: stats };
      } catch (err) {
        log.error('memory_stats failed', { err: String(err) });
        return { error: `Failed to get memory stats: ${String(err)}` };
      }
    }

    case 'enter_mode': {
      if (!ctx.enterMode) return { error: 'Presence system not available' };
      try {
        const mode = args.mode as string;
        if (mode !== 'passive' && mode !== 'active') {
          return { error: `Invalid mode: ${mode}. Use 'passive' or 'active'.` };
        }
        // Defer to macrotask queue so the tool result is sent back to the voice
        // provider before the session is torn down.
        setTimeout(() => ctx.enterMode!(mode), 0);
        return { result: { mode, transitioned: true } };
      } catch (err) {
        log.error('enter_mode failed', { err: String(err) });
        return { error: `Failed to change mode: ${String(err)}` };
      }
    }

    // ── Task tools ──

    case 'create_task': {
      if (!ctx.taskTools) return { error: 'Task system not available' };
      try {
        const title = args.title as string;
        const priority = (args.priority as string) || 'medium';
        const id = await ctx.taskTools.createTask(title, priority, {
          description: args.description as string | undefined,
          dueAt: args.due_at as string | undefined,
        });
        return { result: { created: true, id, title } };
      } catch (err) {
        log.error('create_task failed', { err: String(err) });
        return { error: `Failed to create task: ${String(err)}` };
      }
    }

    case 'list_tasks': {
      if (!ctx.taskTools) return { error: 'Task system not available' };
      try {
        const status = args.status as string | undefined;
        const tasks = await ctx.taskTools.listTasks(status);
        return {
          result: {
            count: tasks.length,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              dueAt: t.dueAt,
            })),
          },
        };
      } catch (err) {
        log.error('list_tasks failed', { err: String(err) });
        return { error: `Failed to list tasks: ${String(err)}` };
      }
    }

    case 'get_task': {
      if (!ctx.taskTools) return { error: 'Task system not available' };
      try {
        const query = args.query as string;
        const task = await ctx.taskTools.getTask(query);
        if (!task) return { result: { found: false } };
        return { result: { found: true, task } };
      } catch (err) {
        log.error('get_task failed', { err: String(err) });
        return { error: `Failed to get task: ${String(err)}` };
      }
    }

    case 'update_task': {
      if (!ctx.taskTools) return { error: 'Task system not available' };
      try {
        const query = args.query as string;
        const updates: Record<string, unknown> = {};
        if (args.status !== undefined) updates.status = args.status;
        if (args.priority !== undefined) updates.priority = args.priority;
        if (args.due_at !== undefined) updates.dueAt = args.due_at;
        if (args.description !== undefined) updates.description = args.description;
        const updated = await ctx.taskTools.updateTask(query, updates);
        if (!updated) return { result: { found: false } };
        return { result: { updated: true } };
      } catch (err) {
        log.error('update_task failed', { err: String(err) });
        return { error: `Failed to update task: ${String(err)}` };
      }
    }

    case 'delete_task': {
      if (!ctx.taskTools) return { error: 'Task system not available' };
      try {
        const query = args.query as string;
        const deleted = await ctx.taskTools.deleteTask(query);
        if (!deleted) return { result: { found: false } };
        return { result: { deleted: true } };
      } catch (err) {
        log.error('delete_task failed', { err: String(err) });
        return { error: `Failed to delete task: ${String(err)}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
