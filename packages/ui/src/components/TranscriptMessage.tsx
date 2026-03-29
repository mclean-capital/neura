export type MessageType = 'user' | 'assistant' | 'tool' | 'system';

export interface TranscriptEntry {
  id: string;
  type: MessageType;
  text: string;
}

const MSG_STYLES: Record<MessageType, string> = {
  user: 'bg-user-bg self-end rounded-br-sm',
  assistant: 'bg-dark-hover self-start rounded-bl-sm',
  tool: 'bg-accent-bg self-start font-mono text-[0.78rem] border-l-3 border-accent rounded-md',
  system: 'bg-transparent self-center text-dark-muted text-[0.72rem]',
};

export function TranscriptMessage({ entry }: { entry: TranscriptEntry }) {
  return (
    <div
      className={`px-3.5 py-2 rounded-[0.85rem] max-w-[85%] text-sm leading-relaxed break-words flex flex-col gap-0.5 ${MSG_STYLES[entry.type]}`}
    >
      <span className="text-[0.6rem] uppercase tracking-wide opacity-50">{entry.type}</span>
      <span>{entry.text}</span>
    </div>
  );
}
