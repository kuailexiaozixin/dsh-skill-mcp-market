# 架构与参考实现对照

参考实现：`WPS 灵犀 / hermes-business-agent / examples / 01-hermes-desktop / Agent系统`（35 个文件）。
本项目把它翻译成 DSH 的形态：**cordis bundle + host 工具 + `shell.overlay` 面板 + 官方插件动态挂载**。

## 一、启停机制（对齐 Hermes）

| 能力 | Hermes 做法 | 本项目做法 |
|---|---|---|
| 技能禁用 | `config.yaml` 的 `skills.disabled: [name]` + `platform_disabled`；`set_skill_enabled` 改列表后 `clear_skills_system_prompt_cache(clear_snapshot=True)` | `~/.dsh/market/settings.json` 的 `disabledSkills: []`；自建 provider（`src/provider.js`）读取并过滤，改完调 `control.invalidate()` |
| MCP 禁用 | `mcp_servers[name].enabled = false`（缺省启用），改完 `trigger_mcp_discovery()` | `<serverName>.json` 的 `enabled` 字段（同样缺省启用），`reconcile()` 跳过并卸载 |

## 二、核心机制

| 能力 | 实现 |
|---|---|
| 装完即刻生效（技能） | 自建 `SkillProvider` 注册到 `ctx.skills`，内部 `fs.watch` 监听目录 → `invalidate()` |
| 装完即刻生效（MCP） | `ctx.plugin()` 动态挂载官方 `@deepseek-ai/dsh-mcp-client`，工具直接落到 `ctx.tools`；卸载 = `fiber.dispose()` |
| 安装路径自定义 | `skillDirs` / `mcpDirs` 两个列表，`market_set_paths` 或面板「路径」页修改，改完重挂 provider 与 MCP |
| 密钥 | 定义里只存 `"${VAR}"`；面板填值 → `[Environment]::SetEnvironmentVariable(name, value, 'User')` + `process.env` |
| 面板数据通道 | host `ctx.webServer.register('/api/dsh-market/rpc')`，client 侧同源 `fetch` |

## 三、文件对照

| 参考实现 | 本项目 |
|---|---|
| `routes/skills.py`（19 个接口） | `index.js` 的 `dispatch()` + 12 个 host 工具 |
| `routes/mcp.py`（13 个接口） | 同上 |
| `unified_skills_client.py` | `src/sources.js`（实时源聚合）+ `src/http.js`（python/curl/fetch 三级取数） |
| `skillhub_client.py` | `src/skillhub.js` + `src/github.js`（含 contents API / tarball 兜底） |
| `hermes_skills_client.py` | 待接（官方 optional-skills，需「拉全量 + 本地过滤」） |
| `mcpstore_client.py` | `src/mcp-registry.js`（官方注册表，主源）+ `src/sources.js` 的 LobeHub 部分（备用源，会 402） |
| `hermes_config/_skills.py` | `src/provider.js` + `setSkillEnabled()` |
| `hermes_config/_mcp.py` | `src/mcp.js` |
| `hermes_config/_paths.py` | `src/home.js` |
| `hermes_adapter.py`（防腐层） | `src/shipped.js` |
| `static/skillstore.js` + `mcpstore.js`（1312 行） | `client.js`（约 400 行，React 无构建） |
| `routes/mcp_server.py`（自己当 MCP 服务器） | 不做 |

## 四、不照搬的部分

FastHTML 页面外壳、`app.css`、`parseSSE`、pywebview 桥接、`routes/mcp_server.py`。
DSH 已有组件库、主题令牌和进程内面板系统，照搬等于重造。
