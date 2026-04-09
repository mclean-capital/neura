/**
 * Voice session factory.
 * Delegates to the active voice provider (currently Grok).
 */

import type { VoiceProvider, VoiceProviderCallbacks } from '@neura/types';
import { GrokVoiceProvider } from './grok-voice.js';
import type { GrokVoiceConfig } from './grok-voice.js';

export type SessionCallbacks = VoiceProviderCallbacks;
export type VoiceSessionConfig = GrokVoiceConfig;

export function createVoiceSession(
  cb: SessionCallbacks,
  config: VoiceSessionConfig = {}
): VoiceProvider {
  // Future: switch on config.provider to select different backends
  return new GrokVoiceProvider(cb, config);
}
