# AGENTS.md — 实现细节与维护手册

> 面向后续接手的 AI / 开发者。README 只讲「是什么、怎么用」，这里讲「为什么这么写、坑在哪」。
>
> **改动本插件前请先通读本文**，尤其是第 3 节的五个坑和第 4 节的时序模型 ——
> 它们都是实测踩出来的，凭直觉改会**静默失效**。

---

## 1. 项目定位与文件地图

给 Figma 桌面客户端做静态资源磁盘缓存。核心目标只有一个：

> **把每次刷新重复下载的编辑器资源，换成一次本地磁盘读取。**

```
whistle-figma-cache/
├── index.js                 入口：导出 3 个 whistle 钩子
├── rules.txt                内置规则（插件启用时自动加载）
├── package.json             whistleConfig / test 脚本
├── lib/
│   ├── policy.js            ★ 安全白名单 + 各类闸门（最重要的文件）
│   ├── rulesServer.js       REQ_RULES 钩子：命中回放 / 未命中落盘
│   ├── resRulesServer.js    RES_RULES 钩子：给落盘意向盖章
│   ├── revalidate.js        SWR 后台静默校验（条件请求）
│   ├── store.js             ★ 磁盘缓存 + 时序模型 + LRU
│   ├── config.js            参数解析与缓存
│   └── uiServer.js          状态页接口
├── public/index.html        状态页（两页：使用方式 / 数据）
├── test/                    4 个测试文件，126 项断言
├── legacy/                  早期 server hook 尝试（whistle 不派发该钩子，仅留存参考）
└── data/cache/              运行期生成
```

**依赖**：零运行时依赖（只用 Node 内置模块）。`legacy/` 不纳入 `npm test`。

---

## 2. 架构：为什么用「规则钩子」而不是「接管请求」

### 2.1 两条路都试过

| 方案 | 做法 | 结果 |
|---|---|---|
| **server hook**（接管请求） | `exports.server`，插件自己查缓存 / 回源 | ❌ 不被派发 |
| **规则钩子**（当前方案） | `exports.rulesServer` + `resRulesServer` | ✅ 实测可用 |

### 2.2 server hook 为什么不行（已用对照实验证明）

`lib/handlers/http-proxy.js` 是 `server` hook 的唯一入口：

```js
var protocol = req.options && req.options.protocol;
var plugin = !req.isWebProtocol && pluginMgr.getPlugin(protocol);
```

它要求 `req.options.protocol === '<插件名>:'`。而规则 `pattern whistle.<插件名>://` 走的是
`resolveWhistlePlugins` → `req.whistlePlugins`，**只喂给 REQ_RULES / RES_RULES / stats 钩子，不碰 server**。

**证据**（在 whistle 2.10.10 上实测）：

1. 用 `/cgi-bin/rules/project` 注入 `* statusCode://418` → 返回 418，说明规则注入机制是活的；
2. 注入 `whistle.<插件名>://` → 插件计数器始终不动；
3. 换成 `rule` 协议形式 `//<插件名>://` → 返回 **502 Unsupported protocol**，
   说明请求走到了 `http-proxy.js`，但 `allPlugins['<插件名>:']` 查不到。

**结论：该版本的 whistle 不把 URL 规则派发到 `server` hook。**

> `legacy/server-hook.js` 保留了那版实现。如果日后 whistle 修复了派发，
> 取消 `index.js` 里对应导出的注释即可启用。

### 2.3 当前方案的完整链路

```
Figma 请求 www.figma.com/webpack-artifacts/assets/xxx.min.js.br
   │
   ├─ rules.txt 命中 → 该请求被登记到 req.whistlePlugins
   │
   ├─ ① whistle 调用 REQ_RULES 钩子（rulesServer）
   │     命中磁盘 → '* file://<目录>/ resType://js cache://31536000'
   │                 → whistle 直接从本地回放，零网络
   │                 → 同时 revalidate.schedule() 发起后台条件请求
   │     未命中   → '* resWrite://<目录>/'
   │                 → whistle 照常回源，顺手把响应落盘
   │     不该管   → ''（完全不受影响）
   │
   └─ ② 响应阶段 whistle 调用 RES_RULES 钩子（resRulesServer）
         读 req.originalRes.statusCode + req.headers（此时语义是响应头）
         确认是合格的 200 → 给 pending 盖上 commit 标记
```

