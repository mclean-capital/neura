import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:presence');

export const presenceToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'enter_mode',
    description:
      "Transition the presence mode. You MUST call this tool (not just respond with a farewell message) when the user EXPLICITLY signals the conversation is over — phrases like 'goodbye', 'bye', 'thanks, that's all', 'I'm done', 'see you later', 'talk to you later', 'I'll be back later', 'catch you later', or similar clear end-of-conversation markers. When you hear these signals, respond with a brief farewell AND call enter_mode('passive') in the same turn — the tool call is how you actually release the session; a farewell message alone does not end the session. Do NOT call 'passive' for ordinary pauses, brief silence, turn boundaries, one-word replies, or when the user is simply thinking. Default behavior between turns is to stay active and wait — the user will keep talking. Call with 'active' only if needed to re-engage.",
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['passive', 'active'],
          description:
            "'passive' ONLY on explicit end-of-conversation (required alongside farewell message), 'active' to re-engage",
        },
      },
      required: ['mode'],
    },
  },
];

export function handlePresenceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Record<string, unknown> | null {
  if (name !== 'enter_mode') return null;
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
