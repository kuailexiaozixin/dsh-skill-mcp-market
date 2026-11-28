#!/usr/bin/env node
// test-trusttools-category-vocab.mjs — trusttools 分类通道（服务端 tags 过滤 + 静态词表 + facet 自证）。
//
// 为什么没有夹具（与 test-clawhub-category-vocab 不同，这条必须写清楚）：
//   2026-11-24 复测 ai.trusttools.cn 连 7 次全部超时（GET /api/skills、?tags=ai、?category=x、
//   POST /api/skills/search、/api/skills/categories、站点根），错误原文一致「The operation was
//   aborted due to timeout」。上游不可达期伪造一份「真抓取夹具」就是拿假数据当真凭据，所以本套件
//   全部走注入：断言的是我们自己发出去什么、拿回来的形状怎么解读，不依赖上游此刻的行为。
// 有实测支撑的只有这些（2026-11-23 取证，本轮无法复测）：
//   · category= 参数被上游忽略（8 个 category 值返回同一批）；真过滤参数是 tags=，OR 语义。
//   · 9 类到 tags 的映射取自上游站点 bundle。
//   · 多 tag 的线路编码从未有实测记录（逗号 / 重复参数 / JSON 数组三种形态都没有成功证据）。
// 因此 serverFacet 由返回数据自证而不是由编码假设声明：编码猜错时上游会回未过滤集合，
// 本套件里对应「不声明服务端过滤、退回本地筛选并如实说明」那条通路必须成立。
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safeTempDir } from '../src/home.js';
import { makeCache, searchSkills } from '../src/sources.js';
import { once, lineOf } from './anchor-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const readLf = (p) => read(p).replace(/\r\n/g, String.fromCharCode(10));
// 源码里要匹配模板串：反引号与美元符在本文件用字符码拼，避免嵌套写法把判据自身弄坏。
const BT = String.fromCharCode(96);
const DOLLAR = String.fromCharCode(36);

const esMod = await import('../src/extra-sources.js');
// 缺导出时先桩住而不是直接 import 具名：链接期崩掉的红（NO-SUMMARY）拿不到判据原文，
// 那种红是无效红（0.5.148 教训）。searchTrustTools 同理——本轮给它加了 category 与注入点。
// 缺导出必须判红而不是判 skip：导出本身是被测对象，把它记成 SKIP 会让「功能不存在」
// 看起来像「本轮没测」，而这两件事的交付含义完全不同。stub 仍然 throw，是为了让
// 调用点报错原文能进判据详情（直接 import 具名会在链接期崩，NO-SUMMARY 拿不到判据原文）。
const noExport = (name) => { throw new Error(name + ' 未导出'); };
const trusttoolsCategoryVocabulary = typeof esMod.trusttoolsCategoryVocabulary === 'function'
    ? esMod.trusttoolsCategoryVocabulary : () => noExport('trusttoolsCategoryVocabulary');
const trusttoolsTagsForCategory = typeof esMod.trusttoolsTagsForCategory === 'function'
    ? esMod.trusttoolsTagsForCategory : () => noExport('trusttoolsTagsForCategory');
const trusttoolsCategoryOfTags = typeof esMod.trusttoolsCategoryOfTags === 'function'
    ? esMod.trusttoolsCategoryOfTags : () => noExport('trusttoolsCategoryOfTags');
const searchTrustTools = typeof esMod.searchTrustTools === 'function'
    ? esMod.searchTrustTools : async () => noExport('searchTrustTools');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + detail : '')); }
};
const skip = (name, detail) => { console.log('  SKIP ' + name + (detail ? '  [' + String(detail).slice(0, 140) + ']' : '')); };
const freshCache = () => makeCache(path.join(safeTempDir(), 'dsh-tt-vocab-' + process.pid + '-f' + Math.random().toString(36).slice(2)));
// 判据详情一律过 safe：JSON.stringify(undefined) 返回 undefined，直接 .slice 会抛 TypeError
// 把整套件打成崩溃（0.5.149 实测踩过），崩溃的红是无效红。
const safe = (x) => String(x === undefined ? '(undefined)' : x).slice(0, 170);

// 取证表：判据的期望值，也是实现里静态表的镜像。两边不一致必须报红，否则「代码改了、
// 取证表跟着改」就成了自证。
const EVIDENCE = {
    'ai-automation': ['ai', 'automation', 'ml'],
    'development': ['backend', 'frontend', 'api'],
    'data': ['data', 'analytics'],
    'devops': ['devops', 'cli', 'scripting'],
    'security': ['security', 'testing', 'debugging'],
    'productivity': ['productivity'],
    'docs': ['docs', 'code-review'],
    'cloud': ['cloud', 'performance'],
    'design': ['design', 'frontend'],
};
const SLUGS = Object.keys(EVIDENCE);

