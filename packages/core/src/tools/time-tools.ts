import type { ToolDefinition } from '@neura/types';

export const timeToolDefs: ToolDefinition[] = [
  {
    type: 'function',
    name: 'get_current_time',
    description: 'Returns the current date and time in the server timezone',
    parameters: { type: 'object', properties: {} },
  },
];

export function handleTimeTool(name: string): Record<string, unknown> | null {
  if (name === 'get_current_time') {
    const now = new Date();
    return {
      result: {
        time: now.toLocaleTimeString(),
        date: now.toLocaleDateString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };
  }
  return null;
}
