'use strict';

/**
 * resRulesServer hook —— 对应 whistle 的 RES_RULES 钩子（响应阶段）
 *
 * 这个阶段 whistle 已经拿到源站响应，所以我们能读到：
 *   req.originalRes.statusCode   响应状态码
 *   req.headers                  响应头（whistle 在 resRules 阶段把 res.headers 当请求头传过来）
 *
 * 职责很简单：把 REQ_RULES 阶段登记的「落盘意向」转正成一条可命中的 meta 记录。
 * 不满足条件（非 200、带 Set-Cookie、no-store 等）就丢弃意向，避免缓存脏数据。
 *
 * 注意：命中回放时不会有 pending（转正时已删除），所以这里天然不会自我覆盖。
 */

const config = require('./config');
const policy = require('./policy');
const store = require('./store');

function fullUrlOf(req) {
  const oReq = req.originalReq || {};
  return oReq.realUrl || req.fullUrl || oReq.url || '';
}

function reply(res) {
  try {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': '0'
    });
  } catch (e) {
    /* ignore */
  }
  res.end();
}

module.exports = (server) => {
  server.on('request', (req, res) => {
    try {
      const oReq = req.originalReq || {};
      const url = fullUrlOf(req);
      const cfg = config.resolveConfig(oReq.ruleValue);
      store.use(cfg);

      const verdict = policy.checkUrl(url);
      if (!verdict.ok) {
        return reply(res);
      }

      const key = store.keyOf(url);

      // 没有待转正的意向 → 可能是命中回放，也可能是别人加的规则，什么都不做
      if (!store.hasPending(key)) {
        return reply(res);
      }

      // 状态码拿不到时宁可放弃，也不要误判成 200 缓存一个错误页
      const oRes = req.originalRes || {};
      const rawStatus = oRes.statusCode;
      if (rawStatus == null || rawStatus === '') {
        store.dropPending(key);
        config.log(cfg, 'DROP(no-status)  %s', url);
        return reply(res);
      }

      const status = Number(rawStatus) || 0;
      const resHeaders = req.headers || {};

      const result = store.commitPending(key, status, resHeaders, cfg);
      if (result.ok) {
        config.log(cfg, 'PEND  %s  %s', resHeaders['content-type'] || '', url);
      } else {
        config.log(cfg, 'SKIP(%s)  %s', result.reason, url);
      }
    } catch (e) {
      /* 静默失败，不影响响应 */
    }
    return reply(res);
  });
};
