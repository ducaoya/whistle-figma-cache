'use strict';

/**
 * 存储层自测（规则版）
 *
 * 重点验证「意向 → 转正」的时序模型：
 *   RES_RULES 阶段只标记意向（此刻 body 往往还没写完）
 *   下一次 lookup() 在确认 body 已写完（mtime 静默）之后才提升为可命中条目
 *
 * 运行： node test/store.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试便利：body 现在落在「一个 URL 一个目录」下，写之前先补父目录
const _wf = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...rest) {
  if (typeof file === 'string') {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (e) {
      /* ignore */
    }
  }
  return _wf.call(fs, file, data, ...rest);
};

const store = require('../lib/store');
const config = require('../lib/config');

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

const TMP = path.join(os.tmpdir(), 'figma-cache-store-' + Date.now());
const cfg = Object.assign(config.resolveConfig(''), {
  dir: TMP,
  ttl: 0,
  maxSize: 4,
  maxFileSize: 64,
  revalidate: -1,
  bodySettleMs: 0
});

const URL_JS = 'https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br';
const URL_UPLOAD = 'https://static.figma.com/uploads/' + 'a'.repeat(40);

const RES_HEADERS = {
  'content-type': 'application/javascript',
  'content-encoding': 'gzip',
  'cache-control': 'public, max-age=31536000',
  etag: '"abc"',
  vary: 'Accept-Encoding'
};

store.use(cfg);

console.log('\n【扩展名推导】');
ok('xxx.min.js.br → .js', () => assert.strictEqual(store.extFor(URL_JS), '.js'));
ok('xxx.min.css.br → .css', () =>
  assert.strictEqual(
    store.extFor('https://www.figma.com/webpack-artifacts/assets/a-1d532d39d96c5d27.min.css.br'),
    '.css'
  ));
ok('static/uploads/<40hex>（无扩展名）→ .js', () =>
  assert.strictEqual(store.extFor(URL_UPLOAD), '.js'));

console.log('\n【完整生命周期：意向 → 标记 → 提升 → 命中】');
const key = store.keyOf(URL_JS);
let bodyFile = '';

ok('未命中时返回 null', () => assert.strictEqual(store.lookup(key, URL_JS, cfg), null));

ok('beginPending 生成落盘路径并登记意向', () => {
  const p = store.beginPending(key, URL_JS, cfg);
  bodyFile = p.bodyFile;
  assert.strictEqual(p.ext, '.js');
  assert.ok(store.hasPending(key), '意向未登记');
});

ok('意向还没被标记时不会提升（避免读到半截文件）', () =>
  assert.strictEqual(store.lookup(key, URL_JS, cfg), null));

ok('commitPending 只做标记，不生成 meta', () => {
  const r = store.commitPending(key, 200, RES_HEADERS, cfg);
  assert.strictEqual(r.ok, true, '标记失败：' + r.reason);
  assert.strictEqual(r.reason, 'committed');
  assert.strictEqual(fs.existsSync(store.metaPath(key)), false, '此刻不应有 meta');
});

ok('body 还没写 → 仍不提升', () =>
  assert.strictEqual(store.lookup(key, URL_JS, cfg), null));

ok('body 写完后 lookup 自动提升并命中', () => {
  fs.writeFileSync(bodyFile, Buffer.from('console.log(1)'));
  const hit = store.lookup(key, URL_JS, cfg);
  assert.ok(hit, '未提升');
  assert.strictEqual(hit.bodyFile, bodyFile);
  assert.strictEqual(hit.ext, '.js');
  assert.ok(fs.existsSync(store.metaPath(key)), 'meta 未生成');
  assert.strictEqual(store.hasPending(key), false, '意向未清理');
});

ok('meta 记录真实大小与筛选后的响应头', () => {
  const meta = JSON.parse(fs.readFileSync(store.metaPath(key), 'utf8'));
  assert.strictEqual(meta.size, fs.statSync(bodyFile).size);
  assert.strictEqual(meta.status, 200);
  assert.strictEqual(meta.headers.etag, '"abc"');
  assert.strictEqual(meta.headers['content-length'], undefined, 'content-length 不应落盘');
  assert.ok(meta.validatedAt > 0, 'validatedAt 未设置');
});

