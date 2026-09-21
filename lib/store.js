'use strict';

/**
 * 磁盘缓存存储层（规则版 + SWR）
 *
 * 配合 whistle 的 rulesServer / resRulesServer 钩子工作：
 *
 *   rulesServer (REQ_RULES)    命中 → 返回 file://…        本地回放，零网络
 *                              未命中 → 返回 resWrite://…   回源时顺手落盘
 *   resRulesServer (RES_RULES) 确认这是一次合格的 200 响应，给意向盖「可转正」标记
 *
 * 为什么转正要等到「下一次请求」而不是在 RES_RULES 里立刻做：
 *   whistle 的 resWrite 是边收边写，RES_RULES 触发时 body 往往还没写完。
 *   所以 RES_RULES 只标记，真正的转正由下一次 lookup() 在确认
 *   「文件存在 + 非空 + mtime 已静默」之后完成。这样既避开时序问题，
 *   也顺带保证不会把半截文件当成完整缓存发出去。
 *
 * body/<哈希前2位>/<sha1>.<nonce>.<ext>   响应体（whistle 解压后写入）
 * meta/<哈希前2位>/<sha1>.json            正式缓存记录
 * pending/<哈希前2位>/<sha1>.json         本次回源的意向（等待下一次请求转正）
 *
 * 全部同步 IO：这是请求路径上的钩子，必须立刻给出结论。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const policy = require('./policy');

const EXT_BY_URL = [
  [/\.min\.js(?:\.br|\.gz)?$/i, '.js'],
  [/\.min\.css(?:\.br|\.gz)?$/i, '.css'],
  [/\.m?js(?:\.br|\.gz)?$/i, '.js'],
  [/\.css(?:\.br|\.gz)?$/i, '.css'],
  [/\.json(?:\.br|\.gz)?$/i, '.json'],
  [/\.wasm(?:\.br|\.gz)?$/i, '.wasm'],
  [/\.woff2(?:\.br|\.gz)?$/i, '.woff2'],
  [/\.woff(?:\.br|\.gz)?$/i, '.woff'],
  [/\.svg(?:\.br|\.gz)?$/i, '.svg'],
  [/\.png(?:\.br|\.gz)?$/i, '.png']
];

/** 孤儿 body 宽限期：刚 resWrite 出来、还没转正的先别删 */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * 待转正（pending）记录的最长保留时间。
 * 超过就当作废弃意向，连同 body 一起清掉，避免磁盘无界增长。
 */
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * body 写盘静默期的默认值。
 * whistle 的 resWrite 是边收边写，所以「文件存在」不等于「写完了」。
 * 用 mtime 距现在的时间做判断：超过这个阈值就认为写流已关闭。
 */
