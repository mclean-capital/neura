import type { ConnectionStatus } from '../hooks/useWebSocket.js';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <div className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABELS[status]}
    </div>
  );
}
