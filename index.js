/**
 * whistle.figma-cache 插件入口
 *
 * 实现方式：只借用 whistle 的「规则钩子」，不接管请求、不做 MITM、不开独立端口。
 *
 *   请求阶段 (REQ_RULES / rulesServer)
 *       命中磁盘 → 返回 file://<body>        whistle 直接从本地回放，零网络
 *       未命中   → 返回 resWrite://<body>    whistle 照常回源，顺手把响应落盘
 *
 *   响应阶段 (RES_RULES / resRulesServer)
 *       把落盘意向转正成可命中的 meta 记录（校验状态码与响应头）
 *
 *   界面 (UI / uiServer)
 *       查看命中率、缓存条目，一键清空
 *
 * 全部能力都挂在插件自身的生命周期上：
 *   · 插件「启用」→ rules.txt 被加载、钩子进程启动，缓存生效
 *   · 插件「禁用」→ rules.txt 不再加载、进程被杀，能力立即失效
 *
 * 注：rules.txt 里的 `whistle.figma-cache://` 规则会把命中路径的请求登记到
 * req.whistlePlugins，whistle 随后就会调用上面的 REQ_RULES / RES_RULES 钩子。
 * 这也是为什么不需要改动 Figma 的代理设置、不影响系统代理。
 */

// 请求阶段：决定「用本地文件回放」还是「回源 + 落盘」
exports.rulesServer = require('./lib/rulesServer');

// 响应阶段：把落盘结果转正为缓存条目
exports.resRulesServer = require('./lib/resRulesServer');

// 界面：状态查看 / 清空缓存
exports.uiServer = require('./lib/uiServer');

// ─────────────────────────────────────────────────────────────────────────────
// 以下为早期尝试：想用 `server` hook（完全接管请求）实现，代码与测试都保留着，
// 但 whistle 2.10.10 不会把 URL 规则派发到 server hook，因此不导出。
// 若日后 whistle 修复了该派发，取消下面一行的注释即可启用。
//
// exports.server = require('./lib/server');
// ─────────────────────────────────────────────────────────────────────────────
