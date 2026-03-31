/** Voice provider interface — any voice backend must implement this. */
export interface VoiceProvider {
  connect(): void;
  sendAudio(base64: string): void;
  sendText(text: string): void;
  sendSystemEvent(text: string): void;
  close(): void;
}

/** Callbacks the voice provider invokes to communicate with the server. */
export interface VoiceProviderCallbacks {
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onOutputTranscriptComplete: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onClose: () => void;
  onReconnected: () => void;
  queryWatcher: (prompt: string, source: 'camera' | 'screen') => Promise<string>;
}

/** Vision provider interface — any vision backend must implement this. */
export interface VisionProvider {
  connect(): Promise<void>;
  sendFrame(base64Jpeg: string): void;
  query(prompt: string): Promise<string>;
  isConnected(): boolean;
  close(): void;
}

/** Provider pricing rates for cost tracking. */
export interface ProviderPricing {
  voiceRatePerMs: number;
  visionRatePerMs: number;
}

/** Abstract data store interface for session persistence. */
export interface DataStore {
  createSession(voiceProvider: string, visionProvider: string): string;
  endSession(sessionId: string, costUsd: number): void;
  appendTranscript(sessionId: string, role: 'user' | 'assistant', text: string): void;
  getSessions(limit?: number): SessionRecord[];
  getTranscript(sessionId: string): TranscriptEntry[];
  close(): void;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  voiceProvider: string;
  visionProvider: string;
}

export interface TranscriptEntry {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
