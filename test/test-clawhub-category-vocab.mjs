#!/usr/bin/env node
// test-clawhub-category-vocab.mjs — clawhub 分类通道（服务端 category 过滤 + 规范词表）。
//
// 为什么单独一套（全部为 2026-11-23 实测，非推测）：
//   · GET /api/v1/skills/-/categories → 200，{categories:[{slug,label,description,icon}]}，
//     14 条、含 other、按站点目录显示顺序；**没有条数字段**（文档明写「这是公开词表，
//     不是可用技能计数」），所以 chip 只能显示标签，不许编条数。
//   · GET /api/v1/skills?category=<slug> → 服务端真过滤：category=security 首条
//     skill-vetter（categories:["security"]），无效 slug → HTTP 400；行内 categories
//     恒含所请求 slug（实测两页 100 行 0 违例）。
//   · cursor + category + sort 链真实：limit=50 page1=50、page2=50、重叠 0。
//   · limit 上界：limit=200 实回 197、limit=500 仍 197（文档写 1-200）。
//   · GET /api/v1/search?q=&category= → 有效 slug 收窄结果；**无效 slug 回 200 + 空
//     results**（与 list 端点的 400 不同形），所以搜索路径不能靠状态码判「slug 不存在」。
//   · 旧实现整个 category 参数被丢弃：browse 走「cursor 累积目录再本地切页」，
//     分类过滤落到聚合层的「仅当前页」本地兜底（categoryNote 明说），
//     面板 chip 又是从当前页卡片派生 —— 与 0.5.148 之前 skillsmp 的毛病同形。
// 判据跑真实模块与真实夹具字节，不靠文本搜索充当证据。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeTempDir } from '../src/home.js';
import { makeCache, searchSkills } from '../src/sources.js';
import { once } from './anchor-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const readLf = (p) => read(p).replace(/\r\n/g, String.fromCharCode(10));

const esMod = await import('../src/extra-sources.js');
// 缺导出时先桩住而不是直接 import 具名：整套件要能逐条报红拿到真实形态，
// 链接期崩掉的红（NO-SUMMARY）拿不到判据原文，那种红是无效红（0.5.148 教训）。
const parseClawhubCategories = typeof esMod.parseClawhubCategories === 'function'
    ? esMod.parseClawhubCategories
    : () => { throw new Error('parseClawhubCategories 未导出'); };
const clawhubCategoryVocabulary = typeof esMod.clawhubCategoryVocabulary === 'function'
    ? esMod.clawhubCategoryVocabulary
    : async () => { throw new Error('clawhubCategoryVocabulary 未导出'); };
const readClawhubCategoryVocabulary = typeof esMod.readClawhubCategoryVocabulary === 'function'
    ? esMod.readClawhubCategoryVocabulary
    : async () => { throw new Error('readClawhubCategoryVocabulary 未导出'); };

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + detail : '')); }
};
const skip = (name, detail) => { console.log('  SKIP ' + name + (detail ? '  [' + String(detail).slice(0, 120) + ']' : '')); };
const freshCache = () => makeCache(path.join(safeTempDir(), 'dsh-ch-vocab-' + process.pid + '-f' + Math.random().toString(36).slice(2)));

// ---------------------------------------------------------------- 夹具
const FIX = path.join(here, 'fixtures', 'clawhub-category-vocab.json');
const fixture = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : null;
check('夹具在位（生产通路抓的真实响应 + browse 样本）',
    !!fixture && Array.isArray(fixture.categories) && fixture.categories.length === 14 && fixture.browseSample.items.length > 0,
    fixture ? 'categories=' + (fixture.categories || []).length + ' sample=' + ((fixture.browseSample || {}).items || []).length : '夹具文件不存在');
if (!fixture) { console.log(''); console.log('0 passed, ' + failed + ' failed（夹具缺失，后续判据无从执行）'); process.exit(1); }

const EXPECTED = fixture.categories;

