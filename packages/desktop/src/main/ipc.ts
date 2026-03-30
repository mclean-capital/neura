import { app, desktopCapturer, ipcMain, shell } from 'electron';
import { getStore } from './store.js';

export function registerIpcHandlers() {
  const store = getStore();

  ipcMain.handle(
    'wizard:save-config',
    (
      _event: Electron.IpcMainInvokeEvent,
      config: { xaiApiKey: string; googleApiKey: string; voice: string }
    ) => {
      store.setApiKeys(config.xaiApiKey, config.googleApiKey);
      store.setVoice(config.voice);
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
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 160, height: 90 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('app:version', () => app.getVersion());
}
