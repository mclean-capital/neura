/**
 * Vision watcher factory.
 * Creates streaming (Gemini) or snapshot (any vision LLM) adapters
 * based on the vision routing config.
 */

import type { VisionProvider, TextAdapter } from '@neura/types';
import { GeminiVisionProvider } from './gemini-vision.js';
import type { GeminiVisionConfig } from './gemini-vision.js';
import { SnapshotVisionAdapter } from '../adapters/snapshot-vision.js';

export interface VisionWatcherConfig extends GeminiVisionConfig {
  mode?: 'streaming' | 'snapshot';
  textAdapter?: TextAdapter;
}

export function createVisionWatcher(config: VisionWatcherConfig = {}): VisionProvider {
  if (config.mode === 'snapshot') {
    if (!config.textAdapter) {
      throw new Error(
        'Snapshot vision mode requires a text adapter (routing.vision configured as snapshot ' +
          'but no text adapter available — check that routing.vision.provider has an API key)'
      );
    }
    return new SnapshotVisionWrapperProvider(config.textAdapter, config.label);
  }

  return new GeminiVisionProvider(config);
}

/**
 * Wrapper that makes SnapshotVisionAdapter look like VisionProvider.
 * The VisionProvider interface expects query(prompt) without a frame param,
 * so the wrapper tracks the latest frame from sendFrame() and passes it.
 */
class SnapshotVisionWrapperProvider implements VisionProvider {
  private readonly adapter: SnapshotVisionAdapter;
  private readonly label: string;
  private latestFrame: string | null = null;

  constructor(textAdapter: TextAdapter, label?: string) {
    this.adapter = new SnapshotVisionAdapter(textAdapter);
    this.label = label ?? 'snapshot-vision';
  }

  async connect(): Promise<void> {
    // No persistent connection needed for snapshot mode
  }

  sendFrame(base64Jpeg: string): void {
    // Track latest frame for use in query()
    this.latestFrame = base64Jpeg;
  }

  async query(prompt: string): Promise<string> {
    if (!this.latestFrame) {
      return `${this.label} has no frame — share your camera or screen first.`;
    }
    return this.adapter.query(prompt, this.latestFrame);
  }

  isConnected(): boolean {
    return true; // Always "connected" — stateless
  }

  close(): void {
    this.latestFrame = null;
    this.adapter.close();
  }
}
