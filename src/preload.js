const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roundtable', {
  callLLM: (opts) => ipcRenderer.invoke('call-llm', opts),
  execInWebview: (webContentsId, script) =>
    ipcRenderer.invoke('exec-in-webview', webContentsId, script),
  insertText: (webContentsId, text) =>
    ipcRenderer.invoke('insert-text', webContentsId, text),
  sendEnter: (webContentsId) => ipcRenderer.invoke('send-enter', webContentsId),
  clickAt: (webContentsId, x, y) => ipcRenderer.invoke('click-at', webContentsId, x, y),

  // ===== 服务编排（本地 HTTP / agent 触发轮次）=====
  // main 进程触发一轮圆桌：{ requestId, question }
  onServiceAsk: (fn) => ipcRenderer.on('service:ask', (_e, data) => fn(data)),
  // renderer 上报进度 / 最终结果
  reportServiceProgress: (data) => ipcRenderer.send('service:progress', data),
  reportServiceResult: (data) => ipcRenderer.send('service:result', data),

  // ===== 历史记录（改进1，桌面端同步）=====
  saveHistory: (entry) => ipcRenderer.send('save-history', entry),
  getHistory: (q, limit) => ipcRenderer.invoke('get-history', q, limit),
  deleteHistory: (id) => ipcRenderer.invoke('delete-history', id),

  // ===== 关窗行为（退出程序 / 最小化到托盘常驻）=====
  setCloseMode: (mode) => ipcRenderer.send('set-close-mode', mode),
  // 关窗保护：本轮有进行中的轮次/总结时上报主进程
  setRoundActive: (active) => ipcRenderer.send('set-round-active', active),
  // 动态节流：参与轮次的面板关闭节流，空闲面板恢复
  setThrottling: (webContentsId, allowed) =>
    ipcRenderer.invoke('set-throttling', webContentsId, allowed),

  // ===== 输入框附件（随问题分发给各家）=====
  chooseAttachment: () => ipcRenderer.invoke('choose-attachment'),
  attachFile: (webContentsId, filePath, fileName, profile) =>
    ipcRenderer.invoke('attach-file', webContentsId, filePath, fileName, profile),

  // ===== 总结导出（Markdown / PDF，PDF 由主进程 HTML->printToPDF）=====
  exportSummary: (opts) => ipcRenderer.invoke('export-summary', opts),

  // ===== 网页总结附件（DeepSeek 第二账号）=====
  buildUploadFile: (markdown) => ipcRenderer.invoke('build-upload-file', markdown),
  setFileInput: (webContentsId, filePath) =>
    ipcRenderer.invoke('set-file-input', webContentsId, filePath),
});
