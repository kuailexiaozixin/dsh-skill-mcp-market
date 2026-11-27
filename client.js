// Client half of dsh-skill-mcp-market: a floating market panel registered into `shell.overlay`.
// No build step; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-skill-mcp-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;
    // 排序键中文标签。能力表本身来自服务端 settings.get 的 sortCapabilities —— 面板不再内联 CAPS 副本。
    // LABEL 刻意留在面板侧：test-sort-options Test 5 锁 '按星级'/'最新'/'最近更新' 字面量。
    const SORT_LABEL = {
      installCount: '按安装数', downloadCount: '按下载数', stars: '按星级', newest: '最新',
      updated: '最近更新', trending: '热门', name: '按名称', ratingAverage: '评分最高',
    };
    // caps=null 表示能力尚未到达 → 只给「默认顺序」，绝不猜键（猜键等于把硬编码换个位置）。
    // 按当前是否有查询词选择该源的能力分支（与 settings.get 的 browse/search 两套对应）。
    function capsFor(entry, hasQuery) {
      if (!entry) return null;
      return Array.isArray(entry) ? entry : (hasQuery ? entry.search : entry.browse);
    }
    // 搜索态/浏览态是两套能力：只在「用户没有显式指定排序键」时读当前查询词态（capsFor 同一口径）。
    // options.sort 由切源 chip、sort effect、搜索重发显式传入：调用方已经按那一刻的能力算过，
    // 这里再判一次会把「同一 sort 值 + 能力翻转」的重复请求退化成 default，服务端排序形同被面板改写；
    // 不判又会让浏览态点「按热门」后进搜索残留的 trending 原样发给上游（上游不认 trending，
    // 返回的是全目录序，而下拉框在搜索态本就不列「按热门」——控件与结果两张皮）。
    function keepSortForForm(sortKey, entry, hasQuery) {
      if (sortKey === undefined || sortKey === null || sortKey === 'default') return 'default';
      const caps = capsFor(entry, hasQuery);
      if (caps && caps.indexOf(sortKey) >= 0) return sortKey;
      return 'default';
    }
    // 连接生命周期文案。unknown 是诚实态：探测不到就不假装知道（回退到旧的布尔语义）。
    const PHASE_LABEL = { active: '· 已连接', loading: '· 启动中', failed: '· 连接失败', unloaded: '· 未挂载', unknown: '' };
    // 工具浮窗一次铺满几十个工具时，每输入一个字符都要重建整棵子树
    // （playwright-mcp 单连接器就有 22+ 个）。默认只渲染一批，余量靠「继续显示」增量展开。
    // ── 市场分页/缓存的纯函数区 ──────────────────────────────────────────
    // 这些都刻意放在组件之外：不碰 React 状态，测试可以直接 new Function 执行它们，
    // 而不是靠正则断言「代码长这样」。
    // 分页器页码窗口：已知总页数时 1 …（page±span）… N；未知总页数（cursor 型源）
    // 时退化为滑动窗口。
    // 分页摘要：数量必须来自真实集合（total），不能是硬编码标签。
    // live 实测到过「共约 第 1 / 1 页」—— 标签后面空着：skillsTotal 只被 set 从未被读，
    // 而 label 是写死的字符串，标签与数据源断链。规则：total<=0 不渲染数量子句
    // （0 命中显示「共约 0 个」是噪声），unknown（cursor 型源）绝不编造总页数。
    // 服务端报告的 total 只有「与页码无关」时才是可信的目录规模：旧版聚合层把未知
    // 兜底成 p*size+1（实测 13/25/37…721），而宿主永不重启意味着那份代码还在跑。
    // 客户端必须自己拦下来：与首页基准不一致的数字一律按未知处理 —— 宁可不显示
    // 数量，也不显示一个按页码算出来的假数。判据是结构性质（随页是否变化）。
    const trustedTotal = (reported, baseline, page) => {
      const p = Number(page) || 1;
      if (p <= 1) return reported;
      if (baseline === undefined || baseline === null) return undefined;
      return Number(reported) === Number(baseline) ? reported : undefined;
    };
    const pagerSummary = (o) => {
      const parts = [];
      if (o.label && o.total > 0) parts.push(o.label + ' ' + o.total + ' 个');
      if (o.unknown) parts.push('第 ' + o.page + ' 页（' + (o.hasMore ? '可继续加载' : '已是最后一页') + '）');
      else parts.push('第 ' + o.page + ' / ' + o.n + ' 页');
      return parts.join(' · ');
    };
    const pageWindow = (page, n, span) => {
      const items = [];
      const push = (v) => items.push(v);
      if (n === 0) {
        for (let i = Math.max(1, page - span); i <= page + span; i += 1) if (i >= 1) push(i);
        return items;
      }
      const lo = Math.max(2, page - span);
      const hi = Math.min(n - 1, page + span);
      push(1);
      if (lo > 2) push('…');
      for (let i = lo; i <= hi; i += 1) push(i);
      if (hi < n - 1) push('…');
      if (n > 1) push(n);
      return items;
    };
    // 跳页目标：输入框字符串 → 可跳转页码，0 表示不跳。回车与失焦共用它 —— 以前两条
    // 路径各写各的 clamp，回车拒绝越界、失焦却放行，同一个数字两种结果。
    const pageJumpOutcome = (raw, current, n, unknown) => {
      if (raw === '' || raw === null || raw === undefined) return { page: 0, reason: '' };
      const v = Math.trunc(Number(raw));
      if (!Number.isFinite(v) || v < 1) return { page: 0, reason: 'invalid' };
      if (!unknown && n > 0 && v > n) return { page: 0, reason: 'outOfRange' };
      if (v === current) return { page: 0, reason: 'samePage' };
      return { page: v, reason: '' };
    };
    // pageJumpTarget 保留旧签名，改为从 outcome 派生（两条路径不可能再各写各的 clamp）。
    const pageJumpTarget = (raw, current, n, unknown) => {
      return pageJumpOutcome(raw, current, n, unknown).page;
    };
    // 本次请求的每页条数：调用方可能带新 size（改「每页条数」时立刻传 nextSize），
    // 而外层 size 状态未必已更新。缓存键与请求参数必须用同一个数，否则键记旧尺寸、
    // 请求发新尺寸 —— 命中那个缓存项等于拿旧尺寸的结果冒充新尺寸。
    // 命名必须不是 size：const size = resolvePageSize(options, size) 会在同一块作用域
    // 遮蔽外层 size，右侧自引用直接 TDZ 崩溃。上限 60 与服务端 clamp 同口径。
    // 同一条件的在途请求去重：连按两次回车/搜索按钮不该各打一次上游（等待翻倍、
    // 结果同形）。append（追加下一页）的 cacheKey 是空串，绝不能参与去重 —— 空串
    // 一律放行，并且不写进集合。
    const shouldSkipInflight = (inflight, key) => {
      if (!key) return false;
      if (!(inflight instanceof Set)) return false;
      return inflight.has(key);
    };
    const resolvePageSize = (options, current) => {
      const raw = options && options.size !== undefined ? Number(options.size) : Number.NaN;
      if (!Number.isFinite(raw)) return current;
      const v = Math.trunc(raw);
      if (v < 1) return current;
      return Math.min(60, v);
    };
    // 缓存键：两个搜索入口各自内联模板串时维度很容易写漏（sk 原来就没有 size）。
    // 'all'/'' 与 'default'/'' 归一，让同一视图的两种写法不会算成两个缓存项 ——
    // 那等于同一条件重复发请求。
    // 运行时判别「正在跑的服务进程有没有这个 op」。绝不能看版本号：宿主永不重启,
    // 版本号只代表磁盘上装了什么，不代表进程加载了什么（实测运行态仍是 0.5.131 的
    // index.js，即 profile 已是 0.5.134，skillhub.evaluation 依然 unknown operation）。
    // 未知 op 走 switch default 抛 `unknown operation "<op>"`；其它错误（参数校验、
    // 网络、上游 5xx）都说明 op 存在、只是这次调用没成。
    const isUnknownOperation = (message) => /unknown operation/i.test(String(message || ''));
    // 探针用一次「明知参数不合法」的调用：新进程在参数校验阶段就返回（实测零上游、
    // <30ms），旧进程落到 default 抛 unknown operation。两种都不会真打上游。
    const probeOpPresent = async (callFn, op) => {
      try {
        await callFn(op);
        return true;
      } catch (e) {
        return isUnknownOperation((e && e.message) || e) === false;
      }
    };
    const skillCacheKey = (o) => {
      if (o && o.append) return '';
      const cat = o.category === 'all' ? '' : (o.category || '');
      return `sk|${o.source}|${o.query || ''}|${cat}|${o.page}|${o.size}|${o.sort || ''}`;
    };
    const mcpCacheKey = (o) => {
      if (o && o.append) return '';
      const cat = o.category === 'all' ? '' : (o.category || '');
      const sort = o.sort === 'default' ? '' : (o.sort || '');
      return `mc|${o.source}|${cat}|${sort}|${o.query || ''}|${o.page}|${o.size}`;
    };
    // ── 渐进式加载（harvest）消费者：服务端边到边返回，面板边到边渲染 ──────────
    // harvest.start 的入参与 skills.search 完全一致，返回首批 rows；此后每
    // HARVEST_POLL_MS 轮询 harvest.poll 取「到达序增量」，见到 final:true 的那包
    // 再整表替换成服务端有序全量（否则顺序会随到达先后跳动）。
    // 停止条件只有四个：final/done、被超车、会话被新搜索接管、卸载或手动取消。
    // 面板侧没有「超过 N 秒就停止加载」这种预算 —— 服务端总预算是 1 小时，提前
    // 截断会把还没到的真实结果说成「没有」。
    const HARVEST_POLL_MS = 250;

    // 会话控制格（组件里用 harvestCtlRef 持有）：timer 是唯一 harvest 定时器的句柄，
    // 排它一处（harvestWaitTick）、清它一处（harvestClearTimer），停止条件都过
    // harvestCancelSession / harvestDropSession，所以句柄不会泄漏，也不会同时跑两轮。
    // wake 是等待者的即时唤醒：接管/取消时不许把在途 Promise 晾着不落地，否则那一轮
    // 循环连同它的闭包会永远挂在内存里。
    const harvestClearTimer = (ctl) => {
      if (ctl && ctl.timer !== null && ctl.timer !== undefined) {
        clearTimeout(ctl.timer);
        ctl.timer = null;
      }
    };

    const harvestReleaseWaiter = (ctl) => {
      const w = ctl && ctl.wake;
      if (ctl) ctl.wake = null;
      if (w) w();
    };

    // 新会话接管：先清旧句柄并叫醒旧等待者，旧循环下一拍自检不过就自己退出。
    const harvestBeginSession = (ctl, token) => {
      harvestClearTimer(ctl);
      harvestReleaseWaiter(ctl);
      ctl.token = token;
    };

    const harvestCancelSession = (ctl) => {
      ctl.token = null;
      harvestClearTimer(ctl);
      harvestReleaseWaiter(ctl);
    };

    // 只有仍然持有槽位的那一轮才准清场：接管之后旧循环的出口必须什么都不动，
    // 否则它会把**新**会话的 token 抹掉，让新搜索的渐进加载莫名断流。
    const harvestDropSession = (ctl, token) => {
      if (ctl && ctl.token === token) harvestCancelSession(ctl);
    };

    const harvestIsOwner = (ctl, token) => !!(token && ctl && ctl.token === token);

    // 这个会话还活着吗：既要没被新的 harvest 接管，也要没被任何一次更新的技能请求
    // 超车（翻页/追加不接管 token，但同样该把上一包判成过期）。
    const harvestIsLive = (ctl, env) => harvestIsOwner(ctl, env.token) && env.seq === env.seqRef.current;

    // 等下一拍：面板里唯一排 harvest 定时器的地方。到点前被接管/取消会立刻醒来，
    // 调用方自检 token 后退出，既不重复排队也不把旧数据写进新视图。
    const harvestWaitTick = (ctl, token, ms) => new Promise((resolve) => {
      if (!harvestIsOwner(ctl, token)) { resolve(); return; }
      harvestClearTimer(ctl);
      ctl.wake = resolve;
      ctl.timer = setTimeout(() => {
        ctl.timer = null;
        ctl.wake = null;
        resolve();
      }, ms);
    });

    // 行 key：harvest 的行带 source+slug（与上游 rowKeyOf 同口径），一次性通路的行
    // 带 id。取不到 key 的行不参与去重 —— 宁可直接展示，也不误当成另一条的更新。
    const harvestRowKey = (x) => {
      if (!x) return null;
      if (x.id !== undefined && x.id !== null && x.id !== '') return String(x.id);
      if (x.source !== undefined && x.source !== null) return String(x.source) + '|' + String(x.slug);
      return null;
    };

    // 增量 upsert：同 key 覆盖、新 key 追加，返回新数组（不改入参）。列表长度因此
    // 单调不减 —— 判据「有多少显示多少、持续增加」锁的就是这条性质。
    const upsertHarvestRows = (rows, incoming) => {
      const out = (rows || []).slice();
      const at = new Map();
      for (let i = 0; i < out.length; i++) {
        const k = harvestRowKey(out[i]);
        if (k !== null && !at.has(k)) at.set(k, i);
      }
      for (const x of incoming || []) {
        const k = harvestRowKey(x);
        if (k === null) { out.push(x); continue; }
        if (at.has(k)) out[at.get(k)] = x;
        else { at.set(k, out.length); out.push(x); }
      }
      return out;
    };

    // call() 对响应顶层 ok:false 是抛错（见 call），而「服务端不认识这个 op」（老
    // 服务端）与「会话不存在或已过期」都必须走同一条回落，所以在这里归一成
    // { ok: false }，由调用方决定回落 —— 不把 harvest 的失败当成搜索的失败。
    const harvestCall = async (call, op, body) => {
      try {
        const d = await call(op, body);
        if (!d || d.ok === false) return { ok: false, data: d || null };
        return { ok: true, data: d };
      } catch {
        return { ok: false, data: null };
      }
    };

    // 与一次性通路同口径的视图键：totalBaseRef 用它记首页报告的 total 基准。
    const harvestViewKey = (env) => String(env.src) + '|' + String(env.q) + '|' + String(env.cat) + '|' + String(env.effSort) + '|' + String(env.pageSize);

    // 0.5.178 尾会话真分页（修「引入渐进式加载后，分页导航器失效」）——两个纯函数放在 island 区，
    // 让 harvest 消费者与组件的翻页分支共用同一份口径，不可能两处各算一套。
    // harvestPagesOf：总页数只按「已取回的行集」算，绝不按 upstreamTotal 算 —— 那个数是目录规模，
    // 不是本会话真能交付、真能翻页的行数。
    const harvestPagesOf = (count, pageSize) => {
      const n = Math.max(0, Math.trunc(Number(count) || 0));
      const s = Math.max(1, Math.trunc(Number(pageSize) || 1));
      return Math.max(1, Math.ceil(n / s));
    };
    // harvestSliceOf：取某一页。页码越界给空数组（诚实：那一页确实没有行），不复制末页冒充。
    const harvestSliceOf = (rows, pageSize, page) => {
      const list = Array.isArray(rows) ? rows : [];
      const s = Math.max(1, Math.trunc(Number(pageSize) || 1));
      const p = Math.max(1, Math.trunc(Number(page) || 1));
      return list.slice((p - 1) * s, p * s);
    };

    // 「等待不焦虑」的写法：渐进期间不挂 busy（列表持续变长本身就是进度），notice
    // 只在有 hints/降级/空表时披露原因；中间包最多说「陆续加载中」，绝不说完成；
    // final 之后按一次性通路同一口径收尾（真空表才给「没有找到匹配的技能。」）。
    const setHarvestNotice = (d, pkg, count, settled) => {
      const m = (pkg && pkg.meta) || {};
      const hints = (m.hints || []).filter(Boolean);
      // 未收口（中间包）：无论已到达几条都只说「陆续加载中」。0 条时绝不能提前讲
      // 「没有找到匹配的技能」—— 那是把还没到的结果说成不存在（诚实性红线）。
      if (!settled) {
        // 0.5.184 逐类进度改报「还有 N 个分类在取」：在取的是分类数，不是把各类上游条数相加的
        // 重叠虚高数（同一技能可属多个分类）。取数失败的类已终结，不计在取，收口后单独说明。
        if (m.tail && m.tail.categoriesTotal > 0) {
          const pending = Math.max(0, Number(m.tail.categoriesTotal || 0) - Number(m.tail.categoriesFetched || 0));
          d.setNotice(hints.length ? hints.join('；') : '（陆续加载中，已到达 ' + count + ' 条' + (pending > 0 ? '，还有 ' + pending + ' 个分类在取' : '') + '）');
          return;
        }
        d.setNotice(hints.length ? hints.join('；') : '（陆续加载中，已到达 ' + count + ' 条）');
        return;
      }
      if (!count) {
        const reasons = (m.sourceErrors || []).length
          ? m.sourceErrors
          : hints.length
            ? hints
            : (m.degraded || []).length
              ? [`部分来源不可用：${m.degraded.map((x) => x.source).join(', ')}`]
              : ['没有找到匹配的技能。'];
        d.setNotice(reasons.join('；'));
        return;
      }
      d.setNotice(hints.length ? hints.join('；') : '');
    };

    // final 包：整表替换为服务端有序全量（消除到达序造成的顺序跳动），并把
    // meta.finalMeta 的 total/pages/hasMore/serverFacet 一并落到分页器与 resultCache
    // （同一 cacheKey 口径）—— 数字与内容必须同步，不许沿用上一次搜索的旧值。
    // 中间包的 meta 里没有 total：那时计数一律标成未知(0)，绝不伪造总数。
    const applyHarvestFinal = (env, pkg) => {
      const d = env.deps;
      const rows = pkg.rows || [];
      const m = pkg.meta || {};
      // 0.5.182 症状2（用户 m28155）：「其他」合并入口收口时行集就是这个合并视图的全集——服务端 tail 分支
      // 把 finalMeta.total 归一到 rows.length（src/sources.js:1330-1331），只是可能不带 tail 对象（逐类只取
      // 第 1 页时一类不中 ⇒ tail 为空 ⇒ 走兜底）。老代码把「无 tail」当「非全集」：整表灌屏（首屏不受每页
      // 约束）+ 翻页落一次性通路（第 2 页起空白）。合并态翻页绝不能再打上游：那条请求体不带 tailCategories，
      // 服务端把 category 降级成整源浏览，回来的行没有一条属于合并集，本地筛必空。
      // 合并判据在门里算好经 env 传值：island 只依赖岛内符号与 env，测试装置摘录岛体才不会悬空引用。
      const mergedTailView = Boolean(m.tail) === false && env.tailMerged === true;
      if (env.cacheKey) {
        d.resultCacheRef.current[env.cacheKey] = {
          items: rows,
          pages: m.pages,
          total: m.total,
          hasMore: m.hasMore,
          serverFacet: Boolean(m.serverFacet),
          hints: m.hints || [],
          sourceErrors: m.sourceErrors || [],
          degraded: m.degraded || [],
          // 0.5.177：tail 声明随结果入缓存（C3 字段逐字）；无 tail 的包记 null，缓存命中时据此恢复或清声明。
          tail: m.tail || null,
          // 0.5.178：tail 收口的行集是该视图全集（服务端 src/sources.js:1326-1334 的 finalMeta 口径），
          // 记 wholeView 让翻页在本地切片；非 tail 收口的行集只是当页结果，绝不冒充全集。
          wholeView: Boolean(m.tail) || mergedTailView,
        };
      }
      // 0.5.177：服务端 tail 声明落会话 memo（P5：tail 态 visibleSkills 不做 covers 本地筛）。
      // 只在 final 收口时写：中间包不声明、失败回落不写，memo 永远不会先于事实。
      if (d.tailStateRef) d.tailStateRef.current = { src: env.src, q: env.q, cat: env.cat, tail: m.tail || null };
      // 0.5.178：整表上屏会让分页器报「第 1/N 页」而内容却是全集 —— 虚构页码（用户 m25083 的第二个根因）。
      // tail 收口是全集，必须按页切片；非 tail 收口本来就是当页结果，原样上屏。
      const wholeView = Boolean(m.tail) || mergedTailView;
      d.setSkills(wholeView ? harvestSliceOf(rows, env.pageSize, env.pageNo) : rows);
      d.setSkillsPage(env.pageNo);
      d.setSkillsTotalPages(wholeView ? harvestPagesOf(rows.length, env.pageSize) : (m.pages || 0));
      const k = harvestViewKey(env);
      d.setSkillsTotal(Number(trustedTotal(m.total, d.totalBaseRef.current[k], env.pageNo)) || 0);
      if (env.pageNo <= 1) d.totalBaseRef.current[k] = Number(m.total) || 0;
      d.setSkillsHasMore(wholeView ? false : Boolean(m.hasMore));
      d.setServerFacet(Boolean(m.serverFacet));
      setHarvestNotice(d, pkg, rows.length, true);
    };

    // 一个完整的渐进式会话：start → 首包立即渲染（不白屏、不等齐）→ 每 250ms 取增量
    // upsert → final 整表替换。
    // 返回 { settled: false } 表示「这包没法自己收尾，交回一次性通路」：调用方接手的
    // 正是原来那段 skills.search，所以回落恰好一次、且完全按旧路径渲染。
    const harvestFirstPage = async (ctl, env) => {
      const d = env.deps;
      harvestBeginSession(ctl, env.token);
      const started = await harvestCall(d.call, 'harvest.start', {
        query: env.text,
        source: env.src,
        // 同一次性通路：'all' 只是「不加分类过滤」的哨兵，绝不作为 category 下发
        // （CAT_OTHER 在 upstreamCat 那一行已经变成 'all'，这里再变成空串）。
        category: env.upstreamCat === 'all' ? '' : env.upstreamCat,
        page: env.pageNo,
        pageSize: env.pageSize,
        sort: env.effSort,
        // 0.5.177 逐类取数：合并态追加 tailCategories（covers=上游真 slug，服务端夹 400）。
        // 非合并态无此键：body 与旧口径逐键一致（C1/S1 判据）。
        ...(env.tailCovers ? { tailCategories: env.tailCovers } : {}),
      });
      if (!started.ok) { harvestDropSession(ctl, env.token); return { settled: false }; }
      if (!harvestIsLive(ctl, env)) { harvestDropSession(ctl, env.token); return { settled: true }; }
      let pkg = started.data || {};
      const sessionId = pkg.id;
      // 会话句柄只由 start 返回（poll 响应不回传 id）：先钉死再轮询，
      // 否则第二轮起带 undefined 会被服务端判成「会话不存在」而中断。
      let rows = upsertHarvestRows([], pkg.rows || []);
      if (pkg.final === true) { applyHarvestFinal(env, pkg); harvestDropSession(ctl, env.token); return { settled: true }; }
      d.setSkills(rows);
      d.setSkillsPage(env.pageNo);
      d.setSkillsTotalPages(0);
      d.setSkillsTotal(0);
      d.setSkillsHasMore(false);
      d.setServerFacet(false);
      // 首批上屏即摘 busy：此后靠列表持续增长与 notice 表达进度，不挂着「搜索中」。
      d.setBusy('');
      setHarvestNotice(d, pkg, rows.length, false);
      while (true) {
        // done 却没带 final:true = 服务端这包不是有序全量，不能拿增量当终态：
        // 交回一次性通路取权威结果（仍恰好一次）。
        if (pkg.done === true) { harvestDropSession(ctl, env.token); return { settled: false }; }
        await harvestWaitTick(ctl, env.token, HARVEST_POLL_MS);
        if (!harvestIsLive(ctl, env)) { harvestDropSession(ctl, env.token); return { settled: true }; }
        const res = await harvestCall(d.call, 'harvest.poll', { id: sessionId });
        if (!harvestIsLive(ctl, env)) { harvestDropSession(ctl, env.token); return { settled: true }; }
        if (!res.ok) { harvestDropSession(ctl, env.token); return { settled: false }; }
        pkg = res.data || {};
        if (pkg.final === true) { applyHarvestFinal(env, pkg); harvestDropSession(ctl, env.token); return { settled: true }; }
        rows = upsertHarvestRows(rows, pkg.rows || []);
        d.setSkills(rows);
        setHarvestNotice(d, pkg, rows.length, false);
      }
    };

    // 门的入口：harvestCall 已把 ok:false 归一成返回值，这里兜的是「harvest 消费者
    // 自己出异常」——那种情况也必须交回一次性通路，绝不能让 searchSkills 抛出去
    // （多个调用点不 await 它，抛出去就是 unhandled rejection + 面板白屏）。
    const harvestGate = async (ctl, env) => {
      try {
        const h = await harvestFirstPage(ctl, env);
        if (h && h.settled) return { settled: true };
      } catch {
        harvestDropSession(ctl, env.token);
      }
      return { settled: false };
    };
    const TOOL_BATCH = 60;
// 分批阈值必须 ≥ 单页上限（下拉里最大 48）：否则「首批」会把用户明确要求
// 的一页裁掉一半，那是拿性能名义偷内容。此前写 60 —— 大于任何可选页大小，
// 分批条件永不成立、纯属装饰（测试只锁了「首批≤阈值」这类性质，锁不住
// 「阈值本身是否合理」，所以补一条首批≥最大每页的不变量）。
const CARD_BATCH = 48;
// 0.5.182 症状1（m28155）：带 tailCategories 的尾会话增量包无视 pageSize（p182l 实测
// size=12 回 46 条、size=24 回 91 条），「每页 12/24」的失效点在卡片分批：分批单位
// 必须跟随每页选择器——每批 = cardStepFor(size) 张；CARD_BATCH 只当上限（下拉最大 48），
// 非法/越界每页值回落 48（不改变现网 24/48 的既得行为）。
const cardStepFor = (pageSize) => {
  const v = Math.trunc(Number(pageSize));
  return v > 0 && v <= CARD_BATCH ? v : CARD_BATCH;
};

