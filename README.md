# @local/dsh-market

DSH 的**技能市场**与 **MCP 连接器市场**：装完即刻生效，安装路径由用户决定，无需重启 DSH。

- 提供的工具：12 个 `market_* / skill_market_* / mcp_market_*`（见下表）
- 安装位置：`~/.dsh/market/settings.json`（可用 `market_set_paths` 改）
- 默认技能目录：`~/.dsh/market/skills`；默认 MCP 目录：`~/.dsh/market/mcp`

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
| `skill_market_search` | 搜技能：`curated`（17 个真实技能）/ `skillhub`（社区 API）/ `all` |
| `skill_market_install` | 装技能：`github` / `url` / `local` / `skillhub` 四种来源 |
| `skill_market_list` | 列已装技能（含 `SKILL.md` 路径） |
| `skill_market_uninstall` | 卸载（移到 `market/trash/`） |
| `mcp_market_search` | 搜 MCP：内置精选 8 条 + 已安装列表 |
| `mcp_market_install` | 装 MCP：`slug`（精选）/ 手工定义 / `importJson`（Claude·Cursor 的 `mcpServers`），装完立即探活 |
| `mcp_market_list` | 列已装 MCP（transport、enabled、mounted、已发布工具名） |
| `mcp_market_set_enabled` | 启停（断开即撤销工具，启用即重连） |
| `mcp_market_probe` | 等 MCP 发布工具并回报 |
| `mcp_market_uninstall` | 卸载（定义移入 `.trash/`） |

## 目录结构

```
dsh-market/
├─ package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml      # 插入一行 dsh-market 插件
├─ index.js              # 插件入口：挂载 provider + 注册 12 个工具
├─ src/
│  ├─ home.js            # 路径解析与 settings.json 读写
│  ├─ shipped.js         # 从 app.asar 解析并 import 官方插件包
│  ├─ frontmatter.js     # SKILL.md frontmatter 解析（无依赖）
│  ├─ github.js          # jsDelivr 列树 + raw/CDN 取文件（绕开被墙的 GitHub API）
│  ├─ skillhub.js        # SkillHub 公共 API 适配
│  ├─ skills.js          # 搜索聚合 / 安装 / 列出 / 卸载
│  ├─ mcp.js             # MCP 定义扫描、动态挂载、启停、探活
│  └─ ...
├─ catalog/
│  ├─ skills.json        # 17 条精选技能（从 anthropics/skills 生成）
│  └─ mcp.json           # 8 条标准 MCP 定义
├─ locale/{en,zh}.json   # 插件管理器里的标题与描述
└─ icon.svg
```

## 已知边界

- DSH 的 `dsh-mcp-client` 只有 `stdio` 与 `streamable-http`，**没有 SSE**；上游只给 SSE 地址的 MCP 装不上。
- 技能发现是**一层深**：只认 `<root>/<name>/SKILL.md` 和 `<root>/<name>.md`。
- 精选 MCP 定义是标准写法，能否真跑由安装时的探活结果决定，不预先保证。
- 市场不伪造下载量/热度：上游没给就显示 0。

## 开发

改完代码后，`plugin_manager` 无法原地替换模块。用 `plugin_manager set_plugin` 把 `include:dsh-market` 关一次再开一次，新代码即生效（本机已验证）。

冒烟脚本在 `../tools/`：`smoke-market.mjs`（技能安装/卸载、MCP 配置映射）、`smoke-demo-mcp.mjs`（MCP 协议自检）。
