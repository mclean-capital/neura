import { useEffect, useRef } from 'react';
import { TranscriptMessage, type TranscriptEntry } from './TranscriptMessage.js';

export function TranscriptPanel({ entries }: { entries: TranscriptEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="transcript-panel">
      {entries.length === 0 && (
        <div className="transcript-empty">Start speaking or type a message…</div>
      )}
      {entries.map((entry) => (
        <TranscriptMessage key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
