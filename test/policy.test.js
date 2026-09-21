'use strict';

/**
 * 安全策略自测
 *
 * 这是本插件最重要的测试：白名单必须精确。
 *   漏放行 → 功能不生效（可接受）
 *   误放行 → 可能缓存画布数据 / 签名地址，导致 FIgma 拿不到最新数据（不可接受）
 *
 * 运行： node test/policy.test.js
 */

const assert = require('assert');
const policy = require('../lib/policy');

let pass = 0;
let fail = 0;

function ok(desc, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + desc);
  } catch (e) {
    fail += 1;
    console.log('  \u2717 ' + desc + '\n      ' + e.message);
  }
}

// ── 必须允许缓存：真实存在的 Figma 静态资源 ────────────────────────────────
console.log('\n【应当缓存】');
[
  'https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/svg-e33bc69de31f9edc.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/3866-6a39a297e15317ca.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/2342-604e061a68aebe6e.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/982-41f74e32b8b1c4ea.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/5608-2d9a2d471c1248ac.min.js.br',
  'https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.css',
  'https://figma.com/webpack-artifacts/assets/8468-e32fd5771d525c98.min.js.br',
  'https://static.figma.com/uploads/0706b46bdc09a419282285b791ea1dd3c019ecd6',
  'https://static.figma.com/uploads/539fd13ba437049b058e7e83fd54539c86878320'
].forEach((url) => {
  ok(url, () => {
    const r = policy.checkUrl(url);
    assert.strictEqual(r.ok, true, '被拒绝，原因=' + r.reason);
  });
});

// ── 必须拒绝：画布数据 / 文件内容 / 接口 / 签名地址 / 各种边界 ─────────────
console.log('\n【画布与文件数据 —— 绝不可缓存】');
[
  ['https://www.figma.com/api/graphql', 'GraphQL 接口'],
  ['https://www.figma.com/api/multiplayer', 'multiplayer 接口'],
  ['https://www.figma.com/file/PHyKtV1VgZ28AIFgR0wg8u/My-Design', '文件页'],
  ['https://www.figma.com/design/PHyKtV1VgZ28AIFgR0wg8u/My-Design', '设计页'],
  ['https://www.figma.com/design/PHyKtV1VgZ28AIFgR0wg8u/7af6798dd205e965a9f81b1815cf5931eb22f6cb.png', '画布内图片'],
  ['https://www.figma.com/design/p0XBnBPwtWXNGQ3Bs9C9NQ/e65f844fdc932798f562bee8673b739f99c62669.svg', '画布内 SVG'],
  ['https://www.figma.com/proto/abc/def', '原型数据'],
  ['https://www.figma.com/board/abc/def', 'FigJam 数据'],
  ['https://www.figma.com/api/figment-proxy/monitor', '内嵌接口'],
  ['https://api.figma.com/v1/files/abc123', 'REST API']
].forEach(([url, desc]) => {
  ok(desc + '  →  ' + url, () => {
    assert.strictEqual(policy.checkUrl(url).ok, false, '居然被允许了！');
  });
});

console.log('\n【用户内容 / 签名地址 —— 绝不可缓存】');
[
  ['https://s3-alpha.figma.com/s3/abc/123.png', 's3-alpha 用户素材'],
  ['https://s3-alpha-sig.figma.com/s3/abc/123.png?X-Amz-Signature=deadbeef', 's3-alpha-sig 签名地址'],
  ['https://figma-alpha-api.s3.us-west-2.amazonaws.com/s3/img/1.png', 'figma-alpha-api'],
  ['https://figma-private-data.s3.us-west-2.amazonaws.com/webpack-artifacts/x-1d532d39d96c5d27.min.js', '私有 S3 桶'],
  ['https://d1a2b3c4.cloudfront.net/uploads/0706b46bdc09a419282285b791ea1dd3c019ecd6', 'CloudFront 直链']
].forEach(([url, desc]) => {
  ok(desc + '  →  ' + url, () => {
    assert.strictEqual(policy.checkUrl(url).ok, false, '居然被允许了！');
  });
});