const row = (i, tags) => ({
    id: 'r' + i, slug: 'skill-' + i, name: 'Skill ' + i, description: 'd' + i,
    repo_url: 'https://github.com/o/r' + i, repo_path: 'skills/x/SKILL.md',
    install_count: 1000 - i, download_count: 5, stars: 1, security_level: '', tags,
});
const sink = () => ({ urls: [], qs: [], bodies: [] });
// 假上游：形状照 searchTrustTools 真正读取的字段（data[] / pagination.total / 行内 tags）。
const mkGet = (rowsFor, s, totalOf) => async (url) => {
    const u = new URL(url);
    s.urls.push(url);
    s.qs.push(u.searchParams);
    return { data: rowsFor(Number(u.searchParams.get('page')) || 1), pagination: { total: totalOf === undefined ? 100 : Number(totalOf) } };
};
// 看门狗：修复前的 searchTrustTools 没有注入点，会直接打真上游（2026-11-24 实测每次
// 超时 25s+，且还会 curl/python 逐级降级）。判据不能靠等它失败来拿红，所以给每次调用
// 一个 4s 上限：GREEN 下所有假上游都是同步 resolve（毫秒级），看门狗只在「注入点不存在
// 或根本没走注入通路」时触发，报的就是这条事实本身。
const WATCH_MS = 4000;
const withWatch = (p) => Promise.race([
    Promise.resolve().then(p).then((val) => ({ ok: true, val }), (err) => ({ ok: false, err: String((err && err.message) || err) })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), WATCH_MS)).then((x) => x),
]);


// 统一入口：任何一次 searchTrustTools 调用都过看门狗，失败一律成一条判红的 FAIL。
const ttCall = async (args) => {
    const r = await withWatch(() => searchTrustTools(args));
    if (r.timeout) throw new Error(WATCH_MS + 'ms 内未返回：注入点不存在或该调用没走注入通路（修复前形态；真上游 2026-11-24 七次全超时）');
    if (!r.ok) throw new Error(r.err);
    return r.val;
};

const mkPost = (rowsFor, s, totalOf) => async (url, body) => {
    s.urls.push(url);
    s.bodies.push(body);
    return { data: rowsFor(Number(body.page) || 1), pagination: { total: totalOf === undefined ? 100 : Number(totalOf) } };
};
// total 感知假上游（0.5.159 的取证形状）：带 tags 的请求回 filteredTotal，不带的回 refTotal。
// 这就是上游真按 tags 过滤时 pagination.total 的样子（实测 579,074 → security 4,372）。
// 行内 tags 一律置 []，照抄 2026-11-24 实测：列表端点的 tags 字段恒为空数组。
const mkTotals = (rowsFor, s, filteredTotal, refTotal) => async (url, opts) => {
    const u = new URL(url);
    // 第二参在 GET 通路上是 { timeoutMs } 选项对象，只有 POST 才带 search/page 请求体。
    const isPost = Boolean(opts) && typeof opts === 'object' && (typeof opts.search === 'string' || opts.page !== undefined);
    const tags = isPost ? (Array.isArray(opts.tags) ? opts.tags : []) : u.searchParams.getAll('tags');
    s.urls.push(url);
    if (isPost) s.bodies.push(opts); else s.qs.push(u.searchParams);
    const pg = Number(isPost ? opts.page : u.searchParams.get('page')) || 1;
    const rows = rowsFor(pg).map((r) => Object.assign({}, r, { tags: [] }));
    return { data: rows, pagination: { total: tags.length ? filteredTotal : refTotal } };
};

console.log('');
console.log('Test 1: 静态词表形状（不编条数、不编显示名、带归属）');
{
    let v = null;
    try { v = trusttoolsCategoryVocabulary(); } catch (e) { v = { err: String((e && e.message) || e) }; }
    if (v && v.err) { check('词表可取（trusttoolsCategoryVocabulary 必须是真导出）', false, safe(v.err)); }
    else {
        check('9 类全收且顺序=取证表顺序',
            Array.isArray(v.categories) && v.categories.length === 9 && v.categories.map((c) => c.slug).join(',') === SLUGS.join(','),
            safe((v.categories || []).map((c) => c.slug).join(',')));
        check('每条带 slug/label/tags（tags 就是上游真过滤参数）',
            v.categories.every((c) => c.slug && typeof c.label === 'string' && c.label.length > 0 && Array.isArray(c.tags) && c.tags.length > 0),
            safe(JSON.stringify(v.categories[0])));
        check('tags 与取证表逐字符一致',
            v.categories.every((c) => c.tags.join(',') === EVIDENCE[c.slug].join(',')),
            safe(JSON.stringify(v.categories.map((c) => [c.slug, c.tags]))));
        // 上游词表端点不可达，没有任何真显示名的实测依据 → label 回落 slug，编中文名等于造数据。
        check('label 不凭空发明（只能等于 slug）',
            v.categories.every((c) => c.label === c.slug),
            safe(JSON.stringify(v.categories.filter((c) => c.label !== c.slug).map((c) => [c.slug, c.label]))));
        // 同理不编条数：tag 级 total 是 2026-11-23 的快照，且不是 category 级。
        check('词表不含条数（没有 category 级实测总数就不许有）',
            v.categories.every((c) => c.totalAll === undefined && c.count === undefined),
            safe(JSON.stringify(Object.keys(v.categories[0]))));
        check('快照带 source 指向上游站点（面板据此核验归属，不串味）',
            String(v.source || '').indexOf('https://ai.trusttools.cn/') === 0 && Number(v.capturedAt) > 0,
            safe(JSON.stringify({ source: v.source, capturedAt: v.capturedAt })));
        const again = trusttoolsCategoryVocabulary();
        check('两次调用互不干扰（改一份不污染另一份）',
            again.categories[0].tags !== v.categories[0].tags
                && again.categories[0] !== v.categories[0]
                && again.categories.map((c) => c.slug).join(',') === v.categories.map((c) => c.slug).join(','),
            'sameRowRef=' + (again.categories[0] === v.categories[0]));
    }
}

