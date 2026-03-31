import { useCallback, useEffect, useRef, useState } from 'react';
import { FRAME_CAPTURE_INTERVAL_MS } from '@neura/shared';

export function useCamera(onFrame: (base64: string) => void) {
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => {
        /* autoplay blocked */
      });
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

  const start = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {
          /* autoplay blocked */
        });
      }

      setIsActive(true);
      intervalRef.current = setInterval(captureFrame, FRAME_CAPTURE_INTERVAL_MS);
      return true;
    } catch (err) {
      console.error('[camera] getUserMedia failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to start camera');
      return false;
    }
  }, [captureFrame]);

  useEffect(() => stop, [stop]);

  return { isActive, start, stop, error, setVideoElement };
}
