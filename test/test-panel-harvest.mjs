// 0.5.174 批·第二棒：面板侧「渐进式加载消费者」判据套件（test/test-panel-harvest.mjs，纯 LF、无 BOM）。
// 判据对象 = client.js 的 harvest 消费者：factory 作用域 island（HARVEST_POLL_MS、会话控制、
// upsert 去重、applyHarvestFinal、harvestFirstPage、harvestGate）+ searchSkills 里的渐进门。
// 服务端契约（冻结）：harvest.start 入参与 skills.search 完全一致（六参）→ { id, rows, meta,
// done, stage }；harvest.poll { id } → { rows(到达序增量), meta, done, final?, hints }（响应
// 不回传 id）；id 未知/过期或老服务端不认识 op ⇒ 顶层 ok:false（call() 对 ok:false 是抛错）
// ⇒ 面板回落恰好一次 skills.search；轮询 250ms；面板侧禁止任何「超过 N 秒停止加载」的时间截断。
// 跑法：needle 抽取 island 与 searchSkills 体 → new Function 绑定真跑（本仓既有姿势）。
// 坑（本会话踩过两次）：抽取体引用的作用域名必须逐一绑定 —— island 只依赖外部名 trustedTotal；
// searchSkills 体依赖既有 22 个自由名 + island 提供的 harvestGate + 注入的 harvestCtlRef。
// 缺一个就是 ReferenceError，且会被函数内 catch 吞成假绿 —— 所以每个场景都包 try/catch，
// THROW 一律判红；判据表达式全部空值安全。
import fs from 'node:fs';
import path from 'node:path';
const NL = String.fromCharCode(10);

const W = path.resolve(import.meta.dirname, '..');
const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
const lines = c.split(/\r?\n/);

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  PASS ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

// ── 抽取 ─────────────────────────────────────────────
const islandStart = lines.findIndex((l) => l.includes('渐进式加载（harvest）消费者'));
const islandEnd = lines.findIndex((l) => l.includes('const TOOL_BATCH = 60;'));
const si = lines.findIndex((l) => l.includes('const searchSkills = useCallback(async (text, options) => {'));
const ei = lines.findIndex((l, k) => k > si && l.trim() === '}, [sort, liveRef, source, size]);');
check('harvest island 可定位（注释头 → TOOL_BATCH 前）', islandStart > 0 && islandEnd > islandStart, islandStart + '/' + islandEnd);
check('searchSkills 体可定位（既有双 needle 不变）', si > 0 && ei > si, si + '/' + ei);
const islandLines = islandStart > 0 && islandEnd > islandStart ? lines.slice(islandStart, islandEnd) : [];
const islandText = islandLines.join(NL);
const bodyText = si > 0 && ei > si ? lines.slice(si + 1, ei).join(NL) : '';
const gateFrom = bodyText.indexOf('渐进式加载门');
const gateTo = bodyText.indexOf('        try {');
const gateText = gateFrom >= 0 && gateTo > gateFrom ? bodyText.slice(gateFrom, gateTo) : '';
check('渐进门可定位（注释 → 裸 try {）', gateFrom >= 0 && gateTo > gateFrom, gateFrom + '/' + gateTo);

const constBodyOf = (name) => {
  const i = lines.findIndex((l) => l.includes('const ' + name + ' = ('));
  if (i < 0) return null;
  const out = [];
  for (let k = i; k < lines.length; k += 1) {
    out.push(lines[k]);
    if (k > i && lines[k].startsWith('    ') && (lines[k].trim() === '}' || lines[k].trim() === '};')) break;
  }
  return out.join(NL);
};
const trustedSrc = constBodyOf('trustedTotal');
const skipSrc = constBodyOf('shouldSkipInflight');
check('trustedTotal / shouldSkipInflight 真函数可抽取注入', Boolean(trustedSrc) && Boolean(skipSrc), String(Boolean(trustedSrc)) + '/' + String(Boolean(skipSrc)));
const trustedTotal = trustedSrc ? new Function(trustedSrc + NL + 'return trustedTotal;')() : (r) => r;
const shouldSkipInflight = skipSrc ? new Function(skipSrc + NL + 'return shouldSkipInflight;')() : () => false;