console.log('');
console.log('Test 2: slug 到 tags（表外一律 null，不猜 tag）');
// block 级兜底：桩函数按设计是 throw 的，裸调用会让整套件在缺导出时崩成 NO-SUMMARY
// （本轮 RED 实测就是这样），那种红拿不到判据原文。兜底把崩溃转成一条红并继续跑完。
{
try {
    let allOk = true;
    const diff = [];
    for (const s of SLUGS) {
        const got = trusttoolsTagsForCategory(s);
        if (!got || got.join(',') !== EVIDENCE[s].join(',')) { allOk = false; diff.push(s + '->' + safe(got && got.join('+'))); }
    }
    check('表内 9 个 slug 各自回完整 tags', allOk, safe(diff.join(' ')));
    const a = trusttoolsTagsForCategory('security');
    if (a) a.push('zzz');
    const b = trusttoolsTagsForCategory('security');
    check('回的是副本（改它不污染词表本身）', !!b && b.length === 3, safe(b && b.join('+')));
    const c = trusttoolsTagsForCategory('  SECURITY ');
    check('大小写与首尾空白不影响命中', !!c && c.join(',') === EVIDENCE.security.join(','), safe(c && c.join('+')));
    const junk = ['', '   ', null, undefined, 'all', 'research', 'integrations', 'douyin', '抖音', 'json', 'ai'];
    let junkOk = true;
    const junkHit = [];
    for (const j of junk) {
        const got = trusttoolsTagsForCategory(j);
        if (got !== null) { junkOk = false; junkHit.push(safe(j) + '->' + safe(got && got.join('+'))); }
    }
    check('表外值一律 null（含单 tag 名 ai 这种「看着像」的）', junkOk, safe(junkHit.join(' ')));
} catch (e) {
    check('slug 到 tags 通路可运行（缺导出是红，不是崩溃）', false, safe(String((e && e.message) || e)));
}
}

console.log('');
console.log('Test 3: 行内 tags 到规范分类（旧口径是 tags[0]，与 clawhub topics[0] 同族泄漏）');
{
try {
    check('单 tag 命中回该类', trusttoolsCategoryOfTags(['productivity']) === 'productivity',
        safe(trusttoolsCategoryOfTags(['productivity'])));
    const secMiss = EVIDENCE.security.filter((t) => trusttoolsCategoryOfTags([t]) !== 'security');
    check('多 tag 类的每个 tag 都能定类（security 靠 testing 也算）', secMiss.length === 0,
        safe(secMiss.map((t) => t + '->' + trusttoolsCategoryOfTags([t])).join(' ')));
    check('表外 tags 回空串而不是拿第一个 tag 冒充分类',
        trusttoolsCategoryOfTags(['douyin', '抖音', 'json']) === '',
        safe(trusttoolsCategoryOfTags(['douyin', '抖音', 'json'])));
    check('空串与非数组回空串而不是抛',
        ['', null, undefined].every((x) => trusttoolsCategoryOfTags(x) === '') && trusttoolsCategoryOfTags([]) === '',
        safe([null, undefined].map((x) => JSON.stringify(trusttoolsCategoryOfTags(x))).join(' ')));
    check('多个表内 tag 时取第一个命中的（顺序可复现）',
        trusttoolsCategoryOfTags(['zzz', 'data', 'ai']) === 'data',
        safe(trusttoolsCategoryOfTags(['zzz', 'data', 'ai'])));
    // 词表本身的重叠（frontend 同属 development 与 design）如实锁住：单值字段只能取一个归属，
    // 过滤正确性靠 tags 通道而不是这个字段，所以这不构成假陈述，但口径必须可见。
    check('tag 重叠时归属第一个表内类（frontend 同属 development/design）',
        trusttoolsCategoryOfTags(['frontend']) === 'development' && trusttoolsCategoryOfTags(['design', 'frontend']) === 'design',
        safe('frontend->' + trusttoolsCategoryOfTags(['frontend']) + ' design+frontend->' + trusttoolsCategoryOfTags(['design', 'frontend'])));
} catch (e) {
    check('tags 到规范分类通路可运行（缺导出是红，不是崩溃）', false, safe(String((e && e.message) || e)));
}
}

