'use strict';

const { contextBridge } = require('electron');

// No privileged APIs needed for the client renderer.
contextBridge.exposeInMainWorld('electronAPI', {});
