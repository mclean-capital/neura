import OpenAI from 'openai';
import type {
  TextAdapter,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  ChatToolResponse,
  ChatToolStreamChunk,
  RouteDescriptor,
} from '@neura/types';
import type { ToolDefinition } from '@neura/types';

/**
 * Text adapter using the OpenAI-compatible chat completions API.
 * Works with: OpenAI, OpenRouter, Vercel AI Gateway, xAI, and any
 * provider that exposes an OpenAI-compatible endpoint.
 */
export class OpenAICompatibleTextAdapter implements TextAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(route: RouteDescriptor) {
    this.client = new OpenAI({
      apiKey: route.apiKey,
      baseURL: route.baseUrl,
    });
    this.model = route.model;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        ...(options?.json && { response_format: { type: 'json_object' as const } }),
        ...(options?.responseSchema && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: options.responseSchema,
              strict: true,
            },
          },
        }),
      },
      { signal: options?.signal }
    );
    const choice = res.choices[0];
    return {
      content: choice?.message?.content ?? '',
      usage: res.usage
        ? {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ChatStreamChunk> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stream: true,
        ...(options?.json && { response_format: { type: 'json_object' as const } }),
      },
      { signal: options?.signal }
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      const done = chunk.choices[0]?.finish_reason != null;
      if (delta || done) {
        yield { delta, done };
      }
    }
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<ChatToolResponse> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.map(toOpenAITool),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
      },
      { signal: options?.signal }
    );
    const choice = res.choices[0];
    return {
      content: choice?.message?.content ?? null,
      toolCalls: (choice?.message?.tool_calls ?? [])
        .filter(
          (
            tc
          ): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: 'function' } =>
            tc.type === 'function'
        )
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: safeParseArgs(tc.function.arguments),
        })),
      usage: res.usage
        ? {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *chatWithToolsStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatToolStreamChunk> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.map(toOpenAITool),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stream: true,
      },
      { signal: options?.signal }
    );

    // Track active tool calls by index
    const activeTools = new Map<number, { id: string; name: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        yield { type: 'text_delta', delta: delta.content };
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (tc.id) {
            // New tool call starting
            activeTools.set(idx, { id: tc.id, name: tc.function?.name ?? '' });
            yield {
              type: 'tool_call_start',
              toolCall: { id: tc.id, name: tc.function?.name },
            };
          }
          if (tc.function?.arguments) {
            const tool = activeTools.get(idx);
            yield {
              type: 'tool_call_delta',
              toolCall: {
                id: tool?.id ?? '',
                argsDelta: tc.function.arguments,
              },
            };
          }
        }
      }

      // Finish
      const finish = chunk.choices[0]?.finish_reason;
      if (finish === 'tool_calls') {
        for (const [, tool] of activeTools) {
          yield { type: 'tool_call_end', toolCall: { id: tool.id } };
        }
        activeTools.clear();
      }
      if (finish != null) {
        yield { type: 'done' };
      }
    }
  }

  close(): void {
    // OpenAI client has no persistent connections to close
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function toOpenAIMessage(msg: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      tool_call_id: msg.toolCallId ?? '',
    };
  }
  if (msg.role === 'assistant') {
    return {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
    };
  }

  // system or user — may have content parts
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }

  // Multimodal content parts (user only)
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = msg.content.map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text };
    return {
      type: 'image_url' as const,
      image_url: {
        url: `data:${p.mimeType ?? 'image/jpeg'};base64,${p.data}`,
      },
    };
  });
  return { role: 'user', content: parts };
}

function toOpenAITool(def: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as unknown as Record<string, unknown>,
    },
  };
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return { _raw: raw ?? '' };
  }
}
