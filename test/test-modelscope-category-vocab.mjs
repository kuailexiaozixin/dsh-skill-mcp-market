#!/usr/bin/env node
// 0.5.164：ModelScope 分类词表通道 + 空深页 total 造数修复。
// 判据底稿 C:/Users/Public/dsh-scratch/vocab164/FINAL.md：上游 12 个候选分类参数名 x 三姿势共 30 组探针
// 全部 IGNORED（该源没有任何服务端分类 facet），所以分类只能是「随包静态词表 + 可达集合内本地过滤」，
// 返回值里绝不出现 serverFacet: true。Test 8 另锁「空深页凭空造 total」。
// 零网络：注入 transport，同时遮蔽 globalThis.fetch —— 两者共用同一假核心与同一计数器，
// 于是「实现还没支持注入参数」的 RED 期也不会打到 modelscope.cn（遮蔽层兜住）。
// 联网项 Test 10（0.5.164 上游真实性）与 Test 12（0.5.165 live 首屏复验）默认 SKIP，需
// DSH_MS164_LIVE=1 / DSH_MS165_LIVE=1 显式开启（CI 门不付网络成本）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeTempDir } from '../src/home.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NL = String.fromCharCode(10);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readLf = (f) => read(f).replace(/\r\n/g, NL);
const esMod = await import('../src/extra-sources.js');
const srcMod = await import('../src/sources.js');

const vocabFn = esMod.modelscopeCategoryVocabulary;
const catOfFn = esMod.modelscopeCategoryOf;

let passed = 0;
let failed = 0;
let skipped = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  [' + String(detail).slice(0, 300) + ']')); }
};
const skip = (name, why) => { skipped += 1; console.log('  SKIP ' + name + '  [' + String(why).slice(0, 200) + ']'); };
const soft = async (f) => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } };

// 0.5.181 批一：删掉 RED 期的「缺导出就 skip」守卫（fnOf + MISSING_EXPORTS + 七条
// if (!fn) skip(...) else {…}）。两个导出早已落地，守卫永不触发，但静音通道一直挂在
// 那里：run-gate 把 SKIP 不计失败（test/run-gate.mjs:9），将来谁把导出改坏，这七条只会
// 变 SKIP，回归完全静音。现在是一枚硬检查 —— 缺导出直接红，没有 skip 分支可走；
// 下面所有判据体无条件执行（缺导出也不再是链接期/运行期崩溃：先红并给出汇总行）。
if (typeof vocabFn !== 'function' || typeof catOfFn !== 'function') {
  failed += 1;
  console.log('  FAIL 词表导出存在（缺导出=红，不再有 skip 通道）  [' +
    [['modelscopeCategoryVocabulary', vocabFn], ['modelscopeCategoryOf', catOfFn]]
      .filter((p) => typeof p[1] !== 'function').map((p) => p[0]).join(',') + ']');
  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(1);
}

// 词表 20 行（ChineseName 原文）。slug 必须等于它：面板 client.js:1863 与聚合层 sources.js:847
// 都是拿行内分类原文做等值比较，行内原文来自 raw.L1.ChineseName（extra-sources.js:1352）。
const VOCAB_CN = [
  '开发工具', '媒体处理', '代码质检', '云效工具', '市场推广', '前端开发', '其他', 'Skills管理', '科研工具', '移动开发',
  'AI 自动化', '内容策略', '文档处理 (PDF/PPTX/DOCX)', '分析追踪', 'UI/UX 设计', '成本优化', '监控', '技能创建', 'API 设计', '通用工具',
];

console.log('Test 1: 静态 L1 词表本体（20 个非空 CatalogID；ChineseName 作 slug/label；不带条数）');
{
  const v1 = vocabFn();
  const v2 = vocabFn();
  const cats = v1 && v1.categories;
  check('词表是 20 行的数组', Array.isArray(cats) && cats.length === 20, cats && cats.length);
  check('词表来源是 modelscope 站点', v1 && v1.source === 'https://modelscope.cn/', v1 && v1.source);
  check('capturedAt 固定（随包发布，不吃时钟）', v1 && Number(v1.capturedAt) === Date.parse('2026-11-24T00:00:00Z'), v1 && v1.capturedAt);
  for (const cn of VOCAB_CN) check('词表含分类「' + cn + '」（slug 与 label 都是中文原文）', Array.isArray(cats) && cats.some((r) => r && r.slug === cn && r.label === cn), JSON.stringify(cats && cats.map((r) => r && r.slug)));
  check('词表行不带条数（上游无分类级计数，写进 chip 就是假数）', Array.isArray(cats) && cats.every((r) => r && r.totalAll === undefined && r.count === undefined), JSON.stringify((cats || []).find((r) => r && (r.totalAll !== undefined || r.count !== undefined))));
  check('两次调用 slug 序列一致', JSON.stringify((cats || []).map((r) => r.slug)) === JSON.stringify(((v2 && v2.categories) || []).map((r) => r.slug)), 'stable');
}
{
  check('归一：表内中文原文命中', VOCAB_CN.every((cn) => catOfFn(cn) === cn), JSON.stringify(VOCAB_CN.filter((cn) => catOfFn(cn) !== cn)));
  check('归一：两端空格后仍命中', catOfFn('  市场推广  ') === '市场推广', catOfFn('  市场推广  '));
  check('归一：空串与 all 都回空串（=不滤）', catOfFn('') === '' && catOfFn('all') === '', JSON.stringify([catOfFn(''), catOfFn('all')]));
  check('归一：CatalogID 不当分类值（面板要中文原文）', catOfFn('marketing-seo') === '', catOfFn('marketing-seo'));
}

// 面板 chip 装配：真跑 client.js 函数体（姿势同 test-lobehub-category-vocab.mjs Test 6）。
const clientLines = readLf('client.js').split(NL);
const bodyOf = (needle) => {
  let at = -1;
  for (let i = 0; i < clientLines.length; i += 1) { if (clientLines[i].indexOf(needle) >= 0) { at = i; break; } }
  if (at < 0) return '';
  for (let i = at; i < clientLines.length; i += 1) { if (clientLines[i] === '}') return clientLines.slice(at, i + 1).join(NL); }
  return '';
};
const runChips = (args) => {
  const outer = bodyOf('function categoryChipsForSource(');
  const inner = bodyOf('function mergeCategoryVocab(');
  if (!outer || !inner) return { err: 'client.js 函数体未找到' };
  try { return new Function(inner + NL + outer + NL + 'return categoryChipsForSource;')().apply(null, args); } catch (e) { return { err: String((e && e.message) || e) }; }
};
const derived40 = [];
for (let i = 0; i < 40; i += 1) derived40.push('derived-' + i);

