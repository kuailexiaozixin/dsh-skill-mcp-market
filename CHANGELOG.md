# Changelog

## 0.5.8

### skills.sh 描述补齐 + 切源走缓存（不再白屏重查）
- **skills.sh 描述**：上游目录/搜索 API 不携带描述字段（只返回 `id/source/skillId/name/installs`），
  之前只有「搜索」路径会尽力从 GitHub `SKILL.md` frontmatter 补描述（前 10 条、0.3–2s/条、超时留空），
  「浏览」（空搜索框的首页推荐）完全不补 → 整页都是 `skills.sh · owner/skills`。现在浏览路径也补前 10 条描述。
- **切源/改查询走 stale-while-revalidate**：客户端加了一个按 `(tab, source, category, sort, query, page)` 的结果缓存。
  切源或改查询时若命中就**立即渲染旧结果**（提示「缓存，正在刷新…」），后台再刷新；不再每次切源都清空重查、白屏等待。
- 插件代码无其他变化。

## 0.5.7

### 已安装标签：「详情/编辑」改为「打开文件夹」
- 技能卡片和 MCP 卡片的「详情/编辑」按钮改成了「**打开文件夹**」：点了直接在资源管理器里定位到该技能 / MCP 定义所在目录，
  可查看 / 编辑内容（保存即生效，无需重启 DSH）。
- 之前的「详情/编辑」抽屉（全屏模态）被移除，编辑需求通过资源管理器直接改文件实现。
- `market.openDir` RPC 扩展：支持 `{ kind: "skill", slug }` 和 `{ kind: "mcp-item", serverName }` 两种用法，
  Windows 上用 `explorer.exe /select,` 定位到具体文件。
- 插件代码无其他变化。

## 0.5.6

### 已安装标签：搜索 + DSH 内置技能
- 「已安装」标签顶部加一个**搜索框**，可按关键词过滤已安装的技能 / MCP（名称、描述）；清空后恢复完整列表。
- 「已安装」标签现在同时列出 **DSH 内置技能**（`$AGENTS_HOME/skills/`）+ market 安装的技能（`settings.skillDirs`）；
  MCP 仍只列出 market 安装的。区块标题旁会显示「含 DSH 内置 N 个目录」。
- `skills.list` RPC 改用 `collectDshNativeSkillDirs()` 合并两套目录；`market_get_settings` 也返回
  `dshNativeSkillDirs` 供客户端展示。
- 插件代码无其他变化。

## 0.5.5

### 安装技能后立即出现在对话框 / 浮窗里
- 之前：`skill_market_install` 把技能装到 `settings.skillDirs[0]`，DSH 的"技能目录"扫描不会把这份技能列进
  对话框输入 `/` 时弹出的浮窗里（要重启 DSH 才可见）。
- 现在：安装成功后，插件往 DSH 原生扫描路径 `$AGENTS_HOME/skills/` 写一份 junction（Windows）/ symlink（其它平台），
  指向技能实际安装位置；DSH 会把它列进"技能目录"，`/` 浮窗随之更新，**无需重启**。
- 卸载不自动清理这份 junction（避免误删用户手工放置的），需要时手工 `rmdir "$AGENTS_HOME\skills\<slug>"`。
- 插件代码无其他变化。

## 0.5.4

### 交互：「详情/编辑」改为全屏模态
- 不再在列表上方插入详情面板，改为**半透明遮罩 + 居中 560px 卡片**的模态（参考 Hermes 的"返回 + 详情"全屏页风格）；
- 关闭：点右下角「关闭」按钮（遮罩外区域不拦截，避免误关）；
- 技能：「描述 / 正文」两个输入区；MCP：「命令 / URL / 参数」三个输入区 + 只读的 transport/env/headers JSON；
- 右下角操作按钮：「保存」/「保存并重连」（与之前一致），「关闭」在左侧。
- 插件代码无其他变化。

## 0.5.3

### 修复：trusttools 技能市场每页只 10 条、"加载更多" 位置不合理、缺少"打开安装目录"按钮
- **trusttools 现在能展示更多技能**：该 API 固定返回 10 行/页（`pageSize` 参数被忽略），`searchTrustTools` 现在
  会最多拉 6 页、去重后截断到面板需要的条数（面板默认 24 行 → 拉 3 页）。每页 10 分钟缓存，搜索词命中后直接走缓存，
  避免每次翻页都打 6 次上游。
- **「加载更多」按钮位置**：从工具条移到**列表最后一行的正下方居中**；MCP（LobeHub）会显示 `加载更多（n/m）`，
  最后一行变成 `已到最后一页（n/m）`；SKILL 市场按钮文案保持 `加载更多`。不再需要滚回顶部点按钮。
