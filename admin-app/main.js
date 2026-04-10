'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'ListaPranzo — Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Load from the Express backend so window.location.origin and WebSocket URLs
  // resolve to http://localhost:3000 correctly.
  function tryLoad(attempt) {
    win.loadURL('http://localhost:3000/admin').catch(() => {
      if (attempt < 30) setTimeout(() => tryLoad(attempt + 1), 500);
    });
  }
  tryLoad(0);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('copy-to-clipboard', (_event, text) => {
  clipboard.writeText(text);
  return true;
});