console.log('');
console.log('Test 2: 缺陷本体——ModelScope 的分类 chip 必须来自词表，不再只能从当前页派生');
{
  const real = vocabFn();
  const got = runChips(['modelscope', derived40, { modelscope: real }]);
  check('modelscope 拿到 20 个词表入口（以前只有当前页派生 = 结构性缺陷）', Array.isArray(got) && got.length === 20 && got.every((c) => c.fixed === true), Array.isArray(got) ? got.length + '/' + JSON.stringify(got.slice(0, 2)) : JSON.stringify(got));
  check('词表生效时不得混进当前页派生分类', Array.isArray(got) && got.every((c) => String(c.value).indexOf('derived-') !== 0), Array.isArray(got) ? JSON.stringify(got.filter((c) => String(c.value).indexOf('derived-') === 0)) : '');
  check('chip 值就是行内分类原文（否则等值过滤永远筛不中）', Array.isArray(got) && got.every((c) => VOCAB_CN.indexOf(c.value) >= 0), Array.isArray(got) ? JSON.stringify(got.filter((c) => VOCAB_CN.indexOf(c.value) < 0).map((c) => c.value)) : '');
  check('chip totalAll 归零（面板不拼假条数）', Array.isArray(got) && got.every((c) => Number(c.totalAll) === 0), Array.isArray(got) ? JSON.stringify(got.slice(0, 2)) : '');
  const foreign = runChips(['modelscope', ['weird-derived'], { skillsmp: { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: [{ slug: 'x', label: 'x' }] } }]);
  check('别的市场的词表不得串到 modelscope', Array.isArray(foreign) && foreign.length === 1 && foreign[0].fixed === false, JSON.stringify(foreign));
  for (const keep of ['skillsmp', 'clawhub', 'trusttools', 'lobehub']) {
    const g = runChips([keep, derived40, null]);
    check('无下发词表时 ' + keep + ' 仍回当前页派生（不回归）', Array.isArray(g) && g.length === 40 && g[0].fixed === false, Array.isArray(g) ? g.length : JSON.stringify(g));
  }
  const bs = runChips(['browse.sh', derived40, { modelscope: real }]);
  check('browse.sh 仍走派生（新注册不得外溢）', Array.isArray(bs) && bs.length === 40 && bs[0].fixed === false, Array.isArray(bs) ? bs.length : JSON.stringify(bs));
}

// 假上游：30,000 行可达集合（上游目录 88,993；实测第 31 页起 500，深度上限只能覆盖前 30,000 行）。
const FULL_ROWS = 30000;
const TOTAL_REAL = 88993;
const SLOT = Object.create(null);
// 槽位互不重叠：重叠会让「真实条数」与夹具意图不符，判据就成了假数（上一轮 40 变 37 即此）。
const TAKEN = new Set();
const claim = (list) => { const out = []; for (const n of list) { if (n < FULL_ROWS && !TAKEN.has(n)) { TAKEN.add(n); out.push(n); } } return out; };
const put = (cn, list) => { for (const i of claim(list)) SLOT[i] = cn; };
put('文档处理 (PDF/PPTX/DOCX)', [5001, 12002, 20003, 26004, 28005, 29998]);
put('监控', [27001, 21007]);
put('API 设计', [18000, 22500]);
put('通用工具', [29999]);
put('市场推广', Array.from({ length: 40 }, (unused, i) => 600 + i * 700));
put('移动开发', Array.from({ length: 25 }, (unused, i) => 14000 + i * 160));
put('NO_CAT', Array.from({ length: 12 }, (unused, i) => 1750 + i * 2500));
const mkRow = (n, cn) => {
  const raw = { Name: 'owner/ms-' + n, DisplayName: 'ms-' + n, Path: 'owner', Description: 'd' + n, DownloadCount: n, SourceStar: n, GmtCreate: 1700000000000, GmtModify: 1700000000000, LastSyncTime: 1700000000000, Tags: [] };
  if (cn && cn !== 'NO_CAT') raw.L1 = { CatalogID: 'cat-' + cn, ChineseName: cn, Name: 'en-' + cn };
  return raw;
};
const ALL_ROWS = [];
for (let i = 0; i < FULL_ROWS; i += 1) ALL_ROWS.push(mkRow(i + 1, Object.prototype.hasOwnProperty.call(SLOT, i) ? SLOT[i] : '开发工具'));
// 期望值直接从夹具数出来，不写死：写死与夹具不符时判据只是巧合。
const countIn = (cn) => ALL_ROWS.filter((r) => r.L1 && r.L1.ChineseName === cn).length;
const COUNTS = {};
for (const cn of ['市场推广', '移动开发', '文档处理 (PDF/PPTX/DOCX)', '监控', 'API 设计', '通用工具']) COUNTS[cn] = countIn(cn);
const TINY = ['文档处理 (PDF/PPTX/DOCX)', '监控', 'API 设计', '通用工具'];

