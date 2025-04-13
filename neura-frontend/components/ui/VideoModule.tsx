"use client";

import { useEffect, useState } from "react";
import DeviceSelector from "./DeviceSelector";
import { PlaygroundTile } from "./PlaygroundTile";

interface VideoModuleProps {
  isConnected?: boolean;
}

const VideoModule: React.FC<VideoModuleProps> = ({ isConnected = false }) => {
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);

  // Function to start video with specific device
  const startVideo = async (deviceId?: string) => {
    // Stop existing tracks
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
    }

    setLoading(true);
    try {
      // Request video with specific device if provided
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setVideoStream(stream);

      // Store current device ID
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        setCurrentDeviceId(settings.deviceId || null);
      }

      setError(null);
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera");
    } finally {
      setLoading(false);
    }
  };

  // Initial video setup
  useEffect(() => {
    if (isConnected && !videoStream && !currentDeviceId) {
      startVideo();
    }

    // Cleanup
    return () => {
      if (videoStream) {
        videoStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [isConnected, videoStream, currentDeviceId]);

  // Listen for device change events
  useEffect(() => {
    const handleDeviceChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail && customEvent.detail.kind === "videoinput") {
        startVideo(customEvent.detail.deviceId);
      }
    };

    window.addEventListener("devicechange", handleDeviceChange);
    return () => {
      window.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  return (
    <PlaygroundTile
      title="VIDEO"
      className="w-full h-full bg-black"
      headerContent={<DeviceSelector kind="videoinput" className="ml-auto" />}
    >
      <div className="relative w-full h-full flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-2 text-gray-700 text-center h-full w-full">
            <div className="w-8 h-8 border-4 border-t-transparent border-blue-500 rounded-full animate-spin"></div>
            <p>Waiting for video track</p>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
            {error}
          </div>
        )}

        {!isConnected && !loading && (
          <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
            No video track. Connect to get started.
          </div>
        )}

        {videoStream && !loading && (
          <video
            autoPlay
            playsInline
            muted
            ref={(videoElement) => {
              if (videoElement && videoStream) {
                videoElement.srcObject = videoStream;
              }
            }}
            className="absolute top-1/2 -translate-y-1/2 object-contain object-position-center w-full h-full"
          />
        )}
      </div>
    </PlaygroundTile>
  );
};

export default VideoModule;
