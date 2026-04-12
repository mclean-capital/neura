import { app, desktopCapturer, ipcMain, shell } from 'electron';
import { getStore } from './store.js';

export function registerIpcHandlers() {
  const store = getStore();

  ipcMain.handle(
    'wizard:save-config',
    (_event: Electron.IpcMainInvokeEvent, config: Record<string, unknown>) => {
      // Extract API keys from v3 config format
      const providers = config.providers as Record<string, { apiKey?: string }> | undefined;
      const xaiKey = providers?.xai?.apiKey ?? '';
      const googleKey = providers?.google?.apiKey ?? '';
      store.setApiKeys(xaiKey, googleKey);

      // Extract voice from routing
      const routing = config.routing as Record<string, unknown> | undefined;
      const voice = routing?.voice as { voice?: string } | undefined;
      if (voice?.voice) store.setVoice(voice.voice);

      store.setSetupComplete(true);
      return { success: true };
    }
  );

  ipcMain.handle('wizard:validate-key', async (_event, provider: string, key: string) => {
    try {
      if (provider === 'xai') {
        const res = await fetch('https://api.x.ai/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        return { valid: res.ok };
      } else if (provider === 'google') {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': key },
        });
        return { valid: res.ok };
      }
      return { valid: false };
    } catch {
      return { valid: false, error: 'Network error' };
    }
  });

  ipcMain.handle('settings:get', () => ({
    voice: store.getVoice(),
    port: store.getPort(),
    hotkey: store.getHotkey(),
    launchAtStartup: store.getLaunchAtStartup(),
    startMinimized: store.getStartMinimized(),
    hasApiKeys: store.isSetupComplete(),
  }));

  ipcMain.handle(
    'shell:open-external',
    async (_event: Electron.IpcMainInvokeEvent, url: string) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          await shell.openExternal(parsed.toString());
        }
      } catch {
        // Silently ignore malformed URLs
      }
    }
  );

  ipcMain.handle('desktop:get-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 160, height: 90 },
      });

      if (sources.length === 0) {
        // macOS returns empty when screen recording permission is missing or stale
        const hint =
          process.platform === 'darwin'
            ? ' Go to System Settings > Privacy & Security > Screen Recording, toggle Neura off then on, then restart the app.'
            : '';
        throw new Error(`No screen sources available.${hint}`);
      }

      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      }));
    } catch (err) {
      if (err instanceof Error && err.message.includes('No screen sources')) throw err;
      const hint =
        process.platform === 'darwin'
          ? ' Check System Settings > Privacy & Security > Screen Recording and ensure Neura is enabled, then restart the app.'
          : '';
      throw new Error(`Failed to get screen sources.${hint}`, { cause: err });
    }
  });

  ipcMain.handle('app:version', () => app.getVersion());
}
