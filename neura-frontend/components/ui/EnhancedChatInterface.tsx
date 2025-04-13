"use client";

import ChatInterface from "../ChatInterface";
import { PlaygroundTile } from "./PlaygroundTile";

interface EnhancedChatInterfaceProps {
  autoConnect?: boolean;
}

const EnhancedChatInterface: React.FC<EnhancedChatInterfaceProps> = ({ autoConnect = true }) => {
  return (
    <PlaygroundTile title="CHAT" className="w-full h-full" padding={false} childrenClassName="p-0">
      <div className="w-full h-full">
        <ChatInterface autoConnect={autoConnect} />
      </div>
    </PlaygroundTile>
  );
};

export default EnhancedChatInterface;
