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
// 内存缓存：单实例应用内只首次访问读盘；此前每次保存/查询都整文件
// load+parse（200 条上限约 6.7MB），轮次密集时纯属重复开销
let cache = null;

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

function ensureLoaded() {
  if (cache === null) cache = load();
  return cache;
}

// entry: { id, ts, question, summary, summaryError, source, replies:[{id,name,state,text}] }
function saveRound(entry) {
  try {
    const list = ensureLoaded();
    list.push(entry);
    if (list.length > MAX_ENTRIES) cache = list.slice(-MAX_ENTRIES);
    // 原子写（#2）：先写临时文件再 rename，避免写一半崩溃损坏历史文件
    const data = JSON.stringify(cache);
    const tmp = getPath() + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, getPath());
    return true;
  } catch (e) {
    console.error('[history] 保存失败:', e && e.message);
    return false;
  }
}

// 按问题关键词过滤，最新在前，返回前 limit 条（返回副本，调用方改动不影响缓存）
function query(keyword, limit) {
  let list = ensureLoaded().slice();
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter((e) => (e.question || '').toLowerCase().includes(kw));
  }
  return list.reverse().slice(0, limit || 10);
}

module.exports = { saveRound, query, getPath };