- **「已安装」标签的两个区块（已装技能 / 已装 MCP）标题旁各加一个「打开目录」按钮**：
  - 技能目录：`settings.skillDirs[0]`（安装目标）；
  - MCP 目录：`settings.mcpDirs[0]`（`.json` 定义存放处）；
  - 点了在资源管理器中打开，直接查看 / 编辑文件（保存即生效，无需重启 DSH）。
  - 两个目录都还没配置时会提示"还没有配置 … 目录"。
- 插件代码无其他变化。

## 0.5.3

### 修复：trusttools 技能市场每页只 10 条、"加载更多" 位置不合理、缺少"打开安装目录"按钮
- **trusttools 现在能展示更多技能**：该 API 固定返回 10 行/页（`pageSize` 参数被忽略），`searchTrustTools` 现在
  会最多拉 6 页、去重后截断到面板需要的条数（面板默认 24 行 → 拉 3 页）。每页 10 分钟缓存，搜索词命中后直接走缓存，
  避免每次翻页都打 6 次上游。
- **「加载更多」按钮位置**：从工具条移到**列表最后一行的正下方居中**；MCP（LobeHub）会显示 `加载更多（n/m）`，
  最后一行变成 `已到最后一页（n/m）`；SKILL 市场按钮文案保持 `加载更多`。不再需要滚回顶部点按钮。
- **「已安装」标签的两个区块（已装技能 / 已装 MCP）标题旁各加一个「打开目录」按钮**：
  - 技能目录：`settings.skillDirs[0]`（安装目标）；
  - MCP 目录：`settings.mcpDirs[0]`（`.json` 定义存放处）；
  - 点了在资源管理器中打开，直接查看 / 编辑文件（保存即生效，无需重启 DSH）。
  - 两个目录都还没配置时会提示"还没有配置 … 目录"。
- 插件代码无其他变化。

## 0.5.2

### 文档：安装/升级卡住、`ERR_PNPM_EPERM` 的原因与修法
- 说明根因：pnpm 用「重命名临时目录覆盖目标目录」的方式落地包，Windows 下覆盖前要删旧目录，而 DSH 正加载着这个插件
  → `EPERM`，表现为安装卡在 `added 0` 或直接失败。
- 给出实测有效的修法：先 `rmdir /s /q` 删掉
  `~/.dsh/profiles/desktop/node_modules/dsh-skill-mcp-market`，再 `dsh plugin --profile desktop add …`（实测 3.7 秒完成）；
  或先退出 DSH 再装；或使用应用内「插件」页的更新按钮。
- 警示：不要用 Git-Bash/MSYS 的 `rm` 删 `link:` 形式的 `node_modules` 条目——它会跟随符号链接删掉源码仓库
  （开发期间因此损坏过一次本地 `.git` 元数据，已从存活对象重建，远端历史未受影响）。
- 插件代码无变化。

## 0.5.1

### 修复：插件无法卸载（“其他配置仍在使用的组合包的组件，请先停用它们”）
- 根因不在插件本身，而是**同一个插件被挂载了两次**：包名在 `dsh.profile.bundles` 里，同时又有一份手写在
  profile `cordis.patch.yml` 的 `insert`。插件管理器卸载时会先停用组合包，随后仍发现同 `id` + 同 `name` 的插件行在运行，
  于是以 `bundle-in-use` 拒绝卸载。
- 插件启动时新增**重复挂载检测**：命中时在日志里告警，并直接给出修法（删掉 profile 里手写的 `insert`，只保留 `bundles` 里的包名）。
- README 补充说明：`bundles` 与手写 `insert` **只能二选一**；「卸载」小节新增这个报错的处理步骤。
- `market_get_settings` 的 MCP 来源说明更新为两个市场（官方注册表 / LobeHub）。

## 0.5.0

### 新增：MCP 市场的分类 / 排序 / 分页
- **分类**：LobeHub 页签按上游返回的分类码生成 chips（70 个，取前 12 个 + 「全部分类」），常见分类显示中文名
  （开发者 / 数据分析 / 媒体生成 / 效率办公 / 金融 …），点一下即按该分类重新检索。
- **排序**：LobeHub 支持「默认顺序 / 安装最多 / 评分最高」，官方注册表支持「默认顺序 / 按名称」。
- **分页**：LobeHub 每页 40 条，「加载更多（第 n/m 页）」按页追加；状态行显示「共 X 个连接器 · 第 n/m 页」。
  `mcp_market_search` 也同步支持 `category` / `sort` / `page` 参数并回传分页信息。
- **稳定性**：LobeHub 市场偶发 `fetch failed`（本机网络抖动），CLI 调用加了 3 次重试（仅对链路类错误重试）。

## 0.4.0

### 新增：两个 MCP 市场（不合并，各占一个来源）
- 面板 MCP 页签新增来源切换：**「MCP 官方注册表」/「LobeHub」**，与技能页签的 chips 一致，一次只看一个市场。
- LobeHub 市场走它自己的官方接口 `@lobehub/market-cli`（首次使用自动注册市场客户端，凭证由 CLI 写到
  `~/.lobehub-market/credentials.json`）；搜索支持关键词、分类、`--sort`，卡片显示作者、分类、安装次数。
