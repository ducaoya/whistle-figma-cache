'use strict';

/**
 * 规则钩子端到端自测（mock whistle 的钩子契约）
 *
 * 验证 rulesServer / resRulesServer 产出的规则文本，以及
 * 「未命中 → resWrite 落盘 → RES_RULES 标记 → 后续请求提升为命中」的完整闭环。
 *
 * 运行： node test/hooks.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'figma-cache-hooks-' + Date.now());
const RULE_VALUE = 'dir=' + TMP.replace(/\\/g, '/') + ',bodySettle=0,revalidate=-1';

const store = require('../lib/store');
const config = require('../lib/config');
const revalidate = require('../lib/revalidate');

let pass = 0;
let fail = 0;

function ok(desc, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + desc);
  } catch (e) {
    fail += 1;
    console.log('  \u2717 ' + desc + '\n      ' + (e && e.message));
  }
}

// ── 取得两个钩子的处理器 ───────────────────────────────────────────────────
let rulesHandler = null;
let resRulesHandler = null;
require('../lib/rulesServer')({
  on: (evt, fn) => {
    if (evt === 'request') rulesHandler = fn;
  }
});
require('../lib/resRulesServer')({
  on: (evt, fn) => {
    if (evt === 'request') resRulesHandler = fn;
  }
});

// ── mock whistle 钩子 ──────────────────────────────────────────────────────
/**
 * REQ_RULES 阶段：req.originalReq.headers 是【请求头】
 * RES_RULES 阶段：req.headers 是【响应头】，req.originalRes.statusCode 是状态码
 */
function hookReq(opts) {
  const url = opts.url;
  const requestHeaders = opts.requestHeaders || {};
  const responseHeaders = opts.responseHeaders || null;
  return {
    url: '/',
    fullUrl: url,
    headers: responseHeaders || requestHeaders,
    originalReq: {
      realUrl: url,
      ruleValue: RULE_VALUE,
      method: opts.method || 'GET',
      headers: requestHeaders
    },
    originalRes: opts.statusCode === undefined ? {} : { statusCode: opts.statusCode }
  };
}

function hookRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(code, h) {
      res.statusCode = code;
      res.headers = h;
    },
    end(b) {
      res.body = b === undefined ? '' : String(b);
      res.ended = true;
    }
  };
  return res;
}

const text = (res) => res.body || '';
const cfg = config.resolveConfig(RULE_VALUE);

const ASSET = 'https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br';
const RES_HEADERS = {
  'content-type': 'application/javascript',
  'content-encoding': 'gzip',
  'cache-control': 'public, max-age=31536000',
  etag: '"abc"'
};

console.log('\n【不干预的请求：必须返回空规则】');
[
  ['画布数据（/design/）', 'https://www.figma.com/design/abc/My-Design', {}],
  ['GraphQL 接口', 'https://www.figma.com/api/graphql', {}],
  ['画布内图片', 'https://www.figma.com/design/x/y/7af6798dd205e965a9f81b1815cf5931eb22f6cb.png', {}],
  ['域名后缀伪造', 'https://www.figma.com.evil.com/webpack-artifacts/assets/a-1d532d39d96c5d27.min.js', {}],
  ['带查询串（签名/令牌）', ASSET + '?token=abc', {}],
  ['未验证的 static 路径', 'https://static.figma.com/fonts/x-1d532d39d96c5d27.woff2', {}],
  ['s3 用户素材', 'https://s3-alpha.figma.com/s3/abc/1.png', {}],
  ['WebSocket 升级', ASSET, { upgrade: 'websocket' }],
  ['Range 请求', ASSET, { range: 'bytes=0-99' }],
  ['no-store 请求', ASSET, { 'cache-control': 'no-store' }]
].forEach(([desc, url, headers]) => {
  ok(desc + '  →  空规则', () => {
    const res = hookRes();
    rulesHandler(hookReq({ url, requestHeaders: headers }), res);
    assert.strictEqual(text(res), '', '不应返回规则，实际：' + text(res));
  });
});

ok('POST 请求 → 空规则', () => {
  const res = hookRes();
  rulesHandler(hookReq({ url: ASSET, method: 'POST' }), res);
  assert.strictEqual(text(res), '');
});

console.log('\n【闭环：未命中 → 落盘 → 标记 → 提升 → 命中】');
let bodyFile = '';