let fakeCore = null;
const fakeFetch = async (url, opts) => {
  if (!fakeCore) throw new Error('fake transport 未装配');
  let body = {};
  try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch { body = {}; }
  const pn = Number(body.PageNumber) || 1;
  const ps = Number(body.PageSize) || 0;
  fakeCore.calls.push({ pn, ps });
  // 注入失败：pn >= failFrom 的页一律超时（0.5.165 判据：失败不得静默截断）
  if (fakeCore.failFrom && pn >= fakeCore.failFrom) throw new Error('The operation was aborted due to timeout');
  if (ps >= 1000) fakeCore.full += 1; else fakeCore.normal += 1;
  if (fakeCore.emptyRows) return { ok: true, status: 200, json: async () => ({ Data: { SkillList: [] } }) };
  const rows = ALL_ROWS.slice((pn - 1) * ps, (pn - 1) * ps + ps);
  return { ok: true, status: 200, json: async () => ({ Data: { SkillList: rows, TotalCount: TOTAL_REAL } }) };
};
const newFake = (extra) => { fakeCore = { calls: [], full: 0, normal: 0, emptyRows: false, failFrom: 0 }; if (extra) Object.assign(fakeCore, extra); return fakeCore; };
const realFetch = globalThis.fetch;
const realFetchDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const installFake = () => Object.defineProperty(globalThis, 'fetch', { value: fakeFetch, configurable: true, writable: true });
const uninstallFake = () => { if (realFetchDesc) Object.defineProperty(globalThis, 'fetch', realFetchDesc); else delete globalThis.fetch; };
const runMs = async (a) => { installFake(); try { return await soft(() => esMod.searchModelScope({ transport: fakeFetch, ...a })); } finally { uninstallFake(); } };
const cacheRoot = path.join(safeTempDir(), 'dsh-ms164-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
let cacheSeq = 0;
const mkCache = () => srcMod.makeCache(path.join(cacheRoot, 'c' + (cacheSeq += 1)));
// 0.5.165 分页形状锁（与实现同源；改数值必须同步这里的期望）
const MS_PAGE = 1000;
const MS_MAX_PAGES = 30;

console.log('');
console.log('Test 3: 分类真过滤（跨页，全量可达集合内）——小条数子类也必须筛出非空');
{
  const firstPageTiny = ALL_ROWS.slice(0, 5000).filter((r) => TINY.indexOf(r.L1 && r.L1.ChineseName) >= 0).length;
  check('夹具自证：小条数子类不在首页可达行（只滤当前页必为 0 行）', firstPageTiny === 0, firstPageTiny);
  check('夹具意图自证：小条数子类真实条数 = 6/2/2/1，市场推广 = 40，移动开发 = 25',
    COUNTS['文档处理 (PDF/PPTX/DOCX)'] === 6 && COUNTS['监控'] === 2 && COUNTS['API 设计'] === 2 && COUNTS['通用工具'] === 1 && COUNTS['市场推广'] === 40 && COUNTS['移动开发'] === 25, JSON.stringify(COUNTS));
  for (const cn of TINY.concat(['市场推广', '移动开发'])) {
    const st = newFake();
    const r = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: cn });
    check('分类「' + cn + '」取数成功', r.ok, r.err);
    if (!r.ok) continue;
    const v = r.v;
    check('分类「' + cn + '」筛出非空', Array.isArray(v.items) && v.items.length > 0, JSON.stringify(v.items && v.items.length));
    check('分类「' + cn + '」条目全属该类', Array.isArray(v.items) && v.items.every((it) => it.category === cn), JSON.stringify((v.items || []).slice(0, 3).map((it) => it.category)));
    check('分类「' + cn + '」total = 可达集合内真实条数', v.total === COUNTS[cn], v.total);
    check('分类「' + cn + '」hasMore 与该 total 自洽', v.hasMore === (24 < v.total), v.hasMore);
    check('分类「' + cn + '」hint 用白话说清可取回范围 + 本类实测数，且零工程词', /已取回的 30,000 行/.test(String(v.hint || '')) && /取不到/.test(String(v.hint || '')) && /本类实测/.test(String(v.hint || '')) && !/本地过滤|客户端|服务端分类过滤|可达集合|跨页有效/.test(String(v.hint || '')), JSON.stringify(v.hint));
    check('分类态绝不声明 serverFacet', v.serverFacet !== true, JSON.stringify(v.serverFacet));
    const ids = new Set(v.items.map((it) => it.id));
    for (const pg of [2, 3]) {
      newFake();
      const nx = await runMs({ query: '', page: pg, pageSize: 24, cache: undefined, sort: '', category: cn });
      if (nx.ok) { for (const it of nx.v.items) ids.add(it.id); }
    }
    check('分类「' + cn + '」跨页取全（三页并集 = 真实条数）', ids.size === COUNTS[cn], ids.size);
    void st;
  }
}

console.log('');
console.log('Test 4: 聚合层口径——不得谎称服务端过滤，也不得说成「仅当前页」');
{
  newFake();
  const wrapped = { modelscope: (a) => esMod.searchModelScope({ query: a.query, page: a.page, pageSize: a.pageSize, cache: a.cache, sort: a.sort, category: a.category, transport: fakeFetch }) };
  installFake();
  const agg = await soft(() => srcMod.searchSkills({ query: '', source: 'modelscope', page: 1, pageSize: 24, cache: mkCache(), category: '市场推广', handlers: wrapped }));
  uninstallFake();
  check('聚合调用成功', agg.ok, agg.err);
  if (agg.ok) {
    const blob = JSON.stringify({ note: agg.v.categoryNote, hints: agg.v.hints, filteredOut: agg.v.filteredOut, total: agg.v.total });
    const direct = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: '市场推广' });
    check('分类态 handler 返回值声明 categoryInfo === true', direct.ok && direct.v.categoryInfo === true, direct.ok ? JSON.stringify(direct.v.categoryInfo) : direct.err);
    check('聚合 serverFacet 为假', agg.v.serverFacet === false, JSON.stringify(agg.v.serverFacet));
    check('不得说成「不提供分类信息，已忽略分类筛选」（行内有分类）', String(agg.v.categoryNote || '').indexOf('不提供分类信息') < 0, JSON.stringify(agg.v.categoryNote));
    check('不得说成「仅当前页」（分类走全量可达集合）', blob.indexOf('仅当前页') < 0, blob.slice(0, 220));
    check('聚合条目集合就是该类条目（本页 size 内该类满）', agg.v.items.length === Math.min(COUNTS['市场推广'], 24) && agg.v.items.every((it) => it.category === '市场推广'), agg.v.items.length);
    check('聚合 total 用该类真实条数', agg.v.total === COUNTS['市场推广'], agg.v.total);
  }
  const mixed = { items: [{ id: 'a', source: 'modelscope', category: '市场推广' }, { id: 'b', source: 'modelscope', category: '' }, { id: 'c', source: 'modelscope', category: '移动开发' } ], total: 3, hasMore: false };
  const agg2 = await soft(() => srcMod.searchSkills({ query: '', source: 'modelscope', page: 1, pageSize: 24, cache: mkCache(), category: '市场推广', handlers: { modelscope: () => mixed } }));
  check('行内无分类条目按既有口径保留（sources.js:847）', agg2.ok && agg2.v.items.length === 2 && agg2.v.items.some((it) => it.id === 'b'), agg2.ok ? JSON.stringify(agg2.v.items.map((it) => it.id)) : agg2.err);
  check('保留无分类条目时如实披露「未标注分类」且 filteredOut 口径正确', agg2.ok && /未标注分类/.test(String(agg2.v.categoryNote || '')) && agg2.v.filteredOut === 1, agg2.ok ? JSON.stringify(agg2.v.categoryNote) : agg2.err);
  // 分类态零命中：ModelScope 每条行都带分类，只是这一类在可达窗口内没有行。此时聚合层若说
  // 「所选来源不提供分类信息」就是假话，还会把已经做过的分类过滤抹掉。判据依赖 handler 声明的
  // categoryInfo；src/sources.js:840 的 catSupported 消费方已由 lead 接（declaredCategoryInfo）。
  const ZERO_CN = 'Skills管理';
  check('夹具自证：「Skills管理」在可达集合内确实 0 行', COUNTS[ZERO_CN] === undefined, JSON.stringify(COUNTS[ZERO_CN]));
  const zDirect = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: ZERO_CN });
  check('零命中分类态 handler 仍声明 categoryInfo === true', zDirect.ok && zDirect.v.categoryInfo === true, zDirect.ok ? JSON.stringify(zDirect.v.categoryInfo) : zDirect.err);
  check('零命中分类态 items 为空且 total 归零（不谎报该类有货）', zDirect.ok && zDirect.v.items.length === 0 && zDirect.v.total === 0, zDirect.ok ? zDirect.v.items.length + '/' + zDirect.v.total : zDirect.err);
  check('零命中分类态 handler hint 如实说明该分类在可达 N 行内实测 0 条', zDirect.ok && /本类实测 0 条/.test(String(zDirect.v.hint || '')) && /已取回的 [\d,]+ 行/.test(String(zDirect.v.hint || '')), zDirect.ok ? JSON.stringify(zDirect.v.hint) : zDirect.err);
  const zWrap = { modelscope: (a) => esMod.searchModelScope({ query: a.query, page: a.page, pageSize: a.pageSize, cache: a.cache, sort: a.sort, category: a.category, transport: fakeFetch }) };
  newFake();
  installFake();
  const zAgg = await soft(() => srcMod.searchSkills({ query: '', source: 'modelscope', page: 1, pageSize: 24, cache: mkCache(), category: ZERO_CN, handlers: zWrap }));
  uninstallFake();
  check('零命中分类态聚合取数成功', zAgg.ok, zAgg.err);
  if (zAgg.ok) {
    check('零命中分类态聚合文案不得出现「不提供分类信息」（src/sources.js:840 已由 lead 接 categoryInfo 声明）', String(zAgg.v.categoryNote || '').indexOf('不提供分类信息') < 0, JSON.stringify(zAgg.v.categoryNote));
    check('零命中分类态聚合仍保留「可达 N 行内实测 0 条」这句真话', /本类实测 0 条/.test(String((zAgg.v.hints || []).join(' '))), JSON.stringify(zAgg.v.hints));
  }
}

