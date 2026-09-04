/* global ADAPTERS, roundtable */
/**
 * 应用入口（装配启动）。
 *
 * 渲染层模块划分（index.html 按依赖顺序加载，经典脚本共享全局词法作用域）：
 *   js/core.js    引擎核心（平台无关）：注入脚本构建器、发送三段降级、
 *                 回复清洗/判稳纯函数、错误分类、Markdown 渲染、执行通道
 *   js/panels.js  面板与视觉状态：webview/模型按钮/回复行构建、状态灯、
 *                 参与选择、行展开、总结者面板重建
 *   js/engine.js  轮次生命周期：广播/轮询/补发/停止/进度/服务编排
 *   js/summary.js 总结与导出：五段模板、网页/API 两路、附件上传、TOC、导出
 *   js/ui.js      设置/主题/历史/引导/分隔条/输入框行为
 *   app.js        本文件：启动装配
 */
applySelection();
syncPromptPlaceholder();
syncSendStopButton(false);
// 关窗行为启动同步：把存储的设置（退出程序/最小化到托盘）告知主进程，
// 主进程据此决定关窗即退出还是创建托盘常驻
applyCloseMode();
