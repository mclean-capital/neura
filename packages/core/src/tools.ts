import type { ToolDefinition, VisionToolArgs } from '@neura/shared';

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
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>
): Promise<Record<string, unknown>> {
  console.log(`[tool] ${name}(${JSON.stringify(args)})`);

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

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