console.log('');
console.log('Test 4: 发出去的请求带 tags（GET 与 POST 两条通路都带）');
{
    const g = sink();
    const okRows = (page) => [row(page * 10 + 1, ['security']), row(page * 10 + 2, ['testing']), row(page * 10 + 3, ['debugging'])];
    try {
        const r = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkGet(okRows, g), postJson: mkPost(okRows, g) });
        const tagSets = g.qs.map((q) => q.getAll('tags').join(','));
        check('GET 多 tag 用单键逗号形式（tags=a&tags=b 实测只有最后一个生效，属错筛）',
            g.qs.every((q) => q.getAll('tags').length <= 1) && g.qs.some((q) => q.getAll('tags')[0] === EVIDENCE.security.join(',')),
            safe(g.qs.map((q) => JSON.stringify(q.getAll('tags'))).join(' | ')));
        check('服务端排序通路每请求都带上该类的全部 tags（OR 语义）',
            g.qs.length >= 2 && g.qs.filter((q) => q.getAll('tags').length > 0).every((q) => q.getAll('tags').join(',') === EVIDENCE.security.join(',')),
            safe(g.urls.length + ' 次: ' + tagSets.join(' | ')));
        check('不再发 category= 参数（实测被忽略，发了就是假过滤）',
            g.qs.every((q) => q.get('category') === null),
            safe(g.qs.map((q) => String(q.get('category'))).join(',')));
        check('返回行全部命中所请求 tag → serverFacet=true（数据自证）', r.serverFacet === true, safe(JSON.stringify(r.serverFacet)));
        check('真过滤时不发「退回本地筛选」的提示',
            !/未按分类|已退回/.test(String(r.hint || '')), safe(String(r.hint).slice(0, 130)));
        check('行内 category 已是规范 slug（不是 tags[0]）',
            r.items.length === 3 && r.items.every((i) => i.category === 'security'),
            safe(r.items.map((i) => i.category).join(',')));
    } catch (e) {
        check('GET 通路可运行', false, safe(String((e && e.message) || e)));
    }
    const b = sink();
    const postRows = (page) => [row(page * 10 + 1, ['security', 'zz']), row(page * 10 + 2, ['testing'])];
    try {
        await ttCall({ query: 'pdf', page: 1, pageSize: 10, cache: null, category: 'data', getJson: mkGet(postRows, b), postJson: mkPost(postRows, b) });
        const bodyTags = b.bodies.map((x) => (Array.isArray(x.tags) ? x.tags.join(',') : String(x.tags)));
        check('搜索通路走 POST 且 body 带该类 tags',
            b.bodies.length >= 2 && b.bodies.filter((x) => Array.isArray(x.tags)).every((t) => t.tags.join(',') === EVIDENCE.data.join(',')),
            safe(bodyTags.join(' | ')));
        check('POST body 仍带 search（旧行为不回退）',
            b.bodies.every((x) => x.search === 'pdf'), safe(JSON.stringify(b.bodies[0])));
    } catch (e) {
        check('POST 通路可运行', false, safe(String((e && e.message) || e)));
    }
}

console.log('');
console.log('Test 5: 表外分类不把别处的值当本市场分类发出去');
{
    for (const junk of ['douyin', 'json', 'research', 'ALL']) {
        const s = sink();
        let r = null;
        try {
            r = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: junk, getJson: mkGet((p) => [row(p, ['ai'])], s), postJson: mkPost((p) => [row(p, ['ai'])], s) });
        } catch (e) { r = { err: String((e && e.message) || e) }; }
        if (r && r.err) { check('表外「' + safe(junk) + '」通路可运行（缺 category/注入点就是红，不是没测）', false, safe(r.err)); continue; }
        const sentTags = s.qs.map((q) => q.getAll('tags').join(',')).filter((t) => t !== '');
        check('表外一个 tag 都不发（猜 tag 就是编上游行为）',
            sentTags.length === 0, safe(junk + ' sent=' + sentTags.join(' | ')));
        check('表外不得谎报服务端已筛', r.serverFacet === false, safe(junk + ' serverFacet=' + JSON.stringify(r.serverFacet)));
        check('表外写清是该分类不存在（不是该分类下没匹配，且不出现「词表」这类工程词）',
            /没有「|不存在/.test(String(r.hint || '')) && String(r.hint || '').indexOf('词表') < 0, safe(junk + ' hint=' + String(r.hint).slice(0, 130)));
    }
}

console.log('');
console.log('Test 6: facet 自证——编码猜错或上游忽略时绝不声明服务端过滤');
{
    const s1 = sink();
    const unfiltered = (page) => [row(page * 10 + 1, ['security']), row(page * 10 + 2, ['douyin']), row(page * 10 + 3, ['json'])];
    let r1 = null;
    try {
        r1 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkGet(unfiltered, s1), postJson: mkPost(unfiltered, s1) });
    } catch (e) { r1 = { err: String((e && e.message) || e) }; }
    if (r1 && r1.err) { check('忽略参数段可运行', false, safe(r1.err)); }
    else {
        check('有一行不含所请求 tag → serverFacet=false', r1.serverFacet === false, safe(JSON.stringify(r1.serverFacet)));
        check('退回本地筛选必须说清（不能静默把未过滤集合说成该分类）',
            /未按分类|本地|已退回/.test(String(r1.hint || '')), safe(String(r1.hint).slice(0, 130)));
        check('条目不因自证失败被丢（宁可少筛，不可假筛）', r1.items.length === 3, 'n=' + r1.items.length);
    }
    const s2 = sink();
    let r2 = null;
    try {
        r2 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkGet(() => [], s2), postJson: mkPost(() => [], s2) });
    } catch (e) { r2 = { err: String((e && e.message) || e) }; }
    if (r2 && r2.err) { check('空页段可运行', false, safe(r2.err)); }
    else {
        check('空页不声明 serverFacet（空页什么也不证明）', r2.serverFacet === false, safe(JSON.stringify(r2.serverFacet)));
        check('空页不发「已退回本地筛选」这种误导提示', !/本地|已退回/.test(String(r2.hint || '')), safe(String(r2.hint).slice(0, 130)));
    }
    const s3 = sink();
    const noTags = (page) => [{ id: 'x' + page, slug: 'x' + page, name: 'X', repo_url: 'https://github.com/o/x', repo_path: 'p', install_count: 1 }];
    let r3 = null;
    try {
        r3 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkGet(noTags, s3), postJson: mkPost(noTags, s3) });
    } catch (e) { r3 = { err: String((e && e.message) || e) }; }
    if (r3 && r3.err) { check('行内无 tags 段可运行', false, safe(r3.err)); }
    else {
        check('行内没有 tags 字段 → serverFacet=false（上游改版不许冒充筛过）', r3.serverFacet === false, safe(JSON.stringify(r3.serverFacet)));
        check('无 tags 时分类字段回空串（不是拿别的字段凑一个）',
            r3.items.length === 1 && r3.items[0].category === '', safe(JSON.stringify((r3.items[0] || {}).category)));
    }
}

