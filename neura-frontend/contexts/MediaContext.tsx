"use client";

import React, { ReactNode, createContext, useContext, useEffect, useState } from "react";

// Define media permission states
type PermissionState = "prompt" | "granted" | "denied" | "unsupported" | "error";

interface MediaContextType {
  // Permission states
  cameraPermission: PermissionState;
  microphonePermission: PermissionState;
  // Devices
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  // Current active devices
  activeVideoDeviceId: string | null;
  activeAudioDeviceId: string | null;
  // Streams
  videoStream: MediaStream | null;
  audioStream: MediaStream | null;
  // Methods
  requestVideoPermission: () => Promise<boolean>;
  requestAudioPermission: () => Promise<boolean>;
  setActiveVideoDevice: (deviceId: string) => Promise<void>;
  setActiveAudioDevice: (deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  // Error handling
  videoError: string | null;
  audioError: string | null;
}

// Create the context with a default undefined value
const MediaContext = createContext<MediaContextType | undefined>(undefined);

interface MediaProviderProps {
  children: ReactNode;
}

export const MediaProvider: React.FC<MediaProviderProps> = ({ children }) => {
  // Permission states
  const [cameraPermission, setCameraPermission] = useState<PermissionState>("prompt");
  const [microphonePermission, setMicrophonePermission] = useState<PermissionState>("prompt");

  // Devices
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);

  // Active devices
  const [activeVideoDeviceId, setActiveVideoDeviceId] = useState<string | null>(null);
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(null);

