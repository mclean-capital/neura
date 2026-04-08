import type { ToolDefinition, VisionToolArgs, FactEntry } from '@neura/types';
import { Logger } from '@neura/utils/logger';

const log = new Logger('tool');

const MEMORY_TOOL_NAMES = new Set(['remember_fact', 'recall_memory', 'update_preference']);
const PRESENCE_TOOL_NAMES = new Set(['enter_mode']);

/** Return tool definitions, excluding unavailable tool groups. */
export function getToolDefs(options: { includeMemory: boolean; includePresence: boolean }) {
  return toolDefs.filter((t) => {
    if (MEMORY_TOOL_NAMES.has(t.name) && !options.includeMemory) return false;
    if (PRESENCE_TOOL_NAMES.has(t.name) && !options.includePresence) return false;
    return true;
  });
}

export interface MemoryToolHandler {
  storeFact(content: string, category: string, tags: string[], sessionId?: string): Promise<string>;
  recall(query: string, limit?: number): Promise<FactEntry[]>;
  storePreference(preference: string, category: string, sessionId?: string): Promise<void>;
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
];

/** Callback for presence mode changes triggered by AI tool calls */
export type EnterModeHandler = (mode: 'passive' | 'active') => void;

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>,
  memoryTools?: MemoryToolHandler,
  enterMode?: EnterModeHandler
): Promise<Record<string, unknown>> {
  log.info(`${name}`, { args });

  switch (name) {
    case 'describe_camera': {
      const { focus, detail } = args as VisionToolArgs;
      const parts = ['Describe what you see from the camera.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detail === 'detailed') parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await queryWatcher(parts.join(' '), 'camera');
      return { result: description };
    }

    case 'describe_screen': {
      const { focus, detail } = args as VisionToolArgs;
      const parts = ['Describe what you see on the shared screen.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detail === 'detailed') parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await queryWatcher(parts.join(' '), 'screen');
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
      if (!memoryTools) return { error: 'Memory system not available' };
      try {
        const content = args.content as string;
        const category = (args.category as string) || 'general';
        const tagsStr = (args.tags as string) || '';
        const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : [];
        const id = await memoryTools.storeFact(content, category, tags);
        return { result: { stored: true, id } };
      } catch (err) {
        log.error('remember_fact failed', { err: String(err) });
        return { error: `Failed to store fact: ${String(err)}` };
      }
    }

    case 'recall_memory': {
      if (!memoryTools) return { error: 'Memory system not available' };
      try {
        const query = args.query as string;
        const facts = await memoryTools.recall(query);
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
      if (!memoryTools) return { error: 'Memory system not available' };
      try {
        const preference = args.preference as string;
        const category = (args.category as string) || 'general';
        await memoryTools.storePreference(preference, category);
        return { result: { stored: true } };
      } catch (err) {
        log.error('update_preference failed', { err: String(err) });
        return { error: `Failed to store preference: ${String(err)}` };
      }
    }

    case 'enter_mode': {
      if (!enterMode) return { error: 'Presence system not available' };
      try {
        const mode = args.mode as string;
        if (mode !== 'passive' && mode !== 'active') {
          return { error: `Invalid mode: ${mode}. Use 'passive' or 'active'.` };
        }
        // Defer to macrotask queue so the tool result is sent back to the voice
        // provider before the session is torn down. queueMicrotask would fire
        // before the await continuation in the caller, tearing down the session
        // before the result is sent.
        setTimeout(() => enterMode(mode), 0);
        return { result: { mode, transitioned: true } };
      } catch (err) {
        log.error('enter_mode failed', { err: String(err) });
        return { error: `Failed to change mode: ${String(err)}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