console.log('');
console.log('Test 6.1: facet 自证换 total 口径（真上游行内 tags 恒空）');
{
    const ttRows = (page) => [row(page * 10 + 1), row(page * 10 + 2), row(page * 10 + 3)];
    const s1 = sink();
    let r1 = null;
    try {
        r1 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkTotals(ttRows, s1, 4372, 579074), postJson: mkTotals(ttRows, s1, 4372, 579074) });
    } catch (e) { r1 = { err: String((e && e.message) || e) }; }
    if (r1 && r1.err) { check('total 口径段可运行', false, safe(r1.err)); }
    else {
        check('行内 tags 恒空但带分类的 total 变小 → serverFacet=true（0.5.158 旧口径在这里必然误判）',
            r1.serverFacet === true, safe(JSON.stringify(r1.serverFacet)));
        check('serverFacet 为真时必须确实发过不带 tags 的参照请求（不是拿同一发数字自说自话）',
            s1.qs.length >= 2 && s1.qs.some((q) => q.getAll('tags').length === 0),
            safe('请求 ' + s1.qs.length + ' 次: ' + s1.qs.map((q) => JSON.stringify(q.getAll('tags'))).join(' | ')));
        check('分类页 total 上报该分类的集合大小而不是全量（面板据此算页数）', r1.total === 4372, safe(r1.total));
        check('真过滤时不发退回本地筛选提示', !/未按分类|未通过自证|已退回/.test(String(r1.hint || '')), safe(String(r1.hint).slice(0, 130)));
    }
    const s2 = sink();
    let r2 = null;
    try {
        r2 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkTotals(ttRows, s2, 579074, 579074), postJson: mkTotals(ttRows, s2, 579074, 579074) });
    } catch (e) { r2 = { err: String((e && e.message) || e) }; }
    if (r2 && r2.err) { check('total 相同段可运行', false, safe(r2.err)); }
    else {
        check('带分类与不带分类 total 相同 → serverFacet=false（上游忽略 tags 时绝不谎报）',
            r2.serverFacet === false, safe(JSON.stringify(r2.serverFacet)));
        check('自证失败时如实说明退回本地筛选', /未通过自证|已退回/.test(String(r2.hint || '')), safe(String(r2.hint).slice(0, 130)));
    }
    const s3 = sink();
    let r3 = null;
    try {
        r3 = await ttCall({ query: '', page: 1, pageSize: 10, cache: null, sort: 'installCount', category: 'security', getJson: mkTotals(ttRows, s3, 4372, 0), postJson: mkTotals(ttRows, s3, 4372, 0) });
    } catch (e) { r3 = { err: String((e && e.message) || e) }; }
    if (r3 && r3.err) { check('参照缺失段可运行', false, safe(r3.err)); }
    else {
        check('参照 total 拿不到（0 或缺失）→ serverFacet=false，不许拿 0 比 4372 凑证据',
            r3.serverFacet === false, safe(JSON.stringify(r3.serverFacet)));
        check('参照缺失时也必须真的发过那一发不带 tags 的请求',
            s3.qs.some((q) => q.getAll('tags').length === 0), safe(s3.qs.map((q) => JSON.stringify(q.getAll('tags'))).join(' | ')));
    }
    const s4 = sink();
    let r4 = null;
    try {
        r4 = await ttCall({ query: 'pdf', page: 1, pageSize: 10, cache: null, category: 'security', getJson: mkTotals(ttRows, s4, 14, 6865), postJson: mkTotals(ttRows, s4, 14, 6865) });
    } catch (e) { r4 = { err: String((e && e.message) || e) }; }
    if (r4 && r4.err) { check('POST 段可运行', false, safe(r4.err)); }
    else {
        check('POST 通路同样按 total 对照自证（实测 search=pdf 14 对 6,865）',
            r4.serverFacet === true && r4.total === 14, safe(JSON.stringify([r4.serverFacet, r4.total])));
        check('POST 参照请求 body 里 tags 必须缺席且参照真的发过（空数组也算带筛选条件）',
            s4.bodies.length >= 2 && s4.bodies.every((x) => x.search === 'pdf') && s4.bodies.some((x) => !x.tags || !x.tags.length),
            safe(JSON.stringify(s4.bodies.map((x) => (x && x.tags) || null))));
    }
}
console.log('');
console.log('Test 7: 缓存键带 facet 维度（换分类不得复用上一分类的页）');
{
    const cache = freshCache();
    const s = sink();
    const byCat = (tag) => (page) => [row(page * 10 + 1, [tag])];
    const call = (cat) => ttCall({ query: '', page: 1, pageSize: 10, cache, sort: 'installCount', category: cat, getJson: mkGet(byCat(cat), s), postJson: mkPost(byCat(cat), s) });
    let first = null;
    let second = null;
    try {
        first = await call('security');
        second = await call('productivity');
    } catch (e) { check('缓存通路可运行', false, safe(String((e && e.message) || e))); }
    if (first && second) {
        check('换分类拿到的是新分类的页，不是上一分类的缓存副本',
            second.items.length === 1 && second.items[0].category === 'productivity',
            safe((second.items[0] || {}).category) + ' calls=' + s.urls.length);
        const before = s.urls.length;
        let third = null;
        try { third = await call('productivity'); } catch (e) { third = { err: String((e && e.message) || e) }; }
        check('同一分类重复请求命中缓存（不重复打上游）',
            !!third && !third.err && s.urls.length === before && third.items.length === 1,
            'before=' + before + ' after=' + s.urls.length);
        check('两条 facet 通路各自独立自证（缓存不互相污染声明）',
            first.serverFacet === true && second.serverFacet === true,
            safe('sec=' + first.serverFacet + ' prod=' + second.serverFacet));
    }
}