const DEFAULT_BODY_SETTLE_MS = 500;

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJsonSync(file, obj) {
  ensureDirSync(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.baseDir = null;
    /** Map<key, {size, atime, ctime, bodyFile}> */
    this.index = new Map();
    this.totalSize = 0;
    this.counters = {
      hit: 0,
      miss: 0,
      bypass: 0,
      stored: 0,
      // 后台静默校验：分开统计，便于看清它到底花了多少钱
      revalidated304: 0, // 内容未变，只刷新校验时间（body 0 字节）
      revalidated200: 0, // 内容真的变了，已原子替换
      revalidateBytes: 0, // 后台校验累计下载字节（仅 body）
      healed: 0,
      evicted: 0,
      bytesServed: 0
    };
    this._statsTimer = null;
  }

  // ── 路径 ────────────────────────────────────────────────────────────────
  keyOf(url) {
    return crypto.createHash('sha1').update(String(url)).digest('hex');
  }

  /**
   * 从 URL 推导扩展名。带扩展名的直接用；
   * static.figma.com/uploads/<hash> 这种没有扩展名的出现在 Figma 的
   * CSP script-src 里，就是 JS。
   */
  extFor(url) {
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch (e) {
      return '.js';
    }
    for (const [re, ext] of EXT_BY_URL) {
      if (re.test(pathname)) {
        return ext;
      }
    }
    return '.js';
  }

  shard(key) {
    return path.join(this.baseDir, String(key).slice(0, 2));
  }

  /**
   * 每个 URL 一个独立目录。
   *
   * whistle 的 file:// / resWrite:// 会自动把「匹配模式之后的剩余路径」拼到
   * 给定路径后面，所以必须传目录（以 / 结尾）让它自己拼，否则会出现
   * .../<key>.js/uploads/0706b... 这种叠加出来的多层路径。
   */
  bodyDirFor(key) {
    return path.join(this.shard(key), 'body', key);
  }

  /**
   * 落盘时把路径转成相对 baseDir 的形式。
   *
   * meta / pending 里存相对路径，整个 data/cache 目录就可以整体搬迁（换盘符、
   * 挪插件目录）而不会让已有缓存失效。不在 baseDir 下的路径理论上不会出现，
   * 一旦出现就保持原样，不做猜测。
   */
  _toRel(p) {
    if (!p || !path.isAbsolute(p)) {
      return p; // 已经是相对路径
    }
    const rel = path.relative(this.baseDir, p);
    return rel && rel.indexOf('..') !== 0 ? rel : p;
  }

  /** 相对路径还原为绝对路径；兼容历史遗留的绝对路径记录 */
  _toAbs(p) {
    if (!p) {
      return p;
    }
    return path.isAbsolute(p) ? p : path.resolve(this.baseDir, p);
  }

  /** URL 的剩余路径（去掉前导 /），也就是 whistle 自动拼接的那段 */
  relPathFor(url) {
    try {
      return new URL(url).pathname.replace(/^\/+/, '');
    } catch (e) {
      return this.keyOf(url);
    }
  }

  metaPath(key) {
    return path.join(this.shard(key), 'meta', key + '.json');
  }

  pendingPath(key) {
    return path.join(this.shard(key), 'pending', key + '.json');
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  use(cfg) {
    if (this.baseDir === cfg.dir) {
      return;
    }
    this.baseDir = cfg.dir;
    this.index = new Map();
    this.totalSize = 0;
    ensureDirSync(this.baseDir);
    this._buildIndexSync();
    this._startStatsTimer();
  }

  _buildIndexSync() {
    let shards;
    try {
      shards = fs.readdirSync(this.baseDir);
    } catch (e) {
      return;
    }
    for (const shard of shards) {
      const metaDir = path.join(this.baseDir, shard, 'meta');
      let files;
      try {
        files = fs.readdirSync(metaDir);
      } catch (e) {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const meta = readJsonSafe(path.join(metaDir, file));
        if (!meta || !meta.bodyFile) {
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(this._toAbs(meta.bodyFile)).size;
        } catch (e) {
          continue;
        }
        const key = file.slice(0, -5);
        this.index.set(key, {
          size,
          ctime: Number(meta.createdAt) || Date.now(),
          atime: Number(meta.lastHitAt) || Date.now()
        });
        this.totalSize += size;
      }
    }
  }

  _startStatsTimer() {
    if (this._statsTimer) {
      return;
    }
    this._statsTimer = setInterval(() => {
      try {
        this.persistStats();
      } catch (e) {
        /* ignore */
      }
    }, 60000);
    if (this._statsTimer.unref) {
      this._statsTimer.unref();
    }
  }

  // ── 命中判定 ────────────────────────────────────────────────────────────
  /**
   * @returns {{bodyFile:string, ext:string, meta:object, size:number}|null}
   */
  lookup(key, url, cfg) {
    // ① 已有正式记录
    const meta = readJsonSafe(this.metaPath(key));
    if (meta) {
      const usable = meta.status === 200 && meta.bodyFile;
      const okTtl =
        cfg.ttl <= 0 || Date.now() - (Number(meta.createdAt) || 0) <= cfg.ttl * 1000;
      let stat = null;
      if (usable && okTtl) {
        try {
          stat = fs.statSync(this._toAbs(meta.bodyFile));
        } catch (e) {
          stat = null;
        }
      }
      if (stat && stat.isFile() && stat.size > 0) {
        meta.lastHitAt = Date.now();
        const entry = this.index.get(key);
        if (entry) {
          entry.atime = Date.now();
          if (entry.size !== stat.size) {
            this.totalSize -= entry.size;
            entry.size = stat.size;
            this.totalSize += stat.size;
            this.counters.healed += 1; // 大小被外部改过 → 已修正
          }
        }
        try {
          writeJsonSync(this.metaPath(key), meta);
        } catch (e) {
          /* 统计信息写失败不影响命中 */
        }
        this.counters.hit += 1;
        this.counters.bytesServed += stat.size;
        return {
          dir: this._toAbs(meta.dir),
          bodyFile: this._toAbs(meta.bodyFile),
          ext: meta.ext || this.extFor(url),
          meta,
          size: stat.size
        };
      }
      this.forget(key);
    }

    // ② 尝试把「上回已经回源完成」的意向转正
    return this._tryPromote(key, cfg);
  }

  /**
   * 把 pending 提升为正式缓存条目。必须同时满足：
   *   · RES_RULES 已确认这是一次合格的 200 响应（pending.commit）
   *   · body 文件存在且非空
   *   · body 的 mtime 已静默超过 BODY_SETTLE_MS（写流已关闭，不会读到半截）
   */
  _tryPromote(key, cfg) {
    const pending = readJsonSafe(this.pendingPath(key));
    if (!pending || !pending.commit || !pending.bodyFile) {
      return null;
    }

    let stat;
    try {
      stat = fs.statSync(this._toAbs(pending.bodyFile));
    } catch (e) {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }
    // 注意：Date.now() 是整数毫秒，而 stat.mtimeMs 带小数，两者相减可能得负数。
    // 所以 settleMs 为 0 时必须直接跳过检查，不能写成 age < settleMs（-0.7 < 0 会误判）。
    const settleMs = cfg.bodySettleMs != null ? cfg.bodySettleMs : DEFAULT_BODY_SETTLE_MS;
    if (settleMs > 0 && Date.now() - stat.mtimeMs < settleMs) {
      return null; // 写流可能还没关闭，再等下一轮
    }

    const now = Date.now();
    const meta = {
      url: pending.url,
      ext: pending.ext,
      dir: pending.dir,
      bodyFile: pending.bodyFile,
      status: 200,
      size: stat.size,
      headers: pending.headers || {},
      contentType: pending.contentType || '',
      createdAt: Number(pending.at) || now,
      lastHitAt: now,
      validatedAt: now,
      hits: 0
    };
    writeJsonSync(this.metaPath(key), meta);
    this.dropPending(key);

    const prev = this.index.get(key);
    if (prev) {
      this.totalSize -= prev.size;
    }
    this.index.set(key, {
      size: stat.size,
      ctime: meta.createdAt,
      atime: now,
      bodyFile: meta.bodyFile
    });
    this.totalSize += stat.size;
    this.counters.stored += 1;
    this.sweep(cfg);

    this.counters.hit += 1;
    this.counters.bytesServed += stat.size;
    return {
      dir: this._toAbs(meta.dir),
      bodyFile: this._toAbs(meta.bodyFile),
      ext: meta.ext,
      meta,
      size: stat.size
    };
  }

  // ── 落盘意向 ────────────────────────────────────────────────────────────
  newNonce() {
    return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  }

  /**
   * 未命中时调用：算出目录与最终落盘路径，并记下意向
   * @returns {{dir:string, bodyFile:string, ext:string}}
   */
  beginPending(key, url, cfg) {
    const ext = this.extFor(url);
    const relPath = this.relPathFor(url);
    const dir = this.bodyDirFor(key);
    const bodyFile = path.join(dir, relPath);
    ensureDirSync(dir);
    writeJsonSync(this.pendingPath(key), {
      url,
      ext,
      // 存相对路径（见 _toRel）
      dir: this._toRel(dir),
      relPath,
      bodyFile: this._toRel(bodyFile),
      at: Date.now()
    });
    // 对外仍然返回绝对路径：whistle 的 resWrite 规则需要真实路径
    return { dir, bodyFile, ext };
  }

  hasPending(key) {
    try {
      return fs.statSync(this.pendingPath(key)).isFile();
    } catch (e) {
      return false;
    }
  }

  /**
   * RES_RULES 阶段调用：确认这是一次合格的 200 响应，给意向盖上「可转正」标记。
   * 此刻 body 往往还没写完，所以这里不生成 meta。
   * @returns {{ok:boolean, reason:string}}
   */
  commitPending(key, status, resHeaders, cfg) {
    const pending = readJsonSafe(this.pendingPath(key));
    if (!pending) {
      return { ok: false, reason: 'no-pending' };
    }
    if (status !== 200) {
      this.dropPending(key);
      return { ok: false, reason: 'status-' + status };
    }
    const check = policy.checkResponse(status, resHeaders);
    if (!check.ok) {
      this.dropPending(key);
      return { ok: false, reason: check.reason };
    }

    const headers = policy.pickStoreHeaders(resHeaders, 0);
    delete headers['content-length']; // 回放时由 file:// 自己算

    pending.commit = Date.now();
    pending.headers = headers;
    pending.contentType = resHeaders['content-type'] || '';
    writeJsonSync(this.pendingPath(key), pending);
    return { ok: true, reason: 'committed' };
  }

  dropPending(key) {
    try {
      fs.unlinkSync(this.pendingPath(key));
    } catch (e) {
      /* ignore */
    }
  }

  // ── SWR：后台校验后的落盘 ───────────────────────────────────────────────
  /**
   * 条件请求返回 304：只刷新「已验证时间」
   */
  touchValidation(key) {
    const meta = readJsonSafe(this.metaPath(key));
    if (!meta) {
      return false;
    }
    meta.validatedAt = Date.now();
    try {
      writeJsonSync(this.metaPath(key), meta);
      this.counters.revalidated304 += 1;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 条件请求返回 200：原子替换 body 与 meta
   * 先写临时文件再 rename，保证读者永远看到完整内容
   * @returns {{ok:boolean, reason:string, size?:number}}
   */
  replaceBody(key, url, buf, resHeaders) {
    const meta = readJsonSafe(this.metaPath(key));
    if (!meta || !meta.bodyFile) {
      return { ok: false, reason: 'no-meta' };
    }
    if (!buf || !buf.length) {
      return { ok: false, reason: 'empty-body' };
    }

    const bodyAbs = this._toAbs(meta.bodyFile);
    const dir = path.dirname(bodyAbs);
    const tmp = path.join(dir, '.' + key + '.new-' + Date.now());
    try {
      ensureDirSync(dir);
      fs.writeFileSync(tmp, buf);
      // 同目录 rename：Windows 上 libuv 以 FILE_SHARE_DELETE 打开，允许覆盖
      fs.renameSync(tmp, bodyAbs);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {
        /* ignore */
      }
      return { ok: false, reason: 'rename-failed' };
    }

    const headers = policy.pickStoreHeaders(resHeaders, buf.length);
    delete headers['content-length'];

    const next = Object.assign({}, meta, {
      size: buf.length,
      headers,
      contentType: resHeaders['content-type'] || meta.contentType,
      lastHitAt: Date.now(),
      validatedAt: Date.now(),
      updatedAt: Date.now()
    });
    try {
      writeJsonSync(this.metaPath(key), next);
    } catch (e) {
      return { ok: false, reason: 'meta-write-failed' };
    }

    const entry = this.index.get(key);
    if (entry) {
      this.totalSize -= entry.size;
      entry.size = buf.length;
      entry.atime = Date.now();
      this.totalSize += buf.length;
    }
    this.counters.revalidated200 += 1;
    this.counters.revalidateBytes += buf.length;
    return { ok: true, reason: 'replaced', size: buf.length };
  }

  // ── 淘汰 ────────────────────────────────────────────────────────────────
  forget(key) {
    const entry = this.index.get(key);
    if (entry) {
      this.totalSize -= entry.size;
      this.index.delete(key);
    }
    // body 现在是「一个 URL 一个目录」，整目录删掉
    try {
      fs.rmSync(this.bodyDirFor(key), { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.metaPath(key));
    } catch (e) {
      /* ignore */
    }
    this.dropPending(key);
  }

  sweep(cfg) {
    const limit = cfg.maxSize * 1024 * 1024;
    if (this.totalSize > limit) {
      const target = limit * 0.9;
      const items = Array.from(this.index.entries())
        .map(([key, val]) => ({ key, atime: val.atime, size: val.size }))
        .sort((a, b) => a.atime - b.atime);
      for (const item of items) {
        if (this.totalSize <= target) {
          break;
        }
        this.forget(item.key);
        this.counters.evicted += 1;
      }
    }
    this._sweepOrphans();
  }

  /**
   * 清理孤儿 body 目录。
   *
   * 【关键】不能只按 index 判断：index 里只有「已转正」的条目，而刚落盘、
   * 等着下一次请求转正的 body 并不在 index 里。如果把它们当孤儿删了，
   * 下次请求就没东西可转正，只能重新下载 —— 缓存永远建不起来。
   *
   * 所以：有 pending 意向的一律保留；同时清理超过保留期（默认 7 天）
   * 的废弃意向，防止磁盘无界增长。
   */
  _sweepOrphans() {
    const now = Date.now();
    let shards;
    try {
      shards = fs.readdirSync(this.baseDir);
    } catch (e) {
      return;
    }
    for (const shard of shards) {
      const bodyRoot = path.join(this.baseDir, shard, 'body');
      let dirs;
      try {
        dirs = fs.readdirSync(bodyRoot);
      } catch (e) {
        continue;
      }
      for (const name of dirs) {
        if (this.index.has(name)) {
          continue; // 已转正
        }

        const pending = readJsonSafe(this.pendingPath(name));
        if (pending) {
          const age = now - (Number(pending.at) || 0);
          if (age < PENDING_MAX_AGE_MS) {
            continue; // 等着转正，不能删
          }
          // 意向已过期 → 连同 body 一起清掉
          this.forget(name);
          this.counters.evicted += 1;
          continue;
        }

        const full = path.join(bodyRoot, name);
        try {
          if (now - fs.statSync(full).mtimeMs > ORPHAN_GRACE_MS) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  // ── 统计 / 维护 ─────────────────────────────────────────────────────────
  bump(name) {
    if (this.counters[name] != null) {
      this.counters[name] += 1;
    }
  }

  /** 累加型计数器（字节数等） */
  bumpBytes(name, n) {
    if (this.counters[name] != null && isFinite(n)) {
      this.counters[name] += n;
    }
  }

  getStats() {
    return {
      dir: this.baseDir,
      files: this.index.size,
      totalBytes: this.totalSize,
      totalMB: Math.round((this.totalSize / 1048576) * 10) / 10,
      counters: Object.assign({}, this.counters)
    };
  }

  list(limit) {
    const max = Math.min(Number(limit) || 100, 1000);
    const out = [];
    for (const [key, entry] of this.index) {
      const meta = readJsonSafe(this.metaPath(key));
      if (!meta) {
        continue;
      }
      out.push({
        key,
        url: meta.url,
        size: entry.size,
        contentType: meta.contentType,
        createdAt: Number(meta.createdAt) || 0,
        lastHitAt: Number(meta.lastHitAt) || 0,
        validatedAt: Number(meta.validatedAt) || 0
      });
    }
    out.sort((a, b) => b.size - a.size);
    return out.slice(0, max);
  }

  clear() {
    const base = this.baseDir;
    this.index = new Map();
    this.totalSize = 0;
    if (!base) {
      return true;
    }
    let shards = [];
    try {
      shards = fs.readdirSync(base);
    } catch (e) {
      /* ignore */
    }
    for (const shard of shards) {
      for (const kind of ['body', 'meta', 'pending']) {
        try {
          fs.rmSync(path.join(base, shard, kind), { recursive: true, force: true });
        } catch (e) {
          /* ignore */
        }
      }
    }
    this.counters.evicted = 0;
    return true;
  }

  persistStats() {
    if (!this.baseDir) {
      return;
    }
    try {
      fs.writeFileSync(
        path.join(this.baseDir, 'stats.json'),
        JSON.stringify({
          updatedAt: Date.now(),
          counters: this.counters,
          files: this.index.size,
          totalBytes: this.totalSize
        })
      );
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = new Store();
