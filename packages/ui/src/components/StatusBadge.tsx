import type { ConnectionStatus } from '../hooks/useWebSocket.js';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

const STATUS_STYLES: Record<ConnectionStatus, { badge: string; dot: string }> = {
  connecting: { badge: 'border-accent text-accent', dot: 'bg-accent' },
  connected: { badge: 'border-session-green text-session-green', dot: 'bg-session-green' },
  disconnected: { badge: 'border-dark-border text-dark-muted-light', dot: 'bg-dark-muted-light' },
  error: { badge: 'border-signal-danger text-signal-danger', dot: 'bg-signal-danger' },
};

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  const styles = STATUS_STYLES[status];
  return (
    <div
      className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-dark-surface border ${styles.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
      {STATUS_LABELS[status]}
    </div>
  );
}
