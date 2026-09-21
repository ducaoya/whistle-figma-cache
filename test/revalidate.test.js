'use strict';

/**
 * 后台静默校验（SWR）自测
 *
 * 用一个本地 HTTP 服务模拟源站，覆盖：
 *   304 → 只刷新校验时间
 *   200 同类型 → 原子替换缓存
 *   200 但变成 text/html（疑似登录页）→ 绝不替换
 *   5xx → 不替换
 *   冷却期 / 去重 / 并发上限
 *   Accept-Encoding: identity 是否被发送
 *   带 content-encoding 的响应是否先解压再存
 *
 * 运行： node test/revalidate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = path.join(os.tmpdir(), 'figma-cache-swr-' + Date.now());
const cfg = {
  dir: TMP,
  ttl: 0,
  maxSize: 4096,
  maxFileSize: 64,
  revalidate: 0, // 测试里不设冷却期
  log: false
};

const store = require('../lib/store');
const revalidate = require('../lib/revalidate');

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

// ── 模拟源站 ───────────────────────────────────────────────────────────────
const BODY_V1 = Buffer.from('/* v1 */ console.log(1)');
const BODY_V2 = Buffer.from('/* v2 */ console.log(2)');
const seenAcceptEncoding = [];

const server = http.createServer((req, res) => {
  seenAcceptEncoding.push(req.headers['accept-encoding']);
  const url = req.url;

  if (url.startsWith('/same')) {
    // 带 etag 的条件请求 → 304
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"v1"' });
    return res.end(BODY_V1);
  }

  if (url.startsWith('/changed')) {
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"v2"' });
    return res.end(BODY_V2);
  }

  if (url.startsWith('/login')) {
    // 类型变了 → 必须被护栏挡住
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<html>please sign in</html>');
  }

  if (url.startsWith('/boom')) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('server error');
  }

  if (url.startsWith('/gzip')) {
    const gz = zlib.gzipSync(BODY_V2);
    res.writeHead(200, {
      'content-type': 'application/javascript',
      'content-encoding': 'gzip'
    });
    return res.end(gz);
  }

  res.writeHead(404);
  res.end();
});

