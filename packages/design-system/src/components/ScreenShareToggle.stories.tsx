import type { Meta, StoryObj } from '@storybook/react';
import { ScreenShareToggle } from './ScreenShareToggle.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof ScreenShareToggle> = {
  title: 'Components/ScreenShareToggle',
  component: ScreenShareToggle,
  args: { onToggle: fn() },
};

export default meta;
type Story = StoryObj<typeof ScreenShareToggle>;

export const Inactive: Story = { args: { isActive: false } };
export const Active: Story = { args: { isActive: true } };
export const Disabled: Story = { args: { isActive: false, disabled: true } };