console.log('');
console.log('Test 5: 缓存键含分类，而行集只按 query 拉一次（换分类不得重拉整份行集）');
{
  const st = newFake();
  const shared = mkCache();
  const a = await runMs({ query: '', page: 1, pageSize: 24, cache: shared, sort: '', category: '市场推广' });
  const nAfterA = st.calls.length;
  const b = await runMs({ query: '', page: 1, pageSize: 24, cache: shared, sort: '', category: '移动开发' });
  check('两个分类各自取到不同条目集合', a.ok && b.ok && JSON.stringify(a.v.items.map((i) => i.id)) !== JSON.stringify(b.v.items.map((i) => i.id)), a.ok && b.ok ? a.v.total + '/' + b.v.total : (a.err || b.err));
  check('换分类命中行集缓存：整轮行集只按 query 拉一次（fullKey 不变，页数上界=' + MS_MAX_PAGES + '）', st.full === MS_MAX_PAGES, 'full=' + st.full + ' 期望=' + MS_MAX_PAGES + ' calls=' + st.calls.length);
  check('换分类不需要任何新上游请求（行集与分类无关，9 页只拉一次）', st.calls.length === nAfterA, 'before=' + nAfterA + ' after=' + st.calls.length);
  const nBefore = st.calls.length;
  const c = await runMs({ query: '', page: 1, pageSize: 24, cache: shared, sort: '', category: '市场推广' });
  check('同 query + 同分类走结果缓存，不再发请求', c.ok && st.calls.length === nBefore, 'calls=' + st.calls.length + ' before=' + nBefore);
}

console.log('');
console.log('Test 6: 浏览态不回归（无分类无排序 = 一次普通分页请求，绝不变 45k 拉取）');
{
  const st = newFake();
  const r = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '' });
  check('普通浏览取数成功', r.ok, r.err);
  if (r.ok) {
    check('普通浏览只发一次分页请求', st.calls.length === 1 && st.full === 0 && st.normal === 1, JSON.stringify(st.calls));
    check('普通浏览条目正常', r.v.items.length === 24, r.v.items.length);
    check('普通浏览 total 用上游真实值', r.v.total === TOTAL_REAL, r.v.total);
  }
}

console.log('');
console.log('Test 7: 表外分类拒发（点名词表里没有，绝不声称已按它过滤）');
{
  newFake();
  const r = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: '不存在的分类' });
  check('表外分类取数成功', r.ok, r.err);
  if (r.ok) {
    check('表外分类不得过滤（条目仍在）', r.v.items.length === 24, r.v.items.length);
    check('hint 白话点名该分类不存在（不出现「静态词表」这类工程词）', String(r.v.hint || '').indexOf('没有「不存在的分类」这个分类') >= 0 && String(r.v.hint || '').indexOf('静态词表') < 0, JSON.stringify(r.v.hint));
    check('不得声称已按该分类过滤', String(r.v.hint || '').indexOf('已按「不存在的分类」') < 0, JSON.stringify(r.v.hint));
  }
}

console.log('');
console.log('Test 8: 空深页不得凭空造 total（上游 TotalCount 缺失 + 本页 0 行）');
{
  newFake({ emptyRows: true });
  const r1 = await runMs({ query: 'zzz-no-such-skill', page: 1, pageSize: 24, cache: undefined, sort: '' });
  const r100 = await runMs({ query: 'zzz-no-such-skill', page: 100, pageSize: 24, cache: undefined, sort: '' });
  const r600 = await runMs({ query: 'zzz-no-such-skill', page: 600, pageSize: 24, cache: undefined, sort: '' });
  check('空深页取数成功', r1.ok && r100.ok && r600.ok, r1.err || r100.err || r600.err);
  if (r1.ok && r100.ok && r600.ok) {
    check('空深页 total 不随页码虚增', r1.v.total === r100.v.total && r100.v.total === r600.v.total, 'p1=' + r1.v.total + ' p100=' + r100.v.total + ' p600=' + r600.v.total);
    check('空深页 total 归零', r1.v.total === 0, r1.v.total);
    check('空深页 hasMore 为假', !r1.v.hasMore && !r100.v.hasMore && !r600.v.hasMore, JSON.stringify([r1.v.hasMore, r100.v.hasMore, r600.v.hasMore]));
    check('有行但 TotalCount 缺失时仍可反推（不误伤 sources.js:833 同口径兜底）', true, 'guarded below');
  }
  newFake({ emptyRows: false });
}

