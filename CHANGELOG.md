# Changelog

## 0.5.27

- **修复「已安装」tab 卡片网格右侧空白**（用户 m10903 反馈「页面右边仍然是大片空白，卡片区中一行并未填满」）：
  - `client.js:92` `S.grid` 由 `repeat(auto-fill, minmax(240px, 1fr))` 改为 `repeat(3, 1fr)` 固定 3 列，填满面板宽度。
  - `client.js:1253` 已安装 tab 包裹 div 加 `flex: 1, width: '100%', alignItems: 'stretch'`；`client.js:90` `S.body` 加 `alignItems: 'stretch'`。
- **修复拖拽上传技能失败**（用户 m11116 反馈拖拽 agnes 文件夹报「A requested file or directory could not be found」）：
  - `client.js` 拖拽处理改用 `DataTransferItem.webkitGetAsEntry()` 递归读取 `FileEntry` 树，拿到真实目录层级；读不到时回退 `dataTransfer.files`。
  - 根目录前缀推断改为「所有文件 path 的公共第一段」，比原来只取 `dropped[0].name` 更可靠。

## 0.5.26

- **详情面板：被拒嵌入站点不再显示破图**（用户 m10464 反馈 skills.sh 详情 iframe 渲染为「禁止嵌入」破图无退路）：
  - `client.js` 详情浮层 iframe 路径新增**常显 URL 工具栏**（`makeUrlStrip`）：URL 单行省略 +「复制 URL」按钮（clipboard.writeText，成功改「已复制 ✓」）+「在浏览器中打开」按钮（window.open noopener）；CSP 黑名单分支（`makeDetailPanel`）同样保留。
  - `index.js` 新增宿主 RPC `frame.check`：`checkFrameable(url)` 对目标 URL 发 `fetch({redirect:'follow'})`，读 `X-Frame-Options` 与 CSP `frame-ancestors` 响应头，返回 `{embeddable, reason, status}`；客户端 `openDetail` 在非黑名单命中时先 `await call('frame.check',{url})`，`embeddable===false` 直接走 `makeDetailPanel` 友好提示（附 `blockReason` 文案），不再等 iframe 破图。
  - `package.json` 版本 0.5.25 → 0.5.26。
- **修复「已安装」tab 布局错乱**（用户 m10495 反馈「已装技能/已装MCP 两个标题占据右侧整列、把内容挤到左边」）：
  - `client.js:1253` 已安装 tab 包裹 div 由无样式 `h('div', null, ...)` 改为 `{ display:'flex', flexDirection:'column', gap:12 }`，拖拽区 / 已装技能标题+卡片网格 / 已装 MCP 标题+卡片网格 全部纵向全宽堆叠，不再横向并排。

## 0.5.25

- **四个源全部走 CLI 快路径（clawhub / skills.sh / browse.sh / trusttools）**：新增 `src/cli-install.js`，`src/skills.js` 各源分支先试快路径、失败 `console.log(... falling back to GitHub)` 后回退原 GitHub 逻辑。
  - `installViaClawHubApi`：直接 `https://clawhub.ai/api/v1/download?slug=<slug>` 拉 zip → 解包 → 校验 frontmatter → 落盘；不再依赖页面 HTML 抓取。
  - `installViaSkillsShCli` / `installViaBrowseShCli` / `installViaTrustToolsCli`：分别对应各源的 CLI/API 直连下载。
- **修复 clawhub 安装失败「找不到 GitHub 源仓库」**（用户 m09486 反馈）：`installViaClawHubApi` 收到的 `reference` 形如 `owner/slug`，直接拼进 `?slug=` 会 404（实测带 owner 前缀 404/15B，裸 slug 200/53KB zip）。新增 `bareSlug = slug.includes('/') ? slug.split('/').pop() : slug`，URL / 目标目录 / kebab / finalSlug 全部改用 `bareSlug`。
- **详情页改为在 DSH 客户端内打开**：`client.js` 注入 `sidebarRight`，点击「详情」→ `sidebarRight.openTab('browser')` → 插件 pane tab → inline iframe overlay；`clawhub.ai` / `browse.sh` 因 CSP `frame-ancestors` 被列入黑名单，改为直接显示详情面板 + 复制 URL。预览按钮文案由「在浏览器中查看详情」改为「在 DSH 客户端内查看详情」。
- **修复「已安装」面板位置错乱**（用户 m09737 反馈）：`grid` 增加 `alignItems: 'start'`；`title` / `meta` 改为单行省略（`overflow: hidden` + `textOverflow: ellipsis` + `whiteSpace: nowrap`，并移除 `meta` 的 `flexWrap: 'wrap'` + 加 `minWidth: 0`）。此前 `openpencil-design` 的长路径（`...\node_modules\@zseven-w\dsh-openpencil\lib\assets`）换行导致该卡片 131px、同行其他卡片 98px，网格行对齐被破坏；修复后 8 张卡片统一 98px。
- `package.json`：`dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-sidebar-right`。

