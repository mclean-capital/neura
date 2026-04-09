import type { ToolDefinition } from '@neura/types';
import { Logger } from '@neura/utils/logger';
import type { ToolCallContext } from './types.js';

const log = new Logger('tool:presence');

export const presenceToolDefs: ToolDefinition[] = [
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
