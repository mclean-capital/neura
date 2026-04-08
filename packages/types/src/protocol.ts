// ── Client → Server messages ─────────────────────────────────────────

export interface AudioMessage {
  type: 'audio';
  data: string; // base64 PCM16 24kHz mono
}

export interface TextMessage {
  type: 'text';
  text: string;
}

export interface VideoFrameMessage {
  type: 'videoFrame';
  data: string; // base64 JPEG
  source: 'camera' | 'screen';
}

export interface SourceChangedMessage {
  type: 'sourceChanged';
  source: 'camera' | 'screen';
  active: boolean;
}

export interface ManualStartMessage {
  type: 'manualStart';
}

export type ClientMessage =
  | AudioMessage
  | TextMessage
  | VideoFrameMessage
  | SourceChangedMessage
  | ManualStartMessage;

// ── Server → Client messages ─────────────────────────────────────────

export interface ServerAudioMessage {
  type: 'audio';
  data: string; // base64 PCM16 24kHz mono
}

export interface InputTranscriptMessage {
  type: 'inputTranscript';
  text: string;
}

export interface OutputTranscriptMessage {
  type: 'outputTranscript';
  text: string;
}

export interface InterruptedMessage {
  type: 'interrupted';
}

export interface TurnCompleteMessage {
  type: 'turnComplete';
}

export interface ToolCallMessage {
  type: 'toolCall';
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: 'toolResult';
  name: string;
  result: Record<string, unknown>;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
}

export interface SessionClosedMessage {
  type: 'sessionClosed';
}

export interface CostUpdateMessage {
  type: 'costUpdate';
  sessionDurationMs: number;
  estimatedCostUsd: number;
  breakdown: {
    voice: number;
    vision: number;
  };
}

export interface PresenceStateMessage {
  type: 'presenceState';
  state: 'passive' | 'active' | 'idle';
}

export type ServerMessage =
  | ServerAudioMessage
  | InputTranscriptMessage
  | OutputTranscriptMessage
  | InterruptedMessage
  | TurnCompleteMessage
  | ToolCallMessage
  | ToolResultMessage
  | ErrorMessage
  | SessionClosedMessage
  | CostUpdateMessage
  | PresenceStateMessage;
