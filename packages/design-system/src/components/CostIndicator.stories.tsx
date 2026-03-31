import type { Meta, StoryObj } from '@storybook/react';
import { CostIndicator } from './CostIndicator.js';
import type { CostUpdateMessage } from '@neura/types';

const meta: Meta<typeof CostIndicator> = {
  title: 'Components/CostIndicator',
  component: CostIndicator,
};

export default meta;
type Story = StoryObj<typeof CostIndicator>;

const baseCost: CostUpdateMessage = {
  type: 'costUpdate',
  sessionDurationMs: 272_000,
  estimatedCostUsd: 0.12,
  breakdown: { voice: 0.08, vision: 0.04 },
};

export const WithCost: Story = { args: { cost: baseCost } };
export const NoCost: Story = { args: { cost: null } };
export const SmallCost: Story = {
  args: {
    cost: { ...baseCost, sessionDurationMs: 5_000, estimatedCostUsd: 0.001 },
  },
};
