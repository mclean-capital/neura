export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'failed';

export type MessageType = 'user' | 'assistant' | 'tool' | 'system';

export interface TranscriptEntry {
  id: string;
  type: MessageType;
  text: string;
}
