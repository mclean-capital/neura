import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../components/StatusBadge.js';
import type { ConnectionStatus } from '../types/index.js';

describe('StatusBadge', () => {
  const cases: [ConnectionStatus, string][] = [
    ['connecting', 'Connecting…'],
    ['connected', 'Connected'],
    ['disconnected', 'Disconnected'],
    ['error', 'Error'],
    ['failed', 'Core Unavailable'],
  ];

  it.each(cases)('renders "%s" as "%s"', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
