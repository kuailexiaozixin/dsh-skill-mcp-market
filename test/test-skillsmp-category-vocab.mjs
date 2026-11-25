// test-skillsmp-category-vocab.mjs — skillsmp 分类词表通道（Phase 2，0.5.148）。
//
// 为什么单独一套：0.5.145 让数据层能按分类服务端取数，0.5.147 把聚合层的本地分类过滤
// 挪到服务端，面板那排 chip 仍是从**当前页卡片**去重派生的（client.js 的 categories），
// 所以「按分类浏览」根本不存在——首屏页里有几个分类就只显示几个，翻页还会变。
// 词表只能从 https://skillsmp.com/zh/categories 的 HTML 解析（编目端点 10 个候选实测
// 全部 ENDPOINT_NOT_FOUND），故这里把解析器、可浏览性判定、下发通道、面板接线四段
// 各锁一条可执行判据，不靠文本搜索充当证据。
import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { safeTempDir } from '../src/home.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCache, searchSkills } from '../src/sources.js';
import { once, lineOf, countHits, absent } from './anchor-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const readLf = (p) => read(p).replace(/\r\n/g, String.fromCharCode(10));

const esMod = await import('../src/extra-sources.js');
const capMod = await import('../src/sort-capability.js');
// 缺导出时先桩住而不是直接 import 具名：整套件要能逐条报红拿到真实形态，链接期崩掉的
// 红（NO-SUMMARY）拿不到判据原文，那种红是无效红。
const parseSkillsMpCategories = typeof esMod.parseSkillsMpCategories === 'function'
    ? esMod.parseSkillsMpCategories
    : () => { throw new Error('parseSkillsMpCategories 未导出'); };
const skillsmpCategoryVocabulary = typeof esMod.skillsmpCategoryVocabulary === 'function'
    ? esMod.skillsmpCategoryVocabulary
    : async () => { throw new Error('skillsmpCategoryVocabulary 未导出'); };
const readSkillsMpCategoryVocabulary = typeof esMod.readSkillsMpCategoryVocabulary === 'function'
    ? esMod.readSkillsMpCategoryVocabulary
    : async () => { throw new Error('readSkillsMpCategoryVocabulary 未导出'); };
// vocabularySortKeys 是死导出（生产零调用，唯一引用是被删掉的四条软锁），0.5.164 已清理。
// 排序键同源一律走真导出的 sortKeysFor。

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + detail : '')); }
};
const skip = (name, detail) => { console.log('  SKIP ' + name + (detail ? '  ' + detail : '')); };
const freshCache = () => makeCache(path.join(safeTempDir(), 'dsh-smp-vocab-' + process.pid + '-f' + Math.random().toString(36).slice(2)));

const esSrc = readLf('src/extra-sources.js');
const esLines = esSrc.split(String.fromCharCode(10));
const clientSrc = readLf('client.js');
const indexSrc = readLf('index.js');
const srcSrc = readLf('src/sources.js');

// 函数体提取：从声明行扫到下一个 0 列闭括号。不用 anchor-lib 的 blockEnd——它按花括号
// 深度扫，遇到签名里带默认值对象（`options = {}`）会在签名行就把深度归零（本轮实测），
// 于是 body 只剩一行、indexOf 恒假：那是判据失效而不是实现有问题。
const bodyOf = (lines, declNeedle, label) => {
  const at = lines.findIndex((l) => l.indexOf(declNeedle) >= 0);
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) if (lines[i] === '}') return lines.slice(at, i + 1).join(String.fromCharCode(10));
  return null;
};

// ---------------------------------------------------------------- 词表夹具
// 词表只能从 /zh/categories 的 HTML 取（实测编目端点 10 个候选全部 ENDPOINT_NOT_FOUND），
// 故把抓取当日存档的页面字节作为夹具：解析器面对真实字节，而不是我想象的字节。
const SNAPSHOT = path.join(here, 'fixtures', 'skillsmp-categories.html.gz');
const VOCAB_JSON = path.join(here, 'fixtures', 'skillsmp-category-vocab.json');
const snapshot = existsSync(SNAPSHOT) ? zlib.gunzipSync(readFileSync(SNAPSHOT)).toString('utf8') : '';
const expectedVocab = existsSync(VOCAB_JSON)
    ? JSON.parse(readFileSync(VOCAB_JSON, 'utf8')).categories
    : null;
check('夹具在位（抓取当日页面字节 + 实测词表）', snapshot.length > 100000 && !!expectedVocab,
    'snapshot=' + snapshot.length + ' vocab=' + (expectedVocab && expectedVocab.length));

