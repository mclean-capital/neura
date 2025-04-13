"use client";

import useGeminiChat from "@/hooks/useGeminiChat";
import { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatMessageInput } from "./ChatMessageInput";

interface ChatInterfaceProps {
  autoConnect?: boolean;
}

export default function ChatInterface({ autoConnect = true }: ChatInterfaceProps) {
  // Destructure hook values (currentMessage and autoConnect removed)
  const {
    messages,
    isConnected,
    isLoading,
    error,
    sendMessage,
    clearMessages,
    connect,
    disconnect,
  } = useGeminiChat({
    // No options needed here anymore
  });

  // Connect to chat service when component mounts if autoConnect is true
  useEffect(() => {
    if (autoConnect) {
      console.log("ChatInterface: Auto-connecting...");
      connect();
    }

    // Cleanup function
    return () => {
      console.log("ChatInterface: Cleanup effect, disconnecting...");
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

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
    // Use flex-col and h-full to take up available space
    <div className="flex flex-col w-full h-full bg-gray-900 text-white">
      {/* Messages area - Use flex-1 to take remaining space, add padding */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-2" // Added py-2 for vertical padding
      >
        {/* Inner div to push messages to the bottom */}
        <div className="flex flex-col min-h-full justify-end">
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

      {/* Input area - Use flex-shrink-0 to prevent shrinking */}
      <div className="flex-shrink-0">
        <ChatMessageInput
          onSend={handleSend}
          accentColor="blue"
          disabled={!isConnected || isLoading}
        />
      </div>
    </div>
  );
}
