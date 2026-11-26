# 门提速层（方案 B / C / D）

> 用户 2026-11-24 21:45 定的口径：**B 主刀**（650s→100~150s）、**C 并行**（前提是 B 完成）、
> **D 必须保留 live 冒烟层**。这一页只讲怎么用、以及它的诚实边界。

## 是什么

`test/run-gate.mjs` 在 `DSH_REPLAY` 开启时，给每个套件子进程注入
`--import=<file:///…/test/replay/preload.mjs>`。预加载装两个东西：

1. **模块钩子**（`hooks.mjs`）——把 `src/http.js` 与网络型 `node:child_process` 调用
   整体换成替身（`http-replay.mjs` / `cp-replay.mjs`）。取证证明钩子命中
   **生产模块内部的相对导入** `./http.js`，所以**零生产代码改动**。
2. **`globalThis.fetch` 补丁**（`fetch-patch.mjs`）——覆盖绕过 http.js 的 14 处裸 fetch
   （实测清单在文件头注释里；钩子管不到「取全局对象再调用」这种写法）。

档案是一条请求一份 JSON，键 = `sha256(方法 + 归一化 URL + body)` 前 32 位
（`engine.requestKey`）。URL 归一化会解码 query 再按 key 排序重建，
所以 `cursor=a%2Fb` 与 `cursor=a/b` 是同一个逻辑键（00:36 实测：不归一化时补录永不收敛）。

## 怎么用

```powershell
# 一次性录制（真打上游，产出档案）。要冷缓存，见下面「录放条件必须一致」。
$env:DSH_REPLAY='record'; $env:DSH_REPLAY_DIR='<archive dir>'
node test/run-gate.mjs

# 回放（零网络，秒级）
$env:DSH_REPLAY='1'; $env:DSH_REPLAY_DIR='<archive dir>'
node test/run-gate.mjs

# 不设 DSH_REPLAY ⇒ 与改动前逐字一致（真网络门）。这是判据 8 锁住的行为。
node test/run-gate.mjs

# 只跑关心的套件（提速方案 A，一直都在）
$env:DSH_GATE_ONLY='test-global-sort.mjs,test-full-sort.mjs'
```

收敛循环（把档案补到能离线跑）：

```powershell
$env:DSH_REPLAY_DIR='<archive dir>'
$env:DSH_GATE_ONLY='<那 10 个慢套件>'
node test/replay/backfill.mjs
```

它每轮**回放 → 若门不绿或有未命中 → 重录 → 再回放**，直到「门全绿且 0 未命中」
或条数不再下降。

## 三条必须知道的边界

**① 未命中 = 红灯，绝不返回空。**
`REPLAY-MISS` 抛错并记账（`DSH_REPLAY_MISSLOG`）。门侧独立数账本条数，
只要 >0 就判该套件红——**不信套件自己怎么汇报**。实测（23:52）：空档案下
`test-global-sort` 把未命中降级成 skip、打印「4 passed, 0 failed, 3 skipped」并退出 0，
而录制态是「9 passed, 2 skipped」：**5 条判据静默蒸发**。若门只听汇总行就放行了，
正是本仓 CHANGELOG 写下过的「『绿』不等于『做了』」。**判据：`misses>0` 优先于 PASS。**

**② 录与放的条件必须逐字一致，尤其是缓存冷热。**
00:45 实测：同一份档案，热缓存下 paging 只 miss 1 条、冷缓存下 miss 24 条——
热态走的是「第二次读 p1 仍要能翻页」的短路径，覆盖面偏窄。
`backfill.mjs` 因此**每轮新建 `DSH_TMP` 缓存目录**。手工补录是无效的：
链型上游（MCP registry 的 cursor、clawhub 的 cursor）下一页由上一页响应决定，
隔时段补的那页属于另一代际的链（我连补三条，每轮换一个新游标值）。