- LobeHub 条目的安装走公开 manifest：`/api/v1/plugins/<identifier>/manifest` 给出真实 `command`/`args`
  或远程 `url` 以及需要的环境变量，装完照旧探活。
- `mcp_market_search` 新增 `source: "registry" | "lobehub"` 参数。

### 修正
- 之前「LobeHub 目录已改付费接口（HTTP 402）/不可用」的结论是错的：那是**匿名**请求的 401，注册市场客户端后即可搜索；
  相关错误文案与 README 已更正。
- LobeHub 搜索分页上限是 40（更大的 `--page-size` 会被拒），且 `--sort` 只能和关键词一起用，代码里都已处理。

## 0.3.2

### 修复
- **skills.sh 空搜索不再空白**：该上游没有列表接口，改为抓取首页推荐的技能卡片（缓存 30 分钟），
  面板同时提示「未输入关键词，显示首页推荐；输入 ≥2 个字符可精确搜索」。
- **trusttools 恢复可用**：`ai.trusttools.cn` 会丢弃本进程的 TLS 握手（与 skillsmp 同类），
  POST 改走 python → curl → fetch 三级通道（`postJsonEscalating`）。
- 面板空状态优先显示各来源自己的 `hint`，不再一律显示「上游不可达」。

## 0.3.1

### 文档与元数据
- 仓库转为 public；README 补齐安装 / 升级 / 卸载与数据源说明
- `docs/ARCHITECTURE.md` 重写为对外版本（去掉内部参考实现对照与本机路径）
- package.json 描述改为中英双语，并补充 keywords
- 清理代码注释里的第三方项目名

行为无变化。

## 0.3.0（进行中）

### 变更
- **移除内置精选库**：删除 `catalog/`（17 条精选技能 + 8 条精选 MCP），只保留实时在线源。
- **技能源改为实时**：`skills.sh`（sitemap 2 万条）+ `SkillHub`（社区 API）。
- **MCP 源改为实时，主源换成官方注册表**：`registry.modelcontextprotocol.io`
  （免费、无需鉴权、自带真实启动方式：npm 包 + stdio，或 streamable-http 端点）。
  LobeHub 降为第二源——它的边缘会间歇返回 `402 payment_required`，不能再作为唯一目录。
  目录失效时按「上次成功缓存 → 内置常见条目」降级，并明确告知原因；安装本身不依赖目录，
  只要给出名称即可解析。
- **新增 skillsmp 源**：`skillsmp.com/api/skills`。该站由 Cloudflare 托管，实测 Node
  `fetch`/`https` 与 Windows `curl` 全部 403「Just a moment…」，只有 CPython 的 TLS 栈能拿到
  200，因此新增 python → curl → fetch 的三级取数通道；条目的 GitHub 位置直接用于安装。
- **GitHub 取数增强**：`github.com`/`raw.githubusercontent.com` 在部分网络只能走系统代理，
  Node `fetch` 不读系统代理，故下载改为 fetch → python → curl 递进；jsDelivr 的文件列表
  看不到 `.agents/` 这类目录，补充 GitHub contents API 与仓库归档（tarball）兜底。
- **新增技能启停配置项** `disabledSkills`：等价于常见的 `config skills.disabled: [...]` 写法，
  由自建 skill provider 读取并过滤，改完立即失效目录缓存。
- **新增 `${ENV_VAR}` + 系统环境变量**：面板填写的 Key 写入 Windows 用户环境变量，
  配置里只保留占位符。
- **新增面板**：`shell.overlay` 注入，四个标签（技能 / MCP / 已安装 / 路径）。
- 修复：自建 provider 未返回 `provider` 字段导致技能目录校验失败。
- 修复：`skill_market_install` 传裸 `owner/repo` 给 `skills.sh` 源时报
  `Failed to parse URL`；现在裸仓库名与页面 URL 都接受。
- 修复：`installSkill` 的 `ref` 参数未被解构，trusttools 源安装时抛 `ref is not defined`。
- 修复：目录为空时只显示空白；现在区分「没有匹配」与「目录不可达」并给出可操作提示。

### 已知问题
- skills.sh 的安装路径靠 `/<owner>/<repo>/<skill>` 推断，非标准布局会装不上。
- 安装前没有隔离区安全扫描。
- modelscope（`api/v1/dolphin/skills` 已 404）仍未接。
- 官方注册表按 token 精确匹配，多词查询由本插件拆词后合并排序。
- 存放于点目录（`.agents/skills/...`）的技能只能走仓库归档安装，单个技能可能要下载
  整个仓库（数十 MB）。

## 0.2.0

- 首个可用版本：12 个 host 工具 + 面板 + 动态挂载官方 MCP 客户端实现零重启生效。

## 0.1.0

- 骨架。
