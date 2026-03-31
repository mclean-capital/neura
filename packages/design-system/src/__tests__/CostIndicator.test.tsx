import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CostIndicator } from '../components/CostIndicator.js';
import type { CostUpdateMessage } from '@neura/shared';

afterEach(cleanup);

describe('CostIndicator', () => {
  it('renders nothing when cost is null', () => {
    const { container } = render(<CostIndicator cost={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders formatted duration and cost', () => {
    const cost: CostUpdateMessage = {
      type: 'costUpdate',
      sessionDurationMs: 61_000,
      estimatedCostUsd: 0.05,
      breakdown: { voice: 0.04, vision: 0.01 },
    };

    render(<CostIndicator cost={cost} />);

    expect(screen.getByText('1:01')).toBeInTheDocument();
    expect(screen.getByText('$0.05')).toBeInTheDocument();
  });

  it('shows <$0.01 for very small costs', () => {
    const cost: CostUpdateMessage = {
      type: 'costUpdate',
      sessionDurationMs: 5_000,
      estimatedCostUsd: 0.001,
      breakdown: { voice: 0.001, vision: 0 },
    };

    render(<CostIndicator cost={cost} />);

    expect(screen.getByText('<$0.01')).toBeInTheDocument();
  });

  it('shows 0:00 for zero duration', () => {
    const cost: CostUpdateMessage = {
      type: 'costUpdate',
      sessionDurationMs: 0,
      estimatedCostUsd: 0,
      breakdown: { voice: 0, vision: 0 },
    };

    render(<CostIndicator cost={cost} />);

    expect(screen.getByText('0:00')).toBeInTheDocument();
  });

  it('includes voice/vision breakdown in title', () => {
    const cost: CostUpdateMessage = {
      type: 'costUpdate',
      sessionDurationMs: 60_000,
      estimatedCostUsd: 0.55,
      breakdown: { voice: 0.5, vision: 0.05 },
    };

    render(<CostIndicator cost={cost} />);

    const wrapper = screen.getByTitle(/Voice:.*Vision:/);
    expect(wrapper).toBeInTheDocument();
    expect(wrapper.title).toContain('$0.50');
    expect(wrapper.title).toContain('$0.05');
  });
});
