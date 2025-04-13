"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface GeminiChatOptions {
  serverUrl?: string;
}

export function useGeminiChat({ serverUrl = "ws://localhost:3001" }: GeminiChatOptions = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  // Connect to WebSocket server - simplified without token
  const connect = useCallback(() => {
    // Close existing connection if any
    if (socketRef.current) {
      // Avoid closing if it's the same connection attempt causing issues
      if (socketRef.current.url !== serverUrl) {
        console.log("Closing existing WebSocket connection before reconnecting.");
        socketRef.current.close(1000, "Client initiated reconnect");
      } else {
        console.log("Connect called but WebSocket URL is the same, skipping close.");
        // If it's already connecting/open with the same URL, maybe do nothing?
        if (
          socketRef.current.readyState === WebSocket.OPEN ||
          socketRef.current.readyState === WebSocket.CONNECTING
        ) {
          return;
        }
      }
    }
    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined; // Clear ref
    }

    console.log("Attempting to create new WebSocket connection...");
    try {
      const ws = new WebSocket(serverUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
        console.log("WebSocket connection opened.");
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        console.log(`WebSocket connection closed: Code=${event.code}, Reason=${event.reason}`);
        socketRef.current = null; // Clear ref on close
        // Attempt to reconnect only on abnormal closure and if still mounted/intended
        if (event.code !== 1000 && event.code !== 1005) {
          // 1000 = Normal, 1005 = No status
          // Check if a reconnect isn't already scheduled
          if (!reconnectTimeoutRef.current) {
            console.log("Scheduling reconnect attempt in 5 seconds...");
            reconnectTimeoutRef.current = setTimeout(() => {
              console.log("Attempting scheduled reconnect...");
              connect(); // Simplified reconnect without token
              reconnectTimeoutRef.current = undefined; // Clear ref after attempt
            }, 5000);
          }
        } else {
          // Clear any potential reconnect timeout on clean closure
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = undefined;
          }
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        setError("WebSocket connection error.");
        // Don't schedule reconnect on error, let onclose handle it if appropriate
      };

      ws.onmessage = (event) => {
        // ... (onmessage logic remains the same) ...
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case "connected":
              console.log(data.content);
              break;

            case "response":
              setMessages((prevMessages) => {
                if (prevMessages.length === 0) return prevMessages;
                const lastMessage = prevMessages[prevMessages.length - 1];
                if (lastMessage.role === "assistant") {
                  const updatedMessages = [...prevMessages];
                  updatedMessages[prevMessages.length - 1] = {
                    ...lastMessage,
                    content: lastMessage.content + (data.content || ""),
                  };
                  // console.log("Updating last message content:", updatedMessages[prevMessages.length - 1].content);
                  return updatedMessages;
                }
                console.warn(
                  "Received response chunk but last message wasn't assistant placeholder."
                );
                return prevMessages;
              });

              if (data.done) {
                console.log("Final chunk signal received.");
                setIsLoading(false);
              }
              break;

            case "error":
              console.error("Error from server:", data.content);
              setError(data.content);
              setIsLoading(false);
              break;

            default:
              console.warn("Unknown message type:", data.type);
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };
    } catch (error) {
      console.error("Error creating WebSocket connection:", error);
      setError("Failed to establish connection.");
    }
  }, [serverUrl]);

  // Explicit disconnect function
  const disconnect = useCallback(() => {
    console.log("Disconnect called.");
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    if (socketRef.current) {
      console.log("Closing WebSocket connection via disconnect function.");
      socketRef.current.close(1000, "User initiated disconnect"); // Use normal closure code
      socketRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    // Return the disconnect function to be called on unmount
    return disconnect;
  }, [disconnect]);

  // Auto-connect logic removed

  // Send message to the server
  const sendMessage = useCallback((content: string) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError("Not connected to server");
      console.error("SendMessage failed: WebSocket not open or null.");
      return;
    }

    const userMessage: Message = { role: "user", content, timestamp: new Date() };
    const assistantPlaceholder: Message = { role: "assistant", content: "", timestamp: new Date() };

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setIsLoading(true);
    setError(null);

    socketRef.current.send(
      JSON.stringify({
        type: "prompt",
        content,
      })
    );
  }, []);

  // Simplified reconnect without token
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
    connect, // Expose connect
    reconnect, // Expose reconnect
    disconnect, // Expose disconnect
    clearMessages,
  };
}

export default useGeminiChat;