let parsed = null;
try { parsed = parseSkillsMpCategories(snapshot); } catch (e) { parsed = { err: String(e && e.message || e) }; }
if (parsed && parsed.err) skip('解析器对真实页面可运行', parsed.err);

if (Array.isArray(parsed)) {
  const bySlug = new Map(parsed.map((c) => [c.slug, c]));
  check('真实页面解析出全部可浏览分类', parsed.length === expectedVocab.length,
      '解析 ' + parsed.length + ' / 实测 ' + expectedVocab.length);
  check('逐条与实测词表同名同数', parsed.map((c) => c.slug + '|' + c.name + '|' + c.totalAll).sort().join(',')
      === expectedVocab.map((c) => c.slug + '|' + c.name + '|' + c.totalAll).sort().join(','));
  // 站点词表里那排板块入口（浏览工具 等）legacy 直接 400：它们只有标题、没有条数。
  check('板块标题不进词表（tools/business/development 等 12 个必被排除）',
      ['tools', 'business', 'development', 'testing-security', 'devops', 'data-ai', 'documentation',
        'content-media', 'research', 'lifestyle', 'databases', 'blockchain'].every((s) => !bySlug.has(s)),
      [...bySlug.keys()].filter((s) => s === 'tools' || s === 'business').join(','));
  check('条目形态 {slug,name,totalAll} 且 totalAll 为正整数',
      parsed.every((c) => typeof c.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(c.slug)
        && typeof c.name === 'string' && c.name.length > 0
        && Number.isInteger(c.totalAll) && c.totalAll > 0),
      JSON.stringify(parsed.find((c) => !Number.isInteger(c.totalAll) || c.totalAll <= 0)));
  check('中文标签齐备（词条名不是 slug 回显）',
      parsed.filter((c) => /\p{Script=Han}/u.test(c.name)).length >= parsed.length - 3,
      '缺中文 ' + parsed.filter((c) => !/\p{Script=Han}/u.test(c.name)).map((c) => c.slug).join(','));
}

// 第二道保险：实测板块入口锚没有条数徽标，totalAll<=0 已能排除它们；但上游一旦改版给入口也
// 挂上计数，就只能靠「浏览X」这个名字前缀识别。下面这条锁的是前缀本身（合成页，不依赖上游）。
const miniHead = '<a class="group" href="/zh/categories/tools"><div class="p-4 text-sm"><span class="font-semibold">浏览工具</span><div class="mt-2 text-xs"><span class="text-primary font-medium"><bdi>1,234</bdi></span> <!-- -->个技能</div></div></a>';
const miniReal = '<a class="group" href="/zh/categories/debugging"><div class="p-4 text-sm"><span class="font-semibold">调试工具</span><div class="mt-2 text-xs"><span class="text-primary font-medium"><bdi>532,411</bdi></span> <!-- -->个技能</div></div></a>';
try {
  const miniRows = parseSkillsMpCategories(miniHead + miniReal);
  check('板块入口即使改版带上条数徽标也按名字前缀排除',
      miniRows.length === 1 && miniRows[0].slug === 'debugging' && miniRows[0].totalAll === 532411,
      JSON.stringify(miniRows));
} catch (e) { check('板块入口即使改版带上条数徽标也按名字前缀排除', false, String(e && e.message || e)); }

// ---------------------------------------------------------------- 抓取失败面
// 词表抓不到时不能把空数组当成「这站没有分类」——那会把已有 chip 行也一起关掉。
{
  let badOut = null;
  let badThrew = null;
  try {
    badOut = await skillsmpCategoryVocabulary({
      cache: freshCache(),
      getText: async () => { throw new Error('上游 403'); },
      now: () => 1000000,
    });
  } catch (e) { badThrew = String(e && e.message || e); }
  check('抓取失败返回 null 而不是空词表', badThrew === null && badOut === null,
      badThrew !== null ? '抛了：' + badThrew : '返回：' + JSON.stringify(badOut));
}
if (snapshot && expectedVocab) try {
  const c1 = freshCache();
  let n = 0;
  const gt = async () => { n++; return { text: snapshot }; };
  const v1 = await skillsmpCategoryVocabulary({ cache: c1, getText: gt, now: () => 1000000 });
  const v2 = await skillsmpCategoryVocabulary({ cache: c1, getText: gt, now: () => 1000000 + 60000 });
  check('首次抓取、二次命中缓存不重复请求', n === 1 && Array.isArray(v1 && v1.categories) && v1 === v2,
      '抓取次数 ' + n + ' v2 ' + (v1 === v2 ? '同一引用' : '另取'));
  const c3 = freshCache();
  let n3 = 0;
  const gt3 = async () => { n3++; return { text: snapshot }; };
  await skillsmpCategoryVocabulary({ cache: c3, getText: gt3, now: () => 1000000 });
  const after = await skillsmpCategoryVocabulary({ cache: c3, getText: gt3, now: () => 1000000 + 7 * 24 * 3600 * 1000 });
  check('超 TTL 重新抓取（词表不是永久快照）', n3 === 2 && Array.isArray(after && after.categories), '抓取次数 ' + n3);
  // 解析出零条等于页面改版而不是「这站没有分类」：同样不许落成空快照。
  let emptyOut = 'no-throw';
  try { emptyOut = await skillsmpCategoryVocabulary({ cache: freshCache(), getText: async () => ({ text: '<html>改版了</html>' }), now: () => 1000000 }); }
  catch (e) { emptyOut = 'threw:' + String(e && e.message || e).slice(0, 40); }
  check('解析不出任何分类时不写空快照', emptyOut === null || typeof emptyOut === 'string', JSON.stringify(emptyOut));
} catch (e) { check('词表抓取与 TTL 段可运行', false, String(e && e.message || e).slice(0, 90)); }