## 0.5.22

- **卡片加「详情」按钮：秒开详情页，不再干等下载**（用户 m06943 反馈）：
  - 每张技能卡片在「预览」旁新增「详情」小按钮，点击经 `window.open` 在系统浏览器打开对应详情页：
    - skills.sh → `https://www.skills.sh/<owner>/<slug>`；
    - clawhub → `https://clawhub.ai/<owner>/<slug>`；
    - 其他源 → `upstreamUrl`。
  - 详情页信息齐全（安装命令、示例、版本历史），加载 <1s，替代原来「下载整仓库 tarball + 解包 + 安全扫描」的数十秒预览等待。
- **clawhub 预览失败回退：不再死胡同**：
  - `clawhubResolve`（`src/extra-sources.js`）先走 HTML 正则提取 GitHub 源仓库（原路径），失败时回退到 `clawhub.ai/api/v1/search` 结构化 API，从结果的 `links.source` / `install.sourceUrl` / `sourceIdentity.repo` 字段定位仓库；两者皆无则抛错并附详情页 URL。
  - `index.js skills.preview`：clawhub 源的全量下载路径失败时，不再向上抛错，改为返回 `{ openUrl, previewError }` 结构体；`client.js` 预览弹层收到 `openUrl` 后显示「在浏览器中查看详情」按钮，替代原来的 `预览失败：…` 死胡同错误。
- **「已安装」面板：去掉顶部输入框+导入按钮，改为拖拽文件夹**（0.5.21 已实现，随本版合入）：
  - 虚线拖拽区（`onDragOver`/`onDrop`）+「浏览文件夹」按钮（`<input type=file webkitdirectory>`），选中含 `SKILL.md` 的文件夹后批量上传。
- **tdd 等 skills.sh 嵌套技能安装修复**（0.5.21 已实现，随本版合入）：
  - `src/github.js` 新增 `findSkillDirFor`：探测 `skills/engineering/<slug>/SKILL.md`、`skills/<slug>/SKILL.md`、`.agents/skills/<slug>/SKILL.md` 三候选路径。
  - `src/skills.js` skills.sh 分支在 `skillDir` 为空时自动探测嵌套路径，修复 `mattpocock/skills` 的 `tdd`（上游 `skills/engineering/tdd/`）安装后「未显示在已安装列表」的问题。

## 0.5.20

- **「已安装」面板补全 DSH 内置与插件携带技能**（`collectDshNativeSkillDirs` 重写）：
  - 原实现只收集 `$AGENTS_HOME/skills` + `settings.skillDirs`（market 安装目录 + .custom-skills），遗漏了两类技能：
    1. **宿主安装目录内的应用内置技能**（`resources/runtime/office-skills/`，office/office-docx/office-pptx 等 7 个）；
    2. **profile node_modules 里插件包自带的 SKILL.md**（如 `@zseven-w/dsh-openpencil` 的 openpencil-design）。
  - 新实现追加两个扫描源：
    - `process.resourcesPath`（Electron 宿主注入）→ `resources/runtime/` 下递归找含 SKILL.md 子目录的父目录；
    - `findProfileNodeModules()`（优先 `DSH_PROFILE_DIR` 环境变量，否则扫 `~/.dsh/profiles/*/node_modules`）→ 遍历顶层包（scoped `@scope/name` 展开一层）递归找技能目录。
  - `findSkillDirs` 返回"含 SKILL.md 子目录的父目录"（与 `listInstalledSkills` 的扫描语义一致——后者对每个 dir 做 readdir 找子目录里的 SKILL.md）。
  - 验证：宿主上下文 dry-run 共 13 个技能（用户 5 + 内置 7 + 插件 1），`skills.list` RPC 返回全部四类来源。