**关键：插件不需要 MITM、不需要独立端口、不需要改系统代理，生命周期天然跟随插件启停。**

---

## 3. 五个必须知道的坑（改动前必看）

### 坑 1：钩子返回的规则文本必须带匹配模式

whistle 的插件钩子返回的是**完整规则行**，形如 `模式 操作符://值`。

```js
// ❌ 静默失效：单 token 行会被当成 pattern（请求 URL 匹配表达式），不是操作符
return 'statusCode://418';

// ✅
return '* statusCode://418';
```

**没有任何报错**，请求照常返回 200，你会以为钩子没被调用。这是排查最久的一个坑。

### 坑 2：`resWrite` / `file://` 会自动拼接 URL 剩余路径

whistle 会把「匹配模式之后的剩余路径」拼到给定路径后面。传文件路径会得到叠出来的多层路径：

```
resWrite://C:/cache/body/<key>.js   →  实际写到  C:/cache/body/<key>.js/<URL 的 pathname>
```

**正确做法：传目录（以 `/` 结尾），让它自己拼。**

因此存储布局是「**一个 URL 一个目录**」：

```
data/cache/<哈希前2位>/
  body/<sha1>/<URL 的 pathname>     ← 响应体（whistle 解压后写入，二进制安全）
  meta/<sha1>.json                  ← 正式缓存记录
  pending/<sha1>.json               ← 本次回源的落盘意向（等转正）
```

`store.relPathFor(url)` = `new URL(url).pathname.replace(/^\/+/, '')`，两侧用同一套算法算路径。

**meta / pending 里存的是相对路径**（`store._toRel()`），读取时用 `store._toAbs()` 还原。
这样整个 `data/cache` 目录可以整体搬迁（换盘符 / 挪插件目录）而不会让已有缓存失效。
历史遗留的绝对路径记录仍能正常读取（`_toAbs` 会原样返回绝对路径），会自动兼容。
注意：`beginPending()` / `lookup()` 对外返回的**仍是绝对路径**，因为 whistle 的 `file://` 规则需要真实路径。

### 坑 3：`file://` 按扩展名猜 MIME，必须显式指定 `resType`

`static.figma.com/uploads/<contenthash>` 这类地址**本身没有扩展名**，
whistle 会把它猜成 `text/html` —— 浏览器拿到 JS 却按 HTML 解析，直接报错。

```js
// 从存储的 Content-Type 反推短名
parts.push('resType://' + resTypeOf(meta.contentType));   // js / css / json / html / xml
```

> **不能**用 `resHeaders://{content-type: application/javascript; charset=utf-8}` ——
> 规则文本按空白分词，值里的空格和分号会把规则拆散。
> `resHeader://key=value`（单数）**不是合法协议**，`protocols.js` 里只有 `resHeaders`。

### 坑 4：`Date.now()` 是整数毫秒，`stat.mtimeMs` 带小数

判断「body 是否写完」时：

```js
// ❌ age 可能是 -0.7（mtime 比 Date.now() 还"新"），settleMs=0 时被误判成"未静默"
if (Date.now() - stat.mtimeMs < settleMs) return null;

// ✅ settleMs 为 0 时直接跳过检查
if (settleMs > 0 && Date.now() - stat.mtimeMs < settleMs) return null;
```

表现为单测三次挂两次的 flaky。

### 坑 5：孤儿清理会误删待转正的 body

