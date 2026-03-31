import type { Meta, StoryObj } from '@storybook/react';
import { CameraPreview } from './CameraPreview.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof CameraPreview> = {
  title: 'Components/CameraPreview',
  component: CameraPreview,
  args: { setVideoElement: fn() },
};

export default meta;
type Story = StoryObj<typeof CameraPreview>;

export const Active: Story = { args: { isActive: true } };
export const Inactive: Story = { args: { isActive: false } };
