export type MessageType = 'user' | 'assistant' | 'tool' | 'system';

export interface TranscriptEntry {
  id: string;
  type: MessageType;
  text: string;
}

export function TranscriptMessage({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className={`msg msg-${entry.type}`}>
      <span className="msg-label">{entry.type}</span>
      <span className="msg-text">{entry.text}</span>
    </div>
  );
}