ok('提升后再次 lookup 稳定命中（走 meta 分支）', () => {
  const hit = store.lookup(key, URL_JS, cfg);
  assert.ok(hit);
  assert.strictEqual(hit.bodyFile, bodyFile);
});

console.log('\n【响应头筛选】');
ok('pickStoreHeaders 会丢掉 server / date 之类无关头', () => {
  const k = store.keyOf(URL_JS + '#x');
  const p = store.beginPending(k, URL_JS + '#x', cfg);
  store.commitPending(k, 200, Object.assign({ server: 'AmazonS3', date: 'x' }, RES_HEADERS), cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('x'));
  store.lookup(k, URL_JS + '#x', cfg);
  const meta = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  assert.strictEqual(meta.headers.server, undefined);
  assert.strictEqual(meta.headers.date, undefined);
  assert.strictEqual(meta.headers.etag, '"abc"');
});

console.log('\n【拒绝条件】');
ok('非 200 直接丢弃意向', () => {
  const k = store.keyOf(URL_UPLOAD);
  const p = store.beginPending(k, URL_UPLOAD, cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('err'));
  const r = store.commitPending(k, 404, RES_HEADERS, cfg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'status-404');
  assert.strictEqual(store.hasPending(k), false);
  assert.strictEqual(store.lookup(k, URL_UPLOAD, cfg), null);
});

ok('带 Set-Cookie 的响应被拒（原因透出 set-cookie）', () => {
  const k = store.keyOf(URL_UPLOAD + '?a');
  const p = store.beginPending(k, URL_UPLOAD + '?a', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('x'));
  const r = store.commitPending(k, 200, { 'set-cookie': 'a=1' }, cfg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'set-cookie');
});

ok('text/html 响应被拒', () => {
  const k = store.keyOf(URL_UPLOAD + '?b');
  const p = store.beginPending(k, URL_UPLOAD + '?b', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('x'));
  const r = store.commitPending(k, 200, { 'content-type': 'text/html' }, cfg);
  assert.strictEqual(r.ok, false);
});

