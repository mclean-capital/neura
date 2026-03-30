import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('neuraDesktop', {
  saveConfig: (config: { xaiApiKey: string; googleApiKey: string; voice: string }) =>
    ipcRenderer.invoke('wizard:save-config', config),
  validateKey: (provider: string, key: string) =>
    ipcRenderer.invoke('wizard:validate-key', provider, key),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  startCore: () => ipcRenderer.invoke('core:start'),
  getScreenSources: () => ipcRenderer.invoke('desktop:get-sources'),
  setScreenSource: (sourceId: string) => ipcRenderer.invoke('desktop:set-screen-source', sourceId),
});
