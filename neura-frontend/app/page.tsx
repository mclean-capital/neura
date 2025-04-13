"use client";

import ChatInterface from "@/components/ChatInterface";
import { useAuth } from "@/components/GoogleAuthProvider";
import Image from "next/Image";
// Removed GoogleAuthProvider import
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import NeuraLogo from "./media/images/logo-512x512.png";

export default function Home() {
  // Added export default
  const { user, isLoading, token } = useAuth();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  // Set mounted state on client side
  useEffect(() => {
    setMounted(true);
  }, []);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (mounted && !isLoading && !user) {
      router.push("/login");
    }
  }, [user, isLoading, router, mounted]);

  // Show loading state while checking authentication
  if (!mounted || isLoading || !user) {
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
                src={
                  "https://lh3.googleusercontent.com/a/ACg8ocKMLbjobS1K7hcb1IqXA1W5-TqFfdSvJQ13v2xMqYTitXQEzSY=s96-c"
                }
                // src={user.picture}
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

      <div className="flex-1 overflow-hidden">
        <ChatInterface token={token} />
      </div>
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

// Removed LogoutButton component as it's defined within Home now
// Removed HomeWithAuth wrapper component
