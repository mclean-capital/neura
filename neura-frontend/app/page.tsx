"use client";

import { useAuth } from "@/components/GoogleAuthProvider";
import AudioModule from "@/components/ui/AudioModule";
import EnhancedChatInterface from "@/components/ui/EnhancedChatInterface";
import StatusModule from "@/components/ui/StatusModule";
import VideoModule from "@/components/ui/VideoModule";
import { ChatProvider } from "@/contexts/ChatContext";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import NeuraLogo from "./media/images/logo-512x512.png";

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  // Set connection state for demo components
  const isConnected = true; // Simplified from state since setter is unused

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/login");
    }
  }, [user, isLoading, router]);

  // Show loading state while checking authentication
  if (isLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <main className="flex flex-col h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 border-b border-gray-700 p-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="mx-auto w-10 h-10 rounded-full flex items-center pointer-events-none justify-center">
            <Image
              width={100}
              height={100}
              priority
              src={NeuraLogo}
              alt="neura logo"
              className="rounded-full"
            />
          </div>
          <h1 className="text-xl font-bold">Neura</h1>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {user.picture ? (
              <Image
                width={100}
                height={100}
                src={user.picture}
                alt={user.name || user.email}
                className="w-8 h-8 rounded-full"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center">
                <span className="text-white font-medium">{user.name?.[0] || user.email[0]}</span>
              </div>
            )}
            <span className="text-sm hidden md:inline">{user.name || user.email}</span>
          </div>

          <LogoutButton />
        </div>
      </header>

      {/* Wrap all content that needs chat functionality with ChatProvider */}
      <ChatProvider autoConnect={true}>
        {/* New modular layout */}
        <div className="flex-1 overflow-hidden p-4 flex flex-col gap-4">
          {/* Status module row */}
          <div className="w-full">
            <StatusModule roomConnected={isConnected} agentConnected={isConnected} />
          </div>

          {/* Main content grid */}
          {!isLoading && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
              {/* Left column - Video & Audio */}

              <div className="flex flex-col gap-4 h-full">
                <div className="flex-1">
                  <VideoModule isConnected={isConnected} />
                </div>
                <div className="flex-1">
                  <AudioModule isConnected={isConnected} chatEnabled={true} />
                </div>
              </div>

              {/* Right column - Chat */}
              <div className="h-full">
                <EnhancedChatInterface />
              </div>
            </div>
          )}
        </div>
      </ChatProvider>
    </main>
  );
}

function LogoutButton() {
  const { logout } = useAuth();

  return (
    <button
      onClick={logout}
      className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded-md transition-colors"
    >
      Logout
    </button>
  );
}