  // Streams
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);

  // Errors
  const [videoError, setVideoError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Initialize permissions
  useEffect(() => {
    checkPermissions();

    // Set up a polling mechanism to check permissions periodically
    // This is a workaround since the Permissions API doesn't have standard event listeners
    const permissionCheckInterval = setInterval(checkPermissions, 2000);

    return () => {
      // Clean up streams
      if (videoStream) {
        videoStream.getTracks().forEach((track) => track.stop());
      }
      if (audioStream) {
        audioStream.getTracks().forEach((track) => track.stop());
      }
      // Clear interval
      clearInterval(permissionCheckInterval);
    };
  }, []);

  // Check if media devices API is supported
  const isMediaDevicesSupported = () => {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  // Check permissions
  const checkPermissions = async () => {
    if (!isMediaDevicesSupported()) {
      setCameraPermission("unsupported");
      setMicrophonePermission("unsupported");
      return;
    }

    try {
      // Check camera and microphone permissions
      if (navigator.permissions) {
        try {
          const cameraResult = await navigator.permissions.query({
            name: "camera" as PermissionName,
          });
          setCameraPermission(cameraResult.state as PermissionState);

          // Check microphone permission
          const microphoneResult = await navigator.permissions.query({
            name: "microphone" as PermissionName,
          });
          setMicrophonePermission(microphoneResult.state as PermissionState);
        } catch (permError) {
          console.warn("Could not query permission state:", permError);
          // We'll fall back to checking during device access
        }
      }
    } catch (err) {
      console.error("Error checking permissions:", err);
      // If we can't check permissions directly, we'll detect during actual media requests
    }

    // Get devices regardless of permission state to prepare the lists
    refreshDevices();
  };

  // Refresh the list of available devices
  const refreshDevices = async () => {
    if (!isMediaDevicesSupported()) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      // Filter video devices
      const newVideoDevices = devices.filter((device) => device.kind === "videoinput");
      setVideoDevices(newVideoDevices);

      // Select first video device if none is selected
      if (newVideoDevices.length > 0 && !activeVideoDeviceId) {
        setActiveVideoDeviceId(newVideoDevices[0].deviceId);
      }

      // Filter audio devices
      const newAudioDevices = devices.filter((device) => device.kind === "audioinput");
      setAudioDevices(newAudioDevices);

      // Select first audio device if none is selected
      if (newAudioDevices.length > 0 && !activeAudioDeviceId) {
        setActiveAudioDeviceId(newAudioDevices[0].deviceId);
      }
    } catch (err) {
      console.error("Error enumerating devices:", err);
    }
  };

  // Request camera permission
  const requestVideoPermission = async (): Promise<boolean> => {
    if (!isMediaDevicesSupported()) {
      setVideoError("Camera access is not supported in this browser");
      setCameraPermission("unsupported");
      return false;
    }

    try {
      setVideoError(null);

      // Stop any existing tracks
      if (videoStream) {
        videoStream.getVideoTracks().forEach((track) => track.stop());
      }

      // Request access with the active device if available
      const constraints: MediaStreamConstraints = {
        video: activeVideoDeviceId ? { deviceId: { exact: activeVideoDeviceId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setVideoStream(stream);

      // Update permission state
      setCameraPermission("granted");

      // Refresh device list since labels are only populated after permission
      await refreshDevices();

      return true;
    } catch (err: any) {
      console.error("Error requesting video permission:", err);

      // Handle different error types
      if (err.name === "NotAllowedError") {
        setVideoError(
          "Camera access was denied. Please allow camera access in your browser settings."
        );
        setCameraPermission("denied");
      } else if (err.name === "NotFoundError") {
        setVideoError("No camera found. Please connect a camera and try again.");
      } else if (err.name === "NotReadableError") {
        setVideoError(
          "Camera is in use by another application. Please close other applications using the camera."
        );
      } else {
        setVideoError(`Camera error: ${err.message}`);
      }

      return false;
    }
  };

  // Request microphone permission
  const requestAudioPermission = async (): Promise<boolean> => {
    if (!isMediaDevicesSupported()) {
      setAudioError("Microphone access is not supported in this browser");
      setMicrophonePermission("unsupported");
      return false;
    }

    try {
      setAudioError(null);

      // Stop any existing tracks
      if (audioStream) {
        audioStream.getAudioTracks().forEach((track) => track.stop());
      }

      // Request access with the active device if available
      const constraints: MediaStreamConstraints = {
        audio: activeAudioDeviceId ? { deviceId: { exact: activeAudioDeviceId } } : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setAudioStream(stream);

      // Update permission state
      setMicrophonePermission("granted");

      // Refresh device list since labels are only populated after permission
      await refreshDevices();

      return true;
    } catch (err: any) {
      console.error("Error requesting audio permission:", err);

      // Handle different error types
      if (err.name === "NotAllowedError") {
        setAudioError(
          "Microphone access was denied. Please allow microphone access in your browser settings."
        );
        setMicrophonePermission("denied");
      } else if (err.name === "NotFoundError") {
        setAudioError("No microphone found. Please connect a microphone and try again.");
      } else if (err.name === "NotReadableError") {
        setAudioError(
          "Microphone is in use by another application. Please close other applications using the microphone."
        );
      } else {
        setAudioError(`Microphone error: ${err.message}`);
      }

      return false;
    }
  };

  // Set active video device
  const setActiveVideoDevice = async (deviceId: string) => {
    setActiveVideoDeviceId(deviceId);

    // If we already have video permission, get a new stream with the selected device
    if (cameraPermission === "granted") {
      try {
        // Stop current video tracks
        if (videoStream) {
          videoStream.getVideoTracks().forEach((track) => track.stop());
        }

        const constraints: MediaStreamConstraints = {
          video: { deviceId: { exact: deviceId } },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setVideoStream(stream);
        setVideoError(null);

        // Dispatch device change event for backwards compatibility
        const event = new CustomEvent("devicechange", {
          detail: { deviceId, kind: "videoinput" },
        });
        window.dispatchEvent(event);
      } catch (err: any) {
        console.error("Error switching video device:", err);
        setVideoError(`Error switching camera: ${err.message}`);
      }
    }
  };

  // Set active audio device
  const setActiveAudioDevice = async (deviceId: string) => {
    setActiveAudioDeviceId(deviceId);

    // If we already have audio permission, get a new stream with the selected device
    if (microphonePermission === "granted") {
      try {
        // Stop current audio tracks
        if (audioStream) {
          audioStream.getAudioTracks().forEach((track) => track.stop());
        }

        const constraints: MediaStreamConstraints = {
          audio: { deviceId: { exact: deviceId } },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setAudioStream(stream);
        setAudioError(null);

        // Dispatch device change event for backwards compatibility
        const event = new CustomEvent("devicechange", {
          detail: { deviceId, kind: "audioinput" },
        });
        window.dispatchEvent(event);
      } catch (err: any) {
        console.error("Error switching audio device:", err);
        setAudioError(`Error switching microphone: ${err.message}`);
      }
    }
  };

  // Set up device change listener
  useEffect(() => {
    const handleDeviceChange = async () => {
      await refreshDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  const value: MediaContextType = {
    cameraPermission,
    microphonePermission,
    videoDevices,
    audioDevices,
    activeVideoDeviceId,
    activeAudioDeviceId,
    videoStream,
    audioStream,
    requestVideoPermission,
    requestAudioPermission,
    setActiveVideoDevice,
    setActiveAudioDevice,
    refreshDevices,
    videoError,
    audioError,
  };

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
};

export const useMedia = (): MediaContextType => {
  const context = useContext(MediaContext);
  if (context === undefined) {
    throw new Error("useMedia must be used within a MediaProvider");
  }
  return context;
};
