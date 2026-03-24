const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDashboardData: () => ipcRenderer.invoke('get-dashboard-data'),
  fetchPlanUsage: () => ipcRenderer.invoke('fetch-plan-usage'),
  openConsoleLogin: () => ipcRenderer.invoke('open-console-login'),
  openConsole: (url) => ipcRenderer.invoke('open-console', url),
  openExternal: (url) => shell.openExternal(url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkNotifications: (data) => ipcRenderer.invoke('check-notifications', data),
  setRefreshInterval: (ms) => ipcRenderer.invoke('set-refresh-interval', ms),
  getRefreshInterval: () => ipcRenderer.invoke('get-refresh-interval'),
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (_, theme) => callback(theme));
  },
});
