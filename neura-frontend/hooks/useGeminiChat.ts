"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";

// NodeJS Timeout type
type TimeoutRef = ReturnType<typeof setTimeout>;

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isAudio?: boolean; // Flag to indicate if this was an audio message
}

interface GeminiChatOptions {
  serverUrl?: string;
}

// Interface for audio data to be sent to the server
interface AudioMessageData {
  audioData: string; // base64 encoded audio data
  mimeType: string; // audio MIME type (e.g., 'audio/webm')
}

export function useGeminiChat({ serverUrl = "http://localhost:3001" }: GeminiChatOptions = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const reconnectTimeoutRef = useRef<TimeoutRef>();

  // Track connection attempt to prevent multiple simultaneous attempts
  const connectionAttemptInProgressRef = useRef<boolean>(false);

  // Connect to Socket.IO server
  const connect = useCallback(() => {
    // Skip if a connection attempt is already in progress
    if (connectionAttemptInProgressRef.current) {
      console.log("Connection attempt already in progress, skipping new attempt");
      return;
    }

    // Skip if already connected
    if (socketRef.current && socketRef.current.connected) {
      console.log("Already connected, skipping connection attempt");
      return;
    }

    // Close any existing connection properly
    if (socketRef.current) {
      console.log("Closing existing Socket.IO connection before reconnecting");
      try {
        socketRef.current.disconnect();
      } catch (err) {
        console.error("Error closing existing connection:", err);
      }
      socketRef.current = null;
    }

    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    // Set flag that connection attempt is starting
    connectionAttemptInProgressRef.current = true;

    console.log("Attempting to create new Socket.IO connection...");
    try {
      // Create Socket.IO connection with auto-reconnect settings
      const socket = io(serverUrl, {
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 5000,
        timeout: 10000,
      });

      socketRef.current = socket;

      // Handle connection events
      socket.on("connect", () => {
        setIsConnected(true);
        setError(null);
        console.log("Socket.IO connection opened successfully");
        connectionAttemptInProgressRef.current = false;
      });

      socket.on("disconnect", (reason) => {
        setIsConnected(false);
        console.log(`Socket.IO disconnected: ${reason}`);
        connectionAttemptInProgressRef.current = false;
      });

      socket.on("connect_error", (err) => {
        console.error("Socket.IO connection error:", err);
        setError(`Connection error: ${err.message}`);
        connectionAttemptInProgressRef.current = false;
      });

      // Handle custom message events
      socket.on("connected", (data) => {
        console.log(data.content);
      });

      socket.on("response", (data) => {
        setMessages((prevMessages: Message[]) => {
          if (prevMessages.length === 0) return prevMessages;
          const lastMessage = prevMessages[prevMessages.length - 1];
          if (lastMessage.role === "assistant") {
            const updatedMessages = [...prevMessages];
            updatedMessages[prevMessages.length - 1] = {
              ...lastMessage,
              content: lastMessage.content + (data.content || ""),
            };
            return updatedMessages;
          }
          console.warn("Received response chunk but last message wasn't assistant placeholder.");
          return prevMessages;
        });

        if (data.done) {
          console.log("Final chunk signal received.");
          setIsLoading(false);
        }
      });

      socket.on("error", (data) => {
        console.error("Error from server:", data.content);
        setError(data.content);
        setIsLoading(false);
      });
    } catch (error) {
      console.error("Error creating Socket.IO connection:", error);
      setError("Failed to establish connection.");
      connectionAttemptInProgressRef.current = false;
    }
  }, [serverUrl]);

  // Enhanced disconnect function with robust cleanup
  const disconnect = useCallback(() => {
    console.log("Disconnect explicitly called");

    // Stop any pending reconnection attempts
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    // Close the Socket.IO connection if it exists
    if (socketRef.current) {
      try {
        console.log("Closing Socket.IO connection via disconnect function");
        // Remove all listeners before disconnecting
        socketRef.current.offAny();
        socketRef.current.disconnect();
      } catch (err) {
        console.error("Error while disconnecting:", err);
      }
      socketRef.current = null;
    }

    // Reset connection state
    setIsConnected(false);
    connectionAttemptInProgressRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    // Return the disconnect function to be called on unmount
    return disconnect;
  }, [disconnect]);

  // Send text message to the server
  const sendMessage = useCallback((content: string) => {
    if (!socketRef.current || !socketRef.current.connected) {
      setError("Not connected to server");
      console.error("SendMessage failed: Socket.IO not connected.");
      return;
    }

    const userMessage: Message = { role: "user", content, timestamp: new Date() };
    const assistantPlaceholder: Message = { role: "assistant", content: "", timestamp: new Date() };

    setMessages((prev: Message[]) => [...prev, userMessage, assistantPlaceholder]);
    setIsLoading(true);
    setError(null);

    // Use the new event-based approach
    socketRef.current.emit("prompt", { content });
  }, []);

  // Send audio message to the server
  const sendAudioMessage = useCallback((audioData: AudioMessageData) => {
    if (!socketRef.current || !socketRef.current.connected) {
      setError("Not connected to server");
      console.error("SendAudioMessage failed: Socket.IO not connected.");
      return;
    }

    // Create a placeholder message for the audio input
    const userMessage: Message = {
      role: "user",
      content: "🎤 [Audio message]", // Visual indicator that audio was sent
      timestamp: new Date(),
      isAudio: true,
    };
    const assistantPlaceholder: Message = { role: "assistant", content: "", timestamp: new Date() };

    setMessages((prev: Message[]) => [...prev, userMessage, assistantPlaceholder]);
    setIsLoading(true);
    setError(null);

    // Send the audio data to the server using the new event-based approach
    socketRef.current.emit("audio", {
      audioData: audioData.audioData,
      audioMimeType: audioData.mimeType,
    });
  }, []);

  // Simplified reconnect
  const reconnect = useCallback(() => {
    console.log("Reconnect called.");
    // Simply call connect, which now handles closing existing connections
    connect();
  }, [connect]);

  // Clear all messages
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    isConnected,
    isLoading,
    error,
    sendMessage,
    sendAudioMessage,
    connect,
    reconnect,
    disconnect,
    clearMessages,
  };
}

export default useGeminiChat;
