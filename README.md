# dsh-skill-mcp-market

DSH 的**技能市场**与 **MCP 连接器市场**：浏览实时技能源、装 SKILL.md 技能、装 MCP 连接器，装完立刻能用，安装路径由你自己定，全程不用重启 DSH。

- 提供的工具：12 个 `market_* / skill_market_* / mcp_market_*`（见下表）
- 设置文件：`~/.dsh/market/settings.json`（可用 `market_set_paths` 改）
- 默认技能目录：`~/.dsh/market/skills`；默认 MCP 目录：`~/.dsh/market/mcp`
- 左侧面板：**「SKILL技能&MCP连接器」**

## 截图

真机截图（DSH 桌面版，左侧菜单「SKILL技能&MCP连接器」）。

### 技能市场

顶部按来源切换（`skills.sh` / `clawhub` / `skillsmp` / `trusttools` / `browse.sh` / `lobehub-agent` / `skillhub`），卡片上直接「预览 / 安装」：

![技能市场：来源筛选与卡片](docs/screenshots/panel-skills.png)

> 「MCP 连接器」「已安装」「路径」三个页签的截图待补。

## 安装

已发布到 npm：**`dsh-skill-mcp-market`**（MIT，公共包，无需登录）。

### 前置条件

- 桌面版 DSH：本插件复用的是 `app.asar` 里官方技能/MCP 插件，纯 Node 环境跑不了。
- profile 目录：`~/.dsh/profiles/<profile>`，桌面版一般是 `~/.dsh/profiles/desktop`；
  Windows 下是 `C:\Users\<你>\.dsh\profiles\desktop`。

### 方式一：`dsh` CLI 安装（推荐）

DSH 桌面版自带 CLI，profile 的依赖由它**内置的 pnpm** 管理（profile 目录里有 `pnpm-lock.yaml`、`pnpm-workspace.yaml`，`nodeLinker: hoisted`）：

```bash
dsh plugin --profile desktop add dsh-skill-mcp-market
```

它等价于在 `~/.dsh/profiles/desktop` 里跑 `pnpm add`，多做了三件事：用安装目录里那份 pnpm（不依赖你本机的 pnpm）、对 profile 的 `package.json` 加文件锁（避免与正在跑的 DSH 抢写）、检查插件与当前 DSH 版本是否兼容。

`dsh` 不在 PATH 时用绝对路径：

```bat
"D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-skill-mcp-market
```

装完依赖还差一步——**让 DSH 加载它**：把包名加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-skill-mcp-market": "^0.3.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-skill-mcp-market"
      ]
    }
  }
}
```

包自带 `dsh.bundle.patch`（指向 `cordis.patch.yml`），进了 `bundles` 就会自动插入插件行，**不用手写 `cordis.patch.yml`**。

改完 `bundles` 需要**重启一次 DSH** 让插件被加载；此后装技能、装 MCP 都不再需要重启。

不想动 `bundles` 的话，也可以在 profile 的 `cordis.patch.yml` 末尾手写一行：

```yaml
- insert:
    - id: dsh-skill-mcp-market
      name: dsh-skill-mcp-market
      config:
        skillDirs: []
        mcpDirs: []
        shippedRoot: ""
