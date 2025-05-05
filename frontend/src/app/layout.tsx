"use client";
import "./globals.css";
import { PlaygroundStateProvider } from "../hooks/use-playground-state";
import { ConnectionProvider } from "../hooks/use-connection";
import { TooltipProvider } from "../components/ui/tooltip";
import { Toaster } from "../components/ui/toaster";
// import { PHProvider } from "../hooks/posthog-provider";
import { AuthProvider } from "../hooks/useAuth";
// import PostHogPageView from "../components/posthog-pageview";

// Configure the Public Sans font
// const publicSans = Public_Sans({
//   subsets: ["latin"],
//   weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
//   style: ["normal", "italic"],
//   display: "swap",
// });

import "@livekit/components-styles";

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => {
  return (
    <PlaygroundStateProvider>
      <AuthProvider>
        <ConnectionProvider>
          <TooltipProvider>
            {/* <PostHogPageView /> */}
            {children}
            <Toaster />
          </TooltipProvider>
        </ConnectionProvider>
      </AuthProvider>
    </PlaygroundStateProvider>
  );
};

export default RootLayout;