// 分类 chip 一屏默认只放 32 个：这个数不是我们拍的，是上游站点自己列出的可见分类数——
// https://lobehub.com/zh/skills?category=all 左栏就是条数降序前 32 类（与上游词表前 32 类双向差集为空，
// 第 32 名 moltbook 368 条 vs 第 33 名 technical 72 条有断崖），覆盖 33.4 万条技能的 99.6%；词表全集
// 246 类里 rank>32 的 214 类合计仅 743 条。取 12 时窗口只覆盖 80.5%，把用户点名要看的分类（金融服务、
// 浏览器 & 自动化、游戏娱乐、智能家居…）全留在折叠外，报障在可见层面等于没修。
// 「其他」合并是产品决策：窗口外的 214 类不再逐个铺开（展开态给 246 个按钮不是筛选，是倾倒），
// 合并成一个「其他」chip 承接：条数=合并集合合计（上游真数），点进去由已取到的集合本地过滤，
// 上游没有可用的「其他」桶，这个 chip 是面板自造的合并入口，不代表任何一个上游分类。
// 0.5.174（用户 m20051 两态入口 + m00001 单入口）：展开/收起哨兵只给「尾巴够小」的源——合并类数
// <= CAT_TAIL_EXPAND_MAX 时展开态才铺得下全部上游真类（依据：skillsmp 63 类 tail=31 落阈内，
// 展开=真分类全集 + catsRow 限高纵向滚动）；lobehub 246 类 tail=214 落阈外，铺开既读不动也筛不动，
// 两态成员就完全相同，「展开分类」退化成装饰假控件（0.5.165 假控件同判）⇒ 干脆不渲染这个入口。
// 集合成员与哨兵在场性的判据：test-lobehub Test 8 装配段真跑 + 63 类小尾巴夹具。
const CAT_TAIL_EXPAND_MAX = 40;
const CAT_CHIP_FOLD = 32;
// 分类词表 → chip 的三件纯函数，放在组件外同一座「可测岛」上：不碰 React 状态，
// 测试用 new Function 直接执行函数体（与 capsFor/CARD_BATCH 同一口径）。
// 词表来自服务端抓的 skillsmp 类目页（随 settings.get 下发），页内派生 chip 永远保留：
// 词表抓不到是上游的事，把整个分类入口关掉不是兜底。
function mergeCategoryVocab(derived, vocab) {
  const rows = (vocab && Array.isArray(vocab.categories)) ? vocab.categories : [];
  // 上游类目页返回的是它自己的页面顺序，不是条数降序；面板只展示前 CAT_CHIP_FOLD 个 chip，
  // 照抄顺序会让窗口里留下 1.7 万条的入口、把 20 万条的挤到窗口外。这里按条数降序，
  // 条数相同保持页内相对顺序（V8 的 Array.prototype.sort 是稳定的），顺序因此仍然可复现。
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(b.r && b.r.totalAll) || 0) - (Number(a.r && a.r.totalAll) || 0)) || a.i - b.i)
    .map((x) => x.r);
  // 用户 m18814：上游自造的杂项桶夹在真分类中间，读起来像「本市场就这些类」，还和面板的合并入口撞名。
  // 桶一律沉到词表序末尾：条数降序只在真分类之间生效，桶始终垫底（同桶之间保持原相对顺序）。
  const isGenericBucket = (r) => {
    const s = String((r && r.slug) || '').trim().toLowerCase();
    const l = String((r && (r.name || r.label)) || '').trim().toLowerCase();
    return s === 'other' || s === 'others' || s === 'general' || l === '其他' || l === 'other' || l === 'others';
  };
  const ranked = [];
  const sunk = [];
  for (const r of ordered) (isGenericBucket(r) ? sunk : ranked).push(r);
  const sorted = ranked.concat(sunk);
  const out = [];
  const seen = new Set();
  for (const r of sorted) {
    const v = String((r && r.slug) || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    // name（skillsmp 中文标签）优先，label（clawhub 词表字段）次之，都没有才回落 slug。
    out.push({ value: v, label: String((r && (r.name || r.label)) || v), totalAll: Number(r && r.totalAll) || 0, fixed: true });
  }
  // 0.5.155 契约修正：词表取到了就只用词表，一个派生值都不追加。
  // 派生值来自 clawhubCategoryOf 的 topics[0] 兜底（作者自由填写的关键词），实测混进分类行的有
  // douyin、抖音、tiktok、kuaishou、json、ai-tools、database —— 与规范 14 类不是一个维度（平台名/
  // 文件格式/数据主题 vs「这技能干什么用」），douyin 与 抖音 还是同一事物的两种写法；且上游只认
  // 规范 slug，点这些 chip 实测回 HTTP 400，面板兜底后显示「已忽略分类筛选」，等于点了没用。
  // 只有词表一条都没取到（上游改版/抓取失败）才退回派生：那时分类入口仍要能用，不能关掉。
  if (rows.length === 0) {
    for (const d of (Array.isArray(derived) ? derived : [])) {
      const v = String(d || '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ value: v, label: v, totalAll: 0, fixed: false });
    }
  }
  return out;
}
function categoryChipLabel(value, vocab) {
  const v = String(value || '');
  const rows = (vocab && Array.isArray(vocab.categories)) ? vocab.categories : [];
  const hit = rows.find((r) => String((r && r.slug) || '') === v);
  return { value: v, label: hit ? String(hit.name || v) : v };
}
// 词表 chip 只在它所属的那个市场里出现。这份词表抓自 skillsmp 的分类页，slug 只有
// skillsmp 的上游认：在 skills.sh / clawhub 等市场下照样显示这排 chip，点上去只会得到
// 「所选来源不提供分类信息，已忽略分类筛选」或退成本地过滤当前页——那是把别家的分类
// 冒充本市场的，属于假陈述（用户 0.5.150 实测点名）。词表若自带来源字段且不是 skillsmp
// 的页面，即使当前源是 skillsmp 也不接受（防未来别处喂进来的词表串味）。
// 词表按市场归属：bySource 是 { skillsmp: {...}, clawhub: {...} }（settings.get 下发的分组形状）。
// 每个市场的词表只能来自它自己的页面，且只能显示在它自己的市场下——上游 slug 只有那一家认，
// 串到别处就是假分类（用户 0.5.151 点名）。词表自带 source 字段时必须与本市场前缀一致；
// 旧快照没落 source 时按可用处理（兼容 0.5.148/0.5.152 已写入的缓存）。
// 归属映射写在函数体内：这座岛的可测约定是「函数体能被 new Function 单独执行」，
// 提到模块级常量会让两份真实函数体的拼接执行拿不到它（本轮实测 CATEGORY_VOCAB_ORIGIN is not defined）。
function categoryChipsForSource(source, derived, bySource) {
  // trusttools 没有可抓的词表端点（上游超时），词表是服务端随包发的静态表，source 同样指向上游站点，
  // 所以归属核验与前两家走同一条规则，不做特例。
  const ORIGIN = { skillsmp: 'https://skillsmp.com/', clawhub: 'https://clawhub.ai/', trusttools: 'https://ai.trusttools.cn/', lobehub: 'https://market.lobehub.com/', modelscope: 'https://modelscope.cn/' };
  const key = String(source || '');
  if (!ORIGIN[key] || !bySource || typeof bySource !== 'object') return mergeCategoryVocab(derived, null);
  // 两种下发形状都要吃：分组 { skillsmp, clawhub }（0.5.153 起），以及旧服务端那份未分组
  // 的单一快照 {capturedAt,source,categories}。面板会热更新而宿主进程内的服务端要等重启，
  // 「新面板 + 旧服务端」是真实存在的中间态——当时实测 skillsmp 的带条数 chip 整排消失。
  // 旧形状按它自己的 source 认市场：只有 source 指向前缀与当前市场一致才生效（不串味）。
  const legacy = Array.isArray(bySource.categories);
  let vocab;
  if (legacy) {
    const owner = Object.keys(ORIGIN).find((k) => String(bySource.source || '').indexOf(ORIGIN[k]) === 0);
    if (owner !== key) return mergeCategoryVocab(derived, null);
    vocab = bySource;
  } else {
    vocab = bySource[key];
  }
  const rows = (vocab && Array.isArray(vocab.categories)) ? vocab.categories : [];
  if (!rows.length) return mergeCategoryVocab(derived, null);
  if (!legacy && vocab.source != null && String(vocab.source).indexOf(ORIGIN[key]) !== 0) return mergeCategoryVocab(derived, null);
  return mergeCategoryVocab(derived, vocab);
}
function categoryLabelLite(chip) {
  const label = String((chip && chip.label) || (chip && chip.value) || '');
  const n = Number(chip && chip.totalAll) || 0;
  return n > 0 ? label + ' ' + n.toLocaleString() : label;
}
// 窗内没列出的分类合并成一个「其他」入口（产品决策：246 类逐个铺开等于没做筛选）。
// 上游没有可用的「其他」桶（lobehub 词表里 general/Others 各 1 条，是被挡的自由标签），所以这个
// chip 是面板自造的：它不代表任何一个上游分类，条数也绝不从上游总量里编——只如实报「未列出的分类还有
// N 类 / 合计 M 条」（入口本体不带数字，数字进 title 与说明行），实际可列出的条目由已取到的集合
// 本地过滤得出（见 visibleSkills）；服务端按类逐个取数后改走 tail 口径。
const CAT_OTHER = '__cat_other';
// 展开态行尾的「收起分类」是渲染集合里的一个哨兵，不是分类值：它永远不进 category。
const CATS_COLLAPSE = '__cats_collapse';

// 尾巴合并入口的文案：0.5.177 起（用户 m23543/m23544）定名为「其他」，与上游词表里真叫「其他」的
// 类（lobehub general 1 条、modelscope slug=其他 2360 条）确实撞名，撞名由渲染层文本区分而不是改词：
// 面板入口 = 恰好「其他」二字、无数字无后缀（数字只在 title 与说明行）；上游自报杂项桶经
// categoryLabelLite 渲染自带条数（如「其他 2360」），并由 genericBucket/splitBuckets 沉底。
// 内部 value 仍是 __cat_other，任何情况下都不作为 category 下发。
const CAT_TAIL_LABEL = '其他';

function foldChips(vocabChips, limit, otherLabel) {
  const chips = [];
  for (const c of (Array.isArray(vocabChips) ? vocabChips : [])) if (c && c.value && c.value !== CAT_OTHER) chips.push(c);
  const cap = Number(limit) > 0 ? Number(limit) : chips.length;
  if (chips.length <= cap) return { window: chips, head: chips, tail: [], other: null, otherCount: 0, otherTotal: 0 };
  const head = chips.slice(0, cap);
  const tail = chips.slice(cap);
  let otherTotal = 0;
  const covers = [];
  for (const c of tail) { otherTotal += Number(c.totalAll) || 0; covers.push(c.value); }
  const other = { value: CAT_OTHER, label: String(otherLabel || CAT_TAIL_LABEL), totalAll: otherTotal, fixed: true, covers };
  // tail/head 外露：合并掉的类确实是上游真 slug，但 0.5.172（用户 m00001「不要每个类别单独显示」）起
  // 不再逐个成 chip：head 供展开态铺窗内全集，tail 的 slug 集既是本地并集筛的 covers，也是 0.5.177 起
  // 下发给服务端逐类取数的 tailCategories。
  return { window: head.concat([other]), head: head, tail: tail, other: other, otherCount: tail.length, otherTotal: otherTotal };
}
// 本地过滤空分类的出路（用户 m18814「部分类型标签的搜索结果为空」）：把分类名当关键词走全文搜索。
// 括号里/斜杠后的限定语要丢掉——「文档处理 (PDF/PPTX/DOCX)」整串去搜实测 0 条。
// 纯函数、无副作用、可被 new Function 真跑；近似搜索绝不冒充分类结果（文案必须写「近似」）。
function nearbySearchNeedle(chip) {
  const raw = String((chip && (chip.label || chip.value)) || '');
  const cut = raw.replace(/\s*[（(][^（()）]*[)）]\s*/g, ' ').replace(/\s*\/\s*[^\/]*$/, ' ').replace(/\s+/g, ' ').trim();
  return cut || raw.trim();
}

// 路径 tab 的降级模型：settings.get 失败（0.5.148 实测：缺 import 时每次必抛）只该让
// 「依赖它的那几个字段」变成未知，不该让整页消失——目录草稿本来就来自本地 state，
// 会话日志体检更是一个字段都不依赖 settings。旧写法把整个 tab gate 在 settings 上，
// 于是三者一起消失，用户看到的就是「路径面板异常空白」。
function pathsView(settings, skillDraftText, mcpDraftText) {
  const rows = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const loaded = Boolean(settings && settings.settings);
  const unknown = '未知（settings.get 未返回）';
  return {
    loaded,
    showPathsSection: true,
    showSessionSection: true,
    skillRows: rows(skillDraftText),
    mcpRows: rows(mcpDraftText),
    configPath: (loaded && String(settings.settings.settingsPath || '')) || unknown,
    providerLabel: !loaded ? unknown : (settings.skillProvider && settings.skillProvider.mounted ? '已挂载' : '未挂载'),
    clientLabel: loaded && settings.shipped && settings.shipped.mcpClient ? String(settings.shipped.mcpClient) : unknown,
    degradedNote: loaded ? '' : 'settings.get 这次没取到数据（原因见上方红字）。目录草稿与会话日志体检仍可用；配置文件路径、provider 与 MCP 客户端状态要等它恢复后才显示。',
  };
}
    // 市场卡片分批：每批 = 每页条数（cardStepFor(size)，0.5.182 起跟随每页选择器），
    // 点「继续显示」再放一批；CARD_BATCH 只当上限（选择器最大 48）。
    // 每页最多 48 条，一次提交整页卡片意味着输入一个字符就重建几十个节点。
    const shownCards = (list, batch, step) => {
      const s = (typeof step === 'number' && step > 0 && step <= CARD_BATCH) ? step : CARD_BATCH;
      return list.slice(0, Math.max(1, Math.trunc(batch) || 1) * s);
    };
    // 已装技能排序：纯前端呈现序，与来源分组正交（分组归属仍由 rank 决定）。
    // default 必须原样返回——服务端顺序本身有含义，不能悄悄重排。
    function sortInstalled(items, mode, isOff) {
      if (!mode || mode === 'default') return items;
      const nameOf = (x) => String(x.name || x.slug || '');
      const byName = items.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN'));
      if (mode === 'name') return byName;
      if (mode === 'on' || mode === 'off') {
        const wantOff = mode === 'off';
        return byName.slice().sort((a, b) => {
          const ao = isOff ? isOff(a) === true : false;
          const bo = isOff ? isOff(b) === true : false;
          if (ao === bo) return 0;
          return wantOff === ao ? -1 : 1;
        });
      }
      return byName;
    }
    // ── 窄屏判据（参照 Issue #71 的双层结构）──────────────────────────────
    // 「窗口宽 ≠ 面板宽」是这里的物理事实：面板挂在宿主主区里，左侧会话栏占掉一截，
    // 900-1100px 的窗口下面板可能只有 ~650px。所以两层判据都留着：
    // 视口宽供首帧直接用（不闪一下），面板宽由 ResizeObserver 事后校准。
    const NARROW_VIEWPORT_WIDTH = 820;
    // 面板阈值：技能工具行控件合计 ~420px（input minWidth120 + select 96 + 按钮×2 + gap），
    // 低于 560 必然挤，留一档余量给滚动条与内边距。
    const NARROW_PANEL_WIDTH = 560;

    // 卡片计数「有值才显示」之外还要认同源：实测上游真实数据的 installs 与 downloads
    // 永不相等（clawhub 同一行 installs=12,282 / downloads=283,509），所以两数完全相等
    // 只可能是服务端把 downloads 复制进了 installs（0.5.134 已在服务端修掉）。宿主永不
    // 重启，旧进程仍在复制，因此客户端自己拦：那种情况下不显示安装数，绝不显示错数。
    // 详情弹层的安装数走同一判据（原本 0 会显示「安装 0」，现在与卡片一致不显示）。
    const visibleCounts = (item) => {
      const inst = Number(item && item.installs) || 0;
      const down = Number(item && item.downloads) || 0;
      const out = { installs: inst || null, downloads: down || null };
      if (!inst || (down && inst === down)) out.installs = null;
      return out;
    };
    function readNarrowViewport() {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(max-width:' + NARROW_VIEWPORT_WIDTH + 'px)').matches === true;
      } catch { return false; }
    }
    // 工具检索：名称或描述命中即可。单一实现，标题计数/清单/无匹配提示共用，避免三处口径漂移。
    function toolMatches(tool, query) {
      if (!query) return true;
      const q = String(query).toLowerCase();
      return ((tool && tool.name ? tool.name : '') + ' ' + (tool && tool.description ? tool.description : '')).toLowerCase().includes(q);
    }
    // 批量结果汇总：逐项 RPC 循环最容易写出「全成功文案，实际第 3 项抛错」的假陈述。
    // 诚实规则：成功数只算 ok 项；有失败必须报数与原因；全失败不得出现成功计数。
    function summarizeBatch(label, results) {
      const rows = Array.isArray(results) ? results : [];
      const okRows = rows.filter((r) => r && r.ok);
      const failRows = rows.filter((r) => !r || !r.ok);
      const parts = [];
      if (okRows.length > 0) parts.push(`已${label} ${okRows.length} 项`);
      if (failRows.length > 0) {
        parts.push(`${failRows.length} 项失败`);
        const reason = String((failRows.find((r) => r && r.error) || {}).error || '').slice(0, 120);
        if (reason) parts.push(`（${reason}）`);
      } else if (rows.length === 0) {
        parts.push('没有可操作的项');
      }
      return { okRows: okRows.length, failRows: failRows.length, hasFailure: failRows.length > 0, text: parts.join('，') };
    }
    // 路径缩写：把用户主目录换成 ~，卡片才不会把长路径中段截断（悬浮给全文）。
    // home 由调用方传入（settings.settings.homeDir，服务端下发）——本函数在 factory 作用域，
    // 拿不到组件 state，绝不能依赖全局变量猜。
    function shortPath(p, home) {
      const text = String(p || '');
      const base = String(home || '');
      const flat = (x) => x.replace(/\\/g, '/');
      if (base && text.toLowerCase().startsWith(base.toLowerCase())) return '~' + flat(text.slice(base.length));
      return flat(text);
    }
    // 回收站时间戳：ISO 的 2026-11-20T01-03-31-951Z 读不出含义，转成 11-20 09:03。
    function formatStamp(stamp) {
      const raw = String(stamp || '');
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(raw);
      if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
      const iso = raw.replace(/(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2.$3Z');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
      const pad = (x) => String(x).padStart(2, '0');
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function sortOptions(caps, defaultLabel) {
      const out = [h('option', { key: 'default', value: 'default' }, defaultLabel || '默认顺序')];
      if (caps) for (const k of caps) out.push(h('option', { key: k, value: k }, SORT_LABEL[k] || k));
      return out;
    }

    const RPC = '/api/dsh-market/rpc';

    async function call(op, payload) {
      // A hung response must surface as an error instead of an endless spinner.
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload || {}) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(300000),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `HTTP ${response.status}`);
      }
      return data;
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: 'var(--dsh-text-primary, #1f2328)',
      },
      launcher: {
        height: 40,
        padding: '0 16px',
        borderRadius: 20,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-surface, #ffffff)',
        color: 'inherit',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(0,0,0,.16)',
        fontWeight: 600,
      },
      panel: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      },
      pane: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      dim: {
        padding: 24,
        color: '#888',
        fontSize: 14,
        textAlign: 'center',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsh-border, #eaeef2)',
        // 宿主面板容器才是真正的滚动容器时，只有 sticky 能让标签栏留在视口里
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--dsh-surface, #ffffff)',
      },
      tab: (active) => ({
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: active ? 'var(--dsh-surface-raised, #f0f3f6)' : 'transparent',
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        color: 'inherit',
      }),
      // 管理面板内的二级页签：下划线式，与主 tab 的药丸形成层级差
      subTab: (active) => ({
        padding: '4px 10px',
        border: '0',
        borderBottom: '2px solid ' + (active ? 'var(--dsh-accent, #3b82f6)' : 'transparent'),
        background: 'transparent',
        fontWeight: active ? 700 : 500,
        fontSize: 12,
        cursor: 'pointer',
        color: 'inherit',
      }),
      body: {
        flex: 1,
        overflow: 'auto',
        padding: '12px 18px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        alignItems: 'stretch',
        // 更粗、更深的竖直滚动条（WebKit）
        scrollbarWidth: 'thin',
        scrollbarColor: '#5a636e #eef1f4',
        '&::-webkit-scrollbar': { width: '12px' },
        '&::-webkit-scrollbar-track': { background: '#f0f2f4' },
        '&::-webkit-scrollbar-thumb': {
          background: '#5a636e',
          borderRadius: 6,
          border: '2px solid #f0f2f4',
        },
        '&::-webkit-scrollbar-thumb:hover': { background: '#3d444d' },
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      // 用户报障（m18209）：分类 chip 铺开 6 行，卡片只剩 3 行没法浏览。默认收成一行横向滚动，
      // 行尾给展开/收起；展开态回到 S.row 多行铺开。只加一个样式，不动 S.row 本身（57 处在用它）。
      chipRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden', paddingBottom: 2 },
      // 展开态限高 + 内部纵向滚动：246 类铺开曾把卡片区挤出屏幕（用户 m18800「怎么还是搞这么多分类」）。
      catsRow: { display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', maxHeight: 116, overflowY: 'auto', overflowX: 'hidden' },
      // 搜索行吸顶：吸附在标签栏（约 48px）之下
      // 搜索栏固定：它和标签栏一样在滚动容器之外，滚动时永不移位

      // 类型 / 分类标签栏：与搜索栏同样在滚动容器之外，滚动时常驻
      filterBar: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '0 18px 8px 12px',
        borderBottom: '1px solid var(--dsh-border, #eaeef2)',
        background: 'var(--dsh-surface, #ffffff)',
      },
      searchBar: {

        display: 'flex',

        gap: 8,

        alignItems: 'center',

        padding: '8px 18px 8px 12px',

        borderBottom: '1px solid var(--dsh-border, #eaeef2)',

        background: 'var(--dsh-surface, #ffffff)',

      },
      // auto-fill：宽面板自动多列、窄侧边栏自动降到 2/1 列，不再固定三列把按钮挤成两行。
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(272px, 1fr))', gap: 10, alignContent: 'start', alignItems: 'start' },
      chip: (active) => ({
        // 0.5.169 现网缺陷（中文分类名）：chipRow 是 flexWrap:'nowrap'，flex 子项默认 flex-shrink:1
        // ⇒ 一行放不下时被压缩；中文词的 min-content 宽度只有一个字，于是「开发工具」被压成一列一字
        // 竖排（lobehub 的英文 slug 整词不可断，掩盖了这个缺陷）。chip 是短标签按钮，永远不许压缩折行。
        whiteSpace: 'nowrap',
        flexShrink: 0,
        padding: '4px 10px',
        borderRadius: 999,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: active ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: active ? '#fff' : 'inherit',
      }),
      input: {
        flex: 1,
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-input-bg, #fff)',
        color: 'inherit',
        font: 'inherit',
      },
      card: {
        minWidth: 220,
        border: '1px solid var(--dsh-border, #eaeef2)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      title: { fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      desc: { opacity: 0.75, fontSize: 12, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      meta: { display: 'flex', gap: 6, fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
      btn: (kind) => ({
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: kind === 'primary' ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: kind === 'primary' ? '#fff' : 'inherit',
      }),
      status: { fontSize: 12, opacity: 0.75 },
      err: { fontSize: 12, color: '#c62828' },
    danger: { color: '#c62828', borderColor: 'rgba(198, 40, 40, 0.45)' },
    btnRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap', width: '100%' },
    };

    // 每个目录一行：多目录时逐行渲染，避免 \n 在 <input> 里被吞掉、两行粘成一行
    function setPathRows(label, values, onValues) {
      // values: 已换行拼接的字符串；每行一个目录，各占一行、各自可编辑，改完整块写回。
      const lines = String(values || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const write = (idx, text) => {
        const next = lines.slice();
        next[idx] = text;
        onValues(next.filter(Boolean).join('\n'));
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { width: 64, opacity: 0.7, fontSize: 12, alignSelf: 'flex-start', marginTop: 4 } }, label),
        lines.map((line, idx) =>
          h('input', {
            key: idx,
            style: { ...S.input, width: '100%' },
            value: line,
            onChange: (e) => write(idx, e.target.value),
          }))
      );
    }
    function Market(props) {
      const [tab, setTab] = useState('skills');
      // 管理面板子页签：记忆上次停留页（参照 dsh-skill-mcp-panel 的 last-tab 模式），
      // localStorage 不可用时静默退化为技能页。
      const MANAGE_TAB_KEY = 'dsh-market:manage-tab';
      const readManageTab = () => {
        try { return localStorage.getItem(MANAGE_TAB_KEY) === 'mcp' ? 'mcp' : 'skill'; } catch { return 'skill'; }
      };
      const [manageTab, setManageTab] = useState(readManageTab);
      const switchManageTab = (next) => {
        setManageTab(next);
        try { localStorage.setItem(MANAGE_TAB_KEY, next); } catch { /* 隐私模式等场景静默 */ }
      };
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      // MCP 安装/保存的实时进度：{ serverName, waitedMs, tools } | null
      const [installProgress, setInstallProgress] = useState(null);
      const [skills, setSkills] = useState([]);
      const [mcps, setMcps] = useState([]);
      // null = 还没加载完，[] = 真的一个都没装。两者混用会让首帧谎报「(0)」。
      const [installed, setInstalled] = useState(null);
      const [mounted, setMounted] = useState(null);
      const [settings, setSettings] = useState(null);
      const [sortCaps, setSortCaps] = useState(null);
      // 服务端分类词表（index.js settings.get 顺带下发）；null = 还没取到，chip 退回页内派生。
      const [categoryVocab, setCategoryVocab] = useState(null);
      // 当页分类筛选是不是上游做的：为真时列表不再二次本地过滤（见 visibleSkills）。
      const [serverFacet, setServerFacet] = useState(false);
      // 可选 op 的运行时可用性：null=还没探过；探过之后每个 op 一个布尔。
      // 入口只有在确认服务端有这个 op 时才渲染 —— 探测前与探测失败都不得画出按钮。
      const [opStatus, setOpStatus] = useState(null);
      const [skillDraft, setSkillDraft] = useState('');
      const [mcpDraft, setMcpDraft] = useState('');
      // { slug, missing: string[] } — the connector needs values before it can start
      const [envPrompt, setEnvPrompt] = useState(null);
      const [envDraft, setEnvDraft] = useState({});
      // { kind: 'skill'|'mcp', slug, data } — detail drawer with the edit form
      const [detail, setDetail] = useState(null);
      const [draft, setDraft] = useState({});
      // searchSkills/searchMcps 的 useCallback 依赖是 []，直接读 state 会闭包住首帧的值。


      const [source, setSource] = useState('clawhub');
      const [mcpSource, setMcpSource] = useState('registry');
      const [mcpCategory, setMcpCategory] = useState('all');
      const [mcpSort, setMcpSort] = useState('default');
      const [mcpPage, setMcpPage] = useState(1);
      const [mcpTotalPages, setMcpTotalPages] = useState(0);
      const [mcpHasMore, setMcpHasMore] = useState(false);
      const [mcpTotal, setMcpTotal] = useState(0);
      const [mcpCategories, setMcpCategories] = useState([]);
      const [size, setSize] = useState(24);
      // 市场卡片分批游标（第 n 批 = n × cardStepFor(size) 张，0.5.182 起跟随每页选择器）
      const [cardBatch, setCardBatch] = useState(1);
      const [sort, setSort] = useState('default');
      const [category, setCategory] = useState('all');
      // 分类 chip 展开态：本次浏览的临时动作，一律默认收起（用户 m18209 报障口径；m19770 复审：
      // 落 localStorage 会让宿主重启后每次开面板都全量展开，只剩限高兜底——不持久化）。
      const [catsExpanded, setCatsExpanded] = useState(false);
      const [pageJump, setPageJump] = useState('');
      const [mcpPageJump, setMcpPageJump] = useState('');
      // 跳页被拒绝时的可见理由（两 tab 共用一个：同一时刻只有一个分页器可见）
      const [jumpNotice, setJumpNotice] = useState('');
      // 过滤词按子页签拆开：旧实现一个词同时过滤技能与 MCP，切页签互相污染
      const [manageSkillFilter, setManageSkillFilter] = useState('');
      const [manageMcpFilter, setManageMcpFilter] = useState('');
      useEffect(() => {
        // 视口判据：matchMedia 变化直接跟（首帧已经用过一次，这里只处理后续变化）。
        let offMedia = null;
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            const media = window.matchMedia('(max-width:' + NARROW_VIEWPORT_WIDTH + 'px)');
            const onChange = () => setNarrowViewport(media.matches === true);
            if (media && typeof media.addEventListener === 'function') {
              media.addEventListener('change', onChange);
              offMedia = () => media.removeEventListener('change', onChange);
            } else if (media && typeof media.addListener === 'function') {
              media.addListener(onChange);
              offMedia = () => media.removeListener(onChange);
            }
          }
        } catch { /* 拒绝 matchMedia 的环境只丢视口判据，面板判据仍在 */ }
        const el = panelRef.current;
        if (!el) return () => { if (offMedia) offMedia(); };
        const measure = () => setNarrowPanel(el.clientWidth < NARROW_PANEL_WIDTH);
        measure();
        if (typeof ResizeObserver === 'undefined') {
          // 没有 RO：面板宽只在首帧测一次，视口判据兜住后续窗口变化（宿主侧栏拖拽不跟，
          // 属极端降级环境的已知边界，不假装全能）。
          setNarrowPanel(el.clientWidth < NARROW_PANEL_WIDTH);
          return () => { if (offMedia) offMedia(); };
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { ro.disconnect(); if (offMedia) offMedia(); };
      }, []);
      // 状态筛选维度：all | on | off（值持久化，与折叠偏好同一风格）。
      const SKILL_STATE_KEY = 'dsh-skill-mcp-market.manage-skill-state';
      const SKILL_SORT_KEY = 'dsh-skill-mcp-market.manage-skill-sort';
      const [manageSkillState, setManageSkillState] = useState(() => {
        try {
          const v = window.localStorage.getItem(SKILL_STATE_KEY);
          return v === 'on' || v === 'off' ? v : 'all';
        } catch { return 'all'; }
      });
      // 上传是低频动作：默认收起，点「＋ 添加技能」才展开；拖拽热区升到整个列表容器。
      const [uploadOpen, setUploadOpen] = useState(false);
      const [dragOver, setDragOver] = useState(false);
      // 批量多选（Task D-1）：Set 存 slug；筛选变化时旧选择仍保留，
      // 但计数与动作只作用于「当前可见」的选中项（selectedVisible），筛掉的项绝不偷偷参与批量。
      const [batchMode, setBatchMode] = useState(false);
      const [selected, setSelected] = useState(() => new Set());
      const [batchConfirm, setBatchConfirm] = useState(false);
      // 就地错误：上传失败显示在浮层内（页面级 error 槽在视口上方，用户视线不在那）。
      const [uploadError, setUploadError] = useState('');
      const uploadRef = useRef(null);
      // 原文编辑：默认不加载（原文会暴露 env 真实值，detail 的掩码在这里失效）。
      // { serverName, text, filePath, hasSecrets, loading, error, dirty }
      const [mcpRaw, setMcpRaw] = useState(null);
      // 手动添加 MCP（E-2）：与市场安装并列的第二条入口，全字段表单。
      const [mcpAdd, setMcpAdd] = useState(null); // null | { open }
      const [mcpAddDraft, setMcpAddDraft] = useState({});
      const [mcpAddConfirm, setMcpAddConfirm] = useState(false);
      // 编辑抽屉：原始值快照（diff 判据）+ 两步确认的「已武装」态。
      const [mcpDraftOrig, setMcpDraftOrig] = useState(null);
      const [mcpConfirmArmed, setMcpConfirmArmed] = useState(false);
      // 窄屏自适应：视口判据首帧生效，面板判据由 ResizeObserver 校准（见模块级注释）。
      const [narrowViewport, setNarrowViewport] = useState(readNarrowViewport);
      const [narrowPanel, setNarrowPanel] = useState(false);
      const panelRef = useRef(null);
      // 回收站默认折叠成一行（数量已在标题里），不再常驻占首屏。
      const TRASH_OPEN_KEY = 'dsh-skill-mcp-market.trash-open';
      // 浮层三路关闭：✕ 按钮（渲染里）、Escape、点击浮层外。监听只在打开时挂，关闭即摘除。
      useEffect(() => {
        if (!uploadOpen) return;
        const onKey = (e) => { if (e.key === 'Escape') setUploadOpen(false); };
        const onDown = (e) => {
          // 触发按钮必须豁免：mousedown 先关、重渲染后 click 的 !uploadOpen 又开 → 闪回。
          if (e.target && e.target.closest && e.target.closest('[data-upload-trigger]')) return;
          if (uploadRef.current && !uploadRef.current.contains(e.target)) setUploadOpen(false);
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
          window.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown);
        };
      }, [uploadOpen]);

      const [trashOpen, setTrashOpen] = useState(() => {
        try { return window.localStorage.getItem(TRASH_OPEN_KEY) === '1'; } catch { return false; }
      });
      const [collapsedGroups, setCollapsedGroups] = useState(() => {
      // searchSkills/searchMcps 的 useCallback 依赖是 []，直接读 state 会闭包住首帧的值；


        // 折叠偏好跨面板重挂载与刷新保留；拒绝存储的浏览器只是不记忆
        try {
          const raw = window.localStorage.getItem('dsh-skill-mcp-market.collapsedGroups');
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      });
      // 这面镜子在每次渲染时同步最新选择，回调里读它拿到的是当前值而不是初值。
      const liveRef = useRef({});
      // sortCaps 也进快照：searchSkills 的 useCallback 依赖里不放它（否则能力表一到就换函数，
      // tab effect 会把整页列表再搜一次），但「浏览态选了热门、进搜索态」这一判定必须读当前能力。
      liveRef.current = { source, category, size, mcpSource, mcpCategory, mcpSort, sortCaps };
      // 会话日志体检：检测并修复「空 tool-call」导致的会话永久损坏
      const [sessionScan, setSessionScan] = useState(null);
      const [sessionBusy, setSessionBusy] = useState('');
      // 回收站：列出/恢复/清空（删除是移入 .trash，不是真删）
      const [trashList, setTrashList] = useState(null);
      // MCP 连接器回收站：卸载已把定义写入 <mcpDir>/.trash，这里把它显性化并可恢复
      const [mcpTrashList, setMcpTrashList] = useState(null);
      const [mcpTrashBusy, setMcpTrashBusy] = useState('');
      // 已装 MCP 的工具清单浮窗：{ serverName, toolDetails, mounted } | null
      const [mcpTools, setMcpTools] = useState(null);
      const [mcpToolOpen, setMcpToolOpen] = useState('');
      // 浮窗里的工具检索词（几十个工具的连接器需要筛）
      const [toolQuery, setToolQuery] = useState('');
      // 工具级禁用草稿：打开浮窗时从 deniedTools 预勾，保存走 mcp.tools.set。
      const [toolDenyDraft, setToolDenyDraft] = useState([]);
      const [toolDenyApplied, setToolDenyApplied] = useState(0);
      // 工具浮窗分批游标（第 n 批 = n × TOOL_BATCH 个）
      const [toolBatch, setToolBatch] = useState(1);
      // 已装技能排序（持久化与「状态筛选」同一路径：拒绝存储的浏览器只是不记忆）
      const [manageSkillSort, setManageSkillSort] = useState(() => {
        try {
          const v = window.localStorage.getItem(SKILL_SORT_KEY);
          return v === 'name' || v === 'on' || v === 'off' ? v : 'default';
        } catch { return 'default'; }
      });
      // 无法解析的定义文件：readDefs 会跳过它们，面板必须说出来，否则用户以为连接器被删了
      const [mcpBroken, setMcpBroken] = useState([]);
      const [trashBusy, setTrashBusy] = useState('');
      // 最近一次的查询结果缓存（按 tab+source+category+sort+query 作 key），
      // 切源/改查询时若命中就立即渲染缓存、后台再刷新，避免每次切源都白屏重查。
      const resultCacheRef = useRef({});
      // 上游没有取消接口，所以「乱序落地」只能在应用点拦：每次请求取一个序号，
      // 回来后若已被更新的请求超车，就整段丢弃 —— 否则先发的慢请求会覆盖后发的结果，
      // 列表与用户最后选择的源/页不符（这是正确性问题，不只是等待问题）。
      const reqSeqRef = useRef(0);
      // MCP 侧同一个缺陷（切源时先发的慢请求覆盖后发），但用独立计数器：技能请求
      // 只应被更新的技能请求超车，不该被切到 MCP tab 的那次请求抹掉。
      const mcpSeqRef = useRef(0);
      // 在途请求集合（技能/MCP 各自一份，与各自序号计数器同侧）：同 key 的第二次
      // 请求直接不发；请求结束（成功或失败）后在 finally 里清掉，否则该条件永久被跳过。
      const inflightRef = useRef(new Set());
      const mcpInflightRef = useRef(new Set());
      // 每个视图（源+词+分类+排序+每页数）首页报告的 total 基准：后续页与它不一致
      // 就说明那个数是按页码算出来的，客户端不显示数量子句（见 trustedTotal）。
      const totalBaseRef = useRef({});
      const [nativeDirs, setNativeDirs] = useState([]);
      // 技能市场的分页：每个源都支持真正的翻页，页数/总数由后端这一页返回的元数据决定
      const [skillsPage, setSkillsPage] = useState(1);
      // 与 mcpTotalPages 同口径：0 = 未知总页数（pager 走窗口式）。首个响应到来之前
      // 不得宣称「已知共 1 页」—— 那是凭空编造的页数。
      const [skillsTotalPages, setSkillsTotalPages] = useState(0);
      const [skillsTotal, setSkillsTotal] = useState(0);
      const [skillsHasMore, setSkillsHasMore] = useState(false);
      // 渐进式加载会话槽：定时器句柄 / 等待者 / token 三态都在这一个 ref 里，卸载时
      // 统一清掉（助手在 factory 作用域，见 trustedTotal 附近），否则被超车或卸载后
      // 那个 250ms 定时器会一直转，把旧搜索的增量写进新视图。
      const harvestCtlRef = useRef({ timer: null, wake: null, token: null });
      // 0.5.177 其他类逐个取数：未列出的分类的 slug 集合（下发用）与服务端 tail 声明（展示用）。
      const tailCoversRef = useRef(null);
      const tailStateRef = useRef(null);
      useEffect(() => () => {
        if (typeof harvestCancelSession === 'function') harvestCancelSession(harvestCtlRef.current);
      }, []);

      const gotoPage = (p) => {
        p = Math.max(1, Math.min(p, 1 << 30));
        // 翻页必须带上当前 tab 的全部查询条件：旧写法技能侧漏 category/sort、MCP 侧
        // 漏 source/category/sort，全靠 searchX 里的 liveRef 兜底 —— 一旦兜底取值与
        // 界面不一致（state 更新竞态），翻页就会静默换条件。显式传参消除这层隐式依赖。
        if (tab === 'skills') searchSkills(query, { source, category, size, page: p, sort });
        else searchMcps(query, { source: mcpSource, category: mcpCategory, sort: mcpSort, size, page: p });
      };

      const pager = (page, totalPages, hasMore, label, total, jumpState, setJumpState) => {
        const unknown = !totalPages; // 注册表按 cursor 走，没有可数的总页数
        const n = unknown ? 0 : Math.max(1, Math.trunc(totalPages) || 1);
        // 回车与失焦共用这一个入口：拒绝必须留下可见理由，成功跳转则清掉旧提示。
        const applyJump = (setJumpState) => {
          const o = pageJumpOutcome(jumpState, page, n, unknown);
          setJumpState('');
          if (o.page) { setJumpNotice(''); gotoPage(o.page); return; }
          if (o.reason === 'invalid') setJumpNotice('请输入有效页码');
          else if (o.reason === 'outOfRange') setJumpNotice('超出范围：共 ' + n + ' 页');
          else if (o.reason === 'samePage') setJumpNotice('已在第 ' + page + ' 页');
          else setJumpNotice('');
        };
        // 页码窗口：已知总数时显示当前页±5（省略号折叠）；未知总数时只显示±2
        // 页码窗口交给纯函数 pageWindow（module scope），行为与原 IIFE 完全一致。
        const pageItems = pageWindow(page, n, 5);
        const pageButtons = pageItems.map((v) =>
          v === '…'
            ? h('span', { key: 'ellipsis-' + v, style: { padding: '0 4px', opacity: 0.5 } }, '…')
            : h('button', {
              key: `pg${v}`,
              style: S.btn(v === page ? 'primary' : undefined),
              disabled: busy !== '' || v === page,
              onClick: () => gotoPage(v),
            }, String(v)));
        return h('div', { style: { ...S.row, justifyContent: 'space-between', padding: '4px 2px' } },
          h('div', { style: S.row },
            h('button', {
              style: S.btn(),
              disabled: page <= 1 || busy !== '',
              onClick: () => gotoPage(page - 1),
            }, '‹ 上一页'),
            pageButtons,
            h('button', {
              style: S.btn(),
              disabled: (unknown ? !hasMore : page >= n) || busy !== '',
              onClick: () => gotoPage(page + 1),
            }, '下一页 ›')),
          h('div', { style: S.row },
            h('span', { style: S.status },
              pagerSummary({ label, total, page, n, unknown, hasMore })),
            h('span', { style: { fontSize: 12, opacity: 0.6, marginLeft: 8 } }, '跳至'),
            h('input', {
              style: { ...S.input, width: 56, height: 26, textAlign: 'center' },
              type: 'number',
              min: 1,
              max: unknown ? '' : n,
              value: jumpState,
              placeholder: String(page),
              onChange: (e) => setJumpState(e.target.value),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return;
                applyJump(setJumpState);
              },
              onBlur: () => { applyJump(setJumpState); },
            }),
            jumpNotice ? h('span', { style: { fontSize: 12, color: 'var(--dsh-danger, #b42318)', marginLeft: 8 } }, jumpNotice) : null));
      };

      const loadInstalled = useCallback(async () => {
        const [s, m] = await Promise.all([call('skills.list'), call('mcp.list')]);
        setInstalled(s.items || []);
        setMounted(m.items || []);
        setMcpBroken(Array.isArray(m.broken) ? m.broken : []);
        return { s, m };
      }, []);

      const loadSettings = useCallback(async () => {
        const d = await call('settings.get');
        setSettings(d);
        setSortCaps(d.sortCapabilities || null);
        setCategoryVocab(d.categoryVocabulary || null);
        setSkillDraft((d.settings.skillDirs || []).join('\n'));
        setMcpDraft((d.settings.mcpDirs || []).join('\n'));
        setNativeDirs(d.settings.dshNativeSkillDirs || []);
      }, []);

      // 可选 op 清单：入口按「这个 op 可能不存在」写的都进这里，boot 各探一次。
      const OPTIONAL_OPS = ['skillhub.evaluation'];
      const probeOps = useCallback(async () => {
        const next = {};
        for (const op of OPTIONAL_OPS) next[op] = await probeOpPresent((name) => call(name, { slug: '' }), op);
        setOpStatus(next);
      }, []);
      const searchSkills = useCallback(async (text, options) => {
        // 回落到当前选中的源——否则回车/点「搜索」会退化成「全部来源」聚合
        const src = (options && options.source) || liveRef.current.source;
        const cat = (options && options.category) || liveRef.current.category || 'all';
        // 「其他」是面板自造的合并入口，不是上游任何一个分类 slug：把它当 category 发下去，
        // 上游会按不存在的 slug 过滤成 0 条（live 实测 category=__cat_other ⇒ n=0/total=0/
        // serverFacet=true），面板再配一句「上游不可达或响应超时」——把自造控件讲成网络故障。
        // 这里兜住任何残留状态（旧缓存 key、旧 liveRef）：自造 slug 一律按浏览态发给上游。
        const upstreamCat = cat === CAT_OTHER ? 'all' : cat;
        const q = String(text || '');
        const pageNo = (options && options.page) || 1;
        const pageSize = resolvePageSize(options, size);
        const append = Boolean(options && options.append);
        // 只有「首页」进缓存；翻页是增量追加，缓存它没有意义还会撑爆内存
        // 旧写法把 stars/newest/updated/trending 全塌成 ''，服务端根本收不到排序意图 →「选了没反应」。
        // 现在原样下发选中的键；default 仍映射 installCount（保持既有默认视图语义）。
        const capsNow = liveRef.current && liveRef.current.sortCaps ? liveRef.current.sortCaps : null;
        const reqSort = options && options.sort !== undefined ? options.sort : keepSortForForm(sort, capsNow && capsNow.skills ? capsNow.skills[src] : null, Boolean(String(text || '').trim()));
        const effSort = reqSort === 'default' ? 'installCount' : reqSort;
        const cacheKey = skillCacheKey({ source: src, query: q, category: cat, page: pageNo, size: pageSize, sort: effSort, append: Boolean(options && options.append) });
        // 0.5.178 尾会话真分页：harvest 收口时把该视图整集写进首页缓存并记 wholeView:true。这种状态下
        // 翻页绝不能再走一次性 skills.search —— 那条请求体不带 tailCategories，服务端把 category 降级成
        // 整源浏览，缓存命中分支于是把 tailStateRef 清成 null，visibleSkills 便把「其他」的无分类行全滤掉
        // （实测：翻页后列表空，用户 m25083 的第一个根因）。整集已在本地，就在本地翻。
        // 未收口 / 非整集（wholeView 不为 true）一律不接管，维持现通路；新自由名走 typeof 防御，
        // 摘录体测试桩拿不到 island 助手时自动回落旧通路（同 harvestGate 的用法）。
        const tailViewKey = skillCacheKey({ source: src, query: q, category: cat, page: 1, size: pageSize, sort: effSort });
        const tailView = pageNo > 1 && !append && typeof harvestSliceOf === 'function' ? resultCacheRef.current[tailViewKey] : null;
        if (tailView && tailView.wholeView === true && Array.isArray(tailView.items)) {
          const localSeq = ++reqSeqRef.current;
          setSkills(harvestSliceOf(tailView.items, pageSize, pageNo));
          setSkillsPage(pageNo);
          setSkillsTotalPages(harvestPagesOf(tailView.items.length, pageSize));
          setSkillsTotal(Number(tailView.total) || tailView.items.length || 0);
          setSkillsHasMore(false);
          setServerFacet(Boolean(tailView.serverFacet));
          if (typeof tailStateRef !== 'undefined' && tailStateRef && tailView.tail) tailStateRef.current = { src: src, q: q, cat: cat, tail: tailView.tail };
          if (typeof totalBaseRef !== 'undefined' && totalBaseRef) totalBaseRef.current[src + '|' + q + '|' + cat + '|' + effSort + '|' + pageSize] = Number(tailView.total) || tailView.items.length || 0;
          if (localSeq === reqSeqRef.current) setBusy('');
          return;
        }
        // 同条件已在途 → 这次直接不发（连按两次回车不该各打一次上游）。
        // 必须在取序号之前判定：若先 ++seq，这次被跳过的请求会把真正在途的那次
        // 标成「已过期」，它的结果反而被丢弃 —— 去重就变成了丢结果。
        if (shouldSkipInflight(inflightRef.current, cacheKey)) return;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        const seq = ++reqSeqRef.current; // 本次请求的序号（超车判定基准）
        if (cacheKey) inflightRef.current.add(cacheKey);
        // 命中缓存：立即渲染旧结果，不白屏；后台再刷新
        if (cached) {
          setSkills(cached.items || []);
          // 缓存的是「这一页」的结果：页码必须恢复成本次请求的那一页，而不是硬置 1 ——
          // 否则数据是第 3 页、分页器却显示「第 1 页」。
          setSkillsPage(pageNo);
          setSkillsTotalPages(cached.pages || 0);
          const skKeyCached = src + '|' + q + '|' + cat + '|' + effSort + '|' + pageSize;
          setSkillsTotal(Number(trustedTotal(cached.total, totalBaseRef.current[skKeyCached], pageNo)) || 0);
          if (pageNo <= 1) totalBaseRef.current[skKeyCached] = Number(cached.total) || 0;
          setSkillsHasMore(Boolean(cached.hasMore));
          setServerFacet(Boolean(cached.serverFacet));
          // 0.5.177：缓存命中恢复 tail 声明（cached.tail 由 applyHarvestFinal 写入）；无声明记 null。
          if (typeof tailStateRef !== 'undefined' && tailStateRef) tailStateRef.current = cached.tail ? { src: src, q: q, cat: cat, tail: cached.tail } : null;
          // 缓存命中先恢复旧结果；失败披露必须跟着它解释的那份结果一起复述，否则「缓存一
          // 跳、披露就消失」——上一轮空列表的诚实文案会被这里无条件 setNotice("") 抹掉。
          const cachedSe = cached.sourceErrors || [];
          const cachedHints = (cached.hints || []).filter(Boolean);
          if ((cached.items || []).length) {
            setNotice('（缓存，正在刷新…）');
          } else if (cachedSe.length) {
            setNotice(cachedSe.join('；'));
          } else if (cachedHints.length) {
            setNotice(cachedHints.join('；'));
          } else {
            setNotice('');
          }
        } else if (!append) {
          setBusy('skills.search');
        }
        setError('');
        // 渐进式加载门（首屏、非追加）：harvest.start / harvest.poll 任何一次返回
        // ok:false —— 含老服务端不认识该 op（响应顶层 ok:false，call() 抛错）——
        // 都原样交回下面这段一次性 skills.search：恰好回落一次、完全按旧路径渲染。
        // 多个调用点并不 await searchSkills，所以这扇门自己兜异常，永不 reject。
        // 测试桩只摘录本函数体、拿不到 factory 作用域的 harvest 助手，入口因此走
        // typeof 防御（同 probeOpPresent 的用法）：解不了就回落旧通路，不判红。
        if (pageNo <= 1 && !append && typeof harvestGate === 'function' && harvestCtlRef && harvestCtlRef.current) {
          const hres = await harvestGate(harvestCtlRef.current, {
            deps: { call, resultCacheRef, totalBaseRef, setSkills, setSkillsPage, setSkillsTotalPages, setSkillsTotal, setSkillsHasMore, setServerFacet, setNotice, setBusy, ...(typeof tailStateRef !== 'undefined' ? { tailStateRef } : {}) },
            seqRef: reqSeqRef,
            seq,
            text,
            src,
            q,
            cat,
            upstreamCat,
            pageNo,
            pageSize,
            effSort,
            cacheKey,
            tailCovers: (cat === CAT_OTHER && typeof tailCoversRef !== 'undefined' && tailCoversRef && Array.isArray(tailCoversRef.current) && tailCoversRef.current.length) ? tailCoversRef.current.slice(0, 400) : undefined,
            // 0.5.182 症状2：与上一行同一判据（合并集合确实下发给了服务端），岛内当整集视图用。
            // 门只读 CAT_OTHER、岛只读 env ⇒ 摘录岛体的测试装置拿不到未绑定的模块级名。
            tailMerged: typeof tailCoversRef !== 'undefined' && cat === CAT_OTHER && Array.isArray(tailCoversRef.current) && tailCoversRef.current.length > 0,
            token: {},
          });
          if (hres && hres.settled) {
            // 与下方 finally 同口径收尾：结束即让位，busy 只由最后一次请求收口。
            if (cacheKey) inflightRef.current.delete(cacheKey);
            if (seq === reqSeqRef.current) setBusy('');
            return;
          }
        }
        try {
          const d = await call('skills.search', {
            query: text,
            source: src,
            category: upstreamCat === 'all' ? '' : upstreamCat,
            page: pageNo,
            pageSize,
            sort: effSort,
          });
          const rows = d.items || [];
          // 被超车（更晚发出的同类请求已经回来）→ 整段丢弃，连缓存也不写：把过期
          // 结果塞进缓存会让下次命中同一个 key 时显示旧数据还标成「缓存」。
          if (seq !== reqSeqRef.current) return;
          if (cacheKey) {
            resultCacheRef.current[cacheKey] = {
              items: rows,
              pages: d.pages,
              total: d.total,
              hasMore: d.hasMore,
              serverFacet: Boolean(d.serverFacet),
              hints: d.hints || [],
              sourceErrors: d.sourceErrors || [],
              degraded: d.degraded || [],
            };
          }
          if (append) {
            // 追加去重：翻页边界上偶尔会重复返回同一条，去重后列表才不会原地重复
            setSkills((prev) => {
              const seen = new Set(prev.map((x) => x.id));
              return prev.concat(rows.filter((x) => !seen.has(x.id)));
            });
          } else {
            setSkills(rows);
          }
          setSkillsPage(d.page || pageNo);
          setSkillsTotalPages(d.pages || 0); // 0 = 未知总页数，pager 走窗口式
          const skKeyFresh = src + '|' + q + '|' + cat + '|' + effSort + '|' + pageSize;
          setSkillsTotal(Number(trustedTotal(d.total, totalBaseRef.current[skKeyFresh], pageNo)) || 0);
          if (pageNo <= 1) totalBaseRef.current[skKeyFresh] = Number(d.total) || 0;
          setSkillsHasMore(Boolean(d.hasMore));
          setServerFacet(Boolean(d.serverFacet));
          const hints = (d.hints || []).filter(Boolean);
          if (!(d.items || []).length) {
            // An empty market is either "no match", "needs a keyword" or "upstream refused us".
            const reasons = (d.sourceErrors || []).length
              ? d.sourceErrors
              : hints.length
                ? hints
                : (d.degraded || []).length
                  ? [`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`]
                  : ['没有找到匹配的技能。'];
            setNotice(reasons.join('；'));
          } else if (hints.length) {
            setNotice(hints.join('；'));
          } else if ((d.degraded || []).length) {
            setNotice(`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`);
          } else {
            setNotice('');
          }
        } catch (e) {
          if (seq !== reqSeqRef.current) return; // 过期请求的报错不该盖掉新结果
          setError(String(e.message || e));
        } finally {
          if (cacheKey) inflightRef.current.delete(cacheKey); // 结束即让位，否则该条件永久被跳过
          if (seq === reqSeqRef.current) setBusy(''); // 只由最后一次请求收口 spinner
        }
      }, [sort, liveRef, source, size]);

      const searchMcps = useCallback(async (text, options) => {
        const opts = options || {};
        const nextSource = opts.source || mcpSource;
        const nextCategory = opts.category !== undefined ? opts.category : mcpCategory;
        const nextSort = opts.sort !== undefined ? opts.sort : mcpSort;
        const nextPage = opts.page || 1;
        const nextSize = resolvePageSize(opts, size);
        // 首屏查询（非 append）命中缓存时立即渲染旧结果，后台再刷新，避免切源白屏
        const cacheKey = mcpCacheKey({ source: nextSource, query: text, category: nextCategory, sort: nextSort, page: nextPage, size: nextSize, append: Boolean(opts.append) });
        if (shouldSkipInflight(mcpInflightRef.current, cacheKey)) return;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        const mseq = ++mcpSeqRef.current;
        if (cacheKey) mcpInflightRef.current.add(cacheKey);
        if (cached) {
          setMcps(cached.items || []);
          // 恢复与这一份缓存绑定的分页元数据：切源再切回来时卡片和页码/总页数必须
          // 一起回来，否则卡片立刻出现、分页器还停在另一个源的页数上。
          setMcpPage(cached.page || nextPage);
          setMcpTotalPages(cached.totalPages || 0);
          const mcKeyCached = nextSource + '|' + text + '|' + nextCategory + '|' + nextSort + '|' + nextSize;
          setMcpTotal(Number(trustedTotal(cached.total, totalBaseRef.current[mcKeyCached], nextPage)) || 0);
          if (nextPage <= 1) totalBaseRef.current[mcKeyCached] = Number(cached.total) || 0;
          setMcpHasMore(Boolean(cached.hasMore));
          setNotice('（缓存，正在刷新…）');
        } else {
          setBusy('mcp.search');
        }
        setError('');
        try {
          const d = await call('mcp.search', {
            query: text,
            source: nextSource,
            category: nextCategory === 'all' ? '' : nextCategory,
            sort: nextSort === 'default' ? '' : nextSort,
            page: nextPage,
            size: nextSize,
          });
          const rows = d.items || [];
          // 同技能侧：被更晚发出的 MCP 请求超车就整段丢弃（连缓存也不写）。
          if (mseq !== mcpSeqRef.current) return;
          // 与下面 setMcpHasMore 共用同一个判定：缓存里必须存住这个信号，否则切源
          // 再切回时命中缓存只恢复了卡片与页数，hasMore 还停在上一个源的值上。
          const mcpMore = d.canLoadMore !== undefined ? Boolean(d.canLoadMore) : (d.page || nextPage) < (d.totalPages || 1);
          if (cacheKey) resultCacheRef.current[cacheKey] = { items: rows, categories: d.categories || [], page: d.page || nextPage, totalPages: d.totalPages || 0, total: d.total, hasMore: mcpMore };
          // Append must not repeat a card: the registry pages by version rows, so a server
          // may legitimately return a slug that is already on screen.
          setMcps(opts.append
            ? (prev) => {
                const seen = new Set(prev.map((m) => m.id || m.slug));
                return prev.concat(rows.filter((m) => !seen.has(m.id || m.slug)));
              }
            : rows);
          setMcpPage(d.page || nextPage);
          // totalPages 0 means the source cannot count pages (the registry is cursor-based);
          // canLoadMore is then the only honest signal.
          setMcpTotalPages(d.totalPages || 0);
          setMcpHasMore(mcpMore);
          const mcKeyFresh = nextSource + '|' + text + '|' + nextCategory + '|' + nextSort + '|' + nextSize;
          setMcpTotal(Number(trustedTotal(d.total, totalBaseRef.current[mcKeyFresh], nextPage)) || 0);
          if (nextPage <= 1) totalBaseRef.current[mcKeyFresh] = Number(d.total) || 0;
          setMcpCategories(d.categories || []);
          // The host reports catalogue degradation separately from "no match", so both the
          // reason and the still-usable path (install by registry name) reach the user.
          if (d.hint) setNotice(d.hint);
          else if (!(d.items || []).length) setNotice('没有找到匹配的连接器；可直接按注册表名称安装，例如 io.github.Async23/chrome-devtools-mcp。');
          else setNotice('');
        } catch (e) {
          if (mseq !== mcpSeqRef.current) return;
          setError(String(e.message || e));
        } finally {
          if (cacheKey) mcpInflightRef.current.delete(cacheKey);
          if (mseq === mcpSeqRef.current) setBusy('');
        }
      }, []);

      useEffect(() => {
        setError('');
        setNotice('');
        // 旧实现：任何 tab 都 loadInstalled + else 分支必打一次 MCP 市场搜索（3-40s 的无谓查询）。
        // 收紧为按需：installed 数据只在管理页需要；searchMcps 只在 MCP 市场页需要。
        loadSettings().catch((e) => setError(String(e.message || e)));
        // 探测本身失败（RPC 不通等）→ 空清单：所有可选入口一律不渲染，
        // 而不是留着「点了必失败」的假可控件。
        probeOps().catch(() => setOpStatus({}));
        if (tab === 'manage') loadInstalled().catch((e) => setError(String(e.message || e)));
        if (tab === 'skills') searchSkills('', { source, size });
        else if (tab === 'mcp') searchMcps('', { size });
      }, [tab, loadSettings, loadInstalled, searchSkills, searchMcps, probeOps]);

      // 排序变了 → 重新拉取当前 tab 的数据（不同排序返回不同顺序/结果）
      const prevSortRef = useRef(sort);
      useEffect(() => {
        if (tab !== 'skills' || sort === prevSortRef.current) return;
        prevSortRef.current = sort;
        setSkills([]);
        searchSkills(query, { source, size, page: 1, sort });
      }, [sort, tab]);

      // 质量评测入口：只在点开时打一次上游（列表零额外请求）。不可达时显式告知，
      // 不伪造分数、也不用 downloads/stars 凑一个「质量」。
      const openSkillQuality = async (item) => {
        const id = String((item && (item.namespace || item.slug)) || '');
        if (!id) { setError('该条目缺少 skillhub 标识，无法查询评测'); return; }
        setBusy('quality:' + id);
        setError('');
        try {
          const data = await call('skillhub.evaluation', { slug: id });
          setDetail({ kind: 'quality', slug: String(item.slug || id), data });
        } catch (e) {
          setError('SkillHub 质量评测暂不可达：' + String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };
      const openSkillDetail = async (slug) => {
        setBusy(`detail:${slug}`);
        setError('');
        try {
          const data = await call('skills.detail', { slug });
          setDetail({ kind: 'skill', slug, data });
          setDraft({ name: slug, description: '', body: data.content });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      // 显式点开才读原文：不加载时用户看到的仍是掩码视图。
      const openMcpRaw = async (serverName) => {
        setMcpRaw({ serverName, text: '', filePath: '', hasSecrets: false, loading: true, error: '', dirty: false });
        try {
          const d = await call('mcp.raw.get', { serverName });
          setMcpRaw({ serverName, text: d.text, filePath: d.filePath, hasSecrets: Boolean(d.hasSecrets), loading: false, error: '', dirty: false });
        } catch (e) {
          setMcpRaw({ serverName, text: '', filePath: '', hasSecrets: false, loading: false, error: String(e.message || e), dirty: false });
        }
      };

      const saveMcpRaw = async () => {
        if (!mcpRaw || !mcpRaw.dirty) return;
        setMcpRaw({ ...mcpRaw, loading: true, error: '' });
        try {
          const r = await call('mcp.raw.set', { serverName: mcpRaw.serverName, text: mcpRaw.text, confirm: true });
          // 保存成功与连接成功分开播报：原文可以合法但连不上，那时不能说「已保存并重连」。
          if (r.connected) setNotice(`已保存并重连 ${mcpRaw.serverName}，${(r.tools || []).length} 个工具`);
          else if (r.pending) setNotice(`已保存 ${mcpRaw.serverName}，连接器仍在启动中，稍后在卡片查看工具数`);
          else setNotice(`已保存，但未连上：${r.connectError || '未知原因'}`);
          setMcpRaw(null);
          await loadInstalled();
        } catch (e) {
          setMcpRaw((prev) => (prev ? { ...prev, loading: false, error: String(e.message || e) } : prev));
        }
      };

      const openMcpDetail = async (serverName) => {
        setBusy(`detail:${serverName}`);
        setError('');
        try {
          const data = await call('mcp.detail', { serverName });
          setDetail({ kind: 'mcp', slug: serverName, data });
          const rowsOf = (map) => Object.entries(map || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
          setDraft({
            command: data.command || '',
            args: (data.args || []).join('\n'),
            url: data.url || '',
            transport: data.transport || 'stdio',
            cwd: data.cwd || '',
            toolCallTimeoutMs: data.toolCallTimeoutMs == null ? '' : String(data.toolCallTimeoutMs),
            envRows: rowsOf(data.env),
            headerRows: rowsOf(data.headers),
          });
          // 原始快照：env/headers 的值此时可能仍是掩码字面量，diff 时按它比对。
          setMcpDraftOrig({
            command: data.command || '',
            args: (data.args || []).join('\n'),
            url: data.url || '',
            transport: data.transport || 'stdio',
            cwd: data.cwd || '',
            toolCallTimeoutMs: data.toolCallTimeoutMs == null ? '' : String(data.toolCallTimeoutMs),
            envRows: rowsOf(data.env),
            headerRows: rowsOf(data.headers),
          });
          setMcpConfirmArmed(false);
          setMcpRaw(null);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      // 点卡片本体：读 mcp.detail 的 toolDetails（宿主 definition 的 name/description/parameters）。
      // 纯读操作，不连接、不重启连接器；未挂载时 toolDetails 为空，浮窗会如实说明原因。
      const submitMcpAdd = async () => {
        const d = mcpAddDraft;
        const serverName = String(d.serverName || '').trim();
        const command = String(d.command || '').trim();
        const url = String(d.url || '').trim();
        if (!serverName) { setError('serverName 必填（1-32 位字母/数字/下划线/连字符）'); return; }
        if (!command && !url) { setError('stdio 需要 command，streamable-http 需要 URL，至少填一个'); return; }
        setBusy('mcpAdd');
        setError('');
        try {
          const args = String(d.args || '').split('\n').map((x) => x.trim()).filter(Boolean);
          const env = {};
          for (const r of d.envRows || []) { const k = String(r.key || '').trim(); if (k) env[k] = r.value; }
          const headers = {};
          for (const r of d.headerRows || []) { const k = String(r.key || '').trim(); if (k) headers[k] = r.value; }
          // 自定义 command = 在本机执行该程序：与服务端闸门同语义，必须显式确认。
          const r = await call('mcp.install', {
            serverName,
            title: String(d.title || '').trim() || serverName,
            description: String(d.description || '').trim(),
            transport: command ? 'stdio' : 'streamable-http',
            command,
            args,
            url,
            env,
            headers,
            cwd: String(d.cwd || '').trim(),
            ...(Number(d.toolCallTimeoutMs) > 0 ? { toolCallTimeoutMs: Number(d.toolCallTimeoutMs) } : {}),
            confirm: command ? true : undefined,
          });
          const rr = (r.results || [])[0] || r;
          setNotice(rr.ok === false && rr.error ? `添加失败：${rr.error}` : `已添加 ${serverName}${rr.pending ? '，连接器启动中' : `，${(rr.tools || []).length} 个工具`}`);
          setMcpAdd(null);
          setMcpAddConfirm(false);
          await loadInstalled();
        } catch (e) {
          setError(`添加失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const saveToolDeny = async (serverName, draft) => {
        setBusy('saveToolDeny');
        setError('');
        try {
          const r = await call('mcp.tools.set', { serverName, deny: draft });
          setToolDenyApplied(Number(r.applied) || 0);
          setNotice(`已保存：${(r.deny || []).length} 个工具被禁用，当前 ${r.applied || 0} 个会话已生效`);
        } catch (e) {
          setError(`保存禁用列表失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const openMcpTools = async (serverName) => {
        setBusy(`tools:${serverName}`);
        setError('');
        try {
          const data = await call('mcp.detail', { serverName });
          setMcpToolOpen('');
          // 上一条搜索的陈旧词与游标必须清掉：否则在连接器 A 搜过 click、关掉再打开 B 时，
          // B 的清单会被这个跟 B 无关的词过滤掉，而标题写着「匹配 x/y」——用户读到的是
          // 「B 只有这些工具」，实际是上一条搜索的残留。那是假陈述，不是小不便。
          setToolQuery('');
          setToolBatch(1);
          // hasDetails 区分两件事：服务端根本没这个字段（旧版本，需重启）vs 真的一个工具都没有。
          // 把前者说成「还没发布工具」是假陈述。
          setMcpTools({
            serverName,
            toolDetails: Array.isArray(data.toolDetails) ? data.toolDetails : [],
            hasDetails: Array.isArray(data.toolDetails),
            mounted: Boolean(data.mounted),
            title: data.title || serverName,
          });
          // deniedTools 可能是旧服务端（没有该字段）→ 空数组起步，checkbox 全不勾
          const deniedOriginal = Array.isArray(data.deniedTools) ? data.deniedTools.slice() : [];
          setMcpTools((prev) => (prev ? { ...prev, deniedOriginal } : prev));
          setToolDenyDraft(deniedOriginal.slice());
          setToolDenyApplied(0);
        } catch (e) {
          setError(`读取工具清单失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const saveSkillEdit = async () => {
        setBusy('save:skill');
        setError('');
        try {
          const saved = await call('skills.update', {
            slug: detail.slug,
            name: draft.name,
            description: draft.description || undefined,
            body: draft.body,
          });
          setNotice(`已保存 ${saved.slug}（${saved.path}），下一步技能目录即刷新`);
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const saveMcpEdit = async () => {
        setBusy('save:mcp');
        setError('');
        try {
          // env/headers 合并语义：掩码条目（未改动）必须省略，真实新值才发送。
          // 服务端还会用 assertNoMaskLiteral 兜底；两边都不允许「***」写回定义。
          const envPatch = {};
          const envUnset = [];
          for (const r of draft.envRows || []) {
            const key = String(r.key || '').trim();
            if (!key) continue;
            if (r.value === '***（来自环境变量）') continue;
            envPatch[key] = r.value;
          }
          for (const r of mcpDraftOrig?.envRows || []) {
            const key = String(r.key || '').trim();
            if (!key) continue;
            if (!(draft.envRows || []).some((x) => String(x.key || '').trim() === key)) envUnset.push(key);
          }
          const headerPatch = {};
          const headersUnset = [];
          for (const r of draft.headerRows || []) {
            const key = String(r.key || '').trim();
            if (!key) continue;
            if (r.value === '***（来自环境变量）') continue;
            headerPatch[key] = r.value;
          }
          for (const r of mcpDraftOrig?.headerRows || []) {
            const key = String(r.key || '').trim();
            if (!key) continue;
            if (!(draft.headerRows || []).some((x) => String(x.key || '').trim() === key)) headersUnset.push(key);
          }
          const argsList = String(draft.args || '').split('\n').map((x) => x.trim()).filter(Boolean);
          const origArgs = String(mcpDraftOrig?.args || '').split('\n').map((x) => x.trim()).filter(Boolean);
          const commandChanged = String(draft.command || '') !== String(mcpDraftOrig?.command || '');
          const argsChanged = JSON.stringify(argsList) !== JSON.stringify(origArgs);
          const patch = {
            url: draft.url,
            transport: draft.transport,
            cwd: draft.cwd,
          };
          if (commandChanged) patch.command = draft.command;
          if (argsChanged) patch.args = argsList;
          if (Object.keys(envPatch).length > 0 || envUnset.length > 0) patch.env = envPatch;
          if (envUnset.length > 0) patch.envUnset = envUnset;
          if (Object.keys(headerPatch).length > 0 || headersUnset.length > 0) patch.headers = headerPatch;
          if (headersUnset.length > 0) patch.headersUnset = headersUnset;
          if (String(draft.toolCallTimeoutMs || '').trim() !== '') patch.toolCallTimeoutMs = Number(draft.toolCallTimeoutMs);
          // 执行面改动（command/args）需要二次确认：服务端闸门会拒未带 confirm 的请求。
          // UI 同步两步化：第一次点保存只是武装确认按钮，第二次才真正发送。
          const needsConfirm = commandChanged || argsChanged;
          if (needsConfirm && !mcpConfirmArmed) {
            setMcpConfirmArmed(true);
            setBusy('');
            return;
          }
          // confirm 在 RPC body 顶层（服务端读 body.confirm）；放进 patch 会被
          // spread 进定义文件，污染数据且闸门仍然读不到——两处都错。
          const result = await call('mcp.update', { serverName: detail.slug, patch, confirm: needsConfirm ? true : undefined });
          if (result.ok) {
            setNotice(`已保存并重连 ${detail.slug}，${result.tools.length} 个工具${needsConfirm ? '（命令已更新）' : ''}`);
          } else if (result.pending) {
            setNotice(`已保存 ${detail.slug}，正在重启连接器…`);
            const final = await waitForTools(detail.slug);
            if (final.ok) setNotice(`已保存并重连 ${detail.slug}，${final.toolCount} 个工具（等待 ${Math.round(final.waitedMs / 1000)}s）`);
            else if (final.timedOut) setNotice(`${detail.slug} 超过 ${Math.round(MAX_PROGRESS_MS / 1000)}s 仍未发布工具，请稍后刷新查看`);
            else setNotice(`已保存，但未连上：${result.error || ''}`);
          } else {
            setNotice(`已保存，但未连上：${result.error || ''}`);
          }
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      // 各源详情页 URL 推导（统一通过 DSH 内置 sidebar-right browser tab 打开）。
      // 每个源都要给出可打开的地址：全部源的全部技能卡片都必须有「详情」按钮。
      // embedBlockedFor(item) —— 该源的详情页是否**拒绝**被宿主内置浏览器承载。
      // 宿主内置浏览器是以框架方式显示页面的，而实测响应头（直打真实页面）：
      //   clawhub / skills.sh / github(skillsmp) → X-Frame-Options: DENY 且 CSP
      //     frame-ancestors 'none'；skillhub → SAMEORIGIN；modelscope → 'self'。
      // 这五个源都拒绝被非同源的宿主框架承载，点开只会是 Chromium 的灰色禁止图标；
      // lobehub、browse.sh 实测未设限，trusttools 未测 —— 未测的源不进名单，因为
      // 凭猜测限制用户与谎报内容同罪。宿主工具条上的「关闭沙箱限制」实测无效：
      // 拦截来自页面级 CSP，不是宿主沙箱，所以这不是能绕的开。
      const embedBlockedFor = (item) => {
        const blocked = ['clawhub', 'skills.sh', 'skillsmp', 'skillhub', 'modelscope'];
        return blocked.includes(String((item && item.source) || ''));
      };
      
      const detailUrlFor = (item) => {
        if (!item) return '';
        const source = item.source;
        const slug = String(item.slug || '').toLowerCase();
        const owner = String(item.owner || '').replace(/^@/, '');
        const homepage = typeof item.homepage === 'string' && /^https?:\/\//i.test(item.homepage) ? item.homepage : '';
        const upstream = String(item.upstreamUrl || '').replace(/^@/, '');
        if (source === 'skillhub') {
          // homepage 指向 api.skillhub.cn 接口地址，可浏览的详情页在 www 站。
          if (slug) return `https://www.skillhub.cn/skills/${slug}`;
          return homepage;
        }
        if (source === 'skillsmp') {
          // upstreamUrl 格式为 owner/repo@branch，取 @ 前的部分拼 GitHub URL。
          const repo = upstream.split('@')[0];
          if (repo) return `https://github.com/${repo}`;
          return homepage;
        }
        if (homepage) return homepage;
        if (source === 'skills.sh') {
          return upstream && slug ? `https://www.skills.sh/${upstream}/${slug}` : '';
        }
        if (source === 'clawhub') {
          return owner && slug ? `https://clawhub.ai/${owner}/${slug}` : '';
        }
        if (source === 'browse.sh') {
          return slug ? `https://browse.sh/skills/${owner ? owner + '/' : ''}${slug}` : '';
        }
        if (source === 'modelscope') {
          const ident = item.modelScopeIdent || '';
          return ident ? `https://modelscope.cn/skills/${ident}` : '';
        }
        if (upstream) return `https://github.com/${upstream}`;
        return '';
      };

      // 在 DSH 内置 sidebar-right browser tab 中打开详情页（绝不使用系统浏览器）。
      // 右侧栏按 Session 挂载：市场面板占满主列时没有挂载的 Session，openTab 会拒绝。
      // 先回到会话（selectPanel(null)），再打开内置浏览器 tab；永远不回退到系统浏览器。
      // 详情页以停靠 tab 呈现（不展开右侧栏、不用浮窗，避免同时弹出侧边栏+浮窗的突兀感）。
      const openDetail = (item) => {
        const url = detailUrlFor(item);
        if (!url) {
          setError('该条目没有可打开的详情页');
          return;
        }
        const sr = props && props.sidebarRight;
        if (!sr || typeof sr.openTab !== 'function') {
          setError('当前环境没有 DSH 内置浏览器（sidebarRight 不可用）');
          return;
        }
        const tryOpen = () => {
          try {
            sr.openTab('browser', { params: { url } });
            return true;
          } catch {
            return false;
          }
        };
        if (tryOpen()) return;
        // 全局面板（市场）没有挂载 Session → 回到会话，再重试
        try {
          if (props.layout && typeof props.layout.selectPanel === 'function') props.layout.selectPanel(null);
        } catch { /* layout service unavailable */ }
        const retry = (left) => {
          if (tryOpen()) return;
          if (left > 0 && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => retry(left - 1));
            return;
          }
          setError('无法在 DSH 内置浏览器中打开详情：右侧栏当前不可用');
        };
        retry(40);
      };

      const doInstallSkill = async (item) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('skills.install', {
            source: item.source,
            // 每个源产出的 installRef 已在 handler 里统一（见 src/sources.js installRefOf）。
            // 这里只做最后兜底，不再堆叠 per-source 三元。
            reference: item.installRef || item.upstreamUrl || item.id,
            upstreamUrl: item.source === 'modelscope' ? (item.upstreamUrl || '') : '',
            skillDir: item.skillDir || (item.source === 'skills.sh' ? (item.slug || '') : ''),
            ref: item.ref || '',
            name: item.slug,
          });
          setNotice(`已安装 ${d.slug} → ${d.dir}（${d.files} 个文件，已生效）`);
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      // 探针只是快速确认；真正的终局由轮询 mcp.list 的实时工具表给出。
      // RPC 分发实测并发（慢查询进行中 settings.get 仍 4ms 返回），轮询不会排队等待。
      const MAX_PROGRESS_MS = 120000;
      const POLL_INTERVAL_MS = 600;
      const waitForTools = (serverName) => new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(async () => {
          const waitedMs = Date.now() - started;
          setInstallProgress({ serverName, waitedMs, tools: 0 });
          if (waitedMs > MAX_PROGRESS_MS) {
            clearInterval(timer);
            setInstallProgress(null);
            resolve({ ok: false, timedOut: true, waitedMs });
            return;
          }
          try {
            const d = await call('mcp.list', {});
            const hit = (d.items || []).find((x) => x.serverName === serverName);
            const tools = (hit && hit.tools) || [];
            if (tools.length > 0) {
              clearInterval(timer);
              setInstallProgress(null);
              resolve({ ok: true, toolCount: tools.length, waitedMs });
            } else {
              setInstallProgress({ serverName, waitedMs, tools: 0 });
            }
          } catch { /* 单次轮询失败就等下一轮 */ }
        }, POLL_INTERVAL_MS);
      });

      const doInstallMcp = async (item, envValues) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('mcp.install', { slug: item.slug, envValues: envValues || {} });
          const r = (d.results || [])[0] || {};
          if (r.missing && r.missing.length) {
            setEnvPrompt({ slug: item.slug, missing: r.missing });
            setEnvDraft({});
            setNotice(`该连接器需要 ${r.missing.join(', ')}；填好后会写入系统环境变量并立即连接`);
          } else if (r.ok) {
            setEnvPrompt(null);
            setNotice(`已连接 ${r.serverName}，新增 ${r.toolCount} 个工具${(r.envWritten || []).length ? `（已写入环境变量 ${r.envWritten.join(', ')}）` : ''}`);
          } else if (r.pending) {
            // 已挂载但还没发布工具：npx 首次运行要先下载依赖，继续轮询出真实结果
            setNotice(`已保存 ${r.serverName}，正在启动…（${r.error || '首次运行需下载依赖'}）`);
            const final = await waitForTools(r.serverName);
            if (final.ok) setNotice(`已连接 ${r.serverName}，新增 ${final.toolCount} 个工具（等待 ${Math.round(final.waitedMs / 1000)}s）`);
            else if (final.timedOut) setNotice(`${r.serverName} 超过 ${Math.round(MAX_PROGRESS_MS / 1000)}s 仍未发布工具，请稍后在「管理 → MCP 连接器」刷新查看，或检查启动命令`);
            else setNotice(`已保存 ${r.serverName}，但未连上：${r.error || ''}`);
          } else {
            setNotice(`已保存 ${r.serverName}，但未连上：${r.error || ''}`);
          }
          await loadInstalled();
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const toggleGroupCollapsed = (key) => {
        setCollapsedGroups((prev) => {
          const next = { ...prev };
          if (next[key]) delete next[key];
          else next[key] = true;
          try {
            window.localStorage.setItem('dsh-skill-mcp-market.collapsedGroups', JSON.stringify(next));
          } catch {
            /* storage refused: the view still collapses for this render */
          }
          return next;
        });
      };

      const toggleSkill = async (slug, enabled, scope) => {
        setBusy(`toggle:${slug}`);
        setError('');
        try {
          const d = await call('skills.toggle', { slug, enabled, scope: scope || 'auto' });
          const scopeText = d && d.scope === 'file'
            ? (enabled ? '文件级：已移除禁用标记，模型可再次调用' : '文件级：已写入禁用标记，模型不再调用')
            : '面板级：仅本面板隐藏，宿主注册表仍会加载该技能';
          setNotice(`${enabled ? '已启用' : '已停用'} ${slug}（${scopeText}）`);
          await loadSettings();
          setSettings((prev) => (prev ? { ...prev, settings: { ...prev.settings } } : prev));
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const toggleMcp = async (name, enabled) => {
        setBusy(`toggle:${name}`);
        setError('');
        try {
          await call('mcp.toggle', { serverName: name, enabled });
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      // 拖拽上传技能：从旧版内联在虚线框里的 handler 原样提取（逻辑零改动），
      // 热区升级为整个技能列表容器。额外先清 dragOver，避免提示条卡在屏幕上。
      const handleSkillDrop = async (e) => {
        e.preventDefault();
        setDragOver(false);
        setBusy('upload'); setUploadError(''); setNotice('');
        try {
          const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
          const items = e.dataTransfer ? Array.from(e.dataTransfer.items || []) : [];
          const droppedFiles = [];
          // 优先走 DataTransferItem.webkitGetAsEntry() 递归读取 FileEntry，
          // 能拿到真实的目录层级；读不到的文件回退到 e.dataTransfer.files。
          const readEntry = async (entry, prefix, out) => {
            if (entry.isFile) {
              const file = await new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
              if (file) out.push({ file, path: prefix + file.name });
            } else if (entry.isDirectory) {
              const reader = entry.createReader();
              const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
              let batch = await readBatch();
              while (batch.length) {
                for (const child of batch) await readEntry(child, prefix + entry.name + '/', out);
                batch = await readBatch();
              }
            }
          };
          const entryResults = [];
          for (const item of items) {
            const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
            if (entry) entryResults.push(entry);
          }
          if (entryResults.length) {
            for (const entry of entryResults) await readEntry(entry, '', droppedFiles);
          }
          if (!droppedFiles.length) {
            for (const f of Array.from(e.dataTransfer.files || [])) droppedFiles.push({ file: f, path: f.name });
          }
          if (!droppedFiles.length) return;
          // 推断根目录前缀：所有 path 的公共第一段（拖入的是文件夹时形如 "agnes/SKILL.md"）。
          const firstSeg = droppedFiles.map(({ path }) => path.split('/').filter(Boolean)[0] || '').filter(Boolean);
          const rootPrefix = firstSeg.length && firstSeg.every((s) => s === firstSeg[0]) ? firstSeg[0] + '/' : '';
          const files = [];
          for (const { file, path } of droppedFiles) {
            const rel = path.startsWith(rootPrefix) ? path : rootPrefix + path;
            const parts = rel.split('/');
            if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
            const text = await file.text();
            files.push({ path: rel, content: text });
          }
          const result = await call('skills.upload', { files, force: false });
          const n = result.count || (result.items || []).length;
          setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
          await loadInstalled();
          setTimeout(() => setUploadOpen(false), 600);
        } catch (err) {
          setUploadError(`上传失败：${err.message || err}`);
        } finally {
          setBusy('');
        }
      };

      const removeSkill = async (slug) => {
        setBusy(`remove:${slug}`);
        try {
          await call('skills.uninstall', { slug, confirm: true });
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const savePaths = async () => {
        setBusy('settings.set');
        setError('');
        try {
          const d = await call('settings.set', {
            skillDirs: skillDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
            mcpDirs: mcpDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          });
          setNotice(`路径已更新（技能 ${d.skillDirs.length} 个 / MCP ${d.mcpDirs.length} 个），已即时重挂`);
          await loadSettings();
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      // 回收站：skills.trash / skills.restore / skills.trashEmpty
      const loadTrash = async () => {
        setTrashBusy('list');
        setError('');
        try {
          const d = await call('skills.trash', {});
          setTrashList(d);
          setNotice(`回收站共 ${d.items.length} 项`);
        } catch (e) {
          setError(`读取回收站失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };
      // 回收站是技能侧的常驻区块：进入管理-技能子页签自动拉一次（失败不打扰用户，
      // 手动「读取回收站」按钮仍在原位兜底）。必须定义在 loadTrash 之后——
      // useEffect 的依赖数组在渲染时求值，提前引用 const 会触发 TDZ（实测白屏）。
      useEffect(() => {
        if (tab === 'manage' && manageTab === 'skill' && trashList === null && !trashBusy) {
          loadTrash().catch(() => {});
        }
      }, [tab, manageTab, trashList, trashBusy, loadTrash]);

      const loadMcpTrash = async () => {
        setMcpTrashBusy('list');
        setError('');
        try {
          const d = await call('mcp.trash', {});
          setMcpTrashList(d);
          setNotice(`MCP 回收站共 ${d.items.length} 项`);
        } catch (e) {
          setError(`读取 MCP 回收站失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };
      // MCP 子页签同理：首次进入自动拉一次回收站。必须定义在 loadMcpTrash 之后——
      // useEffect 的依赖数组在渲染时求值，提前引用 const 会触发 TDZ 白屏（0.5.104 实测回归）。
      useEffect(() => {
        if (tab === 'manage' && manageTab === 'mcp' && mcpTrashList === null && !mcpTrashBusy) {
          loadMcpTrash().catch(() => {});
        }
      }, [tab, manageTab, mcpTrashList, mcpTrashBusy, loadMcpTrash]);

      const restoreMcpTrashEntry = async (entry) => {
        setMcpTrashBusy(`restore:${entry.path}`);
        setError('');
        setNotice('');
        try {
          const r = await call('mcp.restore', { path: entry.path });
          await loadMcpTrash();
          await loadInstalled();
          // 同上：结果提示排在刷新之后，否则被「MCP 回收站共 N 项」覆盖
          setNotice(r.aliased
            ? `已恢复为 ${r.serverName}（同名定义已存在，改用别名避免覆盖）`
            : `已恢复 ${r.serverName}，连接器已重新挂载`);
        } catch (e) {
          setError(`恢复失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };

      const emptyMcpTrash = async () => {
        setMcpTrashBusy('empty');
        setError('');
        setNotice('');
        try {
          const r = await call('mcp.trashEmpty', { confirm: true });
          await loadMcpTrash();
          setNotice(`已清空 MCP 回收站，删除 ${r.removed} 项（不可恢复）`);
        } catch (e) {
          setError(`清空失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };

      const restoreTrashEntry = async (entry) => {
        setTrashBusy(`restore:${entry.path}`);
        setError('');
        setNotice('');
        try {
          const r = await call('skills.restore', { path: entry.path });
          await loadTrash();
          await loadInstalled();
          // 结果提示必须最后写：loadTrash 内部也会 setNotice（回收站共 N 项），
          // 先写结果就会被刷新提示覆盖，用户看不到恢复到了哪里。
          setNotice(`已恢复 ${r.slug} → ${r.restoredTo}`);
        } catch (e) {
          setError(`恢复失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };

      const emptyTrashAll = async () => {
        setTrashBusy('empty');
        setError('');
        setNotice('');
        try {
          const r = await call('skills.trashEmpty', { confirm: true });
          setNotice(`已清空回收站，删除 ${r.removed} 项（不可恢复）`);
          setTrashList({ items: [] });
        } catch (e) {
          setError(`清空失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };

      // 会话日志体检：sessions.scan 列出 + 深度检测；sessions.repair 修复
      const scanSessions = async (deep) => {
        setSessionBusy(deep ? 'scan-deep' : 'scan');
        setError('');
        setNotice('');
        try {
          const d = await call('sessions.scan', { deep: Boolean(deep), limit: 60 });
          setSessionScan(d);
          setNotice(`扫描 ${d.count} 个会话日志${deep ? `，发现 ${d.corrupt} 个损坏` : ''}`);
        } catch (e) {
          setError(`会话体检失败：${e.message || e}`);
        } finally {
          setSessionBusy('');
        }
      };

      const repairSession = async (file, dryRun) => {
        setSessionBusy(`repair:${file}`);
        setError('');
        setNotice('');
        try {
          const r = await call('sessions.repair', { file, dryRun: Boolean(dryRun), confirm: !dryRun });
          if (dryRun) {
            setNotice(r.corruption
              ? `预演：${r.sessionId} 在 seq ${r.corruption.seq} 处损坏（${r.corruption.reason}），将保留 ${r.keepEvents}/${r.eventsBefore} 条`
              : `预演：${r.sessionId} 未发现损坏`);
          } else if (r.repaired) {
            setNotice(`已修复 ${r.sessionId}：丢弃 ${r.dropped} 条坏事件，保留 ${r.keepEvents} 条；原文件备份为 ${r.backup}`);
            await scanSessions(true);
          } else {
            setNotice(`${r.sessionId} 未发现损坏，无需修复`);
          }
        } catch (e) {
          setError(`修复失败：${e.message || e}`);
        } finally {
          setSessionBusy('');
        }
      };

      // 本地兜底只处理面板自己能算的键（default/installCount/name）。
      // 选了 stars/newest/updated/trending 且该源能力表支持时，服务端已经排好整页；
      // 这里若再按 installs 重排，就等于把服务端排序抹掉 → 现象仍是「选了没反应」。
      const skillCaps = capsFor(sortCaps && sortCaps.skills ? sortCaps.skills[source] : null, Boolean(String(query || '').trim()));
      const serverSorted = sort !== 'default' && sort !== 'installCount' && sort !== 'name'
        && Array.isArray(skillCaps) && skillCaps.includes(sort);
      const orderedSkills = skills.slice().sort((a, b) => {
        if (b.installable !== a.installable) return (b.installable === false ? 0 : 1) - (a.installable === false ? 0 : 1);
        if (serverSorted) return 0;
        if (sort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        return (b.installs || 0) - (a.installs || 0);
      });
      // 派生兜底上限从 10 放开到 60：10 会把用户能点的分类静默截掉（面板每页条数上限本就是 60，见
      // resolvePageSize 的 Math.min(60, …)，同一个可见性口径）。词表在手时 chip 由词表给全，这里
      // 只是无词表源（skills.sh / skillhub）的兜底，可见窗口仍由 CAT_CHIP_FOLD 折叠。
      const categories = [...new Set(skills.map((item) => item.category).filter(Boolean))].slice(0, 60);
      // 固定词表在前（上游条目数降序），当前页派生的串补在后：词表抓不到时入口不关，改版也不丢。
      const vocabChips = categoryChipsForSource(source, categories, categoryVocab);
      // 默认窗口外的分类不再逐个铺开：合并成一个「其他」（窗内条数仍是上游真数，合计如实标注）。
      // 声明顺序要紧：chipEntries 与 visibleSkills 都读 chipFold，写在后面会撞 TDZ（node --check 看不见）。
      const chipFold = foldChips(vocabChips, CAT_CHIP_FOLD, CAT_TAIL_LABEL);
      // 0.5.177 逐类取数（消费侧）：covers 交给下发侧（tailCoversRef → env.tailCovers →
      // harvest.start tailCategories）；服务端 tail 声明经 memo 核对当前 src|q|cat 后落到
      // chipFold.other.tailDeclared，visibleSkills 据此豁免 covers 本地筛（P5）。
      tailCoversRef.current = chipFold.other && Array.isArray(chipFold.other.covers) && chipFold.other.covers.length ? chipFold.other.covers.slice(0, 400) : null;
      const tailMemo = tailStateRef && tailStateRef.current && tailStateRef.current.tail
        && tailStateRef.current.src === source && tailStateRef.current.q === query && tailStateRef.current.cat === category
        ? tailStateRef.current.tail
        : null;
      if (chipFold.other) chipFold.other.tailDeclared = !!tailMemo;
      // 渲染集合必须自己带上 'all' 首入口：chipFold.window 只有分类，照它铺开会让「全部分类」
      // 从面板上静默消失（用户没法取消筛选）。0.5.164 的中间量 chipBySlug/chipSlugs 在折叠改造后
      // 没有任何消费方——留着就是死量，判据（lobehub Test 8）直接锁这两行不再出现。
      // 展开/收起只换渲染集合，绝不换筛选值：category 里永远只出现上游真 slug 或 'all'。
      // 0.5.174（用户 m00001 + m20051）：展开态只在尾巴够小（tail<=CAT_TAIL_EXPAND_MAX=40，skillsmp 31）时
      // 才铺全部上游真类；大尾巴源（lobehub 214）两态同窗、连展开入口都不给（装饰假控件）。
      // 合并入口永远只走一个筛选入口，成员身份只活在 covers 谓词里（D 防线：CAT_OTHER 仍在 upstreamCat 那一行
      // 由 upstreamCat 降级为 'all' 才下发，面板自造 slug 绝不进上游）。
      // 上游自造的杂项桶（其他/Other/general）沉到末尾，与面板自造的合并入口分开放，不互相冒充（m18814）。
      const realChip = (chip) => chip && chip.value && chip.value !== CAT_OTHER && chip.value !== CATS_COLLAPSE;
      const genericBucket = (chip) => {
        const s = String((chip && chip.value) || '').trim().toLowerCase();
        const l = String((chip && chip.label) || '').trim().toLowerCase();
        return s === 'other' || s === 'others' || s === 'general' || l === '其他' || l === 'other' || l === 'others';
      };
      const splitBuckets = (list) => {
        const kept = [];
        const sunk = [];
        for (const c of list) (genericBucket(c) ? sunk : kept).push(c);
        return kept.concat(sunk);
      };
      const expandedChips = splitBuckets(vocabChips.filter(realChip));
      // 0.5.174：旧 allRealChips（窗内全集那一路）删除。展开集合改由下面的 tailExpandable 门控：
      // 小尾巴源用 expandedChips（全部上游真类，桶沉底），大尾巴源两态同用 chipFold.window。
      // 收缩/展开两态共用行尾同一个哨兵：label 与 next 都写在 chip 上，渲染块不需要新的自由
      // 变量；它是展示态，永远不进 category，与合并筛选态（catsExpanded 的邻居，不是它本身）互不顶替。
      const tailExpandable = !!chipFold.other && chipFold.otherCount <= CAT_TAIL_EXPAND_MAX;
      const toggleChip = tailExpandable ? { value: CATS_COLLAPSE, label: catsExpanded ? '收起分类' : '展开分类', next: !catsExpanded, totalAll: 0, fixed: true } : null;
      // 展开态只活在本次面板（重挂载/刷新/重启回到收起态），不再落 localStorage。
      const toggleCats = (next) => {
        setCatsExpanded(next === true);
      };
      const chipEntries = [{ value: 'all', label: '全部分类', totalAll: 0, fixed: true }]
        .concat(catsExpanded && tailExpandable ? expandedChips.concat(chipFold.other ? [chipFold.other] : []) : chipFold.window)
        .concat(chipFold.other && tailExpandable ? [toggleChip] : []);
      // 上游已按分类筛过（serverFacet=true）时不再二次本地过滤：facet 页只有当前窗口的
      // 卡片，再按本地标签筛一遍会把未标注分类的条目无谓筛掉，还与分页器总数对不上。
      // 0.5.164：分类态本地过滤必须与聚合层同口径。src/sources.js:848 对「该源未标注分类」的行按
      // 「无分类不过滤」保留（:874 明写「另有 N 项该源未标注分类…一并保留」），面板此前把这类行直接
      // 删掉 ⇒ 渲染比聚合层承诺少（实测：聚合 items=3/filteredOut=0，面板只剩 1 条）。少掉的条目不会
      // 出现在任何文案里，用户看不见这个丢失——正是 0.5.101 起反复判死的静默偷内容。无分类行放行，
      // 异类行仍严格剔除（判据在 test-category-info-declaration Test 6，真跑本行函数体）。
      // 0.5.172（用户 m00001）：CAT_OTHER 是真筛选态——按下合并入口，可见集合就是 covers（合并全部 slug）的并集。
      // serverFacet 不许绕过它：CAT_OTHER 在 upstreamCat 处已降级为 'all' 下发，拿回的是未按合并集合筛的整页，
      // 若让 facet 短路就会把整页都说成合并集合全部（文案与结果不符，正是设计 B 要挡的谎报）。
      // 条目无分类字段 ⇒ 不算合并集合成员：unknown 不是杂项桶，宁缺毋滥，也不吃 !item.category 那条放行。
      // 空分类的出路只在「本市场确实一条都没筛出来」时给：上游 facet 说的 0（serverFacet）、取数失败
      // （sourceErrors/error）、正在加载（busy）都不算——那三种给「近似搜索」按钮是转移视线。
      const nearbyChip = (category === 'all' || serverFacet || busy || error || skills.length > 0)
        ? null
        : vocabChips.find((chip) => chip && chip.value === category);
      const nearbyNeedle = nearbyChip ? nearbySearchNeedle(nearbyChip) : '';
      const visibleSkills = orderedSkills.filter((item) => category === CAT_OTHER ? (chipFold.other && (chipFold.other.tailDeclared || (Array.isArray(chipFold.other.covers) && !!item.category && chipFold.other.covers.indexOf(item.category) >= 0))) : serverFacet || category === 'all' || !item.category || item.category === category);
      // 诚实口径（设计 B）：并集只能作用在**已取回**的条目上——本次搜索取回多少就只筛多少，
      // 所以这里报「已取回 X / 属于这些类 Y」，绝不说成整个合并集合都已经在页面上。
      // 0.5.184 P1 会话在途闸门：上次收口的账本（tailStateRef memo）不得给本次还在取数的会话
      // 提前下结论——harvest 会话在途（ctl.token 非空）时这里恒空，进度只由加载行播报。
      const tailNote = (harvestCtlRef && harvestCtlRef.current && harvestCtlRef.current.token !== null)
        ? ''
        : ((category !== CAT_OTHER || !chipFold.other)
          ? ''
          : (tailMemo
            // 0.5.184 P3/P4/P5 白话两态：说清「每个未列出分类各取回一页」的取数口径；上游
            // 条数按类相加会重复计同一技能，是虚高数，一律不再报；全部取到就静默。
            ? (function () {
                const C = Math.max(0, Number(tailMemo.categoriesTotal || 0) - Number(tailMemo.categoriesFetched || 0));
                const F = Number(tailMemo.categoriesFailed || 0);
                if (C === 0 && F === 0) return '';
                const Y = Number(tailMemo.retrievedTotal || 0);
                let s = '每个未列出的分类各取回一页（' + (Number(size) || 24) + ' 条），本次取回 ' + Y.toLocaleString() + ' 条，未取全';
                if (C > 0) s += '。还有 ' + C + ' 个分类没取回' + (F > 0 ? '（其中 ' + F + ' 个分类取数失败）' : '');
                s += '。建议：稍后重试。';
                return s;
              })()
            // 旧服务端/本地筛源（未声明 tail）：只报本次取回，绝不报虚高的「上游合计」。
            : (function () {
                const Y = skills.length;
                const C = Number(chipFold.otherCount || 0);
                let s = '每个未列出的分类各取回一页（' + (Number(size) || 24) + ' 条），本次取回 ' + Y + ' 条，未取全';
                if (C > 0) s += '。还有 ' + C + ' 个分类没取回';
                s += '。建议：稍后重试。';
                return s;
              })()));
      const skillCards = shownCards(visibleSkills, cardBatch, cardStepFor(size)).map((item) =>
        h('div', { key: item.id, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.sourceLabel || item.source),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            visibleCounts(item).installs ? h('span', null, `· ${Number(item.installs).toLocaleString()} 次安装`) : null,
            // 排序依据必须可见：只给「按安装数」而卡片没有安装数时，用户无法核验。
            // 与安装数同一规则 —— 有值才显示，0/缺失不显示，绝不显示错数。
            visibleCounts(item).downloads ? h('span', null, `· ${Number(item.downloads).toLocaleString()} 次下载`) : null,
            item.stars ? h('span', null, `· ★ ${Number(item.stars).toLocaleString()}`) : null,
            item.installable === false ? h('span', null, '· 仅可浏览') : null),
          h('div', { style: S.row },
            item.source === 'skillhub' && opStatus && opStatus['skillhub.evaluation'] === true ? h('button', {
              style: { ...S.btn(), padding: '0 6px' },
              title: '查看 SkillHub 官方质量评测（打开详情时才查询，列表不预取）',
              disabled: busy === 'quality:' + String(item.namespace || item.slug),
              onClick: () => openSkillQuality(item),
            }, busy === 'quality:' + String(item.namespace || item.slug) ? '评测中…' : '质量') : null,
            h('button', {
              style: { ...S.btn(), padding: '0 6px' },
              title: embedBlockedFor(item) ? '该站点拒绝被内嵌，内置浏览器里只会是空白拦截页（请改用安装或上游站点查看）' : detailUrlFor(item) ? '在 DSH 内置浏览器中查看详情' : '该条目没有可打开的详情页',
              disabled: !detailUrlFor(item) || embedBlockedFor(item),
              onClick: () => openDetail(item),
            }, '详情'),
            (installed ?? []).some((x) => x.slug === item.slug)
              ? h('span', { style: S.status }, '✓ 已安装')
              : item.installable === false
                ? h('span', { style: S.status }, item.note || '该条目没有可用的下载源')
                : h('button', {
                  style: S.btn('primary'),
                  disabled: busy === `install:${item.slug}` || item.installable === false,
                  onClick: () => doInstallSkill(item),
                }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const orderedMcps = mcps.slice().sort((a, b) => {
        if (mcpSort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        if (mcpSort === 'installCount') return (b.installs || 0) - (a.installs || 0);
        if (mcpSort === 'ratingAverage') return (b.rating || 0) - (a.rating || 0);
        return 0;
      });
      const mcpCards = shownCards(orderedMcps, cardBatch, cardStepFor(size)).map((item) =>
        h('div', { key: item.id || item.slug, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.transport || 'stdio'),
            h('span', null, `· ${item.sourceLabel || (item.source === 'lobehub' ? 'LobeHub' : 'MCP 官方注册表')}`),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installs ? h('span', null, `· ${Number(item.installs).toLocaleString()} 次安装`) : null,
            item.stars ? h('span', null, `· ★ ${Number(item.stars).toLocaleString()}`) : null,
            (item.envRequired || []).length ? h('span', null, `· 需要 ${item.envRequired.join(', ')}`) : null),
          // "name" is the registry identifier users may need to copy into a manual install.
          h('div', { style: S.meta }, h('span', null, item.slug)),
          item.note ? h('div', { style: S.status }, item.note) : null,
           h('div', { style: S.row },
             detailUrlFor(item) && !embedBlockedFor(item) ? h('button', {
               style: { ...S.btn(), padding: '0 6px' },
               title: embedBlockedFor(item) ? '该站点拒绝被内嵌，内置浏览器里只会是空白拦截页（请改用安装或上游站点查看）' : detailUrlFor(item) ? '在 DSH 内置浏览器中查看详情' : '该条目没有可打开的详情页',
               disabled: !detailUrlFor(item) || embedBlockedFor(item),
               onClick: () => openDetail(item),
             }, '详情') : null,
             h('button', {
               style: S.btn('primary'),
               disabled: item.installable === false || busy === `install:${item.slug}`,
               onClick: () => doInstallMcp(item),
              }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const CATEGORY_LABELS = {
        developer: '开发者',
        'developer-tools': '开发者工具',
        development: '开发',
        'data-analytics': '数据分析',
        database: '数据库',
        search: '搜索',
        'web-search': '网页搜索',
        'media-generate': '媒体生成',
        productivity: '效率办公',
        business: '商业服务',
        finance: '金融',
        tools: '实用工具',
        utility: '实用工具',
        'travel-transport': '出行交通',
        social: '社交',
        communication: '通信',
        cloud: '云服务',
        security: '安全',
        education: '教育',
        'education-science': '教育科研',
        'gaming-entertainment': '游戏娱乐',
        'health-wellness': '健康',
        healthcare: '医疗',
        news: '新闻',
        research: '研究',
        'real-estate': '房产',
        shopping: '购物',
        services: '服务',
        hardware: '硬件',
        networking: '网络',
        government: '政务',
        legal: '法律',
        industrial: '工业',
        robotics: '机器人',
        lifestyle: '生活',
        entertainment: '娱乐',
        blockchain: '区块链',
        'home-automation': '智能家居',
        'jobs-search': '招聘',
        science: '科学',
      };
      const categoryLabel = (code) => CATEGORY_LABELS[code] || code;
      const disabledSet = new Set(((settings && settings.settings && settings.settings.disabledSkills) || []).map((x) => String(x).toLowerCase()));
      // 两个子页签各用各的过滤词
      const skillFilterText = manageSkillFilter.trim().toLowerCase();
      const mcpFilterText = manageMcpFilter.trim().toLowerCase();
      const homeDir = (settings && settings.settings && settings.settings.homeDir) || '';
      const pv = pathsView(settings, skillDraft, mcpDraft);
      // 停用的真实状态 = 面板级 disabledSkills ∪ 文件级 disable-model-invocation。
      // 只看前者会把「文件级已停用」的技能显示成启用中，并对用户假陈述（0.5.117 前既有缺陷）。
      const skillStateOff = (item) => disabledSet.has(String(item.slug || '').toLowerCase()) || item.disableModelInvocation === true;
      const installedList = installed ?? [];
      const mountedList = mounted ?? [];
      const filteredInstalled = installedList.filter((i) => {
        if (manageSkillState === 'on' && skillStateOff(i)) return false;
        if (manageSkillState === 'off' && !skillStateOff(i)) return false;
        if (!skillFilterText) return true;
        return (i.name || i.slug || '').toLowerCase().includes(skillFilterText) || (i.description || '').toLowerCase().includes(skillFilterText);
      });
      const filteredMounted = mcpFilterText
        ? mountedList.filter((i) => (i.title || i.serverName || '').toLowerCase().includes(mcpFilterText) || (i.description || '').toLowerCase().includes(mcpFilterText))
        : mountedList;
      // 浮窗清单的唯一数据源：标题计数、列表渲染、无匹配提示都读它。
      const visibleTools = mcpTools ? mcpTools.toolDetails.filter((tool) => toolMatches(tool, toolQuery)) : [];
      // 只渲染前 toolBatch × TOOL_BATCH 个：搜索时输入一个字符就重建几十个 card 是明显浪费，
      // 而标题计数仍报全量（命中/总数），用户看得见「还有多少没显示」。
      const renderedTools = mcpTools && visibleTools.length > TOOL_BATCH * toolBatch
        ? visibleTools.slice(0, TOOL_BATCH * toolBatch)
        : visibleTools;
      // 搜索词一变就退回第一批：游标停在上次的末尾时，新搜索的前几条反而看不到。
      useEffect(() => { setToolBatch(1); }, [toolQuery]);
      useEffect(() => { setCardBatch(1); }, [query, source, mcpSource, size]);
      // 任一判据窄即窄屏：视口窄（手机远控）或面板窄（宿主侧栏挤占）。
      const narrow = narrowViewport || narrowPanel;
      // 批量计数与动作的唯一口径：只算「筛选后仍可见」的选中项。
      const exitBatch = () => { setBatchMode(false); setSelected(new Set()); setBatchConfirm(false); };
      const runBatch = async (label, verb, items) => {
        setBusy('batch');
        setError('');
        setNotice('');
        try {
          const results = [];
          for (const item of items) {
            try {
              if (verb === 'uninstall') await call('skills.uninstall', { slug: item.slug, confirm: true });
              else await call('skills.toggle', { slug: item.slug, enabled: verb === 'enable' });
              results.push({ ok: true, slug: item.slug });
            } catch (e) {
              results.push({ ok: false, slug: item.slug, error: String(e.message || e) });
            }
          }
          const summary = summarizeBatch(label, results);
          await loadInstalled();
          if (summary.hasFailure) setError(summary.text);
          else setNotice(summary.text);
          if (summary.failRows === 0) exitBatch();
        } finally {
          setBusy('');
        }
      };
      // 单张已装技能卡片（分组渲染时复用）
      const renderInstalledCard = (item) => {
        const off = skillStateOff(item);
        // fileToggle 表示这个技能的 SKILL.md 可写（文件级真生效）；否则只能面板级隐藏
        const fileToggle = item.fileToggleable !== false;
        return h('div', {
          key: `i-${item.dir}-${item.slug}`,
          style: { ...S.card, opacity: item.shadowedBy ? 0.55 : 1, display: 'flex', flexDirection: 'column', gap: 6 },
        },
          // 标题行：状态点前置，不再把「（已停用）（被…覆盖）」堆进标题字符串
          h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8, flexWrap: 'nowrap' } },
            h('span', { style: { ...S.row, gap: 6, flexWrap: 'nowrap', minWidth: 0 } },
              batchMode ? h('input', {
                type: 'checkbox',
                'aria-label': `选择 ${item.slug}`,
                checked: selected.has(String(item.slug)),
                onClick: (e) => e.stopPropagation(),
                onChange: () => setSelected((prev) => {
                  const next = new Set(prev);
                  const key = String(item.slug);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                }),
              }) : null,
              h('span', { style: { ...S.title, minWidth: 0 }, title: item.name || item.slug }, item.name || item.slug)),
            h('span', {
              style: { fontSize: 11, whiteSpace: 'nowrap', color: off ? '#b26a00' : 'var(--dsh-text-secondary, #57606a)' },
              title: off ? '模型不会调用该技能' : '模型可调用',
            }, off ? '● 已停用' : '● 已启用')),
          // 描述优先于来源（来源已在分组头说过，卡片再写一遍是重复）
          h('div', { style: S.desc, title: item.description || '' }, item.description || '（SKILL.md 未提供 description）'),
          h('div', { style: { ...S.meta, fontSize: 11 } },
            h('span', { style: { opacity: 0.65, minWidth: 0 }, title: item.dir }, shortPath(item.dir, homeDir)),
            item.shadowedBy ? h('span', { style: { color: '#b26a00', whiteSpace: 'nowrap' }, title: `同名技能由 ${item.shadowedBy} 提供，层级更高` }, '被覆盖') : null),
          // 次要动作靠左、危险动作靠右；nowrap 保证窄面板不折行
          h('div', { style: S.btnRow },
            h('button', {
              style: S.btn(off ? 'primary' : undefined),
              disabled: busy === `toggle:${item.slug}`,
              title: fileToggle ? '改写 SKILL.md 的 disable-model-invocation，模型不再调用该技能' : '该技能只能在本面板隐藏，模型仍会收到',
              onClick: () => toggleSkill(item.slug, off, fileToggle ? 'file' : 'panel'),
            }, busy === `toggle:${item.slug}` ? '处理中…' : (off ? '启用' : '停用')),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:skill:${item.slug}`,
              onClick: async () => {
                setBusy(`openDir:skill:${item.slug}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'skill', slug: item.slug });
                  setNotice(`已在资源管理器中定位到技能文件夹：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: { ...S.btn(), ...S.danger },
              disabled: busy === `remove:${item.slug}`,
              title: '移入回收站，可随时恢复',
              onClick: () => removeSkill(item.slug),
            }, '卸载')));
      };

      // 用户选了排序就先排再分组：同一来源组内的先后可控，
      // 组与组之间仍按 rank（避免排序把来源层级搞乱）。
      const sortedInstalled = sortInstalled(filteredInstalled, manageSkillSort, skillStateOff);
      // 排序是否真的改变了可见顺序：非 default 却逐项相同 → 界面上看不出任何区别。
      // 判据用可验证事实（排序前后逐项比较），不猜「每组只有一项」这种间接原因。
      const sortOrderUnchanged = manageSkillSort !== 'default' && filteredInstalled.length > 0 &&
        sortedInstalled.every((x, i) => x === filteredInstalled[i]);
      // 按来源层级分组（rank 200 用户 → 500 插件提供），折叠状态存 localStorage
      const installedGrouped = (() => {
        const map = new Map();
        for (const item of sortedInstalled) {
          const rank = item.rank || 999;
          const label = item.sourceLabel || '未分层';
          const key = `${rank}:${label}`;
          if (!map.has(key)) map.set(key, { key, rank, label, items: [] });
          map.get(key).items.push(item);
        }
        return [...map.values()].sort((x, y) => x.rank - y.rank);
      })();

      // 批量与全选的唯一可见口径：只算「当前展开且未被筛选掉」的项。
      // 折叠分组里的项用户看不见，绝不能悄悄参与批量（0.5.122 定的诚实性原则）。
      // 分组归属从 installedGrouped 反查（不复制 `${rank}:${label}` 公式，避免两处口径漂移）。
      const groupKeyOf = new Map();
      for (const g of installedGrouped) { for (const it of g.items) groupKeyOf.set(`${it.dir}|${it.slug}`, g.key); }
      const expandedVisible = filteredInstalled.filter((i) => collapsedGroups[groupKeyOf.get(`${i.dir}|${i.slug}`)] !== true);
      // 计数、全选、批量动作三者同一口径：只算「展开且未被筛选掉」且被选中的项。
      // 旧口径基于 filteredInstalled（含折叠项），用户展开→选中→再折叠后，
      // 看不见的项仍会参与批量卸载 —— 那是假陈述，也是 0.5.122 原则的漏洞。
      const selectedVisible = expandedVisible.filter((i) => selected.has(String(i.slug)));
      // 与 toggleGroupCollapsed 同一持久化路径：直接 setCollapsedGroups 会漏掉 localStorage 写入。
      const collapseAllGroups = (collapsed) => {
        const next = {};
        for (const g of installedGrouped) next[g.key] = collapsed;
        setCollapsedGroups(next);
        try { window.localStorage.setItem('dsh-skill-mcp-market.collapsedGroups', JSON.stringify(next)); } catch { /* 拒绝存储的浏览器只是不记忆 */ }
      };

      const installedSkills = installedGrouped.map((group) => {
        const collapsed = collapsedGroups[group.key] === true;
        const shadowed = group.items.filter((x) => x.shadowedBy).length;
        return h('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' } },
          h('button', {
            type: 'button',
            style: { ...S.row, gap: 8, cursor: 'pointer', background: 'transparent', border: 0, padding: '4px 0', font: 'inherit', textAlign: 'left', width: '100%' },
            onClick: () => toggleGroupCollapsed(group.key),
            title: collapsed ? '展开该来源' : '收起该来源',
          },
            h('span', { style: { fontSize: 12, width: 12 } }, collapsed ? '▸' : '▾'),
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, group.label),
            // rank 是实现细节（同名技能谁优先），不该出现在界面上；降级为悬浮提示。
            h('span', { style: { ...S.status, fontSize: 11 }, title: `层级 ${group.rank}：数字越小，同名技能越优先` }, `${group.items.length} 个`),
            shadowed > 0 ? h('span', { style: { ...S.status, fontSize: 11, color: '#b26a00' } }, `${shadowed} 个被更高层覆盖`) : null),
          collapsed ? null : h('div', { style: S.grid }, group.items.map(renderInstalledCard)));
      });

      const installedMcps = filteredMounted.map((item) =>
        h('div', {
          key: `m-${item.serverName}`,
          style: { ...S.card, cursor: 'pointer' },
          title: '查看工具清单',
          onClick: () => openMcpTools(item.serverName),
        },
          h('div', { style: S.title }, item.title || item.serverName),
          h('div', { style: S.meta },
            h('span', null, item.transport),
            h('span', { title: item.phase === 'failed' ? (item.phaseDetail || '连接失败') : '' },
              PHASE_LABEL[item.phase] || (item.mounted ? '· 已连接' : '· 未连接')),
            h('span', null, item.tools && item.tools.length ? `· ${item.tools.length} 个工具` : '')),
          h('div', { style: S.row, onClick: (e) => e.stopPropagation() },
            h('button', { style: S.btn(), disabled: busy === `toggle:${item.serverName}`, onClick: () => toggleMcp(item.serverName, !item.enabled) }, item.enabled ? '停用' : '启用'),
            h('button', {
              style: S.btn(),
              disabled: busy === `detail:${item.serverName}`,
              onClick: () => openMcpDetail(item.serverName),
            }, '编辑'),
            h('button', {
              style: S.btn(),
              disabled: busy === `probe:${item.serverName}`,
              onClick: async () => {
                setBusy(`probe:${item.serverName}`);
                setError('');
                try {
                  const r = await call('mcp.probe', { serverName: item.serverName, timeoutMs: 8000 });
                  if (r.ok) { setNotice(`✅ 测试连接成功：${item.serverName} 连接正常，${r.tools.length} 个工具（本条提示会保留，可放心查看）`); await loadInstalled(); }
                  else if (r.pending) { setNotice(`⏳ ${item.serverName} 已挂载，服务器还在启动中（约需几秒到几十秒）；稍后再点一次「测试连接」即可`); await loadInstalled(); }
                  else setNotice(`❌ 测试连接失败：${item.serverName} 未连上——${r.error || '未知原因'}（检查该连接器是否被停用、命令是否可执行）`);
                } catch (e) {
                  setError(`测试失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '测试连接'),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:mcp:${item.serverName}`,
              onClick: async () => {
                setBusy(`openDir:mcp:${item.serverName}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'mcp-item', serverName: item.serverName });
                  setNotice(`已在资源管理器中定位到 MCP 定义：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('button', {
              style: S.btn(),
              disabled: busy === `remove:${item.serverName}`,
              onClick: async () => {
                setBusy(`remove:${item.serverName}`);
                setError('');
                try {
                  await call('mcp.uninstall', { serverName: item.serverName, confirm: true });
                  setNotice(`已卸载 ${item.serverName}`);
                  await loadInstalled();
                } catch (e) {
                  setError(String(e.message || e));
                } finally {
                  setBusy('');
                }
              },
            }, '卸载'))));

      // 搜索栏提到 body 之外，成为与标签栏同级的固定行

      const searchBar = (tab === 'skills' || tab === 'mcp')

        ? h('div', { style: S.searchBar },

            h('input', {

              style: S.input,

              placeholder: tab === 'skills' ? '搜索技能，回车查询' : '搜索 MCP 连接器',

              value: query,

              onChange: (e) => setQuery(e.target.value),

              onKeyDown: (e) => {

                if (e.key === 'Enter') {
                  if (tab === 'skills') searchSkills(query, { source, size, category });
                  else searchMcps(query, { source: mcpSource, category: mcpCategory, sort: mcpSort, page: 1, size });
                }

              },

            }),

            h('button', {
              style: S.btn(),
              onClick: () => {
                if (tab === 'skills') searchSkills(query, { source, size, category });
                else searchMcps(query, { source: mcpSource, category: mcpCategory, sort: mcpSort, page: 1, size });
              },
            }, '搜索'))

        : null;

      // 类型 / 分类标签栏：与搜索栏同级、在滚动容器之外，像 Excel 冻结窗格一样常驻。
      const filterBar = (tab === 'skills' || tab === 'mcp')
        ? h('div', { style: S.filterBar },
            h('div', { style: S.row },
                  tab === 'skills'
                    ? ['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'browse.sh', 'lobehub', 'skillhub', 'modelscope'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(source === key),
                          onClick: () => {
                            // 切源时重置分类：新源不一定有分类字段，沿用旧值会导致空列表
                            setSource(key);
                            setCategory('all');
                            // 新源的 chip 词表不同，展开态跨源残留会铺开一屏不相干标签：切源即复位成一行。
                            setCatsExpanded(false);
                            // 切源时若旧源支持的排序键新源不支持，必须回落 default：
                            // 否则 sort 残留（如在 clawhub 选 trending 再切 skillsmp）会下发一个无效键。
                            const nextCaps = capsFor(sortCaps && sortCaps.skills ? sortCaps.skills[key] : null, Boolean(String(query || '').trim()));
                            const curKey = sort === 'default' ? 'installCount' : sort;
                            const keep = sort === 'default' || (nextCaps != null && nextCaps.includes(curKey));
                            const nextSort = keep ? sort : 'default';
                            if (!keep) { prevSortRef.current = 'default'; setSort('default'); }
                            searchSkills(query, { source: key, size, category: 'all', sort: nextSort });
                          },
                        }, key))
                    : ['registry', 'lobehub'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(mcpSource === key),
                          onClick: () => {
                            setMcpSource(key);
                            setMcpCategory('all');
                            setMcpSort('default');
                            setMcpPage(1);
                            searchMcps(query, { source: key, category: 'all', sort: 'default', page: 1 });
                          },
                        }, key === 'registry' ? 'MCP 官方注册表' : 'LobeHub')),
                  h('div', { style: { flex: 1 } }),
                  tab === 'mcp'
                    ? h('select', {
                        style: { ...S.input, flex: '0 0 132px', height: 30 },
                        value: mcpSort,
                        onChange: (e) => {
                          const next = e.target.value;
                          setMcpSort(next);
                          setMcpPage(1);
                          searchMcps(query, { sort: next, page: 1 });
                        },
                      },
                        // 同上：MCP 两个市场的能力表也来自服务端（sortCapabilities.mcp）。
                        // registry 服务端完全不读 sort → 表为空 → 只给「默认顺序」，
                        // 不再给「按名称」这种只重排当前页、翻页就变回去的假选项。
                        ...sortOptions(capsFor(sortCaps && sortCaps.mcp ? sortCaps.mcp[mcpSource] : null, Boolean(String(query || '').trim()))))
                    : h('select', {
                        style: { ...S.input, flex: '0 0 120px', height: 30 },
                        value: sort,
                        onChange: (e) => setSort(e.target.value),
                      },
                        // 排序项由服务端能力表生成（settings.get → sortCapabilities.skills）。
                        // 单一事实源是 src/sort-capability.js；面板不再有内联副本，
                        // 也就不存在「面板显示了服务端不认的键」这类漂移。
                        ...sortOptions(capsFor(sortCaps && sortCaps.skills ? sortCaps.skills[source] : null, Boolean(String(query || '').trim())))),
            ),
            tab === 'mcp' && mcpSource === 'lobehub' && mcpCategories.length > 0
              ? h('div', { style: S.row },
                  ['all', ...mcpCategories.slice(0, 12)].map((cat) =>
                    h('button', {
                      key: cat,
                      style: S.chip(mcpCategory === cat),
                      onClick: () => {
                        setMcpCategory(cat);
                        setMcpPage(1);
                        searchMcps(query, { category: cat, page: 1 });
                      },
                    }, cat === 'all' ? '全部分类' : categoryLabel(cat))))
              : null,
            tab === 'skills' && (categories.length > 0 || vocabChips.length > 0)
              ? h('div', { style: catsExpanded ? S.catsRow : S.chipRow },
                  // 0.5.165 真缺陷（离线+肉眼同证）：foldChips 之后 chipFold.window 里装的是 chip 对象，
                  // 渲染块还按 0.5.164 的字符串数组写——cat === 'all' 恒假、chipBySlug[对象] 取不到、
                  // onClick 还把对象塞进 category。面板上「全部分类」丢失、chip 文案塌成 [object Object]、
                  // 点上去分类参数是假值。既有套件全绿也抓不到它（Test 8 只测窗口集合，不测渲染 map），
                  // 判据补在 test-lobehub-category-vocab Test 8：真跑本块谓词与文案取值。
                  chipEntries.map((chip) => {
                    const cat = chip && chip.value;
                    const foldChip = chipFold.other && chip === chipFold.other;
                    const collapseHere = chip && chip.value === CATS_COLLAPSE;
                    // 入口本体恰好「其他」二字（用户 m23543/m23544 定名）：数字与合计不拼进
                    // chip 文本，只进 title 与说明行；上游真叫「其他」的分类经 categoryLabelLite
                    // 自带条数（如「其他 2360」），文本层面天然区分（0.5.169 撞名教训仍在）。
                    const chipText = foldChip
                      ? chipFold.other.label
                      : categoryLabelLite(chip);
                    if (collapseHere) {
                      // 哨兵只把渲染集合在两态之间换，不参与任何筛选（与合并筛选态互不顶替）。
                      return h('button', { key: 'cat_collapse', style: { ...S.chip(false), whiteSpace: 'nowrap' }, onClick: () => toggleCats(chip.next === true) }, chip.label);
                    }
                    if (foldChip) {
                      // 合并入口不再兼任展开：收缩/展开由行尾哨兵负责（m20051）。
                      // 合并入口 = 真筛选态（0.5.172 用户 m00001）：按下把 CAT_OTHER 放进 category，
                      // 可见集合换成 covers 并集。防线没退：CAT_OTHER 仍由 upstreamCat 降级为
                      // 'all' 才下发（面板自造 slug 绝不进上游），key 是字面量、不含 CAT_OTHER 子串。
                      return h('button', {
                        key: 'cat_tail',
                        style: S.chip(category === cat),
                        title: '未列出的分类还有 ' + chipFold.otherCount + ' 个（同一技能可属多个分类，不设总数）',
                        onClick: () => { setCategory(cat); searchSkills(query, { source, size, category: cat, page: 1, sort }); window.scrollTo({ top: 0, behavior: 'smooth' }); },
                      }, chipText);
                    }
                    return h('button', {
                      key: cat,
                      style: S.chip(category === cat),
                      onClick: () => { setCategory(cat); searchSkills(query, { source, size, category: cat, page: 1, sort }); window.scrollTo({ top: 0, behavior: 'smooth' }); },
                    }, chipText);
                  })
                  )
              : null,
          )
        : null;


      return h('div', {
          style: S.page,
          'data-dsh-market-root': '',
        },
        // 全局滚动条样式（粗 12px、深色 #444 拇指、#1e1e1e 轨道）
        h('style', null,
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar { width: 12px; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-track { background: #f3f4f6; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-thumb { background: #444; border-radius: 6px; border: 2px solid #f3f4f6; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-thumb:hover { background: #222; }' +
          '[data-dsh-market-root] [data-dsh-market-body] { scrollbar-width: thin; scrollbar-color: #444 #f3f4f6; }'),
        h('div', { ref: panelRef, style: S.panel },
          h('div', { style: S.head },
            h('button', { style: S.tab(tab === 'skills'), onClick: () => setTab('skills') }, 'SKILL 技能'),
            h('button', { style: S.tab(tab === 'mcp'), onClick: () => setTab('mcp') }, 'MCP 连接器'),
            h('button', { style: S.tab(tab === 'manage'), onClick: () => setTab('manage') }, '管理'),
            h('button', { style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '路径'),
            h('div', { style: { flex: 1 } }),
            h('span', { style: S.status }, busy ? `处理中：${busy}` : '')),
          searchBar,
          filterBar,
          h('div', { style: S.body, 'data-dsh-market-body': '' },
            tab === 'mcp' && (mcpTotal > 0 || mcps.length > 0)
              ? h('div', { style: S.status },
                  mcpSource === 'lobehub'
                    ? pagerSummary({ label: 'LobeHub', total: mcpTotal, page: mcpPage, n: mcpTotalPages, unknown: !mcpTotalPages, hasMore: mcpHasMore })
                    : `MCP 官方注册表 · 第 ${mcpPage} 页${mcpHasMore ? '（可继续加载）' : ''}`)
              : null,
            error ? h('div', { style: S.err }, error) : null,
            notice ? h('div', { style: S.status }, notice) : null,
            nearbyNeedle
              ? h('div', { style: { ...S.row, gap: 8, alignItems: 'center' } },
                  h('span', { style: S.status }, '该分类在已取回的条目里没有命中：分类是本地过滤口径，条目可能排在可达集合之外。可以用分类名做一次全文搜索（近似，不等于该分类）：'),
                  h('button', {
                    style: S.chip(false),
                    onClick: () => { setQuery(nearbyNeedle); setCategory('all'); searchSkills(nearbyNeedle, { source, size, category: 'all', page: 1, sort }); window.scrollTo({ top: 0, behavior: 'smooth' }); },
                  }, '近似搜索「' + nearbyNeedle + '」'))
              : null,
            tailNote ? h('div', { style: { ...S.status, marginTop: 8 } }, tailNote) : null,
            installProgress
              ? h('div', { style: { ...S.row, gap: 10, alignItems: 'center' } },
                  h('span', { style: { fontSize: 12, whiteSpace: 'nowrap' } },
                    `${installProgress.serverName} 正在启动，已等待 ${Math.round(installProgress.waitedMs / 1000)}s`),
                  // 确定性进度条：按已等待时长 / 预算推进（npx 首次运行需下载依赖，故给足预算）
                  h('div', { style: { flex: 1, height: 6, borderRadius: 3, background: 'var(--dsh-surface-raised, #eaeef2)', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        height: '100%',
                        width: Math.min(100, Math.round((installProgress.waitedMs / MAX_PROGRESS_MS) * 100)) + '%',
                        background: 'var(--dsh-accent, #3b82f6)',
                        transition: 'width 0.6s linear',
                      },
                    })),
                  h('span', { style: { fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap' } },
                    `${Math.min(100, Math.round((installProgress.waitedMs / MAX_PROGRESS_MS) * 100))}% / 上限 ${Math.round(MAX_PROGRESS_MS / 1000)}s`))
              : null,
            envPrompt
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `${envPrompt.slug} 需要环境变量`),
                  envPrompt.missing.map((name) =>
                    h('div', { key: name, style: S.row },
                      h('span', { style: { width: 220, fontSize: 12, opacity: 0.8 } }, name),
                      h('input', {
                        style: S.input,
                        type: 'password',
                        placeholder: `填写 ${name}`,
                        value: envDraft[name] || '',
                        onChange: (e) => setEnvDraft({ ...envDraft, [name]: e.target.value }),
                      }))),
                  h('div', { style: S.status }, '保存后会写入 Windows 用户环境变量（对新进程持久生效），并立即连接。'),
                  h('div', { style: S.row },
                    h('button', {
                      style: S.btn('primary'),
                      disabled: busy === `install:${envPrompt.slug}`,
                      onClick: () => doInstallMcp({ slug: envPrompt.slug }, envDraft),
                    }, '写入并连接'),
                    h('button', { style: S.btn(), onClick: () => setEnvPrompt(null) }, '取消')))
              : null,
            detail
              ? h('div', {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(15, 23, 42, 0.45)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    padding: '40px 16px',
                    overflowY: 'auto',
                    zIndex: 1000,
                  },
                },
                  h('div', {
                    style: {
                      width: '100%',
                      maxWidth: 560,
                      background: 'var(--dsh-card, #fff)',
                      borderRadius: 12,
                      padding: 20,
                      boxShadow: '0 16px 48px rgba(15, 23, 42, 0.28)',
                    },
                  },
                    h('div', { style: { ...S.title, fontSize: 14 } }, detail.kind === 'quality' ? '质量评测：' + detail.slug : (detail.kind === 'skill' ? '技能' : 'MCP') + '：' + detail.slug),
                    detail.kind === 'mcp' && detail.data && (detail.data.detailSource || detail.data.rating != null || visibleCounts(detail.data).installs != null || detail.data.description) ? h('div', { style: { ...S.meta, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 } }, [
                      detail.data.description ? h('span', { key: 'desc', style: { fontSize: 12, opacity: 0.85 } }, detail.data.description) : null,
                      h('div', { key: 'chips', style: S.row }, [
                        detail.data.rating != null ? h('span', { key: 'rating', style: S.chip() }, `评分 ${detail.data.rating}`) : null,
                        visibleCounts(detail.data).installs != null ? h('span', { key: 'installs', style: S.chip() }, `安装 ${Number(visibleCounts(detail.data).installs).toLocaleString()}`) : null,
                        detail.data.category ? h('span', { key: 'cat', style: S.chip() }, detail.data.category) : null,
                        detail.data.detailSource ? h('span', { key: 'src', style: { fontSize: 11, opacity: 0.6 } }, `详情来源：${detail.data.detailSource}`) : null,
                      ]),
                      detail.data.envRequired && detail.data.envRequired.length ? h('span', { key: 'env', style: { fontSize: 11, opacity: 0.7 } }, `需环境变量：${detail.data.envRequired.join(', ')}`) : null,
                      detail.data.homepage ? h('a', { key: 'hp', style: { fontSize: 11, color: 'var(--dsh-accent, #2f6feb)', cursor: 'pointer' }, onClick: () => { try { window.open(detail.data.homepage, '_blank'); } catch {} } }, detail.data.homepage) : null,
                    ]) : null,
                    detail.kind === 'quality'
                      ? h('div', { style: { marginTop: 12 } },
                          detail.data.summary
                            ? h('div', { style: { ...S.status, fontSize: 12, lineHeight: 1.5 } }, detail.data.summary)
                            : h('div', { style: { ...S.status, fontSize: 12 } }, '上游未提供总体小结。'),
                          (detail.data.dimensions || []).map((d) =>
                            h('div', { key: d.key, style: { marginTop: 8 } },
                              h('div', { style: S.row },
                                h('span', { style: { fontSize: 12, fontWeight: 600 } }, d.label),
                                d.score != null
                                  ? h('span', { style: { ...S.chip(), marginLeft: 8 } }, '子项均分 ' + d.score + (d.scored ? '（' + d.scored + ' 项）' : ''))
                                  : h('span', { style: { ...S.status, marginLeft: 8 } }, '该维度无评分子项'),
                              ),
                              d.reason ? h('div', { style: { ...S.status, fontSize: 11, marginTop: 2, whiteSpace: 'pre-wrap' } }, d.reason) : null,
                            )),
                        )
                      : detail.kind === 'skill'
                      ? h('div', { style: { marginTop: 12 } },
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '描述'),
                            h('input', {
                              style: S.input,
                              placeholder: '留空则不修改',
                              value: draft.description || '',
                              onChange: (e) => setDraft({ ...draft, description: e.target.value }),
                            })),
                          h('textarea', {
                            style: { ...S.input, height: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 10 },
                            value: draft.body || '',
                            onChange: (e) => setDraft({ ...draft, body: e.target.value }),
                          }))
                          : h('div', { style: { marginTop: 12 } },
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '命令'),
                              h('input', { style: S.input, placeholder: '可执行文件，如 npx、node 或绝对路径', value: draft.command || '', onChange: (e) => { setDraft({ ...draft, command: e.target.value }); setMcpConfirmArmed(false); } })),
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '参数'),
                              h('textarea', {
                                style: { ...S.input, height: 60, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                                value: draft.args || '',
                                placeholder: '每行一个参数',
                                onChange: (e) => { setDraft({ ...draft, args: e.target.value }); setMcpConfirmArmed(false); },
                              })),
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, 'URL'),
                              h('input', { style: S.input, value: draft.url || '', onChange: (e) => setDraft({ ...draft, url: e.target.value }) })),
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '传输'),
                              h('select', { style: { ...S.input, width: 220 }, value: draft.transport || 'stdio', onChange: (e) => setDraft({ ...draft, transport: e.target.value }) },
                                h('option', { value: 'stdio' }, 'stdio（本机命令）'), h('option', { value: 'streamable-http' }, 'streamable-http（远程 URL）'))),
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '工作目录'),
                              h('input', { style: S.input, value: draft.cwd || '', onChange: (e) => setDraft({ ...draft, cwd: e.target.value }) })),
                            h('div', { style: S.row },
                              h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '超时 ms'),
                              h('input', { style: { ...S.input, width: 140 }, type: 'number', value: draft.toolCallTimeoutMs || '', placeholder: '60000', onChange: (e) => setDraft({ ...draft, toolCallTimeoutMs: e.target.value }) })),
                            h('div', { style: { ...S.status, fontSize: 11 } },
                              '改动命令或参数会在下一次点击时要求确认——那是在本机执行程序的改动。'),
                            h('div', { style: { marginTop: 8 } },
                              h('span', { style: { fontSize: 12, fontWeight: 600 } }, '环境变量'),
                              (draft.envRows || []).map((row, idx) => h('div', { key: `e-${idx}`, style: { ...S.row, marginTop: 4 } },
                                h('input', { style: { ...S.input, flex: '0 0 180px' }, placeholder: 'KEY', value: row.key, onChange: (e) => { const rows = (draft.envRows || []).slice(); rows[idx] = { ...rows[idx], key: e.target.value }; setDraft({ ...draft, envRows: rows }); } }),
                                h('input', { style: { ...S.input, flex: 1 }, placeholder: '值；来自环境变量的引用显示为掩码，不动即不修改', value: row.value, onChange: (e) => { const rows = (draft.envRows || []).slice(); rows[idx] = { ...rows[idx], value: e.target.value }; setDraft({ ...draft, envRows: rows }); } }),
                                h('button', { style: { ...S.btn(), ...S.danger }, title: '删除该变量（保存时从定义里移除）', onClick: () => setDraft({ ...draft, envRows: (draft.envRows || []).filter((x, i2) => i2 !== idx) }) }, '删'))),
                              h('button', { style: S.btn(), onClick: () => setDraft({ ...draft, envRows: [...(draft.envRows || []), { key: '', value: '' }] }) }, '＋ 添加变量')),
                            h('div', { style: { marginTop: 8 } },
                              h('span', { style: { fontSize: 12, fontWeight: 600 } }, '请求头'),
                              (draft.headerRows || []).map((row, idx) => h('div', { key: `h-${idx}`, style: { ...S.row, marginTop: 4 } },
                                h('input', { style: { ...S.input, flex: '0 0 180px' }, placeholder: 'Header-Name', value: row.key, onChange: (e) => { const rows = (draft.headerRows || []).slice(); rows[idx] = { ...rows[idx], key: e.target.value }; setDraft({ ...draft, headerRows: rows }); } }),
                                h('input', { style: { ...S.input, flex: 1 }, placeholder: '值（掩码同上）', value: row.value, onChange: (e) => { const rows = (draft.headerRows || []).slice(); rows[idx] = { ...rows[idx], value: e.target.value }; setDraft({ ...draft, headerRows: rows }); } }),
                                h('button', { style: { ...S.btn(), ...S.danger }, onClick: () => setDraft({ ...draft, headerRows: (draft.headerRows || []).filter((x, i2) => i2 !== idx) }) }, '删'))),
                              h('button', { style: S.btn(), onClick: () => setDraft({ ...draft, headerRows: [...(draft.headerRows || []), { key: '', value: '' }] }) }, '＋ 添加请求头')),
                            h('pre', { style: { fontSize: 11, opacity: 0.8, whiteSpace: 'pre-wrap', margin: '10px 0 0', background: 'rgba(15, 23, 42, 0.04)', padding: 8, borderRadius: 6 } },
                              JSON.stringify({ transport: detail.data.transport, env: detail.data.env, headers: detail.data.headers }, null, 2))),
                    mcpRaw && detail.kind === 'mcp'
                      ? h('div', { style: { marginTop: 10, border: '1px solid var(--dsh-border, #d0d7de)', borderRadius: 8, padding: 10 } },
                          h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
                            h('span', { style: { fontWeight: 700, fontSize: 12 } }, '定义原文'),
                            h('button', { style: S.btn(), onClick: () => setMcpRaw(null) }, '收起')),
                          mcpRaw.loading && !mcpRaw.text
                            ? h('div', { style: S.status }, '正在读取原文…')
                            : mcpRaw.error && !mcpRaw.text
                              ? h('div', { style: { ...S.err, wordBreak: 'break-word' } }, mcpRaw.error)
                              : h('div', null,
                                  mcpRaw.hasSecrets
                                    ? h('div', { style: { ...S.status, fontSize: 11, color: '#b26a00', marginBottom: 6 } },
                                        '注意：原文视图会显示环境变量明文（detail 的掩码在这里失效），保存前请确认这台机器可信。')
                                    : null,
                                  h('textarea', {
                                    // 用户实测「文本框太小难用」：定义原文是整份 JSON，180px 只能看七八行。
                                    style: { ...S.input, height: 480, resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 11, whiteSpace: 'pre' },
                                    value: mcpRaw.text,
                                    spellCheck: false,
                                    onChange: (e) => setMcpRaw({ ...mcpRaw, text: e.target.value, dirty: true, error: '' }),
                                  }),
                                  mcpRaw.filePath ? h('div', { style: { ...S.status, fontSize: 11, marginTop: 4, wordBreak: 'break-all' } }, shortPath(mcpRaw.filePath, homeDir)) : null,
                                  mcpRaw.error ? h('div', { style: { ...S.err, marginTop: 6, wordBreak: 'break-word' } }, mcpRaw.error) : null,
                                  h('div', { style: { ...S.row, marginTop: 8, justifyContent: 'flex-end', gap: 8 } },
                                    h('button', {
                                      style: S.btn('primary'),
                                      disabled: !mcpRaw.dirty || mcpRaw.loading || busy === 'save:mcp',
                                      title: '直接写回原文（保留字节与未知字段）；command/args 与当前定义不同则拒绝',
                                      onClick: saveMcpRaw,
                                    }, mcpRaw.loading ? '保存中…' : '保存原文'))))
                      : null,
                    h('div', { style: { ...S.meta, marginTop: 10 } }, h('span', null, detail.data.path || '')),
                    h('div', { style: { ...S.row, marginTop: 14, justifyContent: 'flex-end', gap: 8 } },
                      detail.kind === 'mcp'
                        ? h('button', { style: S.btn(), disabled: busy === 'save:mcp', title: '直接编辑定义文件原文（表单覆盖不到的字段）', onClick: () => openMcpRaw(detail.slug) },
                            mcpRaw && mcpRaw.serverName === detail.slug ? '收起原文' : '原文')
                        : null,
                      h('button', { style: S.btn(), onClick: () => { setDetail(null); setMcpRaw(null); setMcpConfirmArmed(false); } }, '关闭'),
                      detail.kind === 'skill'
                        ? h('button', { style: S.btn('primary'), disabled: busy === 'save:skill', onClick: saveSkillEdit }, '保存')
                        : detail.kind === 'quality'
                          ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, '只读视图')
                          : h('button', { style: S.btn('primary'), disabled: busy === 'save:mcp', onClick: saveMcpEdit }, mcpConfirmArmed ? '确认保存（命令已改动）' : '保存并重连'))))
              : null,
            // 已装 MCP 工具清单浮窗：点卡片本体打开，列全部工具的名称/描述，参数 schema 逐个可展开。
            mcpTools
              ? h('div', {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(15, 23, 42, 0.45)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1200,
                  },
                  onClick: () => setMcpTools(null),
                },
                  h('div', {
                    style: {
                      width: '100%',
                      maxWidth: 620,
                      maxHeight: '80vh',
                      overflow: 'auto',
                      background: 'var(--dsh-card, #fff)',
                      borderRadius: 12,
                      padding: 20,
                      boxShadow: '0 16px 48px rgba(15, 23, 42, 0.28)',
                    },
                    onClick: (e) => e.stopPropagation(),
                  },
                    h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                      h('div', { style: { ...S.title, fontSize: 14 } },
                        toolQuery
                          ? `${mcpTools.title} · 匹配 ${visibleTools.length}/${mcpTools.toolDetails.length} 个工具`
                          : `${mcpTools.title} · ${mcpTools.toolDetails.length} 个工具`),
                      h('button', { style: S.btn(), onClick: () => setMcpTools(null) }, '关闭')),
                    h('input', {
                      style: { ...S.input, marginTop: 8 },
                      placeholder: '搜索工具名或描述',
                      value: toolQuery,
                      onChange: (e) => setToolQuery(e.target.value),
                    }),
                    !mcpTools.hasDetails
                      ? h('div', { style: { ...S.status, marginTop: 8 } },
                          '当前服务端未提供工具详情，请点击菜单「重启应用与 Host」后重试。')
                      : mcpTools.toolDetails.length === 0
                        ? h('div', { style: { ...S.status, marginTop: 8 } },
                            mcpTools.mounted
                              ? '已挂载，但还没发布工具（服务器可能仍在启动，稍后重开）。'
                              : '该连接器当前未挂载，所以还没有向模型注册任何工具；启用并连接后再查看。')
                        : null,
                    toolQuery && mcpTools.hasDetails && visibleTools.length === 0 && mcpTools.toolDetails.length > 0
                      ? h('div', { style: { ...S.status, marginTop: 8 } }, '没有匹配的工具（换个关键词）。')
                      : null,
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
                      renderedTools.map((tool) => {
                        const short = tool.name.replace(/^mcp__[A-Za-z0-9_-]+__/, '');
                        const open = mcpToolOpen === tool.name;
                        return h('div', { key: tool.name, style: { ...S.card, padding: 10 } },
                          h('div', { style: { ...S.row, justifyContent: 'space-between', cursor: 'pointer' },
                            onClick: () => setMcpToolOpen(open ? '' : tool.name) },
                            h('label', { style: { ...S.row, gap: 6, cursor: mcpTools.hasDetails ? 'default' : 'not-allowed' },
                              onClick: (e) => e.stopPropagation(),
                              title: mcpTools.hasDetails ? '勾选 = 禁用该工具（从模型工具表消失，真正省上下文）；取消勾选 = 重新启用' : '旧服务端未提供工具详情，无法编辑禁用列表',
                            },
                              h('input', {
                                type: 'checkbox',
                                disabled: !mcpTools.hasDetails,
                                checked: toolDenyDraft.includes(tool.name),
                                onChange: () => setToolDenyDraft((prev) => (prev.includes(tool.name) ? prev.filter((x) => x !== tool.name) : [...prev, tool.name])),
                              }),
                              h('span', { style: { fontWeight: 600, fontFamily: 'ui-monospace, monospace', fontSize: 12 } }, short)),
                            h('span', { style: { ...S.status, fontSize: 11 } }, open ? '收起参数' : '展开参数')),
                          h('div', { style: { ...S.desc, marginTop: 4 } }, tool.description || '（上游未提供描述）'),
                          open
                            ? h('pre', {
                              style: { fontSize: 11, opacity: 0.85, whiteSpace: 'pre-wrap', margin: '8px 0 0', background: 'rgba(15, 23, 42, 0.04)', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto' },
                            }, tool.parameters ? JSON.stringify(tool.parameters, null, 2) : '（无参数 schema）')
                            : null);
                      }))),
                    toolQuery && visibleTools.length > TOOL_BATCH * toolBatch
                      ? h('div', { style: { ...S.row, justifyContent: 'center', marginTop: 8 } },
                          h('button', { style: S.btn(), onClick: () => setToolBatch((n) => n + 1) },
                            `继续显示 ${Math.min(TOOL_BATCH, visibleTools.length - TOOL_BATCH * toolBatch)} 个（还有 ${visibleTools.length - TOOL_BATCH * toolBatch} 个未显示）`))
                      : null,
                    mcpTools.hasDetails && mcpTools.toolDetails.length > 0
                      ? h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 10 } },
                          h('span', { style: { ...S.status, fontSize: 11 } },
                            `已禁用 ${toolDenyDraft.length} 个`,
                            toolDenyApplied > 0 ? ` · ${toolDenyApplied} 个会话已生效` : ''),
                          // 全选/全不选作用于「当前搜索可见」这一口径，和技能批量条一致；
                          // 分批还没显示完时只算已显示的部分，并在标题里写明，避免用户以为全选了整份清单。
                          h('button', {
                            style: S.btn(),
                            disabled: !mcpTools.hasDetails || renderedTools.length === 0,
                            title: visibleTools.length > renderedTools.length
                              ? `只作用于已显示的 ${renderedTools.length} 个（还有 ${visibleTools.length - renderedTools.length} 个未显示，需先点“继续显示”）`
                              : `全选/全不选当前搜索可见的 ${renderedTools.length} 个工具`,
                            onClick: () => {
                              // 注意：这里刻意不用带括号的箭头参数写法，那个形式是 perf 套件的唯一起锚。
                              const names = renderedTools.map(tool => tool.name);
                              const allOn = names.every((n) => toolDenyDraft.includes(n));
                              setToolDenyDraft(allOn ? toolDenyDraft.filter((n) => !names.includes(n)) : [...new Set([...toolDenyDraft, ...names])]);
                            },
                          }, renderedTools.length && renderedTools.every((tool) => toolDenyDraft.includes(tool.name)) ? '全不选' : '全选'),
                          h('button', {
                            style: S.btn('primary'),
                            disabled: busy === 'saveToolDeny' || toolDenyDraft.join('\u0000') === (mcpTools.deniedOriginal || []).join('\u0000'),
                            onClick: () => saveToolDeny(mcpTools.serverName, toolDenyDraft),
                          }, busy === 'saveToolDeny' ? '保存中…' : '保存禁用列表'))
                      : null)
              : null,
            // 分批未渲染完时给出显式续加载入口；空态仍由 notice（服务端整页数据）判定，
            // 不会因为裁切了渲染列表而误报「没有找到」。
            (tab === 'skills' ? visibleSkills : orderedMcps).length > cardStepFor(size) * cardBatch
              ? h('div', { style: { ...S.row, justifyContent: 'center', marginTop: 8 } },
                  h('button', { style: S.btn(), onClick: () => setCardBatch((n) => n + 1) },
                    '继续显示 ' + Math.min(cardStepFor(size), (tab === 'skills' ? visibleSkills : orderedMcps).length - cardStepFor(size) * cardBatch) + ' 个'),
                  h('span', { style: { ...S.status, marginLeft: 6 } },
                    '还有 ' + ((tab === 'skills' ? visibleSkills : orderedMcps).length - cardStepFor(size) * cardBatch) + ' 个未渲染'))
              : null,
            tab === 'skills' ? h('div', { style: S.grid }, skillCards) : null,
            tab === 'mcp' ? h('div', { style: S.grid }, mcpCards) : null,
            // 分页导航：上一页/下一页 + 页码（省略号折叠）+ 每页条数选择器，两个 Tab 统一。
            (tab === 'skills' || tab === 'mcp')
              ? h('div', { style: S.row },
                  h('div', { style: S.row },
                    h('select', {
                      style: { ...S.input, flex: '0 0 96px', height: 28 },
                      value: String(size),
                      onChange: (e) => {
                        const nextSize = Number(e.target.value) || 24;
                        setSize(nextSize);
                        if (tab === 'skills') searchSkills(query, { source, size: nextSize, page: 1 });
                        else searchMcps(query, { page: 1, size: nextSize });
                      },
                    }, [12, 24, 48].map((n) =>
                      h('option', { key: n, value: String(n) }, `每页 ${n}`))),
                  h('div', { style: S.row },
                    pager(
                      tab === 'skills' ? skillsPage : mcpPage,
                      tab === 'skills' ? skillsTotalPages : mcpTotalPages,
                      tab === 'skills' ? skillsHasMore : mcpHasMore,
                      tab === 'skills' ? '共' : '',
                      tab === 'skills' ? skillsTotal : mcpTotal,
                       tab === 'skills' ? pageJump : mcpPageJump,
                       tab === 'skills' ? setPageJump : setMcpPageJump))))
              : null,
            tab === 'manage' ? h('div', { 'data-manage-tab': manageTab, style: { display: 'flex', flexDirection: 'column', gap: 12, flex: 1, width: '100%', alignItems: 'stretch' } },
              // 二级页签：技能侧（上传/列表/回收站）与 MCP 侧各自成页；
              // 记忆上次停留页，aria 属性兼作 test-manage-panel 的结构锚点。
              h('div', { style: { ...S.row, gap: 2, borderBottom: '1px solid var(--dsh-border, #d0d7de)', marginBottom: 2 }, role: 'tablist' },
                h('button', { type: 'button', style: S.subTab(manageTab === 'skill'), 'aria-selected': manageTab === 'skill', onClick: () => switchManageTab('skill') }, `SKILL 技能 (${installed === null ? '读取中' : installed.length})`),
                h('button', { type: 'button', style: S.subTab(manageTab === 'mcp'), 'aria-selected': manageTab === 'mcp', onClick: () => switchManageTab('mcp') }, `MCP 连接器 (${mounted === null ? '读取中' : mounted.length})`)),
              manageTab === 'skill' ? h('div', {
                // position:relative 是浮层的包含块：没有它，absolute 会锚到 S.page，
                // 浮层飞到整个面板右上角盖住 tab 栏（实测祖先链只有 S.page 有 position）。
                style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 12, width: '100%' },
                // 拖拽热区 = 整个技能列表容器（旧版热区是上传行里的小虚线框，且该框从未闭合）。
                onDragOver: (e) => { e.preventDefault(); if (!dragOver) setDragOver(true); },
                onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); },
                onDrop: handleSkillDrop,
              },
              dragOver ? h('div', { style: { ...S.status, textAlign: 'center', padding: 8, border: '2px dashed var(--dsh-accent, #3b82f6)', borderRadius: 8, color: 'var(--dsh-accent, #3b82f6)' } }, '松开即可上传（根目录或一级子目录必须含 SKILL.md）') : null,
              // 上传技能：拖拽文件夹或点按钮选文件夹。宿主 @deepseek-ai 包没有 showOpenDialog
              // 暴露给插件，面板是 web 页面，用 <input type=file webkitdirectory>（Chromium
              // 弹原生文件夹对话框，效果与 workbuddy 相同）。拖拽事件里 dataTransfer.files
              // 是扁平文件列表，没有 webkitRelativePath，用首个文件的 name 前缀推断根目录。
              uploadOpen ? h('div', {
                ref: uploadRef,
                role: 'dialog',
                'aria-label': '添加技能',
                // 绝对定位浮层：锚在技能容器右上角，脱离文档流 → 搜索框/列表/回收站零位移
                //（旧版是插队横幅，实测打开后整页下移 62px）。
                style: {
                  position: 'absolute',
                  right: 0,
                  top: 46,
                  zIndex: 60,
                  width: 'min(430px, 92%)',
                  background: 'var(--dsh-surface, #ffffff)',
                  border: '1px solid var(--dsh-border, #d0d7de)',
                  borderRadius: 10,
                  boxShadow: '0 12px 32px rgba(15, 23, 42, 0.20)',
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                },
              },
                h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'nowrap' } },
                  h('span', { style: { fontWeight: 700, fontSize: 13 } }, '添加技能'),
                  h('button', { type: 'button', style: { ...S.btn(), padding: '0 8px', height: 24, fontSize: 12 }, title: '关闭（Esc）', onClick: () => setUploadOpen(false) }, '✕')),
                h('div', { style: { ...S.status, fontSize: 12 } }, '选择技能文件夹上传，或'),
                h('button', {
                  style: S.btn('primary'),
                  disabled: busy === 'upload',
                  onClick: async () => {
                    setBusy('upload');
                    setUploadError('');
                    setNotice('');
                    try {
                      const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.webkitdirectory = true;
                      input.multiple = true;
                      input.style.display = 'none';
                      document.body.appendChild(input);
                      const picked = await new Promise((resolve) => {
                        input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
                        input.click();
                      });
                      document.body.removeChild(input);
                      if (!picked.length) return;
                      const files = [];
                      for (const f of picked) {
                        const rel = (f.webkitRelativePath || f.name).split('/').join('/');
                        const parts = rel.split('/');
                        if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
                        const text = await f.text();
                        files.push({ path: rel, content: text });
                      }
                      const result = await call('skills.upload', { files, force: false });
                      const n = result.count || (result.items || []).length;
                      setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
                      await loadInstalled();
                      setTimeout(() => setUploadOpen(false), 600);
                    } catch (e) {
                      setUploadError(`上传失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '浏览文件夹'),
                h('button', {
                  style: S.btn(),
                  disabled: busy === 'uploadZip',
                  onClick: async () => {
                    setBusy('uploadZip');
                    setUploadError('');
                    setNotice('');
                    try {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = '.zip,application/zip';
                      input.style.display = 'none';
                      document.body.appendChild(input);
                      const picked = await new Promise((resolve) => {
                        input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
                        input.click();
                      });
                      document.body.removeChild(input);
                      if (!picked) return;
                      if (picked.size > 4 * 1024 * 1024) throw new Error(`压缩包 ${(picked.size / 1024 / 1024).toFixed(1)}MB 超过 4MB 上限`);
                      const buf = await picked.arrayBuffer();
                      let binary = '';
                      const bytes = new Uint8Array(buf);
                      const CHUNK = 0x8000;
                      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
                      }
                      const d = await call('skills.importZip', { dataBase64: btoa(binary), fileName: picked.name });
                      setNotice(`已从 ${d.fileName} 导入 ${d.slug}（${d.files} 个文件，压缩包内 ${d.entries} 项）${d.skipped && d.skipped.length ? `；跳过 ${d.skipped.length} 项` : ''}`);
                      await loadInstalled();
                      setTimeout(() => setUploadOpen(false), 600);
                    } catch (e) {
                      setUploadError(`导入 .zip 失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, busy === 'uploadZip' ? '导入中…' : '导入 .zip'),
                h('span', { style: { ...S.status, fontSize: 11 } }, '也可以把技能文件夹直接拖到本列表区域（根目录或一级子目录必须含 SKILL.md）'),
                h('div', { style: { ...S.status, fontSize: 11, wordBreak: 'break-all' } },
                  `安装到 ${shortPath((settings && settings.settings && settings.settings.skillDirs && settings.settings.skillDirs[0]) || '(未配置技能目录)', homeDir)}`,
                  ' · zip ≤ 4MB'),
                uploadError ? h('div', { style: { ...S.err, wordBreak: 'break-word' } }, uploadError) : null,
              )
              : null,
              h('div', { style: { ...S.row, gap: 8, flexWrap: narrow ? 'wrap' : 'nowrap' } },
                h('input', {
                  style: { ...S.input, flex: 1, minWidth: 120 },
                  placeholder: '搜索已装技能（名称、描述）',
                  value: manageSkillFilter,
                  onChange: (e) => setManageSkillFilter(e.target.value),
                }),
                manageSkillFilter ? h('button', { style: S.btn(), onClick: () => setManageSkillFilter('') }, '清除') : null,
                h('select', {
                  style: { ...S.input, width: 96, flex: '0 0 auto' },
                  value: manageSkillState,
                  title: '按启用状态筛选（文件级与面板级停用一并计入）',
                  onChange: (e) => {
                    const v = e.target.value;
                    setManageSkillState(v);
                    try { window.localStorage.setItem(SKILL_STATE_KEY, v); } catch { /* 拒绝存储的浏览器只是不记忆，不影响本次筛选 */ }
                  },
                }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'on' }, '已启用'), h('option', { value: 'off' }, '已停用')),
                h('button', {
                  style: S.btn(uploadOpen ? 'primary' : undefined),
                  'aria-expanded': uploadOpen,
                  'data-upload-trigger': '1',
                  onClick: () => setUploadOpen(!uploadOpen),
                }, uploadOpen ? '收起上传' : '＋ 添加技能'),
                h('button', {
                  style: S.btn(batchMode ? 'primary' : undefined),
                  'aria-pressed': batchMode,
                  title: batchMode ? '退出批量模式' : '批量启用/停用/卸载技能',
                  onClick: () => { if (batchMode) exitBatch(); else { setBatchMode(true); setBatchConfirm(false); } },
                }, batchMode ? '退出选择' : '选择')),
              h('div', { style: { ...S.title, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装技能（${filteredInstalled.length}）`,
                (() => {
                  const on = filteredInstalled.filter((i) => !skillStateOff(i)).length;
                  return h('span', { style: { ...S.status, fontSize: 11, fontWeight: 400 } }, `已启用 ${on} · 已停用 ${filteredInstalled.length - on}`);
                })(),
                h('select', {
                  style: { ...S.input, width: 104, flex: '0 0 auto', height: 24, fontSize: 12 },
                  value: manageSkillSort,
                  title: '组内排序（纯前端呈现序；来源分组与层级不受影响）',
                  onChange: (e) => {
                    const v = e.target.value;
                    setManageSkillSort(v);
                    try { window.localStorage.setItem(SKILL_SORT_KEY, v); } catch { /* 拒绝存储只是不记忆 */ }
                  },
                }, h('option', { value: 'default' }, '默认顺序'), h('option', { value: 'name' }, '按名称'),
                  h('option', { value: 'on' }, '启用优先'), h('option', { value: 'off' }, '停用优先')),
                sortOrderUnchanged ? h('span', { style: { ...S.status, fontSize: 11, color: '#b26a00' } }, '排序没有改变可见顺序（每个来源组内只有一项）') : null,
                nativeDirs.length > 0
                  ? h('span', { style: { fontSize: 11, opacity: 0.6, fontWeight: 400 } }, `含 DSH 内置 ${nativeDirs.length} 个目录`)
                  : null,
                h('span', { style: { flex: 1 } }),
                !batchMode ? h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, title: '展开所有来源分组', onClick: () => collapseAllGroups(false) }, '全部展开') : null,
                !batchMode ? h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, title: '折叠所有来源分组；折叠的项不参与批量选择', onClick: () => collapseAllGroups(true) }, '全部折叠') : null,
                !batchMode ? h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  title: '在资源管理器中直接查看 / 编辑技能文件',
                  disabled: busy === 'openDir:skills',
                  onClick: async () => {
                    setBusy('openDir:skills');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'skills' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录') : null),
              batchMode && filteredInstalled.length > 0
                ? h('div', {
                    // 复用技能容器的 position:relative（0.5.119 为上传浮层加的）→ 零位移浮条
                    style: {
                      position: 'absolute', left: 0, right: 0, top: 46, zIndex: 55,
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: narrow ? 'wrap' : 'nowrap',
                      background: 'var(--dsh-surface, #ffffff)',
                      border: '1px solid var(--dsh-border, #d0d7de)',
                      borderRadius: 10, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
                      padding: '8px 12px',
                    },
                  },
                    h('span', { style: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' } }, `已选 ${selectedVisible.length} 项`),
                    h('button', { style: S.btn(), onClick: () => setSelected((prev) => {
                      const all = new Set(expandedVisible.map((i) => String(i.slug)));
                      const isAll = selectedVisible.length === expandedVisible.length && expandedVisible.length > 0;
                      return isAll ? new Set() : all;
                    }) }, selectedVisible.length === expandedVisible.length && expandedVisible.length > 0 ? '全不选' : '全选'),
                    h('button', { style: S.btn(), disabled: selectedVisible.length === 0 || busy === 'batch',
                      onClick: () => runBatch('启用', 'enable', selectedVisible) }, '全部启用'),
                    h('button', { style: S.btn(), disabled: selectedVisible.length === 0 || busy === 'batch',
                      onClick: () => runBatch('停用', 'disable', selectedVisible) }, '全部停用'),
                    !batchConfirm
                      ? h('button', { style: { ...S.btn(), ...S.danger }, disabled: selectedVisible.length === 0,
                          onClick: () => setBatchConfirm(true) }, '批量卸载')
                      : h('span', { style: { ...S.row, gap: 6, flexWrap: narrow ? 'wrap' : 'nowrap' } },
                          h('button', { style: { ...S.btn(), ...S.danger }, disabled: busy === 'batch',
                            onClick: () => { setBatchConfirm(false); runBatch('卸载', 'uninstall', selectedVisible); } },
                            `确认卸载 ${selectedVisible.length} 项`),
                          h('button', { style: S.btn(), onClick: () => setBatchConfirm(false) }, '取消')),
                    h('span', { style: { flex: 1 } }),
                    h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, title: '展开所有来源分组', onClick: () => collapseAllGroups(false) }, '全部展开'),
                    h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, title: '折叠所有来源分组；折叠的项不参与批量选择', onClick: () => collapseAllGroups(true) }, '全部折叠'),
                    h('button', { style: S.btn(), onClick: exitBatch }, '退出选择'))
                : null,
              filteredInstalled.length === 0
                ? h('div', { style: S.dim }, manageSkillState !== 'all' || skillFilterText
                    ? '没有符合筛选条件的技能（试试清除筛选）。'
                    : '还没有已安装技能。点右上角「＋ 添加技能」上传。')
                : h('div', { style: S.grid }, installedSkills),
              (skillFilterText || manageSkillState !== 'all') && filteredInstalled.length > 0 && expandedVisible.length === 0
                ? h('div', { style: { ...S.status, fontSize: 11, marginTop: 4 } },
                    '命中项都在折叠分组里（展开对应来源才看得到，或点「全部展开」）。')
                : null,
              h('div', { style: { ...S.row, gap: 8, marginTop: 6, flexWrap: narrow ? 'wrap' : 'nowrap' } },
                h('button', {
                  type: 'button',
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  'aria-expanded': trashOpen,
                  title: trashOpen ? '收起回收站' : '展开回收站（含已删除技能的恢复入口）',
                  onClick: () => {
                    const next = !trashOpen;
                    setTrashOpen(next);
                    try { window.localStorage.setItem(TRASH_OPEN_KEY, next ? '1' : '0'); } catch { /* 拒绝存储的浏览器只是不记忆 */ }
                  },
                }, (trashOpen ? '▾' : '▸') + ' 回收站（' + (trashList ? trashList.items.length : '?') + '）'),
                h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: trashBusy === 'list', onClick: loadTrash }, trashBusy === 'list' ? '读取中…' : '读取回收站'),
                trashList && trashList.items.length > 0
                  ? h('button', { style: { ...S.btn(), ...S.danger, padding: '2px 10px', height: 24, fontSize: 12 }, disabled: trashBusy === 'empty', onClick: emptyTrashAll }, trashBusy === 'empty' ? '清空中…' : '清空回收站')
                  : null,
                h('span', { style: { ...S.status, fontSize: 11 } }, '删除即移入 .trash，可随时恢复')),
              trashOpen
                ? (trashList && trashList.items.length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto', width: '100%' } },
                      trashList.items.map((item) => h('div', {
                        key: item.path,
                        style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 1.2fr) 48px 84px minmax(60px, 1fr) auto', gap: 8, alignItems: 'center', fontSize: 11 },
                      },
                        h('span', { style: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.slug }, item.slug),
                        h('span', { style: { opacity: 0.7 } }, item.kind === 'file' ? '单文件' : '目录'),
                        h('span', { style: { opacity: 0.6 }, title: item.stamp || item.name }, formatStamp(item.stamp || item.name)),
                        h('span', { style: { opacity: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.path }, shortPath(item.path, homeDir)),
                        h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: trashBusy === `restore:${item.path}`, onClick: () => restoreTrashEntry(item) }, trashBusy === `restore:${item.path}` ? '恢复中…' : '恢复'))))
                  : (trashList ? h('div', { style: S.status }, '回收站是空的。') : null))
                : null,
              ) : null,
              manageTab === 'mcp' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%' } },
              h('div', { style: S.row },
                h('input', {
                  style: { ...S.input, flex: 1 },
                  placeholder: '搜索已装 MCP（名称、描述）',
                  value: manageMcpFilter,
                  onChange: (e) => setManageMcpFilter(e.target.value),
                }),
                manageMcpFilter ? h('button', { style: S.btn(), onClick: () => setManageMcpFilter('') }, '清除') : null),
                h('button', {
                  style: S.btn(mcpAdd ? 'primary' : undefined),
                  'aria-expanded': Boolean(mcpAdd),
                  onClick: () => {
                    if (mcpAdd) { setMcpAdd(null); setMcpAddConfirm(false); }
                    else { setMcpAddDraft({ transport: 'stdio', envRows: [{ key: '', value: '' }], headerRows: [] }); setMcpAddConfirm(false); setMcpAdd({ open: true }); }
                  },
                }, mcpAdd ? '收起添加' : '＋ 手动添加'),
              // 手动添加浮层：绝对定位（复用 MCP 子面板容器的 position:relative？没有——用 fixed 居中，
              // 与工具清单浮窗同构），全字段表单；自定义 command 走两步确认。
              mcpAdd
                ? h('div', {
                style: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 },
                onClick: () => { setMcpAdd(null); setMcpAddConfirm(false); },
                },
                h('div', {
                  style: { width: '100%', maxWidth: 560, maxHeight: '80vh', overflow: 'auto', background: 'var(--dsh-card, #fff)', borderRadius: 12, padding: 18, boxShadow: '0 16px 48px rgba(15, 23, 42, 0.28)' },
                  onClick: (e) => e.stopPropagation(),
                  },
                    h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                      h('span', { style: { fontWeight: 700, fontSize: 14 } }, '手动添加 MCP 连接器'),
                      h('button', { style: S.btn(), onClick: () => { setMcpAdd(null); setMcpAddConfirm(false); } }, '✕')),
                    h('div', { style: { ...S.status, fontSize: 11, margin: '6px 0 10px' } },
                      '填写本机可执行命令或远程 URL；stdio 模式下启动命令会在本机执行，保存前会要求确认。'),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, 'serverName'),
                      h('input', { style: S.input, placeholder: 'my-mcp（1-32 位字母/数字/-/_）', value: mcpAddDraft.serverName || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, serverName: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '显示名'),
                      h('input', { style: S.input, value: mcpAddDraft.title || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, title: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '描述'),
                      h('input', { style: S.input, value: mcpAddDraft.description || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, description: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '命令'),
                      h('input', { style: S.input, placeholder: 'npx / node / C:\\path\\to.exe（留空则用远程 URL）', value: mcpAddDraft.command || '', onChange: (e) => { setMcpAddDraft({ ...mcpAddDraft, command: e.target.value }); setMcpAddConfirm(false); } })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '参数'),
                      h('textarea', { style: { ...S.input, height: 52, fontFamily: 'ui-monospace, monospace', fontSize: 12 }, placeholder: '每行一个参数', value: mcpAddDraft.args || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, args: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, 'URL'),
                      h('input', { style: S.input, placeholder: 'https://…/mcp（stdio 留空时必填）', value: mcpAddDraft.url || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, url: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '工作目录'),
                      h('input', { style: S.input, placeholder: '可选：启动连接器时的工作目录', value: mcpAddDraft.cwd || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, cwd: e.target.value }) })),
                    h('div', { style: S.row },
                      h('span', { style: { width: 92, fontSize: 12, opacity: 0.7 } }, '超时 ms'),
                      h('input', { style: { ...S.input, width: 140 }, type: 'number', placeholder: '60000', value: mcpAddDraft.toolCallTimeoutMs || '', onChange: (e) => setMcpAddDraft({ ...mcpAddDraft, toolCallTimeoutMs: e.target.value }) })),
                    h('div', { style: { marginTop: 6 } },
                      h('span', { style: { fontSize: 12, fontWeight: 600 } }, '环境变量'),
                      (mcpAddDraft.envRows || []).map((row, idx) => h('div', { key: `a-${idx}`, style: { ...S.row, marginTop: 4 } },
                        h('input', { style: { ...S.input, flex: '0 0 170px' }, placeholder: 'KEY', value: row.key, onChange: (e) => { const rows = (mcpAddDraft.envRows || []).slice(); rows[idx] = { ...rows[idx], key: e.target.value }; setMcpAddDraft({ ...mcpAddDraft, envRows: rows }); } }),
                        h('input', { style: { ...S.input, flex: 1 }, placeholder: '值（支持 ${ENV_VAR} 引用）', value: row.value, onChange: (e) => { const rows = (mcpAddDraft.envRows || []).slice(); rows[idx] = { ...rows[idx], value: e.target.value }; setMcpAddDraft({ ...mcpAddDraft, envRows: rows }); } }),
                        h('button', { style: { ...S.btn(), ...S.danger }, onClick: () => setMcpAddDraft({ ...mcpAddDraft, envRows: (mcpAddDraft.envRows || []).filter((x, i2) => i2 !== idx) }) }, '删'))),
                      h('button', { style: S.btn(), onClick: () => setMcpAddDraft({ ...mcpAddDraft, envRows: [...(mcpAddDraft.envRows || []), { key: '', value: '' }] }) }, '＋ 添加变量')),
                    h('div', { style: { marginTop: 6 } },
                      h('span', { style: { fontSize: 12, fontWeight: 600 } }, '请求头'),
                      (mcpAddDraft.headerRows || []).map((row, idx) => h('div', { key: `ah-${idx}`, style: { ...S.row, marginTop: 4 } },
                        h('input', { style: { ...S.input, flex: '0 0 170px' }, placeholder: 'Header-Name', value: row.key, onChange: (e) => { const rows = (mcpAddDraft.headerRows || []).slice(); rows[idx] = { ...rows[idx], key: e.target.value }; setMcpAddDraft({ ...mcpAddDraft, headerRows: rows }); } }),
                        h('input', { style: { ...S.input, flex: 1 }, placeholder: '值', value: row.value, onChange: (e) => { const rows = (mcpAddDraft.headerRows || []).slice(); rows[idx] = { ...rows[idx], value: e.target.value }; setMcpAddDraft({ ...mcpAddDraft, headerRows: rows }); } }),
                        h('button', { style: { ...S.btn(), ...S.danger }, onClick: () => setMcpAddDraft({ ...mcpAddDraft, headerRows: (mcpAddDraft.headerRows || []).filter((x, i2) => i2 !== idx) }) }, '删'))),
                      h('button', { style: S.btn(), onClick: () => setMcpAddDraft({ ...mcpAddDraft, headerRows: [...(mcpAddDraft.headerRows || []), { key: '', value: '' }] }) }, '＋ 添加请求头')),
                    h('div', { style: { ...S.row, marginTop: 12, justifyContent: 'flex-end', gap: 8 } },
                      mcpAddDraft.command && !mcpAddConfirm
                      ? h('button', { style: { ...S.btn(), ...S.danger }, onClick: () => setMcpAddConfirm(true) }, '添加并启动')
                      : h('button', { style: { ...S.btn(), ...S.danger }, disabled: busy === 'mcpAdd', onClick: submitMcpAdd },
                        mcpAddDraft.command ? `确认执行 ${mcpAddDraft.command} 并添加` : '添加并启动')),
                ))
                : null,
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装 MCP（${filteredMounted.length}）`,
                h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  disabled: busy === 'openDir:mcp',
                  onClick: async () => {
                    setBusy('openDir:mcp');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'mcp' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录')),
              mountedList.length === 0
                ? h('div', { style: S.dim }, '还没有已安装 MCP 连接器。去「MCP 连接器」页安装，或点上方「打开目录」直接编辑定义文件。')
                : filteredMounted.length === 0
                  ? h('div', { style: S.dim }, '没有匹配的连接（换个关键词或清空搜索）。')
                  : h('div', { style: S.grid }, installedMcps),
              mcpBroken.length > 0
                ? h('div', { style: { ...S.err, wordBreak: 'break-word' } },
                    `${mcpBroken.length} 个定义文件无法解析，这些连接器当前不会生效：${mcpBroken.map((b) => b.file).join('、')}（JSON 语法问题，可对照备份修正）`)
                : null,
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `MCP 回收站（${mcpTrashList ? mcpTrashList.items.length : '?'}）`,
                h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: mcpTrashBusy === 'list', onClick: () => loadMcpTrash() }, '读取回收站'),
                mcpTrashList && mcpTrashList.items.length > 0
                  ? h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: mcpTrashBusy === 'empty', onClick: () => emptyMcpTrash() }, '清空')
                  : null,
                h('span', { style: { ...S.status, fontSize: 12 } }, '卸载即移入 .trash，可随时恢复')),
              mcpTrashList && mcpTrashList.items.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto', width: '100%' } },
                    mcpTrashList.items.map((item) => h('div', { key: item.path, style: { ...S.row, fontSize: 11, gap: 8 } },
                      h('span', { style: { fontWeight: 600, minWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.serverName),
                      h('span', { style: { opacity: 0.7 } }, item.transport || 'stdio'),
                      h('span', { style: { opacity: 0.6 } }, item.deletedAt ? item.deletedAt.slice(0, 16).replace('T', ' ') : ''),
                      h('span', { style: { flex: '1', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || ''),
                      h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: mcpTrashBusy === `restore:${item.path}`, onClick: () => restoreMcpTrashEntry(item) }, '恢复'))))
                : (mcpTrashList ? h('div', { style: S.status }, 'MCP 回收站是空的。') : null),
              ) : null,
            ) : null,
            tab === 'settings'
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  pv.degradedNote ? h('div', { style: S.status }, pv.degradedNote) : null,
                  h('div', { style: S.status }, '每行一个目录；技能列表的第一个目录是安装目标。保存后立即重挂，无需重启。'),
                  setPathRows('技能目录', skillDraft, setSkillDraft),
                  setPathRows('MCP 目录', mcpDraft, setMcpDraft),
                  h('div', { style: S.row },
                    h('button', { style: S.btn('primary'), disabled: busy === 'settings.set', onClick: savePaths }, '保存路径'),
                    h('span', { style: S.status }, `配置文件：${pv.configPath}`)),
                  h('div', { style: S.status }, `技能 provider：${pv.providerLabel}`),
                  h('div', { style: S.status }, `MCP 客户端：${pv.clientLabel}`),
                  h('div', { style: { ...S.title, marginTop: 14 } }, '会话日志体检'),
                  h('div', { style: S.status }, '检测并修复「空 tool-call」导致的会话永久损坏：只截断损坏点、保留其前全部事件，原文件自动备份。'),
                  h('div', { style: S.row },
                    h('button', { style: S.btn(), disabled: sessionBusy === 'scan', onClick: () => scanSessions(false) }, sessionBusy === 'scan' ? '扫描中…' : '列出会话'),
                    h('button', { style: S.btn('primary'), disabled: sessionBusy === 'scan-deep', onClick: () => scanSessions(true) }, sessionBusy === 'scan-deep' ? '检测中…' : '深度检测损坏')),
                  sessionScan && sessionScan.items
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' } },
                        sessionScan.items.map((item) => h('div', { key: item.file, style: { ...S.row, fontSize: 11, gap: 6, opacity: item.corrupt ? 1 : 0.75 } },
                          h('span', { style: { fontWeight: 600, color: item.corrupt ? '#c62828' : undefined } }, item.corrupt ? '损坏' : (item.scanned ? '正常' : '—')),
                          h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.sessionId),
                          item.corrupt
                            ? h('span', null, `seq ${item.corruption.seq}：${item.corruption.reason}`)
                            : h('span', null, item.scanned ? `${item.events} 条事件` : `${Math.round((item.bytes || 0) / 1024)} KB`),
                          item.corrupt
                            ? h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: sessionBusy === `repair:${item.file}`, onClick: () => repairSession(item.file, false) }, sessionBusy === `repair:${item.file}` ? '修复中…' : '修复')
                            : null)))
                    : null)
              : null)));
    }

    /**
     * Composer toolbar entry: two 28px buttons ("技能" / "MCP") on the left of the
     * composer input row. Each opens a popover listing installed items (via the host
     * RPC) with a "go to market" footer that activates the dsh-market panel.
     * Picking an item inserts a prompt snippet into the draft (does NOT submit).
     */
    function ComposerButtons(props) {
      const inputActions = props.inputActions;
      const draft = props.useInput ? props.useInput((state) => state.draft) : '';
      const [open, setOpen] = useState(null); // 'skill' | 'mcp' | null
      const [skills, setSkills] = useState(null);
      const [mcps, setMcps] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const rootRef = useRef(null);
      const timers = useRef([]);

      const later = (fn, ms) => { const id = setTimeout(() => { timers.current = timers.current.filter((pending) => pending !== id); fn(); }, ms); timers.current.push(id); return id; };
      useEffect(() => () => { for (const id of timers.current) clearTimeout(id); timers.current = []; }, []);

      // Popover dismissal: outside click or Escape (quick-resume pattern).
      useEffect(() => {
        if (!open) return undefined;
        if (rootRef.current) rootRef.current.scrollTop = 0;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
          setOpen(null);
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(null); };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('mousedown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown); };
      }, [open]);

      const load = async (kind) => {
        if (kind === 'skill') {
          if (skills !== null) { setOpen(open === 'skill' ? null : 'skill'); return; }
        } else {
          if (mcps !== null) { setOpen(open === 'mcp' ? null : 'mcp'); return; }
        }
        setOpen(kind);
        setLoading(true);
        setError('');
        try {
          if (kind === 'skill') {
            const data = await call('skills.list');
            setSkills((data.items || []).map((item) => ({
              slug: item.slug,
              name: item.name || item.slug,
              description: item.description || '',
            })));
          } else {
            const data = await call('mcp.list');
            setMcps((data.items || []).map((item) => ({
              serverName: item.serverName,
              title: item.title || item.serverName,
              transport: item.transport || 'stdio',
              mounted: item.mounted === true,
              tools: item.tools || [],
            })));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
          setOpen(null);
        } finally {
          setLoading(false);
        }
      };

      /** Insert a snippet into the draft (append a new line when draft is non-empty). Never submits. */
      const insertSnippet = (text) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return;
        const current = String(draft || '').trim();
        inputActions.setDraft(current === '' ? text : `${draft}\n${text}`);
        setOpen(null);
      };

      const skillItemText = (item) => {
        const desc = item.description ? `（${item.description.slice(0, 80)}）` : '';
        return `使用技能 /${item.slug}${desc}。请加载并按需使用它。`;
      };
      const mcpItemText = (item) => {
        const tools = item.tools && item.tools.length > 0 ? `，可用工具：${item.tools.slice(0, 8).join('、')}${item.tools.length > 8 ? ' 等' : ''}` : '';
        const state = item.mounted ? '已挂载' : '未挂载（可先调用 mcp_market_set_enabled 启用）';
        return `使用 MCP 连接器 ${item.serverName}（${item.transport}，${state}${tools}）。需要时直接调用它的工具。`;
      };

      const marketPanel = () => {
        try {
          if (typeof props.openMarketPanel === 'function') props.openMarketPanel();
        } catch { /* layout service unavailable; ignore */ }
        setOpen(null);
      };

      const btnStyle = (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 28,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid ' + (active ? 'var(--dsh-border-strong, #9aa4b2)' : 'var(--dsh-border, #d0d7de)'),
        background: active ? 'var(--dsh-surface-raised, #eef1f5)' : 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-secondary, #57606a)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        userSelect: 'none',
      });

      const popStyle = {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 60,
        width: 360,
        maxHeight: 420,
        overflow: 'auto',
        border: '1px solid var(--dsh-border, #d0d7de)',
        borderRadius: 10,
        background: 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-primary, #1f2328)',
        boxShadow: '0 10px 30px rgba(0,0,0,.18)',
        padding: 10,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      };
      const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' };
      const rowHover = { background: 'var(--dsh-surface-hover, #f0f3f6)' };

      const renderList = (kind, items, textOf, emptyText) => {
        if (loading) return h('div', { style: { ...S.status, padding: 8 } }, '加载中…');
        if (error && items === null) return h('div', { style: { ...S.status, padding: 8 } }, `加载失败：${error}`);
        if (!items || items.length === 0) return h('div', { style: { ...S.status, padding: 8 } }, emptyText);
        return items.map((item) => {
          const key = kind === 'skill' ? item.slug : item.serverName;
          const title = kind === 'skill' ? item.name : item.title;
          const sub = kind === 'skill' ? (item.description || '').slice(0, 60) : `${item.transport} · ${item.mounted ? '已挂载' : '未挂载'} · ${item.tools.length} 工具`;
          return h('div', {
            key,
            style: rowStyle,
            onMouseEnter: (e) => { e.currentTarget.style.background = rowHover.background; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
            onClick: () => insertSnippet(textOf(item)),
            title: textOf(item),
          },
            h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            h('div', { style: { ...S.status, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub));
        });
      };

      return h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, order: 1 } },
        h('button', {
          type: 'button',
          style: btnStyle(open === 'skill'),
          'aria-label': '技能',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('skill'),
        }, h('span', { style: { fontSize: 13 } }, '⚡'), '技能'),
        h('button', {
          type: 'button',
          style: btnStyle(open === 'mcp'),
          'aria-label': 'MCP',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('mcp'),
        }, h('span', { style: { fontSize: 13 } }, '⇄'), 'MCP'),
        open ? h('div', { ref: rootRef, style: popStyle, role: 'dialog' },
          h('div', { style: { ...S.status, fontSize: 11, padding: '0 8px 6px' } },
            open === 'skill' ? `已安装技能（${skills ? skills.length : '…'}）` : `已安装 MCP（${mcps ? mcps.length : '…'}）`),
          open === 'skill' ? renderList('skill', skills, skillItemText, '还没有已安装技能。点下方按钮去技能市场安装。')
            : renderList('mcp', mcps, mcpItemText, '还没有已安装 MCP 连接器。点下方按钮去 MCP 市场安装。'),
          h('div', { style: { borderTop: '1px solid var(--dsh-border, #eaeef2)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', style: { ...S.btn(), height: 26, fontSize: 12 }, onClick: marketPanel },
              open === 'skill' ? '去技能市场' : '去 MCP 市场'),
            h('span', { style: { ...S.status, fontSize: 11 } }, '点击条目把提示插入输入框（不会直接发送）'))) : null);
    }

    /** Icon shown by the left sidebar's panel list (the sidebar owns the button chrome). */
    function MarketIcon(props) {
      const size = props && props.size ? props.size : 18;
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.6 8.4h16.8l-1.3 10.1a2 2 0 0 1-2 1.7H6.9a2 2 0 0 1-2-1.7L3.6 8.4Z', ...stroke }),
        h('path', { d: 'M8.5 8.4V6.6a3.5 3.5 0 0 1 7 0v1.8', ...stroke }),
        h('path', { d: 'M12 12.2v3.4M10.3 13.9h3.4', ...stroke }));
    }

    return {
      inject: ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        // Left sidebar entry: the sidebar renders the button and reads the label from here.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-skill-mcp-market', order: 20, label: () => 'SKILL技能&MCP连接器' },
            MarketIcon,
          ));
        // Central panel addressed by that same sidebar id.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'dsh-skill-mcp-market', inject: () => ({ sidebarRight: ctx.sidebarRight, layout: ctx.layout }) },
            Market,
          ));
        // Composer toolbar: 技能 / MCP quick buttons on the input row (left group).
        // inputActions + useInput are provided by the host to conversation.input.* entries;
        // openMarketPanel is our inject face, closing over ctx for the layout service.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-market-composer',
              order: 10,
              inject: () => ({
                openMarketPanel: () => {
                  try {
                    const layout = ctx.layout;
                    if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('dsh-skill-mcp-market');
                  } catch { /* layout service unavailable; ignore */ }
                },
              }),
            },
            ComposerButtons,
          ));
        // 右侧栏 tab 类型：把市场面板注册为 sidebar-right 的页面 tab。
        // 在 tab 上下文中 sidebarRight 可用（tab 自身就是会话面），
        // openDetail 无需 selectPanel(null) 回会话，直接开内置浏览器 tab。
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: 'dsh-skill-mcp-market',
              inject: () => ({ sidebarRight: ctx.sidebarRight, layout: ctx.layout }),
            },
            Market,
          ));
        // tab 类型的注册必须把 disposer 交回 effect：不返回它，客户端热重载时
        // 上一次的 id/kind 仍在注册表里，第二次 register() 会抛「already registered」，
        // 异常冒到 cordis 就会把整个插件卸载（表现为侧边栏入口消失）。
        ctx.effect(() => {
          const tabs = ctx.sidebarRightTabs;
          if (!tabs || typeof tabs.register !== 'function') return;
          try {
            const dispose = tabs.register({
              id: 'dsh-skill-mcp-market',
              kind: 'dsh-skill-mcp-market',
              multiple: false,
              priority: 'extension',
              title: () => '技能市场',
              guide: [{
                id: 'new',
                order: 50,
                title: () => '技能市场',
                description: () => '浏览、搜索、安装 SKILL 技能与 MCP 连接器',
              }],
            });
            return typeof dispose === 'function' ? dispose : undefined;
          } catch (e) {
            // 注册失败绝不能连累市场面板本身
            console.warn('[dsh-skill-mcp-market] 右侧栏 tab 注册失败（不影响市场面板）:', e && e.message);
            return undefined;
          }
        }, 'dsh-skill-mcp-market.tab-type');
      },
    };
  },
});