## 0.5.19

- **对话框底部按钮栏新增「技能」「MCP」两个快捷按钮**（composer 输入行左侧，`conversation.input.left` 槽位）：
  - 点「技能」弹出已安装技能列表（宿主 RPC `skills.list`）；点「MCP」弹出已安装 MCP 列表（宿主 RPC `mcp.list`）。
  - 点击条目把一段调用提示**插入输入框草稿**（不覆盖已有内容、不直接发送）：技能插 `使用技能 /slug（简介）…`，MCP 插 `使用 MCP 连接器 name（transport/挂载状态/工具前 8 个）…`。
  - 弹窗底部「去技能市场 / 去 MCP 市场」按钮经宿主 `layout.selectPanel('dsh-market')` 直接激活市场面板。
  - 交互细节：外部点击 / Escape 关闭（quick-resume popover 范式），按钮 `onMouseDown` 阻止失焦，已加载列表在会话内缓存避免重复 RPC。
  - `package.json` 的 `dsh.client` 补 `inject: ["@deepseek-ai/dsh-client-ui-conversation"]`，宿主先载入 conversation 包（提供 `inputActions` / `useInput`）再加载本插件浏览器半边。
- **预览提速：github / skills.sh（裸 owner/repo 与页面 URL）走单文件快路径**（`skills.preview`）
  - 原路径：整个技能目录 `listTree` + 逐文件下载 + 读回再删临时目录（本机直连 GitHub 不稳时极慢，用户反馈「预览和安装的速度都很慢，耗时很长」）。
  - 快路径：只拉 `SKILL.md` 一个文件（raw → jsDelivr 兜底），用 `skillMetaFromText` 解析 frontmatter 即返回；单文件取失败（404/网络）才回退整目录路径。
  - skills.sh 裸 `owner/repo` 直接走 github 快路径；页面 URL 用 `lookupSkillShRepo` 本地正则解析出 repo+skill 后同样只拉单文件，免掉原来「抓整页 → 正则解析 npx 命令」的 25 秒网络跳（`src/sources.js` 新增 `lookupSkillShRepo` 导出）。
  - 安装（`skills.install`）保持全目录下载不变（预览只是看简介，快路径不能替代安装）；skills.sh 安装路径改走带缓存的 `resolveSkillsShInstall(url, cache)`（`src/skills.js` 签名加 `cache` 参数，`index.js` 三处调用点传 `marketCache`），首次抓页后 24h 内重复安装/预览免再抓。

## 0.5.18

- 修「上传技能」对带 Python 虚拟环境 / 构建产物的技能目录误拒：前端 `<input type=file webkitdirectory>` 读出文件后、宿主 `uploadSkillFromFolder` 读盘时，都自动跳过 `.git`、`.venv`、`venv`、`node_modules`、`dist`、`build`、`__pycache__`、`.idea`、`.vscode`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.next`、`.nuxt`、`.svelte-kit` 等无关目录。
- 修 SKILL.md 用 YAML 块级描述（`description: >` 折行 / `description: |` 保留）时 frontmatter 解析器只读到单个 `>` / `|` 字符、导致 description 为空被拒的问题：`src/frontmatter.js` 现在识别块标量，把缩进行累积成完整描述文本。

## 0.5.17

- 新增「上传技能」按钮（已安装页导入行旁）：点击弹系统文件夹选择器（`<input type=file webkitdirectory>`），选中含 `SKILL.md` 的文件夹后整目录批量上传，子目录里每个含 `SKILL.md` 的逐个安装，全部走 `scanSkillBundle` 安全扫描。
- `src/skills.js` 新增 `uploadSkillFromFolder({ folder, skillDirs, force })`：根目录含 `SKILL.md` 整目录拷入；否则扫一级子目录逐个装；都没有则报「请选一个符合 SKILL 技能格式的文件夹」。复用 `installSkill` 的 `writeSkill` 规则（frontmatter 校验、`.market-install.json` 元数据、`uniqueSlug` 去重）。
- `index.js` 新增 `skills.upload` RPC：支持 `body.path`（宿主本地目录）或 `body.files`（前端读出的文件数组，宿主解包到临时目录再上传）；成功后对每个新装技能 `registerInstalledSkillToCatalog` 注册到 DSH `/` 浮窗。
- `client.js`：导入行「导入」按钮旁加「上传技能」按钮，`busy==='upload'` 时禁用，成功后 notice 显示上传的 slug 列表并刷新已安装。

## 0.5.16

- 「已安装」页改为**卡片网格布局**（与技能市场 / MCP 市场同款 grid，一行多张卡片自适应换列），已装技能与已装 MCP 两段都换；卡片加了 220px 最小宽度避免窄格挤压。

## 0.5.15

- 面板「加载更多」按钮升级为**分页导航**：上一页/下一页 + 页码（中间省略号折叠，点「…」向后跳 5 页）+ 每页条数选择器（12/24/48），SKILL 与 MCP 两个页签统一；总页数未知时（官方注册表按 cursor 翻页）退化为「上一页 / 第 n 页 / 下一页」。
- `index.js` 的 `mcp.search` 透传 `size`，注册表页大小随选择生效。

## 0.5.14

### skills.sh 的卡片终于有真正的简介了

- 之前 skills.sh 的卡片要么只有「mattpocock/skills 收录于 skills.sh 的技能」这种通用文案，要么把
  SKILL.md 里的残留符号（实测出现过 `>`）当成简介。现在直接读 skills.sh 详情页的 meta 描述——
  一次请求一条、最准；只有连 meta 都没有时才回落到仓库里的 SKILL.md 头。
- 补描述增加总时间预算（9 秒）：超时就先把卡片发出去，描述退回通用文案，面板不会为了几十条描述
  一直转圈。实测暖缓存翻页 3.8 秒、24/24 有真实简介。
- 描述质量加了校验：不足 12 字、纯标点符号（`>`、`#`）一律丢弃，不再冒充简介。

