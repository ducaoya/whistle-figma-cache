'use strict';

/**
 * rulesServer hook —— 对应 whistle 的 REQ_RULES 钩子（请求阶段）
 *
 * whistle 在请求发出前会问我们一句：「这条请求你想加什么规则？」
 * 我们据此给出两种回答：
 *
 *   命中磁盘 →  file://<body 文件>                 让 whistle 直接从本地回放，零网络
 *   未命中   →  resWrite://<body 文件>             让 whistle 照常回源，顺手把响应落盘
 *   不该管   →  返回空字符串                       完全不受影响
 *
 * 这里返回的是「规则文本」，由 whistle 自己执行 —— 所以本插件不需要接管请求、
 * 不需要 MITM、不需要独立端口，生命周期天然跟随插件启停。
 *
 * 安全：任何异常都必须返回空字符串（放行），绝不阻断请求。
 */

const config = require('./config');
const policy = require('./policy');
const store = require('./store');
const revalidate = require('./revalidate');

/**
 * 取本次请求的真实 URL
 * whistle 的 setContext 会把 fullUrl / realUrl 挂在 req 上
 */
function fullUrlOf(req) {
  const oReq = req.originalReq || {};
  return oReq.realUrl || req.fullUrl || oReq.url || '';
}

function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

function reply(res, text) {
  const body = Buffer.from(text || '', 'utf8');
  try {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(body.length)
    });
  } catch (e) {
    /* ignore */
  }
  res.end(body);
}

/**
 * 命中：让 whistle 用本地文件直接回放。
 * 注意 `* ` 前缀：whistle 的插件钩子返回的是「完整规则行」，
 * 缺少匹配模式时会被当成 pattern 而不是操作符，规则不会生效。
 */
/**
 * 把存储下来的 Content-Type 映射成 whistle 的 resType 短名。
 * 必须显式指定：因为 whistle 的 file:// 是按「文件扩展名」猜 MIME 的，
 * 而 static.figma.com/uploads/<hash> 这类地址本身没有扩展名，会猜成 text/html。
 * resType 的值不能带空格（规则文本按空白分词），所以只能用它而不是 resHeaders。
 */
const RESTYPE_BY_CT = [
  [/javascript|ecmascript/i, 'js'],
  [/text\/css/i, 'css'],
  [/json/i, 'json'],
  [/html/i, 'html'],
  [/xml/i, 'xml']
];

function resTypeOf(contentType) {
  const ct = String(contentType || '');
  for (const [re, type] of RESTYPE_BY_CT) {
    if (re.test(ct)) {
      return type;
    }
  }
  return '';
}

function hitRule(dir, contentType) {
  const rt = resTypeOf(contentType);
  // 传目录（以 / 结尾），让 whistle 自己拼接剩余路径
  const parts = ['*', 'file://' + toSlash(dir) + '/'];
  if (rt) {
    parts.push('resType://' + rt);
  }
  // 关键：让 Chromium 也把这些资源存进它自己的缓存。
  // 否则响应没有 Cache-Control，Chromium 不会缓存 -> 也就不会生成 code cache，
  // 每次加载都要把几十 MB JS/WASM 重新解析编译一遍（实测 5 分钟重写 109MB WASM 缓存）。
  parts.push('cache://31536000');
  return parts.join(' ');
}

/**
 * 未命中：让 whistle 回源并把响应体写到指定文件。
 *
 * 注意两个规则前面的 `* `：whistle 的插件钩子返回的是「完整规则行」，
 * 形如 `模式 操作符://值`。单 token 的行会被当成 pattern（请求 URL 的匹配
 * 表达式）而不是操作符，规则会静默失效 —— 这是踩过的坑。
 * 这里只要一个通配模式就够了，因为插件规则只会合并进当前这一个请求。
 */
function missRule(dir) {
  // 同样传目录：whistle 会把 URL 的剩余路径接到后面
  return '* resWrite://' + toSlash(dir) + '/';
}

module.exports = (server) => {
  server.on('request', (req, res) => {
    let ruleText = '';

    try {
      const oReq = req.originalReq || {};
      const url = fullUrlOf(req);
      const cfg = config.resolveConfig(oReq.ruleValue);
      store.use(cfg);

      // ── 闸门 1：请求形态 ────────────────────────────────────────────
      const method = oReq.method || 'GET';
      const reqHeaders = oReq.headers || req.headers || {};
      if (!policy.isSafeRequest({ method, headers: reqHeaders })) {
        store.bump('bypass');
        return reply(res, '');
      }

      // ── 闸门 2：URL 白名单 ─────────────────────────────────────────
      const verdict = policy.checkUrl(url);
      if (!verdict.ok) {
        store.bump('bypass');
        config.log(cfg, 'BYPASS(%s)  %s', verdict.reason, url);
        return reply(res, '');
      }

      const key = store.keyOf(url);

      // ── 命中 ───────────────────────────────────────────────────────
      const hit = store.lookup(key, url, cfg);
      if (hit) {
        // 后台静默校验（非阻塞、有冷却期约束）；任何失败都不影响本次响应
        try {
          revalidate.schedule(key, url, hit.meta, cfg);
        } catch (e) {
          /* ignore */
        }
        config.log(cfg, 'HIT   %s KB  %s', Math.round(hit.size / 1024), url);
        return reply(res, hitRule(hit.dir, hit.meta && hit.meta.contentType));
      }

      // ── 未命中：登记落盘意向，让 whistle 回源并顺手写盘 ─────────────
      store.bump('miss');
      const pending = store.beginPending(key, url, cfg);
      config.log(cfg, 'MISS  %s', url);
      return reply(res, missRule(pending.dir));
    } catch (e) {
      // 出任何问题都放行，绝不阻断
      return reply(res, ruleText);
    }
  });
};
