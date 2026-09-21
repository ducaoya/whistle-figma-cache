'use strict';

// 【历史遗留】早期用 server hook 实现的版本，whistle 2.10.10 不会派发到该钩子。
// 保留仅供参考，不纳入 npm test。


/**
 * server hook 端到端自测（mock Whistle 的 req / res 契约）
 *
 * 验证四件事：
 *   1. 白名单外的请求 → 原样透传，插件零干预
 *   2. WebSocket 升级   → 原样透传
 *   3. 白名单内未命中   → passThrough + transformRes，回写字节完全一致，且落盘成功
 *   4. 白名单内命中     → 直接由插件返回磁盘字节，不再回源
 *
 * 运行： node test/server.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'figma-cache-server-test-' + Date.now());
const RULE_VALUE = 'dir=' + TMP.replace(/\\/g, '/');

process.env.FIGMA_CACHE_TEST_DIR = TMP;

const store = require('../lib/store');
const config = require('../lib/config');

let pass = 0;
let fail = 0;

async function ok(desc, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  \u2713 ' + desc);
  } catch (e) {
    fail += 1;
    console.log('  \u2717 ' + desc + '\n      ' + (e && e.message));
  }
}

// ── 取得插件注册的 request 处理器 ─────────────────────────────────────────
let handler = null;
require('../lib/server-hook')({
  on(evt, fn) {
    if (evt === 'request') {
      handler = fn;
    }
  }
});

// ── mock Whistle 的 req / res ─────────────────────────────────────────────
function mockReq(url, { method = 'GET', headers = {}, ruleValue = RULE_VALUE } = {}) {
  const req = {
    method,
    headers,
    url,
    originalReq: { realUrl: url, ruleValue },
    passThroughArg: undefined,
    passThroughCalled: false,
    passThrough(arg) {
      req.passThroughCalled = true;
      req.passThroughArg = arg === undefined ? 'plain' : arg;
    }
  };
  return req;
}

function mockRes() {
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
      res.body = b;
      res.ended = true;
    }
  };
  return res;
}

/** 模拟 Whistle 传给 transformRes 的 wrapped stream */
function mockUpstream(statusCode, headers, rawBuf) {
  return {
    statusCode,
    headers,
    _readRawBuffer_: rawBuf,
    getRawBuffer(cb) {
      cb(rawBuf);
    }
  };
}

const ASSET_URL = 'https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br';
const BINARY = (() => {
  const b = Buffer.alloc(2048);
  for (let i = 0; i < b.length; i++) {
    b[i] = (i * 7) % 256;
  }
  return b;
})();

