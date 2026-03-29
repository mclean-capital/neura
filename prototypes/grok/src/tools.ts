/**
 * Demo tools for Grok Voice Agent function calling.
 * Uses OpenAI Realtime API tool format.
 */

export const toolDefs = [
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
        count: { type: 'number', description: 'Number of dice to roll (default 1)' },
        sides: { type: 'number', description: 'Number of sides per die (default 6)' },
      },
    },
  },
];

export function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  console.log(`[tool] ${name}(${JSON.stringify(args)})`);

  switch (name) {
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
          note: 'This is mock data for demo purposes',
        },
      };
    }

    case 'roll_dice': {
      const count = Math.min((args.count as number) || 1, 100);
      const sides = Math.min((args.sides as number) || 6, 1000);
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      return {
        result: { rolls, total: rolls.reduce((a, b) => a + b, 0) },
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
