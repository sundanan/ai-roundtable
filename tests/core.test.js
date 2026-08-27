/**
 * 引擎核心纯函数单元测试（Node 内置 test runner，零依赖）。
 * 运行：npm test   （即 node --test tests/）
 * 用例大多源自 docs/交付说明.md「已修复的关键坑」——把历史事故固化为回归断言。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normText,
  cleanReply,
  renderMarkdown,
  buildPrepareScript,
  buildFillScript,
  buildClickSendScript,
  buildSendRectScript,
  buildVerifySentScript,
  buildScrapeScript,
  detectErrorCategory,
} = require('../src/renderer/js/core.js');

// ---------- normText：回音比对的归一化 ----------
test('normText 去空白与标点', () => {
  assert.strictEqual(normText('你 好，世 界！'), '你好世界');
  assert.strictEqual(normText(' \u00a0\u200b '), '');
  assert.strictEqual(normText('1+1=2？'), '112');
});

// ---------- cleanReply：回复清洗 ----------
test('噪声标签判空（坑：文心把「通知/深度思考」当交卷）', () => {
  assert.strictEqual(cleanReply('深度思考'), '');
  assert.strictEqual(cleanReply('通知'), '');
  assert.strictEqual(cleanReply('生成中'), '');
});

test('短回复保留（坑：≤20 字有效回答曾被跳过）', () => {
  assert.strictEqual(cleanReply('2'), '2');
  assert.strictEqual(cleanReply('2 啊 😄'), '2 啊 😄');
});

test('截断「猜你想问」类推荐区块', () => {
  assert.strictEqual(cleanReply('答案正文第一行\n猜你想问\n问题A\n问题B'), '答案正文第一行');
  assert.strictEqual(cleanReply('正文\n相关问题\nX'), '正文');
});

test('剥离尾部按钮文字', () => {
  assert.strictEqual(cleanReply('正文内容\n复制\n分享\n重新生成'), '正文内容');
  assert.strictEqual(cleanReply('正文内容\n\n\n'), '正文内容');
});

test('剔除首行问题回音（坑：回音混进总结附录）', () => {
  assert.strictEqual(cleanReply('用一句话介绍杭州', '用一句话介绍杭州'), '');
  assert.strictEqual(
    cleanReply('用一句话介绍杭州\n杭州是浙江省省会。', '用一句话介绍杭州'),
    '杭州是浙江省省会。'
  );
  // 回音被站点重新排版（加标点/空格）后仍能按归一化剔除
  assert.strictEqual(
    cleanReply('用 一 句 话 介 绍 杭 州！\n杭州是浙江省省会。', '用一句话介绍杭州'),
    '杭州是浙江省省会。'
  );
  // 答案比问题长得多（含问题开头的正常正文）不应被误删
  const long = '1+1等于几？这是一道非常基础的算术题，答案是 2。';
  assert.strictEqual(cleanReply(long, '1+1等于几'), long);
});

test('空输入返回空串', () => {
  assert.strictEqual(cleanReply(''), '');
  assert.strictEqual(cleanReply(undefined), '');
});

// ---------- renderMarkdown：轻量渲染（含 XSS 转义） ----------
test('HTML 转义：模型输出的标签不会被当成 HTML 执行', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('行内加粗与代码', () => {
  assert.ok(renderMarkdown('**重要**').includes('<strong>重要</strong>'));
  assert.ok(renderMarkdown('`x=1`').includes('<code>x=1</code>'));
});

test('标题层级：#/中文一级/中文二级/家名/附录', () => {
  assert.ok(renderMarkdown('# 标题').includes('<h1>标题</h1>'));
  assert.ok(renderMarkdown('一、主要共识').includes('<h2 class="lv1">'));
  assert.ok(renderMarkdown('（一）小节').includes('<h3 class="lv2">'));
  assert.ok(renderMarkdown('【千问】').includes('<h3 class="family">'));
  assert.ok(renderMarkdown('附录：各家意见（原文）').includes('<h2 class="appendix">'));
});

test('表格：表头 th、分隔行跳过、单元格含内竖线时转义（坑：表格拍平）', () => {
  const html = renderMarkdown('| 家 | 立场 |\n| --- | --- |\n| 千问 | 支持 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>家</th>'));
  assert.ok(html.includes('<td>千问</td>'));
  assert.strictEqual((html.match(/<tr>/g) || []).length, 2);
});

test('有序/无序列表', () => {
  assert.ok(renderMarkdown('- 甲\n- 乙').includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(renderMarkdown('1. 甲\n2. 乙').includes('<ol><li>甲</li><li>乙</li></ol>'));
});

// ---------- 注入脚本构建器：内容正确 + 语法可编译 ----------
const ADAPTER = {
  inputSelectors: ['textarea[data-x]'],
  sendSelectors: ['[data-testid="send-button"]'],
  responseSelectors: ['.qk-markdown'],
  watchStop: true,
  pruneSelectors: ['.thinking-block'],
  strictResponse: true,
};

// new Function 仅编译不执行：注入脚本是字符串拼出来的，语法坏了必须在这里炸
function assertCompiles(code) {
  assert.doesNotThrow(() => new Function(code), '生成的注入脚本语法错误');
}

test('buildPrepareScript/FillScript 内容与语法', () => {
  const prep = buildPrepareScript(ADAPTER);
  assertCompiles(prep);
  assert.ok(prep.includes('textarea[data-x]'));
  assert.ok(prep.includes('找不到输入框'));
  const fill = buildFillScript('你好');
  assertCompiles(fill);
  assert.ok(fill.includes('你好'));
});

test('buildClickSendScript/RectScript：含 MiniMax 实测的通用兜底', () => {
  const click = buildClickSendScript(ADAPTER);
  assertCompiles(click);
  // 适配器专属选择器经 JSON.stringify 注入（引号被转义），查无引号子串
  assert.ok(click.includes('send-button'));
  assert.ok(click.includes('[data-testid*="send" i]')); // 2026-08-27 实测新增的非 button 兜底
  const rect = buildSendRectScript(ADAPTER);
  assertCompiles(rect);
  assert.ok(rect.includes('send-button'));
});

test('buildVerifySentScript：输入框清空即发送成功', () => {
  const v = buildVerifySentScript(ADAPTER);
  assertCompiles(v);
  assert.ok(v.includes('sent'));
});

test('buildScrapeScript：判稳/剪枝/回音/watchStop/strict 全部进脚本', () => {
  const s = buildScrapeScript(ADAPTER, '问题原文');
  assertCompiles(s);
  assert.ok(s.includes('"watchStop":true'));
  assert.ok(s.includes('"strict":true'));
  assert.ok(s.includes('.thinking-block')); // pruneSelectors 注入
  assert.ok(s.includes('.qk-markdown'));
  assert.ok(s.includes('问题原文'));
  assert.ok(s.includes('stopVisible')); // 2026-08-27 智谱长思考修复的判据
  assert.ok(s.includes('未抓取到回复内容'));
  // watchStop=false 时不应带停止按钮判据调用
  const s2 = buildScrapeScript({ ...ADAPTER, watchStop: false }, 'q');
  assert.ok(s2.includes('"watchStop":false'));
});

// ---------- detectErrorCategory：错误分级 ----------
// stub webview：getWebContentsId 抛错 → execInPanel 走 reject → 探测跳过
const STUB = { webview: { getWebContentsId() { throw new Error('no guest'); } } };

test('风控关键词直判 risk（不触发页面探测）', async () => {
  assert.strictEqual(await detectErrorCategory(STUB, '页面停在登录'), 'risk');
  assert.strictEqual(await detectErrorCategory(STUB, '站点触发滑块验证'), 'risk');
});

test('超时文案归 timeout，其余归 sendfail', async () => {
  assert.strictEqual(await detectErrorCategory(STUB, '未取到本轮回复'), 'timeout');
  assert.strictEqual(await detectErrorCategory(STUB, '抓取超时'), 'timeout');
  assert.strictEqual(await detectErrorCategory(STUB, '注入失败'), 'sendfail');
});
