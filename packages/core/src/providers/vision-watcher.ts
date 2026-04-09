/**
 * Vision watcher factory.
 * Delegates to the active vision provider (currently Gemini).
 */

import type { VisionProvider } from '@neura/types';
import { GeminiVisionProvider } from './gemini-vision.js';
import type { GeminiVisionConfig } from './gemini-vision.js';

export type VisionWatcherConfig = GeminiVisionConfig;

export function createVisionWatcher(config: VisionWatcherConfig = {}): VisionProvider {
  // Future: switch on config.provider to select different backends
  return new GeminiVisionProvider(config);
}