console.log('');
console.log('Test 8: 聚合层吃 trusttools 的 facet 与规范分类字段');
{
    try {
        const r = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: 12, cache: null, category: 'security',
            handlers: {
                trusttools: async () => ({ source: 'trusttools', items: [
                    { id: 'trusttools:1', slug: 'a', name: 'A', source: 'trusttools', category: 'security' },
                    { id: 'trusttools:2', slug: 'b', name: 'B', source: 'trusttools', category: 'security' },
                ], total: 2, hasMore: false, totalPages: 1, serverFacet: true }),
            }, budgetMs: 5000 });
        check('trusttools 说筛过 → 聚合 serverFacet=true 且不再本地二次筛',
            r.serverFacet === true && r.items.length === 2 && !r.filteredOut,
            'serverFacet=' + safe(JSON.stringify(r.serverFacet)) + ' n=' + r.items.length + ' filteredOut=' + safe(r.filteredOut));
        const r2 = await searchSkills({ query: '', source: 'trusttools', page: 1, pageSize: 12, cache: null, category: 'security',
            handlers: {
                trusttools: async () => ({ source: 'trusttools', items: [
                    { id: 'trusttools:1', slug: 'a', name: 'A', source: 'trusttools', category: 'security' },
                    { id: 'trusttools:2', slug: 'b', name: 'B', source: 'trusttools', category: 'data' },
                    { id: 'trusttools:3', slug: 'c', name: 'C', source: 'trusttools', category: '' },
                ], total: 3, hasMore: false, serverFacet: false }),
            }, budgetMs: 5000 });
        // 聚合层的既有契约（src/sources.js:779-783）：不含分类的条目是**保留**而不是筛掉——
        // 严格过滤会让不提供分类的源整源消失，那是数据丢失不是过滤。所以本页 3 条里
        // 筛掉 1 条（category=data），留下 1 条命中 + 1 条未标注。锁这个数就是锁规范 slug
        // 真的分得开了（tags[0] 时代这三条可能全被算成同一个值）。
        check('服务端没筛 → 聚合走本地兜底且规范 slug 分得开（未标注分类的条目按契约保留）',
            r2.serverFacet === false && r2.items.length === 2 && r2.filteredOut === 1 && r2.items[0].category === 'security',
            'serverFacet=' + safe(JSON.stringify(r2.serverFacet)) + ' n=' + r2.items.length + ' filteredOut=' + safe(r2.filteredOut) + ' cats=' + r2.items.map((i) => JSON.stringify(i.category)).join(','));
        check('本地兜底如实写明只作用于当前页与保留的未标注条目',
            /仅当前页|本地/.test(String(r2.categoryNote || '')) && /未标注分类/.test(String(r2.categoryNote || '')), safe(String(r2.categoryNote).slice(0, 150)));
    } catch (e) {
        check('聚合层通路可运行', false, safe(String((e && e.message) || e)));
    }
}

