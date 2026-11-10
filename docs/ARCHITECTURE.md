# 架构

本插件不重造引擎，而是把 DSH 已有的技能运行时与 MCP 运行时接起来，再加一层市场与面板。
形态是 **cordis bundle + host 工具 + 面板 + 官方插件动态挂载**。

## 一、启停机制

市场里的「安装」只是把内容写到目录，「启用 / 禁用」由两处配置决定，都在
`~/.dsh/market/settings.json` 里（可用 `market_set_paths` 或面板改）：

| 能力 | 落盘位置 | 禁用写法 | 生效方式 |
|---|---|---|---|
| 技能 | `<skillDir>/<name>/SKILL.md` | `disabledSkills: ["name", ...]` | 自建 `SkillProvider` 读取后过滤，改完调 `control.invalidate()` 让目录缓存失效 |
| MCP | `<mcpDir>/<serverName>.json` | 定义文件里的 `enabled: false`（缺省即启用） | `reconcile()` 跳过该条并卸载对应 fiber |

两者都是「改配置即刻生效」，不需要重启 DSH。

## 二、核心机制

| 能力 | 实现 |
|---|---|
| 装完即刻生效（技能） | 自建 `SkillProvider` 注册到 `ctx.skills`，内部 `fs.watch` 监听目录 → `invalidate()` |
| 装完即刻生效（MCP） | `ctx.plugin()` 动态挂载官方 `@deepseek-ai/dsh-mcp-client`，工具直接落到 `ctx.tools`；卸载 = `fiber.dispose()` |
| 安装路径自定义 | `skillDirs` / `mcpDirs` 两个列表，`market_set_paths` 或面板「路径」页修改，改完重挂 provider 与 MCP |
| 密钥 | MCP 定义里只存 `"${VAR}"`；面板填值 → `[Environment]::SetEnvironmentVariable(name, value, 'User')` + `process.env` |
| 复用官方实现 | 从 DSH 安装目录的 `app.asar` 按绝对路径 import 官方 `dsh-skill-filesystem` / `dsh-mcp-client`，与本进程共用同一模块实例（`src/shipped.js`） |
| 面板数据通道 | host `ctx.webServer.register('/api/dsh-market/rpc')`，client 侧同源 `fetch` |

## 三、模块职责

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：注册 12 个 host 工具、挂载 provider、注册面板 RPC、串起 `reconcile()` |
| `client.js` | 面板「SKILL技能&MCP连接器」（React，无构建步骤） |
| `src/home.js` | 路径解析（`~` / `$DSH_HOME` / `%ENV%`）与 `settings.json` 读写 |
| `src/shipped.js` | 定位 `app.asar` 并 import 官方插件包 |
| `src/http.js` | 取数三级通道：python → curl → fetch（绕 TLS 指纹与系统代理限制） |
| `src/github.js` | jsDelivr 列树 + raw 取文件，失败回退 GitHub contents API / codeload tarball |
| `src/sources.js` | 各技能源的聚合、排序与缓存 |
| `src/skills.js` | 搜索 / 安装 / 列出 / 卸载 / 启停 |
| `src/skillhub.js` | SkillHub 公共 API 适配 |
| `src/extra-sources.js` | skillsmp 等需要特殊传输的源 |
| `src/mcp-registry.js` | MCP 官方注册表适配（主源）+ 目录不可达时的内置兜底条目 |
| `src/mcp.js` | MCP 定义扫描、动态挂载、启停、探活 |
| `src/provider.js` | 自定义 `SkillProvider`（含 `disabledSkills` 过滤） |
| `src/frontmatter.js` | `SKILL.md` frontmatter 解析（零依赖） |
| `src/zip.js` | zip 解包（装 `zip` 来源的技能） |
| `src/verify.js` | 安装前的内容体检（把可疑的「密钥外发 / 远程执行」模式标出来） |

## 四、刻意不做的事

- **不自己当 MCP 服务器**：DSH 已经有 `dsh-mcp-resources` 与 MCP 客户端，重复实现只增加故障面。
- **不打包前端构建链**：面板用 React 手写、运行时直出，省掉 vite/rollup 与产物同步。
- **不伪造下载量 / 热度**：上游没给就显示 0。
- **不在市场侧下内容审核结论**：只做静态特征体检并在面板提示，是否安装由用户决定。

## 五、数据与安全

- 所有目录列表、搜索结果、安装内容都来自**第三方实时源**（skills.sh / clawhub / skillsmp /
  trusttools / browse.sh / lobehub-agent / skillhub / 官方 MCP 注册表 / GitHub），本仓库不镜像、
  不托管这些内容；它们的可用性、正确性与许可证由各自上游负责。
- 配置文件里只有 `${VAR}` 占位符；真实密钥写进当前用户的环境变量，不落仓库、不回显。
- 面板 RPC 由 DSH 的 web server 提供，沿用 DSH 自身的访问控制。
