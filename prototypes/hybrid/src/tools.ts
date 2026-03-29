export const toolDefs = [
  {
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
    name: 'get_current_time',
    description: 'Returns the current date and time in the server timezone',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'get_weather',
    description: 'Returns current weather for a given city (mock data)',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
  },
  {
    type: 'function' as const,
    name: 'roll_dice',
    description: 'Rolls one or more dice with the specified number of sides',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of dice (default 1)' },
        sides: { type: 'number', description: 'Sides per die (default 6)' },
      },
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  queryWatcher: (prompt: string) => Promise<string>
): Promise<Record<string, unknown>> {
  console.log(`[tool] ${name}(${JSON.stringify(args)})`);

  switch (name) {
    case 'describe_camera': {
      const focus = args.focus as string | undefined;
      const detailed = args.detail === 'detailed';
      const parts = ['Describe what you see from the camera.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detailed) parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await queryWatcher(parts.join(' '));
      return { result: description };
    }

    case 'describe_screen': {
      const focus = args.focus as string | undefined;
      const detailed = args.detail === 'detailed';
      const parts = ['Describe what you see on the shared screen.'];
      if (focus) parts.push(`Focus on: ${focus}.`);
      if (detailed) parts.push('Give a thorough, detailed explanation.');
      else parts.push('Keep it brief (1-2 sentences).');
      const description = await queryWatcher(parts.join(' '));
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

    case 'get_weather': {
      const city = (args.city as string) || 'Unknown';
      const conditions = ['sunny', 'cloudy', 'partly cloudy', 'rainy', 'windy'];
      const condition = conditions[Math.floor(Math.random() * conditions.length)];
      const tempC = Math.floor(Math.random() * 30) + 10;
      return {
        result: {
          city,
          temperature: `${tempC}°C / ${Math.round(tempC * 1.8 + 32)}°F`,
          condition,
          humidity: `${Math.floor(Math.random() * 50) + 30}%`,
          note: 'Mock data',
        },
      };
    }

    case 'roll_dice': {
      const count = Math.min((args.count as number) || 1, 100);
      const sides = Math.min((args.sides as number) || 6, 1000);
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      return { result: { rolls, total: rolls.reduce((a, b) => a + b, 0) } };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