**③ live 冒烟层不可被回放替代（方案 D）。**
回放证明的是「**逻辑**对着一份快照成立」，不是「**上游还是这个形状**。
上游形状漂移正是这类测试最该抓的事。所以要留 env 开关的真实联网层，先例：
`DSH_MS164_LIVE=1`（modelscope 上游真实性）、`DSH_LH_WIN_ONLY=off`（lobehub 平台分支）。
**发布前必须至少跑一次不带 `DSH_REPLAY` 的全量门**（或至少那 10 个真网络套件），
回放用于开发迭代期。CI 的 `npm test` 走的是真网络层——这是有意的。

## 必须知道的边界（④–⑧）

**④ cursor 链型套件的档案收敛靠「门重录轮」，不靠跨轮回放复用。**
01:11 实测（chain-walk.mjs 读 replay-snap 315 条）：clawhub skills 77 条记录里
cursor-bearing 73 条分属 **68 个不同的链代**（按响应 body 首 2 个 slug 分代），
首页 nextCursor 指向的下一页 hop1 就断——链型上游（clawhub / MCP registry）的
cursor 由上一页响应内容决定，隔时段抓到的任何一页都属于另一代际的链，
**手工补录永远补不齐**。所以这类套件（warmup / nocache / features）在收敛循环里
靠 round 1 重录轮吃满：重录轮内门与套件跑在同一时刻，链是完整的一代，
round 2 回放即 0 未命中（10 套件线实测 rounds=2 CONVERGED）。
推论：**cursor 链档案不能增量复用**——上游目录一动，旧链整代作废，必须整链重录。

**⑤ 全门空档案收敛的语义。**
「回放 0 未命中 + 门全绿」的收敛凭据只在**重录轮吃满之后**成立；
第一轮回放的 miss 数只用于确定红因分布（如 01:15 全门首轮 53/68 green · 54 条，
红因大头 full-sort 25 / sort-honesty 16 / total-pages 11 / sort-options 7 /
warm-budget 6 / func-fixes 1），不作为收敛或失败的判定。

**⑥ 门的 miss 账本语义 = 「意外逃逸的网络」，故意造 miss 的套件要自己隔离。**
门在回放态给每个子进程塞 `DSH_REPLAY_MISSLOG=<MISS_DIR>/.miss-<父pid>-<套件名>.log`
并按行数判 REPLAY-MISS。若某套件**故意**打未录请求来证守卫生效（如 test-gate-replay
的 Test 3 never-recorded=1），这条故意的 miss 会落进门为该套件开的账本 ⇒ 判据家在
回放态被自己的判据误红（01:48 / 01:52 两次实测：46/0/0 全绿却被门判「未命中 1 条」）。
撞车还是双向的：Test 10 跑真门时若不指定私有 `DSH_REPLAY_MISS_DIR`，它那 3 条 miss
会写进 Test 11 的账本，把「外层账本有内容」糊成假绿。⇒ **凡自己造 miss 的套件，
都要显式改 `DSH_REPLAY_MISSLOG` 或 `DSH_REPLAY_MISS_DIR` 到私有路径并在收尾删掉。**

