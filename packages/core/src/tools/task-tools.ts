import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:task');

export const taskToolDefs: ToolDefinition[] = [
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

export async function handleTaskTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!TASK_NAMES.has(name)) return null;
  if (!ctx.taskTools) return { error: 'Task system not available' };

  try {
    switch (name) {
      case 'create_task': {
        const title = args.title as string;
        const priority = (args.priority as string) || 'medium';
        const id = await ctx.taskTools.createTask(title, priority, {
          description: args.description as string | undefined,
          dueAt: args.due_at as string | undefined,
        });
        return { result: { created: true, id, title } };
      }

      case 'list_tasks': {
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
      }

      case 'get_task': {
        const query = args.query as string;
        const task = await ctx.taskTools.getTask(query);
        if (!task) return { result: { found: false } };
        return { result: { found: true, task } };
      }

      case 'update_task': {
        const query = args.query as string;
        const updates: Record<string, unknown> = {};
        if (args.status !== undefined) updates.status = args.status;
        if (args.priority !== undefined) updates.priority = args.priority;
        if (args.due_at !== undefined) updates.dueAt = args.due_at;
        if (args.description !== undefined) updates.description = args.description;
        const updated = await ctx.taskTools.updateTask(query, updates);
        if (!updated) return { result: { found: false } };
        return { result: { updated: true } };
      }

      case 'delete_task': {
        const query = args.query as string;
        const deleted = await ctx.taskTools.deleteTask(query);
        if (!deleted) return { result: { found: false } };
        return { result: { deleted: true } };
      }

      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}

const TASK_NAMES = new Set(['create_task', 'list_tasks', 'get_task', 'update_task', 'delete_task']);
