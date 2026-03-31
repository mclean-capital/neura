import type { Preview } from '@storybook/react';
import '../src/tokens/base.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Neura color theme',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'light', title: 'Light', icon: 'sun' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals.theme as string) ?? 'dark';
      return (
        <div
          data-theme={theme}
          style={{
            background: theme === 'light' ? '#F5F2E8' : '#0A0A0A',
            padding: '2rem',
            minHeight: '100%',
          }}
        >
          <Story />
        </div>
      );
    },
  ],
  parameters: {
    backgrounds: { disable: true },
    layout: 'centered',
  },
};

export default preview;