`_sweepOrphans()` **不能只按 `this.index` 判断**。index 里只有「已转正」的条目，
而刚落盘、等下一次请求转正的 body 不在 index 里 —— 会被当孤儿删掉，
下次请求无物可转正 → 重新下载 → **缓存永远建不起来**。

```js
if (this.index.has(name)) continue;                        // 已转正
const pending = readJsonSafe(this.pendingPath(name));
if (pending && age < PENDING_MAX_AGE_MS) continue;         // 等待转正，不能删
```

---

## 4. 时序模型：为什么转正要等到「下一次请求」

**问题**：whistle 的 `resWrite` 是边收边写的流式落盘。`RES_RULES` 钩子触发时，
body 往往**还没写完甚至还没开始写**，所以不能在那一刻就生成 meta。

**方案**：分两步，把「意向」和「转正」拆开。

```
REQ_RULES(未命中)  → beginPending()      写 pending/<key>.json（只有 url/ext/路径）
响应流              → whistle 的 resWrite 往盘上写 body
RES_RULES          → commitPending()     校验状态码与响应头，给 pending 盖 commit 标记

……之后任何一次对同一 URL 的请求……

REQ_RULES          → lookup() → _tryPromote()
                      条件：pending.commit 存在
                          + body 存在且非空
                          + body 的 mtime 已静默超过 bodySettleMs（默认 500ms）
                     满足 → 写 meta/ 并删 pending → 本次直接命中（file://）
                     不满足 → 返回 null，走未命中流程
```

**这个设计一次解决三个问题**：

1. **时序问题** —— 转正时 body 一定写完了（是上一次响应留下的）
2. **半截文件问题** —— `bodySettleMs` 静默期保证写流已关闭
3. **状态码可信问题** —— 状态码由 RES_RULES 单独确认，拿不到就放弃转正（宁可少缓存，不缓存错误页）

**代价**：一个 URL 的第一次请求总是 MISS，第二次起才 HIT。对 Figma 完全可接受
（同一资源每次刷新都会被重新请求）。

---

## 5. 安全设计（三层防护）

**缓存错了东西会让 Figma 拿不到最新数据。** 所以做了三层。

### 第 1 层：`rules.txt` 匹配范围极窄

```txt
www.figma.com/webpack-artifacts/  whistle.figma-cache://
static.figma.com/uploads/         whistle.figma-cache://
```

只匹配两条路径前缀，**不是整个域名**。WebSocket、`/api/`、`/file/`、`/design/`、
`s3-alpha*.figma.com` 全都不在匹配范围内。

### 第 2 层：`lib/policy.js` 白名单（独立于规则）

即使规则被误改成宽匹配，只要 URL 不满足白名单也**不会**被缓存：

```js
// 允许：域名精确匹配 + 文件名含内容哈希
{ host: /^(?:www\.)?figma\.com$/, path: /^\/webpack-artifacts\/assets\/...+-[0-9a-f]{8,}\.min\.(js|css)...$/ },
{ host: /^static\.figma\.com$/,   path: /^\/uploads\/[0-9a-f]{32,}$/ }
```

硬性拒绝（`DENY_HOST` / `DENY_PATH`）：

| 类别 | 拒绝内容 |
|---|---|
| 域名 | `s3-alpha.figma.com`、`s3-alpha-sig.figma.com`、`api.figma.com`、`*.amazonaws.com`、`*.cloudfront.net`、`figma-alpha-api.*` |
| 路径 | `/api/`、`/graphql`、`/file/`、`/design/`、`/board/`、`/proto/`、`/multiplayer`、`/render/`、`/export/` |
| URL | **任何带查询串的地址**（签名 token、缓存破坏参数） |
| 请求 | 非 `GET`、带 `Range`、`Cache-Control: no-store` |
| 协议 | 非 `https` |
| 升级 | 带 `Upgrade` / `Sec-WebSocket-Key` 的请求 |

### 第 3 层：响应侧闸门

