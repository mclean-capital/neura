import type { MessageType, TranscriptEntry } from '../types/index.js';

const MSG_STYLES: Record<MessageType, { bubble: string; label: string }> = {
  user: { bubble: 'bg-user-bg self-end rounded-br-sm text-dark-text', label: 'opacity-50' },
  assistant: {
    bubble: 'bg-dark-active self-start rounded-bl-sm text-dark-text',
    label: 'opacity-50',
  },
  tool: {
    bubble:
      'bg-dark-active self-start font-mono text-[0.78rem] border-l-3 border-accent rounded-md text-accent-bright',
    label: 'text-accent opacity-80',
  },
  system: {
    bubble: 'bg-transparent self-center text-dark-muted-light text-[0.72rem]',
    label: 'opacity-50',
  },
};

export function TranscriptMessage({ entry }: { entry: TranscriptEntry }) {
  const styles = MSG_STYLES[entry.type];
  return (
    <div
      className={`px-3.5 py-2 rounded-[0.85rem] max-w-[85%] text-sm leading-relaxed break-words flex flex-col gap-0.5 ${styles.bubble}`}
    >
      <span className={`text-[0.6rem] uppercase tracking-wide ${styles.label}`}>{entry.type}</span>
      <span>{entry.text}</span>
    </div>
  );
}