// ---------------------------------------------------------------- 排序键同源
// CAPABILITIES 是模块私有的（sort-capability.js:38 那行没有 export），只有 sortKeysFor 读得到它。
// 早先这里写 capMod.CAPABILITIES.skillsmp，取到 undefined：第一条判据如实报红，
// 第二条却因为 undefined === undefined 而假绿。改成拿真导出的矩阵内容对比。
const smpCaps = capMod.sortKeysFor('skillsmp');
check('skillsmp 排序键与实测一致（stars/updated/name）',
    Array.isArray(smpCaps) && JSON.stringify(smpCaps) === JSON.stringify(['stars', 'updated', 'name']),
    JSON.stringify(smpCaps));


// ---------------------------------------------------------------- 服务端 facet 标记
// 词表存在后 chip 一定点得出 slug，而 slug 不一定被 legacy 接受（实测 documents 探针超时、
// 12 个板块入口回 HTTP 400 INVALID_CATEGORY）。「facet 到底有没有在服务端生效」必须由 handler
// 明说，聚合层才敢关掉本地过滤——谎报就等于告诉用户「整目录已筛过」，而他看到的仍是首屏那一页。
// 注入的是**传输**而不是整个 handler：facet 被拒后去掉参数重发的逻辑在 searchSkillsMp 里，
// 把它替掉就什么都没测到。fake 传输如实复现上游：不认识的 category 直接抛 HTTP 400。
const ACCEPTED = new Set((expectedVocab || []).map((c) => c.slug));
const facetEnvelope = (n) => ({
  skills: Array.from({ length: n }, (_, i) => ({
    id: 'sk-' + i, name: 'dbg-tool-' + i, description: 'D' + i, author: 'octo',
    githubUrl: 'https://github.com/octo/repo-' + i + '/tree/main/skills/dbg-tool-' + i,
    branch: 'main', route: { sourceSkillPath: 'skills/dbg-tool-' + i + '/SKILL.md' }, stars: 7,
  })),
  filters: {},
  pagination: { page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 },
});
const injectLegacy = (urls) => async (url) => {
  const u = new URL(String(url));
  urls.push(u.pathname + '?' + u.searchParams.toString());
  const cat = u.searchParams.get('category');
  if (cat && !ACCEPTED.has(cat)) throw new Error('python 取数失败：urllib.error.HTTPError: HTTP Error 400: Bad Request');
  return facetEnvelope(5);
};
const mpHandler = (urls) => (o) => searchSkillsMpCall({ ...o, fetchJson: injectLegacy(urls) });
const searchSkillsMpCall = typeof esMod.searchSkillsMp === 'function'
    ? esMod.searchSkillsMp
    : async () => { throw new Error('searchSkillsMp 未导出'); };
{
  const urls = [];
  const r = await searchSkills({
    query: '', source: 'skillsmp', page: 1, pageSize: 5,
    category: 'debugging', cache: freshCache(), handlers: { skillsmp: mpHandler(urls) }, budgetMs: 5000,
  });
  // hints 不许为空判据：facet 页合法携带 totalAll 窗口说明（test-skillsmp-search :133 锁的
  // 正是「说明必须经 hints 通道到达展示层」）。这里锁的是另一半：不得出现本地过滤口径。
  check('词表内 slug 被接受：聚合层标注 serverFacet=true 且不再本地过滤',
      r.serverFacet === true && r.items.length === 5 && !r.categoryNote
      && !(r.hints || []).some((x) => /本地过滤|已忽略分类/.test(String(x))),
      'serverFacet=' + r.serverFacet + ' n=' + r.items.length + ' note=' + JSON.stringify(r.categoryNote) + ' hints=' + JSON.stringify(r.hints));
  check('facet 确实作为服务端参数发上游（不是只记在返回值里）',
      urls.length === 1 && /category=debugging/.test(urls[0]), JSON.stringify(urls));
  check('facet 生效时卡片仍回填该分类（行上没有分类字段）',
      r.items.every((it) => it.category === 'debugging'), JSON.stringify(r.items.map((it) => it.category).slice(0, 3)));
}
{
  const urls = [];
  const r = await searchSkills({
    query: '', source: 'skillsmp', page: 1, pageSize: 5,
    category: 'zzznotathing', cache: freshCache(), handlers: { skillsmp: mpHandler(urls) }, budgetMs: 5000,
  });
  check('被 legacy 拒绝的 slug：serverFacet=false 且 hint 点名该分类',
      r.serverFacet === false && (r.hints || []).some((h) => String(h).includes('zzznotathing')),
      'serverFacet=' + r.serverFacet + ' hints=' + JSON.stringify(r.hints));
  check('被拒后去掉 facet 重发一次（全库首页而不是整源失败）',
      urls.length === 2 && !/category=/.test(urls[1]), JSON.stringify(urls));
}
{
  const r = await searchSkills({
    query: '', source: 'clawhub', page: 1, pageSize: 5, category: 'debugging',
    cache: freshCache(), handlers: { clawhub: async () => ({ items: [{ id: 'c1', name: 'x', source: 'clawhub' }], total: 1 }) }, budgetMs: 5000,
  });
  check('没做服务端 facet 的源不得被标成 serverFacet=true',
      r.serverFacet === false && !!r.categoryNote, 'serverFacet=' + r.serverFacet + ' note=' + JSON.stringify(r.categoryNote));
}
{
  const urls = [];
  const r = await searchSkills({
    query: 'pdf', source: 'skillsmp', page: 1, pageSize: 5, category: 'debugging',
    cache: freshCache(), handlers: { skillsmp: mpHandler(urls) }, budgetMs: 5000,
  });
  check('带关键词时 facet 不发、也不谎称服务端已筛',
      r.serverFacet === false && urls.length === 1 && !/category=/.test(urls[0]),
      'serverFacet=' + r.serverFacet + ' urls=' + JSON.stringify(urls));
}
{
  const urls = [];
  const r = await searchSkills({
    query: '', source: 'all', page: 1, pageSize: 5, category: 'debugging',
    cache: freshCache(),
    handlers: { skillsmp: mpHandler(urls), clawhub: async () => ({ items: [{ id: 'c1', name: 'x', source: 'clawhub' }], total: 1 }) },
    budgetMs: 5000,
  });
  check('聚合里有一个源没做 facet 就不能宣称整页已服务端筛过',
      r.serverFacet === false && r.items.length === 6, 'serverFacet=' + r.serverFacet + ' n=' + r.items.length);
}

