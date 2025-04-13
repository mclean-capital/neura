"use client";

import { useAuth } from "@/components/GoogleAuthProvider";
import Image from "next/Image";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import NeuraLogo from "../media/images/logo-512x512.png";

// Google credential response type
interface GoogleCredentialResponse {
  credential: string;
  select_by: string;
  clientId: string;
}

// Define Google library types
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: GoogleInitializeConfig) => void;
          renderButton: (element: HTMLElement, options: GoogleButtonOptions) => void;
          prompt: () => void;
        };
      };
    };
  }
}

// Google initialization config type
interface GoogleInitializeConfig {
  client_id: string | undefined;
  callback: (response: GoogleCredentialResponse) => void;
  auto_select?: boolean;
}

// Google button options type
interface GoogleButtonOptions {
  theme: string;
  size: string;
  type: string;
  text: string;
  shape: string;
  logo_alignment: string;
  width: number;
}

export default function LoginPage() {
  const { login, user, isLoading, error } = useAuth();
  const router = useRouter();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const googleScriptLoaded = useRef(false);

  // Redirect if already logged in
  useEffect(() => {
    if (user && !isLoading) {
      router.push("/");
    }
  }, [user, isLoading, router]);

  // Initialize Google Sign-In
  useEffect(() => {
    // Skip if already logged in or script already loaded
    if (user || googleScriptLoaded.current) return;

    const loadGoogleScript = () => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = initializeGoogleSignIn;
      document.body.appendChild(script);
      googleScriptLoaded.current = true;
    };

    const initializeGoogleSignIn = () => {
      if (!window.google || !googleButtonRef.current) return;

      window.google.accounts.id.initialize({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
        callback: handleGoogleCredentialResponse,
      });

      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "filled_blue",
        size: "large",
        type: "standard",
        text: "continue_with",
        shape: "rectangular",
        logo_alignment: "left",
        width: 280,
      });
    };

    loadGoogleScript();
  }, [user]);

  const handleGoogleCredentialResponse = async (response: GoogleCredentialResponse) => {
    if (response.credential) {
      await login(response.credential);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <div className="w-full max-w-md p-8 space-y-8 bg-gray-800 rounded-lg shadow-lg">
        <div className="text-center">
          <div className="mx-auto  w-20 h-20 rounded-full flex items-center pointer-events-none justify-center">
            <Image
              width={200}
              height={200}
              src={NeuraLogo}
              alt="neura logo"
              className="rounded-full"
            />
          </div>
          <h2 className="mt-6 text-3xl font-extrabold text-white">Sign in to Neura</h2>
          <p className="mt-2 text-sm text-gray-400">Access your personal AI</p>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-500 text-white px-4 py-3 rounded relative">
            <strong className="font-bold">Error: </strong>
            <span className="block sm:inline">{error}</span>
          </div>
        )}

        <div className="mt-8 flex flex-col items-center space-y-4">
          {isLoading ? (
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          ) : (
            <div ref={googleButtonRef} className="flex justify-center"></div>
          )}

          <p className="text-xs text-gray-500 mt-6 text-center">
            Only authorized users can access this application.
          </p>
        </div>
      </div>
    </div>
  );
}
