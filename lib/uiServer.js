'use strict';

/**
 * UI 服务模块
 *
 * 提供插件 Option 页面：查看缓存统计 / 命中率 / 已缓存条目，并支持一键清空。
 * whistle 会把请求路径标准化为 /whistle.figma-cache/...，所以这里统一用后缀匹配。
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const config = require('./config');

function sendJson(res, data, status) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

module.exports = (server) => {
  server.on('request', (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;
    } catch (e) {
      pathname = req.url || '/';
    }

    try {
      store.use(config.resolveConfig(''));

      // ── 首页 ──────────────────────────────────────────────────────────
      if (/\/$/.test(pathname) || /index\.html$/.test(pathname)) {
        const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
        if (fs.existsSync(htmlPath)) {
          sendHtml(res, fs.readFileSync(htmlPath, 'utf8'));
        } else {
          sendHtml(res, '<h1>whistle.figma-cache</h1><p>public/index.html 缺失</p>');
        }
        return;
      }

      // ── 统计 ──────────────────────────────────────────────────────────
      if (/\/cgi-bin\/stats$/.test(pathname)) {
        const stats = store.getStats();
        const c = stats.counters;
        const total = c.hit + c.miss;
        stats.hitRate = total > 0 ? ((c.hit / total) * 100).toFixed(1) + '%' : '-';
        stats.savedMB = Math.round((c.bytesServed / 1048576) * 10) / 10;
        sendJson(res, stats);
        return;
      }

      // ── 条目列表 ──────────────────────────────────────────────────────
      if (/\/cgi-bin\/entries$/.test(pathname)) {
        sendJson(res, store.list(200));
        return;
      }

      // ── 清空缓存 ──────────────────────────────────────────────────────
      if (/\/cgi-bin\/clear$/.test(pathname)) {
        store.clear();
        sendJson(res, { ok: true, message: '缓存已清空' });
        return;
      }

      sendJson(res, { ok: false, message: 'not found: ' + pathname }, 404);
    } catch (e) {
      sendJson(res, { ok: false, message: String((e && e.message) || e) }, 500);
    }
  });
};
