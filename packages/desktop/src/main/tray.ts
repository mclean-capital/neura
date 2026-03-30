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

  const tray = new Tray(nativeImage.createFromPath(iconPath));

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
