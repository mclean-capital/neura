import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { dialog, app } from 'electron';

export function initUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: ${info.version}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Neura ${info.version} is ready to install.`,
        buttons: ['Restart Now', 'Later'],
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    // Network errors and missing release assets are expected when builds
    // haven't been uploaded yet — log without alarming the user
    const msg = err?.message ?? '';
    if (msg.includes('net::') || msg.includes('404') || msg.includes('ENOTFOUND')) {
      console.log('[updater] Update check skipped — release assets not available yet');
      return;
    }
    console.error('[updater] Error:', err);
  });

  void autoUpdater.checkForUpdatesAndNotify();
}