// facet 命中 0 条是「这个分类下确实没有」，不是「没筛」：handler 必须照常明说 serverFacet=true，
// 否则面板会对一个空页再本地过滤一遍，把「该分类为空」说成「没取到」。
{
  const urls = [];
  const emptyHandler = (o) => searchSkillsMpCall({
    ...o,
    fetchJson: async (url) => { const u = new URL(String(url)); urls.push(u.pathname + '?' + u.searchParams.toString()); return facetEnvelope(0); },
  });
  const r = await searchSkills({
    query: '', source: 'skillsmp', page: 1, pageSize: 5,
    category: 'debugging', cache: freshCache(), handlers: { skillsmp: emptyHandler }, budgetMs: 5000,
  });
  check('facet 命中 0 条仍算服务端已筛（空结果不是没筛）',
      r.serverFacet === true && r.items.length === 0 && urls.length === 1 && /category=debugging/.test(urls[0]),
      'serverFacet=' + r.serverFacet + ' n=' + r.items.length + ' urls=' + JSON.stringify(urls));

// facet 确认之后不得再本地过滤：上游行上带的分类与所选 slug 不一致是实测存在的回填问题，
// 本地那一遍会把这种条目直接删掉并把 total 重算成「仅当前页过滤」的口径——一边说「上游已筛过」，
// 一边按没筛过的规矩处理同一页。变异实测：把 sources.js 的 !serverFacet 门槛去掉，原有 45 条全绿，
// 因为 facet 页恰好都被回填成同一个 slug，这条盲区用「混合标注」的页补上。
{
  const r = await searchSkills({
    query: '', source: 'all', page: 1, pageSize: 6, category: 'debugging', cache: freshCache(), budgetMs: 5000,
    handlers: {
      'src-a': async () => ({ source: 'src-a', serverFacet: true, total: 2, hasMore: false, items: [
        { id: 'a1', name: 'a1', source: 'src-a', category: 'debugging' },
        { id: 'a2', name: 'a2', source: 'src-a', category: 'git-workflows' },
      ] }),
      'src-b': async () => ({ source: 'src-b', serverFacet: true, total: 1, hasMore: false, items: [
        { id: 'b1', name: 'b1', source: 'src-b', category: 'testing' },
      ] }),
    },
  });
  check('facet 已确认后连分类标注不一致的条目也不许本地删掉',
      r.serverFacet === true && r.items.length === 3 && !r.categoryNote && !r.filteredOut,
      'serverFacet=' + r.serverFacet + ' n=' + r.items.length + ' filteredOut=' + r.filteredOut + ' note=' + JSON.stringify(r.categoryNote));
}
}

