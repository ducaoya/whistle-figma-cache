'use strict';

/**
 * 配置解析
 *
 * 默认配置写死在代码里，rules.txt 里不带任何参数即可工作（零配置）。
 * 如需调整，可在 Rules 面板追加一条更高优先级的规则覆盖，例如：
 *
 *   www.figma.com/webpack-artifacts/  figma-cache://ttl=0,maxSize=8192,log=1
 *
 * 支持的参数：
 *   dir          缓存目录（绝对路径），默认 <插件目录>/data/cache
 *   ttl          缓存有效期，如 0 / 3600 / 30d / 12h；0 表示永不过期（默认）
 *                URL 内含内容哈希，语义上不可变，所以默认永不过期
 *   maxSize      缓存总量上限，单位 MB，默认 4096
 *   maxFileSize  单个文件缓存上限，单位 MB，默认 64
 *   revalidate   后台静默校验的冷却期，默认 24h；0 = 每次命中都校验；-1 = 关闭
 *   log          1 时在 Whistle 插件控制台打印 HIT/MISS/STORE 日志，默认 0
 */

const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  dir: path.join(PLUGIN_ROOT, 'data', 'cache'),
  ttl: 0,
  maxSize: 4096,
  maxFileSize: 64,
  revalidate: 86400,
  bodySettleMs: 500,
  log: 0
};

/**
 * 解析形如 "ttl=30d,maxSize=8192" 的参数串
 */
function parseParams(value) {
  const out = {};
  if (!value) {
    return out;
  }
  String(value)
    .split(/[,;]/)
    .forEach((seg) => {
      const idx = seg.indexOf('=');
      if (idx <= 0) {
        return;
      }
      const key = seg.slice(0, idx).trim();
      const val = seg.slice(idx + 1).trim();
      if (key) {
        out[key] = val;
      }
    });
  return out;
}

/**
 * 把 "30d" / "12h" / "600" 转成秒；非法值返回 fallback
 */
function toSeconds(input, fallback) {
  if (input == null || input === '') {
    return fallback;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i.exec(String(input).trim());
  if (!m) {
    return fallback;
  }
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n < 0) {
    return fallback;
  }
  const unit = (m[2] || 's').toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 1;
  return Math.round(n * factor);
}

function toPositiveNumber(input, fallback) {
  const n = parseFloat(input);
  return isFinite(n) && n > 0 ? n : fallback;
}

/** 毫秒参数（允许 0） */
function toMillis(input, fallback) {
  if (input == null || input === '') {
    return fallback;
  }
  const n = parseFloat(input);
  return isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 后台校验冷却期。
 *   86400 / 24h / 1d → 同一资源 24 小时内最多校验一次（默认）
 *   0                → 每次命中都校验
 *   -1 / off         → 完全关闭后台校验
 */
function toRevalidate(input, fallback) {
  if (input == null || input === '') {
    return fallback;
  }
  const s = String(input).trim().toLowerCase();
  if (s === '-1' || s === 'off' || s === 'false' || s === 'no' || s === 'none') {
    return -1;
  }
  return toSeconds(s, fallback);
}

const cacheByValue = new Map();

/**
 * 根据 ruleValue 得到生效配置（带缓存，避免每次请求重复解析）
 */
function resolveConfig(ruleValue) {
  const raw = ruleValue == null ? '' : String(ruleValue);
  if (cacheByValue.has(raw)) {
    return cacheByValue.get(raw);
  }

  const p = parseParams(raw);
  const cfg = {
    dir: p.dir ? path.resolve(p.dir) : DEFAULTS.dir,
    ttl: toSeconds(p.ttl, DEFAULTS.ttl),
    maxSize: toPositiveNumber(p.maxSize, DEFAULTS.maxSize),
    maxFileSize: toPositiveNumber(p.maxFileSize, DEFAULTS.maxFileSize),
    revalidate: toRevalidate(p.revalidate, DEFAULTS.revalidate),
    bodySettleMs: toMillis(p.bodySettle, DEFAULTS.bodySettleMs),
    log: String(p.log || '0') === '1' || String(p.log || '').toLowerCase() === 'true'
  };

  cacheByValue.set(raw, cfg);
  return cfg;
}

/**
 * 轻量日志（只在 log=1 时输出）。用 console.log 可被 Whistle 写入插件控制台。
 */
function log(cfg, ...args) {
  if (!cfg || !cfg.log) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.log('[figma-cache]', ...args);
  } catch (e) {
    /* ignore */
  }
}

module.exports = {
  PLUGIN_ROOT,
  DEFAULTS,
  resolveConfig,
  parseParams,
  toSeconds,
  log
};
