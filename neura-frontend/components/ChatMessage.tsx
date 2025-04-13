"use client";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date; // Keep timestamp data even if not displayed
}

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean; // Keep for streaming indicator
}

// Styling copied directly from agents-playground/src/components/chat/ChatMessage.tsx
// Using 'blue' as the default accent color for now.
export const ChatMessage = ({ message, isStreaming = false }: ChatMessageProps) => {
  const isSelf = message.role === "user";
  const accentColor = "blue"; // Default accent color

  // agents-playground hides name for consecutive messages from same sender.
  // We'll keep it simple and always show the name/role.
  const hideName = false;
  const name = message.role === "user" ? "You" : "Assistant";

  return (
    // Apply pt-6 unless name is hidden (which it isn't currently)
    <div className={`flex flex-col gap-1 ${hideName ? "pt-0" : "pt-6"}`}>
      {!hideName && (
        <div
          // Dynamic classes for name based on sender and accent color
          // Adjusted user name style to be right-aligned and gray
          className={`uppercase text-xs font-semibold ${
            isSelf ? "text-right text-gray-500" : `text-left text-${accentColor}-400` // Use agents-playground style for assistant
          }`}
        >
          {name}
        </div>
      )}
      {/* Message Bubble - Apply agents-playground styles */}
      <div className={`flex ${isSelf ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[80%] rounded-lg px-4 py-2 text-white ${
            isSelf
              ? `bg-${accentColor}-600` // User message background (using accent)
              : "bg-gray-700" // Assistant message background (like original neura)
          }`}
        >
          {/* Message Content - Apply agents-playground styles */}
          <div
            className={`pr-4 text-sm whitespace-pre-line ${
              // Added pr-4 from agents-playground
              isSelf
                ? "text-white" // Keep user text white on blue bg
                : `text-${accentColor}-500 drop-shadow-${accentColor}` // Assistant text style + shadow
            }`}
          >
            {message.content}
          </div>

          {/* Streaming Indicator */}
          {isStreaming && !isSelf && (
            <div className="flex items-center gap-1 mt-1">
              <div className="w-1 h-1 bg-gray-400 rounded-full animate-pulse"></div>
              <div className="w-1 h-1 bg-gray-400 rounded-full animate-pulse delay-75"></div>
              <div className="w-1 h-1 bg-gray-400 rounded-full animate-pulse delay-150"></div>
            </div>
          )}

          {/* Timestamp - Removed as per agents-playground style */}
        </div>
      </div>
    </div>
  );
};
