import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@neura/shared';
import {
  useWebSocket,
  useAudioCapture,
  useAudioPlayback,
  useCamera,
  useCostTracker,
  StatusBadge,
  CostIndicator,
  MicButton,
  CameraToggle,
  ScreenShareToggle,
  CameraPreview,
  ScreenPreview,
  TranscriptPanel,
  TextInput,
} from '@neura/design-system';
import type { TranscriptEntry } from '@neura/design-system';
import { config } from './config.js';
import { useScreenShare } from './hooks/useScreenShare.js';
import { ScreenPicker } from './components/ScreenPicker.js';
import { SetupWizard } from './wizard/SetupWizard.js';

let msgIdCounter = 0;
function nextId() {
  return String(++msgIdCounter);
}

export function App() {
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);

  // Check if setup is complete on mount
  useEffect(() => {
    if (window.neuraDesktop) {
      void window.neuraDesktop.getSettings().then((settings) => {
        setHasKeys(settings.hasApiKeys);
      });
    } else {
      // Not in Electron (e.g. dev browser) — skip wizard
      setHasKeys(true);
    }
  }, []);

  // Loading state
  if (hasKeys === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="app-drag-region fixed top-0 left-0 right-0 h-8" />
        <span className="text-dark-muted text-sm">Loading...</span>
      </div>
    );
  }

  // Wizard
  if (!hasKeys) {
    return (
      <div className="h-full relative">
        <div className="app-drag-region fixed top-0 left-0 right-0 h-8" />
        <SetupWizard onComplete={() => setHasKeys(true)} />
      </div>
    );
  }

  // Main session
  return <Session />;
}

function Session() {
  const { status, connect, disconnect, sendMessage, subscribe } = useWebSocket(config.wsUrl);
  const { playChunk, clearQueue, close: closePlayback } = useAudioPlayback();
  const { cost, handleCostUpdate } = useCostTracker();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);

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

  useEffect(() => {
    return () => closePlayback();
  }, [closePlayback]);

  const handleAudioData = useCallback(
    (base64: string) => sendMessage({ type: 'audio', data: base64 }),
    [sendMessage]
  );
  const mic = useAudioCapture(handleAudioData);

  const handleCameraFrame = useCallback(
    (base64: string) => sendMessage({ type: 'videoFrame', data: base64, source: 'camera' }),
    [sendMessage]
  );
  const camera = useCamera(handleCameraFrame);

  const handleScreenFrame = useCallback(
    (base64: string) => sendMessage({ type: 'videoFrame', data: base64, source: 'screen' }),
    [sendMessage]
  );
  const handleScreenStopped = useCallback(() => {
    sendMessage({ type: 'sourceChanged', source: 'screen', active: false });
  }, [sendMessage]);
  const screen = useScreenShare({ onFrame: handleScreenFrame, onStopped: handleScreenStopped });

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
      if (mic.isCapturing) mic.stop();
      if (camera.isActive) camera.stop();
      if (screen.isActive) screen.stop();
      disconnect();
    }
  }, [isDisconnected, connect, disconnect, mic, camera, screen]);

  return (
    <div className="h-full w-full max-w-3xl flex flex-col p-4 app-drag-region">
      <div className="flex items-center justify-between pb-3 pt-5">
        <span className="text-xl font-medium tracking-[0.15em] text-dark-text font-display">
          NEURA
        </span>
        <CostIndicator cost={cost} />
        {isConnected ? (
          <button
            className="px-4 py-1.5 rounded-full border-2 border-signal-danger text-signal-danger cursor-pointer text-xs font-medium transition-all duration-200 hover:bg-signal-danger-bg"
            onClick={handleSessionToggle}
          >
            End Session
          </button>
        ) : (
          <StatusBadge status={status} />
        )}
      </div>

      {(camera.isActive || screen.isActive) && (
        <div className="flex gap-3 mb-3">
          <CameraPreview isActive={camera.isActive} setVideoElement={camera.setVideoElement} />
          <ScreenPreview isActive={screen.isActive} setVideoElement={screen.setVideoElement} />
        </div>
      )}

      <div className="app-no-drag flex-1 min-h-0 flex flex-col">
        <TranscriptPanel entries={entries} />
      </div>

      <div className="flex items-center justify-center gap-4 py-3 shrink-0 app-no-drag">
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
            className="px-8 py-3 rounded-full border-2 border-session-green bg-session-green-bg text-session-green cursor-pointer text-base font-medium transition-all duration-200 hover:bg-session-green-hover hover:shadow-[0_0_0_4px_rgba(42,212,104,0.15)] disabled:opacity-40 disabled:cursor-default"
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
      </div>

      <div className="app-no-drag shrink-0">
        <TextInput onSend={handleSendText} disabled={!isConnected} />
      </div>

      {screen.showPicker && (
        <ScreenPicker
          onSelect={(sourceId) => {
            void screen.startWithSource(sourceId).then((ok) => {
              if (ok) sendMessage({ type: 'sourceChanged', source: 'screen', active: true });
            });
          }}
          onCancel={screen.cancelPicker}
        />
      )}
    </div>
  );
}
