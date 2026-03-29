interface MicButtonProps {
  isCapturing: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function MicButton({ isCapturing, onToggle, disabled }: MicButtonProps) {
  return (
    <button
      className={`mic-btn ${isCapturing ? 'active' : ''}`}
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
