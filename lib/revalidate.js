'use strict';

/**
 * 后台静默校验（Stale-While-Revalidate）
 *
 * 命中缓存时会立刻把本地文件交给 Figma，同时（在有冷却期约束的前提下）
 * 在后台对同一个 URL 发起一次**条件请求**，用返回结果静默更新缓存：
 *
 *   304 Not Modified  → 只刷新 validatedAt，传输量约 0.5 KB，几乎零成本
 *   200 OK            → 内容真的变了 → 原子替换本地缓存
 *   其它              → 丢弃，绝不动缓存
 *
 * 为什么用条件请求而不是直接重下：
 *   Figma 的静态资源每次刷新都要重新下载数十 MB。若每次命中都重下，
 *   流量直接翻倍。带 If-None-Match 之后，绝大多数请求只会产生一个 304。
 *
 * 安全护栏（任何一条不满足都不替换缓存）：
 *   · 必须是 200 且通过 policy.checkResponse（非 HTML、无 Set-Cookie、非 no-store）
 *   · Content-Type 必须与缓存中记录的完全一致
 *     —— 这道护栏专门用来挡住「被重定向到登录页/错误页」把缓存写坏
 *   · body 非空且不超过上限
 *
 * 所有后台请求都是 fire-and-forget，任何异常都被吞掉，绝不影响前台响应。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const store = require('./store');
const policy = require('./policy');

const MAX_CONCURRENCY = 4;
const TIMEOUT_MS = 30000;
const MAX_BODY_SIZE = 64 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 正在校验或排队中的 key，避免同一资源被重复触发 */
const inflight = new Set();
const queue = [];
let running = 0;

/**
 * 是否需要为这个条目安排后台校验
 */
function shouldRevalidate(key, meta, cfg) {
  if (!cfg || cfg.revalidate === -1) {
    return false; // 显式关闭
  }
  if (inflight.has(key)) {
    return false;
  }
  if (key.indexOf('\u0000') !== -1) {
    return false;
  }
  if (cfg.revalidate > 0) {
    const last = Number(meta.validatedAt || meta.createdAt) || 0;
    if (Date.now() - last < cfg.revalidate * 1000) {
      return false; // 还在冷却期内
    }
  }
  return true;
}

/**
 * 安排一次后台校验（非阻塞）
 * @returns {boolean} 是否真的安排了
 */
function schedule(key, url, meta, cfg) {
  try {
    if (!shouldRevalidate(key, meta, cfg)) {
      return false;
    }
    inflight.add(key);
    queue.push({ key, url, meta, cfg });
    pump();
    return true;
  } catch (e) {
    inflight.delete(key);
    return false;
  }
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const task = queue.shift();
    running += 1;
    runTask(task, () => {
      running -= 1;
      inflight.delete(task.key);
      pump();
    });
  }
}

function decodeBody(buf, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') {
    return buf;
  }
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return zlib.gunzipSync(buf);
    }
    if (enc === 'deflate') {
      return zlib.inflateSync(buf);
    }
    if (enc === 'br') {
      return zlib.brotliDecompressSync(buf);
    }
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buf);
    }
  } catch (e) {
    return null;
  }
  return null; // 不认识的编码，宁可不缓存
}

function runTask(task, done) {
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    done();
  };

  let u;
  try {
    u = new URL(task.url);
  } catch (e) {
    return finish();
  }
  // 生产路径上只会出现 https（policy 已经卡过），允许 http 仅为了可测
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return finish();
  }

  const stored = (task.meta && task.meta.headers) || {};
  const headers = {
    // 关键：要求不压缩，这样拿到的字节与缓存里（whistle 解压后）的格式一致
    'Accept-Encoding': 'identity',
    'User-Agent': USER_AGENT,
    Accept: '*/*'
  };
  if (stored.etag) {
    headers['If-None-Match'] = stored.etag;
  }
  if (stored['last-modified']) {
    headers['If-Modified-Since'] = stored['last-modified'];
  }

  let req;
  try {
    const mod = u.protocol === 'http:' ? http : https;
    req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + (u.search || ''),
        method: 'GET',
        headers,
        // 后台请求直连源站，故意不走 whistle 的规则链，避免自己拦自己
        agent: false
      },
      (res) => {
        const status = res.statusCode || 0;

        // 304：内容没变，只刷新校验时间
        if (status === 304) {
          res.resume();
          store.touchValidation(task.key);
          return finish();
        }

        if (status !== 200) {
          res.resume();
          return finish();
        }

        const chunks = [];
        let size = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            aborted = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => {
          aborted = true;
          finish();
        });
        res.on('end', () => {
          if (aborted) {
            return finish();
          }

          const raw = Buffer.concat(chunks);
          const body = decodeBody(raw, res.headers['content-encoding']);
          if (!body || !body.length) {
            return finish();
          }

          // ── 护栏：任何一条不满足都不动缓存 ──
          if (!policy.checkResponse(status, res.headers).ok) {
            return finish();
          }
          const newType = String(res.headers['content-type'] || '');
          const oldType = String(task.meta.contentType || '');
          if (oldType && newType.split(';')[0].trim() !== oldType.split(';')[0].trim()) {
            // 类型变了 → 很可能是被重定向到了登录页/错误页，宁可不动
            return finish();
          }

          // 计数由 store.replaceBody / store.touchValidation 内部按 304 / 200 分别累加
          store.replaceBody(task.key, task.url, body, res.headers);
          return finish();
        });
      }
    );
  } catch (e) {
    return finish();
  }

  req.setTimeout(TIMEOUT_MS, () => {
    try {
      req.destroy();
    } catch (e) {
      /* ignore */
    }
    finish();
  });
  req.on('error', () => finish());
  req.end();
}

module.exports = { schedule, inflight, queue };
