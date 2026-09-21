'use strict';

/**
 * 缓存准入策略 —— 本插件的【安全核心】
 *
 * 设计原则：
 *   1. 白名单，不是黑名单。只有明确认定「内容哈希命名、永远不可变」的
 *      URL 才允许进入缓存，其余一律放行给 Whistle 原生流程。
 *   2. 这是一道独立于 rules.txt 的第二道闸门。即使规则被误改成
 *      www.figma.com/ 这种宽匹配，只要 URL 不满足白名单，也不会被缓存。
 *   3. 涉及画布 / 文件内容 / 接口 / 签名地址的请求，一律硬性拒绝。
 *
 * 【绝对不能缓存的东西】
 *   · 画布与文件数据：/file/、/design/、/board/、/proto/、/multiplayer
 *   · 接口：/api/、/graphql
 *   · 用户内容素材：s3-alpha.figma.com、s3-alpha-sig.figma.com、*.amazonaws.com
 *   · 带查询串的地址（签名 token、缓存破坏参数）
 *   · 非 GET 请求、WebSocket 升级请求
 *   · 非 200 响应、带 Set-Cookie 的响应、Cache-Control 含 no-store/private
 */

// ── 可缓存白名单 ───────────────────────────────────────────────────────────
// host 必须精确匹配，path 必须满足「文件名内含足够长的十六进制哈希」
const ALLOW = [
  {
    name: 'figma-editor-bundle',
    // 例：/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br
    //     /webpack-artifacts/assets/3866-6a39a297e15317ca.min.js.br
    host: /^(?:www\.)?figma\.com$/i,
    path: /^\/webpack-artifacts\/assets\/[A-Za-z0-9._$-]+-[0-9a-f]{8,}\.(?:min\.)?(?:js|mjs|css|json|wasm)(?:\.(?:br|gz))?$/i
  },
  {
    name: 'figma-static-cdn',
    // 仅放行已验证存在的 /uploads/<内容哈希> 路径。
    // 例：/uploads/<40 位内容哈希>，响应头 cache-control: max-age=31536000
    //
    // 如需放行其它路径（如 /fonts/、/fullscreen/），请先用下面命令确认
    // 该路径确实带长缓存头且文件名含内容哈希，再往这里加：
    //   curl -sSI https://static.figma.com/xxx | grep -i cache-control
    host: /^static\.figma\.com$/i,
    path: /^\/uploads\/[0-9a-f]{32,}(?:\.[A-Za-z0-9]+)?$/i
  }
];

// ── 硬性拒绝：域名（画布素材 / 用户内容 / 签名地址）────────────────────────
const DENY_HOST = [
  /(^|\.)s3-alpha\.figma\.com$/i,
  /(^|\.)s3-alpha-sig\.figma\.com$/i,
  /(^|\.)s3-downtime\.figma\.com$/i,
  /(^|\.)api\.figma\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)cloudfront\.net$/i,
  /(^|\.)figma-alpha-api\./i
];

// ── 硬性拒绝：路径关键字（画布 / 文件 / 接口 / 实时协作）──────────────────
const DENY_PATH = [
  '/api/',
  '/graphql',
  '/file/',
  '/design/',
  '/board/',
  '/proto/',
  '/multiplayer',
  '/render/',
  '/export/',
  '/__/',
  '/v1/'
];

// ── 存储哪些响应头 ─────────────────────────────────────────────────────────
const HEADER_KEEP = [
  'content-type',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'content-language',
  'access-control-allow-origin'
];

// 命中后重新下发的缓存时长（一年）—— 让 Chromium 也一起缓存，形成双层
const REPLAY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * 请求本身是否适合缓存
 */
