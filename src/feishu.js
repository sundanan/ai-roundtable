/**
 * 飞书桥接模块（Phase 2）。
 * - 长连接接收消息（无需公网回调）
 * - 暴露 sendText 供 main 进程回发结果
 * 凭证从环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 读取（main.js 顶部加载 .env）。
 */
const { Client, WSClient, EventDispatcher, LoggerLevel } = require('@larksuiteoapi/node-sdk');

function createFeishuBridge({ onQuestion, onState }) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env');
  }

  const client = new Client({ appId, appSecret, loggerLevel: LoggerLevel.warn });
  const wsClient = new WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    loggerLevel: LoggerLevel.warn,
    onReady: () => onState && onState('ready'),
    onError: (err) => onState && onState('error', err),
    onReconnecting: () => onState && onState('reconnecting'),
    onReconnected: () => onState && onState('reconnected'),
  });

  async function start() {
    await wsClient.start({
      eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
        'im.message.receive_v1': async (data) => {
          const msg = data.message || {};
          if (msg.message_type !== 'text') return; // 首期只处理文本
          let text = '';
          try {
            text = JSON.parse(msg.content || '{}').text || '';
          } catch {
            text = String(msg.content || '');
          }
          text = text.trim();
          if (!text) return;
          onQuestion({ requestId: msg.message_id, question: text, chatId: msg.chat_id });
        },
      }),
    });
  }

  async function sendText(chatId, text) {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  // 发送文件消息（总结 docx 用）：先上传拿 file_key，再发 file 消息。
  // 需要应用具备 im:resource 与发消息权限；失败由调用方回退纯文本
  async function sendFile(chatId, filePath) {
    const fs = require('fs');
    const path = require('path');
    const up = await client.im.file.create({
      data: {
        file_type: 'doc',
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath),
      },
    });
    const fileKey = (up && up.file_key) || (up && up.data && up.data.file_key);
    if (!fileKey) throw new Error('文件上传未返回 file_key');
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  function stop() {
    try {
      wsClient.close({ force: true });
    } catch {}
  }

  return { start, sendText, sendFile, stop };
}

module.exports = { createFeishuBridge };
