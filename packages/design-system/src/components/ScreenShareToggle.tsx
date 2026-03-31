interface ScreenShareToggleProps {
  isActive: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ScreenShareToggle({ isActive, onToggle, disabled }: ScreenShareToggleProps) {
  return (
    <button
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-[0.8rem] cursor-pointer transition-all duration-200 disabled:opacity-40 disabled:cursor-default ${
        isActive
          ? 'border-accent bg-accent-bg text-accent'
          : 'border-dark-border bg-dark-elevated text-dark-text hover:border-accent'
      }`}
      onClick={onToggle}
      disabled={disabled}
      aria-label={isActive ? 'Stop screen share' : 'Start screen share'}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />
      </svg>
      <span>{isActive ? 'Sharing' : 'Screen'}</span>
    </button>
  );
}