```

清掉再装：`dsh plugin --profile desktop remove dsh-skill-mcp-market`（同时从 `bundles` 里删掉包名）。

### 方式二：应用内安装（plugin_manager / 插件面板）

- `plugin_manager`：`action: install_bundle`，`target` 填 `dsh-skill-mcp-market` 会「装依赖 + 加进 bundles」；`action: set_bundle` 只切换已安装包的启用状态。
- 设置 → 插件 里也能看到并启用它。
- 这条路径会执行包内代码，需要 Full access 或审批。

### 方式三：npm（不推荐）

profile 的 `node_modules` 是 pnpm 管的：`npm i` 会额外写 `package-lock.json`、打乱 `node_modules` 布局，下一次 `pnpm install` 可能把它清掉。只有在没有 `dsh` CLI 的机器上才这样装：

```bash
cd ~/.dsh/profiles/desktop
npm i dsh-skill-mcp-market      # 之后仍需把包名加入 dsh.profile.bundles
```

### 方式四：固定版本 / 多 profile / 本地开发

```bash
dsh plugin --profile desktop add dsh-skill-mcp-market@0.3.0            # 固定版本
dsh plugin --profile desktop why dsh-skill-mcp-market                  # 看装的哪个版本、谁引入的
dsh plugin --profile desktop add link:/path/to/dsh-market                       # 本地开发（换成你的仓库路径）
```

`link:` 情况下 `bundles` 里仍写包名；改完源码用 `plugin_manager set_plugin` 把 `include:dsh-skill-mcp-market` 关一次再开一次即可重挂（见「开发」）。同一个包可以装进多个 profile，各自独立配置。


### 安装后确认

1. 左侧菜单出现 **「SKILL技能&MCP连接器」**；
2. 「技能市场」「MCP 连接器」两个页签都能出卡片，顶部来源筛选可用：`skills.sh` / `clawhub` / `skillsmp` / `trusttools` / `browse.sh` / `lobehub-agent` / `skillhub`；
3. 让模型调 `market_get_settings`，应返回两个目录、provider 挂载状态、官方包解析结果、可用来源；
4. 12 个 `market_*` / `skill_market_*` / `mcp_market_*` 工具都在。

### 首次使用：决定装到哪里

默认装在 `~/.dsh/market/` 下。想换位置（例如并入 DSH 自带技能目录，让别的 profile 也能看到）：

```
market_set_paths({ skillDirs: ["C:/Users/你/.dsh/skills"], mcpDirs: ["C:/Users/你/.dsh/market/mcp"] })
```

支持 `~`、`$DSH_HOME`、`%ENV%` 和相对 profile 的路径；改完 provider 与 MCP 立即重挂。

需要密钥的 MCP 用 `${ENV_VAR}` 占位，值放环境变量：

```json
{ "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
```

### 升级与卸载

```bash
dsh plugin --profile desktop add dsh-skill-mcp-market@latest   # 升级，重启 DSH 生效
dsh plugin --profile desktop remove dsh-skill-mcp-market       # 卸载；再把这个包名从 dsh.profile.bundles 里删掉
```

卸载插件不会删掉已装好的技能与 MCP 定义（它们在 `~/.dsh/market/` 下，是独立数据）；要清理请用 `skill_market_uninstall` / `mcp_market_uninstall`。

## 为什么能"不重启就生效"

DSH 本来就有技能运行时和 MCP 运行时，缺的只是市场这一层。本插件不重造引擎，而是把两个官方插件按需挂载：

| 能力 | 做法 | 生效机制 |
|---|---|---|
| SKILL | 写 `<dir>/<name>/SKILL.md`，并挂载官方 `@deepseek-ai/dsh-skill-filesystem`（`customSkillDirs` = 用户目录，`watch: true`） | 该 provider 监听目录，文件落盘后自动失效目录缓存，下一步模型就能看见 |
| MCP | 写 `<dir>/<serverName>.json`，并用 `ctx.plugin()` 动态挂载官方 `@deepseek-ai/dsh-mcp-client` | 客户端插件把服务器工具直接注册到 `ctx.tools`，下一步即可调用 |

两个官方包从 DSH 安装目录的 `app.asar` 里按绝对路径 import（`process.resourcesPath` 自动探测，可用 `shippedRoot` 覆盖），与本进程共用同一模块实例。

## 工具一览

| 工具 | 作用 |
|---|---|
| `market_get_settings` | 看两个目录、provider 挂载状态、官方包解析结果、可用来源 |
| `market_set_paths` | 改技能/MCP 目录（支持 `~`、`$DSH_HOME`、`%ENV%`），即时重挂 provider 与 MCP |
| `skill_market_search` | 搜技能（全部实时源）：`skills.sh` / `clawhub` / `skillsmp` / `trusttools` / `browse.sh` / `lobehub-agent` / `skillhub`，`all` 聚合 |
| `skill_market_install` | 装技能：`github`（可带 `@ref`）/ `skills.sh`（页面 URL 或裸 `owner/repo`）/ `clawhub` / `skillsmp` / `trusttools` / `browse.sh` / `lobehub-agent` / `skillhub` / `url` / `local` / `zip` |
| `skill_market_list` | 列已装技能（含 `SKILL.md` 路径） |
| `skill_market_uninstall` | 卸载（移到 `market/trash/`） |
| `mcp_market_search` | 搜 MCP：官方注册表（实时）+ 已安装列表；目录不可达时返回降级列表与 `catalogHint` |
| `mcp_market_install` | 装 MCP：`slug`（官方注册表名称，如 `io.github.Async23/chrome-devtools-mcp`）/ 手工定义 / `importJson`（Claude·Cursor 的 `mcpServers`），装完立即探活 |
| `mcp_market_list` | 列已装 MCP（transport、enabled、mounted、已发布工具名） |
| `mcp_market_set_enabled` | 启停（断开即撤销工具，启用即重连） |
| `mcp_market_probe` | 等 MCP 发布工具并回报 |
| `mcp_market_uninstall` | 卸载（定义移入 `.trash/`） |

## 数据源

| 源 | 说明 |
|---|---|
| **MCP 官方注册表** | `registry.modelcontextprotocol.io`，免费、实时的 MCP 目录，自带真实启动方式（npm / streamable-http） |
| `skills.sh` | 技能索引，支持页面 URL 与裸 `owner/repo` |
| `skillsmp` | 带反爬（Cloudflare），走 python→curl→fetch 三级取数 |
| `browse.sh` | 启动预热 + 内存缓存，冷启动超时不缓存空结果 |
| `clawhub` / `trusttools` / `lobehub-agent` / `skillhub` | 其余实时技能源 |
| `github` | 直接给仓库或 `@ref`；jsDelivr 列树失败时回退 GitHub contents API 与 codeload tarball |

## 目录结构

```
dsh-skill-mcp-market/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml      # 插入一行 dsh-skill-mcp-market 插件
├─ index.js              # 插件入口：挂载 provider + 注册 12 个工具
├─ client.js             # Web 面板「SKILL技能&MCP连接器」
├─ src/
│  ├─ home.js            # 路径解析与 settings.json 读写
│  ├─ shipped.js         # 从 app.asar 解析并 import 官方插件包
│  ├─ http.js            # python→curl→fetch 三级取数（绕 TLS 指纹 / 系统代理）
│  ├─ frontmatter.js     # SKILL.md frontmatter 解析（无依赖）
│  ├─ github.js          # jsDelivr 列树 + raw/CDN 取文件，失败回退 contents API / tarball
│  ├─ extra-sources.js   # skillsmp 等额外源
│  ├─ mcp-registry.js    # MCP 官方注册表适配 + 内置兜底条目
│  ├─ skillhub.js        # SkillHub 公共 API 适配
│  ├─ skills.js          # 搜索聚合 / 安装 / 列出 / 卸载
│  ├─ sources.js         # 各源适配与缓存
│  ├─ mcp.js             # MCP 定义扫描、动态挂载、启停、探活
│  └─ ...
├─ locale/{en,zh}.json   # 插件管理器里的标题与描述
└─ icon.svg
```

## 已知边界

- DSH 的 `dsh-mcp-client` 只有 `stdio` 与 `streamable-http`，**没有 SSE**；上游只给 SSE 地址的 MCP 装不上。
- 技能发现是**一层深**：只认 `<root>/<name>/SKILL.md` 和 `<root>/<name>.md`。
- MCP 定义是标准写法，能否真跑由安装时的探活结果决定，不预先保证；注册表里标记为必填的环境变量会在安装时提示。
- 市场不伪造下载量/热度：上游没给就显示 0。
- LobeHub 页面会间歇返回 `402 payment_required`，所以它只作为次要源；MCP 目录不可达时按「上次缓存 → 内置条目」降级，并在面板上提示可直接按名称安装。

## 开发

改完代码后，`plugin_manager` 无法原地替换模块。用 `plugin_manager set_plugin` 把 `include:dsh-skill-mcp-market` 关一次再开一次，新代码即生效（已在本机验证）。

冒烟脚本在 `../tools/`：`smoke-market.mjs`（技能安装/卸载、MCP 配置映射）、`smoke-market-fixes.mjs`（注册表搜索、裸 `owner/repo`、skillsmp）、`smoke-sources.mjs`（各源 provider 行为）、`smoke-demo-mcp.mjs`（MCP 协议自检）。

## 许可

MIT
