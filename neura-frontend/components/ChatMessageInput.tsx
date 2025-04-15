"use client";

import { useCallback, useState } from "react";

interface ChatMessageInputProps {
  placeholder?: string;
  accentColor?: string; // Optional accent color, default to blue
  onSend: (message: string) => void;
  disabled?: boolean;
}

export const ChatMessageInput = ({
  placeholder = "Type your message...",
  accentColor = "blue", // Default accent
  onSend,
  disabled = false,
}: ChatMessageInputProps) => {
  const [message, setMessage] = useState("");
  // Removed state/refs related to cursor animation for simplicity

  const handleSend = useCallback(() => {
    if (message.trim() === "" || !onSend) {
      return;
    }
    onSend(message.trim());
    setMessage(""); // Clear input after sending
  }, [onSend, message]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // Prevent newline on Enter
      handleSend();
    }
  };

  // Styling adapted from agents-playground ChatMessageInput
  return (
    // Use pt-3 like agents-playground, remove p-4 and bg-gray-800 if ChatInterface handles padding/bg
    <div className="border-t border-t-gray-800 pt-3 pb-3">
      <div className="flex flex-row gap-2 items-center relative px-2">
        {" "}
        {/* Add some horizontal padding */}
        <input
          type="text"
          // Apply focus styles, dynamic accent color, padding from agents-playground
          // Use text-xs like agents-playground
          className={`w-full text-xs bg-transparent text-gray-300 p-2 pr-10 rounded-sm focus:opacity-100 focus:outline-none focus:border-${accentColor}-700 focus:ring-1 focus:ring-${accentColor}-700 disabled:opacity-50 disabled:cursor-not-allowed`}
          style={{
            paddingLeft: "12px", // Simplified padding
            // caretShape: "block", // Removed caret styling for simplicity
          }}
          placeholder={placeholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        <button
          disabled={message.trim().length === 0 || disabled}
          onClick={handleSend}
          // Dynamic styling for send button from agents-playground
          className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-md text-xs uppercase text-${accentColor}-500 hover:bg-${accentColor}-950 disabled:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors opacity-${message.trim().length > 0 ? "100" : "25"} pointer-events-${message.trim().length > 0 ? "auto" : "none"}`}
        >
          Send
        </button>
      </div>
    </div>
  );
};
