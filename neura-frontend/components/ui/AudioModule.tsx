"use client";

import { useChatContext } from "@/contexts/ChatContext";
import { useMedia } from "@/contexts/MediaContext";
import { useEffect, useRef, useState } from "react";
import DeviceSelector from "./DeviceSelector";
import { PlaygroundTile } from "./PlaygroundTile";

interface AudioModuleProps {
  isConnected?: boolean;
  chatEnabled?: boolean;
}

const AudioModule: React.FC<AudioModuleProps> = ({ isConnected = false, chatEnabled = true }) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingTime, setRecordingTime] = useState<number>(0);

  // Media elements
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Get the media context
  const { audioStream, requestAudioPermission, audioError, microphonePermission } = useMedia();

  // Get the chat context with connection controls
  const {
    sendAudioMessage,
    isConnected: isChatConnected,
    connect: connectChat,
    error: chatError,
  } = useChatContext();

  // We've removed the automatic connection attempt on component load
  // to prevent connection loops

  // Helper function to clean up audio resources
  const cleanupAudio = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  // Set up audio analysis when stream changes
  useEffect(() => {
    if (!audioStream) return;

    const setupAudioAnalysis = async () => {
      // Set up audio analysis
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 32;
      const bufferLength = analyser.frequencyBinCount;

      const source = audioContext.createMediaStreamSource(audioStream);
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
    };

    setupAudioAnalysis();

    // Cleanup on unmount or when stream changes
    return cleanupAudio;
  }, [audioStream]);

  // Initialize audio when connected
  useEffect(() => {
    const initializeAudio = async () => {
      if (isConnected && microphonePermission === "prompt") {
        setLoading(true);
        await requestAudioPermission();
        setLoading(false);
      }
    };

    initializeAudio();
  }, [isConnected, microphonePermission, requestAudioPermission]);

  // Start recording audio
  const startRecording = async () => {
    if (!audioStream) {
      // Try to request microphone access if we don't have a stream
      setLoading(true);
      const success = await requestAudioPermission();
      setLoading(false);
      if (!success || !audioStream) return;
    }

    try {
      recordedChunksRef.current = [];

      // Create a new MediaRecorder instance
      // Try different MIME types as fallbacks if one is not supported
      let options;
      if (MediaRecorder.isTypeSupported("audio/webm")) {
        options = { mimeType: "audio/webm" };
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options = { mimeType: "audio/mp4" };
      } else {
        // Use default options if neither is supported
        options = {};
      }

      // audioStream is guaranteed to be non-null here
      const recorder = new MediaRecorder(audioStream, options);

      // Handle data available event
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      // Handle recording stop event
      recorder.onstop = async () => {
        // Create a blob from the recorded chunks
        const audioBlob = new Blob(recordedChunksRef.current, { type: "audio/webm" });

        // Convert blob to base64 for chat service
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          const base64data = reader.result as string;
          // Remove the data URL prefix to get just the base64 data
          const base64Audio = base64data.split(",")[1];

          // Only send if already connected
          if (isChatConnected && chatEnabled) {
            sendAudioMessage({
              audioData: base64Audio,
              mimeType: "audio/webm",
            });
          }
        };

        // Reset recording state
        setIsRecording(false);
        setRecordingTime(0);
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
      };

      // Start recording
      recorder.start(1000); // Collect data in 1-second chunks
      mediaRecorderRef.current = recorder;
      setIsRecording(true);

      // Start timer for recording duration
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Error starting recording:", err);
      // Don't need to set error here as we're using the context error state
    }
  };

  // Stop recording audio
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  // Toggle recording state
  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  // Format recording time as MM:SS
  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <PlaygroundTile
      title="AUDIO"
      className="w-full h-full"
      headerContent={<DeviceSelector kind="audioinput" className="ml-auto" />}
    >
      <div className="w-full h-full flex flex-col items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-2 text-gray-700 text-center h-full w-full">
            <div className="w-8 h-8 border-4 border-t-transparent border-blue-500 rounded-full animate-spin"></div>
            <p>Waiting for audio track</p>
          </div>
        )}

        {audioError && !loading && (
          <div className="flex flex-col items-center justify-center text-gray-700 text-center w-full h-full gap-3">
            <div>{audioError}</div>
            {microphonePermission === "denied" && (
              <button
                onClick={() => requestAudioPermission()}
                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                Request Microphone Access
              </button>
            )}
          </div>
        )}

        {!isConnected && !loading && (
          <div className="flex items-center justify-center text-gray-700 text-center w-full h-full">
            No audio track. Connect to get started.
          </div>
        )}

        {audioStream && !loading && (
          <>
            <div className="flex items-center justify-center h-32 w-full gap-4">
              {audioLevel.map((level, index) => (
                <div
                  key={index}
                  className={`w-5 rounded-sm ${isRecording ? "bg-red-600" : "bg-gray-600"}`}
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
                      className={`w-5 rounded-sm ${isRecording ? "bg-red-600" : "bg-gray-600"}`}
                      style={{ height: "20px" }}
                    />
                  ))}
            </div>

            {/* Recording controls */}
            <div className="mt-6 flex flex-col items-center gap-4">
              {isRecording && (
                <div className="text-red-500 font-mono text-sm font-bold animate-pulse">
                  REC {formatRecordingTime(recordingTime)}
                </div>
              )}

              <button
                onClick={toggleRecording}
                disabled={!isConnected} // Only disable if device not connected
                className={`flex items-center justify-center w-14 h-14 rounded-full border-2 ${
                  isRecording
                    ? "bg-red-600 hover:bg-red-700 border-red-700"
                    : "bg-blue-600 hover:bg-blue-700 border-blue-700"
                } text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
                title={isRecording ? "Stop recording" : "Start recording"}
                aria-label={isRecording ? "Stop recording" : "Start recording"}
              >
                {isRecording ? (
                  // Stop icon
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <rect x="6" y="6" width="12" height="12" strokeWidth="2" fill="white" />
                  </svg>
                ) : (
                  // Microphone icon
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                    />
                  </svg>
                )}
              </button>

              <div className="flex flex-col items-center mt-2">
                {!isChatConnected ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500"></div>
                      <div className="text-amber-500 text-xs">Chat disconnected</div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        connectChat();
                      }}
                      className="px-4 py-2 mt-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium flex items-center gap-2"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12h14"></path>
                        <path d="M12 5v14"></path>
                      </svg>
                      Connect to Gemini
                    </button>

                    {chatError && (
                      <div className="text-red-500 text-xs text-center mt-3 max-w-xs">
                        Error: {chatError}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-green-500"></div>
                    <div className="text-green-500 text-xs">Connected to Gemini</div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </PlaygroundTile>
  );
};

export default AudioModule;
