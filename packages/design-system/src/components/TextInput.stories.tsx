import type { Meta, StoryObj } from '@storybook/react';
import { TextInput } from './TextInput.js';
import { fn } from '@storybook/test';

const meta: Meta<typeof TextInput> = {
  title: 'Components/TextInput',
  component: TextInput,
  args: { onSend: fn() },
};

export default meta;
type Story = StoryObj<typeof TextInput>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
