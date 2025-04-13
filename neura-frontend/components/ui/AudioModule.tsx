"use client";

import { useEffect, useRef, useState } from "react";
import DeviceSelector from "./DeviceSelector";
import { PlaygroundTile } from "./PlaygroundTile";

interface AudioModuleProps {
  isConnected?: boolean;
}

const AudioModule: React.FC<AudioModuleProps> = ({ isConnected = false }) => {
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Function to start audio with specific device
  const startAudio = async (deviceId?: string) => {
    // Stop existing tracks and cleanup
    cleanupAudio();

    setLoading(true);
    try {
      // Request audio with specific device if provided
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setAudioStream(stream);

      // Store current device ID
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        setCurrentDeviceId(settings.deviceId || null);
      }

      // Set up audio analysis
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 32;
      const bufferLength = analyser.frequencyBinCount;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      analyserRef.current = analyser;

      // Start visualization
      const updateVisualization = () => {
        if (!analyserRef.current) return;

        const dataArray = new Uint8Array(bufferLength);
        analyserRef.current.getByteFrequencyData(dataArray);

        // Take a subset of the data for visualization
        const visualData = Array.from(dataArray.slice(0, 10)).map((value) => value / 255);

        setAudioLevel(visualData);

        animationFrameRef.current = requestAnimationFrame(updateVisualization);
      };

      updateVisualization();
      setError(null);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setError("Could not access microphone");
    } finally {
      setLoading(false);
    }
  };

  // Helper function to clean up audio resources
  const cleanupAudio = () => {
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // Don't close audio context as it might be reused
  };

  // Initialize audio
  useEffect(() => {
    if (isConnected && !audioStream && !currentDeviceId) {
      startAudio();
    }

    // Cleanup function
    return () => {
      cleanupAudio();

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [isConnected, audioStream, currentDeviceId]);

  // Listen for device change events
  useEffect(() => {
    const handleDeviceChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail && customEvent.detail.kind === "audioinput") {
        startAudio(customEvent.detail.deviceId);
      }
    };

    window.addEventListener("devicechange", handleDeviceChange);
    return () => {
      window.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  return (
    <PlaygroundTile
      title="AUDIO"
      className="w-full h-full"
      headerContent={<DeviceSelector kind="audioinput" className="ml-auto" />}
    >
      <div className="w-full h-full flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-2 text-gray-700 text-center h-full w-full">
            <div className="w-8 h-8 border-4 border-t-transparent border-blue-500 rounded-full animate-spin"></div>
            <p>Waiting for audio track</p>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
            {error}
          </div>
        )}

        {!isConnected && !loading && (
          <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
            No audio track. Connect to get started.
          </div>
        )}

        {audioStream && !loading && (
          <div className="flex items-center justify-center h-48 w-full gap-4">
            {audioLevel.map((level, index) => (
              <div
                key={index}
                className="w-5 bg-gray-600 rounded-sm"
                style={{
                  height: `${Math.max(20, level * 100)}px`,
                  transition: "height 0.1s ease-in-out",
                }}
              />
            ))}
            {audioLevel.length === 0 &&
              Array(10)
                .fill(0)
                .map((_, index) => (
                  <div
                    key={index}
                    className="w-5 bg-gray-600 rounded-sm"
                    style={{ height: "20px" }}
                  />
                ))}
          </div>
        )}
      </div>
    </PlaygroundTile>
  );
};

export default AudioModule;
