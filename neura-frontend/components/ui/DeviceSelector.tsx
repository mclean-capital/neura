"use client";

import { useEffect, useRef, useState } from "react";

interface DeviceSelectorProps {
  kind: MediaDeviceKind;
  position?: "left" | "right";
  className?: string;
}

export const DeviceSelector: React.FC<DeviceSelectorProps> = ({
  kind,
  position = "right",
  className = "",
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [selectedDeviceName, setSelectedDeviceName] = useState("Select device");
  const menuRef = useRef<HTMLDivElement>(null);

  // Initialize devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        // Request permission first
        if (kind === "videoinput") {
          await navigator.mediaDevices.getUserMedia({ video: true });
        } else if (kind === "audioinput") {
          await navigator.mediaDevices.getUserMedia({ audio: true });
        }

        // Get devices
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const filteredDevices = allDevices.filter((device) => device.kind === kind);
        setDevices(filteredDevices);

        // Set initial active device
        if (filteredDevices.length > 0 && !activeDeviceId) {
          setActiveDeviceId(filteredDevices[0].deviceId);
          setSelectedDeviceName(
            filteredDevices[0].label || `Default ${kind === "videoinput" ? "Camera" : "Microphone"}`
          );
        }
      } catch (err) {
        console.error("Error accessing media devices:", err);
      }
    };

    getDevices();
  }, [kind, activeDeviceId]);

  // Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Create a custom event for device change
  const setActiveMediaDevice = (deviceId: string) => {
    setActiveDeviceId(deviceId);
    const matchingDevice = devices.find((d) => d.deviceId === deviceId);
    if (matchingDevice) {
      setSelectedDeviceName(
        matchingDevice.label || `Selected ${kind === "videoinput" ? "Camera" : "Microphone"}`
      );
    }

    // Dispatch custom event
    const event = new CustomEvent("devicechange", {
      detail: { deviceId, kind },
    });
    window.dispatchEvent(event);
  };

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        className="flex gap-1 items-center px-2 py-1 bg-gray-900 text-gray-300 border border-gray-800 rounded-sm hover:bg-gray-800 text-xs"
        onClick={() => setShowMenu(!showMenu)}
        title={`Select ${kind === "videoinput" ? "Camera" : "Microphone"}`}
      >
        {kind === "videoinput" ? (
          <CameraIcon className="w-3 h-3" />
        ) : (
          <MicIcon className="w-3 h-3" />
        )}
        <span className="max-w-[80px] overflow-hidden whitespace-nowrap text-ellipsis hidden md:inline">
          {selectedDeviceName}
        </span>
        <ChevronIcon className="w-3 h-3" />
      </button>

      {showMenu && (
        <div
          className={`absolute ${position === "right" ? "right-0" : "left-0"} top-8 mt-1 bg-gray-800 text-gray-300 border border-gray-700 rounded-sm z-10 min-w-[180px] shadow-md py-1`}
        >
          <div className="text-xs border-b border-gray-700 px-3 py-1 uppercase text-gray-500 font-medium">
            {kind === "videoinput" ? "Select Camera" : "Select Microphone"}
          </div>

          {devices.length === 0 ? (
            <div className="text-xs py-2 px-3 text-gray-400">No devices found</div>
          ) : (
            devices.map((device, index) => (
              <div
                key={device.deviceId || index}
                onClick={() => {
                  setActiveMediaDevice(device.deviceId);
                  setShowMenu(false);
                }}
                className={`text-xs py-2 px-3 cursor-pointer hover:bg-gray-700 ${
                  device.deviceId === activeDeviceId ? "bg-gray-700 text-white" : "text-gray-300"
                }`}
              >
                {device.label || `Device ${index + 1}`}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// Icons
const ChevronIcon = ({ className = "" }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className={className}
  >
    <path
      fillRule="evenodd"
      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
      clipRule="evenodd"
    />
  </svg>
);

const CameraIcon = ({ className = "" }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className={className}
  >
    <path d="M3.25 4A2.25 2.25 0 001 6.25v7.5A2.25 2.25 0 003.25 16h7.5A2.25 2.25 0 0013 13.75v-7.5A2.25 2.25 0 0010.75 4h-7.5zM19 5.5a.5.5 0 00-.5-.5h-2.5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5H18.5a.5.5 0 00.5-.5v-8z" />
  </svg>
);

const MicIcon = ({ className = "" }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className={className}
  >
    <path d="M7 4a3 3 0 016 0v6a3 3 0 11-6 0V4z" />
    <path d="M5.5 9.643a.5.5 0 00-.5.5V10c0 2.92 2.42 5.25 5.5 5.25S16 12.92 16 10v-.857a.5.5 0 00-.5-.5h-1a.5.5 0 00-.5.5V10a3.5 3.5 0 11-7 0v-.857a.5.5 0 00-.5-.5h-1z" />
  </svg>
);

export default DeviceSelector;
