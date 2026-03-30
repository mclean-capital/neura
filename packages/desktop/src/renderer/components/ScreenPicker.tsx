import { useEffect, useState } from 'react';

interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
}

interface ScreenPickerProps {
  onSelect: (sourceId: string) => void;
  onCancel: () => void;
}

export function ScreenPicker({ onSelect, onCancel }: ScreenPickerProps) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.neuraDesktop
      .getScreenSources()
      .then((s: ScreenSource[]) => {
        setSources(s);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to get screen sources');
        setLoading(false);
      });
  }, []);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-6">
      <div className="bg-dark-elevated rounded-xl border border-dark-border max-w-lg w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-border">
          <span className="text-sm font-medium">Choose what to share</span>
          <button
            className="text-dark-muted hover:text-dark-text text-lg cursor-pointer"
            onClick={onCancel}
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-3 grid grid-cols-2 gap-3">
          {loading && (
            <span className="col-span-2 text-center text-dark-muted text-sm py-8">
              Loading sources...
            </span>
          )}
          {error && (
            <span className="col-span-2 text-center text-signal-danger text-sm py-8">{error}</span>
          )}
          {sources.map((source) => (
            <button
              key={source.id}
              className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-dark-border bg-dark-bg hover:border-accent cursor-pointer transition-all"
              onClick={() => onSelect(source.id)}
            >
              <img
                src={source.thumbnail}
                alt={source.name}
                className="w-full rounded border border-dark-border"
              />
              <span className="text-xs text-dark-text truncate w-full text-center">
                {source.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