console.log('');
console.log('Test 1: parseClawhubCategories 是纯函数，形状与顺序照实');
{
    let parsed = null;
    try { parsed = parseClawhubCategories({ categories: EXPECTED }); } catch (e) { parsed = { err: String((e && e.message) || e) }; }
    if (parsed && parsed.err) { skip('解析器可运行', parsed.err); }
    else {
        check('14 条全收且顺序=站点显示顺序',
            parsed.length === 14 && parsed.map((c) => c.slug).join(',') === EXPECTED.map((c) => c.slug).join(','),
            parsed.map((c) => c.slug).join(','));
        check('每条带 slug/label/description/icon 四件',
            parsed.every((c) => /^[a-z][a-z0-9-]*$/.test(c.slug) && typeof c.label === 'string' && c.label.length > 0
                && typeof c.description === 'string' && typeof c.icon === 'string'),
            JSON.stringify(parsed[0]));
        // 上游没有条数字段：解析器不许凭空造一个（造出来就是假陈述）。
        check('解析结果不含条数（上游没给就不许有）',
            parsed.every((c) => c.totalAll === undefined && c.count === undefined),
            JSON.stringify(Object.keys(parsed[0])));
        const dirty = parseClawhubCategories({
            categories: [
                { slug: 'research', label: 'Research', description: 'd', icon: 'i' },
                { slug: 'RESEARCH', label: '大写重复', description: '', icon: '' },
                { slug: 'research', label: '重复 slug', description: '', icon: '' },
                { slug: '', label: '空 slug', description: '', icon: '' },
                { slug: 'ok-2', label: '  ', description: '', icon: '' },
                { slug: 'has space', label: '非法 slug', description: '', icon: '' },
                null,
            ],
        });
        // 'ok-2' 是合法 slug（只是 label 空白），保留并把 label 回落成 slug；
        // 被丢掉的必须是大写重复、同 slug 重复、空 slug、含空格 slug、null 行。
        check('脏数据只留合法条目且去重', Array.isArray(dirty) && dirty.map((c) => c.slug).join(',') === 'research,ok-2', JSON.stringify(dirty));
        check('label 空白时回落成 slug（不编显示名）', dirty.length === 2 && dirty[1].label === 'ok-2', JSON.stringify(dirty[1]));
        check('非对象载荷回空数组而不是抛', (() => {
            for (const bad of [null, undefined, {}, { categories: null }, { categories: 'x' }]) {
                const r = parseClawhubCategories(bad);
                if (!Array.isArray(r) || r.length !== 0) return false;
            }
            return true;
        })(), '');
    }
}