// ---------------------------------------------------------------- 面板接线
// client.js 跑在宿主 ModuleLoader 里（仓库无 react/jsdom 依赖，package.json deps 为空），
// 既有做法是把纯逻辑段留在固定缩进、取函数体用 new Function 执行（test-batch-select.mjs、
// test-clawhub-quality.mjs）。这里执行的是真实函数体，不是正则命中。
const clientLines = clientSrc.split(String.fromCharCode(10));
const runClientFn = (name, args) => {
  const body = bodyOf(clientLines, 'function ' + name + '(', name);
  if (body === null) return { err: '未取到函数体 ' + name };
  try { return new Function('return (' + body + ')')()(...args); }
  catch (e) { return { err: String(e && e.message || e) }; }
};
const vocab = (expectedVocab || []).map((c) => ({ slug: c.slug, name: c.name, totalAll: c.totalAll }));
const merged = runClientFn('mergeCategoryVocab', [['weird-derived-slug'], { capturedAt: 1, categories: vocab }]);
if (merged && merged.err) skip('词表合并可执行', merged.err);
if (Array.isArray(merged)) {
  // 0.5.155 契约修正：有词表时 chip 只来自词表。旧契约把页内派生值一律追加在词表之后，
  // 而 clawhub 的派生值来自 clawhubCategoryOf 的 topics[0] 兜底（作者自由标签），
  // 于是 douyin/抖音/tiktok/kuaishou/json/ai-tools/database 混进分类行——既与 14 类不可比、
  // 自身重复（douyin 与 抖音 同义），点上去上游还回 400。词表缺失时才用派生（不关入口）。
  check('有词表时 chip 只来自词表（派生自由标签不得混入）',
      merged.length === vocab.length && merged[0].value === 'debugging' && merged[0].fixed === true,
      'n=' + merged.length + ' first=' + JSON.stringify(merged[0]));
  // 面板只展示前 CAT_CHIP_FOLD 个 chip，所以只验第一条是不是最大不够：上游页面顺序里排第 26 位的
  // code-quality（203,368 条）会被挤到窗口外，窗口里留下的却是 domain-utilities（17,113 条）。
  // 这条按整个窗口断言：fixed 段必须严格降序，前 12 个必须正是条数最大的 12 个分类。
  (() => {
    const fx = merged.filter((c) => c.fixed === true);
    const desc = fx.every((c, i) => i === 0 || fx[i - 1].totalAll >= c.totalAll);
    const top = vocab.slice().sort((a, b) => b.totalAll - a.totalAll).slice(0, 12).map((c) => c.slug).sort().join(',');
    const win = fx.slice(0, 12).map((c) => c.value).sort().join(',');
    check('词表按条数降序，chip 窗口就是条数最大的那 12 个分类',
        desc && top === win,
        'desc=' + desc + ' 窗口=' + win + ' 应有=' + top);
  })();
  check('chip 的 value 恒是 slug（面板发上游的只能是 slug，不能是显示名）',
      merged.every((c) => /^[a-z0-9][a-z0-9-]*$/.test(String(c.value))),
      JSON.stringify(merged.filter((c) => !/^[a-z0-9][a-z0-9-]*$/.test(String(c.value))).map((c) => c.value)));
  check('词表在手时不产出 fixed=false 的派生 chip',
      !merged.some((c) => c.fixed === false),
      JSON.stringify(merged.filter((c) => c.fixed === false).map((c) => c.value)));
  // 派生值若本身就在词表里，去重后不能出现第二条同值 chip（防把过滤写成追加）。
  const dupIn = runClientFn('mergeCategoryVocab', [['debugging'], { capturedAt: 1, categories: vocab }]);
  check('派生值恰为词表内 slug 时不产生重复 chip',
      Array.isArray(dupIn) && dupIn.length === vocab.length && dupIn.filter((c) => c.value === 'debugging').length === 1,
      'n=' + (Array.isArray(dupIn) ? dupIn.length : JSON.stringify(dupIn)));
  check('词表为空时退回页内派生（不返回空 chip 集合）',
      (() => { const m = runClientFn('mergeCategoryVocab', [['backend'], null]); return Array.isArray(m) && m.length === 1 && m[0].value === 'backend'; })(),
      JSON.stringify(runClientFn('mergeCategoryVocab', [['backend'], null])));
} else if (!merged || !merged.err) check('词表合并可执行', false, JSON.stringify(merged));
// ---------------------------------------------------------------- 词表只属于 skillsmp
// 用户实测（0.5.150 live）：这排带条数的分类 chip 在 skills.sh / clawhub / browse.sh 等
// 每一个市场下都长一样，点上去要么「所选来源不提供分类信息，已忽略分类筛选」（实测
// skills.sh category=debugging 回同样的 24 条），要么退成本地过滤当前页。词表来自
// skillsmp.com/zh/categories，slug 只有 skillsmp 认——把它显示成别的市场的分类，
// 本身就是假陈述。判据跑真实函数体。
const scoped = (args) => {
  const outer = bodyOf(clientLines, 'function categoryChipsForSource(', 'categoryChipsForSource');
  if (outer === null) return { err: '未取到函数体 categoryChipsForSource' };
  // 它委托 mergeCategoryVocab（面板里两者同在模块作用域）。new Function 是独立作用域，
  // 所以把两份真实函数体一起放进去，还原模块作用域的依赖关系——跑的还是真代码。
  const inner = bodyOf(clientLines, 'function mergeCategoryVocab(', 'mergeCategoryVocab');
  if (inner === null) return { err: '未取到函数体 mergeCategoryVocab' };
  try { return new Function(inner + String.fromCharCode(10) + outer + String.fromCharCode(10) + 'return categoryChipsForSource;')()(...args); }
  catch (e) { return { err: String((e && e.message) || e) }; }
};
// 0.5.153 起词表按源分组下发（{ skillsmp: {...}, clawhub: {...} }），这里传同一形状。
const smp = scoped(['skillsmp', ['weird-derived-slug'], { skillsmp: { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: vocab } }]);
check('skillsmp 下词表 chip 照常生效（且不含派生自由标签）', Array.isArray(smp) && smp.length === vocab.length && smp[0].fixed === true, JSON.stringify(smp && smp.err ? smp : (smp || []).slice(0, 2)));
for (const other of ['clawhub', 'skills.sh', 'browse.sh', 'lobehub', 'skillhub', 'modelscope', 'trusttools', 'all', '', undefined]) {
  const got = scoped([other, ['weird-derived-slug'], { skillsmp: { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: vocab } }]);
  check('非 skillsmp（' + String(other) + '）不得出现词表 chip',
      Array.isArray(got) && got.length === 1 && got[0].value === 'weird-derived-slug' && got[0].fixed === false,
      JSON.stringify(got && got.err ? got : got));
}
check('派生 chip 在任意源都保留（关掉入口不是兜底）', (() => { const g = scoped(['clawhub', ['a', 'b'], null]); return Array.isArray(g) && g.length === 2; })(), JSON.stringify(scoped(['clawhub', ['a', 'b'], null])));
// 词表自带来源字段：那不是 skillsmp 的页面时，即使当前源是 skillsmp 也不接受。
// 没有这条判据时，删掉 stated 检查（把别处喂进来的词表也当 skillsmp 的）行为不变地通过，
// 属于「写了分支没锁行为」——同 M5 那类假锁，这里当轮补上。
const foreign = scoped(['skillsmp', ['weird-derived-slug'], { skillsmp: { capturedAt: 1, source: 'https://other-market.example/categories', categories: vocab } }]);
check('词表来源不是 skillsmp 页面时即使当前源是 skillsmp 也不接受', Array.isArray(foreign) && foreign.length === 1 && foreign[0].fixed === false, JSON.stringify(foreign && foreign.err ? foreign : foreign));
const noSource = scoped(['skillsmp', ['weird-derived-slug'], { skillsmp: { capturedAt: 1, categories: vocab } }]);
check('词表未声明来源时按 skillsmp 词表接受（旧快照不落 source 也要能用）', Array.isArray(noSource) && noSource.length === vocab.length, JSON.stringify(noSource && noSource.err ? noSource : noSource.length));
// live 判别（0.5.153 装完后实测）：面板 client.js 会热更新，而宿主进程内的 index.js
// 要等重启——于是出现「新面板 + 旧服务端」的组合：旧服务端下发的是未分组的单一词表对象
// {capturedAt,source,categories}。当时实测 skillsmp 那排带条数 chip 整排消失（只剩派生），
// 这是我引入的向后不兼容：面板改吃分组形状却没兼容旧形状。判据锁住旧形状仍可用。
const legacy = scoped(['skillsmp', ['weird-derived-slug'], { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: vocab }]);
check('旧服务端下发的未分组单一词表对象仍要生效（新面板+旧服务端不得丢 chip）',
    Array.isArray(legacy) && legacy.length === vocab.length && legacy[0].fixed === true,
    JSON.stringify(legacy && legacy.err ? legacy : { n: legacy.length }));
