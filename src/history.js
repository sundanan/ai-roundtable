/**
 * 历史记录存储（改进1）。
 * 每轮圆桌结果追加到 userData/roundtable-history.json，最多保留 MAX_ENTRIES 条。
 * 供桌面端、飞书、Hermes skill 查询。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ENTRIES = 200;
let historyPath = null;

function getPath() {
  if (!historyPath) {
    historyPath = path.join(app.getPath('userData'), 'roundtable-history.json');
  }
  return historyPath;
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(getPath(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// entry: { id, ts, question, summary, summaryError, source, replies:[{id,name,state,text}] }
function saveRound(entry) {
  try {
    const list = load();
    list.push(entry);
    fs.writeFileSync(getPath(), JSON.stringify(list.slice(-MAX_ENTRIES)));
    return true;
  } catch (e) {
    console.error('[history] 保存失败:', e && e.message);
    return false;
  }
}

// 按问题关键词过滤，最新在前，返回前 limit 条
function query(keyword, limit) {
  let list = load();
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter((e) => (e.question || '').toLowerCase().includes(kw));
  }
  return list.slice().reverse().slice(0, limit || 10);
}

module.exports = { saveRound, query, getPath };
