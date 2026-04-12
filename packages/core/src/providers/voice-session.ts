/**
 * Voice session factory.
 * Delegates to the active voice provider based on config:
 * - "realtime" → GrokVoiceProvider (xAI Realtime API)
 * - "pipeline" → PipelineVoiceProvider (STT → LLM → TTS)
 */

import type { VoiceProvider, VoiceProviderCallbacks } from '@neura/types';
import { GrokVoiceProvider } from './grok-voice.js';
import type { GrokVoiceConfig } from './grok-voice.js';
import { PipelineVoiceProvider } from './pipeline-voice.js';
import type { PipelineVoiceConfig } from './pipeline-voice.js';
import type { ProviderRegistry } from '../registry/index.js';

export type SessionCallbacks = VoiceProviderCallbacks;

export interface VoiceSessionConfig extends GrokVoiceConfig {
  /** Voice mode: "realtime" (default) or "pipeline" */
  mode?: 'realtime' | 'pipeline';
}

export function createVoiceSession(
  cb: SessionCallbacks,
  config: VoiceSessionConfig = {},
  registry?: ProviderRegistry
): VoiceProvider {
  if (config.mode === 'pipeline' && registry) {
    const voiceRoute = registry.resolveVoice();

    if (voiceRoute?.mode !== 'pipeline' || !voiceRoute.pipeline) {
      throw new Error('Pipeline voice mode requires pipeline voice routing');
    }

    // Use the pipeline-specific LLM route, NOT the singleton text adapter.
    // This allows config to route voice LLM separately from memory/discovery text.
    const llmAdapter = registry.createTextAdapterForRoute(voiceRoute.pipeline.llm);
    const sttAdapter = registry.createSTTAdapter(voiceRoute.pipeline.stt);
    const ttsAdapter = registry.createTTSAdapter(voiceRoute.pipeline.tts);

    const pipelineConfig: PipelineVoiceConfig = {
      systemPromptPrefix: config.systemPromptPrefix,
      memoryTools: config.memoryTools,
      enterMode: config.enterMode,
      taskTools: config.taskTools,
      skillTools: config.skillTools,
      workerControl: config.workerControl,
    };

    return new PipelineVoiceProvider(cb, pipelineConfig, llmAdapter, sttAdapter, ttsAdapter);
  }

  return new GrokVoiceProvider(cb, config);
}