`policy.checkResponse(status, headers)`：状态码必须 `200`、无 `Set-Cookie`、
`Cache-Control` 不含 `no-store`/`private`、`Content-Type` 不是 `text/html`、`Vary` 不是 `*`。

**SWR 还有一道额外的内容类型护栏**：后台校验拿到的新响应 `Content-Type` 必须与缓存里记录的
完全一致，否则**绝不替换** —— 专门挡住「被重定向到登录页 / 错误页把缓存写坏」。

### 二进制安全

- whistle 的 `resWrite` 落盘的是**解压后**字节（`addZipTransform` 会置 `_needGunzip`，并删掉 `content-length`）
- 后台校验请求带 `Accept-Encoding: identity`，拿到压缩响应也会先 `zlib` 解压再存
- 命中时 `resType://` 修正 MIME，`file://` 自己算 `Content-Length`

---

## 6. SWR（后台静默校验）

命中时（在冷却期外）在后台对同一 URL 发一次**条件请求**：

```
If-None-Match: <存储的 etag>
If-Modified-Since: <存储的 last-modified>

304  → store.touchValidation()  只刷新 validatedAt，body 0 字节
200  → store.replaceBody()      内容真变了 → 临时文件 + rename 原子替换
其它 → 忽略，绝不动缓存
```

**成本控制**：

| 手段 | 说明 |
|---|---|
| 冷却期 | `revalidate` 默认 24h，同一资源一天最多校验一次 |
| 条件请求 | 绝大多数返回 304，**body 0 字节** |
| 并发上限 | `MAX_CONCURRENCY = 4` |
| 去重 | `inflight` Set，同一 key 同时只跑一个 |
| 内容类型护栏 | 见第 5 节 |

Figma 的 CDN 实测支持条件请求（带 `If-None-Match` 返回 304 / 0 字节）。

**后台请求直连源站**（`agent: false`，不走 whistle），避免自己拦自己形成死循环。
副作用：不会经过用户自己的 whistle 规则。

`replaceBody` 用**同目录临时文件 + `fs.renameSync`** 原子替换。
Windows 上 libuv 以 `FILE_SHARE_DELETE` 打开文件，所以覆盖正在被读的文件不会失败。

---

## 7. 配置解析（lib/config.js）

按 `ruleValue` 字符串缓存（`cacheByValue` Map），避免每请求重复解析。

| 参数 | 默认 | 解析函数 | 备注 |
|---|---|---|---|
| `dir` | `<插件目录>/data/cache` | `path.resolve` | **不能带空格**（规则文本按空白分词） |
| `ttl` | 0（永久） | `toSeconds`（支持 `30d`/`12h`） | URL 含内容哈希，语义上不可变 |
| `maxSize` | 4096 MB | `toPositiveNumber` | LRU 依据 |
| `maxFileSize` | 64 MB | `toPositiveNumber` | 超出不缓存，仍正常透传 |
| `revalidate` | 86400 | `toRevalidate`（`-1`/`off` = 关闭） | |
| `bodySettle` | 500 ms | `toMillis` | 测试里设 0 让提升立即发生 |
| `log` | 0 | — | 设 1 打印 HIT/MISS/PEND/SKIP |

---

## 8. 测试策略（126 项）

```bash
npm test              # 全部 130 项
npm run test:policy   # 60 项：白名单 / 各类闸门
npm run test:store    # 31 项：时序模型 / 原子替换 / LRU / 孤儿清理 / 相对路径搬迁
npm run test:hooks    # 24 项：两个钩子的规则产出与完整闭环
npm run test:swr      # 15 项：后台校验（起一个真实本地 HTTP 服务）
```

**设计原则**：

- `policy.test.js` 里**「必须拒绝」的用例数量远多于「必须通过」**——误放行才是真事故
- 覆盖域名后缀伪造（如 `www.figma.com.evil.com`）、画布内图片、带 token 的签名地址
- `hooks.test.js` **mock 了 whistle 的钩子契约**（`req.originalReq` / `req.originalRes` / `req.headers`
  在 REQ_RULES 与 RES_RULES 阶段语义不同），不需要真跑 whistle