console.log('');
console.log('Test 2: 抓取 + TTL 缓存（命中回同一引用，失败不落空快照）');
{
    const c = freshCache();
    let calls = 0;
    const getJson = async () => { calls += 1; return { categories: EXPECTED }; };
    const v1 = await clawhubCategoryVocabulary({ cache: c, getJson, now: () => 1000000 }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (v1 && v1.err) { skip('抓取段可运行', v1.err); }
    else {
        check('首次抓取写缓存并回 14 条', calls === 1 && v1.categories.length === 14, 'calls=' + calls + ' n=' + (v1.categories || []).length);
        check('快照带 capturedAt 与 source（面板据此判归属）',
            v1.capturedAt === 1000000 && /clawhub\.ai/.test(String(v1.source)), JSON.stringify({ capturedAt: v1.capturedAt, source: v1.source }));
        const v2 = await clawhubCategoryVocabulary({ cache: c, getJson, now: () => 1000000 + 3600 * 1000 });
        check('TTL 内命中同一引用且不重复请求', calls === 1 && v2 === v1, 'calls=' + calls + ' sameRef=' + (v2 === v1));
        const v3 = await clawhubCategoryVocabulary({ cache: c, getJson, now: () => 1000000 + 8 * 24 * 3600 * 1000 });
        check('TTL 过期后重取（新引用）', calls === 2 && v3 !== v1, 'calls=' + calls);
    }
    const c2 = freshCache();
    const boom = await clawhubCategoryVocabulary({ cache: c2, getJson: async () => { throw new Error('fetch failed'); }, now: () => 1 }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (boom && boom.err) skip('失败分支可运行', boom.err);
    else check('抓取失败回 null 且不抛', boom === null, JSON.stringify(boom));
    const c3 = freshCache();
    const empty = await clawhubCategoryVocabulary({ cache: c3, getJson: async () => ({ categories: [] }), now: () => 1 }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (empty && empty.err) skip('空词表分支可运行', empty.err);
    else {
        check('解析不出任何分类时返回 null', empty === null, JSON.stringify(empty));
        const cold = await readClawhubCategoryVocabulary({ cache: c3, now: () => 1 }).catch((e) => ({ err: String((e && e.message) || e) }));
        if (cold && cold.err) skip('空快照后读取可运行', cold.err);
        else check('空词表绝不落盘（冷读取仍 null，不是空集合）', cold === null, JSON.stringify(cold));
    }
}

console.log('');
console.log('Test 3: readClawhubCategoryVocabulary 只读缓存、绝不打网络');
{
    const c = freshCache();
    const seeded = await clawhubCategoryVocabulary({ cache: c, getJson: async () => ({ categories: EXPECTED }), now: () => 1000000 }).catch(() => null);
    let boom = 0;
    const cold = await readClawhubCategoryVocabulary({ cache: c, getJson: () => { boom += 1; throw new Error('不该打网络'); }, now: () => 1000000 + 60000 }).catch(() => ({ err: 'readClawhubCategoryVocabulary 未导出' }));
    if (cold && cold.err) { skip('读取段可运行', cold.err); } else {
        check('命中回同一份快照', cold === seeded && boom === 0, 'sameRef=' + (cold === seeded) + ' calls=' + boom);
        const expired = await readClawhubCategoryVocabulary({ cache: c, getJson: () => { boom += 1; throw new Error('不该打网络'); }, now: () => 1000000 + 8 * 24 * 3600 * 1000 });
        check('过期一律 null（读取侧不重取）', expired === null && boom === 0, JSON.stringify(expired) + ' calls=' + boom);
        const none = await readClawhubCategoryVocabulary({ cache: freshCache(), getJson: () => { boom += 1; throw new Error('不该打网络'); }, now: () => 1 });
        check('冷缓存 null 而不是空对象', none === null, JSON.stringify(none));
    }
}

console.log('');
console.log('Test 4: searchClawHub 把 category 发上游（browse 路径）');
{
    const mk = (slug) => ({ items: [0, 1, 2].map((k) => ({ slug: 's' + k, ownerHandle: 'o', displayName: 'D' + k, summary: '', categories: [slug], topics: [], stats: { downloads: 100 - k, installs: 1, stars: 1, versions: 1 }, latestVersion: '1.0.0', updatedAt: 1, createdAt: 1 })) });
    const urls = [];
    const fetchJson = async (u) => {
        urls.push(u);
        const cat = new URL(u).searchParams.get('category');
        if (cat === 'zzznotathing') { const e = new Error('HTTP 400'); e.status = 400; throw e; }
        return mk(cat || '');
    };
    // catch 只吞「缺导出」这一类；真实异常（如 X5 那种去掉重发兜底后的 400 外抛）
    // 必须让它炸成 FAIL，否则「被拒后重发一次」退化成「直接抛」时判据静默变 SKIP。
    // 永不外抛：缺导出 → SKIP；实现退化（去掉 400 兜底后真的抛出来）→ 一条带原文的
    // FAIL。上一版用 Promise.reject 让 await 直接炸掉套件，那是「崩溃当证据」——
    // 没有汇总行也拿不到判据原文，属无效红。
    const r = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: null, category: 'security', fetchJson }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (r && r.err) {
      if (/未导出|未取到函数体/.test(r.err)) skip('category 分支可运行', r.err);
      else check('browse 带 category 不得外抛（被拒要在内部兜住）', false, r.err.slice(0, 120));
    }
    else {
        check('browse 带 category 时上游 URL 真的含 category=security', urls.some((u) => /category=security/.test(u)), urls[0]);
        check('facet 生效时明说 serverFacet=true', r.serverFacet === true, 'serverFacet=' + JSON.stringify(r.serverFacet));
        check('facet 生效时不再谎称本地过滤（categoryNote 空）', !r.categoryNote, JSON.stringify(r.categoryNote));
        check('回的是上游筛过的条目', r.items.length === 3 && r.items.every((i) => i.category === 'security'), JSON.stringify(r.items.map((i) => i.category)));
    }
    const urls2 = [];
    const r2 = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: null, category: 'zzznotathing', fetchJson: async (u) => {
        urls2.push(u);
        const cat = new URL(u).searchParams.get('category');
        if (cat === 'zzznotathing') { const e = new Error('HTTP 400'); e.status = 400; throw e; }
        return mk('');
    } }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (r2 && r2.err) {
      if (/未导出|未取到函数体/.test(r2.err)) skip('400 兜底分支可运行', r2.err);
      // X5 那种「去掉重发兜底」的实现退化必须报成一条带原文的 FAIL，
      // 不能靠套件崩溃当证据（崩溃没有汇总行，拿不到判据原文）。
      else check('上游 400 必须被内部兜住而不是抛给调用方', false, r2.err.slice(0, 140));
    }
    else {
        check('上游 400 后去掉 category 重发一次', urls2.length === 2 && /category=zzznotathing/.test(urls2[0]) && !/category=/.test(urls2[1]), urls2.join(' | '));
        check('被拒时绝不谎称服务端筛过（serverFacet=false）', r2.serverFacet === false, 'serverFacet=' + JSON.stringify(r2.serverFacet));
        check('被拒时如实说明是哪个分类', /zzznotathing/.test(String(r2.hint || '')) && /400/.test(String(r2.hint || '')), JSON.stringify(String(r2.hint).slice(0, 90)));
    }
    const urls3 = [];
    const r3 = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: null, fetchJson: async (u) => { urls3.push(u); return mk(''); } });
    check('不带 category 时 URL 不夹带空 category 键', urls3.every((u) => !/category=/.test(u)), urls3[0]);
    check('不带 category 时 serverFacet=false', r3.serverFacet === false, JSON.stringify(r3.serverFacet));
    // 缓存键必须含 category：否则「换个分类浏览」会命中上一个分类的缓存条目，
    // 用户点 security 看到的是 research 的页。这条不是靠读代码里的 :${facet} 认定，
    // 而是真用同一个 cache 连打两个分类，看第二次是否真的重新打上游。
    const c = freshCache();
    const urlsC = [];
    const fetchC = async (u) => { urlsC.push(u); const cat = new URL(u).searchParams.get('category') || ''; return mk(cat); };
    const first = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: c, category: 'security', fetchJson: fetchC });
    const second = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: c, category: 'research', fetchJson: fetchC });
    check('换分类必须重新取数（缓存键含 category）', urlsC.length === 2 && second.items.every((i) => i.category === 'research') && first.items.every((i) => i.category === 'security'), 'calls=' + urlsC.length + ' second=' + JSON.stringify(second.items.map((i) => i.category)));
    const third = await esMod.searchClawHub({ query: '', page: 1, pageSize: 10, cache: c, category: 'security', fetchJson: fetchC });
    check('同分类同页仍走缓存（键稳定，不多打上游）', urlsC.length === 2 && third.items.every((i) => i.category === 'security'), 'calls=' + urlsC.length);
}

