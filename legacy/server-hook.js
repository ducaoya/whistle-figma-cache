'use strict';

/**
 * server hook —— 缓存读写的全部逻辑
 *
 * 请求处理流程：
 *
 *   匹配 figma-cache:// 的请求
 *        │
 *        ├─ 闸门1：非 GET / WebSocket / Range / no-store  ──► 原样透传（零改动）
 *        ├─ 闸门2：URL 不在白名单（画布/API/签名/带参） ──► 原样透传（零改动）
 *        │
 *        └─ 白名单内
 *             ├─ 磁盘命中 ──► 直接返回（零网络，并从磁盘读字节）
 *             └─ 未命中   ──► 原样透传回源，同时旁路把响应落盘
 *
 * 安全要求：任何「不确定」的情况都必须退化成原样透传，绝不阻断请求。
 */

const config = require('./config');
const policy = require('./policy');
const store = require('./store');

/**
 * 原样交给 Whistle 原生流程，本插件不做任何干预
 */
function passThroughRaw(req, res) {
  try {
    req.passThrough();
  } catch (e) {
    // 极端兜底：连原生透传都抛错
    try {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('figma-cache: passthrough failed');
    } catch (e2) {
      /* ignore */
    }
  }
}

module.exports = (server) => {
  server.on('request', async (req, res) => {
    const originalReq = req.originalReq || {};
    const ruleValue = originalReq.ruleValue || '';
    const url = originalReq.realUrl || originalReq.url || req.url || '';

    let cfg;
    try {
      cfg = config.resolveConfig(ruleValue);
    } catch (e) {
      cfg = config.resolveConfig('');
    }

    // ── 闸门 1：请求形态是否允许缓存 ─────────────────────────────────────
    if (!policy.isSafeRequest(req)) {
      store.bump('bypass');
      return passThroughRaw(req, res);
    }

    // ── 闸门 2：URL 是否在白名单内 ───────────────────────────────────────
    const verdict = policy.checkUrl(url);
    if (!verdict.ok) {
      store.bump('bypass');
      config.log(cfg, 'BYPASS(%s) %s', verdict.reason, url);
      return passThroughRaw(req, res);
    }

    // 准备缓存目录（首次会扫一遍索引）
    try {
      await store.use(cfg);
    } catch (e) {
      /* 索引构建失败不影响透传 */
    }

    const key = store.keyOf(url);

    // ── 尝试命中 ────────────────────────────────────────────────────────
    let hit = null;
    try {
      hit = await store.get(key, cfg);
    } catch (e) {
      hit = null;
    }

    if (hit) {
      config.log(cfg, 'HIT   %s KB  %s', Math.round(hit.size / 1024), url);
      try {
        res.writeHead(200, policy.buildReplayHeaders(hit.headers, hit.body.length));
        res.end(hit.body);
        return;
      } catch (e) {
        /* 写失败就退化为回源 */
      }
    }

    store.bump('miss');
    config.log(cfg, 'MISS  %s', url);

    // ── 回源 + 旁路落盘 ─────────────────────────────────────────────────
    try {
      req.passThrough({
        transformRes(stream, next) {
          let handled = false;

          const finish = (buf) => {
            if (handled) {
              return;
            }
            handled = true;

            // 落盘是 fire-and-forget，无论如何都不能影响本次响应
            if (buf && buf.length) {
              store
                .put(key, url, stream.statusCode, stream.headers, buf, cfg)
                .then((r) => {
                  if (r && r.ok) {
                    config.log(cfg, 'STORE %s KB  %s', Math.round(r.size / 1024), url);
                  } else if (r) {
                    config.log(cfg, 'SKIP(%s)  %s', r.reason, url);
                  }
                })
                .catch(() => {});
            }

            // 关键：把【原始字节】原样交回 Whistle 输出。
            // buf 为 null（响应体为空）时传 null，Whistle 会按空响应处理。
            try {
              next(buf);
            } catch (e) {
              try {
                next();
              } catch (e2) {
                try {
                  res.end();
                } catch (e3) {
                  /* ignore */
                }
              }
            }
          };

          try {
            // getRawBuffer 拿到的是【未解压】的原始字节，二进制安全
            stream.getRawBuffer((buf) => finish(buf));
          } catch (e) {
            // 读流异常：仍然要吐出内容，退化交给 Whistle 用原始 buffer 输出
            finish(stream && stream._readRawBuffer_);
          }
        }
      });
    } catch (e) {
      // passThrough 装配失败 → 退回原生透传，保证请求不断
      passThroughRaw(req, res);
    }
  });
};
