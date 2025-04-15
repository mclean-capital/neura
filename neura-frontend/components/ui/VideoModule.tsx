"use client";

import { useMedia } from "@/contexts/MediaContext";
import { useEffect, useState } from "react";
import DeviceSelector from "./DeviceSelector";
import { PlaygroundTile } from "./PlaygroundTile";

interface VideoModuleProps {
  isConnected?: boolean;
}

const VideoModule: React.FC<VideoModuleProps> = ({ isConnected = false }) => {
  const [loading, setLoading] = useState<boolean>(false);

  // Get media context
  const { videoStream, requestVideoPermission, videoError, cameraPermission } = useMedia();

  const initializeCamera = async () => {
    if (isConnected && cameraPermission === "prompt") {
      setLoading(true);
      await requestVideoPermission();
      setLoading(false);
    }
  };

  // Initial permission request
  useEffect(() => {
    initializeCamera();
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

        {videoError && !loading && (
          <div className="flex flex-col items-center justify-center text-gray-700 text-center w-full h-full gap-3">
            <div>{videoError}</div>
            {cameraPermission === "denied" && (
              <button
                onClick={() => requestVideoPermission()}
                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                Request Camera Access
              </button>
            )}
          </div>
        )}

        {!isConnected && !loading && !videoError && (
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
            className="absolute -scale-x-100 object-contain object-position-center w-full h-full"
          />
        )}
      </div>
    </PlaygroundTile>
  );
};

export default VideoModule;
