import type { Meta, StoryObj } from '@storybook/react';
import { ScreenPreview } from './ScreenPreview.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof ScreenPreview> = {
  title: 'Components/ScreenPreview',
  component: ScreenPreview,
  args: { setVideoElement: fn() },
};

export default meta;
type Story = StoryObj<typeof ScreenPreview>;

export const Active: Story = { args: { isActive: true } };
export const Inactive: Story = { args: { isActive: false } };
