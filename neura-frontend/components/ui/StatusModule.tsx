"use client";

import { PlaygroundTile } from "./PlaygroundTile";

interface StatusModuleProps {
  roomConnected: boolean;
  agentConnected: boolean;
  accentColor?: string;
}

const StatusModule: React.FC<StatusModuleProps> = ({
  roomConnected,
  agentConnected,
  accentColor = "green",
}) => {
  return (
    <PlaygroundTile title="STATUS" className="w-full">
      <div className="flex flex-col gap-2 w-full">
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Room connected</span>
          <span className={roomConnected ? `text-${accentColor}-500` : "text-gray-500"}>
            {roomConnected ? "CONNECTED" : "DISCONNECTED"}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Agent connected</span>
          <span className={agentConnected ? `text-${accentColor}-500` : "text-gray-500"}>
            {agentConnected ? "CONNECTED" : "DISCONNECTED"}
          </span>
        </div>
      </div>
    </PlaygroundTile>
  );
};

export default StatusModule;