console.log('');
console.log('Test 0: 静态源码锁（只锁 harvest 通路：island + 门，不误伤既有代码）');
{
  check('island 无 Date.now()（无任何时间预算）', !/Date\.now\(\)/.test(islandText), '');
  check('island 的 setTimeout 恰好 1 处（harvestWaitTick 唯一节奏点）', (islandText.match(/setTimeout\(/g) || []).length === 1, String((islandText.match(/setTimeout\(/g) || []).length));
  check('island 的 clearTimeout 恰好 1 处（harvestClearTimer 独占清理）', (islandText.match(/clearTimeout\(/g) || []).length === 1, String((islandText.match(/clearTimeout\(/g) || []).length));
  check('island 无 AbortController/abort（不拿中止当截断）', !/AbortController|\.abort\(/.test(islandText), '');
  check('门无 Date.now()/setTimeout（门只做路由与回落）', !/Date\.now\(\)/.test(gateText) && !/setTimeout\(/.test(gateText), '');
  check('island 绝不自己调 skills.search（回落只由门交回一次性通路；注释里的散文不算）', !/[\'"]skills[.]search[\'"]/.test(islandText), '');
  check('门带 typeof 防御（测试桩摘录体时回落旧通路，不判红）', gateText.includes('typeof harvestGate === ' + "'function'"), '');
  check('门只在首页（pageNo<=1）非追加接管（翻页/追加维持现通路）', gateText.includes('pageNo <= 1 && !append'), (gateText.split(NL).find((l) => l.includes('if (')) || '').trim());
  check('island 的 category 下发点走 upstreamCat 归一（CAT_OTHER 绝不上线）', islandText.includes("category: env.upstreamCat === 'all' ? '' : env.upstreamCat,"), '');
  check('poll 只携带 start 返回的会话 id（poll 响应不回传 id）', islandText.includes('{ id: sessionId }'), '');
  check('final 判定恰两处（首包即收口 + 循环内收口）', (islandText.match(/pkg\.final === true/g) || []).length === 2, String((islandText.match(/pkg\.final === true/g) || []).length));
  check('poll 节奏唯一入口 = harvestWaitTick(ctl, env.token, HARVEST_POLL_MS)', islandText.includes('harvestWaitTick(ctl, env.token, HARVEST_POLL_MS)'), '');
}

// ── 真跑装置 ─────────────────────────────────────────
const keyOf = (r) => (r && (r.slug || r.id || '?')) + (r && r.installed ? '*' : '');
const lastOf = (a) => (a && a.length ? a[a.length - 1] : undefined);
const monotonic = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]);
const canon = (o) => { const ks = Object.keys(o || {}).sort(); const out = {}; for (const k of ks) out[k] = o[k]; return JSON.stringify(out); };

const buildRunner = (islandSrc, bodySrc) => new Function('deps', 'extra', 'trustedTotal', 'shouldSkipInflight',
  islandSrc + NL +
  'const harvestCtlRef = extra.harvestCtlRef;' + NL +
  'return async (text, options) => {' + NL +
  '  const { liveRef, resultCacheRef, reqSeqRef, size, sort, call, setSkills, setSkillsPage,' +
  '    setSkillsTotalPages, setSkillsTotal, setSkillsHasMore, setServerFacet, setNotice, setError, setBusy,' +
  '    skillCacheKey, resolvePageSize, inflightRef, shouldSkipInflight, trustedTotal, totalBaseRef, CAT_OTHER, tailCoversRef } = deps;' +
  '  const { keepSortForForm } = extra;' + NL + bodySrc + NL + '};');

// 假服务端：poll 会校验 id（与真服务端一致：id 不对 ⇒ 顶层 ok:false）；polls 越界回空增量包，
// 防计时抖动把「还在加载」误判成失败。startThrow 模拟老服务端 default 分支抛 unknown operation。
const makeEnv = (islandSrc, plan, opts) => {
  opts = opts || {};
  const ctl = { current: { timer: null, wake: null, token: null } };
  const resultCacheRef = { current: {} };
  const reqSeqRef = { current: 0 };
  const totalBaseRef = { current: {} };
  const inflightRef = { current: new Set() };
  const tailCoversRef = { current: opts.tailCovers === undefined ? null : opts.tailCovers };
  const logs = { skills: [], busy: [], notice: [], error: [], page: [], totalPages: [], total: [], hasMore: [], serverFacet: [] };
  const ops = [];
  const bodies = [];
  const keys = [];
  let pollCount = 0;
  let curSkills = [];
  const planFor = (p) => (plan && plan.for ? plan.for(p || {}) : plan);
  const call = async (op, p) => {
    ops.push(op);
    bodies.push({ op, p: JSON.parse(JSON.stringify(p || {})) });
    const pl = planFor(p || {});
    if (op === 'harvest.start') {
      if (pl.startThrow) throw new Error(pl.startThrow);
      if (pl.startOkFalse) return { ok: false, error: '该 harvest 会话不存在或已过期，请改用 skills.search' };
      return pl.start;
    }
    if (op === 'harvest.poll') {
      const i = pollCount; pollCount += 1;
      if (pl.start && pl.start.id !== undefined && (!p || p.id !== pl.start.id)) return { ok: false, error: '该 harvest 会话不存在或已过期，请改用 skills.search' };
      if (pl.pollOkFalseAt === i) return { ok: false, error: '该 harvest 会话不存在或已过期，请改用 skills.search' };
      const r = pl.polls ? pl.polls[i] : undefined;
      return r !== undefined ? r : { rows: [], meta: {}, done: false };
    }
    if (op === 'skills.search') return pl.search;
    throw new Error('unknown operation "' + op + '"');
  };
  const run = buildRunner(islandSrc, bodyText)({
    liveRef: { current: { source: opts.src || 'clawhub', category: opts.category === undefined ? 'all' : opts.category, sortCaps: { skills: { clawhub: { browse: ['downloadCount', 'stars'], search: ['downloadCount', 'stars'] } } } } },
    resultCacheRef,
    reqSeqRef,
    totalBaseRef,
    inflightRef,
    tailCoversRef,
    size: 24,
    sort: 'default',
    call,
    setSkills: (v) => { curSkills = typeof v === 'function' ? v(curSkills) : v; logs.skills.push((curSkills || []).map(keyOf)); },
    setSkillsPage: (v) => logs.page.push(v),
    setSkillsTotalPages: (v) => logs.totalPages.push(v),
    setSkillsTotal: (v) => logs.total.push(v),
    setSkillsHasMore: (v) => logs.hasMore.push(v),
    setServerFacet: (v) => logs.serverFacet.push(v),
    setNotice: (v) => logs.notice.push(v),
    setError: (v) => logs.error.push(v),
    setBusy: (v) => logs.busy.push(v),
    skillCacheKey: (o) => { const k = ['sk', o.source, o.query || '', o.category === 'all' ? '' : (o.category || ''), o.page, o.size, o.sort || ''].join('|'); keys.push(k); return k; },
    resolvePageSize: (o, s) => (o && o.size) || s,
    shouldSkipInflight,
    trustedTotal,
    CAT_OTHER: '__cat_other',
  }, { keepSortForForm: (s) => s, harvestCtlRef: ctl }, trustedTotal, shouldSkipInflight);
  return { run, logs, ops, bodies, keys, ctl, resultCacheRef, reqSeqRef, totalBaseRef, inflightRef, pollCount: () => pollCount };
};

// 夹具行：与真实 harvest 行同形（带 source+slug，未必有 id），两种去重键路径都覆盖。
const R1 = { source: 'skills.sh', slug: 'pdf-merge', name: 'PDF Merge', installed: false };
const R2 = { source: 'clawhub', slug: 'pdf-ocr', name: 'PDF OCR', installed: false };
const R3 = { source: 'lobehub', slug: 'pdf-sign', name: 'PDF Sign', installed: false };
const R4 = { source: 'skillsmp', slug: 'pdf-split', name: 'PDF Split', installed: false };
const F1 = { source: 'lobehub', slug: 'pdf-sign', name: 'PDF Sign', installed: true };
const F2 = { source: 'skills.sh', slug: 'pdf-merge', name: 'PDF Merge', installed: true };
const F3 = { source: 'skillsmp', slug: 'pdf-split', name: 'PDF Split', installed: true };
const F4 = { source: 'clawhub', slug: 'pdf-ocr', name: 'PDF OCR', installed: true };
const FINAL_KEYS = 'pdf-sign*,pdf-merge*,pdf-split*,pdf-ocr*';
const FB1 = { id: 'fb1', name: 'Fallback 1', installed: false };
const FB2 = { id: 'fb2', name: 'Fallback 2', installed: false };
const SEARCH_OK = { items: [FB1, FB2], pages: 1, total: 2, hasMore: false, hints: [], degraded: [], sourceErrors: [] };
const interimMeta = { hints: [], degraded: [], sourceErrors: [] };
const fm = (total) => ({ hints: [], degraded: [], sourceErrors: [], total, pages: 1, hasMore: false, serverFacet: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('withTimeout ' + ms + 'ms 超时')), ms); if (t && typeof t.unref === 'function') t.unref(); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
const until = async (fn, tries) => { for (let i = 0; i < (tries || 400); i += 1) { if (fn()) return true; await sleep(10); } return false; };

// S1：首包即渲染不等待完成；增量 upsert；final 整表替换；计数/缓存/等待纪律。
const S1 = async (mk, ck) => {
  const PLAN = {
    start: { id: 'h1', rows: [R1], meta: interimMeta, done: false, stage: 'first' },
    polls: [
      { rows: [R2, R3], meta: interimMeta, done: false },
      { rows: [R4], meta: interimMeta, done: false },
      { rows: [F1, F2, F3, F4], meta: fm(4), done: true, final: true },
    ],
    search: SEARCH_OK,
  };
  const e = mk(PLAN);
  await e.run('pdf', {});
  ck('S1 首包立即渲染（1 条，不等齐不白屏）', e.logs.skills.length > 0 && e.logs.skills[0].join(',') === 'pdf-merge', JSON.stringify(e.logs.skills));
  ck('S1 渲染长度单调不减（有多少显示多少、持续增加）', monotonic(e.logs.skills.map((a) => a.length)), JSON.stringify(e.logs.skills.map((a) => a.length)));
  ck('S1 final 整表替换为服务端有序全量', (lastOf(e.logs.skills) || []).join(',') === FINAL_KEYS, JSON.stringify(lastOf(e.logs.skills)));
  ck('S1 到达序增量逐包 upsert（4 次渲染：1→3→4→final）', e.logs.skills.length === 4, String(e.logs.skills.length));
  const crec = e.resultCacheRef.current[e.keys[0]] || {};
  ck('S1 resultCache 与 skills.search 同口径写入（items=final 全量、total/pages 同步）', e.keys.length > 0 && canon(crec.items) === canon([F1, F2, F3, F4]) && crec.total === 4 && crec.pages === 1, String(e.keys[0]));
  ck('S1 finalMeta.total/pages 落到分页器', lastOf(e.logs.total) === 4 && lastOf(e.logs.totalPages) === 1, JSON.stringify([e.logs.total, e.logs.totalPages]));
  ck('S1 中间包计数标未知（0），绝不伪造总数', e.logs.total[0] === 0 && e.logs.totalPages[0] === 0, JSON.stringify([e.logs.total, e.logs.totalPages]));
  ck('S1 totalBaseRef 记录首页基准（与一次性通路同键）', e.totalBaseRef.current['clawhub|pdf|all|installCount|24'] === 4, JSON.stringify(e.totalBaseRef.current));
  ck('S1 渐进期间只闪一次「搜索中」，首批后一律摘除', e.logs.busy.filter((b) => b === 'skills.search').length === 1 && e.logs.busy.every((b) => b === '' || b === 'skills.search'), JSON.stringify(e.logs.busy));
  ck('S1 中间包 notice 只说「陆续加载中」，绝不提前宣判空结果', e.logs.notice.length >= 3 && e.logs.notice.slice(0, e.logs.notice.length - 1).every((n) => String(n).indexOf('陆续加载中') >= 0) && e.logs.notice.slice(0, e.logs.notice.length - 1).every((n) => String(n).indexOf('没有找到') < 0), JSON.stringify(e.logs.notice));
  ck('S1 final 收口 notice 与一次性通路同口径（非空表 → 清空）', lastOf(e.logs.notice) === '', JSON.stringify(e.logs.notice));
  ck('S1 harvest 全程零 skills.search、start 打头', e.ops[0] === 'harvest.start' && !e.ops.includes('skills.search'), e.ops.join(','));
  ck('S1 poll 恰好 3 次后收口', e.pollCount() === 3, String(e.pollCount()));
  ck('S1 每次 poll 都携带 start 返回的会话 id（响应不回传 id）', e.bodies.filter((b) => b.op === 'harvest.poll').every((b) => b.p.id === 'h1'), JSON.stringify(e.bodies.filter((b) => b.op === 'harvest.poll').map((b) => b.p)));
  ck('S1 结束后 inflight 放行、ctl 三清（timer/wake/token）', e.inflightRef.current.size === 0 && e.ctl.current.timer === null && e.ctl.current.wake === null && e.ctl.current.token === null, JSON.stringify([e.inflightRef.current.size, e.ctl.current.timer, e.ctl.current.wake, e.ctl.current.token]));
  ck('S1 全程无实质报错（harvest 失败不当搜索失败；门前的 setError(\'\') 复位合法）', e.logs.error.every((v) => v === ''), JSON.stringify(e.logs.error));
  ck('S1 窗内/全部分类态 harvest.start 入参六键逐键一致（不得多出 tailCategories 键）', e.bodies.length > 0 && canon(e.bodies[0].p) === canon({ category: '', page: 1, pageSize: 24, query: 'pdf', sort: 'installCount', source: 'clawhub' }), canon(e.bodies[0] ? e.bodies[0].p : null));
  // 0.5.177 C1 另一半：只有合并态（CAT_OTHER + covers 非空）才追加 tailCategories，六参仍同旧口径。
  const eT = mk({
    start: { id: 'ht', rows: [R1], meta: interimMeta, done: false },
    polls: [{ rows: [R2, R3, R4], meta: fm(4), done: true, final: true }],
    search: SEARCH_OK,
  }, { category: '__cat_other', tailCovers: ['ai-programming', 'office', 'design'] });
  await eT.run('pdf', {});
  const tb = (eT.bodies.find((b) => b.op === 'harvest.start') || {}).p || {};
  ck('S1 合并态 harvest.start 六参仍逐键同旧口径（category 照旧降级为空串）', canon({ category: tb.category, page: tb.page, pageSize: tb.pageSize, query: tb.query, sort: tb.sort, source: tb.source }) === canon({ category: '', page: 1, pageSize: 24, query: 'pdf', sort: 'installCount', source: 'clawhub' }), canon(tb));
  ck('S1 合并态 tailCategories 为非空字符串数组且每项是上游真 slug（C1，绝不含 __cat_other）', Array.isArray(tb.tailCategories) && tb.tailCategories.length === 3 && tb.tailCategories.every((x) => typeof x === 'string' && x.length > 0 && x !== '__cat_other' && /^[a-z0-9][a-z0-9-]*$/.test(x)), JSON.stringify(tb.tailCategories));
};

// S2：中间包去重 —— 同键覆盖、新键追加；两种行键（source|slug 与 id）都参与。
const S2 = async (mk, ck) => {
  const A1 = { source: 's1', slug: 'dup', name: 'v1', installed: false };
  const A2 = { source: 's1', slug: 'dup', name: 'v2', installed: true };
  const B1 = { id: 'b-1', source: 's2', slug: 'other', name: 'other', installed: false };
  const PLAN = {
    start: { id: 'h2', rows: [A1], meta: interimMeta, done: false, stage: 'first' },
    polls: [
      { rows: [A2], meta: interimMeta, done: false },
      { rows: [B1], meta: interimMeta, done: false },
      { rows: [B1, A2], meta: fm(2), done: true, final: true },
    ],
    search: SEARCH_OK,
  };
  const e = mk(PLAN);
  await e.run('dup', {});
  ck('S2 中间包同键覆盖不追加（同键覆盖、新键追加）', e.logs.skills.length === 4 && e.logs.skills[0].join(',') === 'dup' && e.logs.skills[1].join(',') === 'dup*' && e.logs.skills[2].join(',') === 'dup*,other', JSON.stringify(e.logs.skills));
  ck('S2 final 有序全量整表替换（顺序=服务端序）', (lastOf(e.logs.skills) || []).join(',') === 'other,dup*', JSON.stringify(lastOf(e.logs.skills)));
  ck('S2 两种行键都参与去重（source|slug 与 id）', e.logs.skills.length > 2 && e.logs.skills[2].length === 2, JSON.stringify(e.logs.skills[2]));
};

// S3：start 失败（顶层 ok:false / 老服务端抛 unknown operation）⇒ 回落恰好一次。
const S3 = async (mk, ck, mode) => {
  const PLAN = mode === 'throw'
    ? { startThrow: 'unknown operation "harvest.start"', search: SEARCH_OK }
    : { startOkFalse: true, search: SEARCH_OK };
  const tag = mode === 'throw' ? 'S3t' : 'S3a';
  const e = mk(PLAN);
  await e.run('pdf', {});
  ck(tag + ' ok:false 回落恰好一次 skills.search（零 poll）', e.ops.join(',') === 'harvest.start,skills.search' && e.pollCount() === 0, e.ops.join(',') + ' polls=' + e.pollCount());
  ck(tag + ' 回落按旧路径渲染（items 原样上屏）', (lastOf(e.logs.skills) || []).join(',') === 'fb1,fb2', JSON.stringify(lastOf(e.logs.skills)));
  ck(tag + ' 回落不带 harvest 泥沙（notice 清空、无 setError、busy 收口）', lastOf(e.logs.notice) === '' && e.logs.error.every((v) => v === '') && lastOf(e.logs.busy) === '', JSON.stringify([e.logs.notice, e.logs.error, e.logs.busy]));
  const hb = e.bodies.find((b) => b.op === 'harvest.start');
  const sb = e.bodies.find((b) => b.op === 'skills.search');
  ck(tag + ' 回落请求与 harvest.start 六参完全一致（同参改走旧通路）', Boolean(hb) && Boolean(sb) && canon(hb.p) === canon(sb.p), canon(hb ? hb.p : null) + ' vs ' + canon(sb ? sb.p : null));
  ck(tag + ' 结束后 ctl 三清', e.ctl.current.timer === null && e.ctl.current.wake === null && e.ctl.current.token === null, JSON.stringify([e.ctl.current.timer, e.ctl.current.wake, e.ctl.current.token]));
  // 0.5.177 合并态回落：start 按 C1 带 tailCategories，一次性 skills.search 不带（C6 逐字段不变）
  // ⇒ 比较口径 = 剥掉 tailCategories 后与 sb.p 逐键一致。
  const eTx = mk(PLAN, { category: '__cat_other', tailCovers: ['ai-programming', 'office'] });
  await eTx.run('pdf', {});
  const thb = eTx.bodies.find((b) => b.op === 'harvest.start');
  const tsb = eTx.bodies.find((b) => b.op === 'skills.search');
  ck(tag + ' 合并态回落：harvest.start 确实带 tailCategories（合并集合请求按 C1 发过）', Boolean(thb) && Array.isArray(thb.p.tailCategories) && thb.p.tailCategories.length === 2, thb ? JSON.stringify(thb.p.tailCategories) : 'no start');
  ck(tag + ' 合并态回落：一次性 skills.search 无 tailCategories，剥键后与 start 逐键一致（C6）', Boolean(thb) && Boolean(tsb) && !Object.prototype.hasOwnProperty.call(tsb.p, 'tailCategories') && canon(Object.assign({}, thb.p, { tailCategories: undefined })) === canon(tsb.p), (thb ? canon(thb.p) : 'no hb') + ' vs ' + (tsb ? canon(tsb.p) : 'no sb'));
};

// S3B：poll 中途 ok:false ⇒ 停轮询、回落恰好一次。
const S3B = async (mk, ck) => {
  const PLAN = {
    start: { id: 'h3', rows: [R1], meta: interimMeta, done: false, stage: 'first' },
    polls: [{ rows: [R2, R3], meta: interimMeta, done: false }],
    pollOkFalseAt: 1,
    search: SEARCH_OK,
  };
  const e = mk(PLAN);
  await e.run('pdf', {});
  ck('S3b 中途 ok:false：停 poll、回落恰好一次', e.ops.join(',') === 'harvest.start,harvest.poll,harvest.poll,skills.search' && e.pollCount() === 2, e.ops.join(',') + ' polls=' + e.pollCount());
  ck('S3b 中途回落仍按旧路径渲染', (lastOf(e.logs.skills) || []).join(',') === 'fb1,fb2', JSON.stringify(lastOf(e.logs.skills)));
  ck('S3b 中途失败同样 ctl 三清', e.ctl.current.timer === null && e.ctl.current.wake === null && e.ctl.current.token === null, JSON.stringify([e.ctl.current.timer, e.ctl.current.wake, e.ctl.current.token]));
};

// S4：CAT_OTHER 绝不下发。
const S4 = async (mk, ck) => {
  const PLAN = { start: { id: 'h9', rows: [F1, F2, F3, F4], meta: fm(4), done: true, final: true }, search: SEARCH_OK };
  const e = mk(PLAN, { category: '__cat_other' });
  await e.run('pdf', {});
  const hb = e.bodies.find((b) => b.op === 'harvest.start');
  ck('S4 CAT_OTHER 绝不下发（harvest.start.body.category 为空串或 all）', e.ops[0] === 'harvest.start' && Boolean(hb) && (hb.p.category === '' || hb.p.category === 'all') && hb.p.category !== '__cat_other', hb ? String(hb.p.category) : 'no start');
  ck('S4 「其他」入口正常走完 harvest（分类只影响过滤参数）', !e.ops.includes('skills.search') && (lastOf(e.logs.skills) || []).join(',') === FINAL_KEYS, e.ops.join(','));
};

// S5：被新搜索接管 —— 旧会话停写、timer 三清、不覆盖新结果。
const S5 = async (mk, ck) => {
  const PLAN = {
    for: (p) => (p.query === 'new-q'
      ? { start: { id: 'h-new', rows: [{ source: 'ns', slug: 'new-x', installed: true }, { source: 'ns', slug: 'new-y', installed: true }], meta: fm(2), done: true, final: true }, search: SEARCH_OK }
      : { start: { id: 'h-old', rows: [{ source: 'os', slug: 'old-a' }], meta: interimMeta, done: false, stage: 'first' }, search: SEARCH_OK }),
  };
  const e = mk(PLAN);
  const p1 = e.run('old-q', {});
  const got = await until(() => e.logs.skills.length >= 1);
  const p2 = e.run('new-q', {});
  await withTimeout(p2, 8000);
  await withTimeout(p1, 8000);
  const firstNew = e.logs.skills.findIndex((a) => a.some((k) => k.indexOf('new-') === 0));
  ck('S5 被超车：旧会话首包之后不再写入（写序旧前新后）', Boolean(got) && firstNew >= 0 && e.logs.skills.slice(0, firstNew).every((a) => a.every((k) => k.indexOf('old-') === 0)), JSON.stringify(e.logs.skills));
  ck('S5 新会话 final 正常收口', (lastOf(e.logs.skills) || []).join(',') === 'new-x*,new-y*', JSON.stringify(lastOf(e.logs.skills)));
  ck('S5 旧会话从未 poll（接管发生在首个 250ms tick 前）', e.pollCount() === 0, String(e.pollCount()));
  ck('S5 接管后 ctl 三清（旧 timer/wake 不泄漏）', e.ctl.current.timer === null && e.ctl.current.wake === null && e.ctl.current.token === null, JSON.stringify([e.ctl.current.timer, e.ctl.current.wake, e.ctl.current.token]));
};

// S6：渐进期间同条件在途去重 —— 第二次同参调用不发新 RPC。
const S6 = async (mk, ck) => {
  const PLAN = {
    start: { id: 'h6', rows: [R1], meta: interimMeta, done: false, stage: 'first' },
    polls: [{ rows: [R2, R3], meta: interimMeta, done: false }, { rows: [F1, F2, F3, F4], meta: fm(4), done: true, final: true }],
    search: SEARCH_OK,
  };
  const e = mk(PLAN);
  const p1 = e.run('pdf', {});
  await until(() => e.logs.skills.length >= 1);
  await e.run('pdf', {});
  await withTimeout(p1, 8000);
  ck('S6 在途去重：渐进期间同条件第二次调用不发新 RPC', e.ops.filter((o) => o === 'harvest.start').length === 1 && !e.ops.includes('skills.search') && e.pollCount() === 2, e.ops.join(',') + ' polls=' + e.pollCount());
  ck('S6 渐进正常收口（final 落地）', (lastOf(e.logs.skills) || []).join(',') === FINAL_KEYS, JSON.stringify(lastOf(e.logs.skills)));
};

// S7：翻页（pageNo>1）维持现通路 —— 零 harvest RPC。
const S7 = async (mk, ck) => {
  const PLAN = {
    start: { id: 'h7', rows: [R1], meta: interimMeta, done: false, stage: 'first' },
    polls: [{ rows: [], meta: fm(4), done: true, final: true }],
    search: { items: [{ id: 'p2a' }, { id: 'p2b' }], pages: 3, total: 60, hasMore: true, page: 2, hints: [], degraded: [], sourceErrors: [] },
  };
  const e = mk(PLAN);
  await e.run('pdf', { page: 2 });
  ck('S7 翻页（pageNo>1）维持现通路：零 harvest RPC', !e.ops.includes('harvest.start') && !e.ops.includes('harvest.poll') && e.ops[0] === 'skills.search', e.ops.join(','));
  ck('S7 翻页按一次性路径渲染（items+page 原样）', (lastOf(e.logs.skills) || []).join(',') === 'p2a,p2b' && lastOf(e.logs.page) === 2, JSON.stringify([lastOf(e.logs.skills), lastOf(e.logs.page)]));
};

// S7b：append 追加维持现通路。
const S7b = async (mk, ck) => {
  const PLAN = { search: { items: [{ id: 'a1' }], pages: 2, total: 30, hasMore: true, page: 2, hints: [], degraded: [], sourceErrors: [] } };
  const e = mk(PLAN);
  await e.run('pdf', { append: true });
  ck('S7 追加（append）维持现通路：零 harvest RPC', e.ops.join(',') === 'skills.search', e.ops.join(','));
  ck('S7 追加结果上屏', (lastOf(e.logs.skills) || []).join(',') === 'a1', JSON.stringify(lastOf(e.logs.skills)));
};

// S8：翻页超车（seq 过期）—— 旧 harvest 停轮询、不覆盖新页。
const S8 = async (mk, ck) => {
  const PLAN = {
    start: { id: 'h8', rows: [R1], meta: interimMeta, done: false, stage: 'first' },
    polls: [{ rows: [R2, R3], meta: interimMeta, done: false }],
    search: { items: [{ id: 'p2a' }, { id: 'p2b' }], pages: 3, total: 60, hasMore: true, page: 2, hints: [], degraded: [], sourceErrors: [] },
  };
  const e = mk(PLAN);
  const p1 = e.run('pdf', {});
  await until(() => e.logs.skills.length >= 1);
  await e.run('pdf', { page: 2 });
  await withTimeout(p1, 8000);
  ck('S8 翻页超车：旧 harvest 停轮询、不覆盖新页结果', e.pollCount() === 0 && (lastOf(e.logs.skills) || []).join(',') === 'p2a,p2b', 'polls=' + e.pollCount() + ' last=' + JSON.stringify(lastOf(e.logs.skills)));
  ck('S8 超车后 ctl 三清', e.ctl.current.timer === null && e.ctl.current.wake === null && e.ctl.current.token === null, JSON.stringify([e.ctl.current.timer, e.ctl.current.wake, e.ctl.current.token]));
};

const runMain = async (label, scenario) => {
  console.log('');
  console.log(label);
  if (!islandText || !bodyText) { check(label + ' 跳过（抽取失败）', false, ''); return; }
  try { await scenario((plan, opts) => makeEnv(islandText, plan, opts), check); } catch (e) { check(label + ' 未抛出（THROW 即判红）', false, String((e && e.message) || e)); }
};

await runMain('Test 1: 首包即渲染 / final 整表替换 / 计数与缓存 / 等待不焦虑（真跑 island+门）', S1);
await runMain('Test 2: 中间包去重 —— 同键覆盖、新键追加（两种行键）', S2);
await runMain('Test 3a: harvest.start 顶层 ok:false ⇒ 回落恰好一次', (mk, ck) => S3(mk, ck, 'okfalse'));
await runMain('Test 3b: 老服务端 unknown operation（抛错）⇒ 同一回落', (mk, ck) => S3(mk, ck, 'throw'));
await runMain('Test 3c: poll 中途 ok:false ⇒ 停轮询、回落恰好一次', S3B);
await runMain('Test 4: CAT_OTHER 绝不下发', S4);
await runMain('Test 5: 被新搜索接管 —— 旧会话停写、timer 三清', S5);
await runMain('Test 6: 渐进期间同条件在途去重（第二次调用不发 RPC）', S6);
await runMain('Test 7: 翻页（pageNo>1）/ append 维持现通路 —— 零 harvest RPC', S7);
await runMain('Test 7b: append 追加维持现通路', S7b);
await runMain('Test 8: 翻页超车（seq 过期）—— 旧 harvest 停轮询不覆盖新页', S8);

// ── 变异自证：每道判据「还原旧写法必红 → 改回原文必绿」 ──
console.log('');
console.log('Test 9: 变异自证（还原旧写法必红 → 改回原文必绿；红/绿各计数）');
const mres = {};
const probe = async (key, mutantIsland, scenario, target) => {
  const bad = [];
  let red = 0;
  const lck = (n, cond) => { if (!cond) { red += 1; bad.push(n); } };
  try { await scenario((plan, opts) => makeEnv(mutantIsland, plan, opts), lck); } catch (e) { red += 1; bad.push('THROW:' + String((e && e.message) || e).slice(0, 80)); }
  const targetedRed = red > 0 && bad.some((n) => n.indexOf(target) >= 0);
  const rbad = [];
  const rck = (n, cond) => { if (!cond) rbad.push(n); };
  try { await scenario((plan, opts) => makeEnv(islandText, plan, opts), rck); } catch (e) { rbad.push('THROW:' + String((e && e.message) || e).slice(0, 80)); }
  mres[key] = { targetedRed, restored: rbad.length === 0, bad, rbad };
};
const lineIdx = (needle, indent8) => islandLines.findIndex((l) => l.includes(needle) && (!indent8 || l.indexOf(needle) === 8));
const swapLine = (idx, fn) => { if (idx < 0) return null; const cp = islandLines.slice(); cp[idx] = fn(cp[idx]); return cp.join(NL); };
const m1Island = swapLine(lineIdx('if (pkg.final === true) { applyHarvestFinal', true), (l) => l.replace('applyHarvestFinal(env, pkg);', 'rows = upsertHarvestRows(rows, pkg.rows || []); d.setSkills(rows); setHarvestNotice(d, pkg, rows.length, false);'));
const m2Island = swapLine(lineIdx('if (at.has(k)) out[at.get(k)] = x;'), (l) => l.replace('if (at.has(k))', 'if (false)'));
const m3Island = swapLine(lineIdx('if (!started.ok) { harvestDropSession(ctl, env.token); return { settled: false }; }'), (l) => l.replace('{ settled: false }', '{ settled: true }'));
const m4Island = swapLine(lineIdx("category: env.upstreamCat === 'all' ? '' : env.upstreamCat,"), () => '        category: env.cat,');
// M6：删掉 tailCategories 条件展开 ⇒ 合并态拿不到 tailCategories（新判据必红）
const m6Island = swapLine(lineIdx('...(env.tailCovers ? { tailCategories: env.tailCovers } : {}),'), () => '');
// M7：换成无条件下发 ⇒ 窗内/全部分类态多出第七键（S1 窗内态逐键判据必红）
const m7Island = swapLine(lineIdx('...(env.tailCovers ? { tailCategories: env.tailCovers } : {}),'), (l) => '        tailCategories: env.tailCovers || [],');
if (islandText) {
  await probe('M1', m1Island, S1, 'final 整表替换');
  await probe('M2', m2Island, S2, '同键覆盖');
  await probe('M3', m3Island, (mk, ck) => S3(mk, ck, 'okfalse'), '回落恰好一次');
  await probe('M4', m4Island, S4, 'CAT_OTHER 绝不下发');
  await probe('M6', m6Island, S1, 'tailCategories 为非空字符串数组');
  await probe('M7', m7Island, S1, '窗内/全部分类态 harvest.start 入参六键逐键一致');
  const wi = islandLines.findIndex((l) => l.includes('while (true) {'));
  let m5Island = islandText;
  if (wi >= 0) {
    const cp = islandLines.slice();
    cp.splice(wi + 1, 0, '      const t0 = Date.now();', '      if (Date.now() - t0 > 30000) { harvestDropSession(ctl, env.token); return { settled: true }; }', '      const budgetTimer = setTimeout(() => { harvestDropSession(ctl, env.token); }, 30000);');
    m5Island = cp.join(NL);
  }
  const noCutoff = (t) => !/Date\.now\(\)/.test(t) && (t.match(/setTimeout\(/g) || []).length === 1 && (t.match(/clearTimeout\(/g) || []).length === 1;
  mres.M5 = { targetedRed: !noCutoff(m5Island), restored: noCutoff(islandText), bad: ['注入 Date.now/超时 setTimeout'], rbad: [] };
} else {
  mres.M1 = { targetedRed: false, restored: false, bad: ['抽取失败'], rbad: [] };
  mres.M6 = mres.M7 = mres.M1;
  mres.M2 = mres.M3 = mres.M4 = mres.M5 = mres.M1;
}
check('变异 M1（final 不整表替换=旧写法）目标判据红', mres.M1.targetedRed, JSON.stringify(mres.M1.bad));
check('变异 M2（upsert 只追加=旧写法）目标判据红', mres.M2.targetedRed, JSON.stringify(mres.M2.bad));
check('变异 M3（start 失败不回落=旧写法）目标判据红', mres.M3.targetedRed, JSON.stringify(mres.M3.bad));
check('变异 M4（CAT_OTHER 直接下发=旧写法）目标判据红', mres.M4.targetedRed, JSON.stringify(mres.M4.bad));
check('变异 M5（注入 Date.now/超时 setTimeout）判红', mres.M5.targetedRed, JSON.stringify(mres.M5.bad));
check('变异 M6（合并态不发 tailCategories=旧行为）目标判据红', mres.M6.targetedRed, JSON.stringify(mres.M6.bad));
check('变异 M7（tailCategories 无条件下发=越界写 C1）目标判据红', mres.M7.targetedRed, JSON.stringify(mres.M7.bad));
const reds = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((k) => mres[k].targetedRed).length;
const greens = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((k) => mres[k].restored).length;
check('变异自证汇总：还原旧写法必红（红=7/7）', reds === 7, '红=' + reds + ' 缺:' + JSON.stringify(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((k) => !mres[k].targetedRed)));
check('变异自证汇总：改回原文必绿（绿=7/7）', greens === 7, '绿=' + greens + ' 缺:' + JSON.stringify(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((k) => !mres[k].restored)));

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
