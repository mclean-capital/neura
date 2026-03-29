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
    <div className="text-input-container">
      <input
        type="text"
        className="text-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…"
        disabled={disabled}
      />
      {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing */}
      <button className="send-btn" onClick={handleSend} disabled={disabled || !value.trim()}>
        Send
      </button>
    </div>
  );
}
