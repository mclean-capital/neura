import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptMessage } from './TranscriptMessage.js';

const meta: Meta<typeof TranscriptMessage> = {
  title: 'Components/TranscriptMessage',
  component: TranscriptMessage,
};

export default meta;
type Story = StoryObj<typeof TranscriptMessage>;

export const User: Story = {
  args: { entry: { id: '1', type: 'user', text: 'What am I looking at on screen right now?' } },
};
export const Assistant: Story = {
  args: {
    entry: {
      id: '2',
      type: 'assistant',
      text: 'You have VS Code open with server.ts. There is a type error on line 47.',
    },
  },
};
export const Tool: Story = {
  args: {
    entry: { id: '3', type: 'tool', text: 'describe_screen({ focus: "error message" })' },
  },
};
export const System: Story = {
  args: { entry: { id: '4', type: 'system', text: 'Session closed' } },
};