## 0.5.13

### 修掉 `skill_market_search` 工具直接报错（面板没暴露的真实缺陷）

- **`fallbackCache is not defined`**：0.5.10 重写分页时删掉了 `src/sources.js` 里的进程级兜底缓存，
  但 `searchSkills()` / `warmMarketCache()` 的默认参数还在引用它。面板走的是宿主传入的缓存，所以看不出来；
  只有不带 `cache` 调用时才炸——也就是 agent 直接用 `skill_market_search` 工具的路径。
- **skills.sh 浏览不再只看到 48 条**：`browseSkillsSh` 之前只会「读」缓存里的全量目录，从不自己「抓」；
  没预热过缓存（工具路径、刚重启）时永远只显示首页推荐。现在最多等 12 秒抓 sitemap 目录（约 2 万条），
  超时才回退首页推荐并给提示，同时把抓取留在后台继续，下次打开就是全量。
- 新增 `test/test-nocache.mjs`：不带 cache 参数逐一验证 8 个源 page1/page2 都有数据且零重叠，
  再验证 `all` 聚合与 `warmMarketCache()`——这类「默认参数引用了已删除变量」的缺陷以后会被测试挡住。

## 0.5.12

### 面板侧补齐注册表分页（0.5.11 只修了宿主侧）

- **官方注册表下「加载更多」点了没反应**：宿主已经能翻页，但 RPC `mcp.search` 仍返回 `totalPages: 1`
  且不带 `canLoadMore`，面板据此判定「没有下一页」把按钮置灰。现在 RPC 同样返回 `canLoadMore`；
  注册表没有总页数时 `totalPages` 为 `0`，不再假装是 `1`。
- 注册表状态行不再把「本页 24 条」写成「24 个结果」，改为 `已显示 24 个（可继续加载）`。
- 追加分页时按 id 去重：注册表按版本行翻页，同一 slug 可能跨页出现，去重后列表才不会重复。

## 0.5.11

### MCP 官方注册表也能「加载更多」+ 修掉测试暴露的三个缺陷

- **官方注册表分页**：注册表是 cursor 分页，而且按「版本行」翻页（同一个 server 的多个版本会占多行，
  一页 10 行去重后可能只剩 5 个），所以现在先累积去重目录再切片：前三页各 24 条、零重叠。
  顺手修掉一个静默 bug：分页缓存只存了 items 没存 cursor，导致**第二页永远回到第一页**。
- 面板 MCP 页两个市场（官方注册表 / LobeHub）都显示「加载更多」；注册表没有总页数，按钮显示
  `加载更多（第 n 页）`，到底显示「已到最后一页」。
