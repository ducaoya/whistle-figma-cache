# 开发与发布说明

> 本文件用于仓库内部开发/发布流程，**不会发布到 npm**（`package.json` 的 `files` 是白名单，只包含
> `index.js`、`lib/`、`rules.txt`、`public/`、`README.md`、`AGENTS.md`、`LICENSE`）。

## 仓库信息

- 远程：`https://github.com/ducaoya/whistle-figma-cache.git`
- 主干分支：`master`（本地与远程同名）
- npm 包名：`whistle.figma-cache`

> **注意**：本机所在网络到 GitHub 的 **SSH 完全不通**（`git@github.com:22` 与备用口
> `ssh.github.com:443` 均超时），所以 remote 配的是 HTTPS。若某天 SSH 可用了，可以切回去：
> ```bash
> git remote set-url origin git@github.com:ducaoya/whistle-figma-cache.git
> ```

## 目录结构

```
whistle-figma-cache/
├── index.js                  # 插件入口（导出 rulesServer / resRulesServer / uiServer）
├── rules.txt                 # 内置规则，插件启用时自动加载
├── lib/
│   ├── policy.js             # 安全白名单与各类闸门
│   ├── rulesServer.js        # REQ_RULES：命中回放 / 未命中落盘
│   ├── resRulesServer.js     # RES_RULES：确认响应合格后给意向盖章
│   ├── revalidate.js         # SWR 后台静默校验（条件请求）
│   ├── store.js              # 磁盘缓存、时序模型、LRU
│   ├── config.js             # 参数解析
│   └── uiServer.js           # 状态页接口
├── public/index.html         # 状态页（使用方式 / 数据 两页）
├── test/                     # 4 个测试文件，130 项断言
├── legacy/                   # 早期 server hook 尝试（whistle 不派发该钩子，仅留存参考）
├── data/cache/               # 运行期生成（.gitignore 已排除）
├── .github/workflows/        # 自动发布工作流
├── AGENTS.md                 # 实现细节 / 踩坑记录 / 调试手册
└── package.json
```

## 本地开发

```bash
npm test            # 跑全部单测（130 项）

# 装到本地 whistle（二选一）
#   ① 挂到官方插件目录，做成符号链接，改代码即时生效
#   ② 启动时用 -A 指定插件目录父级
w2 start -A <插件目录的父级>
w2 restart
```

**改动后必须 `w2 restart`** —— whistle 只缓存插件元数据（含 `rules.txt`），改文件不会热重载。
状态页在 `http://127.0.0.1:<whistle端口>/plugin.figma-cache/`，其中「使用方式」页有完整的调试指引。

排障方法（计数器不动 / 想看详细日志 / 缓存目录怎么查）见 `AGENTS.md` 的**调试手册**一节，
里面有若干踩过的坑（尤其是 whistle 的 `/cgi-bin/rules/add` 接口会静默创建空规则组这件事）。

## 发布到 npm（自动）

`.github/workflows/publish.yml` 的触发条件（**两者同时满足**）：

1. 推送到 `master` 分支
2. 提交信息中包含 **【release】** 标识

```bash
# 1. 先上调 package.json 的 version（工作流不会自动 bump）
# 2. 提交信息带上【release】标识并推送
git commit -am "chore: release 1.0.1【release】"
git push origin master
```

工作流执行顺序：
`npm test` → 校验插件能否被 `require` 并导出钩子 → 读取 `name@version` →
检查该版本是否已在 npm（已存在则提示并跳过）→ `npm publish`

> 本地还有一道保险：`package.json` 配了 `"prepublishOnly": "npm test"`，
> 手动 `npm publish` 时也会先跑测试。

### 发布方式：npm Trusted Publishing（OIDC，无需 token）

npm 已永久吊销全部 classic token（2025-12-09），带直接发布能力的 granular token 也在退场，
因此本仓改用 **OIDC 可信发布**：工作流用 GitHub 签发的短期凭据发布，**不需要任何 secret**。

前置（每个包在 npm 网页上配一次）：

打开 `https://www.npmjs.com/package/whistle.figma-cache/access`
（或 Packages → 选包 → **Settings** → **Trusted publishing**），
在 **Trusted Publisher** 区块点 **Select your publisher** → **GitHub Actions**，填：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| Organization or user | `ducaoya` | GitHub 用户名，不带 `@` |
| Repository | `whistle-figma-cache` | 只填仓库名，不填完整 URL |
| Workflow filename | `publish.yml` | **只填文件名**，含 `.yml`，不能写 `.github/workflows/publish.yml` |
| Environment name | 留空 | 若填了，工作流必须声明同名 `environment:`，否则鉴权失败 |
| **Allowed actions** | 勾选 **`npm publish`** | ⚠️ **2026-05-20 之后创建的配置必须显式勾选，至少选一项，否则发布报错** |

