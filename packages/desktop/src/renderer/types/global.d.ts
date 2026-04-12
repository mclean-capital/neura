export {};

declare global {
  interface Window {
    neuraDesktop: {
      saveConfig: (config: Record<string, unknown>) => Promise<{ success: boolean }>;
      validateKey: (provider: string, key: string) => Promise<{ valid: boolean; error?: string }>;
      openExternal: (url: string) => Promise<void>;
      getSettings: () => Promise<{
        voice: string;
        port: number;
        hotkey: string;
        launchAtStartup: boolean;
        startMinimized: boolean;
        hasApiKeys: boolean;
      }>;
      getAppVersion: () => Promise<string>;
      getScreenSources: () => Promise<{ id: string; name: string; thumbnail: string }[]>;
      setScreenSource: (sourceId: string) => Promise<void>;
      startCore: () => Promise<{ success: boolean; error?: string }>;
    };
  }
}