function isSafeRequest(req) {
  if (!req || req.method !== 'GET') {
    return false;
  }
  const h = req.headers || {};
  // WebSocket / HTTP Upgrade 一律不碰
  if (h.upgrade || h['sec-websocket-key'] || h['sec-websocket-version']) {
    return false;
  }
  // 明确要求不走缓存的请求，尊重它
  const cc = String(h['cache-control'] || '').toLowerCase();
  if (cc.indexOf('no-store') !== -1) {
    return false;
  }
  // 分段请求（媒体拖动进度等）不缓存，避免把 206 或半截内容当成完整资源
  if (h.range) {
    return false;
  }
  return true;
}

/**
 * URL 是否在白名单内
 * @returns {{ok: boolean, reason: string, rule?: string}}
 */
function checkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'empty-url' };
  }

  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return { ok: false, reason: 'invalid-url' };
  }

  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'not-https' };
  }

  // 任何查询串都不缓存：签名地址 / 带 token / 缓存破坏参数都在这里被拦掉
  if (u.search && u.search.length > 1) {
    return { ok: false, reason: 'has-query' };
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (DENY_HOST.some((re) => re.test(host))) {
    return { ok: false, reason: 'deny-host' };
  }

  const lowerPath = path.toLowerCase();
  const hitDeny = DENY_PATH.find((seg) => lowerPath.indexOf(seg) !== -1);
  if (hitDeny) {
    return { ok: false, reason: 'deny-path:' + hitDeny };
  }

  const rule = ALLOW.find((r) => r.host.test(host) && r.path.test(path));
  if (!rule) {
    return { ok: false, reason: 'not-allowlisted' };
  }

  return { ok: true, reason: 'allow', rule: rule.name };
}

/**
 * 响应是否适合落盘
 * @returns {{ok: boolean, reason: string}}
 */
function checkResponse(statusCode, headers) {
  if (statusCode !== 200) {
    return { ok: false, reason: 'status-' + statusCode };
  }
  const h = headers || {};

  if (h['set-cookie']) {
    return { ok: false, reason: 'set-cookie' };
  }

  const cc = String(h['cache-control'] || '').toLowerCase();
  if (cc.indexOf('no-store') !== -1) {
    return { ok: false, reason: 'no-store' };
  }
  if (cc.indexOf('private') !== -1) {
    return { ok: false, reason: 'private' };
  }

  const ct = String(h['content-type'] || '').toLowerCase();
  if (ct.indexOf('text/html') !== -1) {
    return { ok: false, reason: 'html' };
  }

  if (String(h['vary'] || '').trim() === '*') {
    return { ok: false, reason: 'vary-star' };
  }

  return { ok: true, reason: 'ok' };
}

/**
 * 从原始响应头中挑出需要持久化的部分
 */
function pickStoreHeaders(headers, bodyLength) {
  const out = {};
  HEADER_KEEP.forEach((key) => {
    const val = headers[key];
    if (val != null && val !== '') {
      out[key] = Array.isArray(val) ? val.join(', ') : String(val);
    }
  });

  // content-length 一律以实际落盘字节数为准，避免「Whistle 已解压但
  // 头里还写着压缩后长度」这类不一致把报文搞坏
  const declared = Number(headers['content-length']);
  out['content-length'] = String(bodyLength);

  // 若声明长度与实际字节数不符，说明上游流已被解压，此时必须摘掉
  // content-encoding，否则回放时会按错误的方式解码
  if (out['content-encoding'] && isFinite(declared) && declared > 0 && declared !== bodyLength) {
    delete out['content-encoding'];
  }

  return out;
}

/**
 * 命中缓存时下发给客户端的响应头
 */
function buildReplayHeaders(storeHeaders, bodyLength) {
  const out = Object.assign({}, storeHeaders);
  out['content-length'] = String(bodyLength);
  out['cache-control'] = REPLAY_CACHE_CONTROL;
  out['x-figma-cache'] = 'HIT';
  return out;
}

module.exports = {
  ALLOW,
  DENY_HOST,
  DENY_PATH,
  REPLAY_CACHE_CONTROL,
  isSafeRequest,
  checkUrl,
  checkResponse,
  pickStoreHeaders,
  buildReplayHeaders
};