console.log('\n【边界与绕过尝试 —— 绝不可缓存】');
[
  ['https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br?token=abc', '带查询串（签名/令牌）'],
  ['https://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br?v=2', '带缓存破坏参数'],
  ['https://www.figma.com/webpack-artifacts/assets/vendor.js.br', '文件名没有内容哈希'],
  ['https://www.figma.com/webpack-artifacts/assets/vendor.min.js', '文件名没有内容哈希'],
  ['https://www.figma.com/webpack-artifacts/index.html', '非 assets 目录'],
  ['https://www.figma.com/webpack-artifacts/assets/index.html', 'HTML 文档'],
  ['http://www.figma.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br', '非 HTTPS'],
  ['https://evil.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br', '域名不匹配'],
  ['https://www.figma.com.evil.com/webpack-artifacts/assets/vendor-1d532d39d96c5d27.min.js.br', '域名后缀伪造'],
  ['https://static.figma.com.evil.com/uploads/0706b46bdc09a419282285b791ea1dd3c019ecd6', '域名后缀伪造 2'],
  ['https://static.figma.com/uploads/not-a-hash', '非哈希文件名'],
  ['https://static.figma.com/uploads/0706b46bdc09a419282285b791ea1dd3c019ecd6?x=1', '带查询串'],
  ['https://static.figma.com/fonts/figma-sans-1d532d39d96c5d27.woff2', '未经实测验证的路径（保守拒绝）'],
  ['not a url', '非法 URL'],
  ['', '空 URL']
].forEach(([url, desc]) => {
  ok(desc + '  →  ' + (url || '(空)'), () => {
    assert.strictEqual(policy.checkUrl(url).ok, false, '居然被允许了！');
  });
});

// ── 请求形态闸门 ───────────────────────────────────────────────────────────
console.log('\n【请求形态闸门】');
const base = { method: 'GET', headers: {} };
ok('普通 GET 通过', () => assert.strictEqual(policy.isSafeRequest(base), true));
ok('POST 拒绝', () => assert.strictEqual(policy.isSafeRequest({ method: 'POST', headers: {} }), false));
ok('WebSocket 升级拒绝', () =>
  assert.strictEqual(policy.isSafeRequest({ method: 'GET', headers: { upgrade: 'websocket' } }), false));
ok('Sec-WebSocket-Key 拒绝', () =>
  assert.strictEqual(policy.isSafeRequest({ method: 'GET', headers: { 'sec-websocket-key': 'x' } }), false));
ok('no-store 请求拒绝', () =>
  assert.strictEqual(policy.isSafeRequest({ method: 'GET', headers: { 'cache-control': 'no-store' } }), false));
ok('Range 请求拒绝', () =>
  assert.strictEqual(policy.isSafeRequest({ method: 'GET', headers: { range: 'bytes=0-100' } }), false));

// ── 响应形态闸门 ───────────────────────────────────────────────────────────
console.log('\n【响应形态闸门】');
ok('200 + js 通过', () =>
  assert.strictEqual(policy.checkResponse(200, { 'content-type': 'application/javascript' }).ok, true));
ok('206 拒绝', () => assert.strictEqual(policy.checkResponse(206, {}).ok, false));
ok('302 拒绝', () => assert.strictEqual(policy.checkResponse(302, {}).ok, false));
ok('404 拒绝', () => assert.strictEqual(policy.checkResponse(404, {}).ok, false));
ok('带 Set-Cookie 拒绝', () =>
  assert.strictEqual(policy.checkResponse(200, { 'set-cookie': 'a=1' }).ok, false));
ok('no-store 响应拒绝', () =>
  assert.strictEqual(policy.checkResponse(200, { 'cache-control': 'no-store' }).ok, false));
ok('private 响应拒绝', () =>
  assert.strictEqual(policy.checkResponse(200, { 'cache-control': 'private, max-age=0' }).ok, false));
ok('text/html 响应拒绝', () =>
  assert.strictEqual(policy.checkResponse(200, { 'content-type': 'text/html' }).ok, false));
ok('vary:* 拒绝', () => assert.strictEqual(policy.checkResponse(200, { vary: '*' }).ok, false));

// ── 响应头处理 ─────────────────────────────────────────────────────────────
console.log('\n【响应头处理】');
ok('content-length 以实际字节数为准', () => {
  const h = policy.pickStoreHeaders({ 'content-length': '99999', 'content-type': 'application/javascript' }, 1234);
  assert.strictEqual(h['content-length'], '1234');
});
ok('声明长度与字节数不符 → 摘掉 content-encoding', () => {
  const h = policy.pickStoreHeaders({ 'content-encoding': 'br', 'content-length': '500' }, 2000);
  assert.strictEqual(h['content-encoding'], undefined, '应当摘掉 content-encoding');
});
ok('声明长度与字节数一致 → 保留 content-encoding', () => {
  const h = policy.pickStoreHeaders({ 'content-encoding': 'br', 'content-length': '500' }, 500);
  assert.strictEqual(h['content-encoding'], 'br');
});
ok('set-cookie 不会被持久化', () => {
  const h = policy.pickStoreHeaders({ 'set-cookie': 'a=1', 'content-type': 'text/css' }, 10);
  assert.strictEqual(h['set-cookie'], undefined);
});
ok('回放头带长缓存 + HIT 标记', () => {
  const h = policy.buildReplayHeaders({ 'content-type': 'text/css' }, 42);
  assert.strictEqual(h['content-length'], '42');
  assert.ok(h['cache-control'].indexOf('immutable') !== -1);
  assert.strictEqual(h['x-figma-cache'], 'HIT');
});

console.log('\n────────────────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
