import { useCallback, useRef, useState } from 'react';
import { AUDIO_SAMPLE_RATE } from '@neura/shared';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function useAudioCapture(onAudioData: (base64: string) => void) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: AUDIO_SAMPLE_RATE }, channelCount: 1 },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({
        sampleRate: stream.getAudioTracks()[0].getSettings().sampleRate,
      });
      audioCtxRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule('/pcm-processor.js');
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
      workletRef.current = worklet;

      worklet.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer }>) => {
        onAudioData(arrayBufferToBase64(e.data.pcm));
      };

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(worklet);

      setIsCapturing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start microphone');
    }
  }, [onAudioData]);

  const stop = useCallback(() => {
    workletRef.current?.disconnect();
    workletRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsCapturing(false);
  }, []);

  return { isCapturing, start, stop, error };
}
