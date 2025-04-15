"use client";

import ChatInterface from "../ChatInterface";
import { PlaygroundTile } from "./PlaygroundTile";

const EnhancedChatInterface: React.FC = () => {
  return (
    <PlaygroundTile
      title="CHAT"
      className="w-full h-full"
      padding={false}
      childrenClassName="p-0 h-full flex flex-col"
    >
      <div className="w-full h-full">
        <ChatInterface />
      </div>
    </PlaygroundTile>
  );
};

export default EnhancedChatInterface;
