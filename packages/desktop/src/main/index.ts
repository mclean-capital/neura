import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  session,
} from 'electron';
import path from 'path';
import { CoreManager } from './core-manager.js';
import { UIServer } from './ui-server.js';
import { createTray } from './tray.js';
import { registerHotkey } from './hotkey.js';
import { initUpdater } from './updater.js';
import { getStore } from './store.js';
import { registerIpcHandlers } from './ipc.js';
import { setQuitting } from './app-state.js';

// Set app name (without this, dev mode shows "Electron" in dock/tooltips)
app.name = 'Neura';

// Suppress noisy Chromium WGC frame capture warnings
app.commandLine.appendSwitch('log-level', '3');

// Single instance lock — exit immediately if another instance is running
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// __dirname resolves to dist-main/ (one level below package root)
function getPreloadPath(): string {
  return path.join(__dirname, '..', 'dist-preload', 'index.cjs');
}

function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(__dirname, '..', 'assets', 'icon.png');
}

function createMainWindow(url: string): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0a',
    icon: nativeImage.createFromPath(getAppIconPath()),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const }
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#e8e4de', height: 32 } }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox defaults to true since Electron 20 when nodeIntegration is false.
      // Only affects the renderer — main process child_process is unaffected.
    },
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(url);
  return win;
}

app.on('ready', () => {
  void (async () => {
    // Set dock icon on macOS (without this, dev mode shows default Electron icon)
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = getAppIconPath();
      const iconImage = nativeImage.createFromPath(iconPath);
      if (!iconImage.isEmpty()) {
        app.dock.setIcon(iconImage);
      }
    }

    registerIpcHandlers();

    // Grant permissions for microphone, camera, and screen capture
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = ['media', 'microphone', 'camera', 'screen'];
      callback(allowed.includes(permission));
    });

    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      const allowed = ['media', 'microphone', 'camera', 'screen'];
      return allowed.includes(permission);
    });

    // Handle screen share
    const isMacOS = process.platform === 'darwin';

    if (isMacOS) {
      // macOS: use system picker — reliable on Sequoia, no desktopCapturer needed
      session.defaultSession.setDisplayMediaRequestHandler(
        (_request, callback) => {
          // With useSystemPicker, the OS handles source selection.
          // Pass empty object — Electron + system picker fills in the source.
          callback({});
        },
        { useSystemPicker: true }
      );
    } else {
      // Windows/Linux: use custom picker via IPC (useSystemPicker has issues on Windows)
      let pendingSourceId: string | null = null;
      let pendingSourceTimeout: ReturnType<typeof setTimeout> | undefined;
      ipcMain.handle(
        'desktop:set-screen-source',
        (_event: Electron.IpcMainInvokeEvent, sourceId: string | null) => {
          clearTimeout(pendingSourceTimeout);
          if (sourceId) {
            pendingSourceId = sourceId;
            pendingSourceTimeout = setTimeout(() => {
              pendingSourceId = null;
            }, 30_000);
          } else {
            pendingSourceId = null;
          }
        }
      );

      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        if (pendingSourceId) {
          void desktopCapturer
            .getSources({ types: ['screen', 'window'] })
            .then((sources) => {
              const selected = sources.find((s) => s.id === pendingSourceId);
              pendingSourceId = null;
              if (selected) {
                callback({ video: selected, audio: 'loopback' });
              } else {
                callback({});
              }
            })
            .catch(() => {
              pendingSourceId = null;
              callback({});
            });
        } else {
          callback({});
        }
      });
    }

    const appStore = getStore();
    const authToken = appStore.getAuthToken();

    // NEURA_DESKTOP_DEV is set by scripts/dev.ts — more reliable than app.isPackaged
    // which can misdetect when running `electron dist-main/index.mjs`
    const isDev = process.env.NEURA_DESKTOP_DEV === 'true' || !app.isPackaged;
    let coreManager: CoreManager | null = null;
    let corePort = appStore.getPort();
    let uiServer: UIServer | null = null;
    let rendererUrl = `http://127.0.0.1:${corePort}`;

    async function startCore(): Promise<void> {
      if (coreManager?.isRunning()) return;
      const apiKeys = appStore.getApiKeys();
      coreManager = new CoreManager({
        port: corePort,
        env: apiKeys,
        authToken,
        onCrash: (code) => {
          const logPath = path.join(app.getPath('userData'), 'logs', 'core.log');
          void dialog
            .showMessageBox({
              type: 'error',
              title: 'Core Server Crashed',
              message: `The Neura core server exited unexpectedly (code ${String(code)}).\n\nLogs: ${logPath}`,
              buttons: ['Quit'],
            })
            .then(() => app.quit());
        },
      });
      await coreManager.start();
      corePort = coreManager.getPort();
    }

    async function startUIServer(): Promise<void> {
      if (uiServer) return;
      uiServer = new UIServer({ corePort, authToken });
      const uiPort = await uiServer.start();
      rendererUrl = `http://127.0.0.1:${uiPort}`;
    }

    // IPC: renderer calls this after wizard completes to start core
    ipcMain.handle('core:start', async () => {
      if (isDev) return { success: true }; // dev.ts already manages core
      try {
        await startCore();
        await startUIServer();
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to start core',
        };
      }
    });

    if (isDev) {
      // Dev: renderer and core dev servers are already running
      rendererUrl = 'http://localhost:5174';
    } else {
      // Production: start core if keys are available, serve renderer
      if (appStore.isSetupComplete()) {
        try {
          await startCore();
        } catch (err) {
          void dialog.showMessageBox({
            type: 'error',
            title: 'Failed to Start',
            message: `Core server failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`,
            buttons: ['OK'],
          });
        }
      }

      try {
        await startUIServer();
      } catch (err) {
        void dialog.showMessageBox({
          type: 'error',
          title: 'Failed to Start',
          message: `UI server failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`,
          buttons: ['OK'],
        });
      }
    }

    const mainWindow = createMainWindow(rendererUrl);

    createTray(mainWindow);
    registerHotkey(mainWindow);
    initUpdater();

    app.on('second-instance', () => {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });

    app.on('before-quit', () => {
      setQuitting(true);
      coreManager?.stopSync();
      uiServer?.stop();
    });
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
