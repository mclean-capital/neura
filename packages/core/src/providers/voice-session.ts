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
    const textAdapter = registry.getTextAdapter();
    const voiceRoute = registry.resolveVoice();

    if (!textAdapter || voiceRoute?.mode !== 'pipeline' || !voiceRoute.pipeline) {
      throw new Error('Pipeline voice mode requires text adapter and pipeline voice routing');
    }

    // Resolve STT and TTS adapters from the pipeline route
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

    return new PipelineVoiceProvider(cb, pipelineConfig, textAdapter, sttAdapter, ttsAdapter);
  }

  return new GrokVoiceProvider(cb, config);
}
