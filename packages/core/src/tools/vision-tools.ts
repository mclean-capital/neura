import type { ToolDefinition, VisionToolArgs } from '@neura/types';
import type { ToolCallContext } from './types.js';

export const visionToolDefs: ToolDefinition[] = [
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
];

export async function handleVisionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<Record<string, unknown> | null> {
  if (name === 'describe_camera' || name === 'describe_screen') {
    const { focus, detail } = args as VisionToolArgs;
    const source = name === 'describe_camera' ? 'camera' : 'screen';
    const label = source === 'camera' ? 'from the camera' : 'on the shared screen';
    const parts = [`Describe what you see ${label}.`];
    if (focus) parts.push(`Focus on: ${focus}.`);
    if (detail === 'detailed') parts.push('Give a thorough, detailed explanation.');
    else parts.push('Keep it brief (1-2 sentences).');
    const description = await ctx.queryWatcher(parts.join(' '), source);
    return { result: description };
  }
  return null;
}