填完记得点保存。一个包同时只能配一个 Trusted Publisher；字段全部大小写敏感，
必须与 GitHub 完全一致——**npm 不会在你保存时校验，写错了只会到发布时才报
「Unable to authenticate (ENEEDAUTH)」**。

工作流侧需满足：

- `permissions.id-token: write`（否则 OIDC 不可用）
- npm ≥ 11.5.1、Node ≥ 22.14.0（Node 22 自带 npm 10.x，工作流里用 `npm install -g npm@latest` 提升）
- `package.json` 的 `repository.url` 必须与 GitHub 仓库完全一致
- 必须使用 **GitHub 托管 runner**（`ubuntu-latest`），不支持自建 runner
- **不要**设 `NODE_AUTH_TOKEN` —— 有 token 时 npm 可能不走 OIDC，掩盖配置错误

### 配完建议收尾：禁止 token 发布

`Settings` → **Publishing access** → 选 **"Require two-factor authentication and disallow tokens"**
→ 点 **Update Package Settings**。

这会把传统 token 发布关掉，但**不影响** Trusted Publisher（它走 OIDC，不是 token）。

### 首版必须手动发布一次

Trusted Publisher 只能给**已存在的包**配置，所以 `1.0.0` 要先手动发一次：

```bash
npm login          # 2FA 交互登录（会话约 2 小时有效）
npm publish        # 提示 OTP 时输入验证码
```

发完之后再去 npm 网页配置 Trusted Publisher，之后的版本就全自动了。

> 可选替代：带人工审批的暂存发布（token 选 **Read and write (stage only)** + `npm stage publish`），
> 但每次发版都需 2FA 审批，且官方明确暂存发布**不支持全新包**。

### 关键细节：标记必须在 HEAD 上

工作流判断的是 `github.event.head_commit.message`，也就是**本次 push 的最后一条提交**。所以：

- 带【release】的那条提交必须是推送后的 HEAD，否则不会触发发布
- 若想先提交其它内容再发布，推荐用「空提交打标记」：

```bash
# 1. 先提交普通改动
git add . && git commit -m "docs: 补充说明"
# 2. 再用空提交把【release】标记放到 HEAD
git commit --allow-empty -m "chore: release 1.0.1【release】"
# 3. 一起推送（HEAD 带标记 -> 触发发布）
git push origin master
```

## 发布前自查（不依赖 GitHub Actions）

```bash
npm test                                        # 130 项单测
npm pack --dry-run                              # 查看将要发布的内容（确认没有 data/ 与 legacy/）
node -p "require('./package.json').name+'@'+require('./package.json').version"
npm view whistle.figma-cache@<version> version  # 有输出=该版本已存在，需先上调 version
```

## 排障：发布失败对照表

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Unable to authenticate (ENEEDAUTH)` | Trusted Publisher 的仓库 / workflow 文件名 / 大小写与 GitHub 不一致 | 逐个字符比对 npm 页面上的值与实际仓库 |
| 同上，但字段都对 | 未勾选 Allowed actions，或用了自建 runner | 勾上 `npm publish`；改用 `ubuntu-latest` |
| `EINVALIDNPMTOKEN` | `setup-node` 的 `registry-url` 生成了带空 `_authToken` 的 `.npmrc` | 删掉 `setup-node` 的 `registry-url`（工作流里试过，不行再删） |
| `EOTP` | 还在走 token 鉴权，或 Trusted Publisher 没保存 | 确认 `id-token: write` 有、不设 `NODE_AUTH_TOKEN`、配置已保存 |
| `EBADENGINE` | Node 版本过低 | 用 22 / 24 |
| 发布成功但没有 provenance 绿标 | 未生成来源证明 | 工作流已在 `npm publish` 后加了 `--provenance` |

## 与 whistle-sse-viewer 的配置差异

本仓的发布配置参考 `whistle-sse-viewer`，只有三处不同：

| 项 | sse-viewer | 本仓 | 原因 |
| --- | --- | --- | --- |
| remote 协议 | SSH | **HTTPS** | 本机网络到 GitHub 的 SSH 被阻断 |
| 工作流多一步 | — | 校验插件能 `require` 并导出钩子 | 本插件靠钩子工作，导出缺失会静默失效（见 AGENTS.md 坑 1） |
| `prepublishOnly` | 无 | `npm test` | 首版要手动发布，加一道本地保险 |
