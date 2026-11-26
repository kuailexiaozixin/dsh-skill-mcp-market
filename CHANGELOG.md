# Changelog

## 0.5.179

- 修 0.5.178 台账遗留①「live-verify 把冷缓存抖动误报成回归」。缺陷形状有现网凭据：同一条判据②「监控」在 0.5.178 的三轮复验里两轮 LIVE-FAIL（C:/Users/Public/dsh-scratch/ms178-live2.log，wall=30122ms / 53625ms）、一轮 GAP（ms178-live3.log，wall=2ms）——两轮之间服务端代码没变，唯一变量是那一轮有没有正在拉整份 30,000 行 ⇒ 判据把「本轮未定性」当成「取数坏了」，回归结论是造出来的。
- RED 先行：test/test-live-verify.mjs 先加 15 条冷态判据（Test 3 形状 9 条 + Test 4 汇总取容 5 条 + Test 8 脚本形态里的冷态部分），落码前实测 **77 passed / 15 failed / 0 skipped、exit=1**，15 条红全部落在新判据上、老判据零红 ⇒ 红灯钉的是缺陷，不是手抖。
- 实现落 test/live-verify.mjs（纯 CRLF 保持，写后 350 行 / 22892B / crlf=349 / loneLF=0），八个改动点：①常量 `COLD_MARK`（:31）、`COLD_WALL_MS = 25000`（:32）、`MAX_WARM_RETRIES = 1`（:34）、`WARM_RETRY_WAIT_MS = 15000`（:35），:27-30 注释引上面那组现网读数；:16 退出码行加 `5=NOT-WARM（冷缓存本轮未定性）`、:15 用法行加 `--retry-wait <ms>`。
- ②`verdictB` 把旧「0 条 + 自承取数中断 ⇒ LIVE-FAIL」一行拆两行：**冷分支在前**（:95）http=200 且 total=0 且 hint 含 `COLD_MARK` 且 `wall > COLD_WALL_MS` ⇒ `{ verdict: 'NOT-WARM', kind: 'WARM' }`，why 里写明冷缓存抖动与「不写 PASS」；**:96 保留热态 LIVE-FAIL**（wall 缺失或 ≤25000 ⇒ 热态下的真取数失败绝不放过）。:94 的 `n > 0 ⇒ PASS` 仍排在冷判之前（拉到一半也算真取回）。
- ③`summarize` 的 HARD 取容排除 `kind === 'WARM'`（:151），冷态结论 `if (warm) return 'NOT-WARM'` 排在真红之后（:152/:154）：冷态既不许掩红，也不许把整轮兜成 PASS；:149 的 fp=old ⇒ STALE-SERVER 仍先于一切。
- ④`runAll` 新增同轮重试助手 `fetchCat`（:226-237）：只在 `isCold`（:225，http=200 + 0 条 + `COLD_MARK` + 超冷阈值四条件齐备）时等 `waitMs` 再取一次，循环带 `tried < MAX_WARM_RETRIES` 上限（:230），**全文件 `while (true)` 出现 0 次**；RPC 连不上或 http!==200 一律不重试 ⇒ 端到段打 127.0.0.1 死端口仍秒退 exit=3（Test 9 实测未变慢）。
- ⑤`shape` 留 `warmRetries`（:211）使重试次数可审计，⑥`render` 冷态行标 `(冷态)`（:302）、计数行追加 `NOT-WARM=n`（:307，旧 `rows=… LIVE-FAIL=… NOT-TESTED=… GAP=…` 前缀逐字未动），⑦两处退出码表达式加 `'NOT-WARM' ? 5`（:344/:348）且排在兜底 `: 3` 之前 —— 次序写反冷态就被误报成 NOT-RUN，⑧`--retry-wait` 覆盖等待预算（:318-319）。
- 每条静态锁都自带反证（新增 Test 10 十三判据，**内存变异不落盘**，与本仓那个真写 client.js 的磁盘变异针区分）：L1 删 `> COLD_WALL_MS` 守护 ⇒ 锁必红；L2 把上限退化成 `while (true)` ⇒ 无界正则命中、整行删掉 ⇒ 主锁取空；L3 `isCold` 放宽不看 http ⇒ 必红；L4 冷态结论排到真红之前 ⇒ 必红；L5 断言两处 exit 的 PASS0/STALE4/FAIL1/WARM5/兜底3 次序；L6–L8 用真函数跑形状（http=0 不判冷、render 标记与计数同源、fp=old 压过冷态）。落码后 **105 passed / 0 failed / 0 skipped**。
- 定性口径变化（对使用者是行为变更）：冷缓存轮的整轮结论由 LIVE-FAIL 改为 **NOT-WARM / exit=5** —— 既不是 PASS 也不是 NOT-RUN。`test:chain` 不含现网复验（只跑 test/test-live-verify.mjs），此变更不影响闸门；台账里读 exit 的人要认得 5。
- 本地测据：`npm run test:chain` 79 段全绿 chainexit=0（C:/Users/Public/dsh-scratch/chain179b.log；Test 10 增补后再复跑 chain179c.log 仍全绿）。bump 后同步 profile 镜像 package.json（:74-83 的 Test4 钉版本号）⇒ test-profile-sync 7 passed / 0 failed「mirrors report 0.5.179」。

## 0.5.178

- 修「引入渐进式加载后，分页导航器失效」（用户 m25083）。两处叠加根因，均已钉死并落码：**根因①翻页走了一次性通路** —— 渐进式门只让 `pageNo <= 1 && !append` 进 harvest（client.js:1323），`gotoPage`（client.js:1145）的翻页打到**不带 `tailCategories`** 的 `skills.search`，服务端把 category 降级成整源浏览，缓存命中分支（client.js:1299）于是把 `tailStateRef` 清成 `null`，`visibleSkills` 便把「其他」的无分类行全部滤掉 ⇒ 翻页后列表空。**根因②final 整表灌屏** —— `applyHarvestFinal` 原先 `setSkills(rows)` 不切片，分页器报「第 1/N 页」而内容是该视图全集（虚构页码）。
- 尾会话真分页（本地切片，翻页零额外 RPC）：harvest 收口时在缓存记录上打 `wholeView: Boolean(m.tail)`（client.js:323）。依据服务端语义（src/sources.js:1326-1334）——**只有 tail 会话的 final 行集才是该视图全集**（`total=finalRows.length`、`pages=ceil(·/size)`、`hasMore=false`），非 tail 收口的行集只是折叠层当页结果，绝不冒充全集。
- 两个模块级纯函数放在 island 区（消费者与组件共用同一口径，不可能两处各算一套）：`harvestPagesOf(count, pageSize)`（client.js:254，总页数只按**已取回行集**算，绝不按 `upstreamTotal` 那个目录规模算）、`harvestSliceOf(rows, pageSize, page)`（client.js:260，页码越界给空数组 —— 诚实：那一页确实没有行，不复制末页冒充）。
- final 上屏改按页切片：`d.setSkills(wholeView ? harvestSliceOf(rows, env.pageSize, env.pageNo) : rows)`（client.js:332）、总页数 `harvestPagesOf(rows.length, env.pageSize)`（client.js:334）、整集态 `hasMore` 恒 false；非 tail 态逐字维持 0.5.177 行为不动。
- `searchSkills` 新增本地翻页分支（client.js:1258-1278，21 行）：`pageNo > 1` 且非 append 且首页缓存记录 `wholeView === true` ⇒ 直接本地切片上屏，页码/页数/总数/hasMore/serverFacet/`tailStateRef`/`totalBaseRef` 全套本地落，**不发 `skills.search`、不开新 harvest、不清 tailStateRef**。未收口 / 非整集一律不接管（维持现通路）；新自由名走 `typeof harvestSliceOf === 'function'` 防御（client.js:1265），摘录体测试桩拿不到 island 助手时自动回落旧通路（同 `harvestGate` 用法，不给真跑装置新增未注入自由名）。
- tailNote 两态文案同步诚实（不留成谎的句子）：tail 态补「翻页就在这已取回的 N 条里本地翻，不再打上游」（client.js:2356）；旧服务端兜底态删掉已成谎的「翻页才会取回更多」，改为「分页器只会在这次已取回的 M 条里翻页，不会再去上游取回更多；集合以本行为准」（client.js:2361-2362）。client.js 全文件「翻页才会取回更多」清零（A 段新增 N1 零旧词锁）。
- 判据同步（冲突的旧断言按新语义**改写并加严**，不是放松）：test-panel-tail.mjs C 段原「P1 翻页走一次性通路」拆成两判据（收口整集态翻页零 RPC／未收口态仍走一次性通路且 body 无 tailCategories），E 段补 final 切片与页数调用点在场锁、每页 2 条时只上屏第 1 页两行、D 段补两态诚实句锁；SECT_WANT 段内判据 73⇒83（A 10⇒11、C 10⇒12、D 10⇒12、E 13⇒18），加 8 条条数自证共 **91 passed / 0 failed**。
- 磁盘态变异针 8⇒10 例：X9 把本地翻页分支短路成 `false &&` ⇒ 收口后翻页又打网络，必红；X10 把 final 切片退回 `d.setSkills(rows)` ⇒ 虚构页码回归，必红。两例各自跑红/还原跑绿/逐字节还原全过（该套单趟含 20 次子进程全跑，运行期间独占 `dsh-panel-tail.mut.lock`，不得并发编辑 client.js）。
- test-panel-harvest.mjs：静态锁「门只在 `pageNo <= 1 && !append` 接管」**保留不动**（门本身未改，翻页不走门）；S7 由 2 判据改写为 4 判据 + 1 条无整集对照（收口后翻页零 RPC／渲染整集第 2 页切片／页数 ceil(4/2)=2 且页码=2／首页收口只上屏第 1 页两行／缓存无 wholeView 时仍走一次性通路），夹具新增 `fmT(total)` 只对 tail 收口给整集语义；78⇒**81 passed / 0 failed**。
- 文案锁同步翻面（改判据而非回滚生产码）：test-lobehub-category-vocab.mjs:819-826 的 B3 两句由「翻页才会取回更多」改为新诚实句 —— 锁的仍是「兜底态必须说实话」，只是实话变了；126 passed / 0 failed。
- 本地测据：`npm run test:chain` 79 段全绿 npmexit=0（日志 C:/Users/Public/dsh-scratch/chain178d.log 4898 行）。chain 期间两处红的处置：① test-profile-sync「no stale copies」红 = profile 镜像 client.js 陈旧 ⇒ 按原样字节同步镜像（252071B，identical=0）后 7/0；② test-lobehub-category-vocab B3 红 = 文案锁钉住已成谎的旧句 ⇒ 见上一条。
- 本批新增纪律（写进门里）：test/test-profile-sync.mjs Test4（:74-83）要求 profile 镜像 `C:\Users\贺新\.dsh\profiles\desktop\node_modules\dsh-skill-mcp-market` 的 package.json version 与工作树一致 ⇒ **bump 版本号必须同步 profile 镜像**，否则 test:chain 必红（本批 0.5.178 bump 后即同步，Test3 的 26 个跟踪 .js 三方对拍 stale=0）。
- 发布凭据（0.5.178）：代码提交 **3fc2c83**「0.5.178 批：尾会话真分页（本地切片修分页导航器失效）+ 诚实页数口径」4 files +92/-21；发布前置提交 **98e121d**「0.5.178 发布前置：version 0.5.178 + CHANGELOG 段落」2 files +16/-1；annotated tag **v0.5.178** object=4028358a91514577eb5f488798ac1f5a274b4aae peel=98e121d80cacfdb1abc788f07e3bd27e624b444c；master 推送 1f3cb38..98e121d 与 tag 同趟一次过（git ls-remote 复核 master=98e121d / tag=4028358）。提交与建 tag 都要带 -c user.name/-c user.email（宿主 env 无 HOME/USERPROFILE 时全局 .gitconfig 的 [user] 不生效，128「Author identity unknown」实测两回：commit 一回、tag -a 一回）。
- CI run **45853484760**（run_number=172，event=push，headSha=98e121d，created 15:53:14Z → updated 15:59:26Z 约 6m12s，conclusion=success，https://github.com/kuailexiaozixin/dsh-skill-mcp-market/actions/runs/45853484760）逐步读数（匿名 jobs API，run json 存档 C:/Users/Public/dsh-scratch/ms178-ci-run.json）：Run tests (gates the publish) ✓ → **Publish package (trusted publishing) ✓** → Verify package contents only = skipped。完整日志正文匿名下载 403「Must have admin rights to Repository」（176/177 那两轮用的 gh 登录态本轮不可用），故凭据以 run 摘要 + jobs 步序为准。
- npm Trusted Publishing(OIDC) 自动出包 **0.5.178**：publish time 2026-11-26T16:02:01.845Z、shasum **670b0648ffd415c887475c4f6fae45009a3e7648**、integrity sha512-P3mQ86bR/69ZYNRrgCt6cNvgdc/JJ+ZyqvHcEZxdisVrfMfPW3q991LCjUCJCfTArLxSvwNBTT+StY5FPo+xww==；versions 总数 172⇒173；npm view 轮询第 7 轮（约 1m50s，16:00:28 仍 0.5.177 → 16:02:18 0.5.178）latest=0.5.178 ⇒ 传播延迟与 176/177 同量级；全程未手工 npm publish、未用本机 ~/.npmrc 的 _authToken。
- 装机 `dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.178` 第一趟失败 **ERR_PNPM_UNEXPECTED_STORE**（宿主 spawn env 无 USERPROFILE/LOCALAPPDATA/HOME ⇒ pnpm 把默认 store 解析到 C:\Users\贺新\.pnpm\store\v11，而 node_modules 现链的是 AppData\Local\pnpm\store\v11）⇒ 补齐这三个环境变量重跑即成：pnpm 11.28.5 Done in 9.2s、`- 0.5.177 / + 0.5.178`、Packages +1 -5、Lockfile passes supply-chain policies（298 entries in 8.5s）、自动向 pnpm-workspace.yaml minimumReleaseAgeExclude 加 0.5.178 一条。镜像复核：profile 内 package.json version=0.5.178、client.js 248108B 与工作树逐字节一致（CRLF 归一后）、新符号 harvestPagesOf×4 / harvestSliceOf×5 / wholeView×9 在场、pnpm-lock :35/:822/:2240 三条全 0.5.178 ⇒ **test-profile-sync 7 passed/0 failed「mirrors report 0.5.178」**（bump 后同步镜像的纪律按预测自愈）。
- live-verify 三轮（port=54233 自发现，fingerprint=new）：第 1/2 轮判据②「监控」LIVE-FAIL=0 条且文案自承「取数中断」（wall=30.1s/53.6s，冷缓存整份 30,000 行正在拉的形状，与 0.5.169 台账 :232/:235 同款现场）；RPC 直探钉形（监控 items=0 total=0 degraded=[]，hint=「已取回的 30,000 行（目录共 89,099 条）…本类实测 0 条」且**无**「取数中断」字样 ⇒ 按 live-verify.mjs:87 该走 GAP）；行集缓存热后第 3 轮 **rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2 RESULT: PASS exit=0**（日志 C:/Users/Public/dsh-scratch/ms178-live3.log；判据③开发工具=574 vs 科研工具=57、判据④lobehub 自洽复算 total=246 win=32(333426) out=214(743) sum=334169、判据⑥硬分类最慢 wall=12ms）。GAP 两条与 176/177 台账同形：①「监控」=ModelScope 可达集合外覆盖缺口（产品决策留用户）②服务端旧通路 __cat_other 信息项。
- 本批现网生效面（诚实边界）：1f3cb38..HEAD 只动 client.js 与三个测试套件，src/ 与 index.js 零改动 ⇒ 面板 bundle 随 profile 即换，服务端进程不受本批牵动；分页器本地切片的**两态画面凭据**仍需宿主重载面板后复拍（待用户点菜单『重启应用与 Host』；BEFORE 底稿 C:/Users/Public/dsh-scratch/before174-chips.txt、ms177-before.txt、ms177-tail-live.txt）。
- 本批遗留（0.5.179 候选）：①live-verify「监控」冷缓存两轮红一轮绿 ⇒ 该判据对冷启动抖动没有防抖，宜加「同轮重试一次再定性」或把 wall>25s 的中断措辞单列 NOT-WARM 态；②TAIL_CATEGORY_SOURCES（src/sources.js:549 硬编码名单）应由源侧自描述取代 + skillhub/modelscope facet 声明位；③source=all 时 tail 落首个源是假设；④5 个无判据导出（env/mcp-registry/lobehub-market）；⑤test-github-transport 缺位；⑥RED 期死 skip；⑦HTTP_BLOCKED_OPS 空集（index.js:1144）观察；⑧src/sources.js:1169 注释与实测不符待订正。

## 0.5.177

- 「其他」分类真筛选（用户三连报障 m23333 全修）：点合并入口不再是本地筛已取回的那一页，而是**服务端按 covers 逐类取数 + 面板走既有 harvest 渐进通路**。harvest.start 新增入参 tailCategories（slug 数组，normalizeTailCategories src/sources.js:553 单点清洗：String+trim、去空、去重、上限 400），index.js:1906 只透传不解释；收口新增 meta.tail 六字段 {categoriesTotal, categoriesFetched, categoriesFailed, upstreamTotal, windowed, retrievedTotal}；一次性 skills.search 出参逐字段不变（test-harvest Test 11 锁 13 键键序逐字）。
- 报障①页数谎言（缺陷 D1）：foldFanResults :889 原先 pages = max(pagesSum, ceil(total/size)) 会用整源 total 覆盖源自己声明的窗口深度 ⇒ skillsmp「调试工具」545885 条被算成 22746 页而实际只有 20 页。现按 declared/windowed 双档夹深度（:814-824 记 closedDepth/windowedDepth，:926-931 只在源已声明有限深度且该源闭合或窗口态时夹），total 口径不动；复现探针 C:/Users/Public/dsh-scratch/ms177-d1.mjs（改前 pages=22746，改后 20）。
- 报障②③0 结果的三条根因（均已证）：R-a lobehub 默认页 60 行分类全落窗内 32 类且 743 条沉在 361758 条尾部（HTTP 列表面 401 Missing bearer token，取行唯一通路是 CLI --category，单类实测 4.4~11.8s）；R-b skillsmp facet 被上游 400 拒 ⇒ facetUsed 为空 ⇒ 行内无分类 ⇒ covers 谓词恒假；R-c 面板谓词只作用在已取回当前页。⇒ 逐类取数用词表真 slug（skillsmp 63/63 全被接受，猜测 slug 才被拒）、query 必须为空（extra-sources.js:1114 带关键词时静默丢 facet）。
- 上游窗口硬顶取证（探针 ms177-deep.mjs）：skillsmp 每类可浏览窗口 **480 行**，page=10/11/15/25 返回同一批行，带 sortBy=stars/recent 同样封顶 ⇒ 「继续翻页遍历」在上游不成立，窗外合计的诚实口径只能是「已取回 N / 上游合计 M」；skillsmp payload 新增 windowed 字段（extra-sources.js:1184 isCapped || maxResults!==undefined || totalIsExact===false）供聚合侧如实标注。
- 谎报修复（lead 抓到、孩子报告低估的缺陷）：什么都不声明 facet 的源（modelscope src/extra-sources.js:1580、skillhub src/skillhub.js:169-178 返回体无 serverFacet/facetUsed）原先把**词表外分类**记为取回成功、拿整源 total 冒充该类合计、未过滤的行直接进会话。现 tail 只认**正向证明**（serverFacet === true 或 facetUsed 归一后等于该 slug），无证明一律 tailRejected 计 categoriesFailed；真机探针 ms177-msref.mjs 证实现盘 modelscope 传假 slug 返回 n=24 total=89063 且行内分类混杂。
- tail 态成员准入谓词（run 3/3，src/sources.js:1103-1108）：tailAdmissible(it, provenClass) 三档——分类在 covers 内放行；不在 covers 内拒收；分类为空**仅**「来自已作证的逐类取数」放行（主扇出默认页的无分类行一律拒收，依据面板既有口径「unknown 不是杂项桶，宁缺毋滥」）。谓词同时落在两条 push 路径（onSettled :1134、msOnPartial :1158 不传 proven；tail 侧 :1211 刻意不传、:1237 整类归因传 true）与收口并集 :1299/:1309，finalMeta.total === finalRows.length 可加性由 T14d 锁死；谓词拒收不计 categoriesFailed（失败只指上游取数失败/facet 被拒）。
- 面板侧（client.js 85/-35）：tailCoversRef（:2242 取 chipFold.other.covers 前 400）仅在 cat === CAT_OTHER 且非空时随 harvestFirstPage 下发 tailCategories（:1294/:338），__cat_other 本身绝不下发（:1198 降级为 all 的 D 防线保留并由 X7 变异证明未拆）；tail 态不再对已取回行做本地 covers 筛（改吃服务端 tail 声明）；缓存命中分支恢复 tail 态（:1256）；逐类取数进度与完成态走既有 notice 通路（多少显多少，无时间预算截断，合 m20111/m20122）。
- 「窗外」改名「其他」（用户 m23533/m23543/m23544 定案：Tab 文案恰好两个字、不带任何数字）：CAT_TAIL_LABEL 窗外⇒其他（:517），合并入口 chip 文本只留 label（:2814-2816），类数与合计移入按钮 title「未列出的分类还有 N 类，合计约 M 条」（:2829）与结果区说明行（:2314-2319）；上游真杂项桶经 categoryLabelLite 自带条数（如「其他 2360」）并由 genericBucket/splitBuckets 沉底 ⇒ 撞名在文本层区分，categoryLabelLite 未改。全文件「窗外」「窗内之外」字样清零。
- 牵连文案锁同步翻面（孩子承担，非放松断言）：test-lobehub-category-vocab.mjs 34/34（:588 标签常量、:597 窗口承接、:673 文案自带身份、:822 tailNote 两句由「必须叫窗外」改为「必须叫其他」）、test-category-info-declaration.mjs 4/4、test/live-verify.mjs 6/6 与 test/test-live-verify.mjs 1/1、test-panel-harvest.mjs 35/6（S1 拆两判据：窗内/全部态 harvest.start 入参与 skills.search 逐键相等且不得出现 tailCategories 键，窗外态才允许多该键；S4/M4「CAT_OTHER 绝不下发」未放松）。
- 新增套件 test/test-panel-tail.mjs（492 行纯 LF，**81 条判据**）：面板 tail 编排与文案锁 + 8 例自带磁盘态变异（X1 无条件下发 / X2 普通分类也下发 / X3 缓存丢 tail / X4 进度分支删 / X5 无分类行错杀 / X6 windowed 句写反 / X7 D 防线拆除 8 红 / X8 title 回退旧比喻 3 红），子进程经 spawnSync(process.execPath, [本文件]) + DSH_MUT_CASE 注入，写 client.js 前必须持 safeTempDir()/dsh-panel-tail.mut.lock 独占锁（:25-36 wx 创建 + pid 探活 + stale takeover），未持锁 writeClient 直接抛。
- 测据缺口返工（如实记录）：run1 交回后 lead 亲跑磁盘态发现 Test 12 的夹具全带 facet 声明位（serverFacet 或 facetUsed），永远看不到「什么都不声明」的真机形 ⇒ E2 判据形同虚设；run2 补 I4 正证门与假分类真机复现；run3 补 Test 14 十一条（T14a covers 外主扇出行不进 finalRows 也不进任何中间包 / T14b covers 内照常进（改前即绿，对照） / T14c 无分类行双向不同答案各一判据 / T14d total===行集===retrievedTotal+扇出合法成员 / T14e 非 tail 会话 150 条既有判据逐条不变）。红基线 154/10（10 条红名逐条在册），实现后 165/0。
- lead 亲验变异（非轻信孩子自证）：server 侧 src/sources.js 磁盘态 M-A 删 :1114 谓词 ⇒ 164/1、M-B 第(3)档写反 ⇒ 156/9、M-C 删 :1299 收口过滤 ⇒ 155/10、M-E 删 :1119 记键 ⇒ 159/6、M-D 单删 :1309 ⇒ 165/0（等价变异，如实记录）、M-D2 :1309 改恒 false ⇒ 158/7 ⇒ 谓词两侧均非 vacuous；孩子 7 例（P1-P7）全 byteIdentical。D1 撞面五套改前改后各跑一遍（search-fanout-latency 207/0、clawhub-quality 86/0、total-pages 38/0、skillsmp-search 73/0、paging-deterministic 30/0）⇒ 夹深度未打破任何既有页数判据。
- 本批事故与加固（如实记录）：lead 自建的外部变异探针与 test-panel-tail 自带变异并发跑，把 client.js 留在 X5 变异态且整 run 超时；按孩子交付锚点逐字节复原至 248189B / sha256(24)=d0b069d826d17da38a1f9caa 一致，复跑 81/0 且 8 例 byteRestored=true。定案：**不得在外部对 test-panel-tail.mjs 做磁盘变异**（该套件单趟含 16 次子进程全跑，远超 420s），面板文案锁只由套件自身 X1-X8 自证 + lead 只读校验。
- 门登记：package.json version 0.5.176⇒0.5.177，test:chain 75⇒79 段（新增 test-zip-safety.mjs、test-provider-frontmatter.mjs、test-repair-guard.mjs、test-panel-tail.mjs）；test-suite-inventory 12/0（游离红自愈）、test-gate-contract 54/0、test-gate-replay 50/0/0、test-cleanup 14/0、test-temp-hygiene 7/0、test-dead-exports 47/0。
- 文档同步：README.md 章节「窗外分类」改写为「未列出的分类（「其他」的真筛选）」8 条新口径（covers 并集/逐类取回/只认正向 facet 证明/撞名文本层区分/小尾巴展开态/说明行真实数字），:289 补「其他逐类取数会话除外」口径注，:379 标注 1371s→30-80s 是 0.5.166 时 69 段链读数；docs/ARCHITECTURE.md:39「startHarvest / pollHarvest」是不存在的函数名 ⇒ 改「makeHarvestStore 的 start / poll」，模块职责表补齐 10 个漏写模块（enrich/cli-install/lobehub-market/sort-capability/rpc-guard/env/tool-filter/toolcall-guard/session-repair/auto-repair）；test/replay/README.md 补 2026-11-26 复核（replay-full2 档案实存 271 files/11,763,131B，仓库内 test/replay/store* 已被 .gitignore:20 屏蔽 ⇒ 「档案留两份」退化为一份，test-gate-replay.mjs:43 自造临时档案不受影响）。
- 发布凭据（0.5.177）：提交 **d733f5bb3dc6b59bda8a9d7e60f98566f4235d36**「0.5.177 批：「其他」分类真筛选（服务端按 covers 逐类取数）+ 修分页器页数谎言」20 files +2710/-120；annotated tag **v0.5.177** object=87e2ca77b571f374d0116f6f32b240e19cdb1d40 peel=d733f5b；master 推送 fa12e7e..d733f5b（tag 第 1 趟网络抖、退避后 TAGTRY1 OK，git ls-remote 复核 master=d733f5b / tag=87e2ca7）。
- CI run **45778439048**（event=push，headSha=d733f5b，conclusion=success，日志 C:/Users/Public/dsh-scratch/ms177-ci.log 39965B）末两行「[GATE] **79/79 suites green**」「[GATE] total 341s across 79 suites」；门内关键读数 test-harvest PASS 4s 165/0、test-panel-tail PASS 86s 81/0、test-anchor-lib PASS 44/0、test-profile-sync PASS 1/0、test-lobehub-category-vocab PASS 103/0/23skip、test-live-verify PASS 69/0/1skip、test-shipped PASS 80/0/1skip。
- npm Trusted Publishing(OIDC) 自动出包 **0.5.177**：33 files / **254.9 kB** / unpacked 785.5 kB / shasum **46608050ff789f68442faf0cce7d412897e9119b** / provenance search.sigstore.dev logIndex=**4121658648**；未手工 npm publish。npm view 第 4 轮（≈1 分钟）latest=0.5.177 ⇒ 传播延迟真实。
- 装机 `dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.177` ⇒ pnpm 11.28.5 Done in 11.9s、`- 0.5.176 / + 0.5.177`、Lockfile passes supply-chain policies（298 entries in 10.6s）；镜像复核 C:\Users\贺新\.dsh\profiles\desktop\node_modules\dsh-skill-mcp-market version=0.5.177 且 src/sources.js 含 normalizeTailCategories/tailAdmissible/closedDepth 三个新符号（75302B、blob 纯 LF）⇒ **test-profile-sync 7 passed/0 failed**（发布前 5/2 预期红按预测自愈）。
- live-verify（port=49238 自发现，fingerprint=new，日志 C:/Users/Public/dsh-scratch/ms177-live.log）⇒ rows=14 **LIVE-FAIL=0 NOT-TESTED=0 GAP=2 RESULT: PASS**；判据③「开发工具=574 vs 科研工具=56」、判据④「lobehub 窗口/合并集合自洽 total=246 win=32(333426) out=214(743) sum=334169」、判据⑤空结果不造数、判据⑥硬分类最慢 wall=58ms。GAP=①「监控」该类 0 条且无中断措辞（ModelScope 可达集合外覆盖缺口，产品决策留用户）②服务端旧通路 __cat_other 信息项。
- tail 通路真上游冒烟（进程内直调 makeHarvestStore，证据 C:/Users/Public/dsh-scratch/ms177-tail-live.txt）：skillsmp tail=debugging,cicd,cloud ⇒ 首包 rows=11 LEAK=0、16 轮 10.8s 收口 rows=34、tail={3,3,0,upstreamTotal:649906,windowed:true,retrievedTotal:34}、total=34 pages=3 hasMore=false；lobehub tail=technical,professional,development ⇒ rows=36、tail={3,3,0,134,windowed:false,36}、LEAK=0。对照 BEFORE（0.5.176 bundle，C:/Users/Public/dsh-scratch/ms177-before.txt）同参本地筛 0 条/note「不提供分类信息」⇒ 报障②③真修有上游实证。
- **现网 RPC 面尚未换新 bundle**（诚实记录）：port 49238 的 harvest.start 带 tailCategories 探针（C:/Users/Public/dsh-scratch/ms177-after.mjs）⇒ 返回 meta **无 tail 键**、__cat_other 仍走旧拒绝通路（「不接受分类「__cat_other」（上游回 400）」）⇒ 宿主仍跑 0.5.176 之前 bundle。面板两态画面与 tailCategories 的现网端到端凭据待用户点菜单『重启应用与 Host』后用同一探针复跑（BEFORE 底稿已留）。
- CI parity 标准门（本轮新增）：git ls-files 148 个跟踪文件 CRLF→LF 复制到 C:/Users/Public/dsh-scratch/ci177-mimic ⇒ 15 套全 EXIT=0（anchor-lib 44/0、tdz-order 6/0、lobehub-vocab 126/0、harvest 165/0、shipped 80/0/1skip、provider-frontmatter 111/0、zip-safety 96/0、repair-guard 129/0、suite-inventory 12/0、cleanup 14/0、dead-exports 47/0、panel-harvest 78/0、category-info 30/0、installed-cache 88/0、panel-tail 81/0），仿真树用后删除 ⇒ 无 0.5.176 那类平台相关行尾判据残留。
- 本批遗留（0.5.178 候选）：TAIL_CATEGORY_SOURCES（src/sources.js:549 硬编码名单）应由源侧自描述分类能力取代，并给 skillhub/modelscope 补 facet 声明位；source：「all」 时 tail 落到名单首个源是假设（面板始终随单源下发）；无判据导出 src/env.js setUserEnvironmentVariable、src/mcp-registry.js registryCatalogueCacheKey/fallbackCards、src/lobehub-market.js lobehubRegistered/viewLobeHubMcp；test-modelscope-category-vocab.mjs :50/:62/:90/:166/:197/:242/:272 与 test-clawhub-category-vocab.mjs:234 的 RED 期死 skip；HTTP_BLOCKED_OPS 空集（index.js:1144）观察项；test-github-transport（readRepoFile 零调用点）。

## 0.5.176

- 已安装技能列表缓存（T-A）：src/skills.js 新增 `export function makeInstalledCache({ ttlMs = 3000, maxEntries = 32, scan = listInstalledSkills } = {})`（:93，list :103-125 / invalidate :127-130）——store Map 按 `keyOf(dirs)` 存 `{ at, value: Object.freeze(rows) }`，命中回 `hit.value.slice()` 防调用方原地改；pending Map 合并在途同 key 扫描；`generation` 代际丢弃使 invalidate 之前起飞的那次扫描结果不得写回（否则变更前旧列表会在 TTL 内继续供出）。返回 {list, invalidate, keyOf, size}。
- 为什么必须缓存：listInstalledSkills 逐目录 readdir + 逐 SKILL.md readFile 且全仓无缓存，本机 3630 个 SKILL.md 实测冷 986ms / 热 49ms；harvest 面板 250ms 轮询每个 start/poll 各扫一次全盘（index.js:1904/:1917），首包白吃近 1s。
- 接线（index.js +40/-14）：:21 import 换入 makeInstalledCache、:48 模块级 `const installedCache = makeInstalledCache();`；只读 8 点 :608/:805/:872/:1272/:1438/:1755/:1904/:1917（`await listInstalledSkills(` 残留 0）；失效 14 点 :364/:509/:853/:889/:1303/:1312/:1326/:1337/:1353/:1394/:1437/:1543/:1582/:1622 覆盖 install/uninstall/import/importZip/restoreFromTrash/emptyTrash/updateSkill/toggleSkillFile 全部变更面。
- 顺带修掉 skills.upload 的 N+1 全盘扫：原 :1415-1423 在 for-of 里逐条调 listInstalledSkills（每条一次全盘 readdir+readFile），现改为循环前 `installedCache.invalidate()` 一次 + 循环内 `installedCache.list()`（index.js:1437/:1438），一批 N 条只扫一次。
- harvest 首包不再冷扫：start 与 poll 共用同一 TTL 窗口（installedCache :93 默认 ttlMs 3000 > 面板 250ms 轮询间隔），250ms 节奏下同一浏览会话只扫 1 次全盘。宿主面 `invalidateSkills`（声明 :371、调用 :497/:515/:1307/:1317/:1593）与新增缓存无关，同名不同物，未被复用。
- TDD 判据缺口与返工（如实记录）：run1 的变异自证在内存内 `new Function` 跑，红=10/10 但覆盖不到磁盘态；lead 亲跑变异把 `if (generation !== at) return rows;` 整行删除，test-installed-cache 仍 84/0 全绿 ⇒ 代际丢弃当时 0 判据锁住。返工（run 2/3，边界只改测试文件）补 2 条端到端断言「在途扫描期间 invalidate：那次结果不写回缓存（size 归 0）」「脏写被代际丢弃，下一次拿到新扫描的结果」，自证清单加 F6（删 guard）/F7（判据取反）。
- lead 复验变异（改盘→跑→字节级还原，restored equal=true）：删 generation guard ⇒ 79 passed/9 failed exit=1；判据取反 ⇒ 79/9；删 `generation += 1;` ⇒ 80/10（含「失效时递增代际（丢弃在途结果）」）；另 F1 TTL 恒假 ⇒ 71/10、F5 返回冻结本体 ⇒ 77/6、删 pending.set ⇒ 78/6、删淘汰 ⇒ 77/7 均红。终态 test-installed-cache **90 passed / 0 failed**（新建 313 行/20038B 纯 LF，12 例工厂变异 + 5 例 index 语义锁）。
- 渐进式加载契约零改动复核：test-harvest 91/0、test-panel-harvest 70/0、test-search-latency-recovery 99/0、test-search-fanout-latency 207/0、test-live-verify 判据套件绿 ⇒ 缓存只吃扫描成本，未改 rows/installed 标记语义。
- src/shipped.js 首次行为级覆盖（T-B）：新建 test/test-shipped.mjs（283 行/17510B 纯 LF，8 个 Test 块 81 判据，**80 passed / 0 failed / 1 skipped**）——SHIPPED 键集、candidateFiles 五组布局逐一命中与三段/单段包名拆段、未命中回 null 不抛、优先级链 explicitRoot > env.DSH_SHIPPED_ROOT > process.resourcesPath > execDir/resources > execDir（含显式根落空后继续试 env 根）、importShipped 真 import 命名导出与 default、重复导入命中缓存、同根两包不串台、失败时 cache.delete 后再补齐依赖可成功、错误文案、pluginFrom 恰五键且 reusable:true。前置 LAYOUTS 表 + plant() + withStubbed()（临时改写三个进程级根再 finally 还原），temp 目录一律 safeTempDir()。
- lead 亲验 shipped 变异 7 例（均转红后还原）：删 `cache.delete(file);`、ENTRY 改 lib/main.js、显式根注入错值 ⇒ 71/9、单删 layout-4 候选、删 layout-5 ⇒ 79/1、删 `push(execDir);` ⇒ 79/1、删 env 根 push ⇒ 78/2 ⇒ 五组布局与优先级链逐条有活判据，非 vacuous。src/shipped.js 一字未改（git hash-object = 0d82dae1334724ec5aef92b66f310319baf5b298 = HEAD blob）。
- 门登记：package.json version 0.5.175⇒0.5.176，test:chain 73⇒75 段（末两段 test-installed-cache.mjs、test-shipped.mjs）；test-suite-inventory 12/0（此前「游离: test-installed-cache.mjs, test-shipped.mjs」的预期红按预测自愈）、test-gate-replay 50/0/0 档案不失真、test-gate-contract 54/0（含 0.5.175 批1 的 timeout-minutes 锁）、test-cleanup 14/0、test-dead-exports 47/0、test-temp-hygiene 7/0、test-index-runtime 26/0、test-rpc-surface 6/0、test-new-features 43/0。
- 首次 CI 红与修复（run 45703064264，headSha=e2082f5，conclusion=failure）：日志 C:/Users/Public/dsh-scratch/ms176-ci.log（287 行）末段「[GATE] 74/75 suites green / RED suites: test-installed-cache.mjs(FAIL) / publish blocked: 1/75 suites red」，四条红全在 Test0 行尾锁：「index.js loneLF=0 [loneLF=1985]」「src/skills.js loneLF=0 [loneLF=984]」「index.js 仍为 CRLF 盘」「src/skills.js 仍为 CRLF 盘」。根因=该套件的平台相关断言：仓库 blob 全 i/lf，本机 core.autocrlf=true 工作副本读出来是 CRLF、CI ubuntu 检出是 LF，同一判据一边绿一边必红；本机 npm test 74/75 绿是假绿（判据读的是 Windows 工作副本而非仓库态）。这正是 test-search-fanout-latency.mjs Test12（:472-477）已钉死的旧教训，新套件又重写了一遍。
- 修法（只改 test/test-installed-cache.mjs，生产码零改动）：Test0 四条改两条平台中立不变量「不许混用行尾」（同文件同时出现 CRLF 与孤立 LF 才红），删掉无引用的 loneLf helper；判据数 90⇒88（净 -2 条断言，非删功能）。变异反证非空洞性：在 LF 检出仿真树里把 index.js 注入一处 CRLF ⇒ 87 passed/1 failed「index.js 无混合行尾 [true]」，还原 ⇒ 88/0。同时补跑 LF 检出仿真（全部跟踪文本文件 CRLF→LF 复制后跑）三套全绿：test-installed-cache 88/0、test-shipped 80/0/1skip、test-search-fanout-latency 207/0。
- 发布闭环凭据：CI run **45710917573**（tag v0.5.176 触发，headSha=f65a10e，5m2s）conclusion=success，日志 C:/Users/Public/dsh-scratch/ms176b-ci.log（339 行）末段「[GATE] 75/75 suites green」「[GATE] total 240s across 75 suites」；门内 test-installed-cache PASS 2s 88/0、test-shipped PASS 0s 80/0/1skip。前一次同 tag run 45703064264（headSha=e2082f5）failure=首红，tag 按 0.5.172 先例重打指向最终绿码。
- npm Trusted Publishing(OIDC) 自动出包 dsh-skill-mcp-market@0.5.176：33 files / 247.1 kB / unpacked 764.9 kB / shasum 2ce3ab36ce7dbbd744a1d31433b8fab09b8bb03a / provenance 透明度日志 search.sigstore.dev logIndex=4112851360；未手工 npm publish。npm view 前 8 轮仍 0.5.175、第 9 轮（≈2 分钟）latest=0.5.176 ⇒ 传播延迟真实存在。
- 装机 dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.176 ⇒ pnpm 11.28.5「Done in 7.7s」deps -0.5.175/+0.5.176；实测 profile dep=0.5.176、node_modules 内包=0.5.176、pnpm-lock.yaml:36/:37/:822/:2240 四条 0.5.176；test-profile-sync **7 passed / 0 failed**（发布前那条预期红按预测自愈）。
- live-verify（port 57669 自发现，日志 C:/Users/Public/dsh-scratch/ms176-live.log）⇒ rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2 **RESULT: PASS**；判据④「lobehub 窗口/窗外自洽复算 total=246 win=32(333426) out=214(743) sum=334169」，判据③「开发工具=574 vs 科研工具=56」分类过滤真生效。GAP 两条=①「监控」该类 0 条且无中断措辞（ModelScope 可达集合外覆盖缺口，产品决策留用户）②服务端旧通路 __cat_other 信息项（0.5.165 起修复在客户端，服务端残留入口不构成回归）。
- 现网 harvest 仍未生效（诚实记录）：port 57669 直发 {op:"harvest.start"} ⇒ {"ok":false,"error":"unknown operation \"harvest.start\""}，同端口 skills.search ok:true ⇒ 宿主跑旧 bundle（AGENTS.md 禁止我自己重启）。面板渐进加载与窗外两态画面凭据待用户点菜单『重启应用与 Host』后取，BEFORE 底稿 C:/Users/Public/dsh-scratch/before174-chips.txt。
- 四端终态：master=远端=**f65a10e**，tag v0.5.176 object=7df665c（peel=f65a10e），npm latest=0.5.176，profile=0.5.176，test:chain 75 段。push 抖动复现：ls-remote 连续 3 趟「Failed to connect to github.com:443 after 21116/21160/21191 ms」⇒ 40s 退避后 TRY 成功，结论一律以 git ls-remote 为准。
- 本批遗留（0.5.177 候选）：HTTP_BLOCKED_OPS 仍是空集（index.js:1132，harvest 两 op 未在 HTTP 面屏蔽）；src/zip.js / toolcall-guard / session-repair / auto-repair / frontmatter / provider 仍薄判据；ModelScope 可达集合外的分类（如「监控」实测 0 条）覆盖与否属产品决策，留用户定夺。

## 0.5.175

- CI 墙钟兜底与死脚本清理（批1，commit 512890b）：.github/workflows/publish.yml 加 job 级 timeout-minutes: 25，删除 publish-0.5.19.ps1（手工 npm publish + 2FA 告警的死物，现行是推 v* tag 走 Trusted Publishing）；补判据 test/test-gate-contract.mjs Test 4 锁 publish.yml 必须含 timeout-minutes（54/0；删该行变异 ⇒ 53/1 转红，还原 ⇒ 54/0）。
- ModelScope 大源逐页推送（批2）：src/extra-sources.js 新增 harvestBypass（:1350 形参、:1450 判据）豁免 MS_FETCH_BUDGET_MS = 45000 的「到点就停」，30 页 MS_MAX_PAGES（上游硬限，第 31 页起 HTTP 500）与 30s 单页超时 MS_PAGE_TIMEOUT_MS 照旧；msPushPartial（:1397-1402）在断点续暖（:1439）与每页取回后（:1465）当场过滤 + 归一推给会话，与最终 categoryRows 共用 msRowInCategory（:1392）/msRowUsable（:1391），全仓只有一份 msMapItems（:1531 定义、:1572 调用，.map(msMapItems) 残留 0）。src/sources.js 侧 pushRow（:1049）与 name === "modelscope"（:1089）把回调接进 harvest 会话；一次性 skills.search 不带这两个键，出参逐字段不变。
- test/test-harvest.mjs 由 59 条增至 91 条（507 行纯 LF）：逐页增量单调、未过滤行不得出现、finalMeta 不得提前写。lead 亲验变异（每例转红后还原，还原 91/0）：删 !harvestBypass && ⇒ 87/4；把 name === "modelscope" 改名 ⇒ 84/7；注释掉 msPushPartial(nx.rows)（憋到收口）⇒ 87/4。test-modelscope-category-vocab 回归同步转绿 181/0/2skip。
- 邻近字符窗源码锁 → 语义锁（批2，12 个套件）：mcp 家族 6 套（panel-p0 22/0、status-p1 26/0、tools-popup 28/0、full-edit 47/0、raw-edit 53/0、command-guard 42/0）+ client 家族 6 套（install-progress 17→19、batch-select 42→44、manage-panel 32→35、manage-optimizations 38→39、func-fixes 9→10、lobehub-category-vocab 123→126；六套合计 196+/43-）。断言行里的 {0,N} 窗实测残留 0（逐行核过，命中只剩解释性注释）；孩子自证 16 例变异全红，另附韧性对照：往被锁代码插 544 字符注释（>0.5.174 CI 假红的 346），新语义锁 8 个插点全绿、旧字符窗版 6 个插点当场假红。成因与 0.5.174 那条「注释把 confirm 锁挤出院外」的假红同型。
- lockref-mcp run2 交回时 6 处 Test 块漏写闭括号（panel-p0「SyntaxError: Identifier 'seg' has already been declared」、tools-popup/status-p1「SyntaxError: Unexpected end of input」），由 lead 用锚点定向补齐（该批 run 2/3 已耗尽，lead 自修）。教训入册：括号深度探针会被 for (const …) { 与 check 行内大括号互相抵销 ⇒ 改「行首 {/} 平衡 + node --check 逐步收敛」。
- lead 独立验收（不采信自述）：client.js / index.js 字节未动（git status 无该项，SHA 与 pristine 副本一致）；ubuntu 检出仿真（跟踪文本全转 LF 后另树跑——CI ubuntu 检出的就是 blob 本体）下 9 套重构套件全绿 ⇒ 新锁不依赖行尾；lead 亲跑变异 4 例转红后还原——去 readManageTab 的 try/catch ⇒ manage-panel 34/1、切源不清分类 ⇒ func-fixes 9/1、删 type: 'checkbox', ⇒ batch-select 43/1、删 chip 的 padding: '4px 10px' ⇒ lobehub 122/4（该字面量在 client.js 出现 2 处：subTab 与 S.chip，单点 replace 只命中 subTab 故首试假绿，两处全删才转红 ⇒ 切片确实锁进 S.chip 体）。孩子报告里 M14「装配键 lobehub:」子串假绿一处已自纠为整词键名集合 + 值断言。
- README「渐进式加载（harvest）」(:275) 内补「ModelScope 大源逐页推」条目：写清 45s 截断只在 harvest 通路被 harvestBypass: true 豁免、一次性通路行为与出参不变；test-dead-exports 47/0、test-cleanup 14/0（两者读 README 作语料）同步复跑。
- 发布前门读数：npm test ⇒ 72/73 green，唯一红 test-profile-sync（Test 3「no stale copies」+ Test 4 版本镜像：工作树含未提交的 harvest/extra-sources 改动而 profile 仍是已装 0.5.174）⇒ 与 0.5.174 发布前同形，装机 0.5.175 后转绿；CI 侧无 profile 目录故该套件 skip，不阻断。
- 本批遗留（0.5.176 候选）：index.js:1415-1419 skills.upload 逐条重扫技能目录的 N+1；harvest 每包同步调 listInstalledSkills（本机 3630 个 SKILL.md ⇒ 冷 986ms / 热 49ms）可做首包预热；HTTP_BLOCKED_OPS 仍空集（index.js:1132，harvest 两 op 未在 HTTP 面屏蔽）；src/shipped.js、src/auto-repair.js、src/session-repair.js、src/toolcall-guard.js、src/zip.js 等薄判据模块补测。
- 发布闭环凭据（0.5.175）：CI run 45678659786 conclusion=success、headSha=9e52172（与 tag v0.5.175 peel 一致）；日志底稿 C:/Users/Public/dsh-scratch/ms175-ci.log（39121B）末两行「[GATE] 73/73 suites green」「[GATE] total 235s across 73 suites」，门内关键读数 test-harvest PASS 3s 91 passed/0 failed、test-panel-harvest PASS 6s 70 passed/0 failed。
- npm Trusted Publishing（OIDC）出包：npm view dsh-skill-mcp-market version ⇒ 0.5.175（本轮第 1 次查询即命中，无传播延迟）。
- 装机：dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.175 ⇒ pnpm 11.28.5「Done in 6.5s」，deps -0.5.174 +0.5.175，并自动向 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 加一条；随后 test-profile-sync ⇒ 7 passed/0 failed（Test 3「no stale copies」转绿、Test 4「mirrors report 0.5.175」）⇒ 发布前那条预期红按预测自愈。
- 现网一键复验：node test/live-verify.mjs（端口自发现 port=57669，fingerprint=new）⇒ rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2 RESULT: PASS exit=0。两处 GAP 与 0.5.174 同款：①「监控」该类 0 条且无中断措辞 ⇒ 可达集合外覆盖缺口（产品决策留用户）；②服务端旧通路 __cat_other 信息项。
- 面板侧 harvest 与两态画面凭据仍待用户点菜单「重启应用与 Host」：宿主现网 bundle 尚未重载，前次实测直发 harvest.start 仍回 unknown operation（本条不是新的实测，重启后会补实测凭据）。
- 工具教训（本批新增）：后台 watcher 用 ConvertFrom-Csv -Delimiter tab 取列名（"Run ID"/Status/Commit）在本机 gh 输出上不匹配 ⇒ 40 轮全打「no run yet」空转，已 job_kill 并改为一趟 gh run list --workflow publish.yml --limit 4 直读。结论：轮询脚本落码前先跑一轮打印原始列名，勿凭列名假定。
## 0.5.174

- 渐进式加载（harvest）落地：服务端新增 `harvest.start` / `harvest.poll` 两个 op（`index.js:1867`、`:1886`），会话表 `makeHarvestStore({ ttlMs: 180000, maxSessions: 8 })`（`index.js:1139`），面板 250ms 轮询增量 upsert，收口包整表替换；未知或过期 id 回 `ok:false`，面板自动回落 `skills.search`（旧服务端兼容）。
- 收口口径唯一：一次性搜索与 harvest 收口共用 `foldFanResults`（`src/sources.js:736`），聚合排序 / skills.sh 补描述 / installRef 全仓各一份（原第二份已删）；`harvestRun` 只推「到达序」增量，收口按 `picked` 序重排后走同一函数（`src/sources.js:1102`），超时未落地的源补一条 `ok:false` 进 degraded（`src/sources.js:1106`）。
- 不设「到点就停」：harvest 不复用一次性搜索的 `DEFAULT_BUDGET_MS = 12000`，真撞预算的源不落地只记 degraded，`done` 照常置真；`HARVEST_BUDGET_MS = 3600000` 仅为挂死兜底（`src/sources.js:971`）。
- `finalMeta` 补齐：收口包 meta 带上与一次性搜索同口径的 `total / pages / hasMore / serverFacet / categoryNote / filteredOut`（`src/sources.js:1117`），面板据此整表替换分页口径；中间包 meta 刻意不带这些字段，不得伪造。
- 「窗外」由披露入口改为真筛选：点击只出一个分类态、结果 = 窗外全部分类的并集（谓词 = 条目分类 ∈ `chipFold.other.covers`），不再把 214 类逐个铺成 chip；上游自带杂项桶（lobehub `general`、modelscope `其他`）不参与并集，否则与「全部」重叠；`upstreamCat` 仍把 `CAT_OTHER` 降级为 `all`，本地过滤口径不变。
- 展开/收起只在「确实多东西可看」时存在：窗外类数 ≤ `CAT_TAIL_EXPAND_MAX`(40) 才渲染哨兵，lobehub（214）/modelscope 这类大尾巴源两态同形、不再铺满整屏；展开态 `S.catsRow` 限高 116px 可上下滚动（`client.js:759`）。
- 首次 CI（run 45642081925）两红已在同批改掉并如实记录：`test-temp-hygiene` 抓到我新建的 `test-harvest.mjs:187` 用裸 `os.tmpdir()` 造夹具目录（改为 `safeTempDir()`）；`test-mcp-full-edit.mjs:133` 的 confirm 锁是「`mcp.install` 字面量后 600 字符内出现 needsConfirm」，我 harvestStore 装配（`index.js:1136-1139`）插在该串第一次命中之后 786 字符处 ⇒ 漂出窗口造成假红（不是 confirm 闸门丢了，实测 case 体内 `body.confirm !== true` 仍在）。锁改为「case 体内 `confirm … true`」语义，并对「闸门标识符改名」变异反证（baseline true / 变异 false）。
- 新增判据：`test/test-harvest.mjs`（59 条）锁住增量集合单调、收口有序、finalMeta 与一次性同值、未知 id 回落、以及「口径唯一」的源码级互斥锁；`test/test-panel-harvest.mjs`（70 条）锁面板消费。两条均有变异反证。
- 文档：README 新增「渐进式加载（harvest）」与「窗外分类（真筛选）」两节；`docs/ARCHITECTURE.md` 的 sources.js 职责行补上 harvest 与 foldFanResults 同口径。
- 发布卫生：`.dsh-tmp/`、`test-results.json`、`test/test-results.json` 均由 `.gitignore`（:11/:12）屏蔽，`npm pack --dry-run` 实测入包 33 个文件、三者皆不在其中；`.dsh-tmp` 是 lobehub 判据的 ASCII 夹具目录（`test-lobehub-category-vocab.mjs:88` 首选候选，中文用户名 Temp 会让 npx.cmd 失败），跑测试必然重建，不是残留污染。
- 本批遗留（0.5.175）：`publish.yml` 无 `timeout-minutes`；`publish-0.5.19.ps1` 是手工 `npm publish` + 2FA 告警的死物且全仓无引用（现行是推 v* tag 走 Trusted Publishing）；`index.js:1415-1419` `skills.upload` 逐条重扫技能目录；harvest 首包同步扫 installed（本机 3630 个 SKILL.md ⇒ 冷 986ms / 热 49ms）；ModelScope 30 页上界改走 harvest 逐页推送。
- 依赖面核对：本包 `dependencies/devDependencies/peerDependencies` 全空、`npm ls --all --depth=0` 为 `(empty)`，`client.js:6` 的 `require('react')` 由宿主 bundle 注入（`dsh.client.inject`）⇒ CI 无需 lockfile/`npm ci`。
- 发布闭环凭据：CI run 45644369726（tag v0.5.174，headSha=7396541）conclusion=success；日志末两行「[GATE] 73/73 suites green」「[GATE] total 235s across 73 suites」（底稿 C:/Users/Public/dsh-scratch/ms174c-ci.log:324 起）。首次 run 45642081925 的两红由同批 7396541 修掉后转绿，test-temp-hygiene 7/0、test-mcp-full-edit 47/0 均在门内读数里。
- npm 侧：Trusted Publishing（OIDC）出包 dsh-skill-mcp-market@0.5.174，package size 244.2 kB / unpacked 757.7 kB / total files 33 / shasum 1643a06af322743d38e2c41cd740eb2870396ede，provenance 已进透明度日志；registry latest 第 4 轮询（约 80s）见 0.5.174。
- 装机与镜像一致性：dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.174（pnpm 28.6s，+1 -5）⇒ profile deps=0.5.174、node_modules 内包 version=0.5.174、pnpm-lock.yaml:822 与 :2240 两条 0.5.174；test-profile-sync 由发布前 5/2 红（陈旧副本 + work=0.5.174 profile=0.5.173）转 **7/0**「mirrors report 0.5.174」。
- 现网一键复验：node test/live-verify.mjs（端口自发现=57669）跑了三轮。冷缓存两轮「监控」判 LIVE-FAIL，走的是判据 :86 分支（文案原文「0 条且文案自承取数中断」，即 hint 内含「取数中断」）；同一轮里「市场推广/开发工具」wall=30~70s 说明整份行集正在冷拉，因此那是取数失败形状、不是可达集合外的覆盖缺口，判红符合 0.5.165 口径；行集缓存热后终态 **rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2 RESULT: PASS**，与 0.5.168/0.5.172 基线同形。两处 GAP=①「监控」0 条且无中断措辞（30,000 行可达集合外的覆盖缺口）②服务端旧通路 __cat_other 信息项。
- 面板侧 harvest 尚未在进程内生效（诚实记录）：对 57669 直发 {op:"harvest.start"} 实测回 `unknown operation "harvest.start"`，而已装 node_modules/dsh-skill-mcp-market/index.js 内 harvest.start 与 harvest.poll 两串都在 ⇒ 宿主仍跑 0.5.173 bundle（default 分支 index.js:1899 抛该错），需点菜单「重启应用与 Host」加载 0.5.174 后才能取渐进加载与窗外两态的画面凭据。

## 0.5.173

- test-warm-budget 判据缺陷修复（门内 420s TIMEOUT 的根因，非实现回归）：原 Test 1 与 Test 2 各用
  全新缓存目录 ⇒ 每次跑套件都要**从零连爬两遍** clawhub 目录（本机实测 167s + 165s = 332s），在
  71 套件的全门负载下越过单套件 420s 线被硬杀；单跑偶尔绿，门内长期不可靠。
- 修法三件，均不削弱覆盖强度：
  1. Test 1/2 共享缓存目录，默认预算那一跳从 323 行接着补到 1200 行（复用后实测 61s + 98s）。
     缓存复用本身就是预热的既有契约（test-warmup Test 3 守这条），不是把断言搬走；并新增
     「默认预算确实接着上一跳补」的行为断言，防止退化成两遍从零。
  2. 耗时上限 120s ⇒ 240s、300s ⇒ 400s，并在注释里把量纲交代清楚：clawhub 每页正常 ~7s，
     命中 fetch→curl→python 降级链的页 ~28s（每级 25s 超时 + 3s 退避）。旧的 120s 等于
     「六页一次都不许重试」——那是上游抖动不是本侧逻辑；240s 仍能一刀砍死无界爬取
     （28k+ 目录按 50 页/爬满算是十几分钟量级）。
  3. 新增 Test 3「预算与错误上限的文本锁」：warmClawHubCatalog 的取页直调 getJsonClawHub
     （extra-sources.js:64），不吃可注入 fetchJson ⇒ 无法离线伪造「游标无限」的上游来证明
     预算生效，于是把预算三要素钉回源码形态（与 test-clawhub-quality 同口径）：while 里带
     rows.length < budget、while 里带 consecutiveErrors < 3、默认预算是有限字面量 1200、
     游标断掉立刻 done=true; break、爬完 { rows, cursor, done } 落缓存；五道锁各配一条
     变异反证（抹掉对应形态 ⇒ 锁必须翻转），保证锁不是恒绿。该锁不联网，门内必判。
- 读数：test-warm-budget 17 passed, 0 failed（Test 1 61s、Test 2 98s、Test 3 十条全绿）；
  全门 **71/71 suites green**（657s），test-warm-budget 由 TIMEOUT 转 PASS 101s，
  test-profile-sync 7/0（0.5.172 发布后转绿，实证上批的「镜像滞后属发布前正常态」判定）。
- 版本 0.5.173。

## 0.5.172

- 子进程环境根因守卫收口（0.5.161 / 0.5.163 两次回归同一根因，这次是根治不是清扫）：src/home.js 新增纯函数
  childEnv(extra, baseEnv) —— Windows 下只补缺失的 SystemDrive / SystemRoot / ComSpec / UserProfile /
  ProgramData / AppData / LocalAppData（SystemDrive 由 SystemRoot 前缀推导，UserProfile 回落 os.homedir()），
  调用方显式给出的键（哪怕值为空串）一律不覆盖；绝不写 process.env、绝不改动 base，非 win32 原样透传。
  此前裸奔的 7 处子进程调用全部接线：src/extra-sources.js:18（cmd /d /s /c npx）、src/sources.js:439（browse CLI）、
  src/cli-install.js:382（curl 兜底下载）、src/http.js:32 / :126 / :257（python 探针与 curl.exe）、index.js:1752；
  src/cli-install.js 原有的 env 拼装改为复用 childEnv，不再维护第二套口径。
- 新套件 test/test-child-env.mjs（57 条，已登记进 test:chain：70⇒71 段）：真跑 childEnv 断言「只补缺、不覆盖」；
  静态锁「files 白名单里不带 env 的子进程调用数 === 0」——裸调用这一类是 PR#1 Test 14 的盲区（它只锁显式写了
  env:{...} 的调用），锁函数本身是纯函数、可喂假源码自证；并以真孙进程实测 %SystemDrive% 正常展开为盘符。
- CI 首跑（run 45574263352）抓到同一根因的残余：publish.yml 跑 ubuntu-latest，homedir() 是 /home/runner（无盘符），
  SystemRoot 兜底旧写法 process.env.SystemRoot || (driveFrom(home) + "\Windows") 在 CI 上拼出无盘符的「\Windows」，
  孙进程的 %SystemRoot% 退化成相对路径——与本次要修的 bug 同形（既有平台化教训第五次目击）。改为 homeDrive 兜底：
  真实 SystemDrive → homedir 前缀 → 字面 C:，任何平台都产出带盘符的绝对路径；SystemRoot 不再优先读宿主 env（注入式）。
  判据随动补两条绝对性锁（SystemRoot 必须 ^[A-Za-z]:\Windows$、ComSpec 必须 ^[A-Za-z]:\Windows\system32\cmd\.exe$）：
  本机 57/0/0 绿；变异自证=兜底换回旧写法两条锁齐红（本机 got=C:\WINDOWS 那侧仍由「不带盘符即红」的形态锁住，
  CI 上旧写法必红）。套件登记随 test:chain 71 段一起进门。
- 发布闭环凭据（0.5.172）：CI run 45578239485（tag v0.5.172 → 8f2461f）末行「[GATE] 71/71 suites green」「total 232s across 71 suites」，
  含 test-child-env 56/0/1skip、test-live-verify 69/0/1skip、test-modelscope-category-vocab 181/0/2skip；npm dist-tags.latest=0.5.172；
  profile 装成 0.5.172（manifest 16:48:15，pnpm-lock L822/L2240）；现网一键复验 node test/live-verify.mjs（port 57560，hint 指纹=「已取回的」）
  ⇒ RESULT: PASS rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2（「监控」=可达集合外覆盖缺口、__cat_other=服务端旧通路信息项）；工作区根无 %/$ 字面路径树、.dsh-tmp absent。
- 本批遗留（0.5.173 在建）：渐进式加载 harvest.start/harvest.poll（服务端，用户原话要求 harvest 路径不得有「超预算就停」）、「其他」=窗外并集真筛选与 skillsmp 展开态可上下滚动。

## 0.5.171

- 用户 m19770 遗留项①收口：展开态去持久化。0.5.169 把分类 chip 展开偏好写进 localStorage（dsh-skill-mcp-market.cats-expanded），
  宿主重启不清 ⇒ 每次开面板都直接铺开全量标签，只剩 S.catsRow 的 maxHeight:116 兜底——m18209 原始诉求「默认就该是一行」
  被持久化吃掉了。口径改为：展开是本次浏览的临时动作，不是偏好。CATS_EXPANDED_KEY 常量与 cats-expanded 存储键在 client.js
  里彻底删除（留着不读同样是隐患），初值改成字面量 useState(false) ⇒ 重挂载 / 刷新 / 重启一律默认收起。
- 切源复位展开态：源 tab 的 onClick 里 setCategory('all') 之后补 setCatsExpanded(false)。chip 词表随源变（lobehub 246 类 /
  modelscope 20 类），展开态跨源残留会让用户在新源上直接看到一屏不相干的铺开标签，正是 m19004 抱怨的形状。
- 判据随动（用户 m19770 遗留项②）：test-lobehub-category-vocab 里旧的「展开偏好持久化（跨重挂载与刷新保留）」2 行
  替换为 4 条重挂载路径判据——CATS_EXPANDED_KEY/cats-expanded 字样零命中、初值必须是字面量 useState(false)
  （惰性初始化函数体里读存储是最容易看漏的写法，故锁字面量而非只锁行为）、切源那一段（setSource(key) 起 14 行窗口内）
  必须同时出现 setCatsExpanded(false) 与 searchSkills(query, { source: key（证明复位落在真切源路径上）、
  toggleCats 仍在位且不再写存储。套件 111 passed / 0 failed（净 +4 条）。
- 变异自证（改 client.js 跑套件后还原，sha 回基线）：M-a 删掉切源复位行 ⇒ 1 红；M-b 把 useState(false) 改回惰性读
  localStorage ⇒ 2 红（不落持久化 + 字面量初值）；M-c 在 toggleCats 里恢复 localStorage.setItem ⇒ 1 红。
- 诚实边界：去持久化之后「展开」只活在一次面板挂载内，习惯展开着翻长列表的用户刷新后要重新点一次。这是刻意取舍
  （默认一行是 m18209 的原始诉求）。若实测确有感，正解是 sessionStorage（会话内记住、重启即清），不是回到 localStorage。
- 依赖：本批改动全在 client.js（面板 bundle），插件 server 侧无改 ⇒ 装机即生效，不需要宿主重启。
- 发布闭环：CI run 45557232359（publish.yml, tag v0.5.171）completed success（3m49s，Run tests ✓ + Publish ✓）；npm 传播 7 轮 25s 轮询后 npm view dsh-skill-mcp-market@0.5.171=0.5.171、dist-tags.latest=0.5.171；
  装机 dsh plugin --profile desktop add ⇒「- 0.5.170 / + 0.5.171，Done in 8.6s using pnpm v11.28.5」。装机产物自证：profile 里 client.js 的 CATS_EXPANDED_KEY=0、cats-expanded=0、useState(false)=1、setCatsExpanded(false) 落在 :2403（切源段）。
- 面板 live 复验（同场景 Before/After，port=54733，本会话面板 tab BD699D681AB3D0D9737CFEFC2D0C0F34）：
  · 全新挂载默认收起：刷新页面后打开面板切到 modelscope ⇒ chip 行 21 个 button 全在 y=141 单行（sha256:0461df8b56eebb273030f8a8cdd99fd38e929f991eea0985acd87f504f797c15）。
  · 展开态限高仍生效：lobehub 点「窗外 214 类合计 743 条」⇒ 铺开 331 个 button，chip 容器 div box={x:292,y:141,width:970,height:116}（内部纵向滚动，sha256:c608a165e004b37a685b11a6ad6179eadbc8a1c49ded5fa96e4a0e850ea19f62）。
  · 切源复位（本批新增行为）：展开状态下点 modelscope ⇒ 回到 21 chip 单行 y=141、「收起分类」入口消失、卡片区紧随其下（sha256:f3798cd19e7f97ef6893a727b8115cd26219a2c95f5822b34654859700961366）。
- 现网一键验收（0.5.171 装机后）：node test/live-verify.mjs ⇒ port=54733 fingerprint=new，rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2，RESULT: PASS exit=0（两条 GAP 与 0.5.170 同：「监控」=可达集合外覆盖缺口、__cat_other=服务端旧通路信息项）。
- 追加 docs 前的小勘正（提交 937b76f，不升版本）：client.js 渲染块两处注释仍写「「其他」是面板自造入口」「窗外 214 类」——0.5.169 起入口已改名「窗外」、类数不该硬编码 lobehub 的 214；test/live-verify.mjs:108 备注补「0.5.171 起展开态不再持久化」。tag v0.5.171 仍 peel=d17243c（docs/注释勘正不入 tag，同 0.5.163/164/166/168/170 先例）。
- 卫生复查：工作区根 60 条目、字面 %SystemDrive% 树 absent、仓库根 git status 干净、.dsh-tmp absent（.local 与 undefined 是既有合法条目，非本轮产物）。

## 0.5.170

- 现网实拍缺陷（0.5.169 装机后 modelscope 面板）：中文分类 chip 被压成一列一字竖排。根因不是 chipRow 的
  flexWrap:'nowrap'，而是 S.chip 自己没有拒绝压缩——flex 子项默认 flex-shrink:1，中文词的 min-content 宽度
  只有一个字，于是一行放不下时逐字折行；lobehub 的英文 slug 整词不可断，把缺陷掩盖住了（0.5.168 复验没暴露）。
- 修法：S.chip 补 whiteSpace:'nowrap' + flexShrink:0，超出宽度交给 chipRow 横向滚动（chip 是短标签按钮，
  永远不许压缩折行）。
- 判据：test-lobehub-category-vocab 新增 3 条——样式体可从 client.js 整段取到、取到的是箭头函数本身
  （真跑一次调用才拿到对象，直接断言对象会假绿）、whiteSpace/flexShrink 双锁。变异自证 M-ws / M-fs 各红 1 条。
- 版本口径：0.5.169 的 npm tarball 已发布且不含本修复（同一版本不能重发），故本批走 0.5.170。
- 发布闭环：CI run 45549221279（publish.yml, tag v0.5.170）completed success（3m46s，Run tests ✓ + Publish ✓）；npm 侧传播延迟实测 9 轮 25s 轮询（约 4 分钟）后 npm view dsh-skill-mcp-market@0.5.170 = 0.5.170、dist-tags.latest=0.5.170；装机 dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.170 ⇒「- 0.5.169 / + 0.5.170，Done in 6.7s using pnpm v11.28.5」。
- 面板 live 复验（Before/After 同场景，port=54733，本会话面板 tab D3F31666CD1FAB15657688955E3A2334；0.5.168 那次的 tab 656A7D6ADB474ADA0E7DA43AD80A9987 已失效）：
  · Before=0.5.169 bundle：modelscope 21 chip 的 box 高度 82/46 两档、y 141/159 两档，截图 sha256:6570de59b83020fedcb039ce3295bb1b5ad6a2f45aaf5275e7633806b843bb02 肉眼实证「开发工具」竖排 4 行 1 字。
  · After=0.5.170 bundle：同一 clip{x:270,y:126,w:1000,h:60} scale2 ⇒ 21 个 chip 全在 y=141、height=28，中文词单行不断字（sha256:daaf38929be8501e41d7a3bb287eed427364877fbed434bce719610a1c3346c6）；顺序末位=「其他」⇒ m19018「其他放末尾」在装机后仍成立。
  · 空分类出路条实测：点「监控」chip ⇒ span「该分类在已取回的条目里没有命中…（近似，不等于该分类）：」+ button「近似搜索「监控」」；按下 ⇒ 面板「共约 1512 个 · 第 1 / 63 页」并出卡片（MITM 代理监控台 / 监控告警编写 / Grafana 监控面板…），sha256:dc136f921b484096e2aa9b3bf7624cf292bf15c96edffc4e0275869cb090976e。⇒ 不是死按钮。
  · 窗外入口实测：lobehub 收起态 chip 行=34 个 button（全部分类 + 32 类 + 窗外入口），窗外入口 box.x=4812 超 1280 视口 ⇒ chipRow 横向滚动生效；skillsmp 收起态同形（34 个 button，窗外入口 x=4309），横向滚动到行尾实拍 sha256:2c0d4e1931095bf7fcd2eac9884f3455607f773659a13437a8892e9537f210fd。⇒ 用户 m18991 的「其他只有文字不能点」两处都已是可点 button，且不再与上游真分类撞名。
  · 展开态限高实测：点窗外入口后 chip 容器 div box={x:270,y:141,w:970,h:116}（S.catsRow maxHeight 116 生效，246 类在内部纵向滚动），卡片区紧随其下未被挤走，sha256:8570df9dab6397b4a587a62a89befe6f4f636704ad9cec4f8516a8dbbbfff505；桶沉尾在展开态可见=「general 1」落最后一行（y=1257，收起入口同排）。⇒ m19004「还是搞这么多分类」的根因（展开即铺满屏）解除。
- 现网一键验收（0.5.170 装机后）：node test/live-verify.mjs ⇒ port=54733 fingerprint=new，rows=14 LIVE-FAIL=0 NOT-TESTED=0 GAP=2，RESULT: PASS exit=0。两条 GAP 不变（「监控」0 条=可达集合外覆盖缺口；__cat_other 服务端旧通路信息项）。

## 0.5.169
- 一句话：收掉用户三条报障（「其他」到底是干什么的、lobehub 展开后还是铺满屏、modelscope「其他」该放末尾且部分标签搜不出东西），并把面板里两个撞名的「其他」彻底分开。
- 窗外入口改名「窗外」（新增 CAT_TAIL_LABEL，foldChips 第三参下发）：以前面板自造的窗外披露叫「其他」，而上游词表里真有同名分类——lobehub 第 190 类 slug=general / label 其他（1 条）、modelscope 第 7 类 slug 其他、clawhub 第 14 类 slug=other。两个「其他」并排，用户按 m18991 的原话就是「我搞不懂操作逻辑」。文案现在是「窗外 214 类合计 743 条」，身份自证。
- 上游杂项桶（other / others / general / 其他）在 mergeCategoryVocab 里一律沉到词表尾（isGenericBucket + ranked/sunk 分流），展开态再按同一口径 splitBuckets 沉一次：m19018 的原话诉求「其他标签应该放在末尾」。桶判定只认 slug 或 label 全文等于这几个 token，「通用工具」这类含字串的真分类不受影响（判据点名）。
- 展开态不再铺满屏（m19004「lobehub 技能市场怎么还是搞这么多分类？」）：新增 S.catsRow（maxHeight 116 / overflowY auto / flexWrap wrap），渲染容器从 catsExpanded ? S.row 改为 S.catsRow。246 类仍可点，但只占固定 116px 高的内部滚动区，卡片区不再被挤成 3 行。
- 展开态不再重复挂窗外入口：窗外类已经逐个铺开，再挂「窗外 N 类」= 死控件（点了没任何反应）。allRealChips 改为 expandedChips（splitBuckets 的结果），窗外入口只存在于收起态行尾。
- 本地过滤空分类给出路（m19018 后半「部分类型标签的搜索结果为空」）：新增纯函数 nearbySearchNeedle(chip)（从分类名剥掉括号限定语与斜杠后缀），出路条只在本市场确实一条都没筛出来时出现——serverFacet 报 0、取数失败、加载中、已有条目四种情况一律不给（那三种给按钮是转移视线）。按下=用分类名做一次全文搜索，文案如实写「近似，不等于该分类」，下发 category 恒为 all。出口实测：modelscope「监控」可达集合内 0 条，query=监控 全文 1252 条，这条路真出货。
- 判据随动：test-lobehub-category-vocab Test 8 的 runFold 绑定补 CAT_TAIL_LABEL（漏绑即 CAT_TAIL_LABEL is not defined，11 条红），承接 / 文案 / label 三断言改判「窗外」，新增桶不进可点 chip、catsRow 限高锁、allRealChips=expandedChips 源码锁；模块作用域补可喂假名单的锁函数自证 runBucketLock 与 tailTextRe 自证（BUCKET_TOKENS 必须与面板同一套，写进 misc/通用 立刻红）。⇒ 105 passed / 0 failed（起点 89）。
- 新判据家 test-modelscope-category-vocab Test 13（21 条，全部真跑 client.js 源码、不复制实现）：桶沉尾 / 不误伤「通用工具」/ 其余 19 类顺序不变；nearbySearchNeedle 七例真跑；触发条件源码段整段取来跑六态（本地 0 条给出路，facet 报 0 / 取数失败 / 加载中 / 有条目 / 未选类 / 词表外值 一律不给）；出路条文案诚实性与按下参数。⇒ 181 passed / 0 failed / 2 skipped（起点 160）。
- 判据家自伤与加固（教训：判据代码也是代码）：(a) 桶断言与 genericBody 锁写在 Test 8 的 const client 声明之前 ⇒ ReferenceError，必须 relocate；(b) buttonKeys 断言插在声明之前 ⇒ Cannot access before initialization；(c) 一次 splice 残留重复的 .concat 行 ⇒ Unexpected token 点号；(d) bodyOf 取函数体的锚按 function 写法找，面板里是箭头函数 const 所以取空、锁等于没跑；(e) M_send 变异把 category 的 all 写成透传变量 ⇒ 按下时 ReferenceError 直接崩掉整个套件（红得没有汇总行），于是补 try/catch 与「按下不得抛错」断言，让同类缺陷报成逐条 FAIL。变异自证：M_sink 2 红、M_facet 1 红、M_honest 1 红、M_needle 1 红、M_send 3 红（补判据前是 0 红 1 崩）；lobehub 侧 M-label 3 红、M-catsRow 1 红、M-chips 1 红。
- test/live-verify.mjs 的窗外复算注释随面板文案改写（只改口径描述，算术不变；该脚本判据④不锁文案，无假绿风险）。
- targeted 复跑全绿：lobehub 105/0、modelscope 181/0/2skip、clawhub 62/0、skillsmp 61/0、trusttools 84/0、category-info 28/0、cleanup 14/0、suite-inventory 12/0、dead-exports 47/0、temp-hygiene 7/0、dead-all 6/0、live-verify 71/0、warm-budget 5/0、search-fanout-latency 207/0。
- 已知边界（不在本轮修）：modelscope 目录 89,044 条，可达集合只到 30,000（上游 offset 硬上限，实测第 31 页起恒 500），30,000 名之后的条目在分类视图看不到——出路条只解决「看得见、有路走」，不解决全覆盖；全覆盖要换通路（按分类逐个搜），属产品决策，留待办。skillsmp 的 education/design/arts-crafts/defi/web3-tools 上一轮记为「拒 facet」已翻案：那是 AGGREGATE_COOLDOWN_MS=120000 的冷却瞬态，重测 63 类全接受，本轮不开「隐藏假控件」项。
- 分支收口（0.5.169 落码后远端动了）：监测方把 PR #1（门提速/回放层，16 文件 +1569/-13，全是 test/ 与 README，不含 src/ 与 client.js）自行合进远端 ⇒ origin/master 从 37b5654 移到 a2e5375，我第一次 git push origin master 被拒（non-fast-forward），而 git push origin v0.5.169 已把 tag 推在**未合并的 1170aca** 上。处置=git rebase origin/master（零冲突，新 HEAD=b7be487，父 a2e5375）→ git tag -f v0.5.169 → push master（a2e5375..b7be487）+ push -f tag（d32474e...9a3ce60 forced）⇒ 远端 master 与 tag 同点，无悬空 tag。
- 发布链「重复版本」红≠内容红：tag 落在 1170aca 那次推送已触发 CI 成功发布（run 45545555350 success ⇒ npm 上 0.5.169 已存在，tarball dsh-skill-mcp-market-0.5.169.tgz，shasum 2edbfe9500c7a9a37a593e9df36d446195f97150，files 33）；rebase 后重推 tag 触发 run 45546297481 在 Publish 步骤报「npm error You cannot publish over the previously published versions: 0.5.169.」（Run tests 步骤 ✓）。判据=发布白名单是否变过：git diff --stat 1170aca..b7be487 -- client.js index.js src cordis.patch.yml icon.svg 输出为空 ⇒ 运行态逐字节相同，故不为这条红再升一位版本号；台账在此写明，避免下次误读成「0.5.169 没发出去」。
- 装机姿势纠错（一次踩坑一次成）：可执行文件 D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd；dsh plugin add <pkg> 直报「error: required option '--profile <name>' not specified」⇒ 必须 dsh plugin --profile desktop add dsh-skill-mcp-market@0.5.169。profiles 根 C:/Users/贺新/.dsh/profiles 下有 dekstop/desktop/open-design/web 四个目录，**dekstop 是另一个拼错的对象、不含本插件**，只有 desktop 的 package.json 里有 dsh-skill-mcp-market ⇒ 装机对象=desktop。结果「- dsh-skill-mcp-market 0.5.168 / + dsh-skill-mcp-market 0.5.169，Done in 6s using pnpm v11.28.5」，日志 C:/Users/Public/dsh-scratch/plugin169-add.txt。
- rebase 后针对性复跑（门提速层首次经我手）：test-gate-contract 53/0、test-suite-inventory 12/0、test-cleanup 14/0、test-dead-exports 47/0、test-temp-hygiene 7/0、test-dead-all 6/0、lobehub 105/0、modelscope 181/0/2skip、clawhub 62/0、skillsmp 61/0、trusttools 84/0、category-info 28/0 ⇒ 监测方的新判据与我的 0.5.169 改动互不踩。回放档案现状：C:/Users/Public/dsh-scratch/replay-full2 271 文件/11.2MB 健在，replay-p4 与仓库内 test/replay/store 均 absent（README:157/159 已规定档案须另存一份、以 replay-full2 为准）。

## 0.5.168
- 一句话：收掉用户两条报障（分类标签铺满半屏、「其他」只有文字不能点）与 modelscope「永远显示取数中断」，并把一键验收脚本的崩溃修掉。
- chip 行默认收成一行横向滚动：新增 S.chipRow（flexWrap:'nowrap' + overflowX:'auto'），不动 S.row（57 处在用）。展开态才回到多行铺开；状态存 localStorage（key dsh-skill-mcp-market.cats-expanded），默认收起。
- 「其他」恢复成真按钮，语义从「下发分类」改成「铺开窗外 214 类」：按下只 toggleCats(true)，零 setCategory、零 searchSkills；展开后每个窗外 chip 都是上游真 slug，点了真出结果；行尾「收起分类」按钮回到一行态。
- foldChips 把 tail 外露（原来算完 otherCount/otherTotal 就把 tail 丢掉 ⇒ 展开无料可用）；CATS_COLLAPSE 是渲染哨兵，永不进 category。
- 两道防线不许退（0.5.165 的假分类修复）：const upstreamCat = cat === CAT_OTHER ? 'all' : cat; 与 visibleSkills 不含 CAT_OTHER 分支。本轮翻转的是「能不能点」，不是「下发什么」。
- 判据家随动：test-lobehub-category-vocab Test 8 整段重写，收起态与展开态两套 chip 集合各真跑一次（runRenderFor 绑 15 量），旧「otherNode 必须是 span 且无 onClick」的期望被推翻并写明理由 ⇒ 100 passed / 0 failed（起点 89）。源码锁 4 条 + 死声明锁扩到 chipSlugs/chipBySlug/chipWindow 三件（本轮顺手删掉 0.5.165 改写后无人消费的 chipWindow）。
- 判据家自伤两次并被当场抓住（教训：判据代码也是代码）：(a) 用同一个 calls 计数器切「按下 other / 按下 collapse」且 splice 插错位置 ⇒ toggles:[] 红；(b) splice 换三行 check 时留下旧标题行 ⇒ SyntaxError missing ) after argument list，补 } 又漏一行 ⇒ Unexpected end of input。两次都靠 node 报错行号定位修好，最终 712 行 / CRLF / loneLF=0。
- modelscope 可达集合上界纠错（用户 08:09 截图：已有 73 页仍显示「第 31 页取数失败/超时」）：直连上游逐页实测 offset≥30,000 一律 HTTP 500 + Message=list_skill_failed——p30/n1000=200(6.9s)、p31/p32/p40/p45=500、p6/n5000=200 而 p7..p10=500、p15/n2000=200 而 p16=500、p150/n200=200 而 p151=500 ⇒ 上界是 offset 乘积 30,000 行，与页长无关，带 Query 同样；total 恒 89,044。
- 旧 MS_MAX_PAGES=45 让循环必然在第 31 页撞 500 ⇒ msFetchFailures 记账 ⇒ msPartial=true ⇒ 结果缓存永不写（:1556）⇒ 每次搜索都从第 31 页重试再失败，这就是「永远显示取数中断」的机制。修法=MS_MAX_PAGES 45→30（30×1000 恰实测上界），可达集合口径由 45,000 改为 30,000，注释与文案同批。
- modelscope 判据随动：FULL_ROWS 45000→30000、夹具槽位重排进 30,000 内并保持六类计数 40/25/6/2/2/1、hint 正则与「不得见 30,000」两处口径同改、源码锁 :375 改为严格 ===30000。实测 160 passed / 0 failed / 2 skipped；test-sort-server 45/0/3skip。三向变异：上界退回 45 ⇒ 3 红；留越界槽位 ⇒ 3 红；中断态文案漏改 ⇒ 1 红、正常态 ⇒ 6 红。
- 一键验收脚本的崩溃（监测方 08:14 报，我 07:48 那次改的是别处）：shape() 出来的 categoryNote/total/degraded 都可能是 undefined，端口连不上时 http=0，判据⑤那行 JSON.stringify(zz.categoryNote).slice(0,60) 直接 TypeError，一个 row 都出不来 ⇒ 绕过自己钉的退出码契约（3=NOT-RUN 本该在此出现）。修法=全字段兜底 + http=0 判「判据未执行」NOT-TESTED、http 真非 200 才 LIVE-FAIL。
- 这条坑原来测不出来（「绿不等于做了」的形状）：新增端到端判据真 spawn node test/live-verify.mjs --port 59999 --timeout 1500 ⇒ exit=3、stdout 无 TypeError、14 行全 NOT-TESTED、fingerprint=unknown；--json 同参 ⇒ exit=3 且单份可解析。⇒ test-live-verify 71 passed / 0 failed。
- 现网实跑（用户已点重启，端口自发现到 55303）：fingerprint=new ⇒ 服务端进程内已是新版；14 行里唯一 LIVE-FAIL=判据②「监控」0 条且文案自承取数中断，与本轮上界修正同根，装 0.5.168 后复验应转绿或转 GAP。
- 监测方 09:27①「可达集合不推进」的机制读实（不是游标坏）：0.5.165 的 MS_MAX_PAGES=45 下，fullKey 缓存写 {rows:30000, next:31, done:false}，下一次调用 cachedPages=30 ⇒ next=31 ⇒ pagesNeeded=45 ⇒ 31<=45 真打第 31 页 ⇒ 上游恒 500 ⇒ 记账 ⇒ msPartial ⇒ 结果缓存永不写。⇒ 续暖每次都真打了那一页，只是上游 offset≥30,000 一律 500（list_skill_failed），所以看起来「不推进」。上界改成 30 后 next=31>pagesNeeded=30 ⇒ 循环不进 ⇒ msDone=true ⇒ done 写进 fullKey ⇒ 不再请求、不再中断、结果缓存恢复写入。夹具 (c) 场景（failFrom:3）仍锁「第二次从失败页继续且不重拉 1-2 页」，续暖语义没被削弱。
- 监测方 09:27②「冷词聚合恒 12.0s」根因定位（本批不开项）：fanOutSources 的超时冷却是按 query 分键的——src/sources.js:677 cooldownKey = String(query).trim().toLowerCase()，:588 前缀 market_src_timeout:<query>:<source>，AGGREGATE_COOLDOWN_MS=120000。⇒ 全新词没有该源的冷却记录，必然付满 DEFAULT_BUDGET_MS=12000 等 trusttools（其单打实测 77.0s fetch failed）；同词 120s 内重打才会被跳过。真要降到 3–4s 需要「按源分键的失败记忆 / 连续 N 次超时降级为短预算并照报 degraded」，这会改变可见结果（哪些源被问），属产品决策，留 0.5.169 单独一轮。
- 现网一键验收（lv-guard 交付终态，端口自发现到 52830，进程内 0.5.165+）⇒ RESULT: LIVE-FAIL exit=1，12 PASS / 1 GAP / 1 LIVE-FAIL=判据② 软报「监控」total=0 且文案自承取数中断——这一条正是上界 45 的现场证据，装 0.5.168 并重启后应转绿；同轮指纹=fingerprint=new ⇒ 服务端半边已换代。
- 0.5.168 面板侧 live 复验（装 profile 后、宿主未重启，client bundle 已随 profile 换代）：lobehub chip 行收成一行横向滚动（收起态 DOM 读数=「全部分类」+32 类+「其他 · 窗外 214 类合计 743 条」，行带内 button 的 y 只有一组、x 超出视口靠 overflowX 取回）；「其他」已是真 button，按下铺开 248 个 chip（全部分类 + 246 类 + 行尾「收起分类」，零重复 slug），再按「收起分类」回到一行态；窗外类真可点——点 web3 1 后面板「共约 1 个 · 第 1 / 1 页」，RPC 同参直探 total=1 items=1 serverFacet=true（条目 ardi，wall=14430ms 冷取），证明 0.5.168 的展开不是假控件。截图凭据 sha256:3ecfc1ed…（收起态行首）/ 4604837a…（展开态铺开）/ 5272097b…（收起态行尾，「其他」为 button）。
- 服务端半边仍差一次宿主重启：装完 0.5.168 后现网一键验收 port=52830 fingerprint=new 但判据②「监控」依旧 LIVE-FAIL，RPC 直探文案=「分类取数中断（第 31 页取数失败/超时）：可达集合只到已取回的 30,000 行」⇒ 进程内插件 server 还是 0.5.165/166 的 MS_MAX_PAGES=45（45 页必然走到第 31 页撞上游 500）。面板 bundle 与插件 server 换代时机不同：前者随 profile 即时生效，后者必须用户点菜单『重启应用与 Host』。重启后重跑 node test/live-verify.mjs，「监控」应转绿或转 GAP。

## 0.5.167
- 一句话验收入口落进仓库（监测方 07:21 需求）：node test/live-verify.mjs 一条命令同时回答「服务端已换代 + 五项红转绿」。端口自发现（Get-NetTCPConnection，回退 netstat）、不写死 60027；退出码 0=PASS / 1=LIVE-FAIL / 3=NOT-RUN（没找到 RPC 端点，显式声明「不写 PASS/FAIL」）/ 4=STALE-SERVER（进程内仍是旧码，该结论先于一切行结论）。
- 版本指纹只认 hint 措辞（05:23 误判的根因固化成判据）：git show 逐字核对 ⇒ v0.5.164 写「分类在可达的」，v0.5.165 起正常态写「分类在已取回的」、中断态写「分类取数中断」；「可达集合外的分类会漏」两版都有 ⇒ 不是指纹。fingerprintOf 先判 NEW_MARKS（含"分类在已取回的""取数中断"）再判 OLD_MARKS（"分类在可达的"），判据家另加两条 git 源码互证（tag 历史缺失时显式 SKIP）。
- 六项判据（14 行读数）：①版本指纹 ②无 query 浏览态基线 + 2 硬类（市场推广/开发工具）+ 4 软类 ③分类过滤真生效（开发工具 vs 科研工具 total 不同，缓存命中也算真生效）④lobehub 246 类窗口/窗外自洽复算（win=32 333,426 / out=214 743 / sum=334,169，与面板文案逐位吻合）⑤冷词空结果不造数 + __cat_other 信息项 ⑥硬类浏览态墙钟 < 88s（0.5.164 的 90s abort 前沿）。
- 「监控」不可当硬判据（监测方踩过两次的坑，已落成口径）：词表里有 slug、同词浏览态 query=监控 total=1,512 有货，但 query=pdf + 监控 分类态 items=0 total=0 degraded=[] categoryNote=""——这不是谎报，是可达集合外覆盖缺口（45,000 行可达 vs 目录 88,993 条）。判据 B 只把已证有货的两类当硬判据，其余软报为 GAP；GAP 绝不判红，也绝不与「失败」混写：「没有匹配 / 覆盖缺口 / 失败 / 未测成」四态分开。
- 词表读取与出参字段形状锁：settings.get 的词表必须读 .categories（读 .rows 恒 0 ⇒ 会把「渲染正常」误判成「词表缺失」）；skills.search 的提示在出参 hints（数组）不是 hint（读 .hint 得 undefined ⇒ 误判「没接线」）。pickHint 按「源名＋全角冒号：」前缀取 modelscope 那条。五源 categories 条目形状各不相同（skillsmp totalAll / clawhub 无计数 / lobehub count+totalAll / trusttools tags / modelscope 仅 slug+label）⇒ 无法从 modelscope 词表预挑「有货」分类，硬判据只能是已实测的两类。
- 判据自身形状锁 + 六向变异：M1 NEW_MARKS 放宽成「可达」⇒ 3 红（正是 05:23 那次自伤的形状）；M2 hints→hint ⇒ 1；M3 summarize 把 GAP 计入硬判据 ⇒ 1；M4 vocabOf 读 rows ⇒ 1；M5 摘掉 STALE-SERVER 优先 ⇒ 1；M6 墙钟上限改 Infinity ⇒ 2；逐向还原后文件与原版逐字节一致。test-live-verify.mjs 55/0，已登记进 test:chain（68→69 段），version 0.5.166→0.5.167。
- 现网实跑（进程内仍 0.5.164，未重启）⇒ 判据真红且红因是真状态：RESULT: STALE-SERVER exit=4，LIVE-FAIL=1（版本指纹 old）、GAP=2（监控类 0 条、__cat_other 服务端残留旧入口），其余 11 行 PASS。⇒ 用户点『重启应用与 Host』后同一条命令应无 LIVE-FAIL 转绿。
- 一键命令自身的第一个缺陷（现网实跑 --json 才暴露，离线判据全绿时看不见）：--json 分支先打 JSON 再打 RESULT 行，消费者 JSON.parse 直接在 position 2637 炸。修法=asJson 分支自己打单份对象（result/port/fingerprint/byClass/rows）并在分支内退出，文本模式不变；判据家补 5 条锁（分支存在且在 RESULT 行之前退出、分支内自己 exit、打的是含 verdict 的单份对象、JSON 打印在 exit 之前、exit 不得恒退 0）。变式：M7 分支改打 RESULT + 恒退 0 ⇒ 1 红；M8 整段删除分支 ⇒ 3 红；M9 退出码收敛为 0 ⇒ 1 红。教训：「机器消费的输出」必须真跑一次消费者（JSON.parse）才算验收，只看人类可读的文本模式会把这类缺陷全部盖住。test-live-verify 55→61 passed
- __cat_other 的判读降级（口径更正）：0.5.165 修的是客户端下发（不再把合成入口发给上游，已 DOM 复验），服务端旧入口仍在 ⇒「上游不可达」那句谎文案对 __cat_other 仍会出现。live-verify 把它列为 GAP 信息项而非回归判据，并写明理由：面板路径已无该下发，服务端残留旧入口不构成回归。
- 门提速（PR #1）档案重录已兑现：监测方 07:21 整门真网络录制 69/69 total 1076s ⇒ 冷缓存回放串行 69/69 78s、parallel=4 墙钟 36s、未命中 0；档案 271 条/11.7MB 双份（scratch + test/replay/store-full2/，.gitignore store/ 改成 store*/）。全门 replay 凭据已贴 PR #1（issuecomment-7147220741）。口径固化：所有回放判据必须冷缓存跑（热缓存会假 miss，06:20 热轮 1 条/冷轮 0 条）；定向补录必须带 --import=…/test/replay/preload.mjs，只设 DSH_REPLAY=record 不注 preload 时请求真成功但一条不落档，看着像「补录无效」。

## 0.5.166
- 修「browse→search 形态切换不复位 sort」（0.5.164 就入库的 RED 判据 test/test-sort-form-switch.mjs 本批转绿 20/0）：用户在 clawhub 浏览态选了「热门」，再输入关键词，请求仍带着该形态不支持的 trending——UI 下拉里已经没有这个选项，请求却还在发，正是 0.5.101 起反复判死的「选了没反应」的排序变体
- 修法：client.js 新增纯函数 keepSortForForm(sortKey, entry, hasQuery)（:26-31，内部复用 capsFor，Test 3 单一口径成立），reqSort 兜底从裸 sort state 改走它；能力表经 liveRef 快照读（sortCaps 进 liveRef.current），searchSkills 的 useCallback deps 保持 [sort, liveRef, source, size] 不变——deps 里放 sortCaps 会让能力表一到就换函数，tab effect 把整页列表再搜一次
- 显式 options.sort 原样透传（切源 onClick 传入的新键不被兜底吃掉）；能力表未到达时非 default 一律回落 installCount，不猜键
- 判据：test-sort-form-switch.mjs 14→20 passed（Test 4 用 client.js 真实 searchSkills 体端到端跑：残留 trending+查询 ⇒ 实发 installCount 且缓存键同口径；浏览态 trending 仍原样下发；显式透传；无能力表回落），不只源码锁
- 变异四向逐向见红：M1 兜底退回裸 sort ⇒ 16/4（honesty 同红）；M2 过度复位（一律 default）⇒ 15/5；M3 不看能力表 ⇒ 14/6；M4 显式透传被吃 ⇒ 18/2；还原 sha=d90f74ce9a47b44c 逐字节 MATCH
- 随动：test-sort-ui-honesty.mjs :30 的 reqSort 整行锁承认 keepSortForForm 兜底（40/0）；test-search-fanout-latency.mjs 的 Test14/Test20 注入线上真实现（capsFor+keepSortForForm 同一作用域封箱，分开封箱会让 capsFor 引用落到 global——测的就不是线上那份），解构清单与两个 env 补绑 keepSortForForm（207/0）
- EXEMPT 撤销、test:chain 67→68 段（sort-form-switch 转绿进门）、version 0.5.165→0.5.166；keepSortForForm 只管「无显式 sort 的调用点」（回车/搜索按钮/分类 chip/改每页条数/安装后刷新），切源 keep 判定（0.5.164 已落）继续管「换源」
- 提交前全量门抓到一处既有判据自身的不合理：test/test-modelscope-category-vocab.mjs:316 写死 pkg.version === '0.5.165'，于是每升一次版本都必红一次门（本批首跑 66/68）。改成「不低于本批落地版本」的单调比较（160/0），版本锁的语义保住、门不再被版本推进本身绊倒。全仓 grep 确认这是唯一一处等号版本锁。
- 本批首跑门余下一红 test-profile-sync（profile=0.5.165 work=0.5.166）＝发布前预期中间态，0.5.163/0.5.164/0.5.165 同形先例，装完 profile 转绿。
- live 判据 B 口径改写（监测方 04:15 实测 + 我独立复核同形）：6 个冷 query × 开发工具 wall=0.9/1.2/1.6/1.6/2.1/3.8s，>12s 目击 0/6、degraded=[]、categoryNote=""；modelscope 分类态冷键（技能创建/监控/市场推广）12–36ms 回 18/0/24 条。0.5.164 那个形状（items=0 + 90.3s abort +「不提供分类信息」）在本机已复现不出 ⇒「正面目击 >12s 慢路径」从本批起不再是可执行判据，判据 B 改为 items>0 且 categoryNote 不含「不提供分类信息」且 degraded=[]。附带判读规矩（监测方踩到、我复核认可）：0 条必须同轮对照浏览态才许判 LIVE-FAIL——冷词「声纹识别 说话人日志」「三维重建 NeRF」分类态 0 条时浏览态同样 0 条（wall 0.9–3.1s、note=""），那是上游真没有，属诚实空结果。
- 进程版本指纹定案（推翻我 04:26 的「重启非验收前置」，也推翻监测方 04:15 的第①条）：live RPC 的 modelscope hint 文案是「分类在可达的 N 行」，该措辞只存在于 v0.5.164（git show v0.5.164/v0.5.165/v0.5.166 对比：0.5.165 起改为「分类在已取回的 N 行」）；skillhub 假分类态连打两次 categoryNote 仍是「所选来源不提供分类信息，已忽略分类筛选」（0.5.165 新增的 fetchFailedOnly 分支没出现），第二次 degraded=["fetch failed"] wall=10496ms。⇒ 60027 那个进程内跑的仍是 0.5.164 的服务端代码。监测方用「modelscope 分类态 6.6s 且没谎报」推热加载已生效是误读：那个形状在 0.5.164 命中缓存或上游快时照样出现，不是新版指纹。结论：0.5.165/0.5.166 的 live 验收仍需用户点菜单『重启应用与 Host』。
- 新登记残留（归 0.5.167，本批不动码）：src/sources.js:854-858 的 fetchFailedOnly 只在 catNeedle 非空的分支里生效 ⇒ 无分类态下 skillhub 取数失败（degraded=["SkillHub HTTP 400"]、items=0）时 categoryNote 仍写「所选来源不提供分类信息，已忽略分类筛选」。面板此刻消费的是 sourceErrors（已逐源点名「上游返回 HTTP 400」），所以用户可见文案不说谎；但 categoryNote 这个对外字段本身不准确，且 degraded 非空时「不提供分类」在语义上一律不该出现。判据位：test-category-info-declaration Test 7/8 需把同一条断言扩到无分类态。
- 无分类态取数失败的口径（登记后自证撤回，零缺陷）：先前记为「0.5.167 残留」的假设是 fetchFailedOnly 只在 catNeedle 非空分支生效、故无分类态失败时 categoryNote 可能仍写「不提供分类信息」。离线直调 src/sources.js（handlers 注入抛错，三形态）否证了它：无分类+失败 ⇒ categoryNote="" 而非那句谎（整段被 :858 的 catNeedle 条件跳过，空串就是「无话可说」不是撒谎），sourceErrors=["skillhub：上游返回 HTTP 400（该来源拒绝或找不到这次请求）"]、degraded=["skillhub|SkillHub HTTP 400"]、items=0；带分类+失败 ⇒ 「所选来源本次取数失败或超时，未能确认该分类下的条目（这不等于该来源没有分类信息）」；带分类+取数成功但行内无 category ⇒ 仍说「不提供分类信息」（Test 8 反向锁生效）。⇒ 三条都对，0.5.167 不为此开项。教训同前：读实赋值点位置不等于跑过分支，判据必须真调用。
- 上面这条同时给出 0.5.164 的 live 指纹对照表（重启后复验照此判）：v0.5.164 的 modelscope hint 写「分类在可达的 N 行」，0.5.165 起写「分类在已取回的 N 行」；v0.5.164 在「带分类+handler 抛错」时回「所选来源不提供分类信息，已忽略分类筛选」，新版回取数失败那句。两条任一命中旧文案 ⇒ 进程内还是旧码，不得据此判功能。
- 工作区卫生复发（同一根因第三次）：工作区根再现 D:/DeepSeek Harness WorkSpace/%SystemDrive%/ProgramData/Microsoft/Windows/Caches（9 条目 990,504B）＝嵌套 spawn 未显式传 env 时孙进程 %SystemDrive% 不展开，已删除。仓库内 .dsh-tmp 与 .local 均不存在，git status 干净；.local 那条锁按监测方 03:46 结论保持不松（不进 .gitignore）。
- 收口前卫生复查（同一根因第四次目击）：11-25 05:04 工作区根再现 %SystemDrive%/ProgramData/Microsoft/Windows/Caches（5 文件 990,504B，mtime 11-25 03:51＝gate166 复跑时段），已删；仓库 .dsh-tmp 与 .local 均 absent、git status 干净。同轮直连 RPC 复验进程指纹（留档 C:/Users/Public/dsh-scratch/probe166-prerefix-fingerprint.txt）：modelscope 市场推广 hint 仍是「分类在可达的 30,000 行」、lobehub 假分类态仍回「所选市场暂时没有取到数据…」⇒ 60027 进程内仍是 0.5.164 服务端；0.5.165/0.5.166 的 live 复验与截图仍待用户点菜单『重启应用与 Host』（AGENTS.md 硬规则，我不自行重启）。settings.get 的 categoryVocabulary 形状复核为 {capturedAt,source,categories}（lobehub=246、modelscope=20 在位），此前按 rows 读出的「0 行」是探针字段名错，不是词表缺失。
- live 面板复验凭据（两张截图，面板半边无需重启即已生效）：tab=lobehub 恰 32 个 chip，点名的分类全落在默认窗口内（devops-cloud 2、productivity-tasks 5、self-hosted-automation 11、finance 13、browser-automation 17、gaming 20、pdf-documents 21、speech-transcription 26、calendar-scheduling 28、smart-home-iot 29），「全部分类」首入口在位，窗外是一行 span 文本「其他 · 窗外 214 类合计 743 条」（不可点），「更多分类（共 246 个）」按钮已不存在；tab=modelscope 21 个 chip＝「全部分类」+ 20 个中文分类（市场推广 / 移动开发 / 文档处理 (PDF/PPTX/DOCX) / 监控 / 技能创建 / API 设计 / 通用工具…），其中上游真分类「其他」是可点 button、与窗外披露 span 并存不打架＝撞名防御在 live 得到印证，卡片列表非空。服务端半边仍是 0.5.164 指纹（modelscope hint 写「可达的 30,000 行」、__cat_other 态回旧文案）⇒ 分页提速与 fetchFailedOnly 文案两项待点击菜单『重启应用与 Host』后复验。凭据 C:/Users/Public/dsh-scratch/live166-panel-shots.txt 与 live166-panel-chips.txt。
- 监测方 05:04 就「进程内已是新版」改口并独立复现同一指纹（探针 D:/DeepSeek Harness WorkSpace/.tmp-inspect/mon-hintfp.mjs）：逐 tag grep「分类在可达的」只在 v0.5.164:src/extra-sources.js:1440，v0.5.165/v0.5.166/master 同位 :1496 已写「分类在已取回的」⇒ 60027 进程内服务端确为 0.5.164，0.5.165/0.5.166 的 live 验收仍需用户点菜单『重启应用与 Host』。双方各错一次再各自纠正的根因记两条：(a) 版本指纹只认 hint 措辞，「分类态 items>0 且 categoryNote 不含不提供分类信息」这个形状在 0.5.164 命中缓存或上游快时照样出现，不是指纹；(b) RPC 出参字段名是 hints（数组，src/sources.js:774 hints.push(name + '：' + result.hint) → :908 出参），不是 hint——读 .hint 得 undefined 会误判成「msCatHint 没接线」，实际接线在 src/extra-sources.js:1552 ...(msHint ? { hint: msHint } : {})。
- 档案损失登记（影响 0.5.167 的 PR #1 门提速验收，不改本批代码）：04:54 那笔台账记录的 scratch 清收把 replay-full / replay-p4 两份全门回放档案删了。监测方 worktree 内 test/replay/store/（427 文件 / 20.6MB）健在、DSH_REPLAY=1 实测 3 慢套件 3/3 green total 3s 未命中 0 条，但它自己的 rebase 已推到 origin（PR #1 OPEN/MERGEABLE，base=e5c0301，head 已更新；Linux dry_run dispatch run 45472670459 conclusion=success）。⇒ 0.5.167 合入前必须重新录制一次全门回放档案，不能当旧档案还在。

## 0.5.165
- 窗外分类合并成一个「其他」chip（用户 21:59 拍板：「更多分类里对应的技能只有几百个吧？你可以合并进一个“其他”标签中。」）：lobehub 词表 246 类，默认窗口只给前 32 类，剩下的 214 类合计 743 条=全部 334,640 条的 0.22%。0.5.164 的处理是给它们一个「更多分类（共 246 个）」展开态，实测那仍然是把 246 个标签摆给用户看，所以本批把展开态整体拆掉：client.js 新增 CAT_OTHER = '__cat_other' 与 foldChips(vocabChips, limit)，窗口 = 前 CAT_CHIP_FOLD(=32) 类 + 1 个「其他」，「其他」的 totalAll 是窗外各类上游真条数之和、covers 记窗外全部 slug，visibleSkills 的分类谓词加 CAT_OTHER 分支（category===CAT_OTHER 时按 covers 命中放行），点「其他」= 筛出这 743 条而不是再列一遍标签。grep 复核 categoryExpanded / __cat_fold / 更多分类 三处均 0 命中，展开态确已移除。
- 撞名防御是必须的：modelscope 静态词表本来就有一个真分类「其他」（ChineseName 其他、565 条）。所以 foldChips 第一步先滤掉上游行里 value===CAT_OTHER 的条目（合成入口不能被上游顶掉），且「其他」chip 的文案自带出身——渲染成「其他 · 窗外 214 类合计 743 条」，只写「其他 743 条」会被读成上游那个 565 条的类。
- 落码后自己踩到的第二个缺陷（判据抓到之前它已在文件里）：foldChips 让 chipWindow 的元素从 0.5.164 的 slug 字符串变成 chip 对象，而渲染块还是旧写法 chipWindow.map((cat) => …)，于是 cat==='all' 恒假（「全部分类」从面板消失）、chipBySlug[对象] 取不到（文案塌成 [object Object]）、onClick 把对象当分类下发（请求带一个假分类）。这套件当时 75 passed / 0 failed 全绿也没拦住——Test 8 只测窗口集合不测渲染 map，再次证明「绿不等于做了」。修法是渲染集合改用 chipEntries（首元素就是 {value:'all',label:'全部分类'}，不依赖 chipSlugs 那个中间量），onClick 下发 chip.value；顺带删掉 chipSlugs/chipBySlug 两个死声明。
- 判据跟着补到渲染层（test/test-lobehub-category-vocab.mjs Test 8 尾部 10 条，75→86 passed）：从 client.js 取 chipEntries.map((chip) => …) 整段，用 new Function 绑满 13 个自由量真跑渲染，断言首个 chip 的 key==='all' 且文案「全部分类」、chip 数===窗口 32+「其他」+all、任一文案不含 [object Object]、未选中时高亮只落一处（拿对象与字符串比较会全灰）、「其他」文案 /^其他/ 且 /窗外 \d+ 类合计 [\d,]+ 条/、窗内 chip 带上游真条数、按下时 setCategory 与下发的 category 都是 slug 字符串且 page===1。
- 变异四向全杀（逐向还原后 sha 回 client.js=a089d1b57631d2e2）：渲染集合退回 chipFold.window（丢 all）⇒ 77/9；文案不吃 categoryLabelLite（条数丢）⇒ 84/2；onClick 下发 chip 对象（本次缺陷原形）⇒ 82/4；恢复 chipSlugs 死声明 ⇒ 85/1。
- 聚合层第二处诚实性修复（监测方 live 亲验点名的那句谎）：modelscope 分类态实测 90.3s 超时、items=0，而 src/sources.js 的 categoryNote 说的是「所选来源不提供分类信息，已忽略分类筛选」——每行都带分类，取数失败被写成没有分类。修法=把两种情形分开：新增 fetchFailedOnly = degraded.length > 0 && items.length === 0，命中时文案「所选来源本次取数失败或超时，未能确认该分类下的条目（这不等于该来源没有分类信息）」，原「不提供分类信息」降为 else if (!catSupported)，取数成功但确实不给分类的源（browse.sh）仍说老实话。
- 该半段判据家 test/test-category-info-declaration.mjs（26 passed / 0 failed）：Test 7 用抛 'The operation was aborted due to timeout' 的 handler 复现 live 形态；Test 8 反向锁 browse.sh（取数成功+无声明+页内无分类）不得冒出「取数失败」；Test 9 源码锁 fetchFailedOnly 必须同时要求 degraded.length>0 与 items.length===0，且 if/else-if 两支都在。变异三向逐向见红并还原 sha=db2f4cab13fe6b8b：git checkout 撤修复 ⇒ 22/4（红字原文就是 live 那句谎）；极性写成 degraded.length===0 ⇒ 23/3；去掉 degraded 守卫只看 items ⇒ 25/1。
- 判据自身也错过一次并留档：new Function 跑面板谓词时 CAT_OTHER/chipFold 是新自由量，没绑就 ReferenceError（node --check 查不出，运行时才炸）；另有一条断言把「other=null 时不放行任何行」写反——该分支是窗外无分类时不误删有分类行的防御，other=null 表示没有「其他」chip，应放行。两处都在测试侧改，未动实现。
- 「其他」的第二次自伤（live RPC 实测，不是推测）：Fix A 把窗口外做成一个可点的 chip，按下即把面板自造 slug __cat_other 当 category 下发上游 ⇒ live 实测 source=lobehub category=__cat_other 回 n=0/total=0/serverFacet=true，面板再配一句「所选市场暂时没有取到数据，可能是上游不可达或响应超时」——把自造控件讲成网络故障。窗外那 214 类合计 743 条=全目录 0.22%，散在几百个分页里，上游一次只收一个 slug，面板没有通路把这批条目取回来。
- 修法：「其他」由 chip 降级为披露 span（client.js 渲染块，key=cat_tail_disclosure，不可点、无 onClick），文案仍自带出身「其他 · 窗外 214 类合计 743 条」；visibleSkills 谓词撤掉 CAT_OTHER 分支（面板过滤集合里不许存在自造分类）；searchSkills 加兜底映射 const upstreamCat = cat === CAT_OTHER ? 'all' : cat;，RPC 下发改读 upstreamCat，任何残留状态（旧缓存 key、旧 liveRef）都不可能把假 slug 发给上游。
- 这一条的判据是真判据不是源码锁（test-lobehub-category-vocab Test 8 渲染层 5 条 + test-category-info-declaration Test 6 7 条）：真跑渲染块断言「其他」节点 tag==='span' 且 props.onClick===undefined、可点 chip 的 key 集合全等于上游真 slug ∪ {all}（33 个）、按下只发生一次 setCategory/searchSkills 且下发的 category 是 slug；聚合层侧断言面板谓词不再引用 CAT_OTHER、CAT_OTHER 残留态下带分类行一律筛掉（不会把整个目录当「其他」）、无分类行仍按「无分类不过滤」放行。
- 变异四向逐向见红并逐字节还原（还原后 sha 回 client.js=6b7a94d051d75885）：visibleSkills 恢复 CAT_OTHER 分支 ⇒ category-info 27/1；「其他」改回可点 button ⇒ lobehub 84/5（红字 tag=button / key=__cat_other / n=34）；撤 upstreamCat 映射 ⇒ 27/1；RPC 下发退回吃原始 cat ⇒ 27/1。
- 判据家自身又被生产改动打到一次（留档教训）：test-search-fanout-latency Test 14 用 new Function 直接执行 searchSkills 函数体，注入的自由量清单里没有 CAT_OTHER ⇒ 新映射行让它 ReferenceError: CAT_OTHER is not defined（node --check 与套件源码锁都查不出，运行时才炸）。修法=两处解构清单加 CAT_OTHER、env 注入 '__cat_other'，复跑 207 passed / 0 failed。凡「执行生产函数体」的判据，绑定表必须跟着生产代码的新自由量走。
- modelscope 分页提速由子代理 ms164-vocab 落地（src/extra-sources.js:1401-1403）：MS_PAGE 5000→1000（实测 PageSize=5000 单页 66s 必被 abort、1000 行档 24.1s 能被 30s 兜住）、MS_MAX_PAGES 9→45（45×1000 与旧 9×5000 同一覆盖）、MS_PAGE_TIMEOUT_MS 90000→30000，配 msFetchFailures 逐页记账 + msDone/msPartial 游标续暖（第二次调用从失败页继续、绝不重拉已得页）；部分成功不再静默 break，失败页码进 hint；msPartial 时不写缓存（防把残缺集合暖成 6h 全量）。判据家 test-modelscope-category-vocab 现 160 passed / 0 failed / 2 skipped（含「中间页超时仍返回非空条目」「失败页码逐页点名」「续暖只增不减」「中断态不得声称覆盖全部行」；live 段仍门控默认 SKIP）。
- test-sort-server 的页长判据同步改为读生产常量：原来写死 '1/5000 2/5000 3/5000'，MS_PAGE 一改必红。改法=从 src/extra-sources.js 正则取 const MS_PAGE = (\d+); 再按同一算式重拼期望序列，并加一条「MS_PAGE 是可解析正数」的前置断言 ⇒ 45 passed / 0 failed / 3 skipped，页长再变也不用改判据（写死字面量的判据会把正确的重构判成回归）。
- 版本归属：0.5.165 =「窗外合并成『其他』」+「取数失败与不提供分类分开文案」+ 渲染层集合缺陷 + 「其他」降级为披露（假分类不再下发）+ modelscope 小页提速与逐页失败记账，五点都在用户 21:59/22:22 的报障线上，且共用同一块 client.js/src/sources.js/src/extra-sources.js 测试面，拆开会让门与判据分家。keepSortForForm（0.5.166 批）不在本批。

## 0.5.164
- 收 skills.sh 浏览态的假排序选项（与 modelscope 分类同批，用户可见）：浏览态（无查询词）下排序下拉给 skills.sh 提供「按安装量」，但目录行根本没有 installs 字段 —— src/sources.js 的 skillsShCard 把 installs 写死 0，sortSkillsShRows 的 installCount 分支于是拿全 0 比较，点了等于没点且静默不排。带查询词走 searchSkillsSh 才有真 installs（live 实测 q=pdf：pdf 236,138 / docx 224,636 / canvas-design 138,809 真降序；其余源 trusttools/browse.sh/lobehub 浏览态 installCount 都真变序 ⇒ 只有 skills.sh 这个洞）。
- 修法只动 UI 侧能力表：src/sort-capability.js 的 sortKeysFor 在 !options.hasQuery 且 source 为 skills.sh 时剔除 installCount。index.js 无需改（sortCapabilities 本来就按 browse/search 两套下发）；supportsSort 不动 —— src/sources.js 那个消费方不区分浏览/搜索路径，收紧它会把 browse 显式传 installCount 的调用直接清空，那是行为回归不是修复。
- 兜底诚实性说明：面板的本地兜底排序在浏览态同样拿全 0 比较，所以「回落默认顺序」与「按安装量」同序 —— 不排是诚实的，缺陷只在下拉不该给这个键。
- 判据：test/test-sort-ui-honesty.mjs Test 7 加 3 条（浏览态不含 installCount / 搜索态仍含 / 浏览态仍给 name）。RED 首跑真实红字：FAIL skills.sh browse 不含 installCount（目录行无 installs 字段）  [installCount,name] ⇒ 38 passed, 1 failed。test/test-search-fanout-latency.mjs Test 18 原来把四源放在一个「保留 installCount」循环里（调 sortKeysFor 不传 hasQuery），收紧后必然撞红 ⇒ 拆成浏览态三源 + 搜索态四源 + 一条 skills.sh 浏览态不给，防「收紧误伤搜索态」。
- 变异三向全杀（逐向跑两套件，还原后 sha 校验回 GREEN）：删收紧行 ⇒ ui-honesty 38/1 + fanout 206/1；极性反转成 options.hasQuery ⇒ ui 37/2 + fanout 205/2；去掉 !options.hasQuery 守卫 ⇒ ui 38/1（红的是「搜索态仍含」那条）。
- 死导出清理：删 src/sort-capability.js 的 vocabularySortKeys（生产零调用，唯一引用是 test/test-skillsmp-category-vocab.mjs 里 4 条 typeof 软锁 ⇒ 同步删除，该套件 65/0 → 61/0；全仓剩余引用只在 CHANGELOG 历史记录里）。诚实记录一条：test-dead-exports.mjs 的「零引用导出数=0」把测试引用也计入，所以这条锁清理前后都绿 —— 真正没兑现的是 CHANGELOG 里「已清理」的承诺本身，而不是判据；今后这类承诺要配一条真判据，否则「绿」不等于「做了」。
- 新缺陷（modelscope 分类态空页被谎报成「该源不提供分类信息」，lead 侧聚合层）：src/sources.js 的 catSupported 原写作 items.some((item) => item.category)，只看**这一页凑没凑到分类行**。modelscope 的服务端分类过滤实测不成立（Category/L1/CatalogID/Categories 四姿势 × lead 独立复跑，rows 与 baseline 逐位相同），过滤只能在可达集合内本地做，于是 文档处理 (PDF/PPTX/DOCX)/监控/API 设计/通用工具 这些 ≤6 条的小分类在深页上合法地回 0 条 —— 聚合层把这页空误判成「源没有分类」，回「所选来源不提供分类信息，已忽略分类筛选」，而同一次返回的 hint 又说「本类实测 0 条」，两句互相打脸，而每行其实都带 L1.ChineseName。
- 修法：分类能力改由 handler **声明**、聚合层**听声明**。src/extra-sources.js 的 searchModelScope 返回 categoryInfo: true（与本页取到几条无关）；src/sources.js 在 facet 计票同座新增 declaredCategoryInfo，逐源 result.categoryInfo === true 时置真，catSupported = items.some(...) || (items.length === 0 && declaredCategoryInfo)。两个条件都必要：声明只在零行时采信（有行仍看行，避免「声明说有能力、实际整页无分类」被放过），且不放宽多源聚合的既有口径。
- 判据家：test/test-category-info-declaration.mjs（5 组 8 条，零网络）。RED 首跑 5 passed, 3 failed：FAIL 不得谎称「不提供分类信息」（每行都带分类，本页恰好 0 条） [所选来源不提供分类信息，已忽略分类筛选]、FAIL 真 handler 分类态零命中不得说「不提供分类信息」 [{note:同上,items:0}]、FAIL catSupported 读的是声明，不只是页内样本 [const catSupported = items.some((item) => item.category);]。反向锁同时绿：browse.sh 整页无分类且无声明 ⇒ 仍照实说「不提供分类信息」；页内凑到分类行 ⇒ 仍走本地过滤并说明「仅当前页」。GREEN 8 passed, 0 failed；变异三向全杀（撤 catSupported 声明分支=3 红、撤逐源累加=3 红、极性反转 items.length>0=2 红），还原 sha256-16 回 990a39decc1b1e4e（改前 17367e5eacfd2d5c）。回归：fanout 207/0、latency-recovery 99/0、nocache 14/0、trusttools 84/0、lobehub 69/0、clawhub-category 62/0、skillsmp-category 61/0。
- 判据自身两处自伤（测试侧修正，非实现问题）：假 transport 原写成 {rows,total}，而生产 fetchOne 吃的是 Response 形状（ok/status/json），于是抛 ModelScope HTTP undefined、测的是「失败源」不是分类文案；源码锁原要求 categoryInfo 出现在 catSupported 同一行（把我的一种写法当判据），改锁「计票循环逐源累加声明 + catSupported 读该声明位」。

- 面板可见集合与聚合层同口径（lead 侧第二处诚实性修复）：src/sources.js 的本地过滤在分类态保留「无分类」行（!item.category || item.category === catNeedle）并另出一句「另有 N 项该源未标注分类，按「无分类不过滤」一并保留」，但 client.js 的 visibleSkills 原写作 orderedSkills.filter((item) => serverFacet || category === 'all' || item.category === category)，把无分类行直接删掉 ⇒ 面板渲染比聚合层承诺的少，filteredOut 与提示数字对不上。修法=面板补 !item.category 放行，与聚合层一致；判据在 test/test-category-info-declaration.mjs Test 6（真取该谓词体用 new Function 跑三例：无分类行放行 / 异类必须筛掉 / facet 态全放行，另加源码锁）。变异两向见红（撤 !item.category ⇒「面板保留无分类行」红；把放行写成恒真 ⇒「异类被筛掉」自证红），还原后 client.js sha 回 1212ac615305a17b。
- 该探针三次自伤记录（教训入档）：(1) 假 transport 给 {rows,total} 而非 Response 形状 ⇒ 抛 ModelScope HTTP undefined，测的是失败源；(2) new Function 直接把整段 (item)=>… 当函数体传入 ⇒ 拿到的是函数本身，谓词恒真＝假绿；(3) category 未绑定导致全部放行。定案=剥掉箭头形参只取 => 之后的谓词体，且必须先自证「异类必须被筛掉」再断言「无分类被放行」。终态读数：聚合 items=3 / filteredOut=0 / note=另有 2 项…保留，面板改前实际只渲染 1 条（b、c 两条无分类被吞）。
- 本批不做的事（用户 20:28「小步快速迭代，提高效率和质量」+ 监测方同向指令）：browse→search 形态翻转不复位 sort 这条已取证并写好判据家（test-sort-form-switch.mjs，正确 RED=3 passed / 3 failed：keepSortForForm 不存在、reqSort 仍直接吃残留 sort state、复位与下拉未同口径），它要同时改 client.js 请求下发处与切源复位，与 modelscope 分类是两条独立通路 ⇒ 落码挪 0.5.165。判据文件按监测方指令留在仓库并登记进 test-suite-inventory.mjs 的 EXEMPT 表（理由=未落码的永红判据不进门），不再放在可被清理的 scratch 目录。
- chip 口径取证（现网复核）：用户指出 lobehub.com/zh/skills 左侧只有 32 个分类，而面板词表给到 246 个。GET market.lobehub.com/api/v1/skills/categories 回 296 条（{category,count}），规范 slug 246 条、条数和 334,640 与站点「全部 334.6k」逐位吻合 ⇒ 词表是上游技能目录全量，不是编造也不是旧快照；而页面 category= 链接去重恰好 32 个，与按条数降序的前 32 名双向差集为空，断崖在第 32 名 moltbook=368 vs 第 33 名 technical=72，前 32 覆盖 99.64%（监测方独立复跑 99.78%，上游在动、结论同向）。另注 /zh/mcp?category=all 的 15 类是 MCP 目录另一套 taxonomy，与技能 tab 无关。
- chip 默认窗口 12→32（同一半步内落码，监测方点名「报障在可见层面等于没修」）：CAT_CHIP_FOLD=12 时默认窗口只覆盖 80.46%，用户点名的 8 类里 7 类（金融服务 13、浏览器 & 自动化 17、游戏娱乐 20、PDF & 文档 21、语音转写 26、日历日程 28、智能家居 & 物联网 29）落在折叠外；取 32 覆盖 99.78%，且 32 正是上游站点自己列出的可见分类数（上一条取证），rank>32 的 214 类合计仅 743 条=0.22%。slice(0, 60) 那个无词表兜底窗口未动（与本题无关）。
- 判据（真判据，不是源码锁）：test/test-lobehub-category-vocab.mjs Test 8 从 client.js 读出 CAT_CHIP_FOLD 实际值，对真 mergeCategoryVocab/categoryChipsForSource 产出的 246 chip 序列取同宽窗口，断言点名 8 类全在窗内 + chip 总数仍大于窗口（折叠入口未被删）+ 常量在 10..60 之间。NAMED_SLUGS 同步补入 speech-transcription（原 7 条）。
- 变异两向全杀：CAT_CHIP_FOLD 退回 12 ⇒ 70 passed, 1 failed（FAIL 点名分类全部落在默认窗口内  chip=246 fold=12 窗外点名=browser-automation,gaming,finance,pdf-documents,smart-home-iot,calendar-scheduling,speech-transcription）；提到 99（不折叠）⇒ 70 passed, 1 failed（FAIL 折叠常量存在且是两位数）。还原后 sha 校验回 f9b72190e5c93f08。
## 0.5.163
- CI 平台差异（run#45348082276 failure 的真因与处置）：本套件 22 条断言断的是 Windows 专有的生产分支（cmd.exe /d /s /c 拼串、quoteForCmd 引号姿势、windowsVerbatimArguments、.cmd shim 假 npx），而 publish.yml runs-on: ubuntu-latest 且 runner 上 npx 不在 PATH ⇒ CI 原文 spawn npx ENOENT；同一代码本地是 68 passed / 0 failed。处置=非 win32 显式 SKIP，判据 process.platform !== 'win32'（DSH_LH_WIN_ONLY=off 可在 Windows 上强制该分支自证）：四个夹具区域整体包进 if (IS_WIN) 使整段不执行，区域内每条断言逐个点名 SKIP，断言一条不删、也不改成 Linux 也能过（那等于拿掉本次修复的核心判据）。自证判据的口径写清楚：证的是**未 spawn**（PATH 从未被指向假 npx、夹具分支内实际执行断言=0、SHIM 内除 cli.cjs/npx.cmd 两个夹具自身文件外零 argv/stdout 落盘），不是「未创建夹具目录」——shimRoot 的探针文件与两个夹具脚本在任何平台都会写。两形态实测（完整末段见 C:/Users/Public/dsh-scratch/lh163-platform-proof.txt）：win32 69 passed / 0 failed（[FIXTURE] 夹具内实际执行=22）；DSH_LH_WIN_ONLY=off 46 passed / 0 failed / 23 skipped（[FIXTURE] 实际执行=0、shimPathApplied=0、Test 9 PASS、exit=0）。⇒ Linux runner 上该套件预期 46 passed / 0 failed / 23 SKIP（22 条 win-only 断言 + 1 条夹具可用性），SKIP 数 N=23。

- 收用户 2026-11-24 点名的 lobehub 两缺陷。①多词搜索整源失败：live 指纹 @lobehub/market-cli CLI failed: error: too many arguments for 'search'. Expected 0 arguments but got N。根因是 Windows 分支把参数拼成 cmd 命令行时，quoteForCmd 对内嵌引号写成反斜杠转义（\"），且 execFile 没开 windowsVerbatimArguments —— cmd.exe 下 --q 后面拿到的是 \"weather 与 forecast\" 两段，上游收到的是被拆碎的关键词。
- 修法：两份同构 quoteForCmd（src/cli-install.js:64 六个安装路径共用、src/lobehub-market.js:41 市场命令）内嵌引号改为 cmd 认的双写 ""，并在各自 execFile 选项加 windowsVerbatimArguments: true。姿势矩阵实测：只改引号不加 verbatim 仍拆参、只加 verbatim 不改引号也拆参，两者缺一即红 —— 所以判据同时锁两处源码行与一次真跑 argv。
- ②分类 chip 恒定不随分类变化：index.js 只下发 skillsmp/clawhub/trusttools 三家词表，client.js 的 ORIGIN 表里没有 lobehub，categoryChipsForSource 取不到词表就退回当前页派生；叠加 client.js:948-953 的 append 累积与派生行的 slice(0, 10)，首页凑满 10 个不同分类后 chip 集合永久锁死（监测方按面板算法逐页复现：lobehub 14 页真实 26 类，被挤出 16 类）。
- 修法：src/extra-sources.js 新增 LobeHub 词表三件套（parseLobeHubSkillCategories 吃顶层数组 / categories 对象数组 / categories 字符串数组三种上游形状，按上游条数降序）+ lobeHubSkillCategoryVocabulary（7 天 TTL、命中回同一引用、抓取失败或解析 0 条一律 null 且绝不落空快照）+ readLobeHubSkillCategoryVocabulary（只读缓存不等网络）；index.js settings.get 按既有形状装配第三家，冷的那份 void 后台补取，面板首屏不等外网；client.js ORIGIN 登记 lobehub；searchLobeHubSkills 收 category 真正推 --category，并回 serverFacet:true 与 totalPages，cacheKey 加 category 段防换分类串到上一个分类的缓存页。
- 解析口径教训（实测自纠）：slug 先 toLowerCase 再做 /^[a-z][a-z0-9-]*$/ 白名单校验等于放宽白名单 —— 上游 7 条首字母大写的自由标签（Analytics/Backend/DevOps/Observability/Organization/Planning/Security）会伪装成规范 slug 入表（解析出 256 而非 246），而 CLI 的 --category 并不认这些值，放行的结果是一个点了没用的入口。现口径：只 trim 不降大小写，形态校验打在原值上，实测 246 条。
- 派生 chip 上限 slice(0, 10) 提到 slice(0, 60)【判定理由】：60 是本仓既有的可见性口径（client.js resolvePageSize 的 Math.min(60, v)），10 会把用户本可点击的分类入口静默截掉；CAT_CHIP_FOLD=12 的折叠不动，展开态可见全部。词表在手时 chip 由词表给全（246 条，翻页与换词集合不变）；词表抓取失败退回当前页派生时，兜底态可见前 60 个分类入口（如实更正：本轮之前该兜底硬截 10 个，且 lobehub 根本没有词表通道）。
- 诚实性护栏：serverFacet 只在真的推过 --category 时声明（cat !== 空串），浏览态不许自称服务端已筛；上游没给条数的分类不拼条数（categoryLabelLite 仅在 totalAll>0 时显示）。聚合层无需改动，src/sources.js 的 facet 计票按 handler 回旗走。
- 判据：新套件 test/test-lobehub-category-vocab.mjs 68 条。RED 首跑 35 passed / 32 failed，真实红字含：词表=null、--category 不在 argv、result 无 serverFacet 与 totalPages、换分类 argv=null（串缓存）、生产 npxRun 经假 npx 落盘自证的拆参 argv、面板 chip n=2 且 first.fixed=false 走派生、ORIGIN 行未登记 lobehub、端到端 note=所选来源不提供分类信息，已忽略分类筛选。假 npx 夹具落在纯 ASCII 目录（含中文用户名的 Temp 在 cmd OEM 代码页下必报 文件名、目录名或卷标语法不正确，已按候选目录写探针择优，全不可用即记 SKIP 而不冒充通过）。
- 两类「判据变了」分开标注（避免被误读成改测试迁就实现）：套件 :312「带空格的值仍是一段」RED 期断言 argv 长度 4，实测假 npx 透传的是 npxRun 全参数（-y、包名、skills、search、--q、值 = 6 段）⇒ 这是判据自身写错，改成断言 --q 的下一段等于完整值；而 :164 的 256→246 是实现改了（先小写再校验等于放宽白名单）。前者改测试、后者改生产，性质不同。
- 自由标签不入表的代价已量化：被排除的 50 条合计只覆盖 471 条技能，占上游全部 334,638 条的 0.14%，最大一条 Backend:225。⇒ 不入表不是洁癖，是用 0.14% 的覆盖换「点了真有结果」的入口，比定性说不规范硬。
- 变异 12 向全杀：撤 verbatim=5 红、双写退回转义=两份各 1 红、cacheKey 去 category 段=1 红、serverFacet 无条件 true=1 红（浏览态那条）、不推 --category=2 红、丢弃 totalPages=1 红、parse 不排序=1 红、parse 先小写=1 红（got=256）、parse 截前 26=2 红（missing=smart-home-iot,calendar-scheduling）、ORIGIN 去 lobehub=6 红、派生上限回 10=1 红、index 不下发 lobehub 键=1 红。逐向还原后五个文件 sha256-16 回到 GREEN 值（cli-install 4f1e7a0bf678fc2f、lobehub-market 11bb5bd65ff3acbc、extra-sources 33e4e3f791766e95、index c31d43910d014dcb、client e9bdf3985c4cda11）。
- 版本归属声明：0.5.163 = lobehub 两缺陷（多词拆参 + 分类词表通道）同一轮 —— 二者同源于 lobehub 面板路径且共用同一测试面；modelscope 分类词表（上游无公开词表端点，需 L1 静态表加行内归一）与空深页 total 凭空造数那条另立 0.5.164，理由是取证与设计各自独立，混进一个判据家只会让两件事互相拖着。
- live 半段口径：宿主 61246 进程内仍是旧服务端（AGENTS.md 禁止自行重启宿主），本版面板展开态的 live 截图须待用户点菜单『重启应用与 Host』后复验；取到之前不宣称面板侧已生效。

## 0.5.162

- 收 MON 效率口径第 ② 条（用户 2026-11-24 原话：「技能市场的UI面板必须完整地呈现所有技能，在搜索时完整地呈现所有搜索结果」「不管快慢，都得等待面板加载完毕」）：面板与所有单源调用从此**没有任何超时预算**。此前 fanOnce 把调用方的 budgetMs 原样传给 fanOutSources，单源同样被 12s 截断——面板点 trusttools/skillhub 等慢源时「trusttools 不可达：来源响应超时（预算 12s），已跳过」（真机截图取证，m13096）。现在 fanOnce 判 picked.length>1：单源传 budgetMs 0（settle 的既有 `!(b>0)` 分支即无预算真等待，超时文案与冷却标记都无从触发）且不带预算覆盖表（fanOverrides=null，否则表里的值会绕过 0）；聚合路径逐字节不变。上游侧自有超时仍在：src/http.js getJson 20s、curlText 15s、pythonText 20s+5s、面板 RPC 上限 5 分钟（client.js:352 AbortSignal.timeout(300000)），因此「无预算」仍有界，只是界从 12s 挪到了每条上游通道自己的真实失败点。
- 完整呈现单独立判据（Test 10）：浏览态一页 24 条一条不少、上游 total 原样保留、搜索态匹配集给全、条目顺序即上游顺序；同一 handler 在 budgetMs=12000/300/覆盖表 50ms 三种口径下可见结果（slug 序列+total+页码+hasMore）逐字符相同——预算值从此不可能改变可见集合。四条覆盖判据顺带锁住单源无冷却（四次调用全部真打上游）。
- 冷却口径不变：AGGREGATE_COOLDOWN_MS=120000 仍只在 picked.length>1 的聚合路径生效（skill_market_search source=all），面板单源刷新每次真打上游。0.5.147/0.5.156 的 CHANGELOG 表述在此更正：冷却与预算截断的收益只属于聚合路径，面板单源路径从本版起永不受截断、也从不冷却。
- 合并键同步分流：budgetKey(picked, fanBudget, fanOverrides)——单源恒为 "0"，聚合为 String(12000)，两种口径的在途合并天然不串（source 段本就不同，双保险）。Test 5/8 的源码锁更新为新形状（aggregate/fanBudget/fanOverrides 三行 + 两条传参），合并键语义锁（空表逐字符等于旧 String(budgetMs)）不动。
- 判据：test-search-latency-recovery 真 import + 注入 handler 出 RED（Test 7 重写后首跑 81 passed, 5 failed——items=0、degraded「响应超时（预算 0s）」、ms1=309ms 截断、sourceErrors 谎称、第二次文案含「已跳过」），落码后 88/0；补 Test 10 完整呈现 11 条后 97/0；再补覆盖表忽略判据（M2 反向破坏直接暴露的缺口）后 **99/0**。变异五向全杀：M1 去掉 aggregate 判定（13 FAIL）、M2 单源仍带覆盖表（3 FAIL：覆盖判据 2 + 源码锁 1）、M3 冷却改无条件（1 FAIL 源码锁）、M4 合并键回退（1 FAIL 源码锁）、M5 传参简写回退（13 FAIL）；逐向还原 sha16 一致（base 17367e5eacfd2d5c）。
- 单源 budgetMs 全测试面回归：fanout 203/0、paging 30/0、clawhub-quality 86/0、skillsmp-category 65/0、skillsmp-search 73/0、trusttools-category 84/0、clawhub-category 62/0、index-runtime 26/0、dead-exports 47/0、inventory 12/0、sources 73s exit=0。
- gate161-s1 的 test-sort-honesty「TIMEOUT 1524s」读数归因【更正，撤回上一版的两条机制】：该轮该套件未取得有效结论，1524s 不是跑了 1524s，是整机睡眠被墙钟原样计入——run-gate.mjs:66-68 的 ms=Date.now()-t0 用墙钟。三条硬证据：①按 gate161-s1.log 文件时间（本地 08:23:23 起）加前序套件秒数累加 94s 推算，该套件窗口=08:24:57→08:50:21，正好 1524 秒；②同窗口系统电源事件 Get-WinEvent Kernel-Power：08:24:57 id=42「系统正在进入睡眠状态」、08:24:59 id=107、08:50:21 id=105、08:50:23 id=506/507、08:50:24 Power-Troubleshooter id=1「系统已从低功耗状态中恢复」（本轮实测复取，同一组读数）；③监测方独立取证本会话日志同窗口有 1554s 空档（08:24:28→08:50:22），冻结的不只是套件。
- 上一版写的两条机制均不成立，已撤回并实测否证：①「SIGKILL 在 Windows 上要等孙进程继承的 stdio 管道全关才 close」——复跑对照实验（C:/Users/Public/dsh-scratch/susp162/main.cjs：父进程 stdio:inherit 派生一个 120s 孙进程后挂住，3s 时 SIGKILL）带孙进程 close 仅比 exit 晚 0ms、无孙进程对照组同样 0ms，该延迟在本仓从未被观测到；②「browse 页 enrichSkillsShFast 是不受控等待、上游慢时最长可挂 ~80s/次」——src/sources.js:214 与 :297 两处都包在 withDeadline(…, DESCRIPTION_BUDGET_MS) 里，:86 写死 DESCRIPTION_BUDGET_MS=9000，await 侧最多 9s 就返回；实测（susp162/enrich2.mjs）单条不存在 slug 的直接 enrich wall=0ms，skills.sh browse 页 searchSkills wall=11388ms 且 24 条 description 全齐（noDesc=0），最后一行日志后约 150ms 进程即退出，没有「Promise.race 不取消底层 fetch ⇒ 残留 socket 拖住退出」的可观测证据，该假设不再写入结论。
- 该套件的有效结论：gate161-clean.log 的 PASS 18s（12 passed, 0 failed）+ 单跑 12/0；本轮 gate162-clean.log 同套件 PASS 10s 12/0、test-sort-ui-honesty 36/0、test-search-latency-recovery 99/0。待办（另立版本）：给 run-gate.mjs/gate-verdict.mjs 加 SUSPEND 疑似守卫——某套件 ms 明显大于 perTimeout 时单独标注，不让笔记本睡眠在门里伪装成 TIMEOUT；该改动必须与 test-gate-contract 的分支锁同批调整。
- live 半段口径更正（监测方 11:50 实测，我独立复核一致）：本版「面板等慢源加载完」的 live 亲验在宿主重启前**结构上无法取得**——64060 属主 PID 34864 起于 07:43:41，早于 profile 的 src/sources.js 落盘 11:09:06（package.json version=0.5.162、含 fanBudget），宿主进程内跑的仍是 0.5.161 服务端；0.5.161 的 fanOnce（`git show f486280~1:src/sources.js` 第 667-668 行）把 budgetMs/budgetOverrides 原样传给 fanOutSources，>12s 必被砍。据此撤回「88.9s 的 clawhub 深页调用只能是 0.5.162 服务端语义」这句推论：那次是 0.5.161 的一次性冷态，复跑 p120 为 93/30/27ms 全走负缓存，且 n=100 超面板上限 60（client.js:94-100 `Math.min(60, v)`），UI 根本到不了那一页。
- 因此本版的 live 证据只有两条且如实标注：同码离线 harness（Test 7 单源 700ms handler 真等、Test 10 三口径 shape 逐字符相同、probe B 13s handler 真等 13014ms items=2 degraded=[]）+ 可复现指纹；重启后一键复验探针留档 `C:/Users/Public/dsh-scratch/probe163-live-budget.mjs`，判据 A=任何单源调用都不得出现「来源响应超时（预算 Ns）」、判据 B=必须正面目击一条 wall>12000ms 且 degraded=[] 且 items>0 才算 PASS，全场 <12s 时脚本只输出 COVERAGE-GAP（未证伪，不得写成已验证）。11:59 干跑 16 形态实测 maxWall=4340ms、A 截断 0 次 ⇒ 当日 UI 可达的 >12s 形态无法稳定复现，本段维持「依赖下一次宿主重启」。

## 0.5.161

- 收 S1「空结果与取数失败不可区分」：查询词非空时任何源的失败都被「没有找到匹配的技能。」吞掉。根因在 src/sources.js 的 sourceErrors 判据 `items.length > 0 || String(query || "").trim()` —— 它只在**空查询**时才披露 degraded，而面板 client.js 在拿不到任何 reason 时兜底成「没有找到匹配的技能。」，用户看到的是一句谎话。现在只要 items 为空且有 degraded，就逐源点名披露（`源名：原因` 用「；」连接），查询词是否非空不再影响诚实性（三态判据：非空 query+degraded 点名 / 非空 query 无 degraded 仍说没找到 / 空 query+degraded 保持 0.5.160 行为不回归）。
- 失败形态分类取代一刀切截断：classifyFailure 对已知形态各出诚实文案——超时（原样转述该源预算秒数）、HTTP 状态码（「上游返回 HTTP N（该来源拒绝或找不到这次请求）」）、取数脚本异常（「该来源的取数脚本异常，未取到数据」，clawhub 的 python traceback 不再把多行原文喷进面板）、网络连接失败（「网络连接失败，该来源不可达（≤56 字原因）」）、响应形态不符；未知形态兜底 onelineFailure 折叠换行+单行 80 字截断。截断只是兜底，不是归类手段。
- 面板缓存命中路径同步诚实：searchSkills 的 400ms 缓存结果现在携带 sourceErrors，命中缓存时复述上一轮的失败原因，不再被无条件 setNotice("") 抹掉（client.js 缓存对象与命中分支两处）。
- 判据：test-search-latency-recovery Test 9 真 import searchSkills + 注入 handler 出 RED（首跑 72 passed, 9 failed；断言的是返回值三态与分类文案，不是源码文本），改后 83/0（+16 条，含行长度兜底与逐源点名）；test-search-fanout-latency 新增 Test 20 直接执行 client.js 的 searchSkills 函数体（+7 条：面板逐源披露、缓存进结果、缓存复述、无异常被 catch 吞掉）——反向用 HEAD 版 client.js 实测 201/2，两条 FAIL 正是缓存判据，证明判据真咬人。变异六向 M1–M6 全杀（src/sources.js：还原旧判据/超时文案改死/去 80 字兜底/取数脚本正则改死/describeFailure 用原始 error；M3 首跑存活属等价变异，补行长度判据后 82/1 抓住），逐向还原 sha 一致（base 18172bd2e360bf84）。
- test-suite-inventory 新增残渣判据（+1 条，12/0）：仓库根不得出现字面环境变量目录（%…%、$… 开头）或 GUID 式缓存树。根因取证：shell 子进程环境缺 SYSTEMDRIVE 时，Windows shell 把字面量 `%SystemDrive%` 当相对路径在 cwd 下重建整棵浏览缓存（5 个 .db、990504B），仓库里任何脚本都不含该字符串——此前两轮 grep 排查猜错的原因。RED/GREEN 实测：造目录 10/2、删除 12/0；且把该目录写进 .gitignore 使 git status 失明后新判据仍 11/1 抓住（磁盘扫描与 git-status 判据不等价）。仓库根与工作区根两份既有残渣已逐一取证删除。
- 门禁：本轮首跑 62/64 —— test-sort-honesty TIMEOUT 是并发窗口内上游网络抖动（单跑 6.8s 12/0 绿，附日志），test-profile-sync 报 profile:client.js/profile:src\sources.js stale 是发布前中间态（0.5.160 段已有同类先例记录，装本版后转绿）。发布后在干净 HEAD 重跑全量门并附原文。
- 效率项口径【用户 2026-11-24 定稿，本行由 0.5.162 更正】：技能市场 UI 面板不是聚合搜索——面板单源不限时、不截断、不冷却，必须等到完整加载；预算差异化与 120s 冷却只属于 skill_market_search 的 source=all 聚合路径。「改变可见条目数的那半仍待用户决策」这一说法自本口径起作废。本轮全部改动不改变任何成功路径的可见条目集合。
- 发布后干净 HEAD 全量门：工作树=HEAD b67f02a（profile 已装 0.5.161）重跑 → `gate161-clean.log`：**[GATE] 64/64 suites green**、total 395s，上一轮两红全部转绿——`test-sort-honesty.mjs PASS 18s 12 passed, 0 failed, 0 skipped`（并发抖动定性得证）、`test-profile-sync.mjs PASS 7 passed, 0 failed`（profile 装上即闭合）。
- 发布收口（六阶段 RESULT: PUBLISHED-VERIFIED，取证 chain161b.txt）：提交 b67f02a（7 files +208/-6）、tag v0.5.161（object 6e46c28，peel=提交）、推送 try=1 直连 PUSH-OK（push161.log，0a8afd3..b67f02a + [new tag]）；CI run#45301330409 publish success；npm dist-tags.latest=0.5.161、shasum ebfde367d61156970998c867ed9ff3b1e86c7c7c、tarball GET=200（214722B）——传播教训：HEAD 请求可 404 而 GET 200，判断就绪以 GET/包文档为准；profile 经 dsh plugin --profile desktop add 升到 0.5.161（profile161.txt，Done in 12.8s）；四方一致 parity161.txt＝HEAD = worktree = profile : 32/32、HEAD = npm tarball : 32/32。
- live 半段闭合（宿主重启后端口 64060，截图取证）：trusttools 面板 chip 实测 9 类（ai-automation/development/data/devops/security/productivity/docs/cloud/design），点分类不再白转——cat=security 实测 wall=4154ms items=24 total=9293 serverFacet=true、cat=zzz-bogus 退回全库 total=579074 serverFacet=false，0.5.159 的 pagination.total 自证在真面板后端生效。S1 服务端半段仍需再一次重启才生效：当前宿主进程内仍是 0.5.160 服务端，实测指纹——skillhub cat=zzz-bogus + q=pdf → items=0、degraded="SkillHub HTTP 400"、sourceErrors=[]（面板仍谎称「没有找到匹配的技能。」），同形 q="" 时 sourceErrors 非空；0.5.161 已装入 profile，下次重启即暴露修复。

## 0.5.160

- 收 0.5.159 的 CI 红灯：产品代码逐字节不动，只修一个被正常重构打断的**假红判据**（`test/test-func-fixes.mjs` Test 1）。
- CI 归因（GitHub check-run 138021192576 annotations 原文，公开可得；Actions 日志端点仍 403 admin-only）：`[GATE] publish blocked: 1/64 suites red → test-func-fixes.mjs(FAIL)`、`[GATE] test-func-fixes.mjs :: FAIL posts search: query  still q:`。npm 因此没有 0.5.159（`registry` 包文档 `dist-tags.latest=0.5.158`，版本列表无 0.5.159），profile 安装报 `[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for dsh-skill-mcp-market@0.5.159`。
- 根因是判据而非功能：Test 1 用 `src.slice(indexOf("export async function searchTrustTools"))` 再截到 `const batch`，在函数体内找 `search: query`。0.5.159 为满足「分类请求与参照请求除 tags 外逐字段相同」把单页请求抽进模块级 `fetchTrustToolsPage`（位于 searchTrustTools **之前**），POST body 于是离开了那段切片 ⇒ 判据命中空串，`{ search: query }` 明明在 :580。`searchSkills` 的 lobehub 分支此前也有一次同类假红（Test 3 的 SKIP 那一条走真网络，CI 上 skipped）。
- 修法：断言范围改为「从 `fetchTrustToolsPage` 与 `searchTrustTools` 中更靠前的那个起，到 `searchTrustTools` 内的 `const batch` 止」，两种代码形状（抽出的 helper / 内联 body）都覆盖。改后 `node --check` 通过、套件 9 passed, 0 failed（原 8 passed, 1 failed）；`test-trusttools-category-vocab` 84/0、`test-suite-inventory` 11/0、`test-dead-exports` 47/0 同轮复跑绿。
- 本地当时另有第 2 红 `test-profile-sync`（`✗ no stale copies  profile:src\extra-sources.js`、`mirrors report 0.5.159  (work=0.5.159 profile=0.5.158 D=null)`）：那是发布前中间态（profile 尚未装 0.5.159/0.5.160），不是回归；CI 上该套件因无镜像目录 skipped（我用空 `DSH_MARKET_PROFILE_DIR`/`DSH_MARKET_MIRROR_DIR` 复现：1 passed, 0 failed）。安装本版后应转绿。
- 版本号沿用「被 CI 拦下的号不复用」的既有口径（0.5.109/0.5.110 同形：0.5.109 至今不在 npm，修复随 0.5.110 发）。tag v0.5.159 保留为未发布标签，本版内容 = 0.5.159 全部改动 + 本次判据修正。
- 发布收口（六阶段 RESULT: PUBLISHED-VERIFIED，取证 `chain160.txt`）：CI run#45272506059 success（`Run tests (gates the publish)` 与 `Publish package (trusted publishing)` 逐步绿）；npm `dist-tags.latest=0.5.160`、shasum `86fb98e275c0a5ff58c3d8625450a4da154b654a`、tarball HEAD=200（传播窗口内 meta 先于 tarball 到位：轮询 try=7 见 latest、try=18 见 `tarball=200`）；profile 经 `dsh plugin add` 从 0.5.158 升到 0.5.160（`profile160.txt`，Done in 3.9s）；四方一致 `parity160.txt`＝`HEAD = worktree = profile : 32/32`、`HEAD = npm tarball : 32/32`。
- 发布后门（装本版之后复跑，工作树 CLEAN HEAD=6de3053）：`gate160-post.txt` → `[GATE] 64/64 suites green`、`total 374s`、`GATE-EXIT=0`。本版同时补齐 0.5.158/0.5.159 未曾各自取得的干净门验收（0.5.158 那轮被并发编辑污染，0.5.159 被上面的假红拦住）。关键计数：`test-func-fixes` 9 passed 0 failed、`test-trusttools-category-vocab` 84/0、`test-profile-sync` 7/0、`test-search-latency-recovery` 67/0、`test-index-runtime` 26/0、`test-suite-inventory` 11/0、`test-search-fanout-latency` 196/0。取证文档提交（HEAD=5447116）后另复跑一次：`gate160b-post.txt` → `[GATE] 64/64 suites green`、`total 374s`、`GATE-EXIT=0`，门禁不回退。 该条本身仍是 docs-only 行，因此对最终 HEAD a01bcc0 另跑一次完整门禁：`gate160c-post.txt` → `[GATE] 64/64 suites green`、`total 337s`、`GATE-EXIT=0`。
- 面板 live 半段仍未取得：宿主进程内仍是旧服务端（`AGENTS.md` 禁止自行重启宿主），需用户点菜单『重启应用与 Host』后复验 trusttools chip 9 类与「点分类不再白转」。服务端半段已由离线同码 harness 取证：真上游 `category=security` → `total=9293`、`serverFacet=true`、无 hint；不带分类 → `total=579074`、`serverFacet=false`。

## 0.5.159

- trusttools facet 自证口径从「行级命中」换成「pagination.total 对照」（src/extra-sources.js searchTrustTools），并修 GET 多 tag 线路编码。
- 根因：2026-11-24 实测上游列表端点返回的行内 tags 恒为 []。旧 facetAnswered 要求「每行 tags 命中所请求 tag」，在真上游永假 ⇒ serverFacet 恒 false ⇒ 面板显示「所选来源不提供分类信息，已忽略分类筛选」，chip 等于白点（0.5.157 遗留的证据缺口在 0.5.158 取证更正里已点名，本轮闭合）。
- 同时纠正一个会静默错筛的线路编码 bug：旧 GET 用 qs.append 逐个发 tags=a&tags=b&tags=c。实测重复同名参数上游只认最后一个（security&testing→3712=testing 单独的值），即对多 tag 分类只筛了最后一个 tag——这是错筛而不是忽略。逗号单键 tags=a,b 才是并集（security,testing=7270，两单值和 8084 确有重叠）。GET 现改 qs.set("tags", tags.join(","))。POST body 的 JSON 数组本就是真并集（search=pdf 下 docs,code-review=117 对单值 116/5），保持不变。
- 新自证口径：带 tags 的分类请求 pagination.total（facetTotal）与同一 query 不带 tags 的参照请求 pagination.total（refTotal）对照，facetTotal < refTotal 才算真过滤（实测 579,074 → security 4,372）。参照请求端点/页号/query 与分类请求逐字段相同，唯一区别是不带 tags，否则比较两次 total 就是拿两次不同查询比大小。
- 边界：facetTotal=0（该分类无匹配）或 refTotal 拿不到（0/缺失）都不许据「0 比 N」判为真过滤；行级命中保留为正向附加信号（上游哪天回填 tags 也算证明）。分类页 total 上报 facetTotal 而不是全量，面板据此算页数。
- hint 措辞换成可证真陈述：自证失败时说「带分类与不带分类的总数相同，且返回行里没有所请求的标签」，不再断言已被实测否证的行级理由。
- live 亲验（真上游 ai.trusttools.cn，单次 wall≈85s 含上游 10s+ TLS 间歇超时，重试即通）：category=security 单查 facetTotal=9293（=security,testing,debugging 三 tag 并集，与逗号编码语义吻合）serverFacet=true、无 hint；不带分类 facetTotal=579,074。修复前同一查询 serverFacet 恒 false。
- 判据 test/test-trusttools-category-vocab.mjs 73→84（新增 total 口径段：tags 恒空但 total 变小→serverFacet=true、必须真发过不带 tags 的参照请求、分类页 total 上报 facetTotal、total 相同/参照缺失→false 且如实退回本地、POST 通路同口径；Test 4 补 GET 单键逗号编码锁）。
- 变异 5 向全杀（还原后 src sha16=e3fa3b01f909e144）：M1 退回 qs.append 逐 tag → 83/1（GET 多 tag 逗号锁红）；M2 关掉 total 对照只留行级 → 81/3（tags 恒空段假陈述被抓）；M3 facetTotal!==refTotal 代替 < → 83/1（参照缺失段「0 比 4372」被凑成真，判据红）；M4 known 优先取 refTotal → 82/2（分类页 total 上报 579074）；M5 参照请求带上 tags → 78/6。
- 回归绿：index-runtime 26/0、search-fanout-latency 196/0、suite-inventory 11/0、clawhub-category 62/0、skillsmp-category 65/0；test-sources 真网络冒烟 exit=0。清理 0.5.159 驱动遗落的 test/test-trusttools-category-vocab.mjs.p159t 副本。
- 本轮属「不改变可见结果」以外的修正：它改变了 trusttools 分类请求实际发出的 tags 编码与 facetTotal 上报，属于修 bug，需要独立版本，不与 0.5.158 合并。

## 0.5.158

- 每源预算差异化中「不改变可见结果」的那一半落地（当时的口径：改变可见条目数的那半留待用户决策，不改变可见结果的那半自行 TDD 并单独发版。【0.5.162 更正】用户 2026-11-24 定稿：这套预算机制一律不得施加于面板——面板单源不限时、不截断，预算与冷却只属于聚合搜索路径）。src/sources.js 把写死的 12000ms 拆成 `DEFAULT_BUDGET_MS` + 空表 `SOURCE_BUDGET_OVERRIDES` + `budgetFor(name, budgetMs, overrides)` / `budgetKey(names, budgetMs, overrides)`，`fanOutSources` / `fanOnce` / `searchSkills` 新增 `budgetOverrides` 入参，settle 守卫的 setTimeout 与两条降级文案都按源取预算。默认可配置表是**空表** ⇒ 每个源拿到的预算与 `DEFAULT_BUDGET_MS` 逐毫秒相同，items/total/文案秒数一律不动；表里没写这个源、或写的值不是正数，一律等同没写。
- 「不改变可见结果」不是声明而是判据：真网络 A/B 快照（C:/Users/Public/dsh-scratch/snap-ab.mjs，q=pdf，BEFORE=snap158-BEFORE.log / AFTER=snap158-AFTER.log）逐源比对 items 数、total、首页 slug 序列、degraded，skills.sh / clawhub / skillsmp / browse.sh / lobehub / modelscope 六源全等。两处 DIFF 都与本次改动无关：trusttools 从「来源响应超时（预算 12s），已跳过 items=0」变成 items=24 total=6865（上游恰好恢复），skillhub 同 total=5659 而首页 slugs 换序（上游自身排序抖动）。⇒ 默认路径的零变化以注入判据为主、真网络 A/B 为旁证。
- 注入判据 test/test-search-latency-recovery.mjs Test 8（套件 274 行 / 22472B 纯 LF）：慢源配 5200ms 而调用方预算 1000ms 时该源必须真回来、且实测耗时贴着它自己的真实耗时（不被 1000ms 误砍）；另一源配 2000ms 而它跑 3000ms 时必须超时，degraded 文案写的是它自己的「预算 2s」而不是整批的 1s；表里的 0 / 字符串 / null 一律不生效；在途合并键在默认路径必须逐字符等于旧写法 `String(budgetMs)`（否则合并命中率白掉），表生效后不同表得不同键。RED 真值 54 passed, 11 failed，首条 FAIL 原文「给慢源单独放宽预算：该源条目回来（这才是这套机制的用意）  [a1,a2,b1,b2 slow|来源响应超时（预算 1s），已跳过]」（留档 C:/Users/Public/dsh-scratch/mut158/red158-run.txt）→ GREEN 67 passed, 0 failed（green158-run.txt）。
- 反向破坏 6 向全杀（基线 src/sources.js 归一化 sha16 a560f0db36d71d28，每轮从 sources.js.keep 逐字节还原并核 sha 回基线；驱动 mut158/mut158-budget.cjs，日志 mut158/budget-mut.log，各轮完整 stdout 存 N1–N6.txt）：N1 budgetFor 恒返调用方预算 → 61/6（慢源又被 1s 砍掉）；N2 两条文案退回 `Math.round(budgetMs / 1000)` → 64/3，首 FAIL「降级文案按各自的预算写秒数  [middling|来源响应超时（预算 1s），已跳过]」；N3 合并键去掉 budgetKey → 65/2「预算表不同 ⇒ 合并键不同  [{"a":1,"b":1}]」；N4 settle 里改用整批共用预算 → 63/4；N5 去掉「必须是正数」校验 → 66/1「表里的 0/字符串/null 一律不生效（等价于不传）」；N6 默认表写死 `{ trusttools: 20000 }` → 66/1「默认可配置表必须是空表」——「不改变可见结果」这条根基有独立判据守着，改一行就红。
- 驱动自伤两次，都不是判据问题但必须记：①拼 13 行块时引用了作用域外的 idx7 → `ReferenceError: idx7 is not defined`（抛错前已 copyFileSync 存快照，产品与测试文件未被写坏）；②往含换行转义的正则字面量里写内容时反斜杠被吃掉 → `SyntaxError: Invalid regular expression: missing /`，修完还残留一行孤儿文本。⇒ 固化规则：变异驱动改完必须 `node --check` 通过（打印 CHECK-OK）才算真的跑了，否则看到的 passed 计数是上一轮噪声；正则与转义一律用 String.fromCharCode 拼。
- 回归（reg158.ps1 → reg158.log，EXIT 全 0）：test-search-fanout-latency 196/0、test-full-sort 40/0/2skip、test-sources EXIT=0（该套件无 passed 汇总行，只打 per-source 计数并写 test-results.json，既有形态非回归）、test-index-runtime 26/0、test-paging-verdict 35/0、test-suite-inventory 11/0、test-manage-optimizations 38/0、test-clawhub-category-vocab 62/0、test-skillsmp-category-vocab 65/0、test-trusttools-category-vocab 73/0。
- 【已由用户 2026-11-24 定口径，本行按 0.5.162 更正；当时不填任何值】真把 trusttools/clawhub 这类慢源的预算调大调小会改变用户可见条目数——12 格扫描实测 q=agent 在 8000ms items=144 vs 12000ms items=192（收紧真丢 48 条），q=calendar 6000ms 与 12000ms 同为 items=149（收紧纯赚）。机制已就位（表里写一行即可）。用户定稿后面板单源没有任何预算，上述「收紧真丢 48 条」在面板路径已不可能发生；该表与差异化预算只对 skill_market_search 的聚合路径生效，填什么值仍属产品口径，当前保持空表。


## 0.5.157

- trusttools 的分类 chip 换成官方 9 类词表，行内分类字段不再取 tags[0]（用户任务「trusttools 的分类标签也完善一下」，与 0.5.155 修的 clawhub topics[0] 是同族泄漏）。上游取证（2026-11-23 站点 bundle 抽取 + 单 tag total 实测留档）：category 参数被上游忽略（8 个分类返回同一批），真过滤参数是 tags=，OR 语义；9 类映射 ai-automation=[ai,automation,ml]、development=[backend,frontend,api]、data=[data,analytics]、devops=[devops,cli,scripting]、security=[security,testing,debugging]、productivity=[productivity]、docs=[docs,code-review]、cloud=[cloud,performance]、design=[design,frontend]。
- 上游现状决定本轮证据形态：ai.trusttools.cn 自 2026-11-24 起 HTTPS 请求 7/7 全超时（DNS 解析正常、TCP 443 可连，node fetch 12/25s 超时、curl --http1.1 exit=28、POST /api/skills/search 20s 超时），因此词表以静态表随包发（capturedAt=2026-11-23），chip 不带条数（tag 级 total 是旧快照且不是 category 级），label 回落 slug（没有真显示名依据就不编一个）。
- 上游再探（2026-11-24 03:00 前后，本轮 13 次请求、四条通路，留档 C:/Users/Public/dsh-scratch/probe158*）：仍不可达，但失败位置已可定位到 TLS 握手，不再是「7/7 超时」一句话。①node fetch 直打 7 个 URL（站点根、/api/skills、?tags=security、?tags=security&tags=testing&tags=debugging、?tags=security,testing,debugging、/api/skills/categories、/api/v1/skills/categories、sort_by=install_count）全部 ERR TypeError: fetch failed，单次 ≈10.7s，TOTAL_MS=74917；展开 cause = UND_ERR_CONNECT_TIMEOUT「Connect Timeout Error (attempted addresses: 154.93.109.10:443, 154.93.109.18:443, timeout: 10000ms)」。②分层定位：DNS A 记录正常（154.93.109.10 / 154.93.109.18）、TCP 443 CONNECTED ms=737、TCP 80 CONNECTED ms=3579、TLS HANDSHAKE TIMEOUT ms=16552 ⇒ 端口通而握手续不上，既不是 DNS 也没被拦 SYN。③明文对照：http:// 两条通路均 301→https（nginx，1901ms/2440ms，body 162B）说明源站明文侧活着；https://trusttools.ai → ENOTFOUND getaddrinfo，证实历史那次失败 probe 是 host 写错（不是上游问题）。④出网对照：curl 8.23.0 经系统代理 127.0.0.1:7897 exit=7「Failed to connect to ai.trusttools.cn:443 over proxy 127.0.0.1 after 0 ms」，绕代理 curl --tlsv1.2 exit=28「Connection timed out after 25006 milliseconds」，Test-NetConnection 7897 proxyTcpTestSucceeded=False ⇒ 本机代理此刻根本没起，两条通路各自独立失败。⇒ 由此：tags= 多值编码的线路实测在本机仍不可能，本条记录的是「TCP 通 / TLS 握手不通 / 明文 301 正常 / 代理未起」四元组证据；上游恢复后要补的仍是那三件事（真抓取时间换掉 capturedAt、9 类映射核对、tags= 多 tag 编码实测）。 【取证更正，0.5.158 追加】上游已于 2026-11-24 03:20 后恢复：probe158e/f/h/i 共 4 轮真请求实测，多 tag 线路编码缺口已闭合（GET 实发 tags=security&tags=testing&tags=debugging 同名重复，POST 实发 body tags:["security","testing","debugging"] JSON 数组，与 URLSearchParams 假设一致）。同一批实测否证了本段那条 serverFacet 由返回数据自证的机制：列表端点（GET 与 POST 皆然）每一行的 tags 恒为空数组（probe158i 三行样本 tagsEcho=[[],[],[]]），所以「本页每一行都命中所请求 tag」永不为真 ⇒ serverFacet 恒 false，把上游已筛好的整页交给聚合层本地兜底过滤，而本地过滤又因 trusttoolsCategoryOfTags([]) 回空串使 catSupported=false → 面板显示「所选来源不提供分类信息，已忽略分类筛选」＝chip 白点。上游其实真在过滤（total 随 tags 变：无 tags 579074 / security 4372 / security+testing+debugging 3494 / 不存在的 tag 0），只是不在行内回显 tags，所以自证必须换成 pagination.total 口径——见 0.5.159。
- 关键设计：多 tag 的线路编码没有实测记录（历史留档里只有一句我自己写的疑问和一次把 host 写成 trusttools.ai 的失败 probe），所以 serverFacet 不由编码假设声明，而由取回数据自证——本页每一行的 tags 至少命中一个所请求 tag 才算上游真过滤；上游忽略参数或编码猜错都得到 facetAnswered=false，聚合层（src/sources.js:775-799）自动退回「仅当前页本地过滤」并如实说明。两种上游行为都不会把未过滤集合谎报成「这就是该分类」。表外分类（douyin / json / research 这类）一个 tag 都不发，并写清是词表不认识这个分类，不是该分类下没有匹配。
- 三处接线：src/extra-sources.js 新增 trusttoolsCategoryVocabulary / trusttoolsTagsForCategory / trusttoolsCategoryOfTags，searchTrustTools 吃 category 并带 getJson/postJson 注入点（形状照 searchClawHub），缓存键加 facet 维度（换分类不复用上一分类的页），POST body 带 tags 数组且仍带 search；index.js settings.get 分组新增 trusttools 键，同步取不经缓存不经网络、不进 Promise.all，:32 同处补 import（0.5.148 缺 import 崩溃就是这一条锚）；client.js 的 ORIGIN 加 trusttools 前缀，与服务端 source 逐字符一致——不一致 categoryChipsForSource 会整排丢弃退回纯派生 chip，等于词表白下发。
- 判据：新增 test/test-trusttools-category-vocab.mjs（9 Test / 63 判据 / 零网络）。上游不可达期伪造一份「真抓取夹具」就是拿假数据当真凭据，所以断言全部走注入通路而不是抓包回放。HEAD 回退态 RED = 4 passed, 25 failed，首条 FAIL 原文「词表可取（trusttoolsCategoryVocabulary 必须是真导出）  trusttoolsCategoryVocabulary 未导出」；修复态 GREEN = 63 passed, 0 failed。回归不红：test-index-runtime 24/0、test-search-latency-recovery 48/0、test-clawhub-category-vocab 62/0、test-skillsmp-category-vocab 65/0、test-suite-inventory 11/0、test-manage-optimizations 38/0、test-manage-states 36/0、test-tool-deny 46/0、test-search-fanout-latency 196/0、test-sources EXIT=0。
- 反向破坏 6 向全杀（基线 extra-sources e1468c32b65a7902 / index 3ed6cab84949dd74 / client 58273a32a8999711，每轮逐字节还原并核 sha 回基线）：V1 缓存键去掉 facet 维度 → 59/3，首 FAIL「换分类拿到的是新分类的页，不是上一分类的缓存副本  security calls=1」；V2 facetAnswered 由 facetUsed 直接为真 → 62/1，「空页不声明 serverFacet（空页什么也不证明）  true」；V3 行内分类退回 tags[0] → 60/2，「行内 category 已是规范 slug（不是 tags[0]）  security,testing,debugging」；V4 空页也发「已退回本地筛选」→ 62/1，详情就是那句假陈述原文；V5 index 热路径把 trusttools 词表挂到 skillsmp 键 → 62/1；V6 面板 ORIGIN 去掉 trusttools → 62/2，「面板 ORIGIN 含 trusttools（不加就永远走纯派生 chip，词表白下发）」。
- 判据机制缺陷一处（V5 第一版存活＝真盲区，不是实现问题）：Test 9 只锁了冷缓存兜底赋值 categoryVocabulary = { trusttools: ttVocab }，热路径那句 categoryVocabulary.trusttools = ttVocab 的键名没有任何判据吃它——把 trusttools 改成 skillsmp 照样 62/0，而那一改会让两份词表都热时 trusttools 键根本不下发、还覆盖掉 skillsmp 那份。补「两份词表都热时 trusttools 键仍按自己的名字挂上」精确键锁后才红。同轮另修三处「红得无效」：缺导出被写成 skip（「功能不存在」看起来像「本轮没测」）、桩函数缺导出把整套件崩成 NO-SUMMARY、注入点不存在时会真打不可达上游（加 4000ms 看门狗，FAIL 原文即「4000ms 内未返回：注入点不存在或该调用没走注入通路」）。
- 未经 live 验证（如实标注）：本轮 trusttools 全段属服务端半段，需宿主重启才生效，且上游不可达使线上复验不可能；面板半段（ORIGIN 与 chip 归属）在 0.5.157 装好并重启后需复验「chip 显示 9 类官方名称、不再有 tags[0] 派生的怪标签、点上去不再白转」。上游恢复后还需把静态表的 capturedAt 换成真抓取时间并核对 9 类映射是否仍与站点一致。
- 门禁：64 套件（test:chain 末项 = test/test-trusttools-category-vocab.mjs）。
- 效率项的取证与决定（本轮记录，不动代码）：12 格预算扫描（独立进程真冷，2026-11-23 留档）实测各源真冷耗时 skills.sh 5514ms / clawhub 2769ms / skillsmp 4731ms / browse.sh 2112ms(total=35) / lobehub 9333ms(total=500) / modelscope 2206ms / skillhub 10641ms(items=0，degraded=[skillhub:fetch failed]) / trusttools 60s 超时。同扫描下 q=calendar 预算 6000ms 与 12000ms 同为 items=149（收紧纯赚），而 q=agent 8000ms items=144 vs 12000ms items=192（真丢 48 条）。⇒ 按冷耗时给每源单独定预算确实有收益，但它会改变用户可见结果（快但可能少条目），且面板 12s 上限是「等一下能出满页」的现状；0.5.156 已拆掉面板侧冷却（面板单源不再被拉黑），所以这条**不在本轮改**：留待宿主重启后带着 live 体感再定口径。曾试图就此向用户提问，ask_user_question 超时（用户冬眠，无交互），故按「不动用户可见行为」的保守侧记录并搁置。
- 发布收口（六阶段 RESULT: PUBLISHED-VERIFIED）：CI run#45225979789 success（Publish = trusted publishing success，head_sha=1916e26）；npm dist-tags.latest=0.5.157 shasum=bccbfaf36869e19fd98ecc1d492be33cfb58e661，tarball HEAD=200；profile 经 tools.pwsh 跑 dsh.cmd plugin --profile desktop add 装 0.5.157（输出「- dsh-skill-mcp-market 0.5.156 / + dsh-skill-mcp-market 0.5.157」，Done in 7.7s，pnpm 11.28.5，resolved 535）；parity `HEAD = worktree = profile : 32/32` 与 `HEAD = npm tarball : 32/32`；装后门 **[GATE] 64/64 suites green**（total 460s，test-trusttools-category-vocab 72/0、test-search-fanout-latency 196/0、test-search-latency-recovery 48/0、test-index-runtime 24/0、test-clawhub-category-vocab 62/0、test-skillsmp-category-vocab 65/0、test-suite-inventory 11/0，test-profile-sync 的 stale/mirrors 两条按预期自愈）。
- 发布前那条「交付 js 无混合行尾」红（client.js CRLF=3410 loneLF=2）是我把两行注释以 LF 写进 CRLF 文件造成的，不是产品缺陷：补成整文件 CRLF 后 196/0，且 `git diff HEAD -- client.js` 为空（core.autocrlf 归一后与 blob 全等）。中途一度以为「已发布的 tarball 与工作树字节不一致」而写了 ## 0.5.158 段并 bump 版本，实测否掉——tarball 里 client.js 181117B / loneLF=3412 / CRLF=0 与 git blob 逐字节一致，0.5.158 属虚增，已 git checkout HEAD 撤回（教训：readFileSync utf8 的 .length 是 UTF-16 码元数，字节比对必须用 statSync/Buffer；同文件 184529 vs 210418）。
- 判据加固（只动 test/，产品代码未改，所以不再 bump 版本）：test-trusttools-category-vocab 新增 Test 10 十条真行为判据（跑 client.js 真实函数体 categoryChipsForSource + mergeCategoryVocab，同 skillsmp 套件口径——anchor-lib 的 blockEnd 会被签名里的默认值对象提前归零）与「两份词表都热时本市场仍只用 trusttools 自己的词表」一条 → 73/0；test-index-runtime 新增 settings.get 真执行判据「词表分组含 trusttools 静态表（冷缓存也在，不经网络）」，并把 clawhub 词表一起播种（注入名是 getJson，写成 fetchJson 会静默走真网络）→ 26/0。补因：Test 9 只有文本接线锁，没有一条真执行 chip，与 0.5.151「只核规范类出现、没核派生值消失」是同族漏验。 加固后在 HEAD 复跑整门：**[GATE] 64/64 suites green**（total 401s，test-trusttools-category-vocab 73/0、test-index-runtime 26/0、test-profile-sync 7/0、test-suite-inventory 11/0、test-search-latency-recovery 48/0），push try=1 exit=0 `b95690f..7074f28 master -> master`，ls-remote master=7074f28afea24e5672f742d57518937640cea392、tag v0.5.157 不变（产品文件在 tag..HEAD 之间零差异，实测 git diff --name-only 为空）。
- 加固后的变异证据（每轮从 .keep 逐字节还原并核 sha 回基线 client c8172aa861c8da08 / index 601f51b72b4c1040）：client.js 分组取键 `vocab = bySource[key]` 改成取 skillsmp → trusttools 套件 70/3，首条 FAIL 原文「词表在手时 trusttools 那一排全是规范 9 类（派生自由标签一个都不留）  ["douyin","抖音","json","ai-tools"]」＝用户点名的自由标签回来了；归属核验整行改注释 → 72/1「词表来源前缀不是 trusttools 时整排丢弃退派生（串味防护真生效，不只是写了分支）」；index.js 去掉 trusttools 的 import 符号（0.5.148 崩溃形态）→ test-index-runtime 17/8，首条 FAIL 原文「settings.get 返回 ok:true  [trusttoolsCategoryVocabulary is not defined]」；热路径 `if (categoryVocabulary) categoryVocabulary.trusttools = ttVocab;` 改成 void → index-runtime 24/1「词表分组含 trusttools 静态表（冷缓存也在，不经网络）  [实际="(无 trusttools 键)"]」且 trusttools 套件 72/1。第三向 I3（把冷路径那条 else 换成 `else if (categoryVocabulary) …`，即两份词表全冷时不下发 trusttools）实测：index-runtime 26/0 全绿、trusttools 套件 72/1「另两份词表都冷缓存时 trusttools 仍要下发（不能只在有词表时才补键）」——冷分支在真执行里要复现需要第二次 settings.get，而那会触发后台真网络补取、把不确定性引进门禁，所以这条保持文本判据并如实记在此。
- live 现状（如实标注）：面板半段热更新即生效，但 trusttools 的词表来自服务端 settings.get；宿主 01:07 起的进程内仍是 0.5.156，实测 `settings.get` 顶层 `categoryVocabulary` 只有 skillsmp/clawhub 两键、无 trusttools ⇒ **本段服务端半段未经 live 验证**，判据证据全部来自离线真执行（test-index-runtime 真 import index.js 跑完整 RPC）。用户冬眠不动宿主；醒来后点菜单『重启应用与 Host』即可复验 trusttools chip 换成 9 类官方标签。

## 0.5.156

- 冷却机制的归属修正：面板的单源搜索彻底不再冷却，短冷却只保留在 agent 聚合路径（用户两次连发定性指令「在UI界面上没有『全部来源』面板，总搜索路径慢不影响技能市场面板」「all 聚合似乎只存在于 skill_market_search 工具中，你不能让 all 参数影响到 UI 面板的功能。UI 面板只有各个独立的市场，不存在聚合市场」）。根因：0.5.147 把聚合层的超时冷却做进了 fanOutSources 的公共签名，而面板每个 tab 走的同一条 fanOutSources（fanOnce 传入 picked.length===1）也跟着生效——面板用户点一次 trusttools 超时的词，之后 120s 内再点同一词就只拿到空面板，这是把「聚合一次要等八个源」的策略加到了「只有一个源」的 UI 上，收益与代价都不成立。
- 具体改动（src/sources.js 三处）：①新增模块级具名常量 `const AGGREGATE_COOLDOWN_MS = 120000;`；②`fanOutSources` 的 `cooldownMs` 默认值从 120000 改为 **0**，即该函数默认不冷却任何源，冷却成为调用方显式选择的策略；③`fanOnce` 调用 `fanOutSources` 时传 `cooldownMs: picked.length > 1 ? AGGREGATE_COOLDOWN_MS : 0`，聚合路径行为保持不变。函数文档注释同步说明这条归属边界。
- live 证据：面板形态真 RPC 对随机新词 source=trusttools 连打三次（宿主端口 62898），修复前 `BEFORE-1 wall=12040ms degraded=[{trusttools:来源响应超时（预算 12s），已跳过}]` / `BEFORE-2 wall=3ms degraded=[{…已跳过（冷却中，本轮不再重试）}]` / `BEFORE-3 wall=4ms` 同样带冷却文案。本段是 0.5.156 修改之前的 live 留档，After 与截图在同轮复验记录里。
- 判据 test/test-search-latency-recovery.mjs：Test 5 源码锁新增三条（`cooldownMs = 0` 默认、`const AGGREGATE_COOLDOWN_MS = 120000;`、`cooldownMs: picked.length > 1 ? … : 0`）；新增 Test 7「面板单源永不冷却」——单源 handler 两次必须 calls=2、四次必须 calls=4、文案不得出现冷却/不再重试/稍后，同 handler 集合走 `source:"all"` 聚合时第二次仍只打一次上游（对照组，证明聚合侧冷却未被误删），以及直调 `fanOutSources` 不传 cooldownMs 两次=2、显式传 120000 两次=1。Test 3 窗口测试原 handlers 只有单个 dead 源，冷却归属改变后需要两个 handler 才落在聚合分支，因此补一个健康 handler 并注明原因（不是判据放宽）。RED 真值 37 passed, 11 failed（首条 `面板单源第二次：仍真重试（calls.slow=2，没有被冷却短路）  [calls.slow=1]`，另 FAIL 原文文案 `slow|来源响应超时（预算 0s），已跳过（冷却中，本轮不再重试）`）→ GREEN 48 passed, 0 failed。回归 test-search-fanout-latency 196/0、test-index-runtime 24/0、test-temp-hygiene 7/0。
- 反向破坏 6 向全杀（src/sources.js 基线 shaNorm16 2208474092c1e610，每轮逐字节还原）：M1 默认值退回 120000 → 45/3；M2 fanOnce 无条件传 AGGREGATE_COOLDOWN_MS（面板也被冷却）→ 41/7；M3 条件写反 `picked.length < 2` → 35/13；M4 删掉该传参行 → 39/9；M5 常量置 0（聚合也不冷却）→ 39/9；M6 写成 `AGGREGATE_COOLDOWN_MS * 0 + AGGREGATE_COOLDOWN_MS` 绕过源码锁 → 41/7，正是靠 Test 7 的行为判据抓到而不是靠文本匹配。

## 0.5.155

- 分类 chip 只认词表，不再混入作者自由标签（用户点名「douyin / 抖音 / tiktok / kuaishou / json / ai-tools / database 这些分类标签感觉好奇怪，从哪来的？跟其他类型具有可比性和不重复性吗？」）。取证结论：这七个值**不来自 clawhub 的分类系统**，来自每个技能的 `topics[]`（作者随便填的关键词）。逐个回溯上游 8 页×100 条定位出处：douyin 与 抖音 同出 douyin-hot-title-creation（categories=[research,creative,knowledge]、topics=[抖音,douyin,抖音选题]）；tiktok 出 mira-video-transcript；kuaishou 出 kuaishou-social-media-search；ai-tools 出 handle-big-tasks；database 出 chance-dlt-predictor（categories=[integrations]、topics=[Data Analysis,Database]）；json 出 agent-bom-discover-gcp（categories=[integrations]、topics=[Json]）。**七条全部只在 topics 里、一条都不在 categories 里**，所以它们不属于规范 14 类。两条不可用理由都是实测不是推断：①与规范类不可比——14 类回答「这技能干什么用」，而这七条是平台名（douyin/tiktok/kuaishou）与文件格式或数据主题（json/database），不同维度；②自身重复——douyin 与 抖音 是同一事物的两种写法，同时出现在列表里。另外点上去没用：直接打上游 category= 实测 security/integrations 回 HTTP 200 且行内 categories 含该 slug，douyin/抖音/json/ai-tools/database/kuaishou/zzznotathing 全部 HTTP 400，面板兜底后显示「所选来源不提供分类信息，已忽略分类筛选」。
- 泄漏机制（改的是这个，不是表面文案）：`clawhubCategoryOf()` 的取值顺序是 `category → categories[0] → topics[0]`。`topics[0]` 兜底本来是给**卡片**显示用的（有些行 categories 为空，卡片上总得有个分类），但面板画 chip 时复用了同一个字段，于是自由标签被当成分类。面板「更多分类（共 21 个）」= 规范 14 + 派生 7，算术吻合，说明这七条一直在列表里、只是被折叠挡住——0.5.153 的 live 复验只核对了「规范类出现」，没核对「自由标签消失」，属漏验，本轮展开折叠实测七条仍在（截图留档）。
- 契约修正：mergeCategoryVocab（client.js:145 可测岛）从「词表在前、派生值一律追加在词表之后」改为「**词表取到了就只用词表，一个派生值都不追加；只有词表一条都没取到（上游改版或抓取失败）才退回派生**」。派生兜底这条线不能删——它是「抓取失败时分类入口仍可用」的唯一退路，判据锁在 browse.sh（无词表市场派生保留）与「词表为空时退回页内派生」两处。
- 判据同步改（契约变了，不是判据松了）：test-skillsmp-category-vocab.mjs 62→65，新增「有词表时 chip 只来自词表（派生自由标签不得混入）」「词表在手时不产出 fixed=false 的派生 chip」「派生值恰为词表内 slug 时不产生重复 chip」，并把旧契约的三条期望值（vocab.length+1 → vocab.length）改到新口径；test-clawhub-category-vocab.mjs 59 项，「派生 chip 仍排在词表之后」改为「词表在手时不产出派生 chip」，「browse.sh 下两套词表都不出现」改为「browse.sh 无词表时派生 chip 保留」（锁住兜底分支）。RED 真值 60 passed, 5 failed（首条 `有词表时 chip 只来自词表  n=64 first={"value":"debugging","totalAll":532411,"fixed":true}`）+ 54 passed, 5 failed → GREEN 65/0 + 59/0，test-index-runtime 24/0 不回归。
- 反向破坏 4 向全杀（client.js 基线 c24f51003a359d7a，逐字节还原 true）：V1 词表在手仍追加派生（缺陷本体）→ 60/5 + 54/5；V2 词表整体作废 rows=[] 全走派生 → 58/7 + 53/6（FAIL 详情 n=1 first=weird-derived-slug，连「chip 窗口是条数最大 12 类」一起红）；V3 条件写反 rows.length>0 → 46/19 + 52/7；V4 写死平台名黑名单（douyin/抖音/tiktok/kuaishou/json/ai-tools/database 七个字面量）这种「换一种自由标签白名单」的实现 → 60/5 + 54/5。V4 第一版因语法错误 check=1 不算杀，重做合法版后才杀——延续「变异必须先断言真的改动了=true」。
- 已知遗留（本轮点名，不假装已处理）：`src/sort-capability.js:82 vocabularySortKeys(source)` 是**生产侧死导出**——全仓只有 test-skillsmp-category-vocab.mjs 引用它（用它断言「clawhub 与 sortKeysFor 读同一份 CAPABILITIES 且返回同一引用」），index.js / client.js / src/* 零引用。test-dead-exports 抓不到它，因为该套件的语料把 test/ 的引用也算作引用（Test 2 只查「仅本文件使用却仍 export」，vocabularySortKeys 连本文件内都没调用，但被 test 引用后 Test 1 的零引用判据不成立）。本轮不接线也不删除：接线需要产品决定（面板排序键现在走 settings 下发的另一条通路，把词表键并进去属排序契约改动，该单独一轮）；删除会拆掉那条同源判据。记在这里作为下一轮候选，并说明「不修」的理由。

## 0.5.154

- 面板兼容旧服务端的词表形状（0.5.153 发布后 live 实测发现的我自己的回归）。机制：client.js 会热更新，而宿主进程内的 index.js 要等重启，所以「新面板 + 旧服务端」是真实存在的中间态；0.5.153 把 categoryVocabulary 从单一对象改成分组 {skillsmp, clawhub}，面板只认分组形状，于是旧服务端那份未分组快照被当成「没有词表」——live 实测 skillsmp 那排带条数 chip **整排消失**（连「全部分类」都没有，截图留档），比 0.5.151 修的「显示别人的分类」更糟。修法：categoryChipsForSource 两种形状都吃——分组按 key 取；旧单一对象按它自己的 source 字段认市场（source 前缀与当前市场一致才生效，所以仍不串味）。判据 test-skillsmp-category-vocab.mjs +4 项：`旧服务端下发的未分组单一词表对象仍要生效`、`旧形状同样不得串到别的市场`、`分组形状里另一路尚未缓存时仍取本市场词表`、`分组形状缺 skillsmp 键也不得当成旧形状`。RED 63/1（详情 {"n":1}，即 chip 只剩派生那一个）→ GREEN 64/0。
- 反向破坏（client.js 基线 d6345c16f912d99f）：Y1 旧形状分支去掉 → 63/1（正是那条新判据）；Y2 旧形状不校验归属 → 63/1 FAIL「旧形状同样不得串到别的市场」（详情带出调试工具 532,411 出现在 clawhub 位上）；Y3 把 legacy 判据写成「没有 skillsmp 键就算旧形状」→ 第一版判据 64/0 抓不到，是盲区，补上「分组里另一路尚未缓存」（冷 skillsmp + 热 clawhub 的真实状态）与「缺 skillsmp 键」两条后才 63/1。逐字节还原全 true。
- clawhub 分类浏览的两处真实缺陷（live 与注入各自实测，都不是文案问题）：①**预取口径把分类页推到超时**：2026-11-23 live 实测 category=security 时上游每次只回 13 条（limit=50/100/197 都一样；文档 Bounded category reads may return a short or empty page with a continuation），而 browse 路径沿用无分类时的 size*(p+2) 预取——面板首页 24 条要 72 条 ⇒ 7 次串行 cursor，实测 11402ms，正好撞满 12s 预算，live RPC 因此回 degraded=[clawhub] + 「所选来源不提供分类信息，已忽略分类筛选」，即分类入口在 clawhub 上因自己的预取策略而整源超时。改成分类页只攒 size*p（够本页），实测同样 24 条从 7 轮/11402ms 降到 2 轮/3511ms；无分类浏览仍保持 size*(p+2)（那里每页回满 50 条，预取便宜、翻页秒开）。②**目录累积没有轮次上界**：extendClawHubCatalog 里 let guard = 0; guard += 1; 却从不检查 guard——上游只要「每页返回同一批条目 + 每页换一个 nextCursor」，state.rows.length 就永远追不上 need，循环不结束（注入实测 201 轮仍未收敛）。生产表现为整源挂到预算被切断，是「clawhub 不可达」的另一种成因。加 MAX_ROUNDS=40 并在 while 条件里真检查。
  **这条修法只解决首页**，深页仍受 cursor 分页本身限制：nextCursor 不透明，取第 p 页必须从第 1 页串着走到第 size*p 条，轮次 = ceil(size*p/13)。注入实测 page1=2 轮(≈3.2s)、page2=4 轮(≈6.4s)、page3=6 轮(≈9.6s)、page5=10 轮(≈16s)、page7=13 轮(≈20.8s)；live 冷路径实测 page7 category=research wall=12008ms items=0 degraded=[clawhub]（撞满 12s 预算），同一条件热路径 32ms。也就是说**冷启动直接翻到第 4 页以后仍会超时**，这不是预取口径能修的（上游不支持随机页，cursor 猜不出来），如实记在这里而不是宣称已解决；用户实际落地的首页已从超时回到 3.5s 内。
- 判据 test-clawhub-category-vocab.mjs +9 项（50 → 59）：Test 9 用注入的 13 条/页短页锁「首页只取够本页的上游轮次（≤3）」「短页预取下首页仍给满 24 条」「分类页仍 serverFacet=true」「未翻完游标时总数留未知」，并锁「无分类浏览仍按预取口径攒目录」；Test 10 锁「病态上游下必须自行收敛」「累积轮次有上界」。RED 真值 56 passed, 3 failed（`首页只取够本页的上游轮次  calls=6`、`病态上游下必须自行收敛  threw:INJECTED_STUCK_UPSTREAM calls=201`、`累积轮次有上界  calls=201`）→ GREEN 59 passed, 0 failed。
- 两处判据机制缺陷（都是「红得无效」而不是实现问题）：①Test 10 第一版用 Promise.race + 8s 定时器观察死循环——那个循环只 await 已完成的 promise（微任务），定时器是宏任务会被饿死，结果整个套件挂到 SIGTERM、连汇总行都没有；改成注入第 200 次主动抛错来观察「有没有界」，红才有原文。②注入的假上游每页返回同一批 slug，意外撞上上面那个真死循环——修正注入（每页 slug 互不相同）后 Test 9 才只测预取轮次；这条也说明注入必须照真实形状写，否则会被另一个缺陷污染。
- 反向破坏（extra-sources.js 基线 a6aa7231f97fa035）4 向全杀：Z1 预取退回 size*(p+2) → 58/1 calls=6；Z2 分类/无分类两口径写反 → 58/1 calls=6；Z3 去掉 while 里的 guard 检查 → 57/2 calls=201；Z4 上界写成 400（事实上仍无界）→ 57/2 calls=201。逐字节还原全 true。
- 门禁：63 套件（test:chain 第 63 项 = test-clawhub-category-vocab.mjs）。

## 0.5.153

- clawhub 分类通道重建（按 0.5.151 给 skillsmp 立的同一条标准：词表按市场归属、服务端筛过就不本地再筛）。先取证再动手，全部 2026-11-23 实测：GET /api/v1/skills/-/categories → 200，{categories:[{slug,label,description,icon}]} 14 条、含 other、顺序即站点目录显示顺序，**无条数字段**（文档原文 This is the public taxonomy, not a count of available skills ⇒ chip 只显示标签不显示条数）；GET /api/v1/skills?category=<slug> 服务端真过滤（category=security 首条 skill-vetter、行内 categories 恒含所请求 slug——两页 100 行 0 违例；无效 slug → HTTP 400；limit=200 实回 197、limit=500 仍 197）；cursor+category+sort 链真实（limit=50 两页各 50 行、重叠 0）；GET /api/v1/search?q=&category= 同样支持（文档 works with default and exact search，实测 q=agent&category=security 收窄生效），**但无效 slug 回 200+空 results**——与 list 端点的 400 不同形，所以「slug 不存在」不能靠状态码判，必须靠词表。监测方记忆里「browse 的 topic/tag/category 全被忽略」已过时，以本轮实测为准（0.5.144 取证时上游还没有这套分类端点）。
- 实现：①extra-sources.js 新增 parseClawhubCategories（0 列纯函数，脏数据只留合法 slug 并去重、label 空白回落 slug）+ clawhubCategoryVocabulary（7 天 TTL、命中回同一引用、失败或空一律 null 绝不落空快照）+ readClawhubCategoryVocabulary（只读缓存）；②searchClawHub 加 category 参数：facet 归一（trim/lowercase），词表在手时先校验（词表里没有的 slug 连上游都不发——那是「slug 不存在」，不许被说成「该分类下没有匹配」），browse 路径 category 透传 extendClawHubCatalog（URL 与**缓存键**都带 category，实测两页 50+50 重叠 0 证明链真实），search 路径 URL 带 category；上游 list 对无效 slug 回 400 时去掉 category 重发一次（宁可给全库首页并说明，也不许整源进 degraded）；两侧出口都带 serverFacet=facetUsed!==""——被拒（词表拒绝或 400 重发）绝不谎称服务端筛过；③index.js 的 settings.get 把词表改成**按源分组**下发 `{skillsmp: {...}, clawhub: {...}}`（两个都只读缓存、冷的那份各自 void 后台补取），import 一行补齐 clawhub 两符号——0.5.148 的缺 import 事故就是这条线上的，套件里锁了；④client.js 的 categoryChipsForSource 改吃按源映射：按当前源取词表 + 词表自带 source 必须与本市场前缀一致（旧快照不落 source 按可用处理），且 mergeCategoryVocab 的标签取值补上 label 字段（clawhub 词表用的是 label 不是 skillsmp 的 name，不改这个 chip 会显示裸 slug）。
- 新增回归 test/test-clawhub-category-vocab.mjs（50 项判据，登记进 test:chain 第 63 项）：夹具是生产通路（getJsonEscalating）真抓的 14 条词表 + browse 样本字节；判据覆盖解析器纯函数（含脏数据与 label 回落）、抓取/TTL/失败/空词表不落盘、只读缓存零网络、browse 与 search 两路真的发 category、serverFacet 口径、词表校验拒在本地、400 兜底重发、缓存键含 category（换分类必重新取数、同分类同页仍走缓存）、聚合层 AND 归约在 clawhub 参与时同样成立、settings.get 分组下发与 import、面板按源取词表 + 串味拒绝 + label 显示。RED 真值 11 passed, 19 failed（首条 FAIL 原文 `browse 带 category 时上游 URL 真的含 category=security  https://clawhub.ai/api/v1/skills?limit=50`）→ GREEN 50 passed, 0 failed。
- 反向破坏证伪 10 向（基线 extra-sources 276b287c24648ab7 / client 740f0a0574e456ef / index cc44dd0843e2a15d，每轮 node --check + 按 CRLF→LF 归一 sha16 逐字节还原全 true）：X1 browse 不发 category → 43/7；X3 结果缓存键去掉 :facet → 48/2（FAIL 换分类必须重新取数 calls=1）；X4 目录缓存键去掉 :cat: → 48/2；X5 400 重发兜底去掉 → 47/1 FAIL「上游 400 必须被内部兜住而不是抛给调用方 HTTP 400」；X6 词表校验分支 if(false) → 47/3；X2 browse serverFacet 恒真 → 48/2；X10 词表落空快照（length<0）→ 49/1；X7d 面板取词表不看当前源（恒取 skillsmp）→ 48/2；X8 串味来源核验去掉 → 49/1；X9 index 不读 clawhub 词表 → 49/1。等价一条如实记录：单纯去掉 expected 短路是等价变异（expected 恒真于存在的源），真正锁行为的是 X7d——杀它的是「clawhub 下拿到 clawhub 词表 14 条 n=1」，不是文案。
- 本轮自己抓出并修掉的判据机制缺陷（都是「判据没跑起来/没锁住」而不是「实现有问题」）：①第一次量 RED 套件直接崩（`Error: clawhubCategoryVocabulary 未导出` 外抛）——0.5.148 立过的规矩（缺导出必须变 SKIP 而不是崩）没照做，补 .catch 收口 + 缺导出 SKIP、真实异常 FAIL；②X5 最初被我的 catch 吞成 SKIP（死区假绿）：「任何异常都 SKIP」与「缺导出才 SKIP」的差别就是「重发兜底退化成外抛」能不能被抓到，改成 attempt 包装后 X5 → 47/1；③第一版接线判据 `(self.match(/compareVerdict/g)).length >= 4` 被判据文件自己的调用喂饱——同一类假锁第 3 次出现，改为按区块取段计数；④import 判据正则漏写 `\}` 恒假（假锁），对着真实 import 行改对；⑤X1 的变异正则跨不了嵌套花括号（replace 后 to===from，变异根本没生效就「存活」），改用字面切片并先断言「真的改动了=true」再跑。
- 门禁：发布前 62/63 suites green（唯一红 test-profile-sync＝工作树已改、profile 未装新版的预期中间态）；test-suite-inventory 的「无静默游离」判据当轮抓到新套件漏登记（这正是它存在的意义），补进 test:chain 第 63 项后转绿。

## 0.5.152

- test-full-sort 的 live 网络抖动固化成判据，不再靠人肉复跑收口（监测方 15:52 点名）。根因实测：Test 6 的守卫只看「两侧皆空」，而真实抖动形态是**单边降级**——一侧正常回条目、另一侧超时回 0 条 + degraded 非空，于是走进比较分支，把「这台机器此刻取不到 skillsmp」报成本仓库回归（门内原文 `FAIL plain == fresh（未被 name 排序污染）`，事后单独连跑两次 31/0、32/0 全绿）。Test 5 在 0.5.149 已改成「任一侧 degraded 即 SKIP」，Test 6 却仍各写一套——同一件事两套口径，所以还会再撞。修法：把判定抽成模块级纯函数 compareVerdict(a, b)，返回 {mode: skip|fail|compare, detail}，Test 5 与 Test 6 共用；skip 的 detail 必须带出是哪侧哪个源、什么错误文案（只说「跳过了」等于下一轮重新猜一遍）。
- 新增 Test 8（11 项判据，注入对象、零网络、确定性）：先用 oldShape 逐字复刻 0.5.151 之前 Test 6 的判据形状，锁住「单边降级时它确实会去比较」——这条是假红本体的存在性证明，不是靠叙述；再锁新判定五种形状：单边降级 → skip、降级在另一侧同样 skip（对称）、两侧皆空且无 degraded → fail、两侧都有数据且无降级 → compare、单边空但无降级 → compare（真回归仍由比较自己红）；SKIP 详情必须同时含降级源名与错误文案。接线两条按 Test 区块分别取段计数，不接受整份文件计数——第一版我写成 (self.match(/compareVerdict\(/g) || []).length >= 4，结果 RED 阶段它就绿了：Test 8 自己的注入调用把计数喂饱，这是「锁了文案没锁行为」的又一实例（与 M5、provenance 同族），改成 segOf('Test 5'→'Test 6') / segOf('Test 6'→'Test 8') 两个区块各自必须出现 compareVerdict(a, b) / compareVerdict(plain, fresh)，并否定区块内再出现 .degraded && .length 私有判据。
- RED 真值（改动前跑）：33 passed, 7 failed, 1 skipped，首条 FAIL 原文 `新判定：单边降级 → SKIP（不再进比较）  [{"mode":"ERR","detail":"compareVerdict is not defined"}]`，另有 `Test 6 不再自带「两侧皆空」旧形状` 一条直接点名旧形状还在。GREEN 42 passed, 0 failed, 1 skipped（那 1 个 skip 是 trusttools 上游此刻真不可达，SKIP 明细如实打出）。
- 反向破坏证伪 4 向（test-full-sort.mjs 基线 shaNorm16 2faadd6d7f52c34d / bytes 26125 / CRLF 315，每轮 node --check + 逐字节还原全 true）：W1 判定退化成只看 a 侧（不对称）→ 41/2，FAIL「单边降级 → SKIP」详情原文 {"mode":"compare","detail":""}；W2 两侧皆空改成 compare（放回空转绿灯）→ 39/1 FAIL「两侧皆空且无 degraded → FAIL」；W3 SKIP 不带降级名单 → 42/1 FAIL「SKIP 详情带上降级源与错误文案」；W4 Test 6 退回旧的「两侧皆空」形状 → 38/2，两条接线判据同时红（`区块 4958B 无调用` 与「口径唯一」）。第一版 W4 我构造成了语法错误（check=1、套件崩溃），那不算杀，重写成语法合法的真实退化后才拿到 38/2。
- 本版另含 0.5.151 的验证口径补注（见该段末）：面板半段已 live 逐源验过，服务端半段（撤掉 skillsmp 窗口说明）此刻 live 上仍未生效，依赖下次宿主重启——已用 pageSize=20/30 的缓存键必 miss 判别排除缓存因素，profile 落盘 src 与仓库归一 sha 相同（16429ce53073940d）而进程内响应仍含旧文案。

## 0.5.151

- 撤掉那条已失效的 skillsmp 窗口说明（用户点名「这句话已经过时、失效，不要再显示了」）。先取证再动手：真发上游实测 browse 态仍回 `{total:1200,totalIsExact:false,isCapped:true,maxResults:1200}`、facet 态 `{total:480,totalAll:532411,maxResults:480}`、search 未翻完 `{total:25,totalIsExact:false}` ⇒ 数字 1200 不是编的，失效的是它给的出路——「更早/更晚的条目需要换关键词继续找」写于面板还没有分类入口的时候，而现在有 63 个 chip（各自带上游 totalAll 真实条数），继续往里走早就不止换关键词一条路。所以删掉 window>0 那一支的说明（extra-sources.js），window===0（上游连窗口多大都没自报）时仍保留 SKILLSMP_UNBOUNDED_NOTE。撤说明不等于放弃口径：total/totalPages 必须继续留未知——新增判据 `去掉说明后总数仍不得冒充目录规模`（r.total===undefined && r.totalPages===undefined）与 `maxResults=777 时同样不显示窗口说明`，并把聚合层那条从「hints 里必须有 1200」改成「hints 必须为空且不得冒出 1200」。RED 真值 70 passed, 3 failed，三条 FAIL 的详情原文就是那句被点名的话；GREEN 73 passed, 0 failed。
- 分类 chip 改为按市场归属（用户点名「这是专属于 skillsmp 技能市场的分类标签，不要把它作为其他技能市场的分类标签」「每个市场的类型 Tab 都是一致的，且无法使用」）。取证：live 逐源实测 `category=debugging` —— skills.sh 回同样的 24 条 + 「所选来源不提供分类信息，已忽略分类筛选」；clawhub 17 条（面板本地过滤当前页，滤掉 7）；browse.sh 0 条（滤掉 24，整页空）；只有 skillsmp 真按 facet 取数（serverFacet=true、total=532411）。再看各源 page1 的 category 覆盖率：skills.sh 0/24、skillsmp 0/24（facet 生效时才回填）、trusttools 0/24、clawhub 7/24、browse.sh 24/24、lobehub 24/24、skillhub 24/24、modelscope 24/24。⇒ 那排带条数的词表 chip 来自 https://skillsmp.com/zh/categories，slug 只有 skillsmp 的上游认，显示在别的市场名下就是假陈述。新增纯函数 categoryChipsForSource(source, derived, vocab)（放组件外可测岛）：只有当前源是 skillsmp、且词表自带 source 字段时必须是 skillsmp 页面（旧快照不落 source 视为可用，兼容 0.5.148 已写入的缓存）才合并词表，否则退回 mergeCategoryVocab(derived, null) 即只用页内派生 chip——关掉入口不是兜底，派生 chip 在任何源都保留。面板接线从无条件 mergeCategoryVocab(categories, categoryVocab) 改为传当前 source。效果：skillsmp 下词表 chip 照常；clawhub/browse.sh/lobehub/skillhub/modelscope 只见本市场真实分类；skills.sh 等无分类字段的源不再显示任何假分类入口。
- 判据 test/test-skillsmp-category-vocab.mjs +16 项（46 → 62）：`skillsmp 下词表 chip 照常生效`、九个非 skillsmp 源（含 'all'、''、undefined）逐个锁 `不得出现词表 chip`、`派生 chip 在任意源都保留`、`面板按当前源决定词表 chip（接线可执行）`、`面板不再无条件合并词表`，外加两条来源核验：`词表来源不是 skillsmp 页面时即使当前源是 skillsmp 也不接受`、`词表未声明来源时按 skillsmp 词表接受`。RED 真值 46 passed, 14 failed（12 条「未取到函数体 categoryChipsForSource」+ 2 条接线）。GREEN 62 passed, 0 failed。
- 本轮自己抓到并补掉的三处机制缺陷（都是「判据没跑起来」而不是「实现有问题」）：①新判据块插在了 lineIf 定义之前 → `ReferenceError: Cannot access 'lineIf' before initialization`（TDZ，套件连汇总行都没有），把接线两条挪到定义之后；②harness 用 new Function 单独执行 categoryChipsForSource 的函数体时，它委托的 mergeCategoryVocab 不在作用域里 → `mergeCategoryVocab is not defined`，改为把两份真实函数体一起放进同一个 new Function 作用域（还原模块作用域的依赖关系，跑的仍是真代码而不是重写一遍）；③我写的来源核验分支（stated）起初没有任何判据覆盖——把 `stated` 改成恒真时全套仍 62/0，正是 M5 那类「写了分支没锁行为」的假锁，当轮补两条判据后才 61/1。
- 反向破坏证伪：窗口说明侧 3 向（extra-sources.js 基线 shaNorm16 16429ce53073940d）——把删掉的说明分支原样放回 → 70/3（详情原文就是那句被点名的话）；窗口>0 时也发「不给数字」那句 → 70/3；撤说明顺手把窗口报成总数（total = window）→ 套件直接崩（那是判据抓到口径倒退，不是实现细节），三条 FAIL 里含 `browse 不报 1200 这种窗口总数`。chip 归属侧 4 向（client.js 基线 shaNorm16 00905df8e55f6053）——词表对所有源都合并（缺陷本体）→ 51/11；只判源、丢掉来源核验 → 61/1；源名比较写错（'skillsmpX'）→ 60/2；非 skillsmp 时连派生 chip 一起关掉 → 51/11。每轮 node --check 通过、按 sha16 逐字节还原全 true。
- 本版两半的验证口径必须分开写，不许混成「已 live 验证」：
  · **已 live 验证的是面板半段**（client.js 热更新即生效）：真开 live 面板逐源实测——clawhub 下 chip 行是本市场真实分类（douyin/ai-tools/tiktok/database/kuaishou/json），skillsmp 下才是带条数的词表（调试工具 532,411 / 销售与营销 407,969 / 系统管理 210,265 / 代码质量 203,368 / Git 工作流 182,885…），skills.sh 下不再出现任何分类入口，且「所选来源不提供分类信息」提示也不再出现。
  · **未经 live 验证的是服务端半段**（撤掉那句窗口说明改的是 src/extra-sources.js）。宿主 14:13:50 重启时加载的是 0.5.150，0.5.151 的 src 改动此刻不在进程里：真发 live RPC `skills.search source=skillsmp` 仍回 `["skillsmp：skillsmp 上游把结果窗口截在约 1200 条…更早/更晚的条目需要换关键词继续找"]`，即**那句失效文案现在 live 上仍然显示着**。判别不是靠猜：profile 落盘的 src/extra-sources.js 与仓库归一化 sha 相同（16429ce53073940d）且已不含该句，而进程内响应仍含该句 ⇒ 差异只在「进程加载的是旧模块」。已另做判别排除缓存因素：把 pageSize 换成 20/30（缓存键必 miss）仍出旧文案。这一半要等下次宿主重启才在 live 上生效，属部署时机，不是代码缺陷。
  （0.5.154 轮闭合）宿主随后重启（GUI 端口 63068→62898），这一半现在 live 验过了：真发 RPC skills.search source=skillsmp 回 hints=[]、total=undefined、hasMore=true，且响应里已搜不到那句文案 —— 服务端半段与面板半段至此都算 live 已验。上面那段记录保留，因为它记的是当时的真实状态与判别方法（profile 落盘 sha 相同而进程内仍旧、pageSize 20/30 排除缓存因素），不是错账。
- 门禁：发布前 60/62，两条红都判过——test-profile-sync（工作树已改、profile 未装新版的预期中间态）与 test-full-sort 的一条 live 网络判据 `plain == fresh（未被 name 排序污染）`（69s 那一轮撞上上游波动；单独连跑两次 31/0 与 32/0 均绿，属真网络抖动而非本轮改动，如实记录不掩盖）。那条抖动已在 0.5.152 固化成判据（Test 8 + compareVerdict 单一口径），不再靠人肉复跑收口。

## 0.5.150

- 面板降级缺陷（一个 op 抛错不得让整页空白）：0.5.148 的缺 import 让 settings.get 每次必抛，client 的 settings 停在 null，而「路径」tab 的渲染写成 `tab === 'settings' && settings ? … : null` —— 于是目录草稿（本来就来自本地 state，一个字段都不依赖 settings）与「会话日志体检」（同样不依赖）跟着一起消失，用户截图原文就是「路径面板异常空白」。新增纯函数 pathsView(settings, skillDraftText, mcpDraftText) 放在组件外的可测岛上（与 mergeCategoryVocab/CAT_CHIP_FOLD 同一口径，测试用 new Function 执行真实函数体而不是正则命中），返回 {loaded, showPathsSection, showSessionSection, skillRows, mcpRows, configPath, providerLabel, clientLabel, degradedNote}：路径区与体检区恒为 true；草稿取自本地 state；只有真正依赖 settings 的三个字段在缺失时给如实文案「未知（settings.get 未返回）」，绝不谎报成「未挂载」（那是假陈述）；degradedNote 点名是哪个 op 失败、并说明哪些功能仍可用。渲染侧去掉整页 gate，改读 pv.*。
- 判别证据（监测方 12:52 提出的「一处缺 import 是否拖垮其它 op」，实测回答）：对运行中的宿主逐 op 真发 RPC —— settings.get 26ms ok=false（就是那句 ReferenceError），而 skills.search q=agent 4257ms ok=true items=12、skills.search q=pdf 12022ms ok=true items=167、skills.list 692ms ok=true、mcp.list 29ms ok=true items=3、mcp.status 4ms ok=true、mcp.tools.get 2ms ok=true、mcp.probe 1ms ok=true、sessions.scan 11ms ok=true items=40。⇒ 服务端 op 分发没有被级联打断：index.js 的 handler 对每次请求各自 try/catch（:1856-1871），一个 op 抛错只影响那一次响应。真正的级联发生在面板侧（settings 为 null 时整块渲染被 gate 掉），所以修的是面板降级，不是给分发再加一层兜底（那会掩盖真错误）。
- 新增回归 test/test-manage-states.mjs Test 5（12 项判据，跑真实函数体）：settings 缺失时函数可执行不抛 / 路径区仍渲染 / 体检区仍渲染 / 草稿仍可编辑（不被失败 op 清空）/ 未知项给如实文案 / 降级提示点名 settings.get；settings 在手时给真实配置路径与 provider、MCP 客户端真实路径、不再显示降级提示；provider 未挂载时不得谎报已挂载；空目录草稿给空数组（保存由服务端把关，面板不造数）；外加一条否定锁 `渲染不再把整个 tab gate 在 settings 上`（只看 gate 形态，不看文案）。RED 真值：23 passed, 2 failed —— 首条 `settings 缺失时函数可执行（不抛）  [{"err":"未取到函数体 pathsView"}]`，第二条就是旧 gate 字面量被逮住。GREEN 36 passed, 0 failed。
- 两处机制缺陷在量 RED 时暴露并修掉（都会让判据失真，不是产品问题）：①套件的 bodyOf 按 \n 切 CRLF 文件，每行结尾带 \r，「整行正好是 }」永远不成立 ⇒ 函数体永远取不到，那是判据失效而不是实现有问题（0.5.148 那轮同类坑重犯），改为先归一 CRLF→LF 再切；②我写在 client.js 注释里的旧 gate 字面量，被自己的否定锁当成「gate 还在」命中 —— 注释不得复述被否定的代码字面量（与 M5 的「锁了文案没锁行为」同一类假锁），注释改述形态、判据只看代码。
- 反向破坏证伪 5 向（client.js 基线 shaNorm16 3b1955ed4edab187 / bytes 206482 / CRLF 3368 / loneLF 0，每轮 node --check + 逐字节还原全 true）：把 && settings 加回渲染 → 35/1 FAIL「渲染不再把整个 tab gate 在 settings 上」；草稿改回从 settings 取（失败即清空）→ 35/1 FAIL「settings 缺失时草稿仍可编辑」（详情原文 [["C:/typed/skill"]/[]]）；未知态谎报成「未挂载」→ 35/1 FAIL「未知项给如实文案而非空白」；降级提示置空 → 35/1 FAIL「降级提示说明是哪个 op 失败」；体检区改成 showSessionSection: loaded（回到旧行为）→ 35/1 FAIL「settings 缺失时会话体检区仍要渲染」。五向各杀一条、无一等价。
- 门禁：发布前 61/62 suites green（唯一红 test-profile-sync＝工作树已改、profile 未装新版的预期中间态），total 见 gate150-pre.txt；发布后应回到 62/62。

## 0.5.149

- 热修线上崩溃（0.5.148 回归，用户实测「现在插件全是BUG，已经无法使用了」）：index.js 的 case "settings.get" 调用 readSkillsMpCategoryVocabulary 与 skillsmpCategoryVocabulary，却没有 ./src/extra-sources.js 的 import ⇒ 每次 settings.get 必抛 ReferenceError，面板四个 tab 顶部一律红字 `skillsmpCategoryVocabulary is not defined`，路径 tab 整页空白（用户截图原文）。补 import 一行即修（index.js:32）。live 复现证据：对运行中的宿主真发 POST /api/dsh-market/rpc {op:"settings.get"} → 200 `{"ok":false,"error":"skillsmpCategoryVocabulary is not defined"}`，profile 侧 index.js 实测无该 import（false），仓库侧 true。
- 这条崩溃为什么 61 套件全绿没抓到（盲区机制，一并修掉）：全仓没有任何套件 import 或执行 index.js，0.5.148 那 46 项判据里锁 settings.get 的三条全是对源码切片跑正则的「文本锁」——文本锁满足 ≠ 代码能跑，缺 import 这种链接期错误永远不会让正则失败。新增 test/test-index-runtime.mjs（登记进 test:chain 第 62 项，24 项判据）：真 import index.js、假 ctx 真跑 apply()（ctx.effect 立即执行 fn 取 disposer，与宿主语义一致）、从注册的 webServer 路由拿 handler、用 Symbol.asyncIterator 喂 body 走完整 RPC 通路。判据分五组：①apply 不抛 + 端点 /api/dsh-market/rpc 注册（kind=exact）；②settings.get 运行时可达（不抛、ok:true、settings.skillDirs/homeDir、sortCapabilities 三键、shipped 段），其中词表载体用真夹具播种进本次隔离缓存后要求带回 63 条分类；③其余只读 op 可达（skills.list/mcp.list/mcp.status ok:true、未知 op 报 unknown operation、mcp.raw.set 无 confirm 被拒）；④静态链接不变式：src/ 里任何一个被 index.js 当函数调用的导出符号，必须出现在 index.js 的 import 名单里（点名整类缺陷，不只是这两个函数）；⑤disposer 全可执行、apply 期间无 effect 抛错。缓存目录走 safeTempDir() + mkdtemp 每次唯一，不读写真实 ~/.dsh/market。
- 新套件 RED 真值（改动前跑）：exit 1、15 passed, 8 failed，首条 FAIL 原文 `settings.get 返回 ok:true  [skillsmpCategoryVocabulary is not defined]`，另有 词表通道带回 63 条分类 与 静态链接 两条点名两个缺失符号。GREEN 24 passed, 0 failed，连跑三次独立进程计数一致（确定性证明，监测方点名要求）。反向破坏 5 向（index.js 基线 shaNorm16 0c89f913f55803bb，每轮 node --check + 逐字节还原）：删 extra-sources import → 16/8（崩溃文案重现）；settings.get 不下发词表字段 → 23/1；词表读取写死 null → 23/1；下发键名改成 categoryVocab → 23/1；把只读缓存换成 await 后台抓取（首屏等网络）→ 本套件 24/0 但 test-skillsmp-category-vocab 45/1 FAIL「settings.get 只读缓存、不等网络（切 tab 不能被词表抓取拖慢）」，说明这条判据由既有套件负责，如实记录不冒充本套件的功劳。
- 套件自身的两处机制缺陷（都会让 RED 失真，不是产品问题）：①判据详情表达式写 `JSON.stringify(x).slice(0,90)`，而 JSON.stringify(undefined) 返回 undefined ⇒ TypeError 直接崩掉整个模块、连汇总行都没有（首轮 V2/V3 就是这样 exit=1 却没有 FAIL 行）；改成先取变量、undefined 显式写成「(字段缺失)」再截断。②新加的「全选/全不选」按钮把两处既有唯一锚撞重：`'全不选' : '全选'`（test-manage-optimizations 的技能批量条锚）命中 2 次、`renderedTools.map((tool) =>`（test-panel-perf-sort-fold 的起锚）命中 2 次，两个套件都在 import 阶段抛「锚不唯一」。修法：批量条锚加口径前缀改锁 `expandedVisible.length > 0 ? '全不选' : '全选'`（并写明两处全选各自由哪个套件锁），新按钮内部改用 `renderedTools.map(tool => tool.name)` 的无括号写法避开 perf 起锚，注释里也不得出现锚文本原文。
- 用户实测的四条面板反馈（09:14–09:30 原话，逐条改并补判据）：①「未勾选是意味着未启用吗？…而且缺少全选按钮」——浮窗里 checked 绑的是 toolDenyDraft.includes(tool.name)，即勾选=在禁用列表=禁用，而悬浮标题写的是「取消勾选 = 禁用该工具」，名实相反；标题改为「勾选 = 禁用该工具（从模型工具表消失，真正省上下文）；取消勾选 = 重新启用」。同时在浮窗底部补一个属于它自己的全选/全不选按钮（技能批量条那个管不到这里），口径=当前搜索可见且已分批显示的 renderedTools，分批未完时标题写明「只作用于已显示的 N 个（还有 M 个未显示）」。判据 test-tool-deny.mjs Test 4 +9 行（RED 44/1 → GREEN 45/0）。②「测试连接…短暂显示处理中，没有进一步的提示」——三分支全部改成可读产出：成功 `✅ 测试连接成功：<name> 连接正常，N 个工具（本条提示会保留，可放心查看）`、pending `⏳ …稍后再点一次「测试连接」即可`、失败 `❌ 测试连接失败：<name> 未连上——<原因>（检查该连接器是否被停用、命令是否可执行）`；失败原来只写红条（会被后续操作冲掉），现在也走 notice。判据 test-manage-optimizations.mjs Test A +5 行 → 38/0。③「定义原文的文本框也太小了，很难用啊」——textarea 由 height:180 改 height:480 + resize:'vertical'（原文是整份 JSON，180px 只够七八行）。判据 test-mcp-raw-edit.mjs Test 5 +6 行（锁高度量级 ≥400 与可拉伸，不锁具体像素）→ 53/0。④路径 tab 空白即上面第一条崩溃的表现，随热修一并消失。
- 反向破坏证伪 5 向（client.js 基线 shaNorm16 b5d0f311776783eb，每轮 node --check + 逐字节还原全 true）：标题退回「取消勾选 = 禁用」→ test-tool-deny 44/1 FAIL「勾选语义标题照实（勾选=禁用）」；整块全选按钮删掉 → 44/2；textarea 退回 height:180 → test-mcp-raw-edit 51/2（高度与可拉伸两条）；失败分支退回只写 setError → test-manage-optimizations 37/1 FAIL「失败分支也走 notice（不只 setError）」；全选集合从 renderedTools 换成 mcpTools.toolDetails（全量清单）→ 第一版判据 45/0 抓不到，是真盲区：旧判据只看标题文案里有没有 visibleTools 字样，按钮实际改哪个集合它不管。补两条实证判据（集合来源必须匹配 const names = renderedTools.map、按钮判定态必须按 renderedTools.every）后复测 → 45/1 FAIL 原文带出替换后的代码切片。补判据的那笔提交是 docs/test 侧（test/test-tool-deny.mjs +4/-1），不动发布产物，tag 仍指发布提交。
- 门禁：test:chain 61 → 62 项。发布前实测 61/62 green，唯一红 test-profile-sync（`✗ no stale copies profile:client.js, profile:index.js`）属「工作树已改、profile 未装新版」的预期中间态，判据正确；发布后应回到 62/62。

## 0.5.148

- skillsmp 分类词表通道（Phase 2）：面板那排技能分类 chip 过去是从**当前页卡片**去重派生的（client.js 的 categories），首屏页里有几个分类就只显示几个、翻页还会变，「按分类浏览」其实并不存在。0.5.145 已让数据层能按分类服务端取数（searchSkillsMp 的 facet），这一版把「有哪些分类」补成有事实来源：词表只能从 https://skillsmp.com/zh/categories 的 HTML 解析（编目端点 10 个候选实测全部 ENDPOINT_NOT_FOUND），抓取走 pythonText——Cloudflare 按 TLS 指纹拦截，node fetch 与 curl 一律 403，只有 CPython urllib 回 200。实测 75 个分类锚点 = 63 个带条数徽标的可浏览分类 + 12 个板块标题锚（后者逐个 GET 必回 400）；63 里有 62 个用每 slug 一次的实测确认可用，documents 那轮探针超时（-1），记为可浏览性未知而不是被拒（legacy 400 兜底路径本就能容它）。词表连同中文标签与条数快照落进 test/fixtures/skillsmp-category-vocab.json，页面快照 gzip 落 test/fixtures/skillsmp-categories.html.gz（409187B 原页 → 58524B）。
- 解析与缓存三段各自可测：parseSkillsMpCategories(html)（0 列纯函数；锚体窗口 1400 字符——先按 600 试过，中位锚长 1124/最长 1139，600 会把正文切掉只剩 12 条板块标题；名字取首个 span、条数取 bdi，靠 /^浏览/ 前缀与 totalAll <= 0 双重排除板块标题）；skillsmpCategoryVocabulary({ cache, getText = pythonText, now })（TTL 7 天，命中回同一引用不重复请求；抓取失败或一个分类都解析不出来时返回 null 且绝不落空快照——上游改版不能让面板静默变空）；readSkillsMpCategoryVocabulary({ cache, now })（只读缓存，冷/空/过期一律 null）。TTL 判定用的是存储里的 capturedAt 与注入 now 之差，不是 makeCache 的 ttlMs——后者内部固定 Date.now()，注入时钟的测试永远算过期。
- 下发通道复用 settings.get（与 0.5.147 的 sortCapabilities 同一先例，不新增 op）：case "settings.get" 改块体，await readSkillsMpCategoryVocabulary 只读缓存（不打网络，冷缓存立即 null），冷时 void skillsmpCategoryVocabulary({ cache: marketCache }).catch(() => {}) 后台补取——面板第一次打开不为词表多等一个网络往返。抓取失败降级为「没有词表」，chip 行退回原有派生来源，而不是退回空 chip 行。
- serverFacet：服务端已按分类筛过页这件事必须显式说出来，否则面板会在已经筛过的结果上再本地过滤一次。skillsmp payload 新增 serverFacet = facet !== "" && !facetRefused（被上游 400 拒掉的 slug 走的是去 facet 重发，绝不能谎称服务端筛过）与 facetUsed；聚合层 searchSkills 按 answered 源做 AND 归约（facetAnswered/facetConfirmed，handler 不提该字段一律按 false），只有全部参与的源都说「筛过了」才置真；置真时跳过本地分类过滤——那段过滤会保留未标注条目并留「本地过滤（仅当前页）」的说明，在 facet 页上那是假话。index.js 的 skills.search 显式带出 serverFacet。带关键词时 facet 不发（上游 search 与 category 互斥），因此也绝不宣称服务端已筛。
- 面板接线：新增三个纯函数（0 列声明、0 列收尾，可被 new Function 直接执行）——mergeCategoryVocab(derived, vocab) 词表行按上游条数降序在前且 fixed: true，派生分类去重后接在后面 fixed: false，词表缺失时退回派生原样；categoryChipLabel(value, vocab) 给 {value, label}（value 恒为 slug，查询与安装口径不变）；categoryLabelLite(chip) 输出「调试工具 532,411」这种带千分位条数的文案，替代原来直接印裸 slug。chip 行由 categories（派生，门槛保留）与 vocabChips 共同驱动，CAT_CHIP_FOLD = 12 折叠尾部（63 词条全铺一排也读不完），尾部一个「更多分类（共 N 个）/收起分类」按钮；选中分类且 serverFacet 为真时不再本地过滤。缓存读写两侧都带上 serverFacet（resultCacheRef 条目形状加了这一个字段），点缓存命中回渲染时不会把「服务端已筛」丢掉。
- 新增回归 test/test-skillsmp-category-vocab.mjs（登记进 test:chain 第 61 项）：46 项判据，真夹具 + 真解析器 + 真 searchSkillsMp 与真聚合层（只注入传输 fetchJson，legacy 的 400 拒收与去 facet 重发那条路径是实际跑出来的，不是文本搜索充当证据）。RED 量在最终 46 判据契约上：改动前的提交 b079dbd 单开一个 detached worktree，只把这份最终套件与两个夹具拷进去跑 → exit 1、6 passed, 26 failed（26 条 FAIL 逐字分类＝①三件未导出连带板块判别 4 条：板块入口按名字前缀排除／抓取失败返回 null／词表抓取与 TTL 段可运行／词表读取段可运行；②vocabularySortKeys 4 条：返回 null、两次调用不是同一个数组、clawhub 给 null、未知源给 "not-a-function"；③serverFacet 未置字段 7 条：facet 接受页（hint 里还挂着 0.5.145 的 totalAll 窗口说明）、被 400 拒的 slug、没做 facet 的源、带关键词、聚合 n=6、空结果 n=0、混合标注 filteredOut=2；④面板接线 7 条：chip 标签与 chip 文案两条 {"err":"未取到函数体 …"}、chip 门槛、词表驱动、本地过滤守卫、缓存写入、缓存命中回填；⑤下发通道 4 条：settings.get 切片无 categoryVocabulary、只读缓存、后台补取、聚合层把 serverFacet 交给展示层。mergeCategoryVocab 那条是 SKIP 不是 FAIL——它的函数体在基线里根本不存在，判据按「取不到就先跳过、由后面三条真判据负责」设计）基线那 6 条 PASS 不是空转：夹具在位、skillsmp 排序键与实测一致、facet 确实作为服务端参数发上游、facet 生效时卡片回填分类、被拒后去掉 facet 重发、chip 发上游用 value——全是既有行为被这份新套件重新锁住。GREEN 终态 46 passed, 0 failed。
- 套件自身两处机制缺陷在量 RED 时暴露并修掉（它们会让 RED 失真，不是产品问题）：①新增的合成 mini 页判据裸调用解析器，未导出时直接抛出，整个模块在 import 阶段崩掉、连汇总行都没有——补 try/catch 让缺失导出变成一条 FAIL；②三处「锚取行」用了 anchor-lib 的 once，GREEN 之前那一行根本不存在，once 抛「命中 0 次」同样把后面所有判据一起带走——改成 countHits 预检的 lineIf（取不到给空串），判据自己红。第一次量 RED 只跑出 15 条 FAIL 就是这个原因；那 15 条属于修机制缺陷之前的中间契约，把判据补到最终 46 项后重跑，才是上一条记的 6 passed, 26 failed。
- 反向破坏证伪 14 向（13 杀 + 1 等价；每轮 node --check + 按 CRLF→LF 归一 sha16 逐字节还原；基线 extra-sources 6364fa7ecbc04e0a / sources b6ebcf6ab777041a / sort-capability 6b410dd98c914db3 / index 6854352d33e78bc0 / client 7798d35de57c50ef）：serverFacet 去掉 facetRefused 判定 → 45/1；AND 归约退化成 facetConfirmed > 0 → 45/1；facetAnswered++ 改成只计非空源 → 45/1；vocabularySortKeys 未知源回空数组 → 45/1；vocabularySortKeys 回 list.slice()（两次调用不同引用）→ 45/1；client 缓存写入 serverFacet: false → 45/1；client 缓存命中回填 setServerFacet(false) → 45/1；client 词表 facet 页仍本地过滤 → 45/1；client 词表不排序（抄页面顺序）→ 45/1；空词表守卫改成 length < 0（落空快照）→ 45/1；去掉 /^浏览/ 前缀判别 → 45/1；聚合层去掉 !serverFacet 本地过滤门槛 → 45/1；index 冷缓存 void 改 await（阻断 settings.get）→ 44/2。其中三向在补判据之前是盲区（当时的判据集全绿抓不到），补上判据后已按最终 46 判据契约逐向复测：面板 serverFacet 落缓存的写入侧 → 45/1 FAIL「当页 serverFacet 落进结果缓存」；缓存命中回填侧 → 45/1 FAIL「缓存命中路径回填 serverFacet」（这两条文案锁的口径同 test-ux-honesty 锁 hasMore 的写法）；以及「facet 确认后混合标注的条目不得被本地删掉」→ 45/1 FAIL 原文 serverFacet=true n=1 filteredOut=2 note="分类为面板本地过滤（仅当前页），已过滤掉 2 项…"（facet 页恰好都被回填成同一个 slug 时，跑不跑本地过滤在旧判据下看不出来）。全 14 向跑完，5 个改动文件按 sha16 逐字节还原全 true、git status 干净。等价变异如实记录一条：在 getText 的 try 内加 if (!html) throw 仍 46 passed, 0 failed，因为它落进同一个 catch 依旧返回 null，行为不变，不算盲区。
- 门禁自身抓到两处（都是真红，没当噪音绕过）：test-temp-hygiene 的裸 tmpdir() 禁令抓到新套件自己——os.tmpdir() 在没有 TEMP/TMPDIR/TMP 的进程里返回相对串 undefined\temp（0.5.110 CI 实测事故），已改用 safeTempDir() → 7 passed, 0 failed；test-profile-sync 报 profile 落后于工作树，属发布前预期中间态，发布后转绿。
- 回归：test-skillsmp-search 72/0（facet 与 totalAll hint 通道未动）、test-clawhub-quality 86/0（categoryNote 三套文案仍只出自服务端本地过滤分支）、test-search-fanout-latency 196/0（其 new Function harness 的依赖清单同步加了 setServerFacet）、test-total-pages 38/0、test-sort-options 35/0 1skip、test-sort-ui-honesty 36/0、test-dead-exports 47/0、test-suite-inventory 11/0、test-ux-honesty 62/0、test-panel-perf-sort-fold 43/0、test-manage-panel 32/0。

## 0.5.147

- 聚合搜索等待时间的第一刀（基线量化 → 只动数据层，不改 UI）：src/sources.js 的聚合路径（面板一次搜索走的同一条代码）在真实网络上六次测量全部 ≈12.0s（就是预算值本身）：冷 12008ms、同条件第二次 12005ms（热/冷=1.0x，缓存没救到等待）、换页 12011ms、换词冷 12013ms/热 12010ms。根因有二：①超时源不写任何负缓存，下一个请求从头再等满一遍预算——单源实测 trusttools 12010ms 撞满 12s 预算、skills.sh 9010ms；②同一条件的并发请求各打各的上游（全仓此前无在途合并，AbortController 只存在于各 fetch 内部）。
- 超时冷却（负缓存）：fanOutSources 新增可选 cache/cooldownMs（默认 120s）/cooldownKey 参数；只有真的等满预算的源才写冷却键 `market_src_timeout:<query>:<source>`，冷却期内同源请求直接进「冷却槽」，degraded 文案如实写明「来源响应超时（预算 Ns），已跳过（冷却中，本轮不再重试）」。抛错与真实空结果绝不进冷却——抛错源每次都真重试（test-search-fanout-latency Test 2 契约保持）。先例：src/enrich.js:89-115 的 skillmd_miss 24h 负缓存。

- 【口径更正，0.5.156 追加】上面两段把冷却写进 fanOutSources 的公共默认参数，同时称聚合路径是「面板一次搜索走的同一条代码」——那句话当时只描述了代码路径，如今看是错的归属：面板因此也被冷却，实测（宿主 live，随机新词 source=trusttools）第一次 12040ms 超时、第二次 3ms 直接回「已跳过（冷却中，本轮不再重试）」，用户看到的是 120s 内点不出东西的空面板。0.5.156 把 `cooldownMs` 默认改 0、聚合路径显式传 AGGREGATE_COOLDOWN_MS=120000，本段的「同条件第二次 2848ms」收益自此**只适用于 agent 的 source=all 聚合搜索，不再适用于面板单源**。此处保留原文作为当时实测记录，不删不改数字。- 在途合并（同条件只打一次上游）：searchSkills 的聚合调用包进 fanOnce——同 query/source/page/size/sort/category 的并发调用共享同一次上游扇出，settled 后即从 inflight 表移除（合并 ≠ 永久缓存），不同条件的调用各打各的。
- 冷却生效后同一把尺复测（真实网络、同脚本、预算未改）：同条件第二次 12005ms → **2848ms（0.24x）**，第三次 2946ms，换词热 12010ms → 6986ms；冷路径不变（首搜仍要等最慢源，那是预算的诚实成本）。复测轮里 skillhub/trusttools 在部分窗口超时进冷却，下一轮即不再拖住整体。
- 行为测试锁死（test/test-search-latency-recovery.mjs，新增登记进 test:chain 第 60 项）：34 项判据全注入零网络——超时源第二次不再重付预算（等待差一个量级）、上游只被打一次、文案如实、抛错源每次真重试、TTL 到期重试（Date.now 冻结 119s/121s 两界）、同条件并发只打一次上游且两个调用方都拿到完整 items、page/query/sort/category 任一不同必须各打各、合并结束后再来重新取、槽位顺序与长度契约不变。RED 对 HEAD 实现原文 `14 passed, 15 failed`（第二次仍付 310ms/312ms、calls.dead=2、无冷却文案、并发各打各、三条源码锁不成立），GREEN `29 passed, 0 failed`。
- 反向破坏证伪 5 向（每轮 node --check + 按字节还原，GREEN 基线 sha16=7e8a67ab04bf5d6a）：去掉冷却写入 → `23 passed, 6 failed`；去掉在途合并（inflight 永空）→ `23 passed, 6 failed`；冷却只写不读 → `23 passed, 6 failed`；抛错也进冷却 → `27 passed, 2 failed`；恢复已删除的「names 同名 merged 复用」死分支 → `31 passed, 3 failed`（Test 6 的移除锁 + n===3 行为判据抓到）。死分支本身已删：picked 来自 ALL_SOURCES 去重集 / handlers 对象键，永远不含重复名，原 3 行复用逻辑测不到（第一版反向破坏 29 passed 0 failed 证实），删后 fanOutSources 相关套件与槽位契约全绿。
- 回归：test-search-fanout-latency 196/0、test-paging-deterministic 30/0、test-ux-honesty 62/0、test-dead-exports 47/0、test-suite-inventory 11/0、test-cleanup 14/0、test-total-pages、test-warmup 12/0、test-skillsmp-search 72/0、test-paging 13/0、test-paging-verdict 35/0、test-features 29/0、test-new-features 43/0、test-edit-lib 41/0、test-global-sort 9/0；门 59/60（唯一红 test-profile-sync 的「profile 落后于工作树」为发布前预期中间态）。

## 0.5.146

- clawhub 条目身份修正：`item.id` 过去直接采用上游 `raw.id`，而 search 端点的 `raw.id` 有两种形态——57/100 行已经自带 `clawhub:` 前缀（拼出来是 `clawhub:clawhub:kd75kdbc9…`），43/100 行是跨源形态（`skills-sh:google/skills/…`，与安装路由逐字相同）。同一技能在 search 与 browse 两种形态下 id 不同构，翻页追加去重（client.js:822）与目录累加去重（extra-sources.js 三处）因此失效。新增导出 `clawhubIdOf(raw)`：身份一律取 clawhub 的 owner/slug 对（实测 219/219 行带 `ownerHandle`+`slug`，176 个 distinct 键、同键多形态 0），`install.reference` 保持上游安装路由原样不被改写（跨源行它是真路由，改了会误装）。
- 卡片字段随身份一起归正：`owner` 不再从安装路由切段（旧写法把 43/100 行切成 `skills-sh:google` 这种值并直接显示在卡片上），改走 `clawhubOwnerOf`——`ownerHandle` 优先，`owner` 是字符串时用它，是对象时取 `.handle`（search 100 行里 57 行 `owner` 是 `{handle,displayName,image}` 对象，直接 `String()` 会写出 `[object Object]`）；`slug` 不再被安装路由第二段覆盖（旧写法 40/100 行错值，12 张卡共用 `superpowers`、10 张共用 `skills`），而 `item.slug` 正是「✓ 已安装」判定（client.js:1748）与安装中 busy 键（client.js:1754）的依据，错值会让一个卡片的安装态串到另外十几张。
- 三处目录/合并去重键改用 `clawhubIdOf`（`extendClawHubCatalog`、`warmClawHubCatalog`、`searchClawHub` 合并键）。裸 `slug` 当键会丢数据：100 条真实 search 行 distinct `raw.slug` 只有 84，distinct 身份对是 100。
- 回归 test/test-clawhub-quality.mjs Test 12 共 17 项判据：三种真实行形态（自带 `clawhub:` 前缀 / 跨源 `raw.id`+`install.reference` / browse 无 id）的 id 拼接、无双前缀、id 不含 `skills-sh:`、owner 与 slug 拼接、`installRef` 原样、browse 形态 homepage 仍是 `/<ownerHandle>/<slug>`、同 slug 不同作者必须两条款、`clawhubIdOf` 的 CLI 降级回落（本机未装 clawhub CLI，`spawnSync clawhub ENOENT`，该路径只能注入纯函数测）、身份缺段不造假 id、owner 对象取 `.handle`。RED 原文 12 条 FAIL（`69 passed, 12 failed`），GREEN `86 passed, 0 failed`。
- 反向破坏证伪 5 向（每轮 `node --check` 后按字节还原并校验）：id 公式退回 `raw.id || reference || raw.slug` → 5 failed；search 合并键退回裸 slug → 2 failed；目录累加键退回 `raw.id ?? raw.slug` → 1 failed；`clawhubOwnerOf` 退化成 `String(o)` → 2 failed（`[object Object]/s`）。第一版判据存在盲区：owner 只测了 `ownerHandle` 与字符串 `owner`，把 `String(对象)` 的变异放过去（`84 passed, 0 failed`），补上 owner 对象两条判据后该变异才会红。
- 测试自身的机制缺陷修正：函数体提取原先用 anchor-lib 的 `blockEnd`（按花括号深度扫），而 `warmClawHubCatalog(cache, options = {})` 与 `searchClawHub({ query = "", … })` 的签名里带内层花括号，深度在签名行就归零，取到的「函数体」只有一行、判据恒假；改为扫到下一个 0 列 `}` 行，并且必须先剥行尾 `\r`（源文件是 CRLF，按 `\n` 切开后每行结尾带 `\r`，裸比较 `'}'` 永远不等）。
- `test-full-sort` Test 7 重写为决定化判据，并把一处假红根治：该段原先只靠真实上游做「聚合排序生效」断言，而每个源只有 12s 预算（sources.js:588 `budgetMs = 12000`），门内 59 套件并发压满时 skillhub/trusttools/lobehub/browse.sh 四个带安装量的源集体超时，只剩上游本身没有 installs 列的 skillsmp+modelscope（extra-sources.js:951 `installs: 0`）回话，`withData.length > 0` 恒假——于是把「这台机器此刻被压满」判成本仓库回归（门内原文 `FAIL aggregation sort applied (nonzero installs exist) [0,0,0,0,0,0]`，同一改动单跑 `22 passed, 0 failed`）。现改走 `searchSkills` 既有的 handlers 注入点断言排序语义（高值刻意放后面、两源交错），真实上游那一层保留但补上「answered 源均无 installs 数据」的 SKIP 分支并如实打印 degraded 名单。
- 同一套件 Test 5（skillsmp 按安装数须被诚实拒绝）也补上单边降级判据：旧写法只挡「两侧皆空」，而实测 4 轮里有 1 轮带 sort 的那一路超时回 0 条、基线那一路正常回 12 条（degraded 名单为 `skillsmp:来源响应超时（预算 12s），已跳过`），于是走进比较分支，把「这台机器此刻取不到 skillsmp」报成本仓库回归（门内原文 `FAIL installCount 被降级为不排序 a= | b=skillsmp:morluto…` + `FAIL a 与基线条目集合一致 a=0 b=12`）。现改为任一侧 degraded 非空即 SKIP 并打出名单；「单边为空但两侧都没降级」保留为真回归判据。修正后连跑三次 `32 passed, 0 failed, 0 skipped` / `31 passed, 0 failed, 1 skipped` / `30 passed, 0 failed, 1 skipped`。
- 该重写的反向证伪（`node --check` 后按字节还原 sha=500eae81348bb237）：把 `aggregateSort` 整个关掉 → `23 passed, 5 failed`；installCount 比较符反向 → `29 passed, 2 failed`；把多源条件去掉让单源路径也二次重排（旧缺陷②）→ 本套件 `27 passed, 0 failed` 抓不到，跨套件实跑由 `test-search-fanout-latency.mjs:159` 的文本锁抓住（`195 passed, 1 failed`「聚合排序兜底限定在多源且用 effectiveSort」）。
- 门禁 59 套件。

## 0.5.145
- **skillsmp 分类 facet 透传 + facet 总数口径（Phase 1，零配额 legacy API）**：
  `searchSkillsMp` 此前根本不收 `category`，聚合层（`src/sources.js:614`）已经把分类传进
  每个 handler，skillsmp 这一路直接丢掉——选分类 chip 等于没选。现在纯浏览态把 facet 发给
  上游 `category=`，缓存键加 facet 段（原来两个分类的同一页会串成一条缓存）。
- **带关键词时绝不发 facet**（实测 `search=pdf` total=7，加 `category=ide-plugins` 仍报 7，
  但首 6 条与不带 facet 的结果重叠 0/6）：上游忽略 facet 且静默换成另一个集合，
  发出去就是「用户以为按分类筛过，实际拿到别的东西」。
- **facet 词表只有 63/75 被 legacy 接受**（其余 HTTP 400 `INVALID_CATEGORY`，tools、business、
  data-ai、databases 都在被拒之列），且没有公开的编目端点可查（`/api/categories`、
  `/api/v1/facets`、`/api/filters`、`/api/stats` 等 10 个候选逐个实测 404）。因此被拒时
  去掉 facet 重发一次并在 hint 里说明，绝不因一个非法分类让整源进 degraded。
- **修正「480 当目录条数」的新缺陷面**：带 facet 时上游 `pagination.total` 恒 480
  （limit=8/24/48 下 totalPages 60/20/10，乘积都是 480；10 个分类 + 2 个 occupation 全报同一个数），
  那是窗口深度。同一响应里上游另自报 `totalAll` = 真实条数（`category=debugging` → 532411、
  `cli-tools` → 21484、`occupation=software-developers` → 1124877）。现在 total 取 totalAll，
  totalPages 只能取窗口页深，hint 同时写明「目录共 N 条、可浏览窗口只有 M 条即 K 页」；
  窗口翻完（`hasNext:false`）不再谎称有下一页；没有 totalAll 时照旧不报数字。
  判据顺序同步改为「先窗口后精确」——旧写法里 facet 态 `totalIsExact:true` + `isCapped:true` 
  同时成立时会走精确分支，把窗口深度 480 当总数报出去。
- **卡片分类回填**：skillsmp 的行上没有分类字段（实测 16 个键里没有 category/topics/tags），
  分类只能来自本次浏览的 facet，由请求侧回填；facet 被拒时不回填，不给卡片安一个上游没承认的分类。
- **stars 不再是 0**：`src/extra-sources.js` 旧注释称上游 stars 是占位符并写死 `stars: 0`；
  实测 plain 首行 stars=469982、`sortBy=recent` 首行 1602，forks 同理，是真实的仓库星数
  （同一仓库的多个技能共用该仓库 star 数是上游口径）。现在照实透出，卡片才显得出 ★。
- **排序能力矩阵不再低估**：`sortBy=stars|recent` 实测服务端全盘生效且跨页单调
  （p1 最小 updatedAt = p2 最大 = 1795140060），`src/sort-capability.js` 的 `"skillsmp"` 从
  `["name"]` 改为 `["stars", "updated", "name"]`，handler 把 stars→`sortBy=stars`、
  updated→`sortBy=recent` 交上游，并取消这两个键的本地重排（本页重排会打乱服务端全盘序）；
  `installCount` 上游无此键，仍诚实拒绝。
- **回归**：`test/test-skillsmp-search.mjs` 新增 Test 11-15（facet 透传/回填/缓存键/400 兜底、
  totalAll 口径与页深、stars 真值、sort 映射与不重排、取证注释锁），套件 43→72 项；
  `test/test-sort-options.mjs` 的 skillsmp 三格与矩阵逐字锁同步。反向破坏 10 向（不发 facet、
  不回填、缓存键去 facet、400 不兜底、不用 totalAll、恢复旧的精确优先判据、stars 写死 0、
  不发 sortBy=stars、不发 sortBy=recent、矩阵退回 name-only）全部被抓红，源码逐字节还原。
- 取证细节（10 个编目端点候选全 404、75 slug 白名单逐个实测、480/totalAll 原始响应）写在 `src/extra-sources.js` skillsmp 段注释与 `test/test-skillsmp-search.mjs` 头注；Phase 2（面板固定词表的分类入口）单独发版。

## 0.5.144

- **skills.sh 的总数不再随页码变（D1）**：`searchSkillsSh` 旧写法 `hasMore = rows.length >= depth`、`total = hasMore ? Math.max(Number(data.count) || 0, depth + 1) : (p - 1) * size + rows.length`。直打上游坐实 `/api/search` 的响应键里 `count` 恒等于本次返回行数（limit 10/24/30/60 → 10/24/30/60），**上游从不报总数**，且没有 offset 参数、单次硬顶 200 条（q=test/code/pdf 在 limit=200 与 500 下都回 200 行；q=agent 144、q=skill 129、q=dev 196 未撞顶）。于是实测复算 q=agent size=24：page1 报「共约 25」、page2 49、page3 73、page8 312（此时 hasMore 已 false）、page9 336 —— 总数随页码线性增长，且明说「没有下一页」时仍在按页凑数。新口径：请求窗口多要一条作探针（`probe = size * p + 1`），三态判定 —— 探针那条到手 ⇒ 只能说还有下一页且 `total` 未知；窗口内没取满 ⇒ 见底，`total = rows.length` 与页码无关；撞 200 顶 ⇒ `total` 未知并把原因写进 hint（面板通知线是活路径 client.js:815/:845）。真实上游复验：pdf p1/p2 均 `total=undefined hasMore=true`；agent p8 `total=144 hasMore=false pages=6`（真实末页之后，面板翻不到）；test p9 `total=undefined hasMore=false` 且 hint 带 200；zqq-never-match-xyz p1 `total=0`（空结果不谎称到底）。
- **回归不再依赖上游心情（新增 Test 5 于 test-paging-deterministic）**：17 项断言，四条源码文本锁（窗口顶常量存在且 =200、`count` 不再参与总数、页码反推算式已从该段消失）+ 四组注入场景（`globalThis.fetch` 只匹配 `www.skills.sh/api/search`，其余回 404）。RED 原文 15 passed, 15 failed；GREEN 30 passed, 0 failed。反向破坏六向均红（恢复旧算式 7 红、去掉探针 6 红、删 hint 1 红、hitCap 分支改 hasMore=true 1 红、hitCap 恒假 2 红、见底改 `total = size * p` 1 红），每轮按字节还原并校验 sha；唯一不红的变异（`hasMore = rows.length >= depth`）经分析是等价变异，如实记录不作证据。
- **LobeHub 规模未知时不再编数、也不再永久禁用下一页（D3）**：`src/lobehub-market.js` 旧写法 `total: Number(data.totalCount) || items.length`、`totalPages: Number(data.totalPages) || 1` —— 字段缺失/为 0/非数字时谎报「共 2 个 · 第 1/1 页」，而 `client.js` 的 LobeHub 专行是裸模板，`第 N/0 页` 是新谎；更糟的是 `canLoadMore` 回落 `page < (catalog.totalPages || 1)`，而 `loadLobeHubCatalog` 从不设 `hasMore`，于是「上游没说规模」= 下一页永久禁用。现在缺失/0/NaN 一律 `undefined`（0.5.140 起全仓同规），并给出诚实 `hasMore: items.length >= size`（本页取满即后面大概率还有），两个成功分支各自透传，专行改走与分页器同一判据的 `pagerSummary`（unknown 时只显示「第 N 页（可继续加载）」，不显示数量子句），`run = runCli` 注入接缝让用例零网络。真打 LobeHub CLI 复验 `items=2 total=127537 totalPages=63769`（上游今天确实给数 ⇒ 这是潜伏缺陷，动它的原因是缺失时才咬人）。
- **SkillHub 分页判据不再拿未钳制的入参比（D4）**：请求用 `size = Math.min(50, Math.max(1, pageSize))`，但 `hasMore: items.length >= pageSize`、`pageSize: items.length || pageSize` 比/报的是入参原值 —— 面板与工具面的页宽（[12,24,48] / ≤50）今天碰不到，但上游真实 total=233969 的集合一旦按 pageSize=60 请求就会谎称最后一页。三处统一用钳后 `size`，`total` 在上游没给正数时不再拿本页条数凑（有货 → `undefined`，空结果 → `0`）。实测：pageSize=60 ⇒ `items=50 total=5621 pageSize=50 hasMore=true`。
- **mcp_market_search 的工具面与 RPC 面 total 口径统一（D5）**：工具面写 `total: catalog.total || items.length`，而 registry 分支只设 `estimatedTotal` ⇒ agent 读到的永远是「本页条数=总数」；RPC 面 `catalog.estimatedTotal || catalog.total || catalog.items.length` 是另一套。两面统一为 `catalog.estimatedTotal || catalog.total || undefined`，并把 `|| 1` 的页数回落改成 `|| Infinity`（未知就是不承诺，不编「只有一页」）。此前该处零覆盖，已补断言。
- **browse.sh 的 CLI 兜底不再把窗口当总数（D6）**：Web API 无结果时走官方 CLI `browse skills find <q> --limit <size>`，`--limit` 就是窗口上限，旧写法 `total: cliItems.length, hasMore: false` 等于宣称「这就是全部」——实测窗口取满时后面的结果被读成不存在。改为 `total: undefined` + `hasMore: cliItems.length >= size` + hint 写明「CLI 单次最多返回 N 条，窗口之外取不到也不计数」。本地全量目录那条路径（`total: matched.length`）是精确值，未动。
- **skillsmp 搜索参数与总数口径（子代理实现，Lead 独立复验）**：上游 `filters` 只回显真键，`q`/`keyword`/`query` 一律被忽略 ⇒ 任何关键词都返回同一 1200 条 capped 窗口（这就是旧「换词总数不变」的真因）；改为 `search=<q>`。`limit` 上界实测 48（24/40/44/45/48 正常，49/50 报错），旧代码 `Math.max(size, 10)` 会越界；新增 `SKILLSMP_MAX_LIMIT = 48` 钳制。总数三态：上游 `pagination.totalIsExact === true` 才透传；`isCapped`/`maxResults`/`totalIsExact: false` ⇒ `total = undefined` 且 hint 引用上游自报的窗口上限并声明「不是目录总数」；无 pagination ⇒ `hasMore = items.length === size`。站点 hero 上的 4,248,026 是 SKILL.md 文件总数，与 `/api/skills` 无关，绝不作为总数呈现。套件 `test/test-skillsmp-search.mjs` 独立复跑 41 passed, 0 failed，其 16 向自证伪全红后还原；`getJsonEscalating` 不接受 `pythonFirst`（`src/http.js:226` 只收 headers/timeoutMs），该越界诉求未采纳，保持默认升级序。
- **clawhub 分类的真实载体是 `categories` 数组，推翻 0.5.138 的结论并修正取证措辞**：本轮直打真实端点各 50 行 —— search 行 `categories` 非空 50/50、`topics` 键 0/50、`category` 键 0/50；browse 行 `categories` 非空 49/49、`topics` 非空仅 27/49。0.5.138 依据的是三行样本，结论「上游无 category 键、载体是 topics」在措辞与载体上都与今日实测不符，而 `clawhubCategoryOf` 只读 `topics` ⇒ 两条路径都存在的 `categories` 被整个丢弃，分类 chip 对 clawhub 永不出现。取值顺序改为 `raw.category`（上游今天不给，给了就是权威值）→ `categories` 首个非空项（小写归一）→ `topics` 首个非空项；新增四条判别（categories 首项、categories 空数组落 topics、categories 非数组落 topics、两者都非空时优先 categories）。证伪四向：去掉 categories 分支 2 红、topics 优先 1 红、取消 raw.category 优先 1 红、去掉数组校验直接 `TypeError: v is not iterable` 使套件崩溃（同样不作通过证据）。`src/sort-capability.js` 的 skillsmp 取证注释同步改准（`sortBy=recent` 服务端生效、未知键静默 200 而非 400）。
- 门禁口径：套件数 58 → 59（新增 skillsmp 套件登记）。本轮同时修掉一处门内假红——`test-total-pages.mjs` 的 skills.sh 项在本地全量目录取不到（sitemap 不可达，实测 `items=0 degraded=1`）时报 `totalPages=undefined` 被旧断言判红；未知是 0.5.140 立的规矩而不是回归，改为证据门控（items=0 记 SKIP），真实网络下仍判数字与 `totalPages = ceil(total/pageSize)` 同源。

## 0.5.143

- 修复 clawhub 搜索结果总数与翻页（真实上游取证 2026-11-23）：上游 `/api/v1/search` 顶层只有 `results`、没有 `total`/`count`，`page` 参数被忽略（page=1 与 page=2 首两条同一批），`limit` 生效但 100 是硬上限（实测 limit=150/200/300/500/1000 恒回 100 条），且 limit=10 的返回正好是 limit=100 的同序前缀。旧实现按页码并发打 1–6 个假分页请求再拼窗口，于是同一查询的总数随页码跳（实测 `q=pdf` page1 报 total=11、page2 报 total=10），page≥2 全空、页大小 50 时 total 缩成 10——那是拿窗口凑数的下界 `wanted+1`，不是上游事实。现在取数口径改为单次请求整个 100 条窗口 + 本地翻页：未撞上限时 `total` 就是这个集合的真实条数（与页码无关）、`totalPages` 可算；撞上限时 `total`/`totalPages` 保持未知（不报 100 也不报 101），`hasMore` 只在窗口内承诺，并给出提示「clawhub 搜索上游单次最多回 100 条且不报总数，再往后的结果需要换关键词继续找」。附带收益：一次请求取代最多 6 次并发。真实上游复验 `q=pdf`：page1/2/3 各 24 条、page11 空、total 与 pages 恒为 undefined、hasMore 只在窗口尽头转 false（修复前 page2/3 是 0 条且 total 在页间跳）。`searchClawHub` 增加 `fetchJson` 注入口（默认走真实取数，仅为确定性测试开口）。
- 新增回归：`test/test-clawhub-quality.mjs` Test 11 用注入 handler 断言 total 与页码无关、未撞上限时等于窗口真实长度、第 4 页不再翻到空页、不再出现 wanted+1 下界、撞上限时 total/pages 双未知且给出说明、只发一次请求且带 limit=100。反向破坏四向均转红（变异先过 `node --check`，排除语法错误冒充红）：A `capped` 恒 false → 3 条红（total 报 100、pages 报 10、说明消失）；B `out.total = merged.length`（无视上限）→ 1 条红；C `hasMore = merged.length >= wanted`（退回旧窗口下界判据）→ 1 条红（越 100 条仍承诺有货）；D `WINDOW_CAP = 10` → 5 条红（窗口截断后 total/翻页/说明/limit 全塌）。每向恢复后与基线字节一致。

## 0.5.142

- **修掉张冠李戴的数据正确性缺陷**（比取数失败更严重）：`skillhub.evaluation` 旧实现把面板传来的整段标识 `@user_xxx/slug` 一起 `encodeURIComponent` 塞进路径，上游只认「路径=纯 slug」，于是稳定 405，面板显示成一句笼统的降级文案。改成纯 slug 也不行 —— 实测 250 条样本里 6 个 slug 被多作者共用：`global-biblio-base` 不带作者时上游解析到 `skillId=70996`（属 `@user_164f4c1f`），而 `@user_814dbe54` 的同名条目是 `skillId=180618`，**用纯 slug 就是把别人的质量评分显示在这张卡上**。正解是路径放纯 slug、作者放 `?namespace=@owner`（实测两种编码形态等价、两作者各自解析），拆不出作者时显式拒绝而不是退回纯 slug 赌归属。上游对不存在的作者组合回 404 `skill not found`，说明它自己按归属校验，不会静默给错数据。证伪两向：去掉 namespace 参数 → 三条归属断言全红（首版注入因多写一个右括号红在 SyntaxError，那是假证据，已用语法平衡的变异重做并显式检查语法有效）；缺作者也照发 → 红。
- **HTML 响应不再冒充上游故障**：v1 端点族里 `www` 域与缺 `/api` 前缀的路径实测回 200 + SPA 的 HTML，旧写法在 `response.json()` 里炸成 `Unexpected token <`，面板只能说「暂不可达」，用户分不清端点错了还是上游挂了。`getJsonV1` 改为先取文本再解析，失败报「SkillHub v1 响应形态不符（非 JSON，疑似落在 SPA 页面上）」并带上响应开头。
- **live 判别点加硬前置**（用户点名要求做成机制而非说明）：第一次跑「SkillHub 搜 pdf 的 total」时探针其实打在主页面搜索框（面板没打开），摘要当然没变 —— 差点把已生效的 keyword 修复判成未生效。`test/live-audit.mjs` 新增 `assertProbeLanded`（面板已开、控件归属为 `owner==='panel'`、目标按钮数与预期一致，任一不满足返回 `landed:false` + 原因）与 `verdictOf`（未测成只能写 `NOT-TESTED`，禁止写成 PASS/FAIL）。三向证伪：取消面板前置红、取消控件归属红（正是本轮失误形态）、按钮数为 0 的专门分支**注入后仍全绿** —— 不等式已覆盖 0，那条是装饰，已合并进唯一判据并对合并后的判据重新证伪（删掉它两条断言都红）。真值表进 test-ux-honesty（62 项）。
- 顺带清掉 `test-ux-honesty.mjs` 里我前几轮插块留下的重复总结行（输出打了两遍 `54 passed`，正是「计数与真实集合不符」那类缺陷的同类，只是发生在测试自己的输出上）。

## 0.5.141

- **详情入口从「有 URL」升级为「打得开」**（用户指出：不是我们的代码 ≠ 不用我们负责）：live 实测点 clawhub 卡片的「详情」，停靠 tab 打开 `https://clawhub.ai/<owner>/<slug>`，页面主体只有 Chromium 的灰色禁止图标，console 稳定报 `Framing 'https://clawhub.ai/' violates ... frame-ancestors 'none'`；宿主工具条上的「关闭沙箱限制」实测无效（拦截来自页面级 CSP，不是宿主沙箱）——所以这不是能绕的开。逐源直打真实页面读响应头：clawhub / skills.sh / github(skillsmp) 回 `X-Frame-Options: DENY` 且 CSP `frame-ancestors 'none'`，skillhub 回 `SAMEORIGIN`、modelscope 回 `'self'`，这五个源都拒绝被非同源的宿主框架承载；lobehub、browse.sh 实测未设限，trusttools 未测（因此不进名单）。新增 `embedBlockedFor`（名单只收实测拒绝的源，没实测过的源不置灰——凭猜测限制用户与谎报内容同罪），技能卡与 MCP 卡两处入口同口径：被拦时按钮置灰、title 改为「该站点拒绝被内嵌，内置浏览器里只会是空白拦截页」，不再承诺一个拿不到的结果。四向证伪（取消名单 / 名单漏 skillhub / MCP 卡不接判定 / title 退回旧承诺）全部变红。
- **「无本插件报错」的口径改成按【触发方】判定**（不该按报错文本里有没有我们的文件名，否则这类问题永远落在判据缝隙里）：新增 `test/live-audit.mjs` 纯函数（`classify` / `signature` / `audit`），相位由 live 脚本在每次点击前后打点，`TRIGGERED`（点击本插件按钮后才出现的签名）与 `PLUGIN`（文本命中插件面）计入待处理，宿主基线噪声豁免。实测校准过程如实记录：第一版把宿主 GUI 自己每几秒就刷的 `GET /api/changes.summary → 404` 也算成本侧触发（过度归因），改为按**签名首次出现**定性后收敛为 2 条（CSP 拦截 + 点击后新出现的 bfcache 断连）。`signature` 的归一化逐步注入证伪，URL 剥离 / 会话 id 归一 / 空白归一三步去掉后断言仍全绿 —— 属装饰代码，已删除，只保留被真实断言咬住的数字归一，注释同步改到与实际一致。真值表 9 例进 test-ux-honesty（54 项）。
- **fanout 套件的 chip 行解析改为「歧义即失败」**：它原本用 find() 取「第一条同时含 skills.sh 与 modelscope 的行」，本轮新增的 `embedBlockedFor` 名单行恰好也含这两个源名并抢先命中，于是数出 5 个源（断言红）。按 anchor-lib 的立场改成候选行必须唯一、命中数不为 1 就显式失败，不再静默挑一条。

## 0.5.140

- **门禁不再取决于上游当时的心情**（用户 2026-11-22 指出）：`test-paging` 的断言绑在真实上游上，trusttools 一超时它就「门里红、单跑绿」——这既是假红源，也会掩盖下一次真回归（`b33e626` 就是在 gate 报 test-paging 真红时被提交的，纪律违规一并记在此处）。新增 `test/test-paging-deterministic.mjs`：13 项断言全部走 handler 注入（零网络、秒级、可重复），覆盖「单源整取失败」「p1 失败 p2 有货」「取数成功必须照报数字」「多源部分失败保持既有口径」四种形态；`test-paging` 保留为可达性探针——抛错、有一页为空、页大小不足、缓存两次抓取内容不同，一律记 SKIP（信息性），但**重叠、越界页非空、重试后仍空而上游宣称有货**这些只有本侧能造成的形态仍然判红。套件数 57 → 58，`test:chain` 段数与唯一段数由登记完整性检查复核。
- **顺带修掉探针抓出的真缺陷**：一次上游超时曾被聚合层报成「共 1 页 / 共 0 个」（`pages=1`、`total=0`），而同一视图的下一页（成功那次）又报 `pages=undefined` —— 一个情况两种口径。`pages=1` 来自 `Math.max(pagesSum, ceil(total/size), 1)` 的兜底，取数失败的源什么都没说，却被读成「目录只有一页且为空」。现在单源失败时 `pagesUnknown`/`totalUnknown` 一起置起，失败与空目录在返回值上不再可混淆；多源聚合部分失败保持既有语义（成功源照报数字、坏源进 degraded）。两向证伪：取消置未知 → 红；只丢 `pagesUnknown` 留 `totalUnknown` → 也红。
- `test-paging` 的 SKIP 分支此前漏计 `skipped`（输出里有 SKIP 行、汇总却说 0 skipped），属「计数与真实集合不符」的同一类缺陷，三处分支全部补上；总结行现在打印 `N passed, M failed, K skipped`。

## 0.5.139

- **空的那一页自己声明了失败，就不再算本侧分页回归**（门内两条红的同一根因，实测非推断）：trusttools 上游此刻 6/6 次请求都是「来源响应超时（预算 12s）」，门里因此同时红了 test-paging（`FAIL trusttools p1= 0 p2=12`）与 test-nocache（`FAIL 重试后第 2 页仍空而 total=579074 hasMore=true`）。两者缺的是同一个维度：判据只看「上游说还有货却拿到空页」，没看**那个空页自己带回来的 degraded 记录**。上游已经承认这页没给成，就不能拿它去判我们的 page/offset 算术 —— 但反过来，没有 degraded 的空页（该页成功返回却空手）仍必须 FAIL，这条绝不放宽。新增纯函数 `pagePairVerdict`（skip=空页自报失败 / judge=交既有判据 / ok=两页都有条目），test-paging 与 test-nocache 共用，判据不再两处各写一套。真值表 8 例（含「degraded 属于另一页时不豁免本页」这种容易写反的边界），两向证伪：取消自报失败豁免 → 红；去掉 ok 短路 → 红。

## 0.5.138

- **clawhub 的分类 chip 从「永远不出现」变成可用**：实测上游 browse 行根本没有 category 键（三行样本的键是 ownerHandle/slug/displayName/summary/description/topics/tags/stats/createdAt/updatedAt/latestVersion/metadata），分类的真实载体是 topics 数组（50 行样本里 38 行非空，如 ["self-improvement","context"]）；我方 mapClawHubRows 读的是 raw.category || "" → 恒空，面板由 item.category 派生的分类 chip 对 clawhub 永远不出现。新增 clawhubCategoryOf（上游真给了 category 就优先用，否则取 topics 首项并小写归一，两者皆无返回空），只用在 mapClawHubRows 体内 —— 553 行等属于 lobehub/trusttools 的映射保留 raw.category，因为那些源的上游行真有该字段，全文件一刀切禁止会误杀。判据范围锁在函数体内（blockEnd 定界）。离线直打真实上游：browse 24 条中 7 条有分类，面板可派生 7 个分类。search 端点行既无 topics 也无 category（实测 21 键）→ 仍为空，这是事实而不是缺陷，因此不编造分类。
- **分类过滤保留的「无分类信息条目」现在如实计数**：本地过滤的语义是「无分类或匹配才保留」—— 没有分类信息的条目被保留（严格过滤会让不提供分类的源整源消失，那是数据丢失而不是过滤），但界面上从没说这件事：实测选 douyin 返回 18 条，其中 17 条并非 douyin。修法不是改过滤语义，而是把保留量写进 categoryNote（另有 N 项该源未标注分类，按「无分类不过滤」一并保留），N=0 时不写。真值表含边界：本页全无分类时 filteredOut=0（旧写法一条说明都不给）同样必须告知。两向证伪：把保留量恒置 0 → 红；把 note 措辞保留但丢掉具体数字 → 也红（判据要的是数字，不是关键词）。
- test-clawhub-quality 从 30 项增至 48 项。

## 0.5.137

- **卡片不再显示被复制出来的安装数（客户端拦，live 可验证）**：装上 0.5.136 后 live 实测 clawhub 每张卡都是「283,509 次安装 · 283,509 次下载」，而上游同一行是 downloads=283,509 / installs=12,282 —— 复制来自仍在运行的旧服务进程（0.5.134 已在服务端把两个字段各取各的，宿主永不重启意味着那份代码还没被加载）。既然实测真实数据里两字段永不相等，卡片上相等就只能来自复制：客户端新增 `visibleCounts` 同源判据（installs 与 downloads 同为非零且相等 → 安装数不显示），「有值才显示、0/缺失不显示」的原规则保留；详情弹层的显示条件与渲染两处同判据（只改其一会出现「区域显示但内容为空」）。真值表 6 例 + 两向证伪（去掉相等判据被抓、连带抹掉下载数也被抓），test-clawhub-quality 共 30 项。
- **卡片计数的文本锁按真形升级（不是放宽）**：接线 visibleCounts 后 test-search-fanout-latency 两条锁立刻变红（`FAIL 下载数一条且带真值守卫与千分位`、`FAIL 安装数同样有真值守卫`）—— 这正是它们该做的事。原锁只匹配 `item.installs ? h('span'`，无法区分「包了一层守卫」和「压根没包」；现在拆成三条：技能卡下载数过同源守卫、技能卡安装数过同源守卫、MCP 卡安装数仍是直接守卫（那一侧没有 downloads 兄弟字段可比）。检查数 185 → 188。

## 0.5.136

- **空页不再被说成「目录已到底」**（同一轮门内实测的第二处不诚实）：trusttools 在门里出现过一次首页静默空响应（items=0、degraded=0、total=0），handler 的 `hasMore` 当时退化成 `items.length >= size` = false，聚合层于是对外宣称「已是最后一页」—— 一次抓取失败被说成整个目录只有这一屏，比谎报总数更误导（用户会以为源已穷尽、不再翻页）。现在 `false` 只有在响应带真实总数证据时才是结论，否则保持 `undefined`（未知），分页器继续显示「可继续加载」。
- **上游状态 vs 本侧回归的判定收敛成一个 helper**：新增 `emptyWithoutEvidence`（degraded>0 / total>0 / hasMore===true 都算有证据，三者皆无才算上游静默空响应）。test-nocache 与 test-paging 之前各写一套相近判据 —— 两套判据互相打架正是假绿来源，现在两处调用同一函数；真值表 6 例进 test-paging-verdict（含反向破坏：写成恒 true 一律当上游问题，就会被 total>0 却空页那例抓到）。修复后 test-paging 13 passed（旧行为下同一场景判 FAIL —— 门里红、单跑三次绿的那种 flake 消失），test-nocache 13 passed / 1 skipped。

- **聚合层两处「骗绿」路径（clawhub 无界流触发的主路径，行为断言 + 四条反向证伪）**：
  ① **handler 声明未知总数却被谎报成随页增长**：clawhub browse 是 cursor 无界流，handler 明确把 total/totalPages 置 undefined 表示「未知」（extra-sources.js:253-260 注释原话：谎报下界会让用户以为目录就这么大）；聚合层却把 undefined 当「没报总数」，兜底成 p*size+1 —— 实测 page=1 报 13、page=60 报 721，一个几千条的目录显示成「共约 13 个」。现在区分两种情形：「没报」（total=0）仍反推下界，Test 13 契约原样保留；「显式未知」（total=undefined）保持未知一路到底 —— 聚合层 reportedTotal=undefined，client 里四处把未知冒充成本页条数的 `|| rows.length` 一并清除，pagerSummary 对 total<=0 本就不渲染数量子句。**红→绿原文**：`FAIL 显式未知的 total 不随页码增长 13,25,37,721` → OK。
  ② **单源结果被二次 localeCompare 重排**：extra-sources.js:223 的既有契约写着「单源排序责任在 handler，dispatcher 只对多源聚合排序」，但 sources.js:599-604 无条件执行，且判据用原始 sort 而不是 effectiveSort —— 实测上游 sort=name 是码位序（Zeta,alpha,beta…），被重排成 alpha,beta…,Zeta；supportsSort 为假时（557 行注释承诺「降级为不排序，保持上游顺序」）也照排不误。现在 `aggregateSort = wanted.length > 1 ? effectiveSort : ""`：多源聚合仍本地排（Test 5 注入三个 handler 验证降序），单源与降级路径保持上游序。**红→绿原文**：`FAIL 单源 name 排序保持上游（码位）顺序 got alpha,beta,iota,omega,Zeta` → OK。
  证伪四条（把修复逐一反向破坏，必须变红）：①取消未知保持、②单源也二次重排且用原始 sort、③不记录显式未知标记、④客户端把未知冒充本页条数 —— 全部被抓，恢复后两文件字节一致。新增 test-clawhub-quality.mjs（15 项；Test 2 复述既有 Test 13 契约，避免两套语义相近判据互相打架；Test 6 锁 client 四处冒充），门 56 → 57 套件。
- **test-full-sort Test 5 的单采样比较改双采样基线**：旧判据「两次独立上游请求逐条同序」本身依赖上游不漂 —— 本轮门里一次红（`26 passed, 1 failed`，失败标签 `installCount 被降级为不排序`）、单跑三次全绿，正是这种抖动。现在 `sort=''` 的基线采两次：两次不同则 SKIP（上游序自身在漂，降级正确性无从判定），一致才比较，并补「a 与基线条目集合一致」断言，防止 sort 悄悄走了另一条取数分支。判据是结构性质（双采样是否自洽），不是阈值。

## 0.5.135

- **「质量」按钮不再是个永远点不动的假可控件（用户指出的 live 可见缺陷）**：宿主永不重启，运行中的服务进程是旧 `index.js`，里面永远没有 `skillhub.evaluation`（v0.5.131→v0.5.134 逐字节比对确认这是唯一新增 op，其余 31 个 client 调用的 op 都在）。于是列表里每个 skillhub 卡片都挂着一个点一次必失败一次的按钮。修法是**运行时判别**而不是看版本号：`isUnknownOperation` 认服务端 switch default 的 `unknown operation` 文案，`probeOpPresent` 用一次「明知参数不合法」的调用探测（新进程在参数校验阶段就返回，实测 <30ms 且不打上游；旧进程落到 default），结果存进 `opStatus`，入口只在 `opStatus['skillhub.evaluation'] === true` 时才渲染；探测本身失败 → 空清单，所有可选入口一律不画。`OPTIONAL_OPS` 是通用清单，后续任何依赖服务端 op 的入口共用同一机制，同类问题不会在别处再长出来。**证伪两轮**（Test 5 削弱判据后 op 被误判存在、Test 4 门控从 ===true 放宽成 !==false 都变红）。离线证据链已确证 profile 内 0.5.135 的 `index.js` 确有该 case，故一旦进程重载即自动生效。
- **跳页拒绝从静默改为可见**：`pageJumpTarget` 对越界/非法/同页一律返回 0，界面清空输入框、页面不动、零反馈——9736 页这种量级必然踩到，而用户无法区分「被拒绝」和「已经跳了」。现在拆成 `pageJumpOutcome` 返回 `{ page, reason }`，回车与失焦共用同一个 `applyJump` 入口（判定在 pager 里只出现一次，不可能再各写各的 clamp），三类拒绝各有文案：请输入有效页码 / 超出范围：共 N 页 / 已在第 N 页。
- **同条件在途请求去重**：连按两次回车或搜索按钮会各打一次上游（等待翻倍、结果同形）。新增 `shouldSkipInflight`，技能与 MCP 各自一个 Set。**顺序是关键**：必须在取序号之前判定——若先 `++seq` 再跳过，这次被跳过的请求会把真正在途的那次标成「已过期」，其结果反而被丢弃，去重就变成了丢结果（这条单独有证伪锁 ⑤）。`append`（加载更多）的 cacheKey 是空串，永不参与去重。
- **MCP 缓存补上 hasMore（双侧口径对齐复查的产出）**：技能侧缓存写入带 `hasMore` 且命中时 `setSkillsHasMore(Boolean(cached.hasMore))`，MCP 侧两处都没有。registry 是 cursor 型（没有总页数），hasMore 是「下一页」能否点的唯一信号，缺了它切源再切回时按钮停在另一个源的值上。顺带把两处判定抽成 `mcpMore` 共用，缓存与实时不再是各写各的。
- **卡片数字统一 Number 化**：技能卡的 `item.installs.toLocaleString()` 是同排四处里唯一没包 `Number()` 的（downloads/stars/MCP 卡 installs 都包了）。上游若回字符串数字，String 没有 `toLocaleString` → 整张卡渲染抛错。另删掉一处恒为 null 的死渲染 `item.describedBy === 'page-meta' ? null : null,`。
- **写文件机制补上「逃逸可审计」（用户指出）**：`applyOps` 的结构锚保护默认 throw，调用方可逐条显式 `allowStructuralLoss: true` 放行——但口子必须能被审计：现在 `forced` 由 applyOps 返回、由 `runOpsFile` 逐条写回 ops 条目，`test-edit-lib` Test 6 锁「带 flag 才放行且 forced 计数」「不带 flag 默认路径仍 throw」，Test 7 更进一步静态扫描 `test/`+`src/`，只要出现未申报的 `allowStructuralLoss: true` 就红（期望值恒为 0，非 0 必须在交付说明里逐条列出是哪条 op、为什么）。applier 本身也已从 `patchFile` 改走 `applyOps`——此前那条路径**根本没进守卫**（⑤ 删掉 `const p = …` 没被拦就是这个原因），现在默认全部经过结构锚保护。
- 新增 `test-op-availability.mjs`（15 项）与 `test-ux-honesty.mjs`（27 项），门从 53 套件增至 56。既有 `test-search-fanout-latency` 的两处 stub 跟着重构更新：Test 8 只 slice `pageJumpTarget` 会 ReferenceError（它现在从 outcome 派生），改为从更靠前的定义处一起 slice；Test 14/14b 的行为驱动 stub 注入 `shouldSkipInflight`/`inflightRef`，且注入的是**从 client.js 取的真实实现**，不是测试里另写一份（另写一份等于测测试自己的假设）。
- **nocache 的两条「外部状态」判据抽成纯函数并被真值表钉死（上游真坏过一次才暴露）**：test-nocache 直打真实上游，本轮实测两类外部状态——skillhub 默认榜（不带 sortBy）自身在重排（同一请求首条在 icon-design 与 govwriter-pro 之间漂移，跨页重叠一次 2、一次 7；同时刻背靠背取第 1 页前 12 位完全相同，说明是榜顺序在变而不是我们把 page 传错），以及 trusttools 一次 p1=12 / p2=0（复测三次都 12/12）。原判据把两者都算代码回归，门会随上游心情 flake；简单放宽又等于永久掩盖真分页回归。现在判定抽到 `test/paging-verdict.mjs`（`overlapVerdict` + `emptyPageAction`，只给测试用的纯函数）：整页重复（page 被忽略）**永远 FAIL**；空第 2 页允许重试一次，重试后仍空 **FAIL**；只有 skillhub 的部分重叠且实测「显式排序路径 overlap=0」才 SKIP，并把依据写进日志。新增 `test-paging-verdict.mjs`（21 项）零网络钉死每条边界——包括 `sortedOverlap` 缺失时不得当作 0 放行、其它源不得蹭 skillhub 的口子。判据不内联进套件，是因为内联一份等于测「测试自己的假设」：上游恰好不坏时那条 SKIP 分支根本没人验证过。
- **temp-hygiene 的漏检面补实（三种注入形态全部证伪）**：旧守卫只有一个正则，只认 `os.tmpdir()`；实测对 `import { tmpdir }` + 裸 `tmpdir()` 两种写法 **MISS** —— 而 test-paging / test-features / test-new-features 历史上用的正是后者（6 处裸调用，含 `makeCache(tmpdir())` 与 4 处 `mkdtemp(join(tmpdir(),…))`）。守卫换成两条子串规则（非注释行含 `tmpdir(` 或 `tmpdir }` 即红，注释行豁免防自指），三个套件全部迁到 `safeTempDir()`。端到端证伪：具名 import+裸调用 / 仅 os.tmpdir() / 仅具名 import 未调用 —— 三种形态注入后守卫 exit=1 全抓，恢复后绿。**「迁移已完成」不再靠记忆，靠能抓回归的守卫。**
- **applyOps 新增作用域感知的重复声明守卫（`assertNoDupDecl`）**：本轮两起真实事故都是「块替换后同一作用域两个同名 const」——一次 g1 块插了两遍（`Identifier 'GLOBAL_SORT_KEY' has already been declared`），一次 nocache 新段自带 `const overlap` 而旧声明行还留着（needle 只看锚行，不看替换后文件能否加载，两次 applyOps 校验全过）。第一版我写成全局计数，实测**误伤**合法代码（各 Test 块各自 `const out = []` 不同作用域完全正常，误伤的守卫会被人为拆掉，比没有更糟）；最终版维护花括号栈（跳过字符串/模板/注释，与 blockEnd 同一套字符级判定），作用域签名相同才算重复，且只报**本次编辑新增**的。证伪：注入同作用域重复 → 抓到且文件未被改写；不同作用域同名 → 不误伤（applied=1）。
- **自指守卫（anchor-lib Test 9）**：Test 8 第一版想锁「白名单只有两项」，判据字面量写在自己体内 → self 必然命中 2 次 → 守卫把自己判红；随手改成 >=2 又变永真假绿。这类「lint 自身扫到 lint」可以静态查出来：扫「读自身源码的套件」，凡以该 self 变量为接收者的 indexOf/split 字面量在本文件出现 ≥2 次即 FAIL。范围经过实测收窄（全仓扫所有 indexOf 字面量会把 patchFile 的夹具字符串 `inserted 1`/`const A = 1;` 也算进来 —— 113 处误伤/29 文件，那是测试数据不是扫自身的判据）；当前自读型套件数=1。
- **test-paging 的魔法阈值删除**：旧判据「overlap 恰好 1 条且落在边界才算上游漂移」，本轮实测 skillhub 默认榜重叠一次 2、一次 7（同一请求首条在 icon-design / govwriter-pro 间漂移），阈值 1 把上游重排判成本仓库回归 —— gate14 里 test-paging 变红的正是这条，不是代码回退。现在与 test-nocache 共用 `overlapVerdict`/`emptyPageAction`：整页重复永远 fail（page 被忽略是我们的回归）、空第 2 页只重试一次且重试后仍空 fail、仅 skillhub 的部分重叠且实测显式排序路径干净才 skip。nocache 里加了**端到端证伪**：用 `handlers` 注入「无视 page、第 2 页返回同一批」的假源（overlap=12）→ 判 fail；非 skillhub 的部分重叠 → fail；重试后仍空 → fail。自证判据不再是只能靠上游恰好坏一次来验证的东西。
- **事故记录与纪律（如实）**：本轮我再次绕过机制手搓补丁脚本改 test-temp-hygiene —— 该文件是纯 LF，脚本用 CRLF split 把整个文件当 1 行，锚点在「那一行」里全部命中，splice 覆盖全文。`git checkout HEAD --` 恢复（该文件本轮无其它未提交改动，零损失），随后改用 applyOps（EOL 无关）一次成功。纪律收口：**改仓库文件一律走 applyOps/patchFile，不再手搓补丁脚本** —— applyOps 的幂等/结构锚/重复声明三层校验正是为这类手搓事故准备的。
## 0.5.134

- **乱序落地守卫（结果正确性，不只是速度）**：client.js 此前没有任何请求序号——快速切源时先发的慢请求后落地，会把后发请求的结果**整段覆盖**，列表与用户最后选择的源/页不符。现在每次请求取序号、回来后若已被超车就丢弃（连缓存也不写：过期结果进缓存会让下次命中显示旧数据还标成「缓存」）；catch/finally 同样按序号收口，过期请求的报错不再盖掉新结果、spinner 只由最后一次请求关闭。技能与 MCP 用**两个独立计数器**（切 tab 的那次请求不该抹掉另一侧的结果）。Test 14/14b 用「先发 40ms + 后发 5ms」的行为测试锁住；改前实测落地顺序是 `skillsmp#p2 → clawhub#p1`（后发的结果被先发的盖掉）。
- **分页默认口径统一**：`skillsTotalPages` 默认 1 而 `mcpTotalPages` 默认 0，同一字段两种语义——技能侧在首个响应到来前显示「第 1 / 1 页」，等于凭空宣称已知总页数。pager 里 `unknown = !totalPages`，所以统一默认为 0（未知）。Test 15 同时锁页码/总数/hasMore 三族状态的默认值成对一致。
- **市场卡片分批渲染**：沿用工具浮窗已有形态（`CARD_BATCH=60` + 游标 +「继续显示 N 个」）。此前一次提交整页卡片（每页最多 48 条，聚合页更宽）；`shownCards(list, batch)` 是纯函数，首批≤阈值、按批单调、批够时覆盖全集、不足一批不误裁、空列表仍为空——空态判定继续只看服务端整页 `d.items`，不会因为裁切渲染列表而误报「没有找到」。
- **gotoPage 显式带全部条件**：旧写法技能侧漏 `category`/`sort`、MCP 侧只传 `page`（漏 `source`/`category`/`sort`），全靠 `liveRef` 兜底；兜底取值与界面不一致时（state 更新竞态）翻页会**静默换条件**。现在两侧都显式传当前值，Test 17 断言的是实参值而不只是键存在。
- **SkillHub 新增「按下载数」+ 卡片显示下载数（用户 2026-11-21 拍板）**：上游 `sortBy=installs` 与 `sortBy=downloads` 都有效且跨页单调，榜首不同（installs→self-improving-agent、downloads→dev-god）；而 installs 覆盖率仅 18/60，只给「按安装数」时多数卡片没有依据可核验。`downloadCount` 现为独立能力键，`order` 显式写出；卡片安装数与下载数**都显示、有值才显示、0/缺失不显示**。
- **各源排序名称与真实字段一致（决定二，含一处数据错误）**：实测 clawhub 同一行 `stats.downloads=494,474` 与 `stats.installs=18,549` 相差 26 倍，而 `extra-sources.js` 把 installs 与 downloads **都写成 downloads** —— 卡片「N 次安装」显示的是下载数（与 skillhub 同类，skillhub 已在 0.5.133 修）。整改覆盖全部线路：clawhub installs 改读真实 installs（缺失保持 0、不回落 downloads）、browse 与 search 的排序键改名 `downloadCount`（其可排字段确实是下载数）、modelscope 同理（上游只有 `DownloadCount`，无安装量列 → `installs: 0`，不再冒充）、trusttools 去掉 `|| raw.download_count` 冒充并补出真实 `downloads`、browse.sh 去掉 `?? raw.downloads` 回落（该源 `installCount` 是真安装数，保留 `installCount` 键）。能力矩阵 clawhub/modelscope 由 `installCount` 改挂 `downloadCount`，skillhub 两键并存；`sort-capability.js` 注释写明「名称→真实字段」并纠正旧的 downloads/installs 推断。Test 18 是零网络交叉表（8 个技能源 + 2 个 MCP 市场：UI 标签 ↔ 能力键 ↔ 实际透传/本地字段三者一致）。
- **SkillHub 质量评测接入已有详情弹层（用户已定落点）**：`evaluation` 端点实测单次 1~2.1s、5 维度 15 子项；若进列表卡片每页要多 24 次请求（串行≈50.6s），直接抵消本轮「减少等待」——因此只在点开时发 1 次请求，列表零额外请求。诚实处理 envelope：v1 端点响应是裸对象、**没有 `code` 字段**，新增 `getJsonV1()` 不校验 code（照抄列表侧的 `getJson` 会把 200 的成功响应判成错误，categories 当年就撞在封装差异上）；只摊平上游给的维度说明与子项分数，**不合成上游没给的总分**；不可达时显式告知「SkillHub 质量评测暂不可达」，不用 downloads/stars 凑一个「质量」。
- **测试与写文件机制**：新增 `test/edit-lib.mjs`（锚唯一 + 行数变化 + EOL 不混用三重校验，先写临时文件、校验通过才 rename，throw 时原文件不动）与 `test/test-edit-lib.mjs`（18 项，含证伪）；`anchor-lib` 增 `blockEnd()`（按花括号深度定位块尾，取代我两次删出半截函数的「扫到第一个 `}`」写法）。手写插入脚本的笔误本轮又复发多次，这是把纪律做成机制而非依赖下次注意。另新增 `test-gate-contract`（闸门契约自身可证伪）与 `test-suite-inventory`（清单无重复/无静默游离/仓库根零临时件）。基线 51 → **53 套件**。


## 0.5.133

- **SKILLHub 来源的四项口径修正（全部由真实上游取证确证，行为测试锁进 CI）**
  - **安装数不再被下载数覆盖**：`toItem` 旧写法 `installs = downloads`，而上游 installs 与 downloads 是两个字段（实测 self-improving-agent installs=86,140 / downloads=1,736,606）。于是卡片「· N 次安装」显示的是下载数（差 20 倍）。现各取各的；上游 installs 缺失或为 0 时**保持 0 不回落到 downloads**（60 条样本里 50 条 installs 为 0，面板对 0 不显示该段 —— 宁可不显示也不显示错数）。
  - **「按安装数」真的按安装数排**：旧映射 `installCount → sortBy=downloads`，用户点安装数拿到的是下载榜（实测两榜首条不同：installs→self-improving-agent，downloads→dev-god）。现映射到 `sortBy=installs` 并显式带 `order=desc`。`updated` 同步改为上游文档字段名 `updated_at`。`name` 保持本地排（实测 `sortBy=name` 上游返回 code:400）。
  - **关键词搜索此前一直无效**：传的是 `q`，上游只认 `keyword`。实测 `q=pdf` 返回 total=233,498（≈全量 233,498，等于没搜），`keyword=pdf` 返回 5,614，且返回条目里 10 条有 8 条名称/描述真含 pdf。因为它仍返回「一堆条目」，界面上看着像搜索成功 —— 这类静默失效比报错更难发现。
  - **删除 `categories()` 死导出**：它请求 `/api/skills/categories`（实测 405 Method Not Allowed），且全仓无任何调用方（面板分类 chip 来自当前页条目的 `category`，client.js:1563；`test-dead-exports` 47/47 通过亦证无引用方）。真实端点是 `/api/v1/categories`（13 个一级分类），但其响应是 `{count,items}`、**没有 `code` 字段**，不能走现有 `getJson`（要求 `code===0`）。因此不做半吊子接入、也不用别的字段凑分类 —— 代码里留注释说明将来接入需要另开不校验 code 的取数路径。
  - `test-full-sort` 里一条把 bug 症状当期望的旧断言已纠正：它要求「skillhub 按安装数首条 > 1,000,000」，那个 12,105,711 是 dev-god 的**下载数**（即旧映射错误的产物）。我先换成「全盘首条 ≫ 未排序窗口 max」的相对判据，实测它自己也会漂（未排序按 updated_at 排，高安装数条目刚被更新就进窗口：top=86,140 对 窗口max=57,561），已撤掉 —— 「排的是全量而非窗口」由 globalSortCheck 的结构性质证明（组内单调 + 跨页 p1min≥p2max），只保留一条 installs 字段非空的确定性 sanity。连续两次运行 exit 0。
- **新增 `test-skillhub-source.mjs`（20 项）**：用 fetch 桩断言 URL 参数与字段取值，零真实网络，锁住上面四条（含「installs=0 不得回落 downloads」「q 不再出现」「sortBy=downloads 不再出现」这类反向锁）。
- **测试基建（`d390b05`）**：否定断言的子串冒充面系统性收口 —— anchor-lib 新增 `absent()`（只认非标识符字符包围的独立出现），六个套件的纯标识符否定断言全部改用；`test-anchor-lib` Test 7 是常驻守卫（扫描所有套件的裸 `!x.includes('plainId')`），其排除规则（数组成员判定、`!` 挂在别的子表达式上）各配一条自证样例，防止守卫空转；证伪双向通过（注入 `windowedIn` 不误红、重新引入裸 includes 立刻变红）。`test-suite-inventory` Test 4 检查工作树无未跟踪点文件 + `.gitignore` 加宽兜底（这条守卫上线当场就抓到了我自己留下的两个探针文件）。
- **基线**：套件数 51 → **52**（新增 skillhub 来源套件）；`[GATE] 52 suites`，CI 为权威。

## 0.5.132
- **applier 机制化（本轮返工的根因收口，不是手工补一次）**：门曾红到 43/53，其中两处是**写文件工具自己产出的破坏**——ops 表里已应用的条目不回写状态，重放时同一个块插了两遍（重复 const 声明）；另一条 span 把 `const CAPABILITIES = {` 整行吃掉。两者都静默发生（语法合法的那次要靠读 diff 才发现）。现在 `edit-lib.mjs` 提供 `applyOps`（幂等：needle 消失且块恰好出现一次即 skip，同一 ops 连跑两次字节必须一致；结构锚保护：span 覆盖到的 const/let/function/export/class 行若未被块原样回归就 throw，needle 自身那行豁免；needle 0 命中且块不在也 throw——静默错位比报错危险）与 `runOpsFile`（一次性消费：应用成功回写 `done:true`，ops 文件不再是每次重放的脚本）。`test-edit-lib` Test 6 把两条机制**真跑证伪**（32 项全过：二次应用 skipped=1 且字节一致、span 吃结构锚 throw 且文件不动、非法 side throw）；`test-suite-inventory` 新增 Test 5「辅助模块必须有可执行断言覆盖」（edit-lib/anchor-lib/gate-verdict/run-gate 都必须被至少一个套件引用或执行——无断言的工具就是假绿风险）。
- **op 清单单源化（修 ①）**：`skillhub.evaluation` 登记后三个套件各自抄的白名单副本同时假红。现在 test-manage-panel / test-install-progress / test-skill-subpanel-ui 的 known 集合直接从 index.js 的 `case "…":` 标签提取，并先断言提取规模与核心 op 存在（提取失效会变成「所有 op 都未知」的全面假红，必须自证）。
- **op 白名单从「三处副本」收敛为单一事实源（修 ①，并升级四处防漂移锁）**：三个套件各自抄一份 known Set，登记新 op 得同步三处，漏一处即假红（skillhub.evaluation 上线时同时撞红三条）。现在 known 一律从 index.js 的 case 标签派生，并先断言提取规模与核心 op 存在（提取失效会变成「所有 op 都未知」的全面假红）。原先检查「每份副本里是否有 mcp.probe」的四处锁（mcp-panel-p0 / mcp-status-p1 / mcp-tool-deny / mcp-raw-edit）随之失去对象，已升级为断言**更强的性质**：登记处唯一 + 派生声明形态存在 + known 真的指向派生集合 + 任何套件不许再写回硬编码清单副本。证伪两轮：第一轮 ② 漏网（t.includes('IX_OPS') 会被任何提及骗过——改名 IX_DISABLED 后残留字样仍判真），补成断言声明形态与指向后 ②⑤ 全被抓到（连跑两次字节一致）。
- **CHANGELOG 混用行尾修复（守卫当场抓到我自己）**：bump 脚本插入的内容是 LF，落进 CRLF 的 CHANGELOG 造成 24 处 loneLF；上一版核验脚本故意排除 CHANGELOG 所以没拦住。已按行 split/join 归一（内容与行数零改动），并把 CHANGELOG.md、package.json 纳入 Test 12 的行尾守卫 —— 判据是「不许混用」而不是「必须 CRLF」，所以纯 LF 的 package.json 也照样通过。
- **名称↔字段交叉表落地（修 ②，含一处我自己归因错的注释）**：clawhub/modelscope 的能力键改 `downloadCount`，getter、browse 透传、`MODELSCOPE_FULL_SORT_KEYS`（全量排分派表，不改这里 downloadCount 会退回单页分支——正是 sort-server 头部写的缺陷2形态）、MATRIX 抄本改从能力表同源读取、UI 断言一起改。clawhub 绝对值段此前读 `vals()`（installs）拿到 18,549，改读 downloads 后实测榜首 494,474；我曾把 12.1M 的 dev-god 误归为 clawhub 榜首——那是 **skillhub** 的下载榜，clawhub 的下载榜首是 self-improving-agent（注释已按实测改写，阈值 400,000 本来成立，错的一直是字段）。sort-capability.js 注释写明「名称→真实字段」与 installs 跨页不单调的证据（实测 p1min=0 < p2max=892）。
- **守卫抓自己人（修 ③）**：test-temp-hygiene 抓到 test-edit-lib 裸 `os.tmpdir()`（改 safeTempDir 并删死导入 os）；anchor-lib 的否定断言守卫抓到 Test 18 交叉表里三处 `!array.includes('identifier')`——那是数组成员判定（无子串冒充面），按守卫口径显式改 `indexOf(...) === -1`，并在注释写明为什么不是削弱守卫。

- **搜索/排序/分类等待时间收敛（本轮主项；全部行为锁进 CI）**
  - **聚合搜索串行改并发（`fanOutSources`，src/sources.js）**：原 `for (await handler)` 串行让总耗时等于各源之和，一个不可达源（trusttools 实测 >20s）拖死整次搜索（实测聚合 >20s 超时拿不到结果）。并发后总耗时 ≈ 最慢单源；同构负载实测串行 48.1s → 并发 6.0s（省 87%）。每源 12s 预算：超预算源记 degraded（写明超时），不再拖住整次；results/degraded 都按源清单顺序折叠，同一条件两次搜索列表顺序不变。`handlers` 是测试注入点：注入时 `all` 展开为注入集合，测试态零真实网络（之前 fake handler 被 8 个真实源淹没，测的还是上游当时的心情）。
  - **每页条数单一来源（`resolvePageSize`）**：cacheKey 用闭包 `size`、请求却用 `(options.size || size)` —— 键与请求不同源，改「每页条数」会拿旧尺寸的缓存冒充新尺寸。现两侧同用 `resolvePageSize`（clamp 1..60 与服务端同口径）。命名必须避开 `size`（同块作用域自引用 TDZ 白屏，实测踩过）。
  - **缓存键抽纯函数（`skillCacheKey`/`mcpCacheKey`）**：skill 键原来没有 size 维度；`all`/`''`、`default`/`''` 归一，同一视图两种写法不再算成两个缓存项（那等于同一条件重复发请求）。Test 7 锁全部维度。
  - **缓存命中恢复分页元数据**：sk 命中不再硬置第 1 页（翻页也走缓存，数据是第 3 页、分页器却显示第 1 页）；mcp 缓存补存 page/totalPages/total，切源再切回来时卡片和页数一起回来（此前卡片立刻出现、分页器停在另一个源的页数上）。
  - **live 实测**：搜索 pdf 请求增量恰 1（一次真实搜索）；同条件再回车命中缓存先渲染旧结果。
- **数量口径（计数与真实集合一致）**
  - **分页摘要接真实数据（`pagerSummary`）**：live 实测「共约 第 1 / 1 页」—— 标签后面没有数字。根因：`skillsTotal` 只被 set 从未被读（useState 只写不读审计全仓唯一一处），label 是写死的字符串，标签与数据源断链。现在摘要 = `共约 N 个 · 第 x/y 页`；0 命中不渲染数量子句；cursor 型源不编造总页数；MCP 侧 label 留空（数量由专行负责，同一数字不显示两次）。
  - **不可达源的 total 不得随页码虚高**：trusttools 每页超时（items=0、total=0）时 total 竟随页涨成 12/24 —— 反推兜底只在「本页有货、上游没报总数」时成立，items=0 时补数就是凭空造数。Test 13 证伪时精确重现了原始数据（0→12→24）。
  - **P4 过滤后计数重算**：本地分类过滤只作用于当前页，继续报过滤前的 total/pages 就是与实际不符的计数。现 total/pages 按可见集合重算，`filteredOut` 如实暴露，并说明是本地过滤。
- **翻页边界与条件完整性**：跳页抽 `pageJumpTarget`（回车与失焦以前各写各的 clamp——回车拒绝越界、失焦却放行，同一数字两种结果；现共用一份，等于当前页也不重复请求）；排序切换不再显式传空查询词（搜过 pdf 再改排序，列表退回全量而搜索框里 pdf 还在）；技能分类 chip 不再是死控件（只 setCategory 高亮，列表不动——用户以为筛过了其实没有）。
- **死代码清理**：pager 的 `shown` 只声明从不使用、`windowed` 参数在 pageWindow 抽出后无人读取，均已移除；分页窗口抽 `pageWindow` 纯函数（首页/末页/单页/未知总数/跨度不足六类边界在 CI 里直接验证数学）。
- **测试基建**：新增 `test-search-fanout-latency.mjs`（106 项）与 `test-suite-inventory.mjs`（8 项：门内无重复、磁盘无静默游离、无幽灵登记）。6 个此前游离在门外的套件（features/new-features/nocache/paging/warmup/inventory）全部登记进 test:chain——**真实基线从 44 提升到 51 套件（含闸门契约套件）**。`test-nocache` 区分外部状态：上游不可达记 SKIP（trusttools 宕机不再伪装成代码回归）。查 `dup=true` 时发现我自己的统计 bug（`new Set(list).length` 是 undefined，不等式恒真——正确写法 `.size`），已写成 inventory 守卫防再犯。
- **run-gate 契约补齐（CI 首跑 5 红的两类根因，都是我的错）**：
  - 我把 Test 12 写成「交付文件必须 CRLF」——`core.autocrlf` 在 Windows 是 true、在 Linux CI 是 false，同一 blob checkout 出来一边全 CRLF 一边全 LF，该断言在任何 Linux 上必红。改为平台中立的「不许混用行尾」，并补一条构造混合串的自测；「整体 CRLF→LF」这种事故形态在 CI 上与正常 checkout 无法区分，它由写入脚本的 EOL 自检 + throw 负责（本轮已落实）。
  - 登记那 6 个游离套件时我只验证了本地 exit 0，没验证输出符合闸门契约（最后一行必须是 `N passed, M failed`），4 个套件因此被判 NO-SUMMARY。修法是让套件符合契约而不是削弱闸门：features/new-features 在中文总结后补英文总结与规范 exit；nocache/paging 加 checks 计数（paging 的判定点数由运行计数得出，不硬编码——上一版我按代码里 `failures += 1` 出现 7 次写死 checks=7，而循环那一处实际执行 8 次，真实判定点是 13 个）。SKIP 的源不计入 passed（nocache 输出 `9 passed, 0 failed, 1 skipped` 即为证）。
  - 闸门契约本身从口头约定变成可测不变量：判定抽成 test/gate-verdict.mjs 纯函数（run-gate 是唯一调用方），test/test-gate-contract.mjs（20 项）锁全部分支并用真 run-gate 证伪——无 summary 的假套件（经 DSH_GATE_EXTRA 注入）必须让门变红、越界名字与自我递归被拒、规范假套件仍绿。test-features 两个网络段包 try/catch（CI 上 npx 不可达记 SKIP 并保持规范 summary，本地已注入相同错误复现验证）；inventory 的辅助模块清单改由「被其它测试 import」自动判定（硬编码清单在新增 gate-verdict 时已腐烂过一次）。
- **验证**：离线 50/50 绿（唯一 FAIL 是 profile-sync，profile 仍 0.5.131、发布安装后转绿）；12 项语义核验全 OK；9+5+3 条证伪全部被抓（含把 client.js 整体转 LF 验证 EOL 锁生效）；Test 12 锁「交付 js 行尾不许混用」（平台中立：CI 在 Linux checkout 就是纯 LF，旧断言「必须 CRLF」在任何 Linux 上必红，已纠正；「整体 CRLF→LF」由每个写入脚本的 EOL 自检 + throw 负责，两边职责不同）；交付文件 CRLF/loneLF=0。

## 0.5.131

- **修陈旧搜索词跨连接器泄漏（假陈述）**：`openMcpTools` 只重置了 `mcpToolOpen`，没有重置 `toolQuery` / `toolBatch`。于是在连接器 A 里搜过 `click`、关掉、再打开连接器 B 时，B 的工具清单会被这个跟 B 无关的词过滤掉，而标题写着「匹配 x/y」—— 用户读到的是「B 只有这些工具」，实际是上一条搜索的残留。现在两个状态都在 `setMcpTools({` **之前**清掉（先清状态再放数据，否则有一帧会用旧词过滤新数据）。
- **排序无可见变化时不再沉默**：排序是「先排再分组」，所以当每个来源组内只剩一项时（本机实测正是这种形态：2 个技能分属 用户目录 / 插件提供 两组），切到「按名称」界面上毫无变化，用户只能猜是不是坏了。上一轮我把这个缺口说成「设计的正确表现」就交付了 —— 正确但不诚实：设计对用户不可见时，得由界面说出来。现在显示「排序没有改变可见顺序（每个来源组内只有一项）」。判据用可验证事实（`sortedInstalled.every((x, i) => x === filteredInstalled[i])` 且非 default 且列表非空），不猜「每组只有一项」这种间接原因。
- 测试：新增 `test-popover-stale-sort-honesty.mjs`（21 项，第 43 个 CI 门套件）。两条 Test 2 断言先写错过一次并当场改掉：原写法假设「判据定义」与「提示渲染」相邻，用「提示前 900 字符」当窗口，而实际两者相距 750 行，窗口里根本没有判据 —— 断言会在判据缺失时照样通过（空转）。改为分别锁判据定义（`sliceBetween` 夹出定义段）与渲染接线（整行正则），并用三条证伪实验证明它们真的有效：摘掉 `setToolQuery`/`setToolBatch` → 3 项 FAIL；判据改成恒 `false` → 3 项 FAIL；只摘渲染 → 3 项 FAIL。全部恢复后字节一致、21/21 绿。
- 过程中我自己制造并修复一次文件截断：证伪脚本原先用 pwsh stdout 读整个 client.js 再写回，stdout 被截断导致文件只剩 868 行。已 `git checkout -- client.js` 恢复（3004 行 / CRLF 完好）并重放实现；证伪改为全程在 Node 进程内读写，绝不经过 stdout。EOL 复核 CRLF=3014 / loneLF=0。
- 验证：离线 38 套件全绿；`node --check` 通过。

## 0.5.130

- **管理面板三项优化（现有功能，不新增功能；全部落在可热更新的 client.js）**
  - **工具浮窗大列表性能**：工具浮窗过去一次渲染 `mcpTools.toolDetails` 的**全部**条目（playwright-mcp 单连接器就有 22+ 个，每个是一张 card + label + 描述 + 条件 pre），搜索时**每输入一个字符都重建整棵子树**。现改为分批：默认只渲染 `TOOL_BATCH`（60）个，余量靠「继续显示 N 个（还有 M 个未显示）」增量展开；标题计数仍报「命中/全量」，用户看得见还有多少没显示；搜索词一变就把游标重置回第一批（否则游标停在上次末尾，新搜索的前几条反而看不到）。小列表（≤60）完全不截断，行为不变。
  - **已装技能排序控件**：已装技能段此前只有搜索 + 状态筛选，没有任何排序（固定「rank 分组 + 组内服务端序」），装了几十个技能后按名字找只能靠搜索。加纯前端 `sortInstalled`（默认顺序 / 按名称 / 启用优先 / 停用优先），**先排再分组**——同一来源组内的先后可控，组与组之间仍按 rank，不破坏来源层级。`default` 必须原样返回同一引用（服务端顺序本身有含义，也避免无谓拷贝）；`isOff` 未注入时退化为名称序（tie-break 设计的直接结果，不是缺陷）。持久化与「状态筛选」同一路径。
  - **折叠命中时的搜索提示**：技能筛选生效、确有命中、但命中全在折叠分组里时（`filteredInstalled.length > 0 && expandedVisible.length === 0`），旧界面只显示组头计数，用户会误判「没搜到」。加一条提示（命中项都在折叠分组里 + 「全部展开」动作）。触发条件三重与，缺一即误报或漏报。
- **anchor-lib.mjs：把「核验脚本」纳入唯一锚守卫（0.5.129 实测教训的闭环）**。上一轮我用裸 `indexOf` 手写交付核验，锚串「退出选择」在 client.js 里命中 2 次、且第一次出现在窗口起点之前 → `slice` 得到空串 → 核验误报 FALSE，而实现其实是好的。「核验脚本自己出错」比实现出错更危险：它给出的结论看起来是实测。所以抽出 `once / lineOf / countHits / sliceBetween` 为单一实现，锚不唯一（0 次 = 锚失效断言空转；>1 次 = 静默回退）一律 throw，绝不返回一个可能是空窗口的结果。`test-anchor-lib.mjs`（19 项，含对「退出选择」当年误报场景的回归锁）与三个证伪用例把它钉死；Test G 与本轮新套件都改为 import 它，消除了三份会各自漂移的拷贝。
- **修掉一处真实死循环**：`countHits` 对空 needle 在 V8 里会死循环（`'ab'.indexOf('', 3)` 被钳位返回 2 而非 -1，循环永不退出——实测把宿主 pwsh 挂到超时）。现在空 needle 显式 throw，并有回归锁。
- **两处过期断言按实测值修正**（非放宽）：`test-skill-subpanel-ui` 的回收站窗口 17000→19000（实测 `gridTemplateColumns` 距锚 17182、`formatStamp` 17708，旧窗口只差 708 字符漏检）；`test-manage-states` 的浮窗数据源锁从「`visibleTools.map` 还在」改为锁「单一数据源仍是 `visibleTools`、渲染经 `renderedTools` 分批派生、计数与无匹配提示仍读 `visibleTools`」这条链，而非某个变量名是否还被 map。
- **EOL 事故修复**：批量插入脚本用 `join("
")` 写回，把 client.js 从 CRLF 转成了 3004 个 loneLF（`core.autocrlf=true` 下工作区源文件本应 CRLF，与 index.js/src/mcp.js 同约定）。已恢复 CRLF=3004 / loneLF=0，`git diff --stat` 仍是 63 insertions 而非整文件重写，npm↔profile↔repo(HEAD blob) 逐字节比对重新 30/30 一致。
- 验证：真实 CI 门 `npm test` = 41/42 绿，唯一 RED 是 `test-profile-sync`（profile 仍 0.5.129、本轮改动未发布，发布安装后转绿——非回归）；手工 37 套件全绿；`sortInstalled` / `renderedTools` 用 `new Function` 真跑行为验证 14 项（非正则锁）。

## 0.5.129

- **修复批量条遮挡列表头控件（0.5.122 引入，本轮 live 证伪实验暴露）**：批量条是 left:0 / right:0 的**全宽**浮层，top:46 起覆盖 y≈166-206；列表头的「打开目录」（以及本轮刚加的「全部展开 / 全部折叠」）在 y=180-204，正好落在覆盖区内 —— 用户看得见却点不到。live 对照实验证实：批量模式下点「全部折叠」无效，退出批量模式同一按钮立刻生效。「打开目录」自 0.5.114 起就一直被遮，本轮新按钮让这个老缺陷显形。修法：三个按钮在批量模式下不渲染（避免假可点），折叠控制整合进批量条本身（批量条只在 batchMode 渲染，条内按钮无需再门控）。
- **测试防假绿加固**：Test F 原用 lastIndexOf 定位「打开目录」的开器（锚串带 '!batchMode' 前缀）。证伪实验（摘掉门控、语法仍合法）显示该串静默退到上一个按钮 —— 那行同样以 !batchMode 开头，于是断言仍判 PASS。改为：用唯一 title 锚回溯**任意**按钮开器（不带门控前缀），并校验开器到 title 之间不含其它按钮残留；摘门控后该断言确实自己 FAIL。
- **新增 Test G：跨套件节点锚唯一性扫描**。几十个 var.indexOf(字面量) 取节点的写法都可能同样静默回退，逐文件改造风险高于收益，改为守卫：这类锚必须在目标源文件里命中恰好 1 次（0 = 锚失效、断言空转；>1 = 存在回退面）。区分三种**不该要求唯一**的合法用法：带第三参数的哨兵、结果与 0/-1 比较的存在性（含反向）断言、模板拼接锚。两条证伪路径均实测（0 命中探针 → FAIL；8 命中探针 → FAIL；清理后恢复全绿）。
- 修掉自己的四处失误：① String.replace 把替换串里的钱符加单引号当特殊模式，两次搅坏测试文件，最终用纯数组切片重建；② 扫描器把反向断言（indexOf(x) < 0）误判为失效锚；③ 自测 needle 拼错引号位置导致假失败；④ 首次批量脚本写盘前崩溃导致部分落地、留下混合口径。
- 验证：离线 35 套件全绿；node --check 均通过。

## 0.5.128

- **管理面板三处现有功能优化（转入优化阶段的第一次交付；全部由审计取证发现，非凭印象）**
  - **A. 测试连接后刷新卡片**：`mcp.probe` 是独立实例、不写 mounted（0.5.112 起的语义，保持不变），但 probe 成功意味着真实 fiber 已发布工具，而卡片的 phase/工具数来自 `mcp.list` 缓存 —— 旧版点完「测试连接」只有 notice，卡片仍显示旧状态，要手动刷新页面。现在成功与 pending 两个分支都 `await loadInstalled()`（失败分支不刷新：什么都没变）。
  - **B. 批量口径收紧（诚实性修复，本轮最有价值的一处）**：审计发现「全选」把**折叠分组里的技能**也选进集合 —— 用户看不见它们，批量卸载却会动它们。这与 0.5.122 自己定下的原则（筛掉/隐藏的项不得参与批量）直接冲突。修复不止于全选：把 `selectedVisible` 的定义从 `filteredInstalled.filter(...)` 改为 `expandedVisible.filter(...)`，让**计数、全选、批量动作三者同一口径**（展开 + 未被筛掉）。于是「展开→选中→再折叠」的项也不再悄悄参与批量卸载。分组归属通过 `installedGrouped` 反查 `groupKeyOf` 得到，不复制 `${rank}:${label}` 公式，避免两处口径漂移。
  - **C. 全部展开 / 全部折叠**：分组多时逐个点折叠箭头繁琐。列表头加两个按钮，走 `collapseAllGroups` helper —— 刻意不直接 `setCollapsedGroups`，因为那样会漏掉 localStorage 写入（单组折叠的 `toggleGroupCollapsed` 是两者都写的），helper 保持同一持久化路径。
  - 过程中修掉两处我自己的失误并留下证据：① 首次批量脚本在写盘前崩溃导致**部分落地**，全选三处出现混合口径（`expandedVisible.length && filteredInstalled.length > 0`），逐区 dump 真实字节后统一；② 按钮插入位置错进 openDir 按钮的 props 对象内部（`find()` 从 0 开始命中了技能段的同名行），语法检查抓到，改为插入撑杆之后成为合法兄弟子元素。
  - 测试：新增 `test-manage-optimizations.mjs`（22 项，第 40 个 CI 门套件）。两条断言按真实架构修正：C 的按钮不直接触碰 `setCollapsedGroups`（走 helper 才有持久化），断言改为锁「按钮→helper→state+持久化」这条真实接线；B 补两条口径一致性锁。`test-batch-select` 的派生断言随契约升级更新（旧口径 filteredInstalled 已被更强的 expandedVisible 取代），并验证定义先于全部真实引用（397 行是注释不是引用，无 TDZ）。
  - 验证：离线 35 套件全绿；TDZ 锁通过（installedGrouped 1698 → expandedVisible 1715 → selectedVisible 1719 → 引用 2464+）。
## 0.5.127

- **MCP 添加/编辑闭环（三项审计缺陷修复；这一项到此完成）**
  - **confirm 回归（0.5.126 引入，本轮实测发现）**：面板的 `draft.command` 恒为字符串（永不为 undefined），`saveMcpEdit` 又按「存在性」写入 `patch.command`，而服务端 `needsConfirmFor` 用 `"command" in patch` 判定 —— 于是**只改 URL 的保存也被要求二次确认而必然失败**。两侧同时修：客户端改为只在值真的变化时写入（`if (commandChanged)`）；服务端按与磁盘当前定义比对判定（`needsConfirmFor(patch, current)`，current 来自 `mcp.readDefs()`，command/args 是未掩码原值，可信）。服务端是权威，所以即使客户端多发键、值没变也不会误要求确认；读不到 current 时退回保守判定（宁可多问一次）。8 个行为用例覆盖「键在值同→不确认」「值变→确认」「无 current→保守」「url/env 永不触发」「非对象不炸」。
  - **E-2 添加路径字段补齐**：`manualMcpDefinition` 与 `overrideOf` 白名单此前丢弃 cwd / toolCallTimeoutMs（headers 只走 override 分支），手动添加表单也没有这三个字段 —— 添加路径比编辑路径弱，出现「只有编辑能设的字段」。现补齐：服务端两路径同宽、浮层加「工作目录 / 超时 ms / 请求头」三块、submit 发送 headers/cwd/toolCallTimeoutMs。
  - **两步确认此前是隐形的**：按钮恒显示「保存并重连」，第一次点击静默武装并 return，用户看不出任何区别（旧断言匹配到的是注释文字，属弱锁）。现按钮文案随 `mcpConfirmArmed` 变为「确认保存（命令已改动）」，且编辑 command/args 时解除武装（确认过一次后再次改动必须重新确认），关闭抽屉重置武装态。
  - **孤立空语句清理（死代码标准）**：`saveMcpEdit` 后有一个独占一行的 `;`。git blame 定位到 `498c144`（0.5.54 移除预览功能）—— 该提交删函数时删掉了 `};` 却把 `;` 单独留下（父提交 0 处、本提交 1 处，diff 里 `-      };` 紧跟 `+;` 即证据）。它自 0.5.54 起存在于每个发布版本。已清除并补回归断言锁住「收尾是 }; 且其后不接空语句」。
  - 测试：新增 `test-mcp-edit-parity.mjs`（40 项，第 39 个 CI 门套件）。过程中修掉 6 处我自己写的断言缺陷：3 处窗口/形态（`headers,` 简写非 `headers:`、origArgs 间接比对链、函数收尾距起点 ~4000），以及 3 处因加字段把内容推远导致的窗口不足（mseg 9000→11000、confirm 321→498 改函数体切片）—— 每处都先实测偏移、确认实现字节为真，再动断言。
  - 验证：离线 34 套件全绿；10 项语义核验逐字节为真。
## 0.5.126

- **MCP 添加与编辑完全化（用户指令）；同时纠正 0.5.116 写错的安全声明**
  - **前提修正（实测，非推测）**：0.5.116 我在 CHANGELOG 里写「`mcp.update` 拒绝 command/args 关闭了一个任意命令执行面」。本轮实测：把 `command=calc.exe` 的定义直接写进定义目录，`reconcile()` 立即挂载执行 —— 任何本地进程或手动编辑磁盘都能绕过全部 UI。那条 HTTP 守卫**从来不是安全边界**，机器信任才是；它的真实价值只是防误操作。因此「完全可编辑」的正确配套不是继续假装存在边界，而是把改动放进与全插件一致的 **confirm 闸门**（删除技能、清空回收站、卸载连接器都走同一形态）：能改，但改到执行面时问一句。
  - `mcp.update`：presence 永久拒绝 → 字段级 `needsConfirmFor(patch)`（command/args 用 `in` 判定，显式置空同样算改动；纯函数，测试用 new Function 真跑 7 个用例）。未确认时报「需要二次确认（confirm:true）」。
  - `mcp.install`：手动自定义 command 同样从永久拒绝改为需 confirm；注册表安装（slug）不带 command，无需确认。`manualMcpDefinition` 的全字段能力本就存在，只是被守卫挡着。
  - `src/mcp.js update()`：env/headers 改**合并语义**（`envUnset`/`headersUnset` 显式删除），旧的整体替换会悄悄删掉用户没填的变量。
  - **数据损坏防线**：`detail()` 把 env/headers 的变量引用掩成「***（来自环境变量）」，表单原样回传就会把真实值替换成这句中文——实测确实发生（Test 4 抓到）。新增 `assertNoMaskLiteral(patch, maskLiteral)` 纯函数，在 update/rawSet **写盘之前**拦截；掩码串收敛为单一 `MASK_LITERAL` 常量（detail 生成端与校验端同源，加了三条防漂移锁）。顺带修掉我自己引入的 bug：`patch.confirm` 会把 confirm 写进定义文件且服务端读不到，改为 RPC body 顶层。
  - 编辑抽屉表单全字段可编辑：命令、参数（每行一个）、URL、传输、工作目录、超时 ms、环境变量键值行（增删）、请求头键值行；改 command/args 时保存按钮两步化（「保存并重连」→「确认执行 <命令> 并添加」）。旧的「面板不开放改写」只读提示与孤立 `;` 一并清除。
  - **E-2 手动添加**：MCP 子面板工具行新增「＋ 手动添加」，全字段浮层（serverName/显示名/描述/命令/参数/URL/环境变量），自定义命令两步确认，文案如实写明「启动命令会在本机执行」。
  - 测试：`test-mcp-command-guard.mjs` 按新契约重写（42 项，含 7 个 needsConfirmFor 行为用例、5 个掩码用例、3 条防漂移锁）；`test-mcp-raw-edit.mjs` 旧「永久拒绝」断言反转为新契约（49 项）；新增 `test-mcp-full-edit.mjs`（47 项，第 38 个 CI 门套件）。过程中修掉 4 处我写的断言窗口/转义错误（321 字符实测、双反斜杠失配等），以及一次浮层插入层级错误（用括号深度扫描器定位到 d9 容器 children 层）。
  - 验证：离线 33 套件全绿（含死代码标准：MASK_LITERAL 从「零引用导出」修成 detail 的单一数据源）。
## 0.5.125

- **MCP 定义原文编辑（差距清单兜底项；本轮已补齐连带修复与全量回归）**
  - `mcp.raw.get` / `mcp.raw.set` 两个 op + `src/mcp.js` 的 rawGet/rawSet。表单覆盖不到的字段（toolCallTimeoutMs、reconnect、cwd、用户手写任意键）从此可编辑。
  - 三个设计决策由测试锁死：**diff 而非 presence**（原文必然含 command，照搬 update 的 presence 判据会误拒只改标题的编辑）；**保字节写回**（不走 save() 规范化，键序/未知字段/缩进原样保留）；**hasSecrets 明文警告**（detail 把 env 掩成「***（来自环境变量）」，原文视图必然暴露真实值，UI 默认不自动加载、显式点开才读）。
  - 「保存成功」与「连接成功」分开报告（`saved` / `connected`/`connectError`）：原文可以合法但连不上，此时不回滚、不抛错、不谎称已重连。重连失败不回滚文件由测试锁住。
  - UI：编辑抽屉内「原文」按钮 → 原文 textarea（等宽字体、filePath 显示、dirty 门控保存按钮）；关闭抽屉/切换连接器自动清空原文态；错误就地显示。
  - `mcp.raw.set` 进 DESTRUCTIVE_OPS（confirm 闸门）；`rawGet`/`rawSet` 排在 status 前、导出列表追加；`writeFile` 补进 fs/promises 导入。
  - 连带修复：test-skill-subpanel-ui 的 known Set 补两个新 op；test-manage-states / test-fiber-state 的导出断言从「锁死尾部顺序」改为「存在 broken 即可」（导出列表会随功能增长，锁死顺序等于每次加功能都要改测试）。
  - 测试：`test-mcp-raw-edit.mjs` 49 项（第 37 个 CI 门套件）；离线 32 套件全绿。
## 0.5.124

- **窄屏自适应（差距清单最后一项可独立落地的布局项）**
  - 现状实测：client.js 完全没有窄屏处理（无 ResizeObserver / matchMedia / innerWidth），而技能工具行（input minWidth120 + select 96 + 按钮×2 ≈ 420px）、批量条（6 控件 ≈ 400px）、回收站头、确认按钮组都写死 `flexWrap:'nowrap'` —— 宿主左侧会话栏展开或手机远控时这些行横向溢出裁切。
  - 双层判据（照抄参照 Issue #71 的结构，因为「窗口宽 ≠ 面板宽」是物理事实：面板挂在宿主主区里，900–1100px 窗口下面板可能只有 ~650px，只按窗口判断会漏）：视口 `matchMedia('(max-width:820px)')` 供首帧直接用（不闪一下），面板宽由 `ResizeObserver` 事后校准（阈值 560 = 工具行 ~420px + 滚动条与内边距余量）。`narrow = narrowViewport || narrowPanel`。
  - 降级路径：无 `matchMedia` → 视口判据返回 false 不崩；无 `ResizeObserver` → 面板宽只测一次，视口判据兜后续变化（守卫内显式再读一次 clientWidth）。这是已知边界，注释写明「宿主侧栏拖拽不跟」，不假装全能。
  - 只条件化真正会溢出的四处（工具行 / 批量条容器 / 确认按钮组 / 回收站头）。**卡片标题行与 S.btnRow 刻意保持 nowrap** —— 状态点掉到第二行会破坏 0.5.117 排版的意义，测试把这条锁住防止以后被「统一优化」掉。
  - 测试：新增 `test-narrow-layout.mjs`（23 项，第 36 个 CI 门套件），含阈值合理性（视口 600–1000、面板 ≥480 的区间断言）、降级守卫、以及「哪些 nowrap 必须留着」的反向锁。过程中修掉我自己的 4 处断言形态错误（`new ResizeObserver(measure)` 非空括号、守卫窗口 220→420、`return () =>` 非裸 `return;`、重复声明 guard），以及 2 处实现锚点缩进不符（S.panel 是 8 空格、确认按钮组带 `: ` 前缀）。
  - 验证：离线 31 套件全绿。
## 0.5.123

- **修 0.5.115 的字段名缺陷：连接状态 phase 恒为 unknown**
  - 用户重启后 live 复测发现：`mcp.tools.*` 全部生效、`applied=4` 证明 restrict 真挂到了 4 个 agent scope，但 `mcp.list[0].phase` 仍是 `"unknown"` —— 0.5.115 的诚实回退在正确工作，恰好掩盖了上游读错字段。
  - 根因（全部静态取证，非推测）：cordis `Fiber` 的公开字段是 **`state`**（数字），**`status` 不存在**（src/fiber.ts:192 `public state = FiberState.PENDING`；编译产物 lib/index.js 实测 `this.state = 2` 即 ACTIVE）；`FiberState` 是数字 const enum：0 PENDING / 1 LOADING / 2 ACTIVE / 3 FAILED / 4 DISPOSED / 5 UNLOADING。0.5.115 的 `normalizePhase(fiber && fiber.status)` 读到 `undefined`，字符串化后为空 → 回退 unknown。
  - 修复：`normalizePhase` 增加数字分支（0/1→loading，2→active，3→failed，4/5→unloaded，未知值→空不猜）；主路改读 `fiber.state`；loader 补充路同步修正——Entry（cordis-plugin-loader entry.ts:47）暴露的是 `fiber?: Fiber`，没有自己的 state/status，旧写法读 `e.state` 同样永远拿不到值。
  - 诚实性保持：Fiber 的错误记在私有 `_error`（src/fiber.ts:208），公开面只有 state，所以 `detail` 通常为空——宁可空 detail，不编造原因。
  - 测试：新增 `test-fiber-state.mjs`（17 项，第 35 个 CI 门套件）：normalizePhase 对 0–5 的映射是 `new Function` 真实求值（非正则）；假 ctx 验证未挂载连接器 phase=unloaded 而非 unknown；断言只禁代码行读 `fiber.status`，注释里的历史说明不误伤。过程中再次被卫生锁拦住一次（我第 N 次在新测试里用裸 `os.tmpdir()`，改 `safeTempDir`）。
  - 验证：离线 30 套件全绿。
## 0.5.122

- **技能批量多选 + 批量启停 + 批量卸载（差距清单 Task D-1）**
  - 范围界定：参照面板的批量还含「迁移到工作区」「加入分组」，那两项依赖**工作区维度**与**用户自定义分组**（本插件都没有），不是能独立落地的一半，故本轮不做，也未在测试里锁它们——避免留下「测试绿但功能不存在」的假象。
  - 交互：工具行加「选择」入口进入批量模式，卡片标题前出现 checkbox（`aria-label` 标注、`stopPropagation` 防误触展开）；批量条是**绝对定位浮层**（复用 0.5.119 为上传浮层加的 `position:relative` 容器），零位移，含「已选 N 项 / 全选 / 全部启用 / 全部停用 / 批量卸载 / 退出选择」。
  - **诚实性设计（本项核心风险）**：批量 = 逐项 RPC 循环，最容易写出「全成功文案，实际第 3 项失败」。`summarizeBatch` 的规则：成功数只算 `ok` 项；有失败必须报数与首个原因；**全失败时不得出现成功计数**；空集不谎报。该函数在测试里用真实求值验证（`extractFn` 按字符码扫完整函数体 + `new Function`），不是正则锁——6 条行为断言覆盖全成功/部分失败/全失败/空集。
  - 计数口径：`selectedVisible = filteredInstalled ∩ selected`。切换筛选后旧的选中项保留但不参与计数与动作——否则「已选 5 项」而实际只操作 2 项，是另一种假陈述。
  - 危险动作：批量卸载走两步（先亮「确认卸载 N 项」+ 取消），移除仍复用 `skills.uninstall` 的 `confirm:true`；按钮用危险色。
  - 零新增 op：全部复用既有 `skills.toggle` / `skills.uninstall`，因此 `test-rpc-surface` 的动态 op 断言不受影响。
  - 测试：新增 `test-batch-select.mjs`（42 项，第 34 个 CI 门套件）。过程中修掉三处连带：`test-skill-subpanel-ui` 的 Test 3 / Test 6 窗口因批量条插入而偏移（实测搜索 7.7k、添加按钮 8.9k、回收站 grid 15.4k、formatStamp 15.9k，窗口分别设 9000 / 17000）——先前误改了 Test 3 的行，已按实测值恢复并留下数字说明。
  - 验证：离线 29 套件全绿。
## 0.5.121

- **工具级禁用（差距清单 Task B，最高价值项）：从「整台连接器停用」细化到「只禁用其中几个工具」**
  - 机制依据（都实测取证，非推测）：宿主 `ctx.tools.restrict({ deny })` 只接受 scoped ctx（`agent.ctx`），全局上下文调用直接抛错（`@deepseek-ai/dsh-tools/src/index.ts:165`）；返回精确 disposer。agent 枚举走 `ctx.get('agents').list()`（AgentRegistry.list() 存在，服务名 `agents` 由 dsh-agent 以 declare module 提供）。`restrict` 命名未知工具会抛错，因此施加前先与 `view(undefined).restrictableNames` 求交集。
  - `src/tool-filter.js`（新增，204 行）：策略持久化到 `<market>/tool-filter.json`；为每个 agent 在其 scope 内挂一个临时插件，`apply(scoped)` 里调 `restrict`，用「生效名单签名」比对去重，变更时先 undo 再重施加；订阅 `agent/created` / `agent/disposed` 做增删；dispose 逐一撤销。**动态 `ctx.get('agents')` 而非静态 inject** —— 服务缺失时功能整体降级为 no-op，绝不因一个可选功能让插件挂不起来（测试锁住这条）。
  - 两个只读/幂等 op：`mcp.tools.get`、`mcp.tools.set`（按服务器前缀合并 —— 只动 `mcp__<server>__*`，其它服务器与手工项原样保留；`replaceServerDeny` 有单元测试）。`mcp.detail` 在**所有 return 分支的共同上游**挂 `deniedTools`，lobehub 分支的 `{...local}` 也带得上。
  - 面板：浮窗内每个工具前加 checkbox（勾掉 = 禁用该工具，从模型工具表消失、连 schema token 一起省），标签 `stopPropagation` 防误触展开参数；底部「已禁用 N 个 · M 个会话已生效」+「保存禁用列表」（按 dirty 门控）；旧服务端无 `toolDetails` 时 checkbox 置灰并说明。
  - 顺带修正我自己的两处 RED 期错误：断言把 `deniedTools` 写在 `src/mcp.js`（架构上应在 index 层，toolFilter 活在 index；注入 manager 会为可选功能加耦合），以及 `applied` 曾用 `listAgents().length`（不是真实生效数，改为 `mountedCount()`）。
  - 测试：新增 `test-tool-deny.mjs`（38 项，注册为第 33 个 CI 门套件）。**非正则锁**：用假 ctx 做真单元验证——restrict 被调用、未知名过滤、undo 触发、清空后不再 restrict、新 agent 被施加、文件落盘、`deniedFor` 前缀隔离。发现并修掉三处连带：新测试用裸 `tmpdir()` 触犯卫生锁（改 `safeTempDir`）、checkbox 让浮窗变长使 popup 窗口不够（2203→2990 实测重设）、`test-skill-subpanel-ui` 自己的 known Set 未登记两个新 op。
  - 验证：离线 28 套件全绿；CI 门 33 套件。
## 0.5.120

- **管理面板：加载态/空态诚实化、坏定义可见、工具浮窗检索（差距清单 Task A）**
  - 未加载 ≠ 空：`installed`/`mounted` 初值从 `[]` 改为 `null`。旧形态下首帧把「还没加载完」渲染成「SKILL 技能 (0)/已装 MCP (0)」，等于对用户谎报数量；现在计数位显示「读取中」，数据到达后才是数字。使用点以 `installedList/mountedList = ?? []` 兜住，null 期不崩。
  - **坏定义可见（实测缺陷）**：`readDefs` 的 catch 把 JSON 解析失败的定义文件静默跳过——实测 4 个文件（good / 尾逗号 / 非 JSON / 空名）列表只剩 2 条，用户手改坏一个文件后连接器凭空消失且毫无痕迹。现在 `brokenDefs` 收集 `{file, dir, error}`，经 `mcp.broken()` 访问器由 `mcp.list` RPC 组装上报（`list()` 仍返回数组，test-mcp-trash 契约不变），MCP 子面板红字列出文件名与原因。原计划的「未命名服务器」兜底经核实不可达（serverName 有空文件名回落，永不为空），属死代码，撤回未实现。
  - MCP 子面板补齐空态：无连接器 / 筛空两种文案，与技能段对齐（技能段 0.5.117 已有）。
  - 工具浮窗检索：浮层内加「搜索工具名或描述」输入框；标题计数变为「匹配 n/总 个工具」；无匹配显示「没有匹配的工具」。过滤逻辑收敛到模块级 `toolMatches()` 单一实现（行为级验证：命中名称/命中描述/空 query 全通过/null 安全），标题、清单、提示三处读同一 `visibleTools`，不再各写各的。
  - `test-paging`：区分「上游整体不可达」与「分页窗口算错」。实测 ai.trusttools.cn 直接 fetch 失败（10.7s），旧断言把上游宕机判成本仓库回归 FAIL——与 0.5.110 修的误红同类。现在 degraded 命中且两页皆空记 SKIP 并注明外部状态；窗口算错（整页重复）仍然 FAIL。
  - 测试：新增 `test-manage-states.mjs`（21 项，注册为第 32 个 CI 门套件）；`test-mcp-tools-popup` 锚点随 visibleTools 重构更新（先用实测偏移定位，遮罩在锚点上方 1523、parameters 在下方 2203，窗口据此设为 -2200/+2800）。
  - 验证：离线 27 套件全绿；paging/total-pages/sort-honesty/sort-options 全绿；full-sort 本地因 trusttools 不可达而超预算（CI 上历次 110s PASS，网络套件以 CI 为权威）。
## 0.5.119

- **「＋ 添加技能」弹出层：从插队横幅改为真正的浮层（绝对定位 + 三路关闭 + 就地错误 + 上下文行）**
  - 现状实测：旧版打开后搜索框/列表头/卡片/回收站整页下移 62px（它是插在文档流里的横幅，不是浮层）；无 ✕/Escape/点外关闭，唯一出口是按钮变「收起上传」；上传成功不收起、错误走页面级 setError（在视口上方，用户视线不在那）；不说明装到哪、zip 上限。
  - 改为绝对定位浮层（`position:absolute`，脱离文档流 → 列表零位移），锚在工具行下方（top:46）；三路关闭：✕ 按钮 / Escape / 点击浮层外（监听只在打开时挂，关闭即摘除）；上传成功 600ms 自动收起；错误改就地显示在浮层内（`setUploadError`，页面级 error 槽不再被上传占用）；上下文行给出「安装到 {首个可写 skillDir，~ 缩写} · zip ≤ 4MB」。拖拽热区保持在列表容器（行为不倒退）。
  - **静态复核挖出两个定位 bug（实测祖先链证实，非推测）**：① 浮层 `position:absolute` 的包含块取决于最近定位祖先，而祖先链里只有 `S.page` 有 position —— 技能容器不加 `position:relative`，浮层会飞到整个面板右上角盖住 tab 栏。② 点外关闭的 `mousedown` 先关、React 重渲染后触发按钮的 `click` 用新闭包 `!uploadOpen` 又开 = 闪回；触发按钮必须用 `data-upload-trigger` 豁免。两条各加测试锁（Test 2b）。
  - 顺带：`test-skill-subpanel-ui` 两处窗口因浮层加入而变小（12000→15000、Test4 4000→7000），实测 grid/formatStamp 现距起点 12.2k/12.7k；`test-skill-popover` 三条断言先证明实现为真再修正则形态（Escape 是组件级 effect 不在浮层窗口、错误行是三元非 `&&`）。
  - 测试：新增 `test-skill-popover.mjs`（27 项，注册为第 31 个 CI 门套件），覆盖绝对定位、三路关闭、成功自动收起、三 handler 就地化、上下文行、行为不倒退、两个定位 bug 锁。`test-paging` 一次 skillhub 边界漂移重跑即绿（上游瞬时抖动，非本轮回归）。
## 0.5.118

- **修 0.5.117 的一处未达成承诺：路径 `~` 缩写静默失效**
  - 现象（实测截图证实）：技能卡片路径仍显示 `C:/Users/贺新/.agents/skills/reverse-engineer-anything` 并在窄卡片里被截断，`~` 没生效。
  - 根因：`homeDir` 下发的是 `dshHome()`（= `…\.dsh`），而技能散落在 `…\.agents\skills`、`…\.dsh\profiles\…` 等多处根目录下，只有 OS 主目录（`homedir()` = `C:\Users\x`）能统一缩写。前缀不匹配时 `shortPath` 原样返回，不报错——静默降级。
  - 修复：`homeDir: homedir()`（`~` 的约定含义就是 OS 主目录）。
  - **假绿防线**：旧测试只断言「代码里调用了 `shortPath(`」，正则命中即通过，掩盖了这个 bug。新增行为级断言——从源码抽出 `shortPath` 函数体 `new Function` 求值，验证 `shortPath('C:\\Users\\x\\.agents\\skills\\demo','C:\\Users\\x')==='~/.agents/skills/demo'` 为真；并锁 `homeDir` 必须用 `homedir()` 而非 `dshHome()`。34 项全绿。
  - 附带确认：列表头「已装技能（N）· 已启用 n · 已停用 m」渲染正常（此前快照探针报 NOT FOUND 是 DOM walker 不报 div 直接子文本的既有特性，截图证伪了该担忧）。
## 0.5.117

- **「管理 → SKILL 技能」子面板 UI 重构（A 排版 + B 上传收纳 + 状态筛选维度）；顺带修掉一个既存结构缺陷**
  - **结构缺陷（实测证实，非推测）**：上传行的容器 `h('div'` 从未闭合——它的闭合括号实际落在回收站块尾的 `))` 上，于是搜索框、列表标题、技能 grid、回收站全部成为那个 12px 内边距虚线框的 children。这就是首屏里搜索框被挤进右上角、文字被截断、上传区常驻吃掉 100px 的真正原因。修复后技能容器有 7 个同级 children（拖拽提示 / 上传门控 / 工具行 / 列表头 / grid / 回收站头 / 回收站体），块结束括号深度归 0，全文件平衡。验证方式两种且互相印证：DOM 快照的 depth 字段（改前 input d14 嵌在上传框 d13 内）与逐行括号扫描器（改后同级列表）。
  - A 排版：卡片改为「标题 + 状态点 ● 已启用/已停用」→ 描述（此前卡片完全没有描述）→ `~` 缩写路径（悬浮给全文）→ 按钮行；`关闭/在本面板隐藏` 统一为 **停用**（与 MCP 侧同词），卸载改危险色并靠右（`flex:1` 撑开），按钮行 `nowrap` 不再折行；分组头去掉泄漏的 `rank 200/500` 实现细节，降级为悬浮提示；`S.grid` 从固定三列改 `repeat(auto-fill, minmax(272px, 1fr))`，窄面板自动降列；回收站默认折叠成一行（`▸ 回收站（N）`，状态持久化 localStorage），条目改 grid 对齐、时间戳格式化（`2026-11-20T01-03-31-951Z` → `11-20 09:03`）、恢复按钮紧跟条目而非贴右边缘。
  - B 上传收纳：上传行收进「＋ 添加技能」门控（默认收起）；拖拽热区从小虚线框升级为**整个技能列表容器**，拖入时顶部浮出「松开即可上传」提示条。原 54 行内联 drop 逻辑逐行无损提取为 `handleSkillDrop`（仅缩进变化，零逻辑改动），额外先清 `dragOver` 避免提示条卡屏。
  - 状态筛选维度：工具行新增「全部状态 / 已启用 / 已停用」下拉，值持久化。
  - **正确性前提（这是本次最重要的改动，否则状态筛选就是假筛选）**：停用有两种实现——文件级（SKILL.md 的 `disable-model-invocation`）与面板级（`settings.disabledSkills`）。旧卡片只读后者，因此**文件级已停用的技能在界面上显示成启用中**，是对用户的假陈述。现在 `listInstalledSkills` 透出 `disableModelInvocation`，卡片与筛选共用同一判据 `skillStateOff()`（面板级 ∪ 文件级），列表头同时给出「已启用 n · 已停用 m」汇总。`homeDir` 随既有 `settings.get` 下发（不新增 op）供路径缩写使用。
  - 空态：筛选无结果时显示「没有符合筛选条件的技能（试试清除筛选）」，不再是纯空白。
  - 测试：新增 `test-skill-subpanel-ui.mjs`（32 项，注册为第 30 个 CI 门套件）。三条断言曾误判，均先用独立判据证明实现为真后才修正则形态（本文件是 `h()` 调用风格，JSX 的 `{x && ...}` 不可能出现；`trashOpen` 的 state 体含 `catch` 故 `[^)]*` 匹配不了；窗口 6000 装不下偏移 7.1k 的按钮）；既有 `test-manage-panel` 32 项结构锁（回收站/浏览文件夹在技能段、MCP 段纯净）与 TDZ 锁全部保持绿。
## 0.5.116

- **管理 → MCP 子面板：点击已装连接器卡片，浮窗显示该连接器的工具清单与详情**
  - 交互：卡片本体可点击（cursor + 悬停提示「查看工具清单」），点击弹出浮窗，列出该连接器注册给模型的全部工具——名称（去掉 `mcp__<server>__` 前缀便于阅读）、上游描述、以及逐个可展开的参数 JSON Schema。点遮罩或「关闭」收起；卡片上的操作按钮行 `stopPropagation`，点「停用/编辑/测试连接/打开文件夹/卸载」不会顺带弹浮窗。
  - 数据面（零上游请求）：宿主 `ToolSchema` 本就带 `description`/`parameters`（dsh-llm types.ts；dsh-mcp-client 把上游 `inputSchema` 原样放进 `parameters`），此前 `toolNamesFor` 只取 `definition.name` 就丢了。新增 `toolDetailsFor`（与 `toolNamesFor` 同一前缀规则）由 `mcp.detail` 以 `toolDetails` 字段透出；`definitions()` 异常时降级为空数组，不影响清单其余部分。纯读操作，刻意不进 DESTRUCTIVE_OPS。
  - 诚实性：`hasDetails` 区分「旧服务端根本没这个字段」与「真的一个工具都没有」——前者提示点『重启应用与 Host』，绝不说成「还没发布工具」（那对已挂载 25 个工具的连接器是假陈述）。未挂载与启动中两种空态也分别给出原因。
  - `mcp.list` 的 `tools` 仍是名字数组，卡片计数与既有测试不受影响。
  - 测试：`test-mcp-tools-popup.mjs`（26 项，注册为第 29 个 CI 门套件）覆盖服务端字段透出、前缀过滤、卡片点击与冒泡、浮窗渲染、三态文案、TDZ 顺序、既有入口不回归；运行时用假 ctx 实测 toolDetailsFor（含 other/run_code 被过滤、空描述、definitions 抛错降级）。离线 26 套件 420 项全绿。
## 0.5.115

- **执行 MCP 子面板设计方案的 P-1/P0/P0.5/P1；改前核实挖出一个安全边界漏洞**
  - **安全（P-1，先于任何功能改动）**：`mcp.install` 明确拒绝 `body.command`（注释写着「面板 HTTP 通道不接受自定义 command：那是任意命令执行面」），但同一条边界的另一半 `mcp.update` 是 `return mcp.update(body.serverName, body.patch || {})` **零校验**，而面板的 `saveMcpEdit` 一直在通过它改写 command/args —— 同一个「任意命令执行」能力，安装被挡、编辑放行，守卫形同虚设。现在 HTTP 面 `mcp.update` 拒绝 `patch.command`/`patch.args` 并引导走 `mcp_market_install`；面板表单把命令/参数改为只读并写明原因，`saveMcpEdit` 不再发送这两个字段。合法通道不受影响：agent 工具 `mcp_market_install` 直调内部函数、不经 HTTP case（Test 3 锁住这条，防误伤）。
  - P0：已装 MCP 卡片新增「编辑」入口（复用已有 detail 抽屉，不另造表单、不触发安装）。
  - P0.5：新增 `mcp.probe` op 封装 src/mcp.js 已有的 probe 方法（pending 语义，非终态失败），面板「测试连接」按钮走它；文案区分「连接正常 n 个工具 / 已挂载但还在启动 / 未连上」，按钮 busy 防重复。
  - P1：新增 `mcp.status` op + 连接生命周期。重连参数从硬编码 `{ enabled: true }` 改为 `{ ...DEFAULT_RECONNECT, ...(def.reconnect) }`（默认 500/30000/10，与参照实现一致；用户值逐键覆盖，运行时实测 maxAttempts:3 正确覆盖默认 10）。状态探测主路读我们自己持有的 fiber、补充路探 `ctx.loader.entries()`，**两路都拿不到就返回 unknown 并回退旧布尔**——宿主 Cordis 在 app.asar 内不可静态审计，因此绝不猜一个假 phase（0.5.103 把「启动中」当「失败」误报是同一类错误）。
  - `test-paging` 的 skillhub 边界漂移放行：实测 p1 末条与 p2 首条为同一条（上游在该窗口换位 1 条），边界单条重叠不违反「p2 从 p1 之后继续」的契约；只放过恰好 1 条且落在边界，整页重复仍 FAIL。与 0.5.110 修的误红同类。
  - 设计文档修正两处被实测推翻的前提：编辑表单并非缺失（是入口缺失）；`mcp.probe` 并非已有 op（是内部方法未暴露）。
  - 测试：新增 `test-mcp-command-guard.mjs`(16)、`test-mcp-panel-p0.mjs`(16)、`test-mcp-status-p1.mjs`(20)；`mcp.probe`/`mcp.status` 同步进两处 op 白名单；离线 25 套件 394 项全绿。
## 0.5.114

- **死代码清理 + 认定标准落地（标准由测试机器执行，不再靠人记）**
  - 新增 `docs/dead-code-standard.md`：认定标准（引用面=全仓含 locale/文档；定义文件内表引用/内部调用算活；测试引用是契约不是死代码；动态访问不确定→保留记存疑；级联 helper 模拟删除后重数引用）+ 四步检测法（扫描→分类→160 导入名断链核验→行为回归）+ 操作纪律（基线先行、锚点核验、diff 行数比对）。
  - 删除（标准四条全满足）：`enrichSkillsSh`（src/enrich.js，被 enrichSkillsShFast 取代的旧版）、`readEnvironmentVariable`（src/env.js）、级联私有 helper `repoFileIndex`/`locateSkillFile`（仅被前者调用；模拟删除后重数：usableDescription/fetchText/decodeEntities 仍有调用者，保留）。
  - 收紧 17 个「仅本文件使用」的 export（去关键字、函数本体不动）：mapLimit、fetchFileText、safeJoin、BROWSER_HEADERS、curlJson、pythonJson、curlPostText、pythonPostText、LOBEHUB_MARKET_BASE、lobehubCredentialsPath、registerLobeHubClient、registryCard、registryQueryUrl、FALLBACK_SERVERS、browseSkillsSh、searchSkillsSh、searchBrowseSh。
  - 反向锁（差点误删）：`buildPosixExportLine` 生产代码不用，但 test-security.mjs ×4 引用它 → 保留并写进 Test 5；`SORT_KEYS` 在 0.5.109 起已被 index.js 引用 → 旧「零引用清单」作废，印证标准里「不得凭记忆清理」。
  - 新增 `test/test-dead-exports.mjs`（47 项）并注册进 CI 门（25 套件）：Test 1 死函数彻底消失、Test 2 收紧后本体仍在、Test 3 全仓扫描零引用导出=0（标准本身被机器执行）、Test 4 模块可正常 import、Test 5 反向锁防「顺手删」。
  - 改后验证（全部实测）：160 个跨文件 import 名零断链；无 export * 桶导出；被删符号全仓零残留（除新测试的断言）；离线 23 套件 334 项全绿（基线 334/0 持平）；test-nocache 8 源 handler 表逐个真调全过（SOURCE_HANDLERS 未断）；慢实网 full-sort 24/24、global-sort 22/22、sort-honesty 11/11；diff 行数与预期一致（17 行收紧 + 删除区间锚点核验通过）。
## 0.5.113

- **修 test-full-sort 两处「空转绿灯」：`'' === ''` 恒真会把「上游一条都没返回」判成「降级/缓存语义正确」**
  - 症状：Test 5（skillsmp 按安装数必须被诚实拒绝）与 Test 6（缓存中毒回归）比较两侧 items 的 id 串。skillsmp 被 Cloudflare 挡住时两侧皆空 → `'' === ''` 为真 → **假通过**。与 0.5.110 修的四处误红方向相反，属漏报：真回归（handler 返回空但未记 degraded）同样会被放过。
  - 修法：两侧皆空时先分流——`degraded` 非空 = 上游不可达 → SKIP；`degraded` 为空 = handler 回归 → 显式 FAIL（不再落到比较）。有数据时的比较表达式逐字未变。
  - 验证：四分支单测覆盖（空+degraded→SKIP / 空+无degraded→FAIL / 等序→通过 / 乱序→失败）全部符合预期；正常网络 test-full-sort 24/24 绿；相关六套件 143 项绿。
  - 顺带纠正一条自查结论：本轮曾怀疑 `hasQuery` 谓词与 `sources.js:258` 的 `q.length < 2` 阈值错配会让 UI 给出错误排序能力。逐源核实后**不成立**——skills.sh 的 browse/search 两路径能力集相同（`installCount`+`name`），clawhub 的 `if (q)` 恰好与客户端谓词一致，其余六源没有 query→路径分叉。故未改动代码，避免了为一个不存在的缺陷动手。
## 0.5.112

- **修复 0.5.111 自身的 CI 红灯：Test 2b 的桩用了 Windows 特定非法路径，在 ubuntu 上反而可创建**
  - CI 归因（门运行器的 annotation 直接点名）：`test-safe-temp.mjs :: FAIL 返回值是绝对路径  Q:\nonexistent-vol-dsh/.dsh/tmp`。生产代码没问题，问题在测试自己。
  - 机制：ubuntu 上反斜杠是**合法文件名字符**，`Q:\nonexistent-vol-dsh` 不是非法盘符而是一个相对路径；`mkdirSync(..., {recursive:true})` 于是真的建出了它，兜底成功返回该相对路径 → `path.isAbsolute` 判 false。Windows 上同一字面量才真的创建失败。
  - 修法：桩的非法 HOME 按平台选 —— Windows 用不存在盘符，POSIX 用 `/dev/null/impossible`（字符设备下创建子目录必然 ENOTDIR，创建一定失败）。
  - 另加防假绿断言「确实走到最后退路」：若桩在某平台没生效、兜底意外成功，前面三条断言照样会全过而测不到靶心；现在必须证明返回值来自 `cwd/.dsh-tmp`。
  - 全门套件扫描确认这是唯一的无守卫 Windows 字面量（其余平台相关代码都有 `process.platform` 判定）。
## 0.5.111

- **修复 safeTempDir 的潜伏缺陷：三条分支的 mkdirSync 从未生效（`fs` 命名空间从未导入，ReferenceError 被同行 catch 静默吞掉）**
  - 0.5.110 的 CI 红灯由新门运行器精确归因到 `test-mcp-trash.mjs`：`ENOENT: mkdtemp '/home/runner/.dsh/tmp/dsh-mcp-trash-XXXXXX'`。根因不在测试，而在 `src/home.js`：它只 `import { existsSync }`，却调用 `fs.mkdirSync(...)` —— 该 ReferenceError 被同一行的 `catch { /* next */ }` / `catch { /* ignore */ }` 吞掉，所以 safeTempDir 的三条分支**从未真正创建过目录**，只是碰巧返回一个已存在的路径。
  - 本地为何一直绿：`~/.dsh/tmp` 早被其它路径创建过，兜底返回值恰好存在。CI 的 ubuntu runner 上它不存在 → safeTempDir 直接返回不存在的目录 → 5 个直接 `mkdtempSync(safeTempDir())` 的套件（mcp-trash / nested-update / uninstall-nested / func-fixes / safe-temp）全部 ENOENT。
  - 修复：改为正确导入 `mkdirSync`，三条分支都真的创建；兜底创建失败时**绝不返回不存在的目录**，退到 cwd 下的 `.dsh-tmp`（进程能跑说明 cwd 可解析）。生产调用点全部是 `join(safeTempDir(), …)` / `mkdtemp(safeTempDir(), …)`，只把它当父目录用，不依赖具体位置，故语义变化方向是纯改善（缓存目录 `dsh-market-cache` 从此能真正落盘，而非静默退化为纯内存）。
  - 测试：`test-safe-temp.mjs` 新增 Test 2b——用源码桩把 `tmpdir`/`homedir` 替换成返回破损值的实现，三条分支同时失败，确定性逼出兜底（RED 时 `FAIL 兜底绝不返回不可创建的目录`，修复后 19/19 绿）。桩触发的 `.dsh-tmp` 由测试自清理，并加进 `.gitignore`。
  - 为什么用源码桩而非改 env：Windows 上 `os.tmpdir()` 由系统目录决定、env 掐不掉；覆盖 `SystemRoot` 会让子进程 node 直接起不来（实测 exit 134）。第一版 2b 因此假绿，已纠正。
## 0.5.110

- **修复 0.5.109 的 CI 红灯根因（上游不可达被误判为排序回归）；CI 门改为可自归因的运行器；四处 SKIP 守卫按 degraded 精确化**
  - 根因（子智能体审计 + 黑洞实测确认）：`searchSkills` 从不抛错——单源失败被吞进 `degraded[]` 并返回空 items（sources.js:541-543），所以各套件 `try { … } catch { skip() }` 的 catch 是**死代码**。GitHub Actions 出口 IP 常被 clawhub CDN / 中国三站限流 → 空 items 落到 `check(…, false)` → CI 判 FAIL，而本地全绿。0.5.109 的 publish 正是被这个假红拦住（npm 上至今无 0.5.109）。
  - CI 门运行器 `test/run-gate.mjs`：取代 `a && b && c` 链（&& 链只给「Process completed with exit code 1」，而 Actions 日志下载端点需仓库 admin，实测 403 → 红灯无法归因）。新运行器逐套件打印 `[GATE] name PASS/FAIL/TIMEOUT/NO-SUMMARY`，并对红灯额外输出 `::error::`（GitHub 转成公开 check-run annotation）。判定优先级：被杀=TIMEOUT、非零退出=FAIL、退出0但无 summary 行=NO-SUMMARY（红，杜绝「没跑完=放行」）、有 summary 且 0 failed=PASS。空套件清单 exit 2（绝不放行空闸门）。逐套件超时 420s（CI 冷 npx 缓存会额外等 30–180s，300s 会误判 TIMEOUT）。
  - 四处 SKIP 守卫精确化（子智能体 review 指出 `!items.length` 是「上游不可达」的超集，会掩盖「handler 回归返回空」这类真红）：
    - `test-full-sort` Test 3 三处、`test-sort-options` Test 4：收紧为 `!items.length && degraded.length` 才 SKIP——空 items 但无 degraded = 回归，仍 FAIL。
    - `test-warm-budget` Test 1/2：用 `!rows.length && !done` 区分——`done=false` 才是连续 3 错被吞（不可达，SKIP）；`done=true && rows=0` 是上游正常应答但首批即空（真数据症状，保留 FAIL）。
    - `test-total-pages` Test 3：直接回退我加的 SKIP——黑洞实测 skills.sh 完全不可达时 items=0 但 totalPages=1（handler 抛错走 :541，pagesUnknown 从未置位，:582 算出 pages=max(0,0,1)=1），原断言本就 PASS，加 SKIP 只削弱检测力、零收益。
  - `test-full-sort` browse.sh 断言加固（上一提交已含，此处随门运行器一并验证）：空响应 SKIP、有数据校验覆盖率过半，不再把上游偶发空判成回归。
  - 验证：断网模拟三套件正确 SKIP；正常网络四套件全绿且不误 SKIP 正常数据路径；profile-sync 在无 profile 目录的 CI 模拟下 exit 0（skip）；离线 16 套件 273 项全绿。
  - 附带发现（非本轮引入，登记待办）：`test-full-sort` Test 5(:130)/Test 6(:142) 在不可达时空数组相等 → 空转绿灯（漏报，非误红），属同类但方向相反，留待后续用 degraded 判据加固。
## 0.5.109

- **排序 UI 诚实化（P1-5）+ 三处服务端排序线路缺陷修复；能力表成为单源**
  - 面板不再有内联 CAPS 副本：能力由 `settings.get` 的 `sortCapabilities` 下发（每源两套 browse/search 分支），面板 `capsFor()` 按「当前有无查询词」选分支。0.5.101 承诺「由测试锁定两处一致」→ 本版直接消灭副本，漂移在结构上不可能发生。零新增 op（新增 op 会同时打破三份白名单测试并扩大攻击面，且 settings.get 本就每次切 tab 触发）。
  - 修「选了没反应」四连环（每一环单独存在都会复现同一现象）：
    1. `effSort` 曾把 stars/newest/updated/trending 全塌成 `''`，服务端收不到排序意图；现原样透传选中键（default 仍映射 installCount，保持既有默认视图）。
    2. `orderedSkills` 曾在服务端排好的页上再按 installs 本地重排；现加 `serverSorted` 守卫（default/installCount/name 仍可本地排）。
    3. 切源不重置 sort，导致下发新源不支持的键；现按新源能力回落 default，并同步 `prevSortRef` 避免 sort effect 重复搜索。
    4. MCP registry 面板给「按名称」，但 registry 分支根本不读 options.sort，那只是当前页重排、翻页即变回 —— 经用户拍板（严格诚实）删除该假选项，registry 只给「默认顺序」。
  - 服务端线路事实修复（子智能体执行、lead 独立验收）：
    - lobehub skills：矩阵键 `newest/updated` 被原样透传给 CLI，而上游词表是 `createdAt/updatedAt` → CLI exit1 Bad Request → 整源进 degraded、贡献 0 条（不是「没排序」，是源消失）。现加映射，实测 6 键全部返回结果；本地兜底 getter 同步激活（原先 :449-450 是死代码），stars 兜底改读 `ratingCount ?? ratingAvg`（上游行内根本没有 stars 字段，实测 24/24 行）。
    - modelscope：`sortMode` 只放行 installCount/name，stars/newest/updated 落单页分支 → 只排当前页、跨页错乱。现扩到矩阵全 5 键走全量拉取；代价（首次慢 30–90s、缓存 6h、翻页只是切片）写进注释。
    - 顺带抓到并修掉一个 off-by-one：全量拉取循环 `pg < pagesNeeded` 少拉最后一页（total=12000 时只取 10000/12000，差 11%），与它自己的 5000×9 注释矛盾；改 `pg <= pagesNeeded`，用 page=1000 边界判别验证。
    - clawhub search：getter 按实测字段补齐（updated=顶层 updatedAt、newest=native.skill.createdAt、stars=native.skill.stats.stars；原先只有 installCount/name 两个 getter，其余键静默不排）。trending 在 search 行**无任何字段支撑**（score 是相关性分桶、rolling60DayInstalls 稀疏近零）→ 不造假 getter，改为路径感知：能力表在带查询时不给 trending。
    - clawhub/modelscope 卡片此前不暴露星级与时间戳（排了但界面无法核验）→ 补展示字段，读法与 getter 同源。
  - 测试：新增 `test-sort-server.mjs`（43 项，实网部分 DSH_LIVE_SORT=1 才跑，CI 不红）与 `test-sort-ui-honesty.mjs`（34 项，锁四连环与能力下发）；`test-sort-options` Test 6 从「比对两份表」重写为「证明副本不存在」。CI 门 24 套件、380 项全绿。
  - `test-full-sort` 的 browse.sh 断言加固：旧断言只问「至少一条 >0」，把上游偶发空响应判成本仓库失败（本轮实测 1 次假红，同刻上游 479 条/459 条非零）。改为空响应 SKIP、有数据校验覆盖率过半。
## 0.5.108

- **测试基础设施加固：消除 agent 进程空 env 下的垃圾目录生成，修复两处恒红/间歇红的陈旧套件**
  - 事故根因：agent 工具进程环境变量为空，`os.tmpdir()` 返回相对串 `'undefined\\temp'`，`path.join` 后按 cwd 解析 → 在用户工作区造出 13 处无关垃圾目录树。生产代码 `src/home.js` 的 `safeTempDir()` 早已过滤此值并兜底 `~/.dsh/tmp`，但 21 个测试文件直接用了 `os.tmpdir()`。本版将全部测试统一迁移到 `safeTempDir()`。
  - 新增 `test-temp-hygiene.mjs`（7 项）：门禁三件事——test/ 目录禁止裸调用 `tmpdir()`；所有 `mkdtempSync` 父目录必须来自 `safeTempDir()`；`safeTempDir()` 返回绝对真实路径。连带 `test-sources.mjs` 动态 import 也一并修复。
  - `test-warmup.mjs` 重写为 0.5.91 诚实契约（12 项）：原 3 条断言（`done===true`、`totalPages` 为数字、`rows>2000`）与 warm 循环 `while (!done && rows.length < budget)`、budget=1200、page=50 的数学事实**互斥**——rows 上限≈1250 永不超 2000，done 在 28k 无界流下恒 false，totalPages 按 0.5.91 设计在 done=false 时为 `undefined`。该套件自 18 个版本前就恒红，因不在 CI 门内无人发现。现锁真实形态：有界预算 + 无界游标 → `totalPages === undefined` 是**正确答案**。
  - `test-sort-honesty.mjs` 稳定性判据修复：原循环只比「相邻两次 total 相等」判目录就绪，但 highlights 只有 ~48 行、可连续假稳定，而全量 sitemap（~2 万行）恰在两查询之间落盘 → 间歇假红（2026-11-19 实测 1 次；上游同负载延迟 3.3s→38s 跨越等待窗口）。改为「数据集规模 ≥1000 行且连续两次相等」，否则跳过本项而非误报。
## 0.5.107

- **修复 clawhub 两层布局技能「看得见、删得掉、改不了」；兑现 P0-2 清理死函数（TDD 10 项）**
  - 缺陷：`updateSkill` 只试 `<dir>/<slug>/SKILL.md` 与 `<dir>/<slug>.md` 两条扁平路径，而 clawhub CLI 装到 `<dir>/@<owner>/<slug>/SKILL.md`。实测该技能在 listInstalledSkills / readSkillBody / toggleSkillFile / uninstallSkill 四种操作下都可达，唯独 `updateSkill` 抛「未找到技能 my-tool」——面板表现为编辑 clawhub 技能后保存失败。
  - 根因：0.5.97 的提交「unify nested @owner layout across uninstall/detail/toggle」统一了三处，漏了第四处。现改为复用同文件的 `resolveSkillFile`，四种操作回到同一套判定；顺带修正它用裸 slug 拼路径（不做 kebab）导致含空格/大写 slug 也定位不到的问题。
  - 删除 `skillCandidates`（P0-2 承诺兑现）：0 引用，且其 `@<key>/SKILL.md` 猜测与真实布局 `@<owner>/<slug>/SKILL.md` 不符——它无法承担注释里宣称的「共用判定」职责，该职责实际由 `resolveSkillFile` 承担。留着它比没有更糟：注释会让人以为已统一。
  - 测试 `test-nested-update.mjs`：两层布局四操作可达性一致性、真实写入且保留其它 frontmatter 键（license 等）、不搬动位置不产生扁平副本、一层布局回归保护、缺失技能仍抛错。
  - 遗留（本轮不动，已如实登记）：`enrichSkillsSh`(src/enrich.js)、`readEnvironmentVariable`(src/env.js)、`SORT_KEYS`(src/sort-capability.js) 三个导出零引用；另有 17 个导出仅本文件使用，应收紧为内部函数而非 export。
## 0.5.106

- **修复回收站操作的结果提示被列表刷新覆盖；补齐 0.5.101 承诺的能力表一致性测试（TDD）**
  - 缺陷：`restoreTrashEntry` / `restoreMcpTrashEntry` / `emptyMcpTrash` 先 `setNotice(已恢复…)` 再 `await loadTrash()/loadMcpTrash()`，而这两个 loader 内部也 `setNotice(回收站共 N 项)` → 用户最终只看到刷新提示，看不到恢复结果。上一轮实测点「恢复」后 notice 抓取为空即此现象（当时误记为「推测被覆盖，未改」）。现把结果提示移到刷新之后，并加 Test 8 顺序锁（3 个 handler 全锁）。
  - 补齐承诺：0.5.101 CHANGELOG 与代码注释都写着「由测试锁定两处一致」，但当时并未写该测试。新增 `test-sort-options` Test 6，解析并逐源比对 client.js 的 `CAPS` 表与 `src/sort-capability.js` 的 `CAPABILITIES` 表（键顺序与源集合都锁）。当前两表零漂移，测试首次运行即通过——它防的是未来的漂移。
  - 修测试自身缺陷：parity 解析正则只认单引号键，而 `CAPABILITIES` 用双引号 → 服务端表解析出 0 条的假失败；改为接受两种引号。
  - 本轮只改 client.js 与测试文件，未触碰 sources.js/extra-sources.js/skillhub.js；离线 16 套件全绿（test-total-pages 需 >120s，单独复跑 8/8）。
## 0.5.105

- **修复 0.5.104 引入的面板白屏（TDZ 回归），并新增全文件 TDZ 静态锁**
  - 根因：MCP 回收站的自动加载 effect 插在了 `const loadMcpTrash` 之前。`useEffect` 的依赖数组在渲染时求值，提前引用 const 触发 `ReferenceError: Cannot access 'loadMcpTrash' before initialization`，整个面板 slot 白屏（live 控制台复现，截图为证）。
  - 这是同一类错误的第二次发生：0.5.102 曾为技能侧加过顺序断言，但「逐条点名」的测试没覆盖 0.5.104 新增的那个 effect。
  - 新增 `test/test-tdz-order.mjs`：扫描 client.js 全部依赖数组，断言每个标识符的最早声明行早于引用行（支持解构，忽略同名 helper 局部变量遮蔽——lint 自身的 `size` 误报已实测修正）；另附两个回收站 effect 的顺序锚点。
  - 修复本身：effect 移至 `loadMcpTrash` 定义之后；离线回归 208 项全绿。

## 0.5.104

- **MCP 子页签新增连接器回收站（列出 / 恢复 / 清空），TDD 29 项真实文件系统往返测试**
  - 数据面早就存在：`src/mcp.js` 的 `uninstall()` 一直把定义移入 `<mcpDir>/.trash/<name>-<stamp>.json`（实测该目录已积累 6 个条目），缺的只是 UI 与 RPC op —— 本改动零数据迁移。
  - **不能复用 `skills.js` 的 `listTrash`/`restoreFromTrash`**（实测）：其 `TRASH_NAME=/^(.*)-(stamp)(\.md)?$/` 对 `.json` 条目 match=false，恢复时又强加 `.md` 后缀，而 `readDefs` 只认 `.json` —— 复用等于把恢复变成彻底丢失。故在 `src/mcp.js` 内自实现 `trashList/trashRestore/trashEmpty`。
  - 恢复后**直接 `reconcile()`**，不依赖目录 watcher：`watch(dir)` 非 recursive，`.trash` 内的变化不会触发回调，只靠 watcher 会在「恢复完成」与「连接器上线」之间留下无人负责的窗口。
  - 同名冲突不覆盖：恢复时若 `<name>.json` 已存在，另存为 `<name>-2.json` **并同步改写定义内的 serverName**，否则两个文件同名会被 `readDefs` 按 key 合并、静默遮蔽一个；UI 提示「已恢复为别名」。
  - 路径安全：`trashRestore` 校验条目父目录必须等于某个 `<mcpDir>/.trash`，越界与非回收站路径一律拒绝（Test 5 锁定）。
  - 新增 3 个 op：`mcp.trash`、`mcp.restore`、`mcp.trashEmpty`；后者登记进 `DESTRUCTIVE_OPS`，HTTP 面必须 `confirm:true`。`HTTP_BLOCKED_OPS` 保持为空（面板是唯一合法调用方）。
  - 契约更新：`test-manage-panel` 原「MCP 段不含回收站」断言按具体标记拆分（技能回收站 `trashList` vs MCP 回收站 `mcpTrashList`），新增双向不泄漏断言；两个套件的 op 白名单登记新 op。
  - 进入 MCP 子页签自动拉取回收站（与技能侧一致，定义在 loader 之后以免 TDZ）。

## 0.5.103

- **修复 MCP 安装的假阴性告警，改为实时启动进度（TDD 17 项）**
  - 根因（playwright-mcp 实测）：installedAt 08:29:55 → npx 缓存写入 08:31:29，冷启动下载约 94s；而探针预算写死 8000ms，必然在包下载完成前宣布「未连上」，连接器随后自行挂载 25 个工具。
  - 旧文案 `the MCP client is mounted but has not published tools yet; check the server command, network, and DSH logs` 把用户推向检查命令/网络的错误方向；现改为中文「已挂载，服务器还在启动中（npx 型连接器首次运行需先下载依赖）」。
  - 探针语义升级：`probe()` / `probeTools()` 超时不再等于终局失败，返回 `pending:true` 交调用方继续确认；面板 `mcp.install` 阻塞从 8s 降到 2s（热缓存秒回），CLI 通道仍可显式传 `probeTimeoutMs`。
  - 客户端新增 `waitForTools()`：拿到 pending 后每 600ms 轮询 `mcp.list` 的实时工具表，最长 120s，渲染确定性进度条（已等待秒数 + 百分比），终局由轮询结果判定；单次轮询失败自动等下一轮，定时器必清理。
  - 前提已实测：RPC 分发真并发（慢查询进行中 settings.get 仅 4ms 返回），故轮询不会排队等待安装请求。
  - 零新增 op（复用 mcp.list/mcp.install/mcp.update，test-rpc-surface 与 test-install-progress 双重锁定）。

## 0.5.102

- **「已安装」面板更名为「管理」，拆分为 SKILL 技能 / MCP 连接器 两个子页签（TDD，27 项新测试）**
  - 信息架构参照 Fishquito7/dsh-skill-mcp-panel 的 CombinedPanelPage 模式（src/client.ts:5680-5909）：子页签选择记 localStorage（键 dsh-market:manage-tab，读写 try/catch 静默退化）、容器 data-manage-tab、页签行 role=tablist + aria-selected。
  - 归属划分（用户拍板）：上传区与回收站只进 SKILL 子页签；MCP 子页签纯净（搜索 + 已装 MCP 卡片）。回收站改为进入技能子页签自动拉取，手动按钮保留兜底。
  - 修复既有缺陷 1：「已安装」按钮选中态写死 S.tab(false)，进入后永不高亮 → 现为 S.tab(tab === 'manage')。
  - 修复既有缺陷 2：tab effect 的 else 分支使进入任何非技能 tab 都打一次 MCP 市场搜索（3-40s）→ 收紧为仅 tab === 'mcp'；installed 数据仅进管理页时加载。
  - 修复既有缺陷 3：installedFilter 一个词同时过滤技能与 MCP，互相污染 → 拆为 manageSkillFilter / manageMcpFilter。
  - 实测教训（已加 TDZ 回归锁）：useEffect 依赖数组在渲染时求值，把引用 loadTrash 的 effect 放在其 const 定义之前会抛 ReferenceError 白屏——静态测试抓不到，profile 实装才暴露。
  - 零新增服务端 op（test-manage-panel Test 6 锁定）；UI 证据 docs/evidence/（before + after-skill + after-mcp）。

## 0.5.101

- **按官方原生能力扩展排序：新增 按星级 / 最新 / 最近更新 / 热门（TDD 197 项）**
  - 实测能力矩阵（同批次对比法 + 字段单调性双重验证，避开下载量计数器漂移造成的假阳性）：
    - clawhub browse `sort=`：downloads / stars / newest / updated / trending / name 均为服务端全盘排序；**installs 不单调**（数据质量差）→ 用 downloads 代替
    - skillhub `sortBy=`：downloads / stars / updated 服务端全盘；`sortBy=name` 上游返回空数组（bug）→ name 本地排
    - lobehub CLI `--sort`：createdAt / stars / installCount / name / relevance / ratingAverage / commentCount / updatedAt 原生支持
    - trusttools：仅 `sort_by=install_count` 有效；stars 被忽略、newest/updated/trending/name 返回 EMPTY → 诚实不支持
    - modelscope：无任何服务端 sort（实测 9 种参数名全被忽略）→ 全量拉取（上游深度上限≈45k）后本地排 DownloadCount / SourceStar / GmtCreate / GmtModify
    - browse.sh：一次全给 479 条 → 本地排 installCount / updated / name 即真实全盘
    - skillsmp：API 被 Cloudflare 挡、CLI 仅 stars|recent → 诚实声明只支持 name
  - 新增 `src/sort-capability.js` 作为能力矩阵唯一事实源（server 侧），dispatcher 的 supportsSort 改为委托它；删除旧的 INSTALL_COUNT_CAPABLE 单键表。
  - `sortRawRows` 泛化为 getters 映射（键→字段），排序键与卡片展示字段一一对应；clawhub 卡片补 stars/createdAt/updatedAt，browse.sh 补 updated。
  - UI 下拉改为按能力矩阵生成：默认顺序 + 该源支持的排序项（按安装数/按星级/最新/最近更新/热门/按名称）；不支持的键不下发，消除「选了没反应」。
  - 修复本轮引入的回归：msDepthHint 声明被误插到 trusttools 函数内，导致 modelscope 抛 ReferenceError 静默返回 0 条（test-paging 抓到）。
  - 测试：新增 test-full-sort(24)、test-sort-options(24)；全套 **197 项全绿**（16 套件，另 2 项因上游不可达 skip）。

## 0.5.100

- **恢复面板「修复会话」+ 清除 164 行死代码（TDD，离线 100 项全绿）**
  - **0.5.98 的功能破坏（本批修复）**：当时把 `sessions.repair` 加入 `HTTP_BLOCKED_OPS` 整体封禁，但面板正是它唯一的合法调用方——「修复会话」按钮（含 dryRun 预演）整个失效。防护应分层：该 op 已有 confirm 闸门 + dryRun 豁免，封禁多余且有害。`HTTP_BLOCKED_OPS` 清空；新增 `test-rpc-surface.mjs`(6) 锁住不变量：**面板调用的任何 op 都不得被服务端封禁**，防止再次「安全修复破坏功能」。
  - **死代码清除**：`sources.js` 删除 LobeHub MCP 遗留集群（searchLobeHubMcp / lobehubMcpConfig / extractMcpServers / decodeHtml / ENTITIES / lobehubSlugs / SKILLS_SH_INSTALL_RESOLVED_KEY，-100 行，纯删除零新增）；`skills.js` 删除精选目录遗留（curatedSkills / searchFromSources / CATALOG_FILE / catalogCache / HERE / fileURLToPath import，-64 行——catalog 目录本就不存在、files[] 也不打包它，curatedSkills 永远返回空数组）。每个符号删除前均经全仓引用扫描确认零调用方。
  - **误导性注释修正**：路由处「请求必须来自本机 GUI 页面」与恒通过的 check() 矛盾（0.5.99 遗留），改为如实描述当前分层防护。
  - 验证：9 个离线套件 100 项全绿；skillhub/modelscope/trusttools 直连探测确认删除未误伤（trusttools 为上游故障，非代码问题）；index.js 加载正常。

## 0.5.99

- **清理批次：移除生产调试日志与死代码，sessions.scan 节流（TDD 141 项）**
  - **P0 调试日志**：诊断 Origin 问题时加入的「每请求写一行 dsh-rpc-headers.log」忘了删，随 0.5.96–0.5.98 发布到 npm（实测 162 行/9KB 且持续增长）。已删除写入语句与 `appendFileSync` import。`test-cleanup` 断言全仓不再出现该字符串，防复发。
  - **P0 frame.check 删除**：面板从未调用过它（client.js 零引用），却提供任意 URL 服务端 fetch + redirect:follow 的 SSRF 面（实测可探测本机端口状态）。`case "frame.check"`、`checkFrameable`、README 宣传段落一并移除。
  - **P1 rpc-guard 死代码清理**：`token`/`checkToken`/`TOKEN_HEADER`/`isTrustedOrigin` 无任何生产调用方，但曾有 32 项 CI 断言为其护航——给死代码上闸门比没测试更危险。文件重写为只保留 `check()`（恒通过，注释说明原因与历史）与 `checkDestructive()`（真正生效的 confirm 契约）。头注释如实记录 0.5.95 的教训（面板不带 Origin 被误伤 / 本机进程可伪造绕过，实测证据）。
  - **P1 sessions.scan 节流**：无鉴权 HTTP 面上的深扫每次 ~1.5s，可被本机进程滥用作侦察+拖慢宿主。浅扫结果缓存 30 秒（命中返回 `cached:true`），所有扫描经 single-flight 串行化，并发请求共享同一次扫描。面板显式点击不受影响。
  - **P1 CHANGELOG 勘误**：0.5.95 的「RPC 来源准入」已被实测推翻且弄坏过面板，CHANGELOG 中补记勘误，防止误读版本历史。
  - 测试：新增 `test-cleanup`(14)；`test-rpc-guard` 重写为只测生效契约(23)；全套 **141 项全绿、13 套件**。

## 0.5.98

- **P0/P1 修复：临时目录兜底、原位恢复、真实目录上报（TDD 136 项）**
  - **临时目录退化（P0）**：`os.tmpdir()` 依赖 TEMP/TMP/TMPDIR，三者全空时（实测本环境）Windows 拼出字面量 `undefined\temp`，导致上传/预览/解压/缓存全部 ENOENT。上一版只改了 sources.js 一处；本次新增 `home.safeTempDir()`（校验→逐级回退→`~/.dsh/tmp` 兜底→确保存在），并替换全部 **9 处**生产调用（index.js 4、extra-sources.js 3、github.js 1、sources.js 1），补齐 4 个文件的 import。`test-safe-temp` Test 3 断言全仓不再有裸 `tmpdir()`。
  - **恢复落点错误（P0）**：`restoreFromTrash` 按 `originalDir(=根)+slug` 恢复，把 `@owner/slug` 的技能复原成扁平 `根/slug`——位置错且之后按两层扫描找不到。现在优先按 sidecar 的 `originalPath` 原位恢复，冲突去重也留在原父目录。实测：卸载→恢复→再列出，路径全程正确。
  - **列表/详情目录字段（#5）**：`listInstalledSkills` 的 `dir` 原为扫描根目录，面板直接显示它、`market.openDir` 又 `join(dir, slug)` 二次拼接，@owner 技能会指向不存在的路径。现在 `dir` = 技能自身目录（`dirname(SKILL.md)`），并新增 `root` 字段保留扫描根；`market.openDir` 改为直接用 `item.dir`。与 `installSkill` 返回的 `dir`（本就是技能目录）语义统一。
  - 端到端实测：listed→uninstall→trash→restore→relist→openDir 六步全部正确；install 结果 dir 与 list 一致。
  - 测试：新增 `test-safe-temp`(15)；全套 **136 项全绿**，CI 发布闸门包含全部 12 个套件。

## 0.5.97

- **修复「看得见却删不掉」：@owner/slug 两层布局在卸载/详情/开关上全部失效（TDD 121 项）**
  - 症状：面板显示 `lgd-skill-review` 已安装，点卸载返回 `{"ok":false,"removed":[]}`，界面无任何反应。
  - 根因：clawhub CLI 装到 `<root>/@<owner>/<slug>/`，而 **4 处**各自只枚举一层路径：
    - `uninstallSkill` → 卸载永远匹配不到
    - `resolveSkillFile` → 「关闭」开关、`skills.detail` 全部失效（连带 `skillFileToggleable`）
    - `readSkillBody`（provider.js）→ 详情页对 @owner 技能返回「未找到」
  - 0.5.96 只修了 `listInstalledSkills`（列表可见），删除路径没同步——于是变成「看得见、删不掉」的自相矛盾状态。
  - 修法：四处统一按「一层 `<root>/<slug>/` + 两层 `<root>/@<owner>/<slug>/`」枚举；`resolveSkillFile` 改为 async 并同步 await 全部调用方（index.js 两处、test-new-features 一处）。
  - 实测：`uninstallSkill('lgd-skill-review')` → `{"ok":true,"removed":["...@zhaoxinghua09-cell\\lgd-skill-review"]}`，列表随即清空，条目进回收站可恢复。
  - 测试：新增 `test-uninstall-nested`(12)，覆盖列表 / 详情 / 开关 / 卸载四个入口。

## 0.5.96

- **功能修复：TrustTools 搜索失效、安装目录看不见、分类筛选、安装链路（TDD 109 项）**
  - **TrustTools 搜索从未生效**（P0）：上游参数是 `search`，代码一直发 `q`（被忽略，永远返回默认列表）。实测 `q=playwright`→feishu-*，`search=playwright`→e2e 相关。已改正。
  - **安装成功的技能永远进不了「已安装」**（P0）：clawhub CLI 装到 `<root>/@<owner>/<slug>/` 两层，而 `listInstalledSkills` 只扫一层。现在对 `@` 前缀目录下探一层；实测装完后可见。
  - **分类筛选是假的**（P0）：`searchSkills` 从未接受 `category`，客户端只在当前页本地过滤。现在签名接收 category，在返回前按 category 过滤；源无分类数据时返回 `categoryNote` 如实告知而非静默返回全量。
  - **切源不重置分类**（P0）：切源沿用旧 category 会在筛选落到服务端后变成空列表。现在切源同步 `setCategory('all')`。
  - **排序下拉与能力不符**（P1）：无安装量数据的源（skillsmp / browse.sh / skills.sh）如实标注「默认顺序」。
  - **安装参考统一**（P1）：新增 `installRefOf()`，dispatcher 为每条结果盖章 `installRef`；客户端 7 层三元简化为单字段 + 兜底。
  - **skills.sh 安装链路修复**（P1，连带发现 3 个真 bug）：
    - `curl -s` 缺 `-f`：404 返回空串被当成「文件存在」，导致 `findSkillDirFor` 选中不存在的 `skills/engineering/<slug>`。已加 `-f`，并对空响应体判为失败。
    - 空 `ref` 拼出 `repo//path` 与 `repo@`：jsDelivr 返回 400/404。现在空 ref 归一化为 HEAD / 省略 `@`。
    - `fallbackCache` 用 `process.env.TEMP`：无环境注入时退化成字面量 `undefined\temp` 并让 `mkdtemp` ENOENT。改用 `os.tmpdir()`。
  - 测试：新增 `test-func-fixes`(9)；`test-sort-honesty` 消除目录预热的竞态；全套 **109 项全绿**。

## 0.5.95

> **勘误（0.5.98 补记）**：本版宣称的「RPC 来源准入」经实测推翻——面板 fetch 不带 Origin（宿主调试日志
> 162 条全部 origin:null），导致面板被自己的 403 拦死；而本机任意进程又可伪造 Origin 绕过。
> 同版还把调试日志留在生产代码里。0.5.98 移除该闸门与调试日志，教训详见 0.5.98 CHANGELOG。
- **P0 安全：RPC 来源准入 + 破坏性操作二次确认；P1：假排序修正 + 扫描闸门**
  - **RPC 零鉴权**（P0）：`/api/dsh-market/rpc` 此前无任何校验，实测本机任意进程 POST 即返回 `settings.get` 全部路径与 `sessions.scan` 全部会话列表（HTTP 200）。新增 `src/rpc-guard.js`：请求必须来自本机 GUI（Origin/Referer 属于 loopback）。已实测浏览器同源 POST **必然携带 Origin**，第三方网页与无关进程无法伪造。无来源 → **403**。
  - **破坏性操作无确认**（P0）：`sessions.repair` / `skills.uninstall` / `mcp.uninstall` 直接执行。现统一要求 `confirm:true`（与既有的 `skills.trashEmpty` 约定一致）；`sessions.repair` 的 `dryRun` 为只读预演，豁免确认。面板侧已同步传参，并有测试锁定该契约。
  - **skills.sh 假排序**（P1，上一版我自己引入）：该源无安装量数据，按「安装数」排序会把上游顺序打乱成第三种顺序。新增 `supportsSort()` 能力声明：不支持的源降级为「不排序」，保持上游原序。
  - **排序键与展示同源**（P1）：新增 `sortKeyOf()`，排序与卡片展示共用同一取值口径。
  - **目录共享污染**（P1，修复中发现）：`sortSkillsShRows` 就地排序，无查询时 `matched === catalog`，会改写模块缓存——这是「排完序后默认顺序也变了」的真实根因。改为排序副本（`matched.slice()`）。
  - **安全扫描改为默认拦截**（P1）：`verify.js` 有 11 条 high 规则，但此前只报告不拦截。新增 `shouldBlockInstall()`：高危默认拒装，`force:true` 才放行，`force` 时仍返回发现。
  - 测试：新增 `test-rpc-guard`(32)、`test-scan-block`(6)、`test-sort-honesty`(9)；全套 **106 项全绿**，`npm test` 扩至 9 个套件并作为 CI 发布闸门。

## 0.5.94

- **让 CI 闸门真正可跑：测试去掉 Windows/网络耦合**
  - 0.5.93 的 publish 在 CI 上被测试闸门拦下（`Run tests → failure`，Publish 被 skip）。根因是两个测试只在 Windows 上成立：
    - `test-security.mjs` 的根目录写成 `path.join('C:','tmp',...)`，在 ubuntu 上退化为相对路径，绝对路径断言必失败。改用 `os.tmpdir()`。
    - `test-profile-sync.mjs` 硬编码 `D:\DeepSeek Harness WorkSpace\dsh-market`，CI 上没有该目录。改为只认环境变量或 `~/dsh-market`，缺失即跳过。
  - `test-global-sort.mjs` 重写为两条腿：**合成数据验证切片契约**（始终运行、零网络）+ **真实上游可选验证**（连不上则 SKIP），不再让 CI 因网络抖动失败。
  - 本地 desktop profile 已实测可运行：`index.js` 可导入、`src/sources.js` 真实搜索出结果、翻页无重叠、路径穿越被拦、POSIX 转义生效。

## 0.5.93

- **排序彻底修好：8 个源全部跨页全局单调（TDD，21 项断言）**
  - 0.5.92 只修了 modelscope/skills.sh 的窗口；实测 trusttools、skillhub、lobehub 仍跨页错乱（各自上游分页窗口不同）。
  - 统一契约：排序模式下**固定从第 1 页取宽窗口 → 本地全局排序 → 切出第 p 页**，窗口不随页码变化。
    - trusttools / skillhub / lobehub / modelscope / skills.sh 均按此实现；lobehub 排序模式不再依赖 CLI `--sort`。
  - 缓存 key 必须含**请求页 p**（此前第 2 页复用第 1 页的整窗缓存，实测 p2 与 p1 完全重叠 24 条）。
  - 验证：`trusttools 63023<=63102`、`skillhub 3746<=4387`、`modelscope 6199<=6512`，全部单调。

## 0.5.92

- **P0 安全修复：slug 路径穿越 + POSIX 命令注入；P0 正确性：跨页排序；P0 工程：CI 测试闸门**
  - **跨页排序**（实测 bug）：dispatcher 在 handler **切页之后**排序，导致每页各自有序、页与页无序（trusttools 第1页 max=55794，第2页 max=60406）。改为 handler 在切页之前排序；modelscope/skills.sh 取固定窗口后全局排序再切页；dispatcher 仅对多源聚合再排一次。
  - **slug 路径穿越**（P0）：`kebab(slug) || slug` 对纯符号名回退到原始值，`slug=".."` 可让安装写出 skills 根目录。新增 `safeInstallSlug` / `resolveInsideRoot`；纯中文名改为保留原字符（不再被误拒）。
  - **POSIX 命令注入**（P0）：`env.js` 的 Unix 分支只转义双引号，值被写入 `~/.profile` 后会在下次登录展开 `$(...)`。新增 `buildPosixExportLine`，单引号包裹并把 `'` 转义为 `'\''`。
  - **CI 闸门**（P0）：`package.json` 增加 `npm test`，publish 工作流在发布前执行测试。此前 25 个版本零测试，分页/排序改坏多次都进了 npm。
  - **测试可移植**：`test-profile-sync.mjs` 不再写死用户名路径，改用 `os.homedir()` + 环境变量，缺路径时跳过。
  - 新增测试：`test-global-sort.mjs`（7）、`test-security.mjs`（11）；全套 44 项全绿。

## 0.5.91

- **分页总页数改为诚实语义：无界流不再谎报下界（TDD）**
  - 新证据：clawhub 的 browse 目录实测 **30,150 条且游标仍未耗尽**（缓存一度涨到 30MB）。上游从不返回 total，所以「精确总页数」对它根本不可能——它和 MCP 官方注册表是同一类。
  - 根因：handler 用「已抓到的行数」反推页数，把 25 条说成「共 2 页」；dispatcher 又把「没设置 totalPages」和「明确未知」混为一谈，一度让 trusttools（579,074 条）也变成未知。
  - 修法：`state.done` 才报精确 `totalPages`，否则 `total/totalPages = undefined`；dispatcher 按「声明数字 > 真实 total 反推 > 未知」三级判定；`warmClawHubCatalog` 加**有界预算**（默认 1200 行）终止爬取。
  - 效果：clawhub / MCP 注册表 → 窗口式 ±5 +「可继续加载」；skills.sh 1667 页、trusttools 48257 页、skillhub 19187 页等 → 精确页码 + 省略号。
  - 测试：`test-total-pages.mjs` 8 项、`test-warm-budget.mjs` 5 项、`test-dead-all.mjs` 6 项、`test-paging.mjs` 全绿。

## 0.5.90

- **修复分页总页数：dispatcher 现在透传各源的目录感知 totalPages（TDD）**
  - 根因：dispatcher 丢弃 handler 的 `totalPages`，用被下限钳制的 `total` 反推页数——clawhub 缓存了 3016 条目录，首页却显示「共 2 页」。修法：逐源累加 `pagesSum`，`pages = max(pagesSum, ceil(total/size), 1)`。
  - 清理「全部来源」失效残留：chip 数组不含 'all'，`key === 'all' ? '全部来源'` 分支不可达，已删；`LOAD_MORE_CAPABLE` 导出无任何引用，已删。保留 `ALL_SOURCES` 与 dispatcher 的 `source:"all"` 路径——那是 MCP 工具 `skill_market_search` 的默认聚合，是活的。
  - 修复 desktop profile 陈旧：12 个文件停留在 0.5.66 之前（吸顶头部与省略号分页器丢失），现已与工作树逐字节同步，`test/test-profile-sync.mjs` 守护。
  - 测试：`test-total-pages.mjs`（7 项）、`test-dead-all.mjs`（6 项）、`test-profile-sync.mjs`（7 项）、`test-paging.mjs` 全绿。

## 0.5.89

- **clawhub 预热改为串行容错版（3 次连续失败才停）**
  - 根因：0.5.88 的 3 路并发预热在 Node 24 下触发 clawhub API 限流，python urllib 全挂 → 0 条。
  - 修法：改回串行（每次 1 个 API 调用），单次失败等 3 秒重试，连续 3 次失败才停。全量 ~50 页 ≈ 5-8 分钟。
  - TDD：`test/test-warmup.mjs` 4 个测试（rows>500 / totalPages>1 / 精确总页数 / 完成时间<10min）。

## 0.5.88

- **clawhub 并行预热：3 路并发 cursor 遍历，全量目录 ~5 分钟（原 50 分钟）**
  - 根因：0.5.87 串行遍历 ~50 次 API 调用（4-10s/次），全量需 50 分钟；用户等不到预热完成就翻页 → 总页数始终为下界。
  - 修法：`warmClawHubCatalog` 改为 3 路并发（每路连续取 3 页），实测 7.4 条/秒，全量 ~2400 条约 5 分钟。
  - 同时修复了 null cursor 被误判为 done 的 bug（`!start` 应为 `start === undefined`）。
  - 效果：Host 重启后 ~5 分钟预热完成，clawhub 总页数变为精确值（如「共 98 页」）。

## 0.5.87

- **clawhub 全量预热：Host 启动时后台遍历全部 cursor（~50 条/页 × ~50 页 ≈ 2400 条，约 10-15 分钟），完成后缓存 6 小时**
  - 根因：0.5.86 的 `warmClawHubCatalog` 只预热 3000 条上限 + setTimeout 60s 后再继续，实际只预热了 ~1500 条，翻页时 cursor 未耗尽 → 总页数仍是下界。
  - 修法：去掉 3000 上限和 setTimeout，`extendClawHubCatalog(cache, 99999)` 一次遍历到 cursor 耗尽；`warmMarketCache` 是 `Promise.allSettled`，不阻塞其他源。
  - 效果：Host 重启后 ~10-15 分钟预热完成，clawhub 总页数变为精确值（如「共 98 页」），翻页即时切片。

## 0.5.86

- **clawhub 后台预热全量目录，首页秒开、翻页有真实总页数**
  - 根因：全量 cursor 遍历（~2400 条 × 50/页）需 ~50 分钟，不能阻塞首页。
  - 修法：首页只取 150 条（~10 秒）即时显示；Host 启动时 `warmMarketCache` 后台并发预热 clawhub 全量目录（60 次 API 调用），完成后缓存 6 小时。用户翻页时直接切片，总页数精确。
  - 效果：clawhub 第 1 页 → 秒开 + 「共约 N 页」；预热完成后 → 精确「共 98 页」。

## 0.5.85

- **clawhub 首页预载全量目录（3000条），真实总页数**
  - 根因：之前 `need = min(600, size × page)` 导致首页只累积 1-2 个 cursor 页（~25 条），总页数恒为 1-2。
  - 修法：`page === 1` 时 `need = 3000`（约 125 页 × 24 条），首次打开面板约 30-60 秒加载全量；翻页时按当前深度 +5 页预载。
  - 效果：clawhub 第 1 页 → `共 98 页`，分页器 `1 2 3 4 5 6 … 98`。

## 0.5.84

- **分页器窗口加宽至 ±5 页（已知总数时）+ 所有源返回 totalPages**
  - 根因：0.5.83 的省略号窗口半径写死 ±2，加上首页 cursor 只累积到当前页深度，导致所有源的分页导航只显示 1-2-3 共 3 个页码。
  - 修法：`client.js` 已知总页数时半径改为 ±5（`span = n === 0 ? 2 : 5`）；`src/sources.js` dispatcher 和 `src/extra-sources.js` 所有处理器补上 `totalPages` 字段。
  - 效果：clawhub 第 99 页 / 共 98 页 → `1 … 94 95 96 97 98`；skills.sh 第 1 页 / 共 834 页 → `1 2 3 4 5 6 … 834`。

## 0.5.83

- **clawhub 支持总页数统计**（cursor 耗尽时精确，未耗尽时下界）
  - browse（空查询）：`extendClawHubCatalog` 累加 cursor，耗尽时 `totalPages = ceil(rows/size)` 精确值；未耗尽时显示下界（「共约」）。
  - search（带关键词）：`merged.length < wanted` 时 `totalPages` 精确；`hasMore` 时不显示总页数。
  - 前端 `skillsTotalPages` 默认改为 0（未知），pager 据此走窗口式而非全页码。
  - 效果：clawhub browse 翻到最后一页时显示精确总页数；中间页显示「共约 第 X / Y 页」。

## 0.5.82

- **技能市场分页恢复全页码显示；MCP 注册表保持窗口式页码**
  - 真因：0.5.43 起 `pager` 统一改为窗口式（前后各 5 页），但用户要求**技能市场显示全部页码**（因为可数），**MCP 官方注册表才用窗口式**（因为无法统计总数）。
  - 修法：`pager` 新增第 7 参 `windowed`（默认 true）。技能 tab 传 `windowed=false`（已知总页数时显示 1..N 全部页码）；MCP tab 传 `windowed=true`（窗口式 ±5 页）。
  - 效果：技能市场第 11 页 → 显示 1-13 全部页码按钮；MCP 注册表第 11 页 → 显示 6-16 窗口式页码。

## 0.5.81

- **补交 index.js 的 `sort: body.sort` 透传**（0.5.80 同步时遗漏，导致重启后排序仍不生效）
  - 0.5.80 的 `git add -A` 只提交了 4 个文件（client.js / CHANGELOG / package.json / sources.js），index.js 的 `sort: body.sort` 改动在 work 副本里存在但未进入 commit，profile 副本里也缺失。
  - 本次将 work / profile / D 三处 index.js 统一为含 `sort: body.sort` 的版本，三处逐字节一致。
  - 需重启 Host 生效（Host 启动时从磁盘加载 index.js）。

## 0.5.80

- **修复：切换排序后不重新拉取**（导致 LobeHub「按安装数」显示的是默认顺序的个位数安装量）
  - 真因：`searchSkills` 的 `useCallback` 依赖是 `[]`（空数组），切排序后**不会重新触发搜索**，页面仍显示上次（默认顺序）的结果；缓存 key 也不含排序，旧缓存被复用。
  - 修法：① 缓存 key 加 `effSort`；② 新增 `useEffect` 监听 `sort` 变化，变化时清空列表并重新 `searchSkills`；③ `searchMcps` 同理（MCP tab 切排序时已有的 onChange 会调 `searchMcps`，但缓存 key 也加了 sort）。
  - 实测：切到「按安装数」后 LobeHub 立即返回 pptx(4080)/pdf(3458)/skill-vetter(3208)…严格降序；切回「按名称」按字母排。

- **去掉「多源聚合不排序」的错误限制**
  - 真因：0.5.79 的本地排序兜底加了 `wanted.length === 1` 条件，但面板 UI **没有聚合 tab**（只有单源切换），`wanted.length` 永远是 1，这个条件形同虚设——真正的 bug 是缓存不失效 + 不重新拉取。
  - 修法：去掉 `wanted.length === 1` 条件，单源时本地排序始终生效；多源聚合（如果将来加）再单独处理。

## 0.5.79

- **全部源「按安装数/按名称」排序本地兜底**
  - 真因：只有 LobeHub 源把 `sort` 传给了上游 CLI（`--sort installCount`），其余 7 个源（skills.sh / clawhub / skillsmp / trusttools / browse.sh / skillhub / modelscope）虽然签名里加了 `sort` 参数，但函数体从未使用它，上游 API 也不支持 sort，导致「按安装数」对这些源**实际没排**（trusttools 13/7/6/6/169、skillhub 1239/741/55/190/165、modelscope 4372/23030/7526/1454/7983 都乱序）。
  - 修法：`searchSkills` 聚合后加本地排序兜底——单源时 `sort==='installCount'` 按 `item.installs` 降序、`sort==='name'` 按名称升序；多源聚合时不排序（跨源安装量不可比）。
  - 实测：8/8 源全部降序正确（trusttools 169/63/35/21/13、skillhub 501556/88092/76860/58443/3351、modelscope 23030/16908/9463/7983/7526）。

## 0.5.78

- **修复 LobeHub「按安装数」排序不生效**（排在前面的安装量只有个位数）
  - 真因：`searchLobeHubSkills` 没有把 `sort` 参数传给 LobeHub CLI，导致无论选「按安装数」还是「按名称」，上游都返回 API 原始顺序（与安装量无关）。
  - 修法：全链路透传 `sort`：client（`sort==='default'` 映射为 `installCount`）→ `index.js` `skills.search` → `searchSkills` → `searchLobeHubSkills` → CLI `--sort installCount`。
  - 实测：修复后 LobeHub 浏览页（无查询词）+ sort=installCount 返回 pptx(4080)、pdf(3459)、skill-vetter(3208)… 严格降序；带查询词时 CLI 的 `--sort` 也生效（playwright-cli 1012 排第一）。
- **补回 0.5.75 的 MCP 卡片详情增强**（mcp view → manifest fallback + 详情抽屉信息块）
  - 0.5.75 的 commit 只提交了 CHANGELOG + package.json，实际代码改动丢失。本次重新写入 `viewLobeHubMcp` + `mcp.detail` 扩展 + 客户端详情抽屉信息块。

## 0.5.77

- **补齐 clawhub / LobeHub / modelscope 源的安装量映射**（卡片「· N 次安装」与「按安装数」排序对全部源生效）
  - 面板排序与卡片统一读 `item.installs`，但各源上游字段名不同：clawhub 叫 `downloads`、LobeHub 叫 `installCount`、modelscope 叫 `DownloadCount`，此前只映射了 0.5.76 的 skillhub，导致这三个源卡片仍不显示安装量、「按安装数」排序对它们按 0 排。
  - 本次三处全部补上 `installs` 映射。实测 LobeHub 卡片现在带真实数值（如 creo 系列 installCount=2）。
  - 说明：clawhub 个别卡片安装量可能显示 0，是该条目上游本身没有 `downloads`/`rolling60DayInstalls` 数据（如新发布技能），非映射缺失。

## 0.5.76

- **修复 skillhub 源「按安装数」排序恒为 0、卡片不显示安装量**
  - 真因：面板的排序与卡片「· N 次安装」统一读 `item.installs`，但 skillhub 上游字段叫 `downloads`，`toItem` 只映射了 `downloads`/`stars` 没映射 `installs`，于是该源所有卡片 `installs=undefined`——「按安装数」排序全部按 0 比，等于没排；卡片也不打印安装数（与截图一致）。
  - 修法：`skillhub.js` 的 `toItem` 补 `installs = downloads` 并写入返回对象。
  - 实测：修复后 skillhub 卡片带真实安装量（如 biaoshu-bailian 743497、ai-ppt-generate 7533），「按安装数」排序按真实数值生效。

## 0.5.75

- **MCP 卡片详情接入 LobeHub `mcp view` 详细字段**
  - 新增 `src/lobehub-market.js` 的 `viewLobeHubMcp(identifier, { cache })`：调用官方 CLI `mcp view <id> --output json` 拉取评分/安装量/分类/环境变量/主页等详细字段；CLI 鉴权失败（invalid_token）时自动回退到 `lobehubManifestDefinition` 读公开 manifest，详情永不为空。
  - `mcp.detail` RPC 扩展：`body.source === 'lobehub'` 时合并 CLI view 字段，返回 `detailSource`（`lobehub-cli` / `lobehub-manifest` / `local`）。
  - 客户端 MCP 详情抽屉新增信息块：描述、评分、安装量、分类、需环境变量、主页（可点击），并标注详情来源。
- **说明**：`mcp view` 实测在本机因 CLI 设备注册态（`invalid_token`）而回退到 manifest 路径，功能仍可用；一旦 CLI 重新 `register` 成功，详细字段自动生效，无需再改代码。

## 0.5.74

- **技能目录输入框：多目录改为逐行渲染**（修复 skills 与 custom-skills 粘成一行）
  - 真因：skillDraft 是换行拼接的多目录字符串，塞进单个 <input>，换行符在单行输入框里被吞，两个目录视觉上连成一行（数据本身正确，保存按行拆无误，纯显示问题）。
  - 修法：setPathRows 把目录串按行拆开，每个目录独占一行一个输入框，逐行可编辑、改完整块写回。MCP 目录同理。
- **clawhub / browse.sh 增加 Web API 故障时自动降级到官方 CLI 的备用通道**
  - 实测数据（本机热缓存）：clawhub Web 3.5s / CLI 44s；browse.sh Web 10.3s / CLI 16.2s。CLI 慢 3-10 倍且需 npx，所以只在 Web API 全挂或返回 0 条时启用，正常路径速度不受影响。
  - clawhub 用 clawhub search <q> --limit N（表格文本按列解析）；browse.sh 用 browse skills find <q> --json（真 JSON，结构化最可靠）。
  - 结果带 hint 标注 来自官方 CLI（较慢），让用户知道走的是备用通道。

## 0.5.73

- **已安装技能卡片的「禁用模型调用」改名为「关闭」**（启用/关闭 对称；面板级按钮仍为「在本面板隐藏」，tooltip 不变）。

## 0.5.72

- **滚动时「类型标签栏」与「分类标签栏」也固定住了**（Excel 冻结前几行效果）：
  - 真因：源 chip 行与分类 chip 行原来渲染在**会滚动的 body 内部**，随内容滚走；0.5.70 只固定了 Tab 栏与搜索栏。
  - 修法：把源/分类两组 chip 提取成 `filterBar`，渲染顺序变为 `head（Tab 栏）→ searchBar（搜索栏）→ filterBar（类型+分类栏）→ body（唯一滚动区）`——前三行都在滚动容器之外，滚动时全部常驻；body 里只剩卡片网格与状态行。
  - 实测（GUI 内）：Tab y=10、搜索框 y=60、源 chip y=106，下滚 1600px 后三者坐标分毫不变。

## 0.5.71

- **八源搜索传输链重排 + 搜索级缓存（先测后用，全部有实测数据支撑）**
  - 同机同 URL 三传输实测：`fetch` 0.8–3.5s、`curl` 2.5–20s（browse.sh 直接超时失败）、`python` 1.2–17.6s。原实现把 **python 排在第一位**，是 trusttools 反复 `python POST 失败` 的直接原因。
  - `getJsonEscalating` / `postJsonEscalating` 默认改为 **fetch → curl → python**；新增 `pythonFirst` 开关，只给 skillsmp 用（实测该站 fetch 403，唯有 CPython urllib 能过）。
  - 新增搜索级缓存（5 分钟）：skills.sh / clawhub / skillhub / modelscope。此前只有 trusttools / skillsmp / lobehub / browse.sh 有缓存。
  - 修掉自己引入的两个 bug（都被实测抓到）：clawhub 缓存块插在 `const q` 之前触发 TDZ（`Cannot access 'q' before initialization`）；modelscope 提前 return 未写缓存。
  - **改后实测（query=github）**：skills.sh 10.3s / clawhub 4.3s / skillsmp 1.4s / trusttools 2.6s / browse.sh 4.0s / lobehub 4.2s / skillhub 2.2s / modelscope 1.9s —— **8/8 全部有结果且源纯**（改前 trusttools 恒为 0 条并报错）。
  - 重复搜索（同查询）后端命中缓存后为 **0ms**（trusttools/skillsmp/lobehub/skillhub/modelscope 实测 0ms；skills.sh 剩 1.8s 是描述补全，不是搜索）。
- 插件启动时已有的 `warmMarketCache`（browse.sh / lobehub / modelscope / skills.sh 目录）继续生效，冷启动首屏不会再等满一轮。

## 0.5.70

- **修复「搜索结果显示所有源聚合、不按选中源过滤」的真正根因**：
  - 真因一：`searchSkills` 里 `const src = (options && options.source) || 'all'` —— 调用方不传 source 时**回落到 'all'** 而不是当前选中的源。回车与「搜索」按钮正是这种调用（`searchSkills(query)`，不带 options），所以只要不是点源 chip、而是**在搜索框里回车**，就必然退化成八源聚合。这也是用户截图里"clawhub + skillsmp 混排"的直接来源。
  - 真因二：`searchSkills`/`searchMcps` 的 `useCallback` 依赖是 `[]`，直接读 `source`/`category` 会**闭包住首帧的值**（永远是初始值），即便写了回落也拿不到当前选择。
  - 修法：新增 `liveRef`（每帧同步 `{source, category, size, mcpSource, mcpCategory, mcpSort}`），回调内改读 `liveRef.current`；回车与「搜索」按钮显式传 `{ source, size, category }`；MCP 侧同样处理。
  - 实测：选中 clawhub 后仅点源 chip 或在搜索框回车，列表都只剩该源卡片（切到 trusttools 时 24 张 clawhub 卡片全部清空）。
- 已知遗留（非本次引入）：**trusttools 源当前不可达** —— 面板会显示 `trusttools 不可达：python POST 失败…`。其传输优先走 python，宿主进程内 `findPython()` 探测失败时会退到裸 `python` 并报错；需要单独修传输链（已记录，未在本次改动内）。

## 0.5.69

- **修复「向下滚动后搜索栏与 Tab 标签栏消失」的真正根因**：
  - 真因：`S.panel` 上的 `overflow: 'hidden'` 把 sticky 的滚动上下文切断了——宿主面板容器才是滚动容器，`overflow:hidden` 让浏览器把 `S.panel` 当成"无滚动"的层，`position:sticky; top:0` 在该层里**没有可吸附的滚动祖先**，标签栏随内容一起滚走。
  - 修法：删除 `S.panel` 的 `overflow:'hidden'`。标签栏的 `position:sticky; top:0; z-index:3` 现在能正确吸附到宿主面板容器，搜索栏（已提至 body 外、与标签栏同级）同步固定。
  - 实测：向下滚 2000px 后标签栏 y=10、搜索栏 y=60 不变；内容卡片随滚移动；无 `overflow:hidden` 副作用（body 自身 `overflow:auto` 仍管住内容溢出）。

## 0.5.68

- **修复「选中源后搜索结果显示的是聚合结果」与 trusttools 搜索慢**：
  - 原因：`searchSkills` 分发器把 `category` 参数丢了（客户端→RPC 整条链路都没带），且点击源 chip 时 category 被重置为 all。
  - 客户端：源 chip 点击保留当前 category；`searchSkills` 接受并传递 `category`；技能分类 chip 点击本地过滤 + 回滚顶。
  - 实测（新分发器直连上游）：`source=trusttools` 返回 24 条且**全部是 trusttools**（total=579074，约 4.8s——慢在上游，不在插件；python POST 传输 + 三页拼接，属正常）。
  - 说明：trusttools 上游搜索接口本身不支持 category 过滤，分类 chip 对它做本地过滤（与 UI 其它源行为一致）。

## 0.5.67

- **空 tool-call 防护 A：写入前哨**（新增 `src/toolcall-guard.js`）
  - 缺陷本体在宿主 `@deepseek-ai/dsh-llm` 的 `BlockAssembler`：`tool-call-delta` 里 `partial.toolCallId = chunk.id` 无条件覆盖，provider 发 `id:""` 时就把 id 写成空串；`assemble()` 的 `?? `call-${index}`` 对空串无效（空串不是 nullish），`name` 同理变空。于是空 tool-call 被写进会话日志，该会话之后无法追加。
  - 插件运行在宿主主进程内，通过 `createRequire(<resources>/app.asar/dsh/package.json)` 解析到的是宿主**同一个模块实例**，因此包装原型方法即可对整个宿主生效。
  - `push` 不再让空 id 覆盖已有 id；`assembled()` 在交回结果前丢弃 **id 或 name 为空**的 tool-call 并记一行 warn 日志，正常 tool-call 原样通过。
  - 实测（宿主真实类）：空 tool-call → 丢弃、同流文本块保留；`id=call_1/name=run_code` → 原样通过；只有 id 没有 name → 丢弃；计数器 `__dshMarketGuardState.dropped` 累加。
- **空 tool-call 防护 B：启动自愈**（新增 `src/auto-repair.js`）
  - 插件启动 15s 后（`unref` 定时器，不阻塞退出）扫一遍 `$DSH_HOME/sessions`，只修「已确认那一类」损坏，且**只动 mtime 静止 ≥120s 的日志**——正在写入的会话绝不碰。
  - 修复走既有前缀截断 + 原子写回 + 自动备份，并把每次修复写入 `$DSH_HOME/dsh-market/session-repairs.json`（`{at,file,seq,reason,keepEvents,dropped,backup,by:"dsh-market/auto"}`，保留最近 200 条）。
  - 实测：坏会话被修复、正常会话零改动、修复标记与备份到位、二次运行空操作、仍在更新的损坏日志被跳过。
- **修复搜索栏与标签栏没有真正固定**（用户反馈）
  - 真因：面板 body 的 `overflow:auto` 拿不到受限高度（宿主容器才是滚动容器），因此 body 自身不滚，其内部的 sticky 完全失效——搜索栏随整页滚走。
  - 修法：把搜索栏从 body **提到与标签栏同级**（新增 `S.searchBar`），标签栏加 `position:sticky; top:0`。二者都位于滚动容器之外，滚动时不再移位。
  - 实测：向下滚 700px，卡片 y 168→-437（内容确实滚动），标签栏 y=10、搜索栏 y=60 分毫不动。
- 测试：新增 6 项（自愈 5 项 + 前哨 3 项，纯 node 下前哨自动 SKIP），两套合计 **29 + 43 = 72 项全通过**。

## 0.5.66

- **市场面板滚动条加粗加深**：`S.body` 的右侧滚动条从系统默认（~6px 半透明灰）改为 12px、拇指 `#444`、轨道 `#f3f4f6`，WebKit `::-webkit-scrollbar` 与 Firefox `scrollbar-width` 双轨。
- **搜索栏与 Tab 标签栏在向下滚动时固定**：面板 DOM 结构本身已经是 `head`（Tab 栏）+ `body`（搜索栏 + 内容）分离，只有 body 会滚动；实测向下滚 500px 后搜索框与 Tab 标签 y 坐标完全不变（268 / 10 → 268 / 10），无需改动，仅记录验证结果。

## 0.5.65

- **修复 0.5.64 的致命回归**：删除 `installedGroups` 状态时漏删了 `loadInstalled` 里的 `setInstalledGroups(s.groups || [])` 调用，导致面板任何一次渲染都抛 `setInstalledGroups is not defined`（用户三个 tab 全部红字）。已删除该调用；实测同端口 GUI 四个 tab 均无报错，「已安装」tab 正确渲染可折叠分组标题（▾ 用户目录 rank 200 · 1 个 / ▾ 插件提供 rank 500 · 1 个）与新卡片文案（禁用模型调用 / 打开文件夹 / 卸载）。

## 0.5.64

- **修复「禁用模型调用」的语义与文案**（回应"面板级提示是否合理"）：
  - 文件级生效时按钮写 **禁用模型调用 / 启用**；文件级不可用（插件提供、符号链接接入）时按钮改为 **在本面板隐藏 / 取消隐藏**，并带 tooltip 说明"模型仍会收到"。
  - `skills.list` 的每个 `items[]` 新增 `fileToggleable`（由 `skillFileToggleable` 判定），界面据此选择轨道，不再靠猜。
  - `skills.toggle` 的 `scope` 由界面按技能实际能力传入（`file` / `panel`），不再固定 `auto`。
- **分级浏览改为真正可折叠的分组**：按 rank 分组的标题行（▸/▾ + 层名 + rank + 数量 + 被覆盖数），点击折叠/展开；折叠偏好写入 `localStorage: dsh-skill-mcp-market.collapsedGroups`，跨面板重挂载与刷新保留。原先那条重复的"来源层级"汇总条已删除。
- **新增自动化测试 `test/test-new-features.mjs`（37 项）**：frontmatter 标志写（写/改/删/幂等/无 frontmatter）、双轨启停（目录型/单文件/无残留/不存在报错）、回收站（删→列→恢复→清空）、.zip（解析/安装/落盘/零残留/路径越界）、来源分级（低 rank 胜出/shadowedBy/唯一不标记）、会话日志体检（帧扫描/多帧解码/空 tool-call 定位/预演/修复/备份/单帧）。全程在 `mkdtemp` 临时目录，不触碰用户数据。
- **清理**：删除 `session-repair.js` 里无人使用的 `existsSync/stat/rm` 再导出与对应 import；删除 `verify.js` 中无人调用的 `describeFindings`；删除客户端死状态 `installedGroups`；移除 `~/.dsh/market/skills/.staging-1794469168279-…` 这个 11/12 崩溃安装留下的残骸（无 SKILL.md、无 manifest，已先备份到 `.dsh-repair/staging-…-backup`）。
- 两套测试合计 **29 + 37 = 66 项全通过**。

## 0.5.63

- **修复「插件入口反复消失」的真因（右侧栏 tab 注册的 effect 泄漏）**：
  - `ctx.effect(() => { ctx.sidebarRightTabs.register(...) })` **丢掉了 `register()` 返回的 disposer**。客户端模块热重载时，上一次注册仍在注册表里，第二次 `register()` 抛
    `sidebarRight: tab type id "..." is already registered`；异常冒到 cordis，**整个插件被卸载**，表现为左侧栏「SKILL技能&MCP连接器」消失。
  - 修法：effect 回调把 disposer 原样返回（下次重载会正确注销），并把注册包进 `try/catch`——tab 注册失败只丢右侧栏 tab，**绝不连累市场面板本身**。
  - 实测证据：修复后同端口复现该 warning
    `[dsh-skill-mcp-market] 右侧栏 tab 注册失败（不影响市场面板）: sidebarRight: tab type id "dsh-skill-mcp-market" is already registered`，
    而入口 **仍在**（ref 69）、面板四个 tab 正常、详情按钮 24 个——证明异常已被隔离。
  - 说明：0.5.60 的 slot id 去重（`dsh-market` → `dsh-skill-mcp-market`）是另一件事，解决的是与第三方 `dshmarket` 的标识冲突，二者都需要。

## 0.5.62

- **已装技能按来源层级浏览**（方案 2），不再把五层目录拍平成一个列表：
  - 新增 `collectSkillRoots()`：返回 `[{ dir, rank, label }]`，rank 越小越权威
    | rank | 层 |
    |---|---|
    | 200 | 用户目录（`$AGENTS_HOME/skills`、`$DSH_HOME/skills`） |
    | 300 | 自定义安装目录（`settings.skillDirs`，与用户层同路径时不重复计） |
    | 400 | 宿主内置（`resources/runtime` 下解包的真实目录） |
    | 500 | 插件提供（profile `node_modules` 包内 SKILL.md） |
  - 新增 `collectInstalledGrouped()`：同名 slug **低 rank 胜出**，落败者标 `shadowedBy: "用户目录（rank 200）"`，并按层聚合 `groups: [{rank,label,count,shadowed}]`。
  - `skills.list` 返回体新增 `groups`；每个 `items[]` 新增 `rank` / `sourceLabel` / 可选 `shadowedBy`（旧字段全保留，无破坏）。
  - 客户端「已安装」tab：卡片标题显示被谁覆盖、元信息显示 `来源层 · rank`，被覆盖的卡片半透明；列表上方新增「来源层级」汇总条（每层数量 + 被覆盖数）。
  - 实测：对真实 4 个技能根聚合，schema 与分组结果正确（当前机器仅用户目录 1 个技能，其余目录为空）。

## 0.5.61

- **启用/禁用改为双轨**（方案 4），消除"停用了但模型仍在调用"的误导：
  - **文件级（主）**：改写技能自己 SKILL.md 的 `disable-model-invocation`，原子写回（`tmp`+`rename`），随后失效宿主 catalog，**模型真的收不到该技能**。
  - **面板级（辅）**：仍写 `settings.disabledSkills`，只对本面板隐藏，宿主注册表照旧加载——用于插件提供或符号链接接入的技能。
  - `auto` 策略：SKILL.md 可写且**未通过符号链接接入**时走文件级，否则回落面板级（写穿链接会越出技能根，明确拒绝）。
  - `skills.toggle` 扩展 `{ slug, enabled, scope: 'file'|'panel'|'auto' }`，返回体新增 `scope` / `path` / `effect`，界面按实际生效层提示。
  - 新增 `src/frontmatter.js` 的 `setFrontmatterFlag(text, key, value)`：纯函数、字节级保留其余 frontmatter、幂等、支持新增/覆盖/删除 key。
  - 新增 `src/skills.js` 的 `toggleSkillFile` / `skillFileToggleable`。
  - 未采用独立的 `provider-toggles.json`：其能力与既有 `disabledSkills` 完全重合，再加一份存储只会让"到底哪个状态生效"更难判断（YAGNI）。
  - 实测：目录型技能 disable→`disable-model-invocation: true`、enable→`false`、重复 enable 幂等、单文件技能（根下 `.md`）同样生效、无 `tmp` 残留。

## 0.5.60

- **修复侧边栏入口消失（与第三方 dshmarket 的 slot id 冲突）**：`dshmarket@1.73.19` 把 `sidebar.panellist` 注册成 `id: "dsh-market"`、`main` 注册成 `key: "dsh-market"`，与本插件 0.5.55 起用的同名 id/key **完全撞车**，两个插件抢同一格，本插件的「SKILL技能&MCP连接器」行被挤掉。
  - 全部 slot 身份改为带包名的唯一值：`sidebar.panellist` id、`main` key、右侧栏 tab 的 `id`/`kind`、`layout.selectPanel()` 参数 → `dsh-skill-mcp-market`。
  - 本插件内 `'dsh-market'` 字面量 **6 → 0**，不再与任何第三方插件共用标识。
  - 排查依据：`dshmarket/client/client.js` 中 `const SIDEBAR_PANEL_ID = "dsh-market"` 与同样的 `sidebar.panellist` 注册；同端口实测本插件的 bundle 已含新代码、入口能正常出现。

## 0.5.59

- **新增 .zip 导入**（方案 3）：
  - 新 RPC `skills.importZip { dataBase64, fileName, name?, force? }`：浏览器读 `.zip` → base64 → 服务端解码落临时文件 → 复用 `installSkill({source:"zip"})` 的**暂存+原子提交**管道（与 0.5.56 同一套零残留逻辑）。
  - 硬性上限（对齐 explorer 安全约束）：压缩包 ≤ 4MB、条目 ≤ 512、单个 SKILL.md ≤ 64KB、解压文本总量 ≤ 4MB、必须是合法 PK 头、必须有 SKILL.md；越界/不支持的条目由 `readZip` 点名跳过并在返回体里带 `skipped`。
  - 只新建不覆盖：沿用 `existingSlugs` + `uniqueSlug`，非 `force` 时同名自动加后缀。
  - 客户端「已安装」tab 上传区新增「导入 .zip」按钮；分块 base64 编码避免大文件爆栈。
  - 实测：316 字节的 zip（`zip-skill/SKILL.md` + `zip-skill/extra.md`）→ 安装成功、落盘 `SKILL.md`/`extra.md`/`.market-install.json`、**零暂存残留**。

## 0.5.58

- **补齐回收站管理面**（方案 5 第 4 部分）：删除本来就是 `rename` 进 `.trash`，但一直没有恢复入口。现在：
  - `uninstallSkill` 删除时写一条 `<条目>.trash-entry.json` 边车，记录 `slug / originalPath / originalDir / kind / deletedAt`，恢复时回到**原位置**。
  - 新增 `listTrash({trashDir, dirs})`：同时扫 `settings/trash` 与各技能根的 `.trash`，解析 `<slug>-<ISO时间戳>[.md]`，边车缺失时按文件名还原 slug（兼容历史条目）。
  - 新增 `restoreFromTrash({path, dirs})`：优先边车记录的原始路径，缺失则回落到第一个技能根；同名冲突自动加 `-2/-3` 后缀；`EXDEV` 降级 `copy+rm`；恢复后删边车。
  - 新增 `emptyTrash({trashDir, dirs})`：永久清空，RPC 层要求 `confirm:true` 二次确认。
  - 新增 RPC：`skills.trash` / `skills.restore` / `skills.trashEmpty`。
  - 客户端「已安装」tab 底部新增「回收站」区块：列出条目（slug / 类型 / 时间戳）、逐个「恢复」、整站「清空回收站」。
  - 实测：边车恢复→原路径、无边车恢复→`legacy.md`（保留 .md）、同名冲突→`demo-2`、`emptyTrash` 清空归零；21 条历史回收站条目全部可正常列出。

## 0.5.57

- **新增「会话日志体检」**（路径 tab）：检测并一键修复 `session.v4.jsonl.zstd` 的「空 tool-call」永久损坏。
  - 新增 `src/session-repair.js`：自解析 DSH 的**串联 Zstandard 帧容器**（Node 的 `zstdDecompress` 只解第一帧，必须逐帧解），逐帧解码成 JSONL 事件。
  - 损坏判定只认已确认的那一类：`assistant/message` 里 `type:"tool-call"` 的 `id` 或 `name` 为空，或 `tool/call` 的 `callId`/`name` 为空，或某行不是合法 JSON。**不猜其它类别**，合法日志绝不会被误裁。
  - 修复 = 保留损坏点之前的全部事件，重新压成一帧后**原子写回**（`tmp` + `rename`），原文件自动备份为 `<file>.repair-<时间戳>`。
  - 新增 RPC：`sessions.scan`（`{deep, limit}`，浅扫列大小、深扫逐帧检测）、`sessions.repair`（`{file, dryRun}`）。
  - 实测：对三份真实损坏日志（seq 2502 / 2807 / 2984）全部精准定位；修复后 seq 2983 `step/start` 收尾、单帧、2985 条事件、零解码错误；12 个正常会话零误报。

## 0.5.56

- **安装改为「暂存 + 原子提交」**：先在 `<root>/.staging-<slug>-<ts>` 写全部文件与 `.market-install.json`，核对无误后 `rename` 到正式目录（同卷原子）；任何一步失败只清暂存，**正式目录零残留**。跨卷 `EXDEV` 降级 `copy + rm`，失败同样只清暂存。
- **安全扫描改为报告制（不拒装）**：`scanSkillBundle` 仍执行，高危命中不再抛错，改为随安装结果返回 `findings` 与 `scanStats`，由界面提示用户自行确认。
- 移除 `lobehub` / `modelscope` 分支里重复的预扫描拒绝逻辑（统一由 `writeSkill` 报告）。
- `uploadSkillFromFolder` 的 `copyOne` 同步改为暂存 + 原子提交 + 报告制。
- 新增同名保护：非 `force` 安装时若正式目录已存在，明确报错而不是静默覆盖。
- 清理未使用的 `describeFindings` 导入。

## 0.5.54

- **移除「预览」功能**：详情按钮已覆盖"看介绍"需求（内置浏览器 tab 打开来源站完整详情页，比 tarball 下载快且信息更全），预览按钮与预览弹层（`skills.preview` 客户端调用路径、`preview`/`previewModal` state、卡片「预览」按钮、预览模态）全部移除。
- `index.js` 的 `skills.preview` RPC 保留（服务端能力，不影响客户端；其他客户端/自动化仍可调）。
- `client.js` 卡片操作行现为：「详情」+「安装 / ✓ 已安装 / 仅可浏览」。

## 0.5.33

- **修复 trusttools CLI 命令名**：`trusttools` CLI 的安装命令是 `add` 而非 `install`（`trusttools add <source> -g`），0.5.30 的 `installViaTrustToolsCli` 使用了不存在的 `trusttools install` 子命令，会导致 CLI 安装路径永远失败并回退 GitHub。修正为 `npx -y trusttools add <reference> -g`。
- **修复 skillhub 安装 reference 映射**：`client.js` `doInstallSkill` 中 skillhub 条目的 `reference` 之前走 `item.upstreamUrl || item.id` 默认分支，当 `upstream_url` 为空时 `item.id`（`skillhub:facebook/react/test`）带前缀传给 `npx skillhub install` 会失败。修正为 `item.reference || item.upstreamUrl || item.id`，优先使用 `skillhub.js` 新增的 `reference` 字段（canonicalName，无 `skillhub:` 前缀）。
- **`installViaSkillHubCli` 防御性 strip 前缀**：即使传入带 `skillhub:` 前缀的 skill-id，也会自动 strip，确保 CLI 调用成功。

## 0.5.32

- **skillhub 安装改用官方 `skillhub` CLI**（用户 m14629 确认 skillhub CLI 无需注册登录即可搜索和安装）：
  - `src/cli-install.js` 新增 `installViaSkillHubCli`：`npx -y skillhub install <skill-id> --target-dir <targetRoot>`，自动下载 CLI（无需预装、无需认证）；安装到 `<targetRoot>/<skill-name>/`；timeout 180s；失败时回退 GitHub。
  - `src/skillhub.js` 条目 `installable` 不再依赖 `upstream_url`，改为 `Boolean(canonical || raw.slug)`；新增 `reference: canonical || raw.slug` 字段供 CLI 安装使用。
  - `src/skills.js` skillhub 分支由 GitHub 直下改为调用 `installViaSkillHubCli`，CLI 失败仍回退 GitHub（`upstream_url` 存在时）。
  - 官方 CLI 接受 `owner/slug` 格式的 skill-id（如 `facebook/react/test`），与 SkillHub API 的 `namespace.canonicalName` 直接匹配。

## 0.5.31

- **clawhub 安装改用官方 `clawhub` CLI**（用户 m14469 反馈「clawhub 有官方 CLI，为什么选择 HTTP API 下载 ZIP？」）：
  - `src/cli-install.js` 新增 `installViaClawHubCli`：`npx -y clawhub install <owner/slug> --dir <targetRoot> --no-input`，自动下载 CLI（无需预装），安装到 `<targetRoot>/@<owner>/<slug>/`；timeout 180s；失败时回退 GitHub。
  - `src/skills.js` clawhub 分支由 `installViaClawHubApi`（HTTP API 下载 ZIP）改为 `installViaClawHubCli`（官方 CLI）。
  - 官方 CLI 支持 `owner/slug` 格式输入，与 dsh-market clawhub 条目的 `reference` 字段直接匹配。

## 0.5.30

- **browse.sh 安装路径修复**（用户反馈 browse.sh 条目显示「无可用下载地址」，但实际可通过官方 `browse` CLI 安装）：
  - `src/sources.js` `searchBrowseSh` 条目 `installable` 由 `false` 改为 `true`，新增 `reference: raw.slug` 字段；`note` 改为「通过官方 browse CLI 安装（npx browse skills add）」。
  - `client.js` `doInstallSkill` 对 `browse.sh` 源使用 `item.reference`（原始 slug）作为安装引用；非可安装条目 status 显示改为 `item.note`（有 note 时）或「该条目没有可用的下载源」。
  - `src/skills.js` browse.sh 安装分支：CLI 失败时不再回退 GitHub（GitHub 上 browse.sh 技能仓库 404），改为抛出带指引的错误（提示安装 Node.js 22.18+ 并运行 `npm i -g browse`）。
  - `src/cli-install.js` `installViaBrowseShCli`：`npx -y browse` 自动下载 CLI（无需预装），timeout 延长到 180s；搜索目录扩展到所有 agent skills 目录 + `.browse/skills`；支持 slug 含 `/`（取 basename 匹配）；错误信息带 `npx browse skills add <slug>` 手动指引。
  - `client.js` `installable === false` 时 meta 行显示「· 仅可浏览」替代「· 无可用下载地址」。

## 0.5.29

- **lawhub.ai 不显示「详情」按钮**（用户 m10721 指令：skills.sh、lawhub.ai、browse.sh 不设详情功能）：
  - `client.js` `detailUrlFor` 新增 lawhub.ai 识别：`item.source === 'lawhub'` 或 homepage 匹配 `/lawhub\.ai$/i` 时返回空字符串，卡片上不渲染「详情」按钮。
  - 0.5.28 已处理 skills.sh / clawhub / browse.sh，本次补齐 lawhub.ai。

## 0.5.28

- **卸载回退到 `$AGENTS_HOME/skills/<slug>`**（用户 m11258 反馈「装在 SKILLS_HOME 下的技能无法卸载」）：
  - `src/skills.js` `uninstallSkill` 新增 `agentsHomeSkillsDir` 参数，在 skillDirs 找不到时回退到 `$AGENTS_HOME/skills/` 删除。
  - `index.js` 两处调用（`skill_market_uninstall` 工具 + `skills.uninstall` RPC）传入 `join(agentsHome(), "skills")`。
- **skills.sh / clawhub / browse.sh / lawhub.ai 不显示「详情」按钮**（用户 m11258 要求这四个源不设详情功能）：
  - `client.js` `detailUrlFor` 对 `skills.sh`、`clawhub`、`browse.sh` 源直接返回空字符串，卡片上不渲染「详情」按钮；`lawhub.ai` 通过 source 或 homepage 域名识别，同样不渲染；其他源保留。

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




