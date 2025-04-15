"use client";

import { useChatContext } from "@/contexts/ChatContext";
import { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatMessageInput } from "./ChatMessageInput";

export default function ChatInterface() {
  // Get chat methods from shared context
  const { messages, isConnected, isLoading, error, sendMessage } = useChatContext();

  // No need to handle connection - it's managed by the context provider now

  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Log messages state whenever it changes (for debugging)
  useEffect(() => {
    console.log("ChatInterface messages state updated:", messages);
  }, [messages]);

  const handleSend = (message: string) => {
    if (!isLoading && isConnected) {
      sendMessage(message);
    }
  };

  // Layout adapted from agents-playground ChatTile
  return (
    // Main container with fixed height
    <div className="flex flex-col w-full h-full bg-gray-900 text-white relative">
      {/* Scrollable messages container with absolute positioning */}
      <div
        ref={messagesContainerRef}
        className="absolute inset-x-0 top-0 bottom-[64px] px-4 py-4 overflow-y-scroll"
        style={{
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "thin",
        }}
      >
        {/* Messages with spacing */}
        <div className="flex flex-col space-y-4 pb-4">
          {/* Initial placeholder */}
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-12 h-12 mb-3"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                />
              </svg>
            </div>
          )}
          {/* Render messages */}
          {messages.map((msg, index) => (
            <ChatMessage
              key={`msg-${index}`}
              message={msg}
              isStreaming={index === messages.length - 1 && msg.role === "assistant" && isLoading}
            />
          ))}
          {/* Error message */}
          {error && (
            <div className="flex justify-center pt-6">
              <div className="max-w-[80%] bg-red-900/50 border border-red-500 text-white px-4 py-2 rounded-lg">
                <strong className="font-bold">Error: </strong>
                <span>{error}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input area - Fixed at the bottom */}
      <div className="absolute inset-x-0 bottom-0">
        <ChatMessageInput
          onSend={handleSend}
          accentColor="blue"
          disabled={!isConnected || isLoading}
        />
      </div>
    </div>
  );
}
