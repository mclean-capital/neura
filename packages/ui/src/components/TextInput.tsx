import { useState, type KeyboardEvent } from 'react';

interface TextInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function TextInput({ onSend, disabled }: TextInputProps) {
  const [value, setValue] = useState('');

  const handleSend = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-2 py-2">
      <input
        type="text"
        className="flex-1 px-4 py-2 rounded-full border border-dark-border bg-dark-elevated text-dark-text text-sm outline-none font-sans focus:border-accent disabled:opacity-40"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…"
        disabled={disabled}
      />
      {}
      <button
        className="px-4 py-2 rounded-full border border-dark-border bg-dark-elevated text-dark-text cursor-pointer font-sans text-sm hover:border-accent disabled:opacity-40 disabled:cursor-default"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
      >
        Send
      </button>
    </div>
  );
}
