import { useCallback, useRef } from 'react';
import { AUDIO_SAMPLE_RATE } from '@neura/utils';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function useAudioPlayback() {
  const ctxRef = useRef<AudioContext | null>(null);
  const nextTimeRef = useRef(0);

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      nextTimeRef.current = 0;
    }
    if (ctxRef.current.state === 'suspended') {
      void ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const playChunk = useCallback(
    (base64: string) => {
      const ctx = ensureCtx();
      const raw = base64ToArrayBuffer(base64);
      const int16 = new Int16Array(raw);
      const float32 = new Float32Array(int16.length);

      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const buffer = ctx.createBuffer(1, float32.length, AUDIO_SAMPLE_RATE);
      buffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now, nextTimeRef.current);
      source.start(startAt);
      nextTimeRef.current = startAt + buffer.duration;
    },
    [ensureCtx]
  );

  const clearQueue = useCallback(() => {
    nextTimeRef.current = 0;
  }, []);

  const close = useCallback(() => {
    void ctxRef.current?.close();
    ctxRef.current = null;
    nextTimeRef.current = 0;
  }, []);

  return { playChunk, clearQueue, close };
}
