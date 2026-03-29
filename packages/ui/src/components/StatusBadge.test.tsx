import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge.js';
import type { ConnectionStatus } from '../hooks/useWebSocket.js';

describe('StatusBadge', () => {
  const cases: [ConnectionStatus, string][] = [
    ['connecting', 'Connecting…'],
    ['connected', 'Connected'],
    ['disconnected', 'Disconnected'],
    ['error', 'Error'],
  ];

  it.each(cases)('renders "%s" as "%s"', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