ok('首次请求返回 resWrite:// 并登记意向', () => {
  const res = hookRes();
  rulesHandler(hookReq({ url: ASSET }), res);
  const t = text(res);
  // 钩子返回的是完整规则行，形如 `* resWrite://<dir>/`
  assert.ok(/^\*\s+resWrite:\/\//.test(t), '应为 `* resWrite://`，实际：' + t);
  assert.ok(store.hasPending(store.keyOf(ASSET)), '意向未登记');
  // 从 pending 读出 whistle 实际会写入的完整文件路径
  const pending = JSON.parse(fs.readFileSync(store.pendingPath(store.keyOf(ASSET)), 'utf8'));
  bodyFile = store._toAbs(pending.bodyFile); // pending 里存的是相对路径
  assert.ok(bodyFile.indexOf('body') !== -1, '路径应在 body 目录下：' + bodyFile);
  assert.ok(
    bodyFile.endsWith('vendor-1d532d39d96c5d27.min.js.br'),
    '应包含 URL 剩余路径：' + bodyFile
  );
});

ok('body 还没写出来时，直接查缓存仍是未命中', () => {
  assert.strictEqual(store.lookup(store.keyOf(ASSET), ASSET, cfg), null);
});

ok('RES_RULES 拿到 200 → 标记为可提升', () => {
  const res = hookRes();
  resRulesHandler(
    hookReq({ url: ASSET, responseHeaders: RES_HEADERS, statusCode: 200 }),
    res
  );
  assert.strictEqual(store.hasPending(store.keyOf(ASSET)), true, '意向应保留待提升');
});

ok('whistle 写入 body 后，下一次请求提升为命中并返回 file://', () => {
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, Buffer.from('console.log("figma")'));
  const res = hookRes();
  rulesHandler(hookReq({ url: ASSET }), res);
  const t = text(res);
  assert.ok(/^\*\s+file:\/\//.test(t), '应为 `* file://`，实际：' + t);
  const dir = store.bodyDirFor(store.keyOf(ASSET)).replace(/\\/g, '/');
  assert.ok(t.indexOf(dir + '/') !== -1, '应指向同一目录：' + t + ' ←dir=' + dir);
  assert.ok(t.indexOf('resType://js') !== -1, '应带 resType://js 以修正 MIME');
});

ok('提升后意向被清理，meta 已生成', () => {
  assert.strictEqual(store.hasPending(store.keyOf(ASSET)), false);
  assert.ok(fs.existsSync(store.metaPath(store.keyOf(ASSET))));
});

ok('再次请求稳定命中', () => {
  const res = hookRes();
  rulesHandler(hookReq({ url: ASSET }), res);
  assert.ok(/^\*\s+file:\/\//.test(text(res)));
});

ok('命中时会安排后台校验（冷却期为 0，应立即安排）', () => {
  revalidate.inflight.clear();
  const warm = Object.assign({}, cfg, { revalidate: 0 });
  const meta = JSON.parse(fs.readFileSync(store.metaPath(store.keyOf(ASSET)), 'utf8'));
  // 用本机无用端口，避免单测真的发网络请求
  const okScheduled = revalidate.schedule(
    store.keyOf(ASSET),
    'http://127.0.0.1:9/asset.js',
    meta,
    warm
  );
  assert.strictEqual(okScheduled, true);
});

console.log('\n【转正前的拒绝逻辑】');
ok('RES_RULES 收到 404 → 丢弃意向，不生成缓存', () => {
  const url = 'https://www.figma.com/webpack-artifacts/assets/chunk1-bbbbbbbbbbbbbbbb.min.js';
  const key = store.keyOf(url);
  const r1 = hookRes();
  rulesHandler(hookReq({ url }), r1);
  const pk = JSON.parse(fs.readFileSync(store.pendingPath(key), 'utf8'));
  const pkBody = store._toAbs(pk.bodyFile);
  fs.mkdirSync(path.dirname(pkBody), { recursive: true });
  fs.writeFileSync(pkBody, Buffer.from('not found page'));

  const r2 = hookRes();
  resRulesHandler(hookReq({ url, responseHeaders: { 'content-type': 'text/html' }, statusCode: 404 }), r2);

  assert.strictEqual(store.hasPending(key), false, '意向应被丢弃');
  assert.strictEqual(store.lookup(key, url, cfg), null, '不应命中');
});

ok('RES_RULES 拿不到状态码 → 放弃（不误判为 200）', () => {
  const url = 'https://www.figma.com/webpack-artifacts/assets/chunk2-cccccccccccccccc.min.js';
  const key = store.keyOf(url);
  const r1 = hookRes();
  rulesHandler(hookReq({ url }), r1);
  const pk2 = JSON.parse(fs.readFileSync(store.pendingPath(key), 'utf8'));
  const pk2Body = store._toAbs(pk2.bodyFile);
  fs.mkdirSync(path.dirname(pk2Body), { recursive: true });
  fs.writeFileSync(pk2Body, Buffer.from('x'));

  const r2 = hookRes();
  resRulesHandler(hookReq({ url, responseHeaders: RES_HEADERS }), r2); // 不给 statusCode
  assert.strictEqual(store.hasPending(key), false);
  assert.strictEqual(store.lookup(key, url, cfg), null, '不应命中');
});

ok('命中回放时的 RES_RULES 不会覆盖已有记录', () => {
  const key = store.keyOf(ASSET);
  const before = JSON.parse(fs.readFileSync(store.metaPath(key), 'utf8'));
  const res = hookRes();
  resRulesHandler(
    hookReq({ url: ASSET, responseHeaders: { 'content-type': 'text/html' }, statusCode: 200 }),
    res
  );
  const after = JSON.parse(fs.readFileSync(store.metaPath(key), 'utf8'));
  assert.strictEqual(after.contentType, before.contentType, 'meta 被覆盖了');
  assert.strictEqual(after.createdAt, before.createdAt);
});

console.log('\n【异常兜底】');
ok('非法 URL 不抛错，返回空规则', () => {
  const res = hookRes();
  rulesHandler(hookReq({ url: 'not a url' }), res);
  assert.strictEqual(text(res), '');
});

ok('空 URL 不抛错', () => {
  const res = hookRes();
  rulesHandler(hookReq({ url: '' }), res);
  assert.strictEqual(text(res), '');
});

ok('缓存的 body 被删除后自动失效', () => {
  fs.unlinkSync(bodyFile);
  const res = hookRes();
  rulesHandler(hookReq({ url: ASSET }), res);
  assert.ok(/^\*\s+resWrite:\/\//.test(text(res)), '应回退为未命中');
});

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}

console.log('\n────────────────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