(async () => {
  console.log('\n【闸门：不干预的请求】');

  await ok('白名单外（画布数据）→ 原样透传', async () => {
    const req = mockReq('https://www.figma.com/design/abc/My-Design');
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughCalled, true);
    assert.strictEqual(req.passThroughArg, 'plain', '不应带 transformRes');
    assert.strictEqual(res.ended, false, '插件不应自己结束响应');
  });

  await ok('白名单外（API）→ 原样透传', async () => {
    const req = mockReq('https://www.figma.com/api/graphql');
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughArg, 'plain');
  });

  await ok('白名单外（画布内图片）→ 原样透传', async () => {
    const req = mockReq('https://www.figma.com/design/x/y/7af6798dd205e965a9f81b1815cf5931eb22f6cb.png');
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughArg, 'plain');
  });

  await ok('WebSocket 升级 → 原样透传', async () => {
    const req = mockReq('https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br', {
      headers: { upgrade: 'websocket' }
    });
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughArg, 'plain');
  });

  await ok('带查询串 → 原样透传', async () => {
    const req = mockReq(ASSET_URL + '?token=secret');
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughArg, 'plain');
  });

  await ok('Range 请求 → 原样透传', async () => {
    const req = mockReq(ASSET_URL, { headers: { range: 'bytes=0-99' } });
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(req.passThroughArg, 'plain');
  });

  console.log('\n【未命中：回源 + 旁路落盘】');

  await ok('装配 transformRes 且不自行结束响应', async () => {
    const req = mockReq(ASSET_URL);
    const res = mockRes();
    await handler(req, res);
    assert.strictEqual(typeof req.passThroughArg, 'object', '应当传对象形式的 passThrough 参数');
    assert.strictEqual(typeof req.passThroughArg.transformRes, 'function');
    assert.strictEqual(res.ended, false);
  });

  await ok('transformRes 回写字节与上游完全一致，且已落盘', async () => {
    const req = mockReq(ASSET_URL);
    const res = mockRes();
    await handler(req, res);

    const upstream = mockUpstream(200, {
      'content-type': 'application/javascript',
      'cache-control': 'public, max-age=31536000'
    }, BINARY);

    let forwarded = null;
    req.passThroughArg.transformRes(upstream, (buf) => {
      forwarded = buf;
    });

    // 回写字节必须逐字节一致
    assert.strictEqual(
      crypto.createHash('sha256').update(forwarded).digest('hex'),
      crypto.createHash('sha256').update(BINARY).digest('hex'),
      '回写字节被破坏'
    );

    // 落盘是异步的，等一拍
    await new Promise((r) => setTimeout(r, 200));
    const hit = await store.get(store.keyOf(ASSET_URL), config.resolveConfig(RULE_VALUE));
    assert.ok(hit, '没有落盘');
    assert.strictEqual(hit.body.length, BINARY.length);
  });

  console.log('\n【命中：直接返回磁盘字节】');

  await ok('命中时不调用 passThrough，并由插件返回 200 + 磁盘字节', async () => {
    const req = mockReq(ASSET_URL);
    const res = mockRes();
    await handler(req, res);

    assert.strictEqual(req.passThroughCalled, false, '命中时不应回源');
    assert.strictEqual(res.ended, true, '应当由插件结束响应');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-figma-cache'], 'HIT');
    assert.ok(String(res.headers['cache-control']).indexOf('immutable') !== -1);
    assert.strictEqual(
      crypto.createHash('sha256').update(res.body).digest('hex'),
      crypto.createHash('sha256').update(BINARY).digest('hex'),
      '命中返回的字节与落盘不一致'
    );
  });

  console.log('\n【异常兜底：不能把请求搞挂】');

  await ok('getRawBuffer 抛错时仍然回写可用字节', async () => {
    const url = 'https://www.figma.com/webpack-artifacts/assets/chunk9-aaaaaaaaaaaaaaaa.min.js';
    const req = mockReq(url);
    const res = mockRes();
    await handler(req, res);

    const broken = {
      statusCode: 200,
      headers: { 'content-type': 'application/javascript' },
      _readRawBuffer_: BINARY,
      getRawBuffer() {
        throw new Error('boom');
      }
    };

    let forwarded;
    let threw = null;
    try {
      req.passThroughArg.transformRes(broken, (buf) => {
        forwarded = buf;
      });
    } catch (e) {
      threw = e;
    }
    assert.strictEqual(threw, null, 'transformRes 不应向外抛错');
    assert.ok(Buffer.isBuffer(forwarded), '应当回写 _readRawBuffer_ 兜底内容');
    assert.strictEqual(forwarded.length, BINARY.length);
  });

  await ok('回源响应含 Set-Cookie 时不落盘（但仍正常透传）', async () => {
    const url = 'https://www.figma.com/webpack-artifacts/assets/chunk8-bbbbbbbbbbbbbbbb.min.js';
    const req = mockReq(url);
    const res = mockRes();
    await handler(req, res);

    const upstream = mockUpstream(200, { 'set-cookie': 'sid=1', 'content-type': 'application/javascript' }, BINARY);
    let forwarded;
    req.passThroughArg.transformRes(upstream, (buf) => {
      forwarded = buf;
    });
    assert.ok(forwarded && forwarded.length === BINARY.length, '仍然要正常透传');

    await new Promise((r) => setTimeout(r, 150));
    const cfg = config.resolveConfig(RULE_VALUE);
    const hit = await store.get(store.keyOf(url), cfg);
    assert.strictEqual(hit, null, '含 Set-Cookie 的响应不应被缓存');
  });

  // 收尾
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }

  console.log('\n────────────────────────────────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