console.log('');
console.log('Test 9: 接线（import / settings.get 下发 / 面板归属 / 套件登记）');
{
    const ix = readLf('index.js');
    const imp = (ix.match(/import \{[^}]*\} from "\.\/src\/extra-sources\.js";/) || [null])[0];
    check('index.js 已导入 trusttools 词表符号（缺 import 就是 0.5.148 那类崩溃）',
        !!imp && /trusttoolsCategoryVocabulary/.test(imp), safe(imp || '(无 extra-sources import)'));
    const a = once(ix, 'case "settings.get":', 'settings.get 起');
    const b = ix.indexOf('case "', a + 20);
    const sg = ix.slice(a, b < 0 ? ix.length : b);
    check('settings.get 下发 trusttools 键（按源分组，不新增 op）', /trusttools/.test(sg), safe(sg.replace(/\s+/g, ' ')));
    check('静态词表同步取，不在 settings.get 里等网络（该 op 从不打网络）',
        !/await trusttoolsCategoryVocabulary/.test(sg) && /trusttoolsCategoryVocabulary\(\)/.test(sg),
        safe((sg.match(/trusttoolsCategoryVocabulary[^;]{0,60}/g) || ['(未出现)']).join(' ~ ')));
    check('另两份词表都冷缓存时 trusttools 仍要下发（不能只在有词表时才补键）',
        /categoryVocabulary = \{ trusttools: ttVocab \}/.test(sg),
        safe((sg.match(/if \(categoryVocabulary\) categoryVocabulary\.trusttools[^;]*;|categoryVocabulary = \{ trusttools: ttVocab \};/g) || ['(未找到兜底赋值)']).join(' ~ ')));
    // V5 存活教训（实测 62/0）：上一行只锁了冷缓存兜底赋值，热路径那句 `categoryVocabulary.trusttools =
    // ttVocab` 的键名没有任何判据吃它——把 trusttools 改成 skillsmp 照样全绿，而那一改会让两份词表都热时
    // trusttools 键根本不下发、并覆盖掉 skillsmp 那份。补这条精确键锁。
    check('两份词表都热时 trusttools 键仍按自己的名字挂上（不是覆盖 skillsmp）',
        /categoryVocabulary\.trusttools\s*=\s*ttVocab/.test(sg),
        safe((sg.match(/if \(categoryVocabulary\) categoryVocabulary\.\w+ = ttVocab;|categoryVocabulary\.trusttools[^;]*;/g) || ['(未找到热路径赋值)']).join(' ~ ')));
    check('trusttools 那份不参与 Promise.all 等待（只有两个只读缓存进 all）',
        !/Promise\.all\(\[[^\]]*trusttools/i.test(sg), safe((sg.match(/Promise\.all\(\[[^\]]{0,200}/) || ['(无)'])[0]));
    const es = readLf('src/extra-sources.js');
    check('extra-sources.js 真的导出三件',
        /export function trusttoolsCategoryVocabulary/.test(es) && /export function trusttoolsTagsForCategory/.test(es) && /export function trusttoolsCategoryOfTags/.test(es), '');
    check('searchTrustTools 已吃 category 且带注入点（否则测试只能打真上游）',
        /export async function searchTrustTools\(\{[\s\S]{0,320}?category[\s\S]{0,320}?getJson = getJsonEscalating[\s\S]{0,160}?postJson = postJsonEscalating/.test(es),
        safe((es.match(/export async function searchTrustTools\([\s\S]{0,240}/) || ['(未找到签名)'])[0].replace(/\s+/g, ' ')));
    // 详情必须在 searchTrustTools 体内取：裸匹配 ` {6}category:` 命中的是第一处（clawhub 的
    // 映射行），本轮 RED 实测就打印成了 clawhubCategoryOf(raw)——报着别处的代码当证据。
    const ttBody = es.slice(es.indexOf('export async function searchTrustTools'));
    check('缓存键含 facet 维度（换分类不复用同一键）', ttBody.includes(':' + DOLLAR + '{facetUsed}'),
        safe((ttBody.match(new RegExp('const key = ' + BT + 'trusttools:[^' + BT + ']*')) || ['(未找到缓存键)'])[0]));
    check('行内分类字段不再取 tags[0]（0.5.151 那类泄漏的源头）',
        /category: trusttoolsCategoryOfTags\(raw\.tags\)/.test(ttBody) && !/raw\.tags\[0\]/.test(ttBody),
        safe((ttBody.match(/ {6}category: [^\n]*/) || ['(未找到)'])[0]));
    check('tags 编码注释写明 2026-11-24 实测结论，且不得保留已被否证的「没有实测记录」旧口径',
        /2026-11-24 实测/.test(es) && !/线路编码没有实测记录/.test(es) && !/上游支持重复参数/.test(es),
        safe((es.match(/[^\n]*线路编码[^\n]*/) || ['(注释缺失)'])[0]));
    const client = readLf('client.js');
    const originLine = lineOf(client, once(client, 'const ORIGIN = {', '面板归属映射'));
    const ttOrigin = (originLine.match(/trusttools: '([^']+)'/) || [null, null])[1];
    check('面板 ORIGIN 含 trusttools（不加就永远走纯派生 chip，词表白下发）', ttOrigin !== null, safe(originLine.trim()));
    check('面板前缀与服务端 source 逐字符一致（不一致 categoryChipsForSource 会整排丢弃）',
        ttOrigin !== null && es.indexOf(ttOrigin) >= 0, safe('client=' + ttOrigin + ' es含之=' + (ttOrigin !== null && es.indexOf(ttOrigin) >= 0)));
    check('新套件已登记进 test:chain（漏登记就是静默游离套件）',
        /test-trusttools-category-vocab\.mjs/.test(readLf('package.json')), safe((readLf('package.json').match(/"test:chain"[^\n]{0,90}/) || ['(无)'])[0]));
}

// ---------------------------------------------------------------- Test 10: 面板 chip 真行为
// 接线判据（Test 9）只证明 ORIGIN 里写了 trusttools，不证明那一排 chip 真按词表画出来。
// 0.5.151 那轮的漏验就是同一个形状：只核了「规范类出现」，没核「派生值消失」，
// 结果 douyin/抖音 七个自由标签照样在面板上（用户实测点名）。这里跑真实函数体，
// 和 skillsmp 套件同一口径（bodyOf 扫到 0 列闭括号；anchor-lib 的 blockEnd 会被签名里的
// 默认值对象提前归零，那个坑 skillsmp 套件注释里已写明）。
console.log('');
console.log('Test 10: 面板 chip 真按 trusttools 词表画（跑真实函数体）');
{
    const clientLines = readLf('client.js').split(String.fromCharCode(10));
    const bodyOf = (declNeedle) => {
        const at = clientLines.findIndex((l) => l.indexOf(declNeedle) >= 0);
        if (at < 0) return null;
        for (let i = at + 1; i < clientLines.length; i++) if (clientLines[i] === '}') return clientLines.slice(at, i + 1).join(String.fromCharCode(10));
        return null;
    };
    const outer = bodyOf('function categoryChipsForSource(');
    const inner = bodyOf('function mergeCategoryVocab(');
    check('面板两个函数体取得到（拿不到就是锚失效，不是实现有问题）',
        outer !== null && inner !== null, safe('outer=' + (outer === null ? 'null' : 'ok') + ' inner=' + (inner === null ? 'null' : 'ok')));
    let chips = null;
    try {
        chips = new Function(inner + String.fromCharCode(10) + outer + String.fromCharCode(10) + 'return categoryChipsForSource;')();
    } catch (e) {
        chips = null;
        check('面板函数可执行', false, safe((e && e.message) || e));
    }
    if (typeof chips === 'function') {
        const run = (source, derived, bySource) => chips(source, derived, bySource);
        const freeTags = ['douyin', '抖音', 'json', 'ai-tools'];
        const real = (() => { try { return trusttoolsCategoryVocabulary(); } catch { return null; } })();
        check('词表在手时 trusttools 那一排全是规范 9 类（派生自由标签一个都不留）',
            Array.isArray(real && real.categories) && (() => {
                const got = run('trusttools', freeTags, { trusttools: real });
                return got.length === 9 && got.every((c) => c.fixed === true)
                    && got.every((c) => freeTags.indexOf(c.value) < 0);
            })(), safe(JSON.stringify((() => { try { return run('trusttools', freeTags, { trusttools: real }).map((c) => c.value); } catch (e) { return String((e && e.message) || e); } })())));
        check('顺序按词表顺序（无条数时不许瞎排）',
            (() => { const g = run('trusttools', [], real); return g.map((c) => c.value).join(',') === real.categories.map((c) => c.slug).join(','); })(),
            safe((() => { try { return run('trusttools', [], real).map((c) => c.value).join(','); } catch (e) { return String((e && e.message) || e); } })()));
        check('chip 标签非空（label 回落 slug，绝不显示 undefined/空串）',
            run('trusttools', [], real).every((c) => c.label && c.label !== 'undefined'),
            safe(run('trusttools', [], real).map((c) => c.label).slice(0, 3).join(',')));
        const legacy = run('trusttools', freeTags, real);
        check('旧服务端单一形状（未分组）同样生效——面板热更新、服务端等重启是真实中间态',
            legacy.length === 9 && legacy.every((c) => c.fixed === true), safe(JSON.stringify(legacy.map((c) => c.value).slice(0, 3)) + ' n=' + legacy.length));
        const cold = run('trusttools', freeTags, { skillsmp: real });
        check('本市场词表尚未下发时派生值保留（不能把分类入口关掉）',
            cold.length === freeTags.length && cold.every((c) => c.fixed === false), safe(JSON.stringify(cold)));
        // 线上稳定态是两份词表都热（新服务端 + skillsmp 也已补取）：只测冷路径兜底会漏掉分组取键这条路。
        const bothHot = run('trusttools', freeTags, {
            skillsmp: { source: 'https://skillsmp.com/', categories: [{ slug: 'debugging', label: '调试工具', totalAll: 532411 }] },
            trusttools: real,
        });
        check('两份词表都热时本市场仍只用 trusttools 自己的词表（分组取键，不被别家覆盖）',
            bothHot.length === 9 && bothHot.every((c) => c.fixed === true), safe(JSON.stringify(bothHot.map((c) => c.value).slice(0, 4)) + ' n=' + bothHot.length));
        const foreign = run('trusttools', freeTags, { trusttools: Object.assign({}, real, { source: 'https://other-market.example/' }) });
        check('词表来源前缀不是 trusttools 时整排丢弃退派生（串味防护真生效，不只是写了分支）',
            foreign.length === freeTags.length && foreign.every((c) => c.fixed === false), safe(JSON.stringify(foreign)));
        const leak = run('clawhub', ['weird-derived-slug'], { trusttools: real });
        check('trusttools 词表不得出现在别的市场下（用户 0.5.151 点名的假分类）',
            leak.length === 1 && leak[0].value === 'weird-derived-slug' && leak[0].fixed === false, safe(JSON.stringify(leak)));
        const noKey = run('trusttools', freeTags, null);
        check('settings.get 整体失败时退派生（pathsView 同款：不依赖它的那部分照常）',
            noKey.length === freeTags.length && noKey.every((c) => c.fixed === false), safe(JSON.stringify(noKey)));
    }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
