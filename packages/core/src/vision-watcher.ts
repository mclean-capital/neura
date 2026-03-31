/**
 * Vision watcher factory.
 * Delegates to the active vision provider (currently Gemini).
 */

import type { VisionProvider } from '@neura/types';
import { createGeminiVisionWatcher } from './providers/gemini-vision.js';
import type { GeminiVisionConfig } from './providers/gemini-vision.js';

export type VisionWatcherConfig = GeminiVisionConfig;

export function createVisionWatcher(config: VisionWatcherConfig = {}): VisionProvider {
  // Future: switch on config.provider to select different backends
  return createGeminiVisionWatcher(config);
}