console.log('');
console.log('Test 5: 搜索路径也发 category，且无效 slug 不当成「该分类没有」');
{
    // 实测：search 端点对无效 slug 回 200 + 空 results（不是 400）。所以判「slug 不存在」
    // 只能靠词表，不能靠状态码；否则「这个分类里没匹配」与「上游根本没这个分类」不可区分。
    const urls = [];
    const r = await esMod.searchClawHub({ query: 'agent', page: 1, pageSize: 10, cache: null, category: 'security', fetchJson: async (u) => {
        urls.push(u);
        return { results: [{ slug: 'skill-vetter', ownerHandle: 'o', displayName: 'Skill Vetter', summary: '', categories: ['security'], stats: { downloads: 10 }, latestVersion: '1.0.0', updatedAt: 1, createdAt: 1 }] };
    } }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (r && r.err) skip('搜索路径 category 可运行', r.err);
    else {
        check('带 query 时 category 仍发上游（文档：works with default and exact search）', urls.some((u) => /category=security/.test(u) && /[?&]q=agent/.test(u)), urls[0]);
        check('搜索 facet 生效同样 serverFacet=true', r.serverFacet === true, JSON.stringify(r.serverFacet));
    }
    const c = freshCache();
    // 播种用真实时钟：searchClawHub 内部读缓存走默认 now=Date.now()，
    // 若这里冻结成 1，读取侧按 TTL 判过期（正确行为），校验分支根本不会被走到。
    const seed5 = await clawhubCategoryVocabulary({ cache: c, getJson: async () => ({ categories: EXPECTED }) }).catch(() => null);
    if (!seed5) skip('词表播种不可用（缺导出）', '后续两条判据无从执行');
    const urls2 = [];
    const r2 = await esMod.searchClawHub({ query: 'agent', page: 1, pageSize: 10, cache: c, category: 'nosuchcat', fetchJson: async (u) => { urls2.push(u); return { results: [] }; } }).catch((e) => ({ err: String((e && e.message) || e) }));
    if (r2 && r2.err) skip('词表校验分支可运行', r2.err);
    else {
        check('词表里没有的 slug 不发上游（免得把「slug 不存在」说成「该分类无匹配」）', urls2.every((u) => !/category=nosuchcat/.test(u)), urls2.join(' | '));
        check('词表判定的拒绝同样 serverFacet=false', r2.serverFacet === false, JSON.stringify(r2.serverFacet));
        check('拒绝原因白话点名该分类不存在（不出现「词表」这类工程词）', /没有「|不存在/.test(String(r2.hint || '')) && String(r2.hint || '').indexOf('词表') < 0, JSON.stringify(String(r2.hint).slice(0, 90)));
    }
}

console.log('');
console.log('Test 6: 聚合层把 clawhub 的服务端 facet 计入（AND 归约）');
{
    // 这条锁的是聚合层既有语义（0.5.148 立的 AND 归约）在 clawhub 参与时同样成立：
    // 全部参与源都说「筛过了」才敢说 serverFacet=true，一个没说就不许说。
    const r = await searchSkills({
        query: '', source: 'clawhub', page: 1, pageSize: 12, cache: null, category: 'research',
        handlers: {
            clawhub: async () => ({
                source: 'clawhub',
                items: [{ id: 'clawhub:1', slug: 'a', name: 'A', source: 'clawhub', category: 'research' }, { id: 'clawhub:2', slug: 'b', name: 'B', source: 'clawhub', category: 'research' }],
                total: 2, hasMore: false, totalPages: 1, serverFacet: true,
            }),
        },
        budgetMs: 5000,
    });
    check('唯一参与源说筛过 → 聚合 serverFacet=true', r.serverFacet === true, 'serverFacet=' + JSON.stringify(r.serverFacet) + ' n=' + r.items.length);
    check('serverFacet=true 时不做本地二次过滤（条目一条不丢）', r.items.length === 2 && !r.categoryNote && !r.filteredOut, 'n=' + r.items.length + ' filteredOut=' + r.filteredOut + ' note=' + JSON.stringify(r.categoryNote));
    const mixed = await searchSkills({
        query: '', source: 'all', page: 1, pageSize: 12, cache: null, category: 'research',
        handlers: {
            clawhub: async () => ({ source: 'clawhub', items: [{ id: 'c1', slug: 'c1', name: 'C1', source: 'clawhub', category: 'research' }], total: 1, hasMore: false, serverFacet: true }),
            lobehub: async () => ({ source: 'lobehub', items: [{ id: 'l1', slug: 'l1', name: 'L1', source: 'lobehub', category: 'knowledge' }], total: 1, hasMore: false }),
        },
        budgetMs: 5000,
    });
    check('有一个源没说筛过 → 聚合不得宣称服务端已筛', mixed.serverFacet === false, 'serverFacet=' + JSON.stringify(mixed.serverFacet) + ' n=' + mixed.items.length);
}

console.log('');
console.log('Test 7: 词表随 settings.get 下发（按源分组，不新增 op）');
{
    const ix = readLf('index.js');
    const a = once(ix, 'case "settings.get":', 'settings.get 起');
    const b = ix.indexOf('case "', a + 20);
    const sg = ix.slice(a, b < 0 ? ix.length : b);
    check('settings.get 读 clawhub 词表缓存（只读、不等网络）', /readClawhubCategoryVocabulary/.test(sg) && !/await clawhubCategoryVocabulary/.test(sg), sg.replace(/\s+/g, ' ').slice(0, 200));
    check('冷缓存时后台补取 clawhub 词表', /void clawhubCategoryVocabulary/.test(sg), sg.replace(/\s+/g, ' ').slice(0, 200));
    check('下发按源分组（面板据此只给对应市场显示对应词表）', /categoryVocabulary:/.test(sg) && /clawhub:/.test(sg) && /skillsmp:/.test(sg), sg.replace(/\s+/g, ' ').slice(0, 260));
    check('index.js 已导入 clawhub 词表两个符号（缺 import 就是 0.5.148 那类崩溃）',
        /import \{[^}]*readClawhubCategoryVocabulary[^}]*\} from "\.\/src\/extra-sources\.js"/.test(ix) && /import \{[^}]*clawhubCategoryVocabulary[^}]*\} from "\.\/src\/extra-sources\.js"/.test(ix),
        (ix.match(/import[^\n]*extra-sources\.js/) || ['(无 extra-sources import)'])[0].slice(0, 160));
    const es = readLf('src/extra-sources.js');
    check('extra-sources.js 真的导出三件', /export function parseClawhubCategories/.test(es) && /export async function clawhubCategoryVocabulary/.test(es) && /export async function readClawhubCategoryVocabulary/.test(es), '');
}