const legacyOther = scoped(['clawhub', ['weird-derived-slug'], { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: vocab }]);
check('旧形状同样不得串到别的市场', Array.isArray(legacyOther) && legacyOther.length === 1, JSON.stringify(legacyOther && legacyOther.err ? legacyOther : legacyOther));
// 接线：面板必须把当前源传进去，而不是无条件合并词表。

const labeled = runClientFn('categoryChipLabel', ['debugging', { categories: vocab }]);
check('chip 标签走中文映射而 value 仍是 slug',
    !!labeled && !labeled.err && labeled.value === 'debugging' && /\p{Script=Han}/u.test(String(labeled.label || '')),
    JSON.stringify(labeled));
const lite = runClientFn('categoryLabelLite', [{ value: 'debugging', label: '调试工具', totalAll: 532411, fixed: true }]);
check('chip 文案带条数（千分位，非裸 slug）',
    typeof lite === 'string' && lite.indexOf('调试工具') === 0 && /532[,.]?411/.test(lite),
    JSON.stringify(lite));

// 词表为空时 chip 行必须退回原有派生 chip（关掉入口不是兜底）
// gate 行允许被重构成括号形式（词表驱动后仍必须留着 categories.length 这条派生兜底），
// 所以锚定到实际写法而不是裸串；判据在下面两条正则里，与锚无关。
// 锚取行不能直接 once：GREEN 之前那一行还不存在，once 会抛出去把后面所有判据一起带走
// （实测 RED 停在 anchor-lib 抛错、连汇总行都没有）。取不到就交给空串，让判据自己红。
const lineIf = (needle, label) => (countHits(clientSrc, needle) === 1 ? lineOf(clientSrc, once(clientSrc, needle, label)) : '');
const chipGate = lineIf("tab === 'skills' && (categories.length", '技能 chip 行门槛');
check('技能 chip 行门槛保留 categories.length（词表抓不到时不关掉入口）',
    /categories\.length/.test(chipGate), chipGate.trim().slice(0, 140));