- `store.test.js` 里 monkey-patch 了 `fs.writeFileSync` 自动补父目录（因为测试直接写 body，
  而真实环境是 whistle 的 resWrite 负责建目录）
- `revalidate.test.js` 用真实 HTTP 服务 + `waitIdle()` 轮询，
  覆盖 304 / 200 / 类型变化 / 5xx / 压缩 / 冷却期 / 去重 / 连接失败

**测试里的一个陷阱**：`pending` / `meta` 存的是**相对路径**。测试如果需要直接读写 body 文件，
必须先过了 `store._toAbs()`，否则会写到 `process.cwd()` 下面（表现为「提升失败」但没有任何报错）。

**改动后务必连跑 3 轮** —— 第 3 节的坑 4 曾经让测试三次挂两次。

---

## 9. 已确认的技术事实（别再重新验证一遍）

| 事实 | 依据 |
|---|---|
| **Figma 只读 `HKLM\Software\Figma`** | app.asar 里：`reg query ${NODE_ENV==="test" ? "HKCU" : "HKLM"}\Software\Figma`。写 HKCU 被**静默忽略**，不报错 |
| Figma 在**启动时一次性**读取该配置 | app.asar 里有 `To == null` 的缓存判断，改注册表后必须重启 |
| Figma CDN 支持条件请求 | 带 `If-None-Match` 返回 304 / 0 字节 |
| `file://` 回放比网络快一个数量级 | 同一资源本地回放 45 MB/s，直连网络约 600 KB/s |
| whistle 的 `resWrite` 落盘是解压后内容 | `lib/init.js` 的 `addZipTransform` 会置 `res._needGunzip` 并删 `content-length` |
| Chromium 默认 HTTP 缓存配额很小 | 实测长时间稳定在 80–100 MB 区间，写入量一大就驱逐 |
| `--disk-cache-size` 对 Electron 无效 | 进程命令行确认带上该参数，但 Chromium 缓存占用没有变化 |
| `cache://` 协议能设置命中响应的缓存头 | 命中响应出现 `cache-control: max-age=...` 与 `expires` |

### 关于性能优化边界

消除网络成本之后，加载仍然需要可观测的一段时间。实测该阶段：

- **网络不饱和**（远低于链路带宽上限）
- **CPU 也不饱和**（只占单核量级，远未跑满多核）

即既不是网络瓶颈也不是 CPU 瓶颈，而是**串行流水线**特征：请求 → 解析 → 编译 → 渲染，
绝大部分落在单核上，任何一环都在等下一环。**这部分客户端开销缓存无法优化。**

> 另注：给命中响应加 `Cache-Control`（`cache://31536000`）实测**没有带来可测量的改善** ——
> 多轮加载耗时基本一致。保留它是因为语义正确、无副作用，但不要指望它提速。

---

## 10. 调试手册

### 计数器不动？

```bash
# 1. 插件是否被调用（miss 是否增长）
curl -s "http://127.0.0.1:<端口>/plugin.figma-cache/cgi-bin/stats"

# 2. 客户端是否在用代理（应全部指向 127.0.0.1:<端口>，直连 443 应为 0）
#    PowerShell:
#    $ids=(Get-Process Figma).Id
#    Get-NetTCPConnection -State Established | ? { $ids -contains $_.OwningProcess } |
#      Group-Object RemotePort
```

- `bypass` 在涨但 `miss` 不动 → 请求进了插件但被 policy 拒了，开 `log=1` 看 BYPASS 原因
- 连 `bypass` 都不动 → 请求压根没进插件，检查 `rules.txt` 是否加载、插件是否启用

### 想看详细日志

临时加一条更高优先级的规则。**注意字段是 `rules=` 不是 `data=`，且接口是 `/cgi-bin/rules/project`**：

