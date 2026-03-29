interface CameraToggleProps {
  isActive: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function CameraToggle({ isActive, onToggle, disabled }: CameraToggleProps) {
  return (
    <button
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full border font-sans text-[0.8rem] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-default ${
        isActive
          ? 'border-accent bg-accent-bg text-accent'
          : 'border-dark-border bg-dark-elevated text-dark-text hover:border-accent'
      }`}
      onClick={onToggle}
      disabled={disabled}
      aria-label={isActive ? 'Stop camera' : 'Start camera'}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
      </svg>
      <span>{isActive ? 'Camera On' : 'Camera'}</span>
    </button>
  );
}
