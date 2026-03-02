import { streamText, generateText, stepCountIs, type ModelMessage, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { buildSystemPrompt } from "./system-prompt.js";
import { getTools } from "./tools/index.js";
import { logger } from "../lib/logger.js";

/** Subset of AI SDK's OnFinishEvent — only the fields callers need. */
interface AgentOnFinishEvent {
  response: { messages: { role: string; content: unknown }[] };
}

const PROVIDERS: Record<string, (modelId: string) => LanguageModel> = {
  anthropic: (id) => anthropic(id),
  openai: (id) => openai(id),
  google: (id) => google(id),
};

function resolveModel(modelId: string): LanguageModel {
  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/");
  const factory = PROVIDERS[provider];
  if (!factory) {
    throw new Error(
      `Unknown provider: ${provider}. Supported: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return factory(modelName);
}

async function getAgentConfig(agentSlug?: string) {
  const { systemPrompt, agentConfig } = await buildSystemPrompt(agentSlug);
  const model = resolveModel(agentConfig.model_id);
  const tools = getTools();
  return { systemPrompt, agentConfig, model, tools };
}

export async function runAgentStream(opts: {
  messages: ModelMessage[];
  agentSlug?: string;
  onFinish?: (event: AgentOnFinishEvent) => void | Promise<void>;
}) {
  const { systemPrompt, agentConfig, model, tools } = await getAgentConfig(opts.agentSlug);

  logger.debug(
    { model: agentConfig.model_id, messageCount: opts.messages.length },
    "Running agent (stream)",
  );

  return streamText({
    model,
    system: systemPrompt,
    messages: opts.messages,
    tools,
    stopWhen: stepCountIs(10),
    temperature: Number(agentConfig.temperature),
    maxOutputTokens: Number(agentConfig.max_tokens),
    onFinish: opts.onFinish,
    onError: ({ error }) => {
      logger.error({ error }, "Agent stream error");
    },
  });
}

export async function runAgent(opts: { messages: ModelMessage[]; agentSlug?: string }) {
  const { systemPrompt, agentConfig, model, tools } = await getAgentConfig(opts.agentSlug);

  logger.debug(
    { model: agentConfig.model_id, messageCount: opts.messages.length },
    "Running agent (generate)",
  );

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: opts.messages,
    tools,
    stopWhen: stepCountIs(10),
    temperature: Number(agentConfig.temperature),
    maxOutputTokens: Number(agentConfig.max_tokens),
  });

  logger.info(
    {
      text: result.text?.substring(0, 200),
      usage: result.usage,
      finishReason: result.finishReason,
      stepCount: result.steps?.length,
    },
    "Agent response complete",
  );

  return result;
}
