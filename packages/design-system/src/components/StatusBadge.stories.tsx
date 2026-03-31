import type { Meta, StoryObj } from '@storybook/react';
import { StatusBadge } from './StatusBadge.js';

const meta: Meta<typeof StatusBadge> = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  argTypes: {
    status: {
      control: 'select',
      options: ['connecting', 'connected', 'disconnected', 'error', 'failed'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Connected: Story = { args: { status: 'connected' } };
export const Connecting: Story = { args: { status: 'connecting' } };
export const Disconnected: Story = { args: { status: 'disconnected' } };
export const Error: Story = { args: { status: 'error' } };
export const Failed: Story = { args: { status: 'failed' } };
