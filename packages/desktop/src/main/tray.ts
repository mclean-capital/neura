import { Tray, Menu, nativeImage, app, dialog, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { isQuitting, setQuitting } from './app-state.js';
import { getStore } from './store.js';

export function createTray(mainWindow: BrowserWindow): Tray {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'tray-icon.png')
    : path.join(__dirname, '..', 'assets', 'tray-icon.png');

  if (!fs.existsSync(iconPath)) {
    console.warn(`[tray] Icon not found at ${iconPath} — tray may be invisible`);
  }

  let icon = nativeImage.createFromPath(iconPath);

  if (process.platform === 'darwin') {
    // macOS menu bar: resize to 18x18pt (standard size) and mark as template
    // so the system applies proper light/dark styling
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }

  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Neura', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'Reset API Keys...',
      click: () => {
        void dialog
          .showMessageBox(mainWindow, {
            type: 'question',
            title: 'Reset API Keys',
            message: 'This will clear your saved API keys and show the setup wizard. Continue?',
            buttons: ['Reset', 'Cancel'],
            defaultId: 1,
          })
          .then((result) => {
            if (result.response === 0) {
              const store = getStore();
              store.setApiKeys('', '');
              store.setSetupComplete(false);
              mainWindow.show();
              mainWindow.webContents.reload();
            }
          });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        setQuitting(true);
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Neura');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  // Minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return tray;
}