ok('没有意向时 commitPending 直接忽略（命中回放场景）', () => {
  const r = store.commitPending('nonexistent-key', 200, RES_HEADERS, cfg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-pending');
});

console.log('\n【写盘静默期】');
ok('body 刚写完（静默期未过）→ 暂不提升', () => {
  const strict = Object.assign({}, cfg, { bodySettleMs: 5000 });
  const k = store.keyOf(URL_JS + '#settle');
  const p = store.beginPending(k, URL_JS + '#settle', strict);
  fs.writeFileSync(p.bodyFile, Buffer.from('abc'));
  store.commitPending(k, 200, RES_HEADERS, strict);
  assert.strictEqual(store.lookup(k, URL_JS + '#settle', strict), null, '不应提升');
  // 把 mtime 往过去推，模拟写流已关闭
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(p.bodyFile, old, old);
  assert.ok(store.lookup(k, URL_JS + '#settle', strict), '静默期过后应提升');
});

console.log('\n【失效保护】');
ok('body 被清空 → 视为未命中并清理', () => {
  fs.writeFileSync(bodyFile, Buffer.alloc(0));
  assert.strictEqual(store.lookup(key, URL_JS, cfg), null);
  assert.strictEqual(fs.existsSync(store.metaPath(key)), false);
});

ok('body 被删除 → 视为未命中', () => {
  const k = store.keyOf(URL_JS + '#2');
  const p = store.beginPending(k, URL_JS + '#2', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('abcd'));
  store.commitPending(k, 200, RES_HEADERS, cfg);
  assert.ok(store.lookup(k, URL_JS + '#2', cfg), '应命中');
  fs.unlinkSync(p.bodyFile);
  assert.strictEqual(store.lookup(k, URL_JS + '#2', cfg), null);
});

console.log('\n【SWR：原子替换】');
ok('replaceBody 原子替换并同步 meta', () => {
  const k = store.keyOf(URL_JS + '#swr');
  const p = store.beginPending(k, URL_JS + '#swr', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('old'));
  store.commitPending(k, 200, RES_HEADERS, cfg);
  assert.ok(store.lookup(k, URL_JS + '#swr', cfg));

  const r = store.replaceBody(k, URL_JS + '#swr', Buffer.from('brand new body'), {
    'content-type': 'application/javascript',
    etag: '"v2"'
  });
  assert.strictEqual(r.ok, true, '替换失败：' + r.reason);
  assert.strictEqual(fs.readFileSync(p.bodyFile, 'utf8'), 'brand new body');
  const meta = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  assert.strictEqual(meta.size, 'brand new body'.length);
  assert.strictEqual(meta.headers.etag, '"v2"');
});

ok('replaceBody 不残留临时文件', () => {
  const k = store.keyOf(URL_JS + '#swr');
  const meta = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  // meta 里存的是相对路径（见「相对路径存储」一节），这里要用 store 的解析器还原
  const dir = path.dirname(store._toAbs(meta.bodyFile));
  const leftovers = fs.readdirSync(dir).filter((f) => f.indexOf('.new-') !== -1);
  assert.deepStrictEqual(leftovers, []);
});

ok('无 meta 时 replaceBody 拒绝', () => {
  const r = store.replaceBody('no-such-key', 'https://x/y.js', Buffer.from('a'), {});
  assert.strictEqual(r.ok, false);
});

ok('touchValidation 刷新 validatedAt', () => {
  const k = store.keyOf(URL_JS + '#swr');
  const meta = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  assert.strictEqual(store.touchValidation(k), true);
  const after = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  assert.ok(after.validatedAt >= meta.validatedAt);
  assert.strictEqual(store.counters.revalidated304 > 0, true);
});

console.log('\n【孤儿清理：绝不能误删待转正的 body】');
ok('有 pending 意向的 body，即使很旧也不会被当孤儿删掉', () => {
  const k = store.keyOf(URL_JS + '#orphan');
  const p = store.beginPending(k, URL_JS + '#orphan', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('pending-body'));
  // 把 body 文件与目录的 mtime 推到 1 小时前（远超 10 分钟宽限期）
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(p.bodyFile, old, old);
  fs.utimesSync(p.dir, old, old);

  store.sweep(cfg);

  assert.ok(fs.existsSync(p.bodyFile), '待转正的 body 被误删了 —— 缓存将永远建不起来');
});

ok('意向超过保留期后会被清理（防止磁盘无界增长）', () => {
  const k = store.keyOf(URL_JS + '#stale');
  const p = store.beginPending(k, URL_JS + '#stale', cfg);
  fs.writeFileSync(p.bodyFile, Buffer.from('stale'));
  // 把意向时间改成 10 天前
  const meta = JSON.parse(fs.readFileSync(store.pendingPath(k), 'utf8'));
  meta.at = Date.now() - 10 * 24 * 3600 * 1000;
  fs.writeFileSync(store.pendingPath(k), JSON.stringify(meta));

  store.sweep(cfg);

  assert.strictEqual(fs.existsSync(store.pendingPath(k)), false, '过期意向未清理');
  assert.strictEqual(fs.existsSync(p.bodyFile), false, '过期意向的 body 未清理');
});

console.log('\n【相对路径存储：缓存可整体搬迁】');
ok('pending 里存的是相对路径（对外返回的仍是绝对路径）', () => {
  const k = store.keyOf(URL_JS + '#relpath');
  const p = store.beginPending(k, URL_JS + '#relpath', cfg);
  const pending = JSON.parse(fs.readFileSync(store.pendingPath(k), 'utf8'));
  assert.strictEqual(path.isAbsolute(pending.bodyFile), false, 'bodyFile 应为相对路径：' + pending.bodyFile);
  assert.strictEqual(path.isAbsolute(pending.dir), false, 'dir 应为相对路径：' + pending.dir);
  assert.ok(path.isAbsolute(p.bodyFile), 'beginPending 的返回值仍应是绝对路径');
});

ok('meta 里存的也是相对路径', () => {
  const k = store.keyOf(URL_JS + '#relpath');
  const p = store.beginPending(k, URL_JS + '#relpath', cfg);
  fs.mkdirSync(path.dirname(p.bodyFile), { recursive: true });
  fs.writeFileSync(p.bodyFile, Buffer.from('rel'));
  store.commitPending(k, 200, RES_HEADERS, cfg);
  store.lookup(k, URL_JS + '#relpath', cfg);
  const meta = JSON.parse(fs.readFileSync(store.metaPath(k), 'utf8'));
  assert.strictEqual(path.isAbsolute(meta.bodyFile), false, 'meta.bodyFile 应为相对路径');
  assert.strictEqual(path.isAbsolute(meta.dir), false, 'meta.dir 应为相对路径');
});

ok('整个缓存目录搬迁后仍能命中', () => {
  const SRC = path.join(os.tmpdir(), 'figma-cache-move-src-' + Date.now());
  const DST = path.join(os.tmpdir(), 'figma-cache-move-dst-' + Date.now());
  const cfgA = Object.assign({}, cfg, { dir: SRC });
  const url = 'https://www.figma.com/webpack-artifacts/assets/move-aaaaaaaaaaaaaaaa.min.js';
  const k = store.keyOf(url);

  store.use(cfgA);
  const p = store.beginPending(k, url, cfgA);
  fs.mkdirSync(path.dirname(p.bodyFile), { recursive: true });
  fs.writeFileSync(p.bodyFile, Buffer.from('movable'));
  store.commitPending(k, 200, RES_HEADERS, cfgA);
  assert.ok(store.lookup(k, url, cfgA), '搬迁前应命中');

  fs.renameSync(SRC, DST); // ← 整体搬家

  const cfgB = Object.assign({}, cfg, { dir: DST });
  store.use(cfgB);
  const hit = store.lookup(k, url, cfgB);
  assert.ok(hit, '搬迁后应仍然命中（说明存的是相对路径）');
  assert.strictEqual(hit.bodyFile, p.bodyFile.replace(SRC, DST), '搬迁后解析出的绝对路径应指向新位置');

  store.use(cfg); // 切回主测试目录
  fs.rmSync(DST, { recursive: true, force: true });
});

ok('历史遗留的绝对路径记录仍然可读（向后兼容）', () => {
  const k = store.keyOf(URL_JS + '#legacy');
  const p = store.beginPending(k, URL_JS + '#legacy', cfg);
  fs.mkdirSync(path.dirname(p.bodyFile), { recursive: true });
  fs.writeFileSync(p.bodyFile, Buffer.from('legacy'));
  // 手工把 pending 改回「老格式」：绝对路径
  const pending = JSON.parse(fs.readFileSync(store.pendingPath(k), 'utf8'));
  pending.dir = p.dir;
  pending.bodyFile = p.bodyFile;
  fs.writeFileSync(store.pendingPath(k), JSON.stringify(pending));

  store.commitPending(k, 200, RES_HEADERS, cfg);
  const hit = store.lookup(k, URL_JS + '#legacy', cfg);
  assert.ok(hit, '老格式的绝对路径记录应仍可提升');
  assert.strictEqual(hit.bodyFile, p.bodyFile);
});

console.log('\n【LRU 淘汰】');
ok('超过 maxSize 触发淘汰', () => {
  const oneMB = Buffer.alloc(1024 * 1024, 7);
  for (let i = 0; i < 6; i++) {
    const u = 'https://www.figma.com/webpack-artifacts/assets/chunk' + i + '-aaaaaaaaaaaaaaaa.min.js';
    const k = store.keyOf(u);
    const p = store.beginPending(k, u, cfg);
    fs.writeFileSync(p.bodyFile, oneMB);
    store.commitPending(k, 200, RES_HEADERS, cfg);
    store.lookup(k, u, cfg);
  }
  const s = store.getStats();
  assert.ok(s.totalBytes <= 4 * 1024 * 1024, '淘汰后仍超限：' + s.totalMB + 'MB');
  assert.ok(store.counters.evicted > 0, '未发生淘汰');
});

console.log('\n【清空】');
ok('clear() 后统计归零', () => {
  store.clear();
  const s = store.getStats();
  assert.strictEqual(s.files, 0);
  assert.strictEqual(s.totalBytes, 0);
});

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}

console.log('\n────────────────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
