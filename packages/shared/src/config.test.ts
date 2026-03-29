import { describe, it, expect } from 'vitest';
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_FORMAT,
  FRAME_CAPTURE_INTERVAL_MS,
} from './config.js';

describe('shared/config constants', () => {
  it('AUDIO_SAMPLE_RATE is 24 kHz', () => {
    expect(AUDIO_SAMPLE_RATE).toBe(24_000);
  });

  it('AUDIO_CHANNELS is mono', () => {
    expect(AUDIO_CHANNELS).toBe(1);
  });

  it('AUDIO_FORMAT is pcm16', () => {
    expect(AUDIO_FORMAT).toBe('pcm16');
  });

  it('FRAME_CAPTURE_INTERVAL_MS is 2 seconds', () => {
    expect(FRAME_CAPTURE_INTERVAL_MS).toBe(2_000);
  });
});
