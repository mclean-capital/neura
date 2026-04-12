/**
 * Snapshot vision adapter — stateless, sends frame with each query.
 * Uses any vision-capable TextAdapter (OpenAI, OpenRouter, Anthropic)
 * to answer questions about an image.
 */

import { Logger } from '@neura/utils/logger';
import type { BaseVisionAdapter, TextAdapter } from '@neura/types';

const log = new Logger('snapshot-vision');

export class SnapshotVisionAdapter implements BaseVisionAdapter {
  constructor(private readonly textAdapter: TextAdapter) {}

  async query(prompt: string, frame: string): Promise<string> {
    try {
      const response = await this.textAdapter.chat([
        {
          role: 'user',
          content: [
            { type: 'image', data: frame, mimeType: 'image/jpeg' },
            { type: 'text', text: prompt },
          ],
        },
      ]);
      return response.content;
    } catch (err) {
      log.warn('snapshot vision query failed', { err: String(err) });
      return 'Vision query failed — could not analyze the image.';
    }
  }

  close(): void {
    // Stateless — no persistent connections
  }
}
