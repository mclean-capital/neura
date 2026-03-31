import type { Meta, StoryObj } from '@storybook/react';
import { CameraToggle } from './CameraToggle.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof CameraToggle> = {
  title: 'Components/CameraToggle',
  component: CameraToggle,
  args: { onToggle: fn() },
};

export default meta;
type Story = StoryObj<typeof CameraToggle>;

export const Inactive: Story = { args: { isActive: false } };
export const Active: Story = { args: { isActive: true } };
export const Disabled: Story = { args: { isActive: false, disabled: true } };
