import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:memory');

export const memoryToolDefs: ToolDefinition[] = [
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
];

export async function handleMemoryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (!MEMORY_NAMES.has(name)) return null;
  if (!ctx.memoryTools) return { error: 'Memory system not available' };

  try {
    switch (name) {
      case 'remember_fact': {
        const content = args.content as string;
        const category = (args.category as string) || 'general';
        const tagsStr = (args.tags as string) || '';
        const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : [];
        const id = await ctx.memoryTools.storeFact(content, category, tags);
        return { result: { stored: true, id } };
      }

      case 'recall_memory': {
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
      }

      case 'update_preference': {
        const preference = args.preference as string;
        const category = (args.category as string) || 'general';
        await ctx.memoryTools.storePreference(preference, category);
        return { result: { stored: true } };
      }

      case 'invalidate_fact': {
        const query = args.query as string;
        const factId = await ctx.memoryTools.invalidateFact(query);
        if (factId) {
          return { result: { invalidated: true, factId } };
        }
        return { result: { invalidated: false, message: 'No matching fact found' } };
      }

      case 'get_timeline': {
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
      }

      case 'memory_stats': {
        const stats = await ctx.memoryTools.getMemoryStats();
        return { result: stats };
      }

      default:
        return null;
    }
  } catch (err) {
    log.error(`${name} failed`, { err: String(err) });
    return { error: `Failed: ${String(err)}` };
  }
}

const MEMORY_NAMES = new Set([
  'remember_fact',
  'recall_memory',
  'update_preference',
  'invalidate_fact',
  'get_timeline',
  'memory_stats',
]);
