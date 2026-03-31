import type { Meta, StoryObj } from '@storybook/react';
import { MicButton } from './MicButton.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof MicButton> = {
  title: 'Components/MicButton',
  component: MicButton,
  args: { onToggle: fn() },
};

export default meta;
type Story = StoryObj<typeof MicButton>;

export const Idle: Story = { args: { isCapturing: false } };
export const Capturing: Story = { args: { isCapturing: true } };
export const Disabled: Story = { args: { isCapturing: false, disabled: true } };
