import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptPanel } from './TranscriptPanel.js';

const meta: Meta<typeof TranscriptPanel> = {
  title: 'Components/TranscriptPanel',
  component: TranscriptPanel,
  decorators: [
    (Story) => (
      <div style={{ height: 400, display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TranscriptPanel>;

export const Empty: Story = { args: { entries: [] } };

export const WithMessages: Story = {
  args: {
    entries: [
      { id: '1', type: 'user', text: 'What am I looking at?' },
      { id: '2', type: 'tool', text: 'describe_screen({ focus: "main content" })' },
      { id: '3', type: 'assistant', text: 'You have VS Code open with server.ts.' },
      { id: '4', type: 'user', text: 'Can you read the exact error?' },
      { id: '5', type: 'assistant', text: 'Property "port" does not exist on type "CoreConfig".' },
    ],
  },
};
