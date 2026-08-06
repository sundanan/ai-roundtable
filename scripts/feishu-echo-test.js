/**
 * Phase 1 · 回声测试
 * 验证飞书长连接 + 凭证是否可用：
 *   私聊机器人（或群里 @ 它）发任意文本，机器人原样回一句 "回声：<原文>"。
 *
 * 运行：node scripts/feishu-echo-test.js
 * 退出：Ctrl+C
 */
require('dotenv').config();
const { Client, WSClient, EventDispatcher, LoggerLevel } = require('@larksuiteoapi/node-sdk');

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env');
  process.exit(1);
}

// 用于发消息/回复的普通客户端
const client = new Client({ appId, appSecret, loggerLevel: LoggerLevel.warn });

// 长连接客户端
const wsClient = new WSClient({
  appId,
  appSecret,
  loggerLevel: LoggerLevel.info,
  autoReconnect: true,
  onReady: () => console.log('✅ 长连接已就绪（onReady），可以发消息测试了'),
  onError: (err) => console.error('❌ 长连接错误（onError）:', err && err.message),
  onReconnecting: () => console.log('⚠️ 连接断开，正在重连…'),
  onReconnected: () => console.log('✅ 已重新连接'),
});

async function replyEcho(message) {
  const { message_id, chat_id, chat_type, message_type, content } = message;
  if (message_type !== 'text') {
    console.log(`[跳过] 非文本消息类型: ${message_type}`);
    return;
  }
  let text = '';
  try {
    text = JSON.parse(content || '{}').text || '';
  } catch {
    text = String(content);
  }
  console.log(`[收到] chat=${chat_id}(${chat_type}) 文本="${text}"`);

  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chat_id,
        msg_type: 'text',
        content: JSON.stringify({ text: `回声：${text}` }),
      },
    });
    console.log('[已回复]');
  } catch (e) {
    console.error('[回复失败]', e && e.message, e && e.code);
  }
}

wsClient
  .start({
    eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
      'im.message.receive_v1': async (data) => {
        try {
          await replyEcho(data.message || {});
        } catch (e) {
          console.error('[处理消息异常]', e);
        }
      },
    }),
  })
  .then(() => {
    console.log('长连接已启动，等待消息…（Ctrl+C 退出）');
  })
  .catch((e) => {
    console.error('启动长连接失败:', e && e.message);
    process.exit(1);
  });

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  try {
    wsClient.close({ force: true });
  } catch {}
  process.exit(0);
});
