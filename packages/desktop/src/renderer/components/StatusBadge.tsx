import type { ConnectionStatus } from '../hooks/useWebSocket.js';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
  failed: 'Core Unavailable',
};

const STATUS_STYLES: Record<ConnectionStatus, { badge: string; dot: string }> = {
  connecting: { badge: 'border-yellow-400 text-yellow-400', dot: 'bg-yellow-400' },
  connected: { badge: 'border-green-500 text-green-500', dot: 'bg-green-500' },
  disconnected: { badge: 'border-dark-border text-dark-muted', dot: 'bg-dark-muted' },
  error: { badge: 'border-red-400 text-red-400', dot: 'bg-red-400' },
  failed: { badge: 'border-red-400 text-red-400', dot: 'bg-red-400' },
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