console.log('');
console.log('Test 8: 面板按源取词表（clawhub 词表不得串到别的市场）');
{
    const client = readLf('client.js');
    const lines = client.split(String.fromCharCode(10));
    const bodyOf = (needle) => {
        const at = lines.findIndex((l) => l.indexOf(needle) >= 0);
        if (at < 0) return null;
        for (let i = at + 1; i < lines.length; i++) if (lines[i] === '}') return lines.slice(at, i + 1).join(String.fromCharCode(10));
        return null;
    };
    const run = (args) => {
        const outer = bodyOf('function categoryChipsForSource(');
        if (outer === null) return { err: '未取到函数体 categoryChipsForSource' };
        const inner = bodyOf('function mergeCategoryVocab(');
        if (inner === null) return { err: '未取到函数体 mergeCategoryVocab' };
        try { return new Function(inner + String.fromCharCode(10) + outer + String.fromCharCode(10) + 'return categoryChipsForSource;')()(...args); }
        catch (e) { return { err: String((e && e.message) || e) }; }
    };
    const chVocab = { capturedAt: 1, source: 'https://clawhub.ai/api/v1/skills/-/categories', categories: EXPECTED.map((c) => ({ slug: c.slug, label: c.label })) };
    const smpVocab = { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: [{ slug: 'debugging', name: '调试工具', totalAll: 532411 }] };
    const bySource = { clawhub: chVocab, skillsmp: smpVocab };
    const got = run(['clawhub', ['page-derived-slug'], bySource]);
    if (got && got.err) skip('按源取词表可执行', got.err);
    else {
        // 0.5.155 契约：有词表时 chip 只来自词表（派生自由标签不得混入，见 skillsmp 套件同条）。
        check('clawhub 下拿到 clawhub 词表 14 条（不含派生）', got.length === 14 && got[0].value === 'integrations' && got[0].fixed === true, 'n=' + got.length + ' first=' + JSON.stringify(got[0]));
        check('clawhub 词表 chip 不带条数（上游没给条数就不许显示）', got.every((c) => !/\d{3,}/.test(String(c.label))), JSON.stringify(got.slice(0, 2).map((c) => c.label)));
        check('词表在手时不产出派生 chip', !got.some((c) => c.fixed === false), JSON.stringify(got.filter((c) => c.fixed === false).map((c) => c.value)));
    }
    const other = run(['browse.sh', ['page-derived-slug'], bySource]);
    // 词表「抓取失败」的真实形状有两层，两层都必须留下派生入口（否则上游改版就整排 chip 消失）：
    //   ①settings.get 冷缓存/过期/抓取失败 → 该源字段是 null（index.js 的 readXxxCategoryVocabulary 回 null）
    //   ②词表对象在但 categories 为空数组（解析不出任何分类，服务端按「不许落空快照」返回 null，这里注入防御）
    // 注入这两层，断言派生值照旧出现——这就是「抓取失败时分类入口仍在」的实证，不是注释承诺。
    const failNull = run(['clawhub', ['douyin', 'json'], { clawhub: null, skillsmp: smpVocab }]);
    check('词表抓取失败（该源字段为 null）时派生入口仍可用',
        Array.isArray(failNull) && failNull.length === 2 && failNull.every((c) => c.fixed === false),
        JSON.stringify(failNull && failNull.err ? failNull : failNull));
    const failEmpty = run(['clawhub', ['douyin'], { clawhub: { capturedAt: 1, source: 'https://clawhub.ai/api/v1/skills/-/categories', categories: [] } }]);
    check('词表解析为空（categories=[]）时派生入口仍可用',
        Array.isArray(failEmpty) && failEmpty.length === 1 && failEmpty[0].value === 'douyin' && failEmpty[0].fixed === false,
        JSON.stringify(failEmpty && failEmpty.err ? failEmpty : failEmpty));
    const failAbsent = run(['clawhub', ['douyin'], { skillsmp: smpVocab }]);
    check('该源在分组里缺键时派生入口仍可用',
        Array.isArray(failAbsent) && failAbsent.length === 1 && failAbsent[0].fixed === false,
        JSON.stringify(failAbsent && failAbsent.err ? failAbsent : failAbsent));
    // browse.sh 没有词表 ⇒ 派生 chip 仍保留（不关入口）。这条锁「无词表市场用派生」。
    check('browse.sh 无词表时派生 chip 保留', Array.isArray(other) && other.length === 1 && other[0].value === 'page-derived-slug', JSON.stringify(other && other.err ? other : other));
    const smp = run(['skillsmp', ['page-derived-slug'], bySource]);
    check('skillsmp 下仍是自己的词表（0.5.151 行为不回退，且不含派生）', Array.isArray(smp) && smp.length === 1 && smp[0].value === 'debugging' && smp[0].totalAll === 532411, JSON.stringify(smp && smp.err ? smp : smp));
    // Y3 盲区：把 legacy 判据写成「没有 skillsmp 键就算旧形状」时，
    // 「分组但某一路还没缓存」这种真实状态（冷 skillsmp、热 clawhub）会整排丢 chip。
    const partial = run(['clawhub', ['page-derived-slug'], { skillsmp: null, clawhub: chVocab }]);
    check('分组形状里另一路尚未缓存时仍取本市场词表', Array.isArray(partial) && partial.length === 14 && partial[0].value === 'integrations', JSON.stringify(partial && partial.err ? partial : { n: partial.length }));
    const partial2 = run(['clawhub', ['page-derived-slug'], { clawhub: chVocab }]);
    check('分组形状缺 skillsmp 键也不得当成旧形状', Array.isArray(partial2) && partial2.length === 14, JSON.stringify(partial2 && partial2.err ? partial2 : { n: partial2.length }));
    const crossed = run(['clawhub', ['page-derived-slug'], { clawhub: smpVocab, skillsmp: smpVocab }]);
    check('词表串味（clawhub 位上放 skillsmp 的词表）时按来源拒绝', Array.isArray(crossed) && crossed.length === 1, JSON.stringify(crossed && crossed.err ? crossed : crossed));
    const wire = lines.find((l) => l.includes('const vocabChips = categoryChipsForSource('));
    // 判据锁真实接线：第三参必须是那份按源的词表映射（state 变量名 categoryVocab），
    // 且该 state 来自 settings.get 的分组字段。写死单一词表或漏传 source 都会红。
    check('面板接线传的是按源词表映射', !!wire && /categoryChipsForSource\(source, categories, categoryVocab\)/.test(wire), (wire || '未取到接线行').trim().slice(0, 150));
    const assign = lines.find((l) => /setCategoryVocab\(d\.categoryVocabulary/.test(l));
    check('面板 state 取自 settings.get 的分组词表字段', !!assign, (assign || '未取到回填行').trim().slice(0, 130));
    const labelHit = got && !got.err ? got.find((c) => c.value === 'integrations') : null;
    check('clawhub chip 显示上游 label 而不是裸 slug（词表字段名是 label）', !!labelHit && labelHit.label === 'Integrations', JSON.stringify(labelHit));
}

console.log('');
console.log('Test 9: 带分类浏览不得为预取多付上游轮次（live 实测的超时根因）');
{
    // 2026-11-23 live 实测：category=security 时上游**每次只回 13 条**（limit=50/100/197
    // 都一样，文档：Bounded category reads may return a short or empty page with a
    // continuation），而旧 browse 路径沿用「攒到 size*(p+2) 条」的预取口径 —— 面板首页
    // 24 条要 72 条，13 条/次就是 7 次串行 cursor，实测 11402ms，正好撞满 12s 预算：
    // live RPC 回 degraded=[clawhub] + 「所选来源不提供分类信息，已忽略分类筛选」。
    // 也就是说分类入口在 clawhub 上会因为自己的预取策略而整源超时。
    // 判据不数文案，数上游轮次：注入 13 条/页的短页，page=1 必须只取够本页的量。
    let pageSeq = 0;
    // 每页行必须互不相同（真实 cursor 分页给的是新条目）。上一版注入让每页都是同一批
    // slug，撞进 extendClawHubCatalog 的死循环（见 Test 10），那次「挂住」是真缺陷被
    // 意外暴露，不是注入的本意 —— 这里把注入修正成真实形状，让 Test 9 只测预取轮次。
    const mkShort = (slug, n) => { pageSeq += 1; return { items: Array.from({ length: n }, (_, k) => ({ slug: 'p' + pageSeq + '-' + k, ownerHandle: 'o', displayName: 'X' + k, summary: '', categories: [slug], topics: [], stats: { downloads: 500 - k, installs: 1, stars: 1, versions: 1 }, latestVersion: '1.0.0', updatedAt: 1, createdAt: 1 })), nextCursor: 'c' + pageSeq }; };
    let calls = 0;
    const r = await esMod.searchClawHub({ query: '', page: 1, pageSize: 24, cache: null, category: 'security', fetchJson: async (u) => { calls += 1; return mkShort('security', 13); } });
    check('首页只取够本页的上游轮次（13 条/页 ⇒ 2 次，不再 7 次预取）', calls <= 3, 'calls=' + calls);
    check('短页预取下首页仍给满 24 条', r.items.length === 24, 'items=' + r.items.length);
    check('分类页仍声明服务端已筛（serverFacet=true）', r.serverFacet === true, JSON.stringify(r.serverFacet));
    check('未翻完游标时总数留未知（不拿已攒条数冒充）', r.total === undefined && r.hasMore === true, 'total=' + JSON.stringify(r.total) + ' hasMore=' + JSON.stringify(r.hasMore));
    // 无分类的浏览路径保持既有预取口径（那里 limit=50 每次回满页，预取便宜）
    let calls2 = 0;
    const r2 = await esMod.searchClawHub({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async (u) => { calls2 += 1; return mkShort('', 50); } });
    check('无分类浏览仍按预取口径攒目录（满页时多攒几页不亏）', calls2 >= 1 && r2.items.length === 24, 'calls=' + calls2 + ' items=' + r2.items.length);
}

console.log('');
console.log('Test 10: 目录累积必须有轮次上界（重复行 + 新 cursor 不得无限循环）');
{
    // 2026-11-23 意外暴露：extendClawHubCatalog 里有 let guard = 0; guard += 1; 却
    // 从不检查 guard —— 上游只要「每页返回同一批条目 + 每页换一个 nextCursor」，
    // state.rows.length 就永远追不上 need，循环不结束。生产里表现为整源挂到 12s 预算
    // 被切断（degraded=[clawhub]），也就是「clawhub 不可达」的另一种成因。
    // 判据：注入这种病态上游，调用次数必须有界且函数必须返回。
    // 注入用「每页同一批条目 + 每页换新 cursor」的病态上游，并在第 200 次主动抛错。
    // 不用 Promise.race + 定时器：那个循环只 await 已完成的 promise（微任务），
    // 定时器是宏任务会被饿死 —— 上一版就是这么把套件挂到超时的（真缺陷，但红得无效）。
    let calls3 = 0;
    const dup = () => {
      calls3 += 1;
      if (calls3 > 200) throw new Error('INJECTED_STUCK_UPSTREAM');
      return { items: [0, 1, 2].map((k) => ({ slug: 'same-' + k, ownerHandle: 'o', displayName: 'S' + k, summary: '', categories: ['security'], topics: [], stats: { downloads: 10, installs: 1, stars: 1, versions: 1 }, latestVersion: '1.0.0', updatedAt: 1, createdAt: 1 })), nextCursor: 'cursor-' + calls3 };
    };
    const done = await esMod.searchClawHub({ query: '', page: 1, pageSize: 24, cache: null, category: 'security', fetchJson: async () => dup() })
      .then(() => 'returned').catch((e) => 'threw:' + String((e && e.message) || e).slice(0, 60));
    check('病态上游下必须自行收敛（不靠外层预算切断）', done === 'returned', done + ' calls=' + calls3);
    check('累积轮次有上界（不是无限串行 cursor）', calls3 > 0 && calls3 <= 60, 'calls=' + calls3);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
