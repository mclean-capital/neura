"use client";

import useGeminiChat from "@/hooks/useGeminiChat";
import { ReactNode, createContext, useContext, useEffect, useRef } from "react";

interface AudioMessageData {
  audioData: string;
  mimeType: string;
}

interface ChatContextType {
  messages: any[];
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  sendMessage: (content: string) => void;
  sendAudioMessage: (audioData: AudioMessageData) => void;
  connect: () => void;
  reconnect: () => void;
  disconnect: () => void;
  clearMessages: () => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({
  children,
  autoConnect = true,
}: {
  children: ReactNode;
  autoConnect?: boolean;
}) {
  // Call the hook inside a component
  const chat = useGeminiChat();

  // Track if we've already connected to avoid multiple connections
  const hasConnectedRef = useRef(false);

  // Connect to the chat service when the component mounts
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (autoConnect && !hasConnectedRef.current) {
      hasConnectedRef.current = true;

      // Add a small delay before connecting to prevent rapid connection attempts
      timer = setTimeout(() => {
        console.log("ChatContext: Connecting to chat service...");
        chat.connect();
      }, 300);
    }

    // Cleanup on unmount - we should only disconnect when the entire context is unmounted
    return () => {
      if (timer) clearTimeout(timer);
      // Only disconnect when the component is actually unmounting (not on dependency changes)
      // This helps prevent constant reconnections
    };
  }, [autoConnect, chat]);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}
