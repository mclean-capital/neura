"use client";

import React, { createContext, useState, useCallback, useContext } from "react";
import { PlaygroundState } from "../data/playground-state";
import { usePlaygroundState } from "./use-playground-state";
import { VoiceId } from "../data/voices";
import { useAuth } from "./useAuth";

export type ConnectFn = () => Promise<void>;

type TokenGeneratorData = {
  shouldConnect: boolean;
  wsUrl: string;
  token: string;
  pgState: PlaygroundState;
  voice: VoiceId;
  disconnect: () => Promise<void>;
  connect: ConnectFn;
};

const ConnectionContext = createContext<TokenGeneratorData | undefined>(
  undefined
);

export const ConnectionProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [connectionDetails, setConnectionDetails] = useState<{
    wsUrl: string;
    token: string;
    shouldConnect: boolean;
    voice: VoiceId;
  }>({ wsUrl: "", token: "", shouldConnect: false, voice: VoiceId.alloy });

  const { pgState } = usePlaygroundState();
  const { user } = useAuth();

  const connect = useCallback(async () => {
    const response = await fetch(
      `${import.meta.env.VITE_BACKEND_API_URL}/api/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: user?.email,
        }),
      }
    );

    if (!response.ok) {
      throw new Error("Failed to fetch token");
    }

    const { accessToken, url } = await response.json();

    setConnectionDetails({
      wsUrl: url,
      token: accessToken,
      shouldConnect: true,
      voice: VoiceId.alloy,
    });
  }, [user?.email]);

  const disconnect = useCallback(async () => {
    setConnectionDetails((prev) => ({ ...prev, shouldConnect: false }));
  }, []);

  return (
    <ConnectionContext.Provider
      value={{
        wsUrl: connectionDetails.wsUrl,
        token: connectionDetails.token,
        shouldConnect: connectionDetails.shouldConnect,
        voice: connectionDetails.voice,
        pgState,
        connect,
        disconnect,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const context = useContext(ConnectionContext);

  if (context === undefined) {
    throw new Error("useConnection must be used within a ConnectionProvider");
  }

  return context;
};
