const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roundtable', {
  callLLM: (opts) => ipcRenderer.invoke('call-llm', opts),
  execInWebview: (webContentsId, script) =>
    ipcRenderer.invoke('exec-in-webview', webContentsId, script),
  insertText: (webContentsId, text) =>
    ipcRenderer.invoke('insert-text', webContentsId, text),
  sendEnter: (webContentsId) => ipcRenderer.invoke('send-enter', webContentsId),
  clickAt: (webContentsId, x, y) => ipcRenderer.invoke('click-at', webContentsId, x, y),

  // ===== 飞书服务编排（Phase 2）=====
  // main 进程触发一轮圆桌：{ requestId, question }
  onServiceAsk: (fn) => ipcRenderer.on('service:ask', (_e, data) => fn(data)),
  // renderer 上报进度 / 最终结果
  reportServiceProgress: (data) => ipcRenderer.send('service:progress', data),
  reportServiceResult: (data) => ipcRenderer.send('service:result', data),

  // ===== 历史记录（改进1，桌面端同步）=====
  saveHistory: (entry) => ipcRenderer.send('save-history', entry),
  getHistory: (q, limit) => ipcRenderer.invoke('get-history', q, limit),
});
