import { useEffect, useRef } from 'react';
import { TranscriptMessage, type TranscriptEntry } from './TranscriptMessage.js';

export function TranscriptPanel({ entries }: { entries: TranscriptEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="flex-1 w-full overflow-y-auto flex flex-col gap-2 py-2">
      {entries.length === 0 && (
        <div className="text-dark-muted text-center mt-8 text-sm">
          Start speaking or type a message…
        </div>
      )}
      {entries.map((entry) => (
        <TranscriptMessage key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
