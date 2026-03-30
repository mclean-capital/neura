import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } from 'electron';
import path from 'path';
import { createCoreManager } from './core-manager.js';
import { createUIServer } from './ui-server.js';
import { createTray } from './tray.js';
import { registerHotkey } from './hotkey.js';
import { initUpdater } from './updater.js';
import { getStore } from './store.js';
import { registerIpcHandlers } from './ipc.js';
import { setQuitting } from './app-state.js';

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

function createMainWindow(url: string): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0a',
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

    // Handle screen share — renderer sends selected source ID via IPC before calling getDisplayMedia
    let pendingSourceId: string | null = null;
    let pendingSourceTimeout: ReturnType<typeof setTimeout> | undefined;
    ipcMain.handle(
      'desktop:set-screen-source',
      (_event: Electron.IpcMainInvokeEvent, sourceId: string | null) => {
        clearTimeout(pendingSourceTimeout);
        if (sourceId) {
          pendingSourceId = sourceId;
          // 30s timeout — generous for slow pickers, auto-clears if getDisplayMedia never fires
          pendingSourceTimeout = setTimeout(() => {
            pendingSourceId = null;
          }, 30_000);
        } else {
          // null sourceId means picker was cancelled — clear immediately
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

    const appStore = getStore();

    // NEURA_DESKTOP_DEV is set by scripts/dev.ts — more reliable than app.isPackaged
    // which can misdetect when running `electron dist-main/index.mjs`
    const isDev = process.env.NEURA_DESKTOP_DEV === 'true' || !app.isPackaged;
    let coreManager: ReturnType<typeof createCoreManager> | null = null;
    let uiServer: ReturnType<typeof createUIServer> | null = null;
    let rendererUrl: string;

    async function startCore(): Promise<void> {
      if (coreManager?.isRunning()) return;
      const corePort = appStore.getPort();
      const apiKeys = appStore.getApiKeys();
      coreManager = createCoreManager({
        port: corePort,
        env: apiKeys,
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
    }

    // IPC: renderer calls this after wizard completes to start core
    ipcMain.handle('core:start', async () => {
      if (isDev) return { success: true }; // dev.ts already manages core
      try {
        await startCore();
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

      uiServer = createUIServer({ corePort: appStore.getPort() });
      const uiPort = await uiServer.start();
      rendererUrl = `http://127.0.0.1:${uiPort}`;
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
