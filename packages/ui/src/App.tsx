import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@neura/shared';
import { config } from './config.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useAudioCapture } from './hooks/useAudioCapture.js';
import { useAudioPlayback } from './hooks/useAudioPlayback.js';
import { useCamera } from './hooks/useCamera.js';
import { useScreenShare } from './hooks/useScreenShare.js';
import { useCostTracker } from './hooks/useCostTracker.js';
import { StatusBadge } from './components/StatusBadge.js';
import { CostIndicator } from './components/CostIndicator.js';
import { MicButton } from './components/MicButton.js';
import { CameraToggle } from './components/CameraToggle.js';
import { ScreenShareToggle } from './components/ScreenShareToggle.js';
import { CameraPreview } from './components/CameraPreview.js';
import { ScreenPreview } from './components/ScreenPreview.js';
import { TranscriptPanel } from './components/TranscriptPanel.js';
import { TextInput } from './components/TextInput.js';
import type { TranscriptEntry } from './components/TranscriptMessage.js';

let msgIdCounter = 0;
function nextId() {
  return String(++msgIdCounter);
}

export function App() {
  const { status, connect, disconnect, sendMessage, subscribe } = useWebSocket(config.wsUrl);
  const { playChunk, clearQueue, close: closePlayback } = useAudioPlayback();
  const { cost, handleCostUpdate } = useCostTracker();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);

  // Track current streaming messages
  const currentUserRef = useRef<string | null>(null);
  const currentAssistantRef = useRef<string | null>(null);

  const addEntry = useCallback((type: TranscriptEntry['type'], text: string) => {
    const id = nextId();
    setEntries((prev) => [...prev, { id, type, text }]);
    return id;
  }, []);

  const updateEntry = useCallback((id: string, text: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)));
  }, []);

  // Handle incoming server messages
  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      switch (msg.type) {
        case 'audio':
          playChunk(msg.data);
          break;

        case 'inputTranscript':
          if (!currentUserRef.current) {
            currentUserRef.current = addEntry('user', msg.text);
          } else {
            updateEntry(currentUserRef.current, msg.text);
          }
          break;

        case 'outputTranscript':
          if (!currentAssistantRef.current) {
            currentAssistantRef.current = addEntry('assistant', msg.text);
          } else {
            updateEntry(currentAssistantRef.current, msg.text);
          }
          break;

        case 'interrupted':
          clearQueue();
          break;

        case 'turnComplete':
          currentUserRef.current = null;
          currentAssistantRef.current = null;
          break;

        case 'toolCall':
          addEntry('tool', `${msg.name}(${JSON.stringify(msg.args)})`);
          break;

        case 'toolResult':
          addEntry('tool', `${msg.name} → ${JSON.stringify(msg.result)}`);
          break;

        case 'error':
          addEntry('system', `Error: ${msg.error}`);
          break;

        case 'sessionClosed':
          addEntry('system', 'Session closed');
          break;

        case 'costUpdate':
          handleCostUpdate(msg);
          break;
      }
    });
  }, [subscribe, playChunk, clearQueue, addEntry, updateEntry, handleCostUpdate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => closePlayback();
  }, [closePlayback]);

  // Mic
  const handleAudioData = useCallback(
    (base64: string) => sendMessage({ type: 'audio', data: base64 }),
    [sendMessage]
  );
  const mic = useAudioCapture(handleAudioData);

  // Camera
  const handleCameraFrame = useCallback(
    (base64: string) => sendMessage({ type: 'videoFrame', data: base64, source: 'camera' }),
    [sendMessage]
  );
  const camera = useCamera(handleCameraFrame);

  // Screen
  const handleScreenFrame = useCallback(
    (base64: string) => sendMessage({ type: 'videoFrame', data: base64, source: 'screen' }),
    [sendMessage]
  );
  const handleScreenStopped = useCallback(() => {
    // Browser native "Stop sharing" button — notify server
    sendMessage({ type: 'sourceChanged', source: 'screen', active: false });
  }, [sendMessage]);
  const screen = useScreenShare({ onFrame: handleScreenFrame, onStopped: handleScreenStopped });

  // Text
  const handleSendText = useCallback(
    (text: string) => {
      addEntry('user', text);
      sendMessage({ type: 'text', text });
    },
    [sendMessage, addEntry]
  );

  const isConnected = status === 'connected';
  const isDisconnected = status === 'disconnected';

  const handleSessionToggle = useCallback(() => {
    if (isDisconnected) {
      connect();
    } else {
      // Stop all media before disconnecting
      if (mic.isCapturing) mic.stop();
      if (camera.isActive) camera.stop();
      if (screen.isActive) screen.stop();
      disconnect();
    }
  }, [isDisconnected, connect, disconnect, mic, camera, screen]);

  return (
    <div className="h-full w-full max-w-3xl flex flex-col p-4">
      <div className="flex items-center justify-between pb-3">
        <span className="text-xl font-medium tracking-[0.15em] text-dark-text font-display">
          NEURA
        </span>
        <CostIndicator cost={cost} />
        <StatusBadge status={status} />
      </div>

      {(camera.isActive || screen.isActive) && (
        <div className="flex gap-3 mb-3">
          <CameraPreview isActive={camera.isActive} setVideoElement={camera.setVideoElement} />
          <ScreenPreview isActive={screen.isActive} setVideoElement={screen.setVideoElement} />
        </div>
      )}

      <TranscriptPanel entries={entries} />

      <div className="flex items-center justify-center gap-4 py-3">
        {isConnected && (
          <CameraToggle
            isActive={camera.isActive}
            onToggle={() => {
              if (camera.isActive) {
                camera.stop();
                sendMessage({ type: 'sourceChanged', source: 'camera', active: false });
              } else {
                void camera.start().then((ok) => {
                  if (ok) sendMessage({ type: 'sourceChanged', source: 'camera', active: true });
                });
              }
            }}
          />
        )}
        {isConnected ? (
          <MicButton
            isCapturing={mic.isCapturing}
            onToggle={() => (mic.isCapturing ? mic.stop() : void mic.start())}
          />
        ) : (
          <button
            className="px-8 py-3 rounded-full border-2 border-session-green bg-session-green-bg text-session-green cursor-pointertext-base font-medium transition-all duration-200 hover:bg-session-green-hover hover:shadow-[0_0_0_4px_rgba(42,212,104,0.15)] disabled:opacity-40 disabled:cursor-default"
            onClick={handleSessionToggle}
            disabled={!isDisconnected}
          >
            Start Session
          </button>
        )}
        {isConnected && (
          <ScreenShareToggle
            isActive={screen.isActive}
            onToggle={() => {
              if (screen.isActive) {
                screen.stop();
                sendMessage({ type: 'sourceChanged', source: 'screen', active: false });
              } else {
                void screen.start().then((ok) => {
                  if (ok) sendMessage({ type: 'sourceChanged', source: 'screen', active: true });
                });
              }
            }}
          />
        )}
        {isConnected && (
          <button
            className="px-3.5 py-2 rounded-full border border-dark-muted bg-dark-hover text-dark-muted-light cursor-pointertext-xs transition-all duration-200 hover:border-signal-danger hover:text-signal-danger"
            onClick={handleSessionToggle}
          >
            End
          </button>
        )}
      </div>

      <TextInput onSend={handleSendText} disabled={!isConnected} />
    </div>
  );
}
