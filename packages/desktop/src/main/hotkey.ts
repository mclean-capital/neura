import { app, globalShortcut, type BrowserWindow } from 'electron';
import { getStore } from './store.js';

export function registerHotkey(mainWindow: BrowserWindow) {
  const hotkey = getStore().getHotkey();

  const registered = globalShortcut.register(hotkey, () => {
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  if (!registered) {
    console.warn(`[hotkey] Failed to register global shortcut: ${hotkey}`);
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
