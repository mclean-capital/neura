import type { ProviderPricing } from '@neura/types';
import { GROK_VOICE_RATE_PER_MS } from './grok-voice.js';
import { GEMINI_VISION_RATE_PER_MS } from './gemini-vision.js';

/** Combined session pricing for the default Grok voice + Gemini vision stack. */
export const SESSION_PRICING: ProviderPricing = {
  voiceRatePerMs: GROK_VOICE_RATE_PER_MS,
  visionRatePerMs: GEMINI_VISION_RATE_PER_MS,
};

export { createGrokVoiceSession, GROK_VOICE_RATE_PER_MS } from './grok-voice.js';
export type { GrokVoiceConfig } from './grok-voice.js';

export { createGeminiVisionWatcher, GEMINI_VISION_RATE_PER_MS } from './gemini-vision.js';
export type { GeminiVisionConfig } from './gemini-vision.js';
