# whistle.figma-cache

给 **Figma 桌面客户端**加一层**磁盘缓存**，消除每次刷新都重复下载的静态资源。

> 实现细节、踩坑记录、调试手册见 **[AGENTS.md](./AGENTS.md)**（供 AI / 后续维护者阅读）。

## 它解决什么

Figma 编辑器每次刷新都要重新拉取**数十 MB** 的 JS / WASM / 字体。带宽受限时，这部分会占掉刷新耗时的大头。

而 Chromium 自带的 HTTP 缓存救不了这个场景：

- 它的缓存配额只有约 **80 MB**，一次刷新就有数十 MB 资产要写进去，**写进去就被驱逐** ——
  热加载和冷加载一样慢；
- Electron 升级会更换 profile 目录，**上一次的缓存全部作废**。

本插件把缓存放到自己的磁盘目录里：不设 80 MB 上限，不受 Electron 版本影响，命中后由本地磁盘回放。

## 使用方式

### 1. 确认插件已加载

whistle 界面 → **Plugins** 面板 → 找到 `figma-cache`，确保处于启用状态。
点 **Option** 打开状态页 —— 里面有两页：**使用方式**（含验证方法与常见问题）和**数据**。

### 2. 让 Figma 走 whistle（管理员 PowerShell）

Figma 只读 `HKLM\Software\Figma`，写别处会被静默忽略：

```powershell
New-Item -Path 'HKLM:\SOFTWARE\Figma' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Figma' -Name 'ProxyUrl' `
  -Value 'http://127.0.0.1:8899' -Type String
```

把端口换成 `w2 status` 显示的实际值。这是**进程级代理，不影响系统代理**。

### 3. 完全退出 Figma 再打开

Figma 只在启动时读一次这个配置，必须让所有 `Figma.exe` 进程结束（关窗口不够）。
然后打开一个**设计文件** —— 第一次仍慢（在填缓存），之后刷新就走本地了。

### 4. 可选参数

默认零配置。需要调整时，在 whistle 的 **Rules** 面板追加一条更高优先级的规则：

```txt
static.figma.com/uploads/  figma-cache://revalidate=7d,maxSize=8192,log=1
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxSize` | 4096 MB | 缓存总量上限，超出按 LRU 淘汰 |
| `maxFileSize` | 64 MB | 单文件上限 |
| `revalidate` | 24h | 后台静默校验冷却期；`0` = 每次命中都校验，`-1` = 关闭 |
| `ttl` | 0（永久） | 缓存有效期 |
| `dir` | `<插件目录>/data/cache` | 缓存目录（路径不能带空格） |
| `bodySettle` | 500 ms | 判定「body 写完」的静默阈值 |
| `log` | 0 | 设 `1` 打印 HIT / MISS 日志 |

## 常见问题

**Q：状态页数据一直是 0，计数器不动？**
逐一确认：① 写的是 `HKLM` 而不是 `HKCU`；② Figma 是**完全退出后**重启的（不是关窗口）；
③ 打开的是**设计文件**，不是只停在文件列表页 —— 白名单只覆盖编辑器资源。

**Q：Figma 打不开了 / 白屏 / 一直转圈？**
说明代理生效了但 whistle 没响应。检查 whistle 是否在运行（`w2 status`）。急着用就先删掉注册表值恢复：
```powershell
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Figma' -Name 'ProxyUrl'
```

**Q：第一次加载还是慢？**
正常。第一次必须回源并写入缓存，从第二次开始才走本地磁盘。

**Q：第二次刷新还是不够快？**
网络成本已经消除 —— 看状态页：`已省流量` 很大且 `后台校验流量` 接近 0 就说明缓存没问题了。
剩下的时间是 Figma 自身的客户端开销（解析编译 JS/WASM、渲染文档），缓存帮不上忙。
继续优化要看文件复杂度：拆分大文件、删除隐藏图层（官方明确隐藏图层照样占内存）、
用 component properties 替代海量 variants、压缩大图。

**Q：后台校验会不会偷跑流量？**
不会。它用 `If-None-Match` 条件请求，绝大多数返回 304（body 0 字节），
且同一资源 24 小时内最多校验一次。状态页的「后台校验流量」可以直接确认。

**Q：会不会缓存到画布数据，导致拿不到最新内容？**
不会。白名单只覆盖两类**内容哈希命名、永远不可变**的地址：

```
www.figma.com/webpack-artifacts/assets/<name>-<contenthash>.min.js(.br)
static.figma.com/uploads/<contenthash>
```

画布数据、`/api/`、`/file/`、`/design/`、`s3-alpha*.figma.com`、WebSocket、
任何带查询串的地址全部拒绝。详见 AGENTS.md 的「安全设计」。

## 关闭 / 卸载

| 操作 | 效果 |
|---|---|
| Plugins 面板禁用插件 | 缓存能力立即失效，请求原样透传 |
| 删掉注册表的 `ProxyUrl` | Figma 恢复直连 / 走系统代理 |
| 状态页「清空缓存」 | 清掉全部本地缓存 |
| `npm unlink -g whistle.figma-cache` | 从 node_modules 移除 |

## 自测

```bash
npm test   # 130 项：安全策略 60 / 存储 31 / 钩子 24 / SWR 15
```

## License

MIT