**⑦ 本地夹具不是网络：认「孪生文件」形态，别指望 `DSH_REPLAY_CLI=off`。**
回放层截 `execFile` 的判据只看 argv 里有没有 npx/curl/npm，**看不出这条 npx 是真是假**。
套件常用的假 npx 夹具（`npx.cmd` 转发到同目录 `cli.cjs`）零网络，一旦被档案截住，
夹具不执行、它落盘的 `argv.json` 不存在 ⇒ 依赖 argv 的判据全红，而红的形状
（`argv=null`）与被测代码真的坏掉**完全一样**（02:05 实测九条）。
`fixtureShimActive()` 用「PATH 第一个 npx.cmd 目录里同时有 cli.cjs」放行；
整条旁路（`DSH_REPLAY_CLI=off`）代价是真 npx 打网络，实测 10 套件 11s→213s，所以只作逃生阀。
⇒ **新写夹具型套件时，夹具目录用纯 ASCII 路径**：`safeTempDir()` 在本机含中文用户名，
`npx.cmd` 以 UTF-8 写、cmd.exe 按 OEM 码页读 ⇒ 路径变 `C:\Users\??\` ⇒ 子 node
`ERR_MODULE_NOT_FOUND`（02:47 复现；真实套件同进程自写自读不受影响）。

**⑧ 录放分支不一致有两类，成因不同、解法也不同（06:30 实测更正）。**
`test-full-sort.mjs:274` 的聚合段带 `query='agent' + sort='installCount'`，回放态档案秒回、
该分支走通 ⇒ 发出 `ai.trusttools.cn/api/skills?…&search=agent` 的 page 1/2/3；
录制态这三条**从未发出**——不是进程 exit 掐死在途（单套件录制轮 188s 跑完仍 `present=false`），
而是聚合层给每源 12s 预算（`sources.js:550 DEFAULT_BUDGET_MS`）内 trusttools 回不来 ⇒
走 `skip` 分支 ⇒ 档案里永远没有这个键。`backfill --rounds=4` 每轮稳定 NOT-CONVERGED 即此因。
⇒ **A 类（预算挡掉的分支）：整链重录无效，只能绕过预算定向补录。**
直调 `searchTrustTools(...)`（不经 fanOutSources 预算）实测能拿到 14,345B 真字节并落档；
上游该端点**时好时坏**（05:27 成功、06:30 连四次 `python 取数失败`），
所以补录要么重试到成功形态，要么从别处已成功的档案搬同一 key 的记录
（schema/method/url 逐字一致才可搬）。**失败形态落档是允许的**——引擎会把录到的错误原样重现，
`page=3` 那条就是 ERR 形态，回放态如实走 degraded/skip，与真网络一致。
⇒ **B 类（cursor 链型）：定向补录无效，只能靠收敛循环在同一时刻吃满整条链**（见边界④）。
两类混在一起时按 miss 的 URL 形状分流：带 `cursor=` 的是 B，带固定 query 参数的是 A。
**顺带：回放态比真网络「多测」不是好事**——它意味着录放覆盖不一致，
要么把该分支的预算调成录制轮也能走通（`budgetOverrides` 形参已有、无 env 缝），
要么承认这条判据只在回放态成立。

## 睡眠不是慢：SUSPEND-SUSPECT
门的「被杀」判定原本只有 TIMEOUT 一种归因，于是**整机睡眠会被当成套件真慢**。
实测（2026-11-24 08:24）：`test-sort-honesty` 记成 `TIMEOUT 1524s`，而 `perTimeout=420s`；
Kernel-Power 事件 08:24:57 睡眠 / 08:50:21 唤醒，窗口正好 1524 秒。睡眠把杀定时器与
子进程一起冻住，`Date.now()` 照走。那条红当时被当成机制 bug 查了两版。

现在 `gateVerdict` 收 `ms/perTimeout/suspendGraceMs`：被杀且墙钟超出
`perTimeout + 宽限(默认 60s)` ⇒ **SUSPEND-SUSPECT**。仍算红灯（不替它放行），
但归因行会写「疑似整机睡眠 ⇒ 先单独复跑本套件确认，再谈机制」。
判据在 `test-gate-contract.mjs` Test 6（13 条，含一个真造 40s 假套件的端到端）。
`DSH_GATE_SUSPEND_GRACE_MS=0` 只为复现；生产必须 >0，否则正常被杀（ms 只超出
几十毫秒的关流延迟）也会被误报成睡眠。

## 本地动作不许冻进档案

`isNetworkCli` 只认 curl / npx / npm（以及 `cmd.exe /c` 里包着这些命令的命令行）；
git / tar / sh / node 一律放行回真。否则「`git ls-remote` 结果被档案糊住」这类
测试会绿得毫无意义。判据 6 锁这七条。

## 现状与待办

- **2026-11-26 复核（0.5.177 批内，先看这条再看下面）**：下面那段是 0.5.166 当时的读数，链已从 69 段长到 **78 段**，整门绿数随之变化，历史数字保留不改。
  档案实盘状态：`C:\Users\Public\dsh-scratch\replay-full2` **仍在**（实测 271 个文件 / 11,763,131 B，与本节记录的条数字节数逐字相符）；
  而本节承诺的仓库内第二份 `test/replay/store-full2/` **已不存在**（store / store-full / store-full2 三目录实测 absent，`store*/` 被 gitignore 故不会被提交带回来）。
  结论：所谓「档案必须留两份」在本机已退化成一份，换机/新克隆仍须自己 `DSH_REPLAY=record` 整门录一遍。判据不受影响——
  `test-gate-replay.mjs:43` 用的是 `join(safeTempDir(), "dsh-replay-" + Date.now())` 自造临时档案，不依赖本节任何一份历史档案。

- **全门可复现终数（07:05，69 套件、整门录制档案 replay-full2）：**
  · 录制轮 = 真网络整门一遍 `DSH_REPLAY=record` ⇒ `[GATE] 69/69 suites green` / `total 1076s`
  （`gate-all-record.txt`），档案 **271 条 / 11,763,131 B**。
  · 回放轮（**冷缓存**：每轮新建 `DSH_TMP` + 外层 `DSH_REPLAY_MISS_DIR`）⇒
  串行 `[GATE] 69/69 suites green` / `total 78s` / 墙钟 78s / 未命中 0 条；
  `DSH_GATE_PARALLEL=4` ⇒ `69/69 green` / `total 85s` / **墙钟 36s** / 未命中 0 条、exit=0。
  ⇒ **开发迭代期一遍全门 1076s → 36s（约 30×）**。此前 02:52/03:22 的数字依赖 replay-full/p4
  两份档案，已被 04:54 那次 scratch 清收删除，**从本行起以 replay-full2 为准**。
  ⚠️**档案必须留两份**：scratch 已被别的会话清收扫过两次（04:54 一次删掉 replay-full/p4 共 30MB 级），
  所以本轮起 `replay-full2` 除 `C:\Users\Public\dsh-scratch\` 外另存一份
  `test/replay/store-full2/`（`.gitignore` 的 `test/replay/store*/` 已把它和默认 store 一起排除，
  不会被 `git add -A` 收进提交）。档案没了就等于判据没了——数字还能写在 README 里，
  但下一个人复现不出来，那正是 04:54 之后我重录一轮的全部理由。
  · **两份只治本机，不治换机（07:28 实测后写清）**：仓库内副本 `DSH_REPLAY_DIR=$PWD\test\replay\store-full2`
  冷缓存复跑 ⇒ 串行 `69/69 green / total 80s / 墙钟 80s / 未命中 0`、`parallel=4` `69/69 / total 85s /
  墙钟 36s / 未命中 0`，与 07:05 的 scratch 档案数字逐字对得上 ⇒ 证明**搬目录不影响判据**。
  但 `store*/` 不进 git ⇒ **新克隆的人手上没有档案**，第一遍必然全门 REPLAY-MISS（那是守卫在起作用，
  不是回归）。换机唯一姿势=自己 `DSH_REPLAY=record` 整门录一遍（一次性 1076s 级），
  或把 `store-full2` 目录当构建产物手工带过去。别指望 `git clone` 自带回放能力。
  · 整门档案仍缺两类请求，本轮手工补齐（都属边界⑧的 A 类）：
  trusttools `…&search=agent` 的 page=1/2/3（12s 聚合预算挡掉，录制轮根本不发出；
  从 worktree 默认 store 按 key 搬成功形态）+ lobehub `market.lobehub.com/api/v1/skills/categories`
  （`index.js:1201` 的 fire-and-forget 冷词表补取，只在词表冷缓存时触发）。
  ⚠️**定向补录必须带 `--import=…/replay/preload.mjs`**：只设 `DSH_REPLAY=record` 而不注入预加载，
  生产侧 http.js 不会被替换 ⇒ 请求真打但**不落档**（07:00 实测：不带跑出 `OK cats= 246`、
  档案里搜不到该 URL；带上同键立刻落档 13,375 B）。这条坑比边界⑧本身更容易让人误判「补录无效」。
  ⚠️**live 一键验证（0.5.167 的 `test/live-verify.mjs`）必须不带 DSH_REPLAY 跑**：fetch-patch 截一切
  `http(s)` 含 `http://127.0.0.1` 的调用。07:38 主树实测两种姿势：不带 ⇒ `exit=4 / RESULT: STALE-SERVER /
  rows=14 LIVE-FAIL=1 GAP=2`（真问进程，判据成立）；带上我的 store-full2 ⇒ **`exit=1 / wall=0s /
  TypeError: Cannot read properties of undefined (reading 'slice')`，账本 12 条未命中**。
  ⚠️**但这条崩不是回放层造成的（07:41 对照实验定案）**：真网络态打一个死端口
  `node test/live-verify.mjs --port 59999` ⇒ **同样 exit=1 / TypeError … 'slice' 崩在同一行**。
  真因链在它自己脚本里：`rpc()` 把失败吞成 `json=null` ⇒ `shape()` 出 `categoryNote=undefined` ⇒
  `:214 JSON.stringify(undefined)` 返回 **undefined（不是字符串）** ⇒ `.slice` 炸。⇒ 只要 RPC 非 200
  （宿主没起 / 端口变了 / 超时）就没有 verdict，绕过 `:16` 自己声明的「3=NOT-RUN 判据未执行绝不写
  PASS/FAIL」。同形写法 `:219` 有 `|| []` 守卫所以没事。回放层只是让它更早撞到的一条路径，不是根因。
  链内入口只有离线纯函数套件 `test-live-verify.mjs`（07:37 回放态实测 **55 passed/0 failed/0 skipped、
  未命中 0 条**，`git show` 被 isNetworkCli 放行回真），两层互不干扰。
- **全门回放终态（02:52，68 套件、夹具识别与 Test 13 都落码后）：**
  · 串行 `DSH_REPLAY=1` ⇒ `[GATE] 68/68 suites green` / `total 45s`，墙钟 45s，外层账本 0 条未命中。
  · `DSH_GATE_PARALLEL=4` ⇒ `[GATE] 68/68 suites green` / `total 53s`，**墙钟 25s**（exit=0、账本 0 条）。
  · 真网络基线 `gate165-post.txt` = `[GATE] 67/67 suites green` / `total 1371s`。
  ⇒ **开发迭代期一遍全门 1371s → 25s（约 55×）**；档案 353 条 / 15.8 MB，放在仓库外。
  注：并发那轮 `total 53s` 大于墙钟 25s 是各套件墙钟求和（并发重叠），不是变慢。
- **rebase 到 0.5.166 之后（链 69 段 = 主树 68 + 我的 test-gate-replay）：**
  · `DSH_GATE_PARALLEL=4`（03:13）⇒ `[GATE] 68/69 suites green`，墙钟 35s、未命中 0 条；
  唯一红 `test-profile-sync.mjs 5 passed, 2 failed` = `work=0.5.166 profile=0.5.165`
  （目标会话 0.5.166 已提交但那一刻还没发到 profile），与回放层无关。
  · profile 装到 0.5.166 后复验（03:22，冷缓存 + 外层账本）⇒ `test-profile-sync 7 passed, 0 failed`，
  全门 **串行 `[GATE] 69/69 suites green` / `total 78s`**、`DSH_GATE_PARALLEL=4` 墙钟 35s，
  未命中 0 条。这条中间态被误当回归的风险，正是 03:13 那轮该读 profile 版本而不是读代码的理由。
  rebase 唯一冲突面是 `package.json` 的 `test:chain`：主树把 `test-sort-form-switch.mjs`
  加进链、我把 `test-gate-replay.mjs` 加进链 ⇒ 解法是两侧都留（69 段），
  用集合差核过「mine 独有 1 段 / head 独有 1 段」，没有静默丢段。
- **两条回放层真缺陷（已修，判据都在判据家）：**
  ① 套件自带的**假 npx 夹具被档案截走** ⇒ lobehub 九条读 argv 落盘的判据全拿 `argv=null`（02:05）。
  修法=`cp-replay.fixtureShimActive()` 认 PATH 首个 `npx.cmd` 目录里的孪生 `cli.cjs`，放行回真；
  逃生阀 `DSH_REPLAY_CLI=off` 实测**默认不能开**（那 10 套件从 11s 涨回 213s，档案 CLI 通道会整条旁路）。
  ② 我自己写的 Test 13 **首版是空判据**：子进程 `node -e` 直接 import `child_process` 不在
  `hooks.CP_PARENTS` 白名单内 ⇒ 走真 execFile ⇒ 关掉夹具识别照样全绿（02:38 变异实测）。
  改从生产入口 `searchLobeHubMarket` 打进去后，变异 ⇒ 46/2（红因 `REPLAY-MISS 054db3…` +
  `argv.json=(无)`），还原 ⇒ 48/0。**教训：判据家测替身层必须从生产入口进，不能自己直接调被截的 API。**
- **全门回放早期一轮（01:32，68 套件）：墙钟 43s**，对真网络 1064s（67 套件）。
  该轮 62/68 green，6 条红的判读（**都不算回放层缺陷**）：
  · test-func-fixes / test-paging / test-index-runtime 各「未命中 1 条」+
  test-lobehub-category-vocab 21 条红（`REPLAY-MISS … cmd.exe ["/d","/s","/c","npx -y @lobehub/market-cli …"]`）
  = **这份档案只录了那 10 个慢套件**，其余套件的请求本来就不在里面 ⇒
  红灯正是守卫在起作用（对照组：同一轮里没录到的裸 fetch/CLI 一个都没被当成空数据放行）。
  · test-profile-sync 2 条 = `work=0.5.164 profile=0.5.165`，我的分支基线是 558bbcd（0.5.164），
  合入主树后自然对齐，与回放无关。
  · test-gate-replay 1 条 = **我自己的判据姿势缺陷**：它问父进程 `engine.mode()`，
  而门给子进程传了 `DSH_REPLAY=1` ⇒ 在回放态跑门时必然假红。已改为问子进程
  （判据家 Test 8），两形态各 46/0。
- 10 个慢套件（占门 970s / 1064s）回放态实测 **≈3s**；其余 59 个本来就合计 3s。
- 档案 **不进 git**（13.3 MB，大头是 skills.sh sitemap 891KB×9 分片）；
  放在仓库外的目录，由 `DSH_REPLAY_DIR` 指过去。要长期用就得加一条「档案过期就重录」的
  节奏（建议：每次改 `src/**` 的取数逻辑后重录一轮）。
- 方案 C（并发）已落，**默认关**：`DSH_GATE_PARALLEL` 不设 ⇒ `limit=1` ⇒ 与串行版行为
  逐字一致（CI 路径不变，故不改 `perTimeout=420s`）。回放态实测（01:43，`parallel=4`，
  同样那 10 个慢套件）：`[GATE] total 11s across 10 suites`、**墙钟 4s**。
  归属核对：同四套件（含一个不在档案里的 lobehub 套件）在 `parallel=4` 与串行下
  逐字同结果——都是 `69 passed, 20 failed` + 账本 `.miss-<pid>-test-lobehub-category-vocab.mjs.log`
  **9 条**，另外三件 PASS 且各自账本零行 ⇒ 并发没把 A 的未命中串到 B 头上
  （账本按套件名分文件的直接收益，判据见 `test-gate-contract` Test 5）。
  真网络态不建议开：并发会污染计时类判据（warm-budget 的预算、latency-recovery 的延迟），
  理由写在 `test/gate-pool.mjs` 头注释。
