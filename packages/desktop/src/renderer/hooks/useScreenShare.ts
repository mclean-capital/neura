import { useCallback, useEffect, useRef, useState } from 'react';
import { FRAME_CAPTURE_INTERVAL_MS } from '@neura/shared';

interface UseScreenShareOptions {
  onFrame: (base64: string) => void;
  onStopped?: () => void;
}

export function useScreenShare({ onFrame, onStopped }: UseScreenShareOptions) {
  const [isActive, setIsActive] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && !el.srcObject) {
      el.srcObject = streamRef.current;
      void el.play();
    }
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    canvasRef.current ??= document.createElement('canvas');
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    const base64 = dataUrl.split(',')[1];
    onFrame(base64);
  }, [onFrame]);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsActive(false);
  }, []);

  const startWithSource = useCallback(
    async (sourceId: string): Promise<boolean> => {
      try {
        setError(null);
        setShowPicker(false);

        // Tell main process which source to use, then call getDisplayMedia
        // The setDisplayMediaRequestHandler in main will use this source ID
        await window.neuraDesktop.setScreenSource(sourceId);

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        streamRef.current = stream;

        stream.getVideoTracks()[0].addEventListener('ended', () => {
          stop();
          onStoppedRef.current?.();
        });

        setIsActive(true);
        intervalRef.current = setInterval(captureFrame, FRAME_CAPTURE_INTERVAL_MS);
        return true;
      } catch (err) {
        console.error('[screen] error:', err);
        setError(err instanceof Error ? err.message : 'Failed to start screen share');
        return false;
      }
    },
    [captureFrame, stop]
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (window.neuraDesktop) {
      setShowPicker(true);
      return true;
    }
    // Web fallback
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      streamRef.current = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stop();
        onStoppedRef.current?.();
      });
      setIsActive(true);
      intervalRef.current = setInterval(captureFrame, FRAME_CAPTURE_INTERVAL_MS);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start screen share');
      return false;
    }
  }, [captureFrame, stop]);

  const cancelPicker = useCallback(() => {
    setShowPicker(false);
  }, []);

  useEffect(() => stop, [stop]);

  return {
    isActive,
    showPicker,
    start,
    startWithSource,
    cancelPicker,
    stop,
    error,
    setVideoElement,
  };
}