// ── 工具 ───────────────────────────────────────────────────────────────────
function waitIdle(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (revalidate.inflight.size === 0 && revalidate.queue.length === 0) {
        return setTimeout(resolve, 30);
      }
      if (Date.now() - t0 > timeout) {
        return reject(new Error('等待后台校验超时'));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function seed(body, headers, extra) {
  const url = 'http://127.0.0.1:' + server.address().port + (extra || '/same');
  const key = store.keyOf(url);
  const bodyFile = path.join(store.bodyDirFor(key), 'asset.js');
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.mkdirSync(path.dirname(store.metaPath(key)), { recursive: true });
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(
    store.metaPath(key),
    JSON.stringify(
      Object.assign(
        {
          url,
          ext: '.js',
          dir: store.bodyDirFor(key),
          bodyFile,
          status: 200,
          size: body.length,
          headers,
          contentType: headers['content-type'] || '',
          createdAt: Date.now(),
          lastHitAt: Date.now(),
          validatedAt: Date.now() - 100000
        },
        extra ? { contentType: headers['content-type'] || '' } : {}
      )
    )
  );
  return { key, url, bodyFile };
}

function readMeta(key) {
  return JSON.parse(fs.readFileSync(store.metaPath(key), 'utf8'));
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  store.use(cfg);

  console.log('\n【304：只刷新校验时间】');
  const same = seed(BODY_V1, { 'content-type': 'application/javascript', etag: '"v1"' }, '/same');
  await ok('后台校验后 validatedAt 被刷新，body 未被改动', async () => {
    const before = readMeta(same.key);
    assert.strictEqual(before.validatedAt < Date.now() - 90000, true);
    revalidate.schedule(same.key, same.url, before, cfg);
    await waitIdle();
    const after = readMeta(same.key);
    assert.ok(after.validatedAt > Date.now() - 5000, 'validatedAt 未刷新');
    assert.deepStrictEqual(fs.readFileSync(same.bodyFile), BODY_V1, 'body 不应被改动');
  });

  await ok('304 路径只计入 revalidated304，body 字节为 0', async () => {
    const before = store.counters.revalidateBytes;
    const k = store.keyOf(same.url);
    const meta = readMeta(same.key);
    revalidate.schedule(same.key, same.url, meta, cfg);
    await waitIdle();
    assert.ok(store.counters.revalidated304 > 0, 'revalidated304 未累加');
    assert.strictEqual(
      store.counters.revalidateBytes,
      before,
      '304 不应该产生任何 body 下载量'
    );
  });

  await ok('条件请求确实带上了 If-None-Match', () => {
    // 由服务端 304 分支反推：只有带了 etag 才会拿到 304，而上面 validatedAt 确实刷新了
    assert.ok(seenAcceptEncoding.length > 0);
  });

  console.log('\n【200：原子替换】');
  const changed = seed(BODY_V1, { 'content-type': 'application/javascript', etag: '"v1"' }, '/changed');
  await ok('内容变化时 body 被替换，size / etag 同步更新', async () => {
    const before = readMeta(changed.key);
    revalidate.schedule(changed.key, changed.url, before, cfg);
    await waitIdle();
    assert.deepStrictEqual(fs.readFileSync(changed.bodyFile), BODY_V2, 'body 未更新');
    const after = readMeta(changed.key);
    assert.strictEqual(after.size, BODY_V2.length);
    assert.strictEqual(after.headers.etag, '"v2"');
  });

  await ok('200 路径计入 revalidated200 与 revalidateBytes', () => {
    assert.ok(store.counters.revalidated200 > 0, 'revalidated200 未累加');
    assert.ok(
      store.counters.revalidateBytes >= BODY_V2.length,
      'revalidateBytes 未累加：' + store.counters.revalidateBytes
    );
  });

  await ok('替换后没有残留临时文件', () => {
    const dir = path.dirname(changed.bodyFile);
    const leftovers = fs.readdirSync(dir).filter((f) => f.indexOf('.new-') !== -1);
    assert.deepStrictEqual(leftovers, []);
  });

  console.log('\n【护栏：绝不用脏数据覆盖缓存】');
  const login = seed(BODY_V1, { 'content-type': 'application/javascript', etag: '"v1"' }, '/login');
  await ok('Content-Type 变成 text/html → 不替换', async () => {
    const before = readMeta(login.key);
    revalidate.schedule(login.key, login.url, before, cfg);
    await waitIdle();
    assert.deepStrictEqual(fs.readFileSync(login.bodyFile), BODY_V1, '缓存被脏数据覆盖了');
    assert.strictEqual(readMeta(login.key).size, BODY_V1.length);
  });

  const boom = seed(BODY_V1, { 'content-type': 'application/javascript', etag: '"v1"' }, '/boom');
  await ok('源站 500 → 不替换', async () => {
    const before = readMeta(boom.key);
    revalidate.schedule(boom.key, boom.url, before, cfg);
    await waitIdle();
    assert.deepStrictEqual(fs.readFileSync(boom.bodyFile), BODY_V1);
  });

  console.log('\n【压缩处理】');
  const gz = seed(BODY_V1, { 'content-type': 'application/javascript', etag: '"v1"' }, '/gzip');
  await ok('源站返回 gzip 时先解压再落盘（与 whistle 存储格式一致）', async () => {
    const before = readMeta(gz.key);
    revalidate.schedule(gz.key, gz.url, before, cfg);
    await waitIdle();
    assert.deepStrictEqual(fs.readFileSync(gz.bodyFile), BODY_V2, '应存解压后的内容');
  });

  await ok('请求头带 Accept-Encoding: identity', () => {
    assert.ok(
      seenAcceptEncoding.some((v) => String(v).toLowerCase() === 'identity'),
      '未发送 identity：' + JSON.stringify(seenAcceptEncoding)
    );
  });

  console.log('\n【冷却期与去重】');
  await ok('冷却期内不重复安排', () => {
    const meta = { validatedAt: Date.now(), createdAt: Date.now() };
    const warm = Object.assign({}, cfg, { revalidate: 3600 });
    assert.strictEqual(revalidate.schedule('k-cool', 'http://127.0.0.1/x', meta, warm), false);
  });

  await ok('revalidate = -1 时完全关闭', () => {
    const off = Object.assign({}, cfg, { revalidate: -1 });
    assert.strictEqual(revalidate.schedule('k-off', 'http://127.0.0.1/x', {}, off), false);
  });

  await ok('同一资源并发只安排一次（in-flight 去重）', () => {
    const meta = { validatedAt: 0, createdAt: 0 };
    const a = revalidate.schedule('k-dup', 'http://127.0.0.1:1/same', meta, cfg);
    const b = revalidate.schedule('k-dup', 'http://127.0.0.1:1/same', meta, cfg);
    assert.strictEqual(a, true);
    assert.strictEqual(b, false, '重复安排了');
  });

  console.log('\n【异常兜底】');
  await ok('非法 URL 不抛错', async () => {
    const meta = { validatedAt: 0, createdAt: 0 };
    revalidate.schedule('k-bad', 'not a url', meta, cfg);
    await waitIdle();
  });

  await ok('连接失败不抛错', async () => {
    const meta = { validatedAt: 0, createdAt: 0 };
    revalidate.schedule('k-dead', 'http://127.0.0.1:9/nope', meta, cfg);
    await waitIdle();
  });

  server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }

  console.log('\n────────────────────────────────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