- **LobeHub 安装失败修复**：卡片 id 带 `lobehub:` 前缀，取清单时没剥掉 → 404 被当成「没有声明启动方式」。
  现在剥掉前缀，并按 `deploymentOptions[].isRecommended` 选推荐配方；清单里 `configSchema` 声明为必填的
  变量写成 `${VAR}` 占位（值留在用户环境变量里）。
- **`uninstallSkill` 的 `trashDir` 之前被忽略**，回收站一直写在技能目录下；现在传了就写到传入位置，
  跨盘仍走 copy+delete 兜底。
- 新增 `test/test-features.mjs`（29 项）：注册表浏览/翻页/缓存命中后翻页/关键词/定义解析/配置映射、
  LobeHub 浏览/翻页/排序/分类/搜索/清单解析、MCP 纯函数、安装前安全扫描、技能安装/编辑/卸载。

## 0.5.10

### 「加载更多」对每个源都真的能翻到新条目（0.5.9 的妥协做法已废弃）
0.5.9 把不可翻页的源「置灰」并标注「（当前源已取完）」，那不是上游的限制，是我实现偷懒：
skills.sh 只抓了首页那 48 条精选，其余源也只取了第一屏。参照 `hermes-business-agent` 里的
`unified_skills_client.py`（服务端 page + 全量目录本地切片），现在每个源都能真正翻页：

| 源 | 翻页方式 | 规模 |
|---|---|---|
| `skills.sh` | sitemap 全量目录 `sitemap-skills-1/-2.xml` → 缓存 24h → 本地切片 | ~20 000 |
| `clawhub` | 顺 `nextCursor` 累积本地目录（每屏 50 条） → 本地切片 | 持续增长 |
| `browse.sh` | 一次取整份目录（约 480 条）→ 本地切片 | ~480 |
| `lobehub-agent` | `index.json` 全量（约 505 个 agent）→ 本地切片 | ~505 |
| `skillsmp` | 服务端 `?page=&limit=` | ~1 200 |
| `trusttools` | 服务端 `page`（实际 10 条/页，按批拼接） | 579 074 |
| `skillhub` | 服务端 `page` | 226 000+ |
| `modelscope` | 服务端 `PUT PageNumber/PageSize`（新增源） | 88 862 |

- 客户端改为**请求下一页并追加去重**，不再「把 pageSize 加大重查」；按钮显示 `加载更多（n/m）`，
  到底显示 `已到最后一页（n/m）`（SKILL 与 MCP 一致）。
- 聚合源（`all`）也按页返回：8 个源各出 12 条，翻页后整页无重复。
- `skills.sh` 列表接口本身没有简介字段：读不到 SKILL.md 时给一句诚实兜底，卡片不再空白。
- 新增 `test/test-paging.mjs`：逐源断言「第 2 页与第 1 页零重叠、hasMore/total 合理」，并覆盖
  聚合源与关键词搜索的翻页。

## 0.5.9

### 「加载更多」对各源真实可用 + 修复切换源反复重查/不可达误报
- **加载更多**：此前点「加载更多」只是把 `size` 加 24 再查一次同一查询——
  多数技能源（skills.sh / clawhub / skillsmp / trusttools / lobehub-agent）的上游是**单页/无分页**，
  重新查只会拿到同一批，所以按钮「点了没反应」甚至把整页换掉。现在：
  - 后端按源判定 `canLoadMore`（只有 `skillhub` 支持真实翻页；MCP 的 LobeHub 本就带 `page`），
    非可翻页的源「加载更多」置灰并标注「（当前源已取完）」，避免误点；
  - skillhub「加载更多」真正传 `page`，取到新一批；
  - clawhub 浏览改用 `?limit=`（实测 limit=50 有效），搜索拼接两页，加载更多能取到更多；
  - skills.sh 浏览/搜索的描述补齐加**负缓存**（404/403/451 才记），把 80s 级等待降到 ~10s。
- **切源不再白屏重查**（0.5.8 已做的 stale-while-revalidate 结果缓存）保留；本次修复
  clawhub「不可达：fetch failed」的间歇误报：clawhub 浏览/搜索现在对网络错误做 1 次重试，
  且把「不可达」与「无结果」分开提示。
- 其余源行为经测试集核实：skillsmp/lobehub-agent/trusttools/skillhub 浏览与搜索均正常返回、
  描述完整；MCP registry/lobehub 搜索、分页、分类、排序正常。

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
