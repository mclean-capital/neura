interface MicButtonProps {
  isCapturing: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function MicButton({ isCapturing, onToggle, disabled }: MicButtonProps) {
  return (
    <button
      className={`w-18 h-18 rounded-full border-2 bg-dark-elevated text-dark-text cursor-pointer transition-all duration-300 flex items-center justify-center shrink-0 ${
        isCapturing
          ? 'border-accent bg-accent-bg animate-pulse-ring'
          : 'border-dark-border hover:border-accent hover:bg-dark-hover'
      }`}
      onClick={onToggle}
      disabled={disabled}
      aria-label={isCapturing ? 'Stop microphone' : 'Start microphone'}
    >
      <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
        {isCapturing ? (
          <rect x="6" y="6" width="12" height="12" rx="2" />
        ) : (
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
        )}
      </svg>
    </button>
  );
}