```bash
# 创建并置顶启用（top=1）
curl -X POST -u <用户>:<密码> \
  --data-urlencode "name=__debug" --data-urlencode "enable=1&top=1" --data-urlencode "groupName=" \
  "http://127.0.0.1:<端口>/cgi-bin/rules/project"

# 写入规则
curl -X POST -u <用户>:<密码> \
  --data-urlencode "name=__debug" \
  --data-urlencode "rules=static.figma.com/uploads/ figma-cache://log=1" \
  --data-urlencode "groupName=" \
  "http://127.0.0.1:<端口>/cgi-bin/rules/project"

# 用完删掉
curl -X POST -u <用户>:<密码> --data-urlencode "name=__debug" \
  "http://127.0.0.1:<端口>/cgi-bin/rules/remove"
```

> ⚠ `/cgi-bin/rules/add` 接口**不保存 `data` 字段** —— 用它会创建出**空规则组**，
> 而且返回 `{"ec":0}` 看起来像成功。排查时用它会白费大量功夫。

### 验证某个 URL 会不会被缓存

```bash
node -e "const p=require('./lib/policy'); console.log(p.checkUrl('<URL>'))"
```

### 缓存目录排查

```bash
find data/cache -path '*pending*' -name '*.json' | wc -l   # 待转正
find data/cache -path '*meta*' -name '*.json' | wc -l      # 已转正
find data/cache -path '*/body/*' -type f | wc -l           # 响应体
du -sh data/cache
```

`meta` 数量长期远小于 `pending` → 提升没发生，检查 `bodySettle` 与 RES_RULES 是否拿到状态码。

---

## 11. 已知限制

1. **首次加载仍然慢** —— 必须回源填缓存。
2. **`x-figma-cache` 之类的调试响应头加不上** —— `resHeaders` 在 `file://` 回放场景下不生效，
   规则文本又受空白分词限制。可观测性靠状态页计数器。
3. **依赖 whistle 提供状态码** —— RES_RULES 阶段拿不到 `_statusCode` 时主动放弃转正。
4. **缓存目录路径不能带空格**。
5. **未转正的 body 不计入 `maxSize`** —— 它们不在 index 里，LRU 管不到。
   目前靠 `PENDING_MAX_AGE_MS`（7 天）兜底清理。
6. **后台校验请求不走 whistle 的规则链** —— 直连源站。
7. **`cache://` 让 Chromium 也缓存** → Chromium 自己的缓存会跟着 churn。
   实测无性能影响；若要减少磁盘 IO，可改成 `cache://no-store` 让 Chromium 每次都问我们。

## 12. 未解之谜（留待后续）

- **加载期间剩余的客户端计算具体花在哪**：V8 解析 JS？WASM 编译？文档渲染？
  没有对 Figma 内部做 profiling，无法定论。
- **`Code Cache/wasm` 频繁被改写**：究竟是 LRU 时间戳刷新还是真的在重编译，
  未验证（用目录总大小的变化可以区分，尚未做）。
- **`server` hook 的正确触发语法**：可能是某个协议别名，也可能该版本已移除 URL 规则入口。
  建议去 whistle 仓库确认。

---

## 13. 运维速查

| 项 | 说明 |
|---|---|
| 插件安装位置 | whistle 的 `custom_plugins` 目录下，形如 `<WhistleAppData>/custom_plugins/whistle.figma-cache/node_modules/whistle.figma-cache` |
| 常见做法 | 该路径做成指向开发目录的符号链接，改代码即时生效 |
| 重启 whistle | `w2 restart`（会重置计数器，但**磁盘缓存保留**） |
| 状态页 | `http://127.0.0.1:<端口>/plugin.figma-cache/` |
| 状态接口 | `.../cgi-bin/stats`、`.../cgi-bin/entries`、`.../cgi-bin/clear` |

**新增 / 修改插件后必须 `w2 restart`** —— whistle 只缓存插件元数据（含 `rules.txt`），
改文件不会热重载。