check('chip 行由派生与词表共同驱动', /categories/.test(chipGate) && /ocab/.test(chipGate), chipGate.trim().slice(0, 150));
const wiringLine = lineIf('const vocabChips = categoryChipsForSource(', '词表 chip 接线');
check('面板按当前源决定词表 chip（接线可执行）', /categoryChipsForSource\(source/.test(wiringLine), wiringLine.trim().slice(0, 150) || '未取到接线行');
check('面板不再无条件合并词表', countHits(clientSrc, 'mergeCategoryVocab(categories, categoryVocab)') === 0, '');

// 词表存在后本地过滤必须让位（否则点词表 chip 只剩首屏那一页里的几张卡）
const localGate = lineIf('const visibleSkills = orderedSkills.filter', '本地分类过滤');
check('切到服务端 facet 的分类时不再本地过滤',
    /serverFacet/.test(localGate) && /category === 'all'/.test(localGate), localGate.trim().slice(0, 170));
// 0.5.174：窗外筛选 chip 与窗内 chip 共用同一个 onClick 形状，「setCategory(cat); searchSkills(」
// 在 client.js 里有两处命中——旧 lineIf 要求唯一命中，窗外分支落地后必然拿到空串（红）。
// 正确口径是锁「全部命中行」：每行都必须把上游真 slug 放进 category，任何一处发显示名都算红；
// 再加形状锁 >=2 处，删掉窗外分支会让命中退回 1，同样转红（不许靠删断言换绿灯）。
const clickLines = clientSrc.split(/\r?\n/).filter((l) => l.includes('setCategory(cat); searchSkills('));
check('chip onClick 形状锁：窗内 + 窗外共 2 处同一下发形状（少一处即红）',
    clickLines.length >= 2, 'hits=' + clickLines.length);
check('每处 chip onClick 都发上游真 slug（category: cat），无一处发显示名',
    clickLines.length >= 2 && clickLines.every((l) => /category: cat\b/.test(l)) &&
    clickLines.every((l) => !/category:\s*(chip|c)\.label/.test(l)),
    JSON.stringify(clickLines.map((l) => l.trim().slice(0, 80))));


// 0.5.174 判据（用户 m20051）：skillsmp tail=31 落在 CAT_TAIL_EXPAND_MAX=40 阈内 ⇒ 展开态保留，
// 形态仍是限高纵向滚动（catsRow）+ 行尾收缩/展开哨兵。这里出源码锁，两态成员的真跑判据在
// test-lobehub Test 8 的装配段与 63 类夹具（跑同一段生产码，不在这里复制实现）。
check('展开态纵向滚动形态在场（catsRow 限高 + overflowY，行样式随 catsExpanded 切换）',
    /catsRow: \{[^\n]*maxHeight: 116[^\n]*overflowY: 'auto'/.test(clientSrc) &&
    /style: catsExpanded \? S\.catsRow : S\.chipRow/.test(clientSrc),
    (clientSrc.split(/\r?\n/).find((l) => l.includes('catsRow:')) || '(none)').trim().slice(0, 150));
check('小尾巴源两态入口的三道源码锁在场（阈值常量 / tailExpandable 门控 / 哨兵入集合）',
    /const CAT_TAIL_EXPAND_MAX = 40;/.test(clientSrc) &&
    /chipFold\.other && tailExpandable \? \[toggleChip\] : \[\]/.test(clientSrc) &&
    /const toggleChip = tailExpandable \? \{ value: CATS_COLLAPSE/.test(clientSrc),
    JSON.stringify({ th: /const CAT_TAIL_EXPAND_MAX = 40;/.test(clientSrc), gate: /tailExpandable \? \[toggleChip\]/.test(clientSrc), sen: /const toggleChip = tailExpandable/.test(clientSrc) }));
// 缓存两条路都要带上 serverFacet：只在新返回里认、落缓存时丢掉，刷新一次这一页就退成「未筛」。
// 实测把写入侧改成 serverFacet: false 时 43 条判据全绿，这条盲区用文案锁补上（口径同
// test-ux-honesty.mjs 锁 hasMore：写侧一条、缓存命中回填一条）。
check('当页 serverFacet 落进结果缓存', countHits(clientSrc, 'serverFacet: Boolean(d.serverFacet)') >= 1, '');
check('缓存命中路径回填 serverFacet', countHits(clientSrc, 'setServerFacet(Boolean(cached.serverFacet))') >= 1, '');
function sliceOfSettingsGet() {
  const a = once(indexSrc, 'case "settings.get":', 'settings.get 起');
  const b = indexSrc.indexOf('case "', a + 20);
  return indexSrc.slice(a, b < 0 ? indexSrc.length : b);
}
const sg = sliceOfSettingsGet();
check('词表随 settings.get 下发（与 sortCapabilities 同通道，不新增 op）',
    /categoryVocabulary/.test(sg) && absent(clientSrc, 'skillsmp.categories'), 'sg 无 categoryVocabulary / client 出现新 op');
check('settings.get 只读缓存、不等网络（切 tab 不能被词表抓取拖慢）',
    /readSkillsMpCategoryVocabulary/.test(sg) && !/await skillsmpCategoryVocabulary/.test(sg),
    sg.replace(/\s+/g, ' ').slice(0, 170));
check('冷缓存时后台补取且不阻断（失败只是没有词表）',
    /void skillsmpCategoryVocabulary/.test(sg) && countHits(sg, 'catch') >= 1 && /categoryVocabulary: /.test(sg),
    sg.replace(/\s+/g, ' ').slice(0, 170));
check('聚合层把 serverFacet 交给展示层（面板不再靠猜）',
    /serverFacet/.test(srcSrc) && /serverFacet/.test(readLf('index.js')), '见下');

// 词表读取的缓存语义（面板拿到的就是这份）
try {
  const c = freshCache();
  const cold = await readSkillsMpCategoryVocabulary({ cache: c, now: () => 1000000 });
  check('冷缓存读取返回 null（空词表与没有词表是两回事）', cold === null, JSON.stringify(cold));
  const fetched = await skillsmpCategoryVocabulary({ cache: c, getText: async () => ({ text: snapshot }), now: () => 1000000 });
  const again = await readSkillsMpCategoryVocabulary({ cache: c, now: () => 1000000 + 60000 });
  check('写入后读取命中同一份（不发第二次网络）',
      !!fetched && again === fetched && (again.categories || []).length === vocab.length,
      'again=' + (again && again.categories && again.categories.length));
  const stale = await readSkillsMpCategoryVocabulary({ cache: c, now: () => 1000000 + 8 * 24 * 3600 * 1000 });
  check('超过 7 天视为无词表（宁可回退派生 chip 也不长期贴旧词表）', stale === null, JSON.stringify(stale && stale.capturedAt));
} catch (e) { check('词表读取段可运行', false, String(e && e.message || e).slice(0, 90)); }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);