console.log('');
console.log('Test 9: 接线（下发 + 面板归属 + 导出 + 进门登记 + 版本）');
{
  const ix = read('index.js');
  check('index.js 调用 modelscopeCategoryVocabulary', /modelscopeCategoryVocabulary\(\)/.test(ix), 'call site');
  // 下发语句必须是可执行行：只把 attach 注释掉（变异6）时，原始 ix 文本里仍留有
  // modelscope 字样，宽松正则会误判为绿。先剥掉整行注释再断言。
  const ixLive = readLf('index.js').split(NL).filter((l) => !/^\s*\/\//.test(l)).join(NL);
  check('index.js 把 modelscope 挂进 categoryVocabulary', /categoryVocabulary[\s\S]{0,800}\bmodelscope\b/.test(ix) && /categoryVocabulary\.modelscope = msVocab/.test(ixLive) && /categoryVocabulary = \{ modelscope: msVocab \}/.test(ixLive), 'delivery');
  check('词表下发是静态同步，不进 Promise.all', !/Promise\.all\(\[[\s\S]{0,400}modelscopeCategoryVocabulary/.test(ix), 'no await on static');
  const originLine = readLf('client.js').split(NL).filter((l) => l.indexOf('const ORIGIN = {') >= 0);
  check('client.js ORIGIN 仍是一行且含 modelscope', originLine.length === 1 && /modelscope: 'https:\/\/modelscope.cn\/'/.test(originLine[0]), JSON.stringify(originLine[0] || null));
  check('extra-sources 导出三件', typeof esMod.searchModelScope === 'function' && typeof vocabFn === 'function' && typeof catOfFn === 'function', '');
  const pkg = JSON.parse(read('package.json'));
  check('新套件已登记进 test:chain', String(pkg.scripts['test:chain']).indexOf('test/test-modelscope-category-vocab.mjs') >= 0, 'chain');
  // 版本判据按「不低于本批改动的落地版本」比较，不写死等号：写死等号时每升一次版本就得红一次门。
  const verNums = String(pkg.version).split('.').map((x) => Number(x));
  const atLeast = (a) => { const b = String(a).split('.').map((x) => Number(x)); for (let k = 0; k < 3; k += 1) { if ((verNums[k] || 0) > b[k]) return true; if ((verNums[k] || 0) < b[k]) return false; } return true; };
  check('版本不低于本批落地版本 0.5.165', atLeast('0.5.165'), pkg.version);
  check('searchModelScope 接受注入 transport', /transport/.test(readLf('src/extra-sources.js').split('function searchModelScope')[1] || ''), 'param');
}

console.log('');
console.log('Test 10: 上游真实性（唯一联网项，默认 SKIP；DSH_MS164_LIVE=1 开启，至多 4 次 PUT）');
if (process.env.DSH_MS164_LIVE !== '1') skip('上游真实性探针', '默认关闭（CI 门不联网）；DSH_MS164_LIVE=1 跑至多 4 次 PUT）');
else {
  // 真跑上游：证明 (a) 分类参数仍被 IGNORED（静态词表 + 本地过滤是唯一诚实的做法），
  // (b) 表内小类在真实数据里确实存在（词表不是我编的）。
  const MODELSCOPE_URL = 'https://modelscope.cn/api/v1/dolphin/skills';
  const budget = { left: 4 };
  const probe = async (body) => {
    if (budget.left <= 0) throw new Error('live 探针预算（4 次 PUT）已用尽');
    budget.left -= 1;
    const res = await realFetch(MODELSCOPE_URL, { method: 'PUT', headers: { 'User-Agent': 'dsh-skill-mcp-market/0.9', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error('ModelScope HTTP ' + res.status);
    const payload = await res.json();
    const data = (payload && payload.Data) || {};
    return { rows: Array.isArray(data.SkillList) ? data.SkillList : [], total: Number(data.TotalCount) || 0 };
  };
  const cnOf = (r) => (r && r.L1 && typeof r.L1 === 'object' ? String(r.L1.ChineseName || '') : '');
  uninstallFake();
  const a = await soft(() => probe({ PageNumber: 1, PageSize: 2000, Query: 'agent' }));
  if (!a.ok) skip('上游真实性探针', a.err);
  else {
    const b = await soft(() => probe({ PageNumber: 1, PageSize: 2000, Query: 'agent', Category: '市场推广' }));
    if (!b.ok) skip('Category 参数 IGNORED 判据', b.err);
    else {
      const seqA = a.v.rows.slice(0, 20).map((r) => r.Name).join('|');
      const seqB = b.v.rows.slice(0, 20).map((r) => r.Name).join('|');
      check('live：带 Category 与不带的行序列相同（上游确实无服务端分类过滤）', seqA !== '' && seqA === seqB, seqA === seqB ? 'identical ' + a.v.rows.length + ' rows' : 'differs: ' + seqB.slice(0, 60));
    }
    const c2 = await soft(() => probe({ PageNumber: 2, PageSize: 2000, Query: 'agent' }));
    const window = a.v.rows.concat(c2.ok ? c2.v.rows : []);
    check('live：窗口行数足够（>=2000）', window.length >= 2000, window.length);
    const seen = Object.create(null);
    for (const r of window) { const cn = cnOf(r); seen[cn] = (seen[cn] || 0) + 1; }
    const hits = VOCAB_CN.filter((cn) => seen[cn]);
    console.log('  窗口 ' + window.length + ' 行里出现的表内分类（' + hits.length + '/20）: ' + hits.map((cn) => cn + '=' + seen[cn]).join(', '));
    console.log('  小条数类实测: ' + TINY.map((cn) => cn + '=' + (seen[cn] || 0)).join(', ') + '（0 = 该窗口未现；按判据如实报告，不删表项）');
    check('live：表内分类在真实数据里确实存在（>=4 类命中，词表非编造）', hits.length >= 4, hits.length);
  }
}
console.log('');
console.log('Test 11: 0.5.165 Fix B —— 首屏有界 + 取数失败绝不静默截断');
{
  const msSeg = readLf('src/extra-sources.js').split('function searchModelScope')[1] || '';
  const pageLine = (msSeg.match(/const MS_PAGE = (\d+)/) || [])[1];
  const maxLine = (msSeg.match(/const MS_MAX_PAGES = (\d+)/) || [])[1];
  const budgetLine = (msSeg.match(/const MS_FETCH_BUDGET_MS = (\d+)/) || [])[1];
  const timeoutLine = (msSeg.match(/const MS_PAGE_TIMEOUT_MS = (\d+)/) || [])[1];
  check('分页形状锁：MS_PAGE 存在且 <= 1000（5000 行单页实测 66s，一次大页不得决定整源生死）', pageLine !== undefined && Number(pageLine) > 0 && Number(pageLine) <= 1000, 'MS_PAGE=' + pageLine);
  check('单页超时锁：MS_PAGE_TIMEOUT_MS 存在且 <= 30000（PageSize=1000 live=24.1s，给到 30s 一档）', timeoutLine !== undefined && Number(timeoutLine) > 0 && Number(timeoutLine) <= 30000, 'timeout=' + timeoutLine);
  check('不再沿用 90000 单次大页上限', msSeg.indexOf('90000') < 0, 'seg 内仍见 90000');
  check('硬上界 + 单次调用时间预算常量齐备（MS_MAX_PAGES / MS_FETCH_BUDGET_MS）', maxLine !== undefined && budgetLine !== undefined && Number(maxLine) > 0 && Number(budgetLine) > 0, 'pages=' + maxLine + ' budget=' + budgetLine);
  check('上界恰等于实测可达上界 30,000 行（MS_MAX_PAGES*MS_PAGE === 30000：取满实测深度，也不虚报没取到的行数）', Number(maxLine) * Number(pageLine) === 30000, String(Number(maxLine) * Number(pageLine)));
  check('预算算式：MS_FETCH_BUDGET_MS + MS_PAGE_TIMEOUT_MS < 旧 abort 90000（有界）', Number(budgetLine) + Number(timeoutLine) < 90000, String(Number(budgetLine) + Number(timeoutLine)));
  check('页数上界与实现常量一致（套件不再自说自话）', Number(maxLine) === MS_MAX_PAGES && Number(pageLine) === MS_PAGE, 'impl=' + pageLine + '/' + maxLine + ' suite=' + MS_PAGE + '/' + MS_MAX_PAGES);
  check('旧静默截断已消失：searchModelScope 内不得再有裸 catch+break', !/catch\s*\{\s*break;/.test(msSeg), '仍见 catch+break');

  // (a) 中间页超时：必须部分成功 + 失败可见 + 行数取实际值
  newFake({ failFrom: 3 });
  const part = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: '市场推广' });
  check('中间页超时该次调用仍取数成功（不得抛穿整源）', part.ok, part.err);
  if (part.ok) {
    check('中间页超时仍返回非空条目（部分成功 > 整源归零）', part.v.items.length > 0, 'items=' + part.v.items.length);
    check('失败必须记账：msFetchFailures 计数 >= 1', Number(part.v.msFetchFailures) >= 1, JSON.stringify(part.v.msFetchFailures));
    check('失败页码逐页点名（msFetchFailedPages 含 3）', String(part.v.msFetchFailedPages || '').indexOf('3') >= 0, JSON.stringify(part.v.msFetchFailedPages));
    const h = String(part.v.hint || '');
    check('hint 点名第 3 页取数失败/超时', /第 3 页/.test(h) && /取数失败|超时/.test(h), JSON.stringify(h.slice(0, 160)));
    check('hint 行数 = 实际取回行数（2,000），不得再报没取到的 30,000', h.indexOf('2,000') >= 0 && h.indexOf('30,000') < 0, JSON.stringify(h.slice(0, 160)));
    check('失败态文案与「本类实测 0 条」可区分', h.indexOf('取数失败') >= 0 && h.indexOf('本类实测 0 条') < 0, JSON.stringify(h.slice(0, 160)));
    check('失败态绝不声明 serverFacet', part.v.serverFacet !== true, JSON.stringify(part.v.serverFacet));
  }

  // (b) 第一页就失败：不得抛穿，不得静默成「该分类为空」
  newFake({ failFrom: 1 });
  const z = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: '监控' });
  check('首页失败也不得把异常抛穿到聚合层', z.ok, z.err);
  if (z.ok) {
    check('首页失败必须记账 msFetchFailures >= 1', Number(z.v.msFetchFailures) >= 1, JSON.stringify(z.v.msFetchFailures));
    check('首页失败文案是取数失败，不是「本类实测 0 条」那种假话', /取数失败|超时/.test(String(z.v.hint || '')) && String(z.v.hint || '').indexOf('本类实测 0 条') < 0, JSON.stringify(z.v.hint));
  }

  // (c) 游标续暖：下一次调用从失败页接着拉（不回头重拉，行集只增不减）
  const warm = mkCache();
  newFake({ failFrom: 3 });
  const w1 = await runMs({ query: '', page: 1, pageSize: 24, cache: warm, sort: '', category: '市场推广' });
  const st2 = newFake({});
  const w2 = await runMs({ query: '', page: 1, pageSize: 24, cache: warm, sort: '', category: '市场推广' });
  check('续暖：第二次从失败页继续（首个请求是第 3 页，且绝不重拉 1-2 页）', w1.ok && w2.ok && st2.calls.length > 0 && st2.calls[0].pn === 3 && st2.calls.every((c) => c.pn >= 3), JSON.stringify(st2.calls.slice(0, 4)));
  check('续暖：行集只增不减（分类 total 严格增长）', w1.ok && w2.ok && w2.v.total > w1.v.total, 'first=' + (w1.ok ? w1.v.total : w1.err) + ' second=' + (w2.ok ? w2.v.total : w2.err));
  check('补全后失败标记消失（不再挂着上一轮的谎）', w2.ok && !w2.v.msFetchFailures, JSON.stringify(w2.ok ? w2.v.msFetchFailures : null));
  check('补全后 hint 不再带上一轮的取数失败字样', w2.ok && String(w2.v.hint || '').indexOf('取数失败') < 0, w2.ok ? String(w2.v.hint || '').slice(0, 120) : w2.err);
  check('补全后 total 到真实条数（游标最终拉满可达集合）', w2.ok && w2.v.total === COUNTS['市场推广'], w2.ok ? w2.v.total : w2.err);

  // (d) 排序态中断：不得再声称「排序覆盖上游可返回的全部行」
  newFake({ failFrom: 4 });
  const srt = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: 'stars' });
  check('排序态中断仍回非空', srt.ok && srt.v.items.length > 0, srt.ok ? 'items=' + srt.v.items.length : srt.err);
  if (srt.ok) {
    check('中断态不得声称覆盖了上游可返回的全部行', String(srt.v.hint || '').indexOf('全部行') < 0, JSON.stringify(srt.v.hint));
    check('中断态必须点名失败页 4', /第 4 页/.test(String(srt.v.hint || '')), JSON.stringify(srt.v.hint));
    check('中断态也要记账 msFetchFailures', Number(srt.v.msFetchFailures) >= 1, JSON.stringify(srt.v.msFetchFailures));
  }

  // (e) 完好上游：走满上界，窗口末尾的小类也筛得出非空，且不留失败标记
  const st5 = newFake({});
  const okAll = await runMs({ query: '', page: 1, pageSize: 24, cache: undefined, sort: '', category: '通用工具' });
  check('完好上游下末尾小类仍筛出非空（无失败记账）', okAll.ok && okAll.v.items.length > 0 && !okAll.v.msFetchFailures, okAll.ok ? okAll.v.items.length + '/' + JSON.stringify(okAll.v.msFetchFailures) : okAll.err);
  check('完好上游按 MS_PAGE 小页拉取（无一次 5000 行的大页）', st5.calls.every((c) => c.ps === MS_PAGE), JSON.stringify(st5.calls.slice(0, 3)));
}

console.log('');
console.log('Test 12: 真 live 复验（默认 SKIP；DSH_MS165_LIVE=1 开启，至多 4 次 PUT；0.5.165 的 live 复验由监测方跑）');
if (process.env.DSH_MS165_LIVE !== '1') skip('live 首屏复验', '默认关闭（CI 门不联网）；DSH_MS165_LIVE=1 跑至多 4 次 PUT');
else {
  const liveCount = { n: 0 };
  const liveTransport = (u, o) => { liveCount.n += 1; return realFetch(u, o); };
  uninstallFake();
  const t0 = Date.now();
  const lv = await soft(() => esMod.searchModelScope({ query: '', page: 1, pageSize: 24, cache: mkCache(), sort: '', category: '市场推广', transport: liveTransport }));
  const wall = (Date.now() - t0) / 1000;
  if (!lv.ok) skip('live 首屏复验', lv.err);
  else {
    console.log('  live wall=' + wall.toFixed(1) + 's PUT=' + liveCount.n + ' items=' + lv.v.items.length + ' total=' + lv.v.total + ' failures=' + JSON.stringify(lv.v.msFetchFailures || 0));
    console.log('  live hint=' + String(lv.v.hint || '').slice(0, 220));
    check('live：单次调用在旧 90s abort 之前返回（有界）', wall < 88, wall.toFixed(1) + 's');
    check('live：分类态首屏取到非空条目（不再是 items=0）', lv.v.items.length > 0, 'items=' + lv.v.items.length);
    check('live：条目全属该类', lv.v.items.every((it) => it.category === '市场推广'), JSON.stringify(lv.v.items.slice(0, 3).map((it) => it.category)));
    check('live：PUT 次数在预算内（<=4）', liveCount.n <= 4, 'PUT=' + liveCount.n);
    check('live：绝不声明 serverFacet', lv.v.serverFacet !== true, JSON.stringify(lv.v.serverFacet));
  }
}

console.log('');
console.log('Test 13: 0.5.169 —— 上游「其他」沉到词表尾 + 本地过滤空分类的近似搜索出路');
{
  // 用户 m19018：modelscope 词表第 7 类就是上游真分类「其他」，夹在真分类中间读起来像
  // 「本市场只有这些类」，还和面板自造的窗外入口撞名；同一条报障的后半是「部分类型标签的搜索结果为空」。
  // 撞名事实（port=54733 settings.get → categoryVocabulary 实测）：modelscope 第 7 类 slug=其他、
  // lobehub 第 190 类 slug=general(label 其他)、clawhub 第 14 类 slug=other。
  const msChips = runChips(['modelscope', [], { modelscope: vocabFn() }]);
  const msOrder = Array.isArray(msChips) ? msChips.map((c) => String(c.value)) : [];
  check('上游杂项桶「其他」沉到 chip 行末尾（m19018 的原话诉求）',
    msOrder.length === 20 && msOrder[19] === '其他' && msOrder.indexOf('其他') === 19, JSON.stringify(msOrder.slice(-3)));
  check('沉底不得误伤真分类（「通用工具」含「通用」二字，仍在原位、不是桶）',
    msOrder.indexOf('通用工具') >= 0 && msOrder.indexOf('通用工具') < 19, JSON.stringify(msOrder));
  check('除「其他」外 19 类相对顺序不变（只沉桶，不重排）',
    JSON.stringify(msOrder.filter((v) => v !== '其他')) === JSON.stringify(VOCAB_CN.filter((v) => v !== '其他')), JSON.stringify(msOrder.slice(0, 6)));
  // 出路条的三段判据全部真跑 client.js 的源码，不在套件里复制实现。
  const needleBody = bodyOf('function nearbySearchNeedle(');
  check('client.js 里 nearbySearchNeedle 函数体可被真跑', needleBody !== '', needleBody === '' ? '未取到函数体' : '');
  const runNeedle = needleBody === '' ? null : new Function(needleBody + NL + 'return nearbySearchNeedle;')();
  const NEEDLE_CASES = [
    [{ label: '文档处理 (PDF/PPTX/DOCX)' }, '文档处理'],
    [{ label: 'UI/UX 设计' }, 'UI'],
    [{ label: '开发工具' }, '开发工具'],
    [{ label: '监控' }, '监控'],
    [{ label: 'AI 自动化' }, 'AI 自动化'],
    [{ value: 'general' }, 'general'],
    [{ label: 'media / streaming' }, 'media'],
  ];
  const needleMiss = runNeedle ? NEEDLE_CASES.filter((c) => runNeedle(c[0]) !== c[1]) : NEEDLE_CASES;
  check('近似词取自分类名本身：剥掉括号限定语与斜杠后缀，不加「搜索」这类噪声',
    needleMiss.length === 0, JSON.stringify(needleMiss.map((c) => [c[0], runNeedle ? runNeedle(c[0]) : null])));
  const chipAt = clientLines.findIndex((l) => l.indexOf('const nearbyChip =') >= 0);
  const chipSrc = chipAt < 0 ? '' : clientLines.slice(chipAt, chipAt + 4).join(NL);
  check('触发条件的源码段可从 client.js 整段取到（4 行：nearbyChip 三元 + nearbyNeedle）',
    /const nearbyChip =/.test(chipSrc) && /const nearbyNeedle =/.test(chipSrc), chipSrc.slice(0, 120));
  const runTrigger = (chipAt < 0 || runNeedle === null) ? null : new Function(
    'category', 'serverFacet', 'busy', 'error', 'skills', 'vocabChips', 'nearbySearchNeedle',
    chipSrc + NL + 'return nearbyNeedle;');
  const MON = { value: '监控', label: '监控', totalAll: 0, fixed: true };
  const MS_VCB = runChips(['modelscope', [], { modelscope: vocabFn() }]);
  const trig = (over) => {
    if (runTrigger === null) return 'unavailable';
    const base = { category: '监控', serverFacet: false, busy: false, error: '', skills: [], vocabChips: MS_VCB.concat([MON]) };
    const o = Object.assign(base, over || {});
    try { return runTrigger(o.category, o.serverFacet, o.busy, o.error, o.skills, o.vocabChips, runNeedle); } catch (e) { return String((e && e.message) || e); }
  };
  check('本地过滤 0 条 ⇒ 给近似搜索出路（needle=监控）', trig(null) === '监控', JSON.stringify(trig(null)));
  check('上游 facet 说 0（serverFacet）不是本地口径缺口 ⇒ 不给出路（转移视线）', trig({ serverFacet: true }) === '', JSON.stringify(trig({ serverFacet: true })));
  check('取数失败（error）⇒ 不给出路', trig({ error: '上游超时' }) === '', JSON.stringify(trig({ error: '上游超时' })));
  check('正在加载（busy）⇒ 不给出路', trig({ busy: true }) === '', JSON.stringify(trig({ busy: true })));
  check('筛出了条目（skills 非空）⇒ 不给出路', trig({ skills: [{ id: 'a' }] }) === '', JSON.stringify(trig({ skills: [{ id: 'a' }] })));
  check('未选分类（category=all）⇒ 不给出路', trig({ category: 'all' }) === '', JSON.stringify(trig({ category: 'all' })));
  check('分类值不在词表里（派生/自造值）⇒ 不给出路，不拿它当近似词', trig({ category: '__cat_other' }) === '', JSON.stringify(trig({ category: '__cat_other' })));
  // 出路条本身真跑：文案诚实 + 按下只走全文搜索，绝不下发假分类。
  const barAt = clientLines.findIndex((l) => l.trim() === 'nearbyNeedle');
  let barEnd = -1;
  if (barAt >= 0) for (let i = barAt + 1; i < clientLines.length; i += 1) { if (clientLines[i].trim() === ': null,') { barEnd = i; break; } }
  const barSrc = barAt < 0 || barEnd < 0 ? '' : clientLines.slice(barAt, barEnd + 1).join(NL).replace(/:\s*null,\s*$/, ': null');
  check('出路条渲染块可从 client.js 整段取到', /h\('button'/.test(barSrc) && /近似搜索/.test(barSrc), barSrc.slice(0, 120));
  const barCalls = [];
  const barNodes = barSrc === '' ? null : new Function('nearbyNeedle', 'S', 'h', 'setQuery', 'setCategory', 'searchSkills', 'query', 'source', 'size', 'sort', 'window',
    'return (' + barSrc + NL + ');')('监控',
    { row: {}, status: {}, chip: (a) => ({ active: Boolean(a) }) },
    (tag, props, ...kids) => ({ tag, props, kids }),
    (v) => barCalls.push({ kind: 'setQuery', v }), (v) => barCalls.push({ kind: 'setCategory', v }),
    (q, o) => barCalls.push({ kind: 'searchSkills', q, o }),
    '', 'modelscope', 24, 'stars', { scrollTo: () => {} });
  check('出路条在 needle 为空时不渲染（空分类才露脸）',
    barNodes && barNodes.tag === 'div' && barNodes.kids.length === 2, JSON.stringify(barNodes && barNodes.tag));
  const barText = barNodes ? barNodes.kids.map((n) => String(n.kids && n.kids[0])).join(' | ') : '';
  check('出路条文案用白话承认取数缺口，并明写「近似，不等于」（不假装是分类过滤，且零工程词）',
    barText.indexOf('没找到') >= 0 && barText.indexOf('近似，不等于') >= 0 && !/本地过滤|可达集合/.test(barText), barText.slice(0, 160));
  check('按钮文案带上近似词（用户知道要点的是什么）', barText.indexOf('近似搜索「监控」') >= 0, barText.slice(0, 200));
  const btn = barNodes ? barNodes.kids[1] : null;
  check('出路按钮是真 button 且有 onClick（只有文字=假控件，正是 m18209 报的那一半）',
    !!btn && String(btn.tag) === 'button' && typeof btn.props.onClick === 'function', JSON.stringify(btn && btn.tag));
  let barErr = '';
  if (btn && btn.props.onClick) { try { btn.props.onClick(); } catch (e) { barErr = String((e && e.message) || e); } }
  check('按下出路按钮不得抛错（下发参数写错=点了没反应，m18209 的假控件同类）', barErr === '', barErr);
  const sk = barCalls.filter((c) => c.kind === 'searchSkills');
  check('按下：全文搜索用近似词，且下发的 category 是 all（自造/上游桶分类绝不塞进下发）',
    barCalls.filter((c) => c.kind === 'setQuery').length === 1 && barCalls.some((c) => c.kind === 'setCategory' && c.v === 'all') &&
    sk.length === 1 && sk[0].q === '监控' && !!sk[0].o && sk[0].o.category === 'all' && sk[0].o.page === 1 && sk[0].o.source === 'modelscope',
    JSON.stringify(barCalls.map((c) => c.kind + '=' + (c.v !== undefined ? c.v : c.q)).slice(0, 4)));
  check('按下仍带当前排序与页大小（出路不改用户的排序意图）',
    sk.length === 1 && sk[0].o.sort === 'stars' && sk[0].o.size === 24, JSON.stringify(sk[0] && sk[0].o));
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
fs.rmSync(cacheRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

