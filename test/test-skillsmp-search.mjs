#!/usr/bin/env node
// test-skillsmp-search.mjs — TDD: skillsmp 搜索参数名 + 「窗口上限被当成目录总数」两处口径缺陷。
//
// 两处都以实测上游坐实（2026-11-22，直接打 /api/skills）：
//
// ① 旧实现发的是 `q=`（extra-sources.js:652）。实测 q=、keyword=、query= 全部被忽略，
//    filters 只回显 {"search":"","sortBy":"stars"}；唯一生效的键是 `search=`。
//    后果：带关键词的搜索返回的是全目录首页，用户以为搜过了。
// ② 旧实现的 `total` 直接抄 `pagination.total`（:684）。实测：
//      browse        → {"total":1200,"totalIsExact":false,"isCapped":true,"maxResults":1200}
//      search=pdf    → total 恒为 page*limit+1（24→25、48→49、p2→49、l40→41），totalIsExact:false
//      search 翻完   → totalIsExact:true（这才是真正的完整集合大小）
//    1200 是 API 自报的窗口上限，站点首页写的是 4,248,026 个 SKILL.md。把窗口当目录，
//    等于把「共约 1200 个」显示给用户；把 page*limit+1 当总数，等于总数随翻页线性增长。
// 判据只看上游字段（isCapped / maxResults / totalIsExact），不比较 1200 这种魔法数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSkills, makeCache } from '../src/sources.js';
import { searchSkillsMp } from '../src/extra-sources.js';
import { safeTempDir } from '../src/home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 200) : '')); } };

// 真实响应形状：由上游实测样本（data.skills 两行）派生，只改 filters/pagination。
const rawRow = (i) => ({
  id: 'sk-' + i,
  name: 'pdf-tool-' + i,
  description: 'handles pdf',
  author: 'octo',
  githubUrl: 'https://github.com/octo/repo-' + i + '/tree/main/skills/pdf-tool-' + i,
  branch: 'main',
  route: { sourceSkillPath: 'skills/pdf-tool-' + i + '/SKILL.md' },
  stars: 7,
});
const mkData = (n, filters, pagination) => ({ skills: Array.from({ length: n }, (u, i) => rawRow(i)), filters: filters || { search: '', sortBy: 'stars' }, pagination });

const cache = makeCache(safeTempDir());

// RED 阶段（旧实现没有 fetchJson 形参）urls 会是空的：断言必须 FAIL，不能崩在 new URL。
const paramsOf = (u) => (u ? new URL(u) : { searchParams: new URLSearchParams([]) }).searchParams;

console.log('');
console.log('Test 1: 请求带上游真正生效的 search= 参数');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(2, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 25, totalIsExact: false, hasNext: true }); };
  await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson });
  check('请求经由注入的 fetchJson 发出（seam 生效）', urls.length === 1, JSON.stringify(urls));
  const q = paramsOf(urls[0]);
  console.log('   实测 URL: ' + String(urls[0]));
  check('带上 search=pdf', q.get('search') === 'pdf', urls[0]);
  check('不再带被上游忽略的 q=', q.get('q') === null && q.get('keyword') === null && q.get('query') === null, urls[0]);
  const u2 = { searchParams: paramsOf(urls[0]) };
  check('带上 page 与 limit', u2.searchParams.get('page') === '1' && u2.searchParams.get('limit') === '24', urls[0]);
}

console.log('');
console.log('Test 2: 无关键词（browse）时不发 search=');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 }); };
  await searchSkillsMp({ query: '   ', page: 1, pageSize: 24, cache: null, fetchJson });
  const sp = paramsOf(urls[0]);
  check('browse 请求根本不带 search 键（空值也算污染回显）', sp.get('search') === null, urls[0]);
  check('browse 仍带上 page/limit', sp.get('page') === '1' && sp.get('limit') === '24', urls[0]);
}

console.log('');
console.log('Test 3: isCapped/maxResults 的窗口上限不得当成目录总数');
{
  const fetchJson = async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, hasPrev: false, totalIsExact: false, isCapped: true, maxResults: 1200 });
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测(browse 窗口): total=' + String(r.total) + ' hasMore=' + String(r.hasMore) + ' hint=' + String(r.hint));
  check('browse 不报 1200 这种窗口总数', r.total === undefined, String(r.total));
  check('browse 不给由窗口推算的 totalPages', r.totalPages === undefined, String(r.totalPages));
  // 用户 2026-11-23 点名这句说明已失效、不要再显示：数字本身（maxResults=1200
  // 实测仍在）不是问题，问题是它给的出路只有一条「换关键词继续找」，而面板现在
  // 有 63 个分类 chip（各自带上游 totalAll 真实条数）可走。去掉说明不等于放弃口径：
  // 总数与总页数必须继续留未知——不许因为「不再解释」就顺手把窗口当总数报出来。
  check('browse 窗口态不再显示那条过时说明', r.hint === undefined || r.hint === '', String(r.hint));
  check('去掉说明后总数仍不得冒充目录规模', r.total === undefined && r.totalPages === undefined, String(r.total) + '/' + String(r.totalPages));
  check('hasMore 沿用上游 hasNext=true', r.hasMore === true, String(r.hasMore));
  // 没有 isCapped 但 totalIsExact:false：同样是「不精确」，一样不许报数
  const r2 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 25, hasNext: true, totalIsExact: false }) });
  console.log('   实测(search 未翻完): total=' + String(r2.total) + ' hint=' + String(r2.hint));
  check('totalIsExact:false 时 total 保持未知', r2.total === undefined, String(r2.total));
  check('totalIsExact:false 时仍给出「总数未知」说明', typeof r2.hint === 'string' && r2.hint.length > 0, String(r2.hint));
  // 真实上游 2026-11-22 实测：search 未翻完只回 totalIsExact:false（没有 isCapped/maxResults），
  // 那个 total 是 page*limit+1 的每页移动值，绝不许写进说明里冒充窗口。
  check('未翻完 search 的说明不得引用会移动的 total 数字', !/\d/.test(String(r2.hint)), String(r2.hint));
  check('上游没回 isCapped 时说明不得谎称 isCapped', !/isCapped/i.test(String(r2.hint)), String(r2.hint));
  // 上游自报 hasNext:false（实测 search 深页形状：窗口未翻完但确实没有下一页）：不许再承诺下一页
  const r3 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 1000, hasNext: false, totalIsExact: false }) });
  console.log('   实测(窗口未翻完 + hasNext=false): total=' + String(r3.total) + ' hasMore=' + String(r3.hasMore));
  check('hasNext=false 时 hasMore 必须是 false（不承诺空页）', r3.hasMore === false, String(r3.hasMore));
  // hasNext 缺失：unknown 就留 unknown，不拿「本页装满」去猜
  const r4 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 1000, totalIsExact: false }) });
  check('hasNext 缺失时 hasMore 保持未知', r4.hasMore === undefined, String(r4.hasMore));
  // 窗口数字必须来自上游字段：换一种 maxResults，说明里的数字要跟着变
  const r5 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 4242, totalPages: 6, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 777 }) });
  console.log('   实测(maxResults=777): hint=' + String(r5.hint));
  // 窗口态整条说明已撤，所以这里改锁「换 maxResults 也不会冒出数字」：
  // 撤掉一条说明不许顺手留下别的数字来源。
  check('maxResults=777 时同样不显示窗口说明', (r5.hint === undefined || r5.hint === '') && !/777/.test(String(r5.hint)), String(r5.hint));
  // isCapped 只声明「有窗口」，没声明窗口多大：没有 maxResults 就不许从 total 倒推出数字。
  const r6 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true }) });
  check('只有 isCapped 没有 maxResults 时说明不得凭 total 编数字', !/\d/.test(String(r6.hint)), String(r6.hint));
  // maxResults 存在但退化（0）：同样不许回头引用会移动的 total。
  const r7 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 0 }) });
  check('maxResults 退化时不得回头引用 total', !/1200/.test(String(r7.hint)), String(r7.hint));
}

console.log('');
console.log('Test 4: 搜索翻完后上游报的精确总数必须照实上报');
{
  const fetchJson = async () => mkData(0, { search: 'zzzzxqqq', sortBy: 'stars' }, { page: 1, limit: 24, total: 0, totalPages: 1, hasNext: false, hasPrev: false, totalIsExact: true });
  const r = await searchSkillsMp({ query: 'zzzzxqqq', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测(翻完): total=' + String(r.total) + ' hasMore=' + String(r.hasMore));
  check('totalIsExact:true 时 total 就是上游的 0', r.total === 0, String(r.total));
  check('hasMore 取上游 hasNext=false', r.hasMore === false, String(r.hasMore));
  const r5 = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(5, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 5, totalPages: 1, hasNext: false, totalIsExact: true }) });
  check('totalIsExact:true 的 5 条结果照实上报', r5.total === 5 && r5.hasMore === false, String(r5.total) + '/' + String(r5.hasMore));
}

console.log('');
console.log('Test 5: 聚合层不得再冒出窗口数字');
{
  const handlers = {
    skillsmp: () => searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 }) }),
  };
  const r = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: 24, cache: makeCache(safeTempDir()), handlers, budgetMs: 5000 });
  console.log('   实测聚合: total=' + String(r.total) + ' totalPages=' + String(r.totalPages) + ' hints=' + JSON.stringify(r.hints));
  check('单源 skillsmp 的 browse 不报总数', r.total === undefined, String(r.total));
  check('单源 skillsmp 的 browse 不报总页数', r.totalPages === undefined, String(r.totalPages));
  // 展示层收口：browse 不再有那条说明 ⇒ 聚合 hints 里不得再出现它（也不得冒出 1200）。
  check('聚合 hints 不再携带那条窗口说明', Array.isArray(r.hints) && r.hints.length === 0 && !JSON.stringify(r.hints).includes('1200'), JSON.stringify(r.hints));
}

console.log('');
console.log('Test 6: 发出的 limit 必须落在上游接受范围内');
{
  const urls = [];
  const fetchJson = async (u) => { urls.push(u); return mkData(1, { search: '', sortBy: 'stars' }, { page: 1, limit: 1, total: 0, totalIsExact: true, hasNext: false }); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 50, cache: null, fetchJson });
  const lim = Number(paramsOf(urls[0]).get('limit'));
  console.log('   实测 pageSize=50 → limit=' + lim + '（上游 49/50 回 HTTP 400：Invalid limit; expected one integer between 1 and 48）');
  check('limit 不越过上游接受上限 48', lim <= 48, String(lim));
  check('pageSize 被完整用上（clamp 到 48 而不是缩到 10）', lim === 48, String(lim));
  const urls2 = [];
  await searchSkillsMp({ query: '', page: 0, pageSize: 0, cache: null, fetchJson: async (u) => { urls2.push(u); return mkData(1, undefined, undefined); } });
  const sp2 = paramsOf(urls2[0]);
  check('page 至少为 1（page=0 上游回 400）', Number(sp2.get('page')) >= 1, sp2.get('page'));
  check('limit 至少为 1（limit=0 上游回 400）', Number(sp2.get('limit')) >= 1, sp2.get('limit'));
}

console.log('');
console.log('Test 7: 上游整体缺 pagination 时仍不得造总数');
{
  const urls = [];
  const r = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async (u) => { urls.push(u); return { skills: [rawRow(1)] }; } });
  check('缺 pagination 时 total 保持未知', r.total === undefined, String(r.total));
  check('缺 pagination 时仍给出说明', typeof r.hint === 'string' && r.hint.length > 0, String(r.hint));
  check('缺 pagination 时 hasMore 以本页是否装满判断', r.hasMore === false, String(r.hasMore));
}

console.log('');
console.log('Test 8: 命中集合必须是上游过滤后的行（条数与上游一致）');
{
  const fetchJson = async (u) => {
    const sp = new URL(u).searchParams;
    const s = sp.get('search') || '';
    const all = Array.from({ length: 40 }, (x, i) => rawRow(i));
    const rows = s ? all.slice(0, 5) : all;
    return mkData(rows.length, { search: s, sortBy: 'stars' }, { page: 1, limit: 24, total: rows.length, totalPages: 1, hasNext: false, totalIsExact: true });
  };
  const hit = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson });
  const browse = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson });
  console.log('   实测: search=pdf → ' + hit.items.length + ' 条 total=' + String(hit.total) + '；browse → ' + browse.items.length + ' 条 total=' + String(browse.total));
  check('search=pdf 的条数等于上游过滤集大小', hit.items.length === 5 && hit.total === 5, hit.items.length + '/' + String(hit.total));
  check('browse 的条数等于上游全集大小', browse.items.length === 24 && browse.total === 40, browse.items.length + '/' + String(browse.total));
  check('上报计数与实际集合一致（不是窗口值）', browse.total === 40, String(browse.total));
}

console.log('');
console.log('Test 9: 守卫自证 —— 静态源码不得再出现被忽略的 q= 参数或 p*size 造数');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('searchSkillsMp 区域内不再用 URLSearchParams({ q, ... }) 形式', !/new URLSearchParams\(\s*\{\s*q[,:]/.test(body), body.slice(body.indexOf('new URLSearchParams'), body.indexOf('new URLSearchParams') + 90));
  check('searchSkillsMp 区域内不再以 p * size 造总数', !/p\s*\*\s*size\s*\+/.test(body), '');
  check('请求参数键只有 page/limit/search', /params\.set\("search", q\)/.test(body) && !/params\.set\("(q|keyword|query)"/.test(body), '');
  check('limit 上限取自实测接受值（SKILLSMP_MAX_LIMIT）', /Math\.min\(SKILLSMP_MAX_LIMIT/.test(body), '');
  // 边界值必须有上游原文支撑（用户 2026-11-22 点名：48 落在 40 与 50 之间的未知区）：
  // 交错重放 4 轮实测 48 → HTTP 200 n=48，49/50 → HTTP 400 且错误体自己写「between 1 and 48」。
  check('SKILLSMP_MAX_LIMIT 等于上游自报的边界 48', /const SKILLSMP_MAX_LIMIT = 48;/.test(src), '边界与上游原文不符');
  check('边界取证写明上游原文与重放轮次', /Invalid limit; expected one integer between 1 and 48/.test(src) && /交错重放 4 轮/.test(src), '注释里没有可复核的上游证据');
}

console.log('');
console.log('Test 10: cache.get 只经 cache 对象调用（不得残留 makeCache(...) 直调）');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('区域内不含 makeCache(', !body.includes('makeCache('), '');
  check('区域内 cache.get 走的是 cache 对象', /cache\.get\(key, SKILLSMP_TTL\)/.test(body), '');
}

console.log('');
console.log('Test 11: 分类 facet 只在纯浏览态透传上游，并回填到卡片');
{
  const urls = [];
  const mkFacet = () => mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 480, totalPages: 10, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 });
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async (u) => { urls.push(u); return mkFacet(); } });
  const sp = paramsOf(urls[0]);
  console.log('   实测 URL: ' + String(urls[0]));
  check('纯浏览态把 category 发给上游', sp.get('category') === 'debugging', String(urls[0]));
  check('facet 回填到卡片 category（行上无分类字段时）', r.items.length > 0 && r.items.every((it) => it.category === 'debugging'), JSON.stringify(r.items.map((it) => it.category)));
  const urls2 = [];
  await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async (u) => { urls2.push(u); return mkData(2, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 7, hasNext: true, totalIsExact: false }); } });
  check('带关键词时绝不发 facet（实测被忽略且静默换集合）', paramsOf(urls2[0]).get('category') === null, String(urls2[0]));
  // 一次性缓存目录：safeTempDir() 是共享目录，磁盘缓存活过 10 分钟 TTL 会让本场景跨轮次互相污染。
  const c2 = makeCache(safeTempDir() + '/skillsmp-facet-' + Date.now());
  const n3 = [];
  const fj3 = async (u) => { n3.push(u); return mkFacet(); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c2, fetchJson: fj3 });
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'cli-tools', cache: c2, fetchJson: fj3 });
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c2, fetchJson: fj3 });
  check('缓存键含 facet（不同分类不得串同一页）', n3.length === 2, JSON.stringify(n3));
  check('同一分类重复浏览才走缓存', n3[0] !== n3[1] && /category=debugging/.test(n3[0]), JSON.stringify(n3));
  let threw = '';
  let rr = null;
  const n4 = [];
  try {
    rr = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'tools', cache: null, fetchJson: async (u) => {
      n4.push(u);
      if (new URL(u).searchParams.get('category')) throw new Error('python 取数失败：Traceback ... urllib.error.HTTPError: HTTP Error 400: Bad Request');
      return mkData(2, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 1200, totalPages: 50, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 1200 });
    } });
  } catch (e) { threw = String((e && e.message) || e); }
  check('facet 被上游 400 拒绝时整源不崩', threw === '' && rr !== null, threw);
  check('被拒后去 facet 重发一次（不是放弃这一页）', n4.length === 2 && !new URL(n4[1]).searchParams.get('category'), JSON.stringify(n4));
  check('被拒时 hint 如实说不接受该分类', !!rr && typeof rr.hint === 'string' && /分类/.test(rr.hint), rr && String(rr.hint));
  check('被拒时不得把该分类回填到卡片', !!rr && rr.items.every((it) => !it.category), JSON.stringify(rr && rr.items.map((it) => it.category)));
}

console.log('');
console.log('Test 12: facet 态的 480 是窗口深度、totalAll 才是目录条数');
{
  // 样本自洽：limit=24 时上游给的 totalPages 就是 480/24=20（实测 limit=48 → 10）。
  const shape = (extra) => Object.assign({ page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 }, extra || {});
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, shape()) });
  console.log('   实测(facet 首页): total=' + String(r.total) + ' totalPages=' + String(r.totalPages) + ' hasMore=' + String(r.hasMore) + ' hint=' + String(r.hint));
  check('facet 态总数报 totalAll（不是窗口 480）', r.total === 532411, String(r.total));
  check('总页数只能是窗口页深 480/24=20（不得用 totalAll 反推）', r.totalPages === 20, String(r.totalPages));
  check('hint 同时给出目录条数与可翻页深度', /532411/.test(String(r.hint)) && /480/.test(String(r.hint)), String(r.hint));
  const rEnd = await searchSkillsMp({ query: '', page: 10, pageSize: 48, category: 'debugging', cache: null, fetchJson: async () => mkData(48, { search: '', sortBy: 'stars' }, shape({ page: 10, limit: 48, hasNext: false })) });
  check('窗口末页 hasNext=false → hasMore 必须 false', rEnd.hasMore === false, String(rEnd.hasMore));
  check('末页仍报 totalAll', rEnd.total === 532411, String(rEnd.total));
  const rNoAll = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'tools', cache: null, fetchJson: async () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: false, isCapped: true, maxResults: 480 }) });
  check('没有 totalAll 时绝不报数字总数', rNoAll.total === undefined, String(rNoAll.total));
  const rPlain = await searchSkillsMp({ query: 'pdf', page: 1, pageSize: 24, cache: null, fetchJson: async () => mkData(5, { search: 'pdf', sortBy: 'stars' }, { page: 1, limit: 24, total: 5, totalPages: 1, hasNext: false, totalIsExact: true }) });
  check('普通翻完的精确态不回退（total 照报 5）', rPlain.total === 5 && rPlain.hasMore === false, String(rPlain.total) + '/' + String(rPlain.hasMore));
}

console.log('');
console.log('Test 13: stars 不再写死为 0，口径注释必须改对');
{
  const rows = [Object.assign(rawRow(0), { stars: 469982 }), Object.assign(rawRow(1), { stars: 1602 })];
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, cache: null, fetchJson: async () => ({ skills: rows, filters: { search: '', sortBy: 'stars' }, pagination: { page: 1, limit: 24, total: 2, totalIsExact: true, hasNext: false } }) });
  check('stars 取上游真实值', r.items[0].stars === 469982 && r.items[1].stars === 1602, JSON.stringify(r.items.map((i) => i.stars)));
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('export async function searchSkillsMp');
  const e = src.indexOf('// ---------------------------------------------------------------- ModelScope', s);
  const body = src.slice(s, e);
  check('skillsmp 区域内不再有 stars: 0', !/stars: 0/.test(body), '');
  check('skillsmp 区域内不再称 stars 是 placeholder', !/placeholder/i.test(body), '');
}

console.log('');
console.log('Test 14: 排序键映射到上游生效的 sortBy，且不再本页重排');
{
  const unordered = [Object.assign(rawRow(0), { stars: 10, updatedAt: 5 }), Object.assign(rawRow(1), { stars: 900, updatedAt: 9 }), Object.assign(rawRow(2), { stars: 50, updatedAt: 7 })];
  const mk = () => ({ skills: unordered.slice(), filters: { search: '', sortBy: 'stars' }, pagination: { page: 1, limit: 24, total: 3, totalIsExact: true, hasNext: false } });
  const urls = [];
  const rStars = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'stars', cache: null, fetchJson: async (u) => { urls.push(u); return mk(); } });
  check('sort=stars 发 sortBy=stars', paramsOf(urls[0]).get('sortBy') === 'stars', String(urls[0]));
  check('stars 由服务端排，本页不得重排', rStars.items.map((i) => i.stars).join(',') === '10,900,50', rStars.items.map((i) => i.stars).join(','));
  const urls2 = [];
  const rUpd = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'updated', cache: null, fetchJson: async (u) => { urls2.push(u); return mk(); } });
  check('sort=updated 映射到上游唯一生效的 sortBy=recent', paramsOf(urls2[0]).get('sortBy') === 'recent', String(urls2[0]));
  check('updated 也不得本页重排（条目顺序即上游序）', rUpd.items.map((i) => i.name).join(',') === 'pdf-tool-0,pdf-tool-1,pdf-tool-2', rUpd.items.map((i) => i.name).join(','));
  const urls3 = [];
  const rName = await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'name', cache: null, fetchJson: async (u) => { urls3.push(u); return mk(); } });
  check('sort=name 不发 sortBy（上游无 name 排序）', paramsOf(urls3[0]).get('sortBy') === null, String(urls3[0]));
  check('sort=name 仍本地升序', rName.items[0].name <= rName.items[2].name, JSON.stringify(rName.items.map((i) => i.name)));
  const urls4 = [];
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, sort: 'installCount', cache: null, fetchJson: async (u) => { urls4.push(u); return mk(); } });
  check('installCount 绝不伪造 sortBy', paramsOf(urls4[0]).get('sortBy') === null, String(urls4[0]));
}

console.log('');
console.log('Test 15: 取证注释必须把 facet 窗口与白名单写成可复核的事实');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'extra-sources.js'), 'utf8');
  const s = src.indexOf('// ---------------------------------------------------------------- skillsmp');
  const e = src.indexOf('export async function searchSkillsMp', s);
  const notes = src.slice(s, e);
  check('注释写明 480 是窗口深度不是条数', /480/.test(notes) && /窗口/.test(notes) && /不是/.test(notes), '');
  check('注释引用上游自报 totalAll 实测值', /totalAll/.test(notes) && /532411/.test(notes), notes.slice(0, 200));
  check('注释写明白名单是真子集（63 接受 / 11 拒绝）', /63/.test(notes) && /11/.test(notes) && /(INVALID_CATEGORY|400)/.test(notes), '');
}
// ---------------------------------------------------------------- 0.5.188 游标链（用户 m40394）
// 取证（探针 20/22/23/24/25b/26/27 轮，日志 sk20.log…sk27.log）：
//   /api/skills?category=<slug>&limit=48&cursor=start  ⇒ pagination 回
//     {total:545886,totalAll:545886,totalIsExact:true,isCapped:false,cursorPagination:true,
//      totalPages:11373,hasNext:true,nextCursor:"b1.eyJ2…"}
//   —— 页码态那个 480（facet）/1200（browse）是 maxResults 自报的**浏览窗口**，不是目录上限。
//   链走 30 步 ⇒ 720 行零重复，且第 21 步起就跨过旧窗口尽头（旧通路永远取不到那些行）。
//   游标解出来是 keyset（after:{id,rank}+snapshot），尾带 32 字节签名：改一个字节就被拒
//   （实测 rank 改写/去尾/翻字节三种都 Traceback）⇒ 只能原样重放、顺序往后走，不能跳页。
//   limit 在游标态仍是 48 上限（60/96/100 一律被拒）；page 与 cursor 不可同带。
//   每轮 limit=48 平均 1.95s（10 轮实测 19,496ms）⇒ 545,886 条串行约 6.2 小时，只能随翻随取。
const mkCursorPage = (n, off, next, extra) => ({
  skills: Array.from({ length: n }, (u, i) => rawRow(off + i)),
  filters: { search: '', sortBy: 'stars' },
  pagination: Object.assign({
    page: 1, limit: 48, total: 545886, totalAll: 545886, totalIsExact: true,
    hasNext: true, hasPrev: false, isCapped: false, cursorPagination: true, nextCursor: next,
  }, extra || {}),
});

console.log('');
console.log('Test 16: facet 态带 cache 时起链 cursor=start，480 窗口口径退场');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-cur-' + Date.now());
  const r = await searchSkillsMp({
    query: '', page: 1, pageSize: 24, category: 'debugging', cache: c,
    fetchJson: async (u) => { urls.push(u); return mkCursorPage(48, 0, 'C2'); },
  });
  const sp = paramsOf(urls[0]);
  console.log('   实测 URL: ' + String(urls[0]) + ' | total=' + String(r.total) + ' pages=' + String(r.totalPages) + ' hint=' + String(r.hint));
  check('起链带 cursor=start', sp.get('cursor') === 'start', String(urls[0]));
  check('起链不带 page（实测 page+cursor 同带被上游拒）', sp.get('page') === null, String(urls[0]));
  check('facet 仍作为服务端参数发出', sp.get('category') === 'debugging', String(urls[0]));
  check('limit 落在上游接受上限 48', Number(sp.get('limit')) === 48, String(sp.get('limit')));
  check('游标态总数报上游 totalAll', r.total === 545886, String(r.total));
  check('游标态不再报窗口页深（旧 480/24=20 退场）', r.totalPages === undefined, String(r.totalPages));
  check('游标态 windowed=false（480 不再是上限）', r.windowed === false, String(r.windowed));
  check('游标态 hasMore=true（后面还能取）', r.hasMore === true, String(r.hasMore));
  check('游标态声明自己是渐进目录', r.catalogProgressive === true, String(r.catalogProgressive));
  check('hint 不再写「没有翻页入口 / 只让浏览前」', typeof r.hint === 'string' && r.hint.length > 0 && !/没有翻页入口|只让浏览前/.test(r.hint), String(r.hint));
  check('hint 报出目录条数（与 chip 同源）', /545886/.test(String(r.hint)), String(r.hint));
  check('本页条数仍受 pageSize 约束', r.items.length === 24, String(r.items.length));
  check('卡片回填 facet', r.items.every((it) => it.category === 'debugging'), JSON.stringify(r.items.slice(0, 2).map((it) => it.category)));
  check('serverFacet=true（上游确实按分类筛过）', r.serverFacet === true, String(r.serverFacet));
  check('只发一次请求（need=24 首页一就够）', urls.length === 1, JSON.stringify(urls));
}

console.log('');
console.log('Test 17: 翻页顺着上一轮 nextCursor 往后走，不重复也不跳页');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-chain-' + Date.now());
  const fetchJson = async (u) => {
    urls.push(u);
    const sp = new URL(u).searchParams;
    const cur = String(sp.get('cursor'));
    const idx = cur === 'start' ? 0 : Number(cur.replace(/^C/, ''));
    return mkCursorPage(48, idx * 48, 'C' + (idx + 1));
  };
  const p2 = await searchSkillsMp({ query: '', page: 2, pageSize: 24, category: 'debugging', cache: c, fetchJson });
  check('第 2 页起链仍走 cursor=start（本地目录还空）', paramsOf(urls[0]).get('cursor') === 'start' && urls.length === 1, JSON.stringify(urls));
  check('第 2 页给的是第 25–48 行', p2.items.length === 24 && p2.items[0].slug === 'pdf-tool-24' && p2.items[23].slug === 'pdf-tool-47', JSON.stringify(p2.items.map((i) => i.slug).slice(0, 2)));
  const p3 = await searchSkillsMp({ query: '', page: 3, pageSize: 24, category: 'debugging', cache: c, fetchJson });
  check('第 3 页带的是上一轮 nextCursor（不是 cursor=start）', paramsOf(urls[1]).get('cursor') === 'C1', String(urls[1]));
  check('第 3 页请求不带 page', paramsOf(urls[1]).get('page') === null, String(urls[1]));
  check('第 3 页给的是第 49–72 行', p3.items[0].slug === 'pdf-tool-48' && p3.items[23].slug === 'pdf-tool-71', JSON.stringify(p3.items.map((i) => i.slug).slice(0, 2)));
  const ids = p2.items.concat(p3.items).map((i) => i.id);
  check('跨页零重复', new Set(ids).size === ids.length, ids.length + '/' + new Set(ids).size);
  const p3again = await searchSkillsMp({ query: '', page: 3, pageSize: 24, category: 'debugging', cache: c, fetchJson });
  check('同一页重复取不再打网络（走页缓存）', urls.length === 2, JSON.stringify(urls));
  check('重复取内容一致', p3again.items[0].slug === 'pdf-tool-48', p3again.items[0].slug);
}

console.log('');
console.log('Test 18: 上游不支持游标时回落旧页码口径，且不多打一次请求');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-legacy-' + Date.now());
  const legacy = () => mkData(24, { search: '', sortBy: 'stars' }, { page: 1, limit: 24, total: 480, totalPages: 20, hasNext: true, totalIsExact: true, isCapped: true, maxResults: 480, totalAll: 532411 });
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c, fetchJson: async (u) => { urls.push(u); return legacy(); } });
  console.log('   实测(legacy) 请求数=' + urls.length + ' total=' + String(r.total) + ' pages=' + String(r.totalPages) + ' windowed=' + String(r.windowed));
  check('legacy 响应只打一次请求（不重复发页码请求）', urls.length === 1, JSON.stringify(urls));
  check('legacy 回落：total 仍报 totalAll', r.total === 532411, String(r.total));
  check('legacy 回落：totalPages 仍报窗口深度 20', r.totalPages === 20, String(r.totalPages));
  check('legacy 回落：windowed 仍为 true', r.windowed === true, String(r.windowed));
  check('legacy 回落：hint 仍同时含目录数与窗口', /532411/.test(String(r.hint)) && /480/.test(String(r.hint)), String(r.hint));
  check('legacy 回落：不带 catalogProgressive', r.catalogProgressive === undefined, String(r.catalogProgressive));
}

console.log('');
console.log('Test 19: 链不再前进时必须停，且如实说这一页还没取到');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-stall-' + Date.now());
  const fetchJson = async (u) => { urls.push(u); return mkCursorPage(48, 0, 'SAME'); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c, fetchJson });
  const pDeep = await searchSkillsMp({ query: '', page: 9, pageSize: 24, category: 'debugging', cache: c, fetchJson: async (u) => { urls.push(u); return mkCursorPage(48, 0, 'SAME'); } });
  const reqs = urls.length;
  check('上游反复回同一游标 ⇒ 判定目录已到底（不再无限补链）', reqs <= 5, '请求数=' + reqs);
  check('取不到的深页给空集合而不是假数据', Array.isArray(pDeep.items) && pDeep.items.length === 0, String(pDeep.items.length));
  check('取不到时如实说明已取到多少条', /48/.test(String(pDeep.hint)), String(pDeep.hint));
  const c2 = makeCache(safeTempDir() + '/smp-empty-' + Date.now());
  const r2 = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c2, fetchJson: async () => mkCursorPage(0, 0, null, { hasNext: false, total: 0, totalAll: 0 }) });
  check('首页就零行时不谎称有目录', r2.items.length === 0 && r2.hasMore === false, 'n=' + r2.items.length + ' hasMore=' + String(r2.hasMore));
}

console.log('');
console.log('Test 20: 目录链按 facet/sort 隔离，不同分类不串同一份目录');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-iso-' + Date.now());
  const fetchJson = async (u) => { urls.push(u); const sp = new URL(u).searchParams; return mkCursorPage(48, 0, 'C1-' + String(sp.get('category'))); };
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'debugging', cache: c, fetchJson });
  await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'cli-tools', cache: c, fetchJson });
  const second = paramsOf(urls[1]);
  check('换分类重新起链（cursor=start，不带上一分类的游标）', second.get('cursor') === 'start' && second.get('category') === 'cli-tools', String(urls[1]));
  await searchSkillsMp({ query: '', page: 3, pageSize: 24, category: 'cli-tools', cache: c, fetchJson });
  check('cli-tools 第 3 页续自己的游标', paramsOf(urls[2]).get('cursor') === 'C1-cli-tools' && paramsOf(urls[2]).get('category') === 'cli-tools', String(urls[2]));
}

console.log('');
console.log('Test 22: 链中途的瞬时错误不得当成「分类不存在」，且落盘的半截链要能接上');
{
  // 真机 28b 实证：p21 链到中途上游回 `python 取数失败：Traceback`（限流抖动），旧写法一律
  // 当作分类被拒 ⇒ 悄悄换成全库目录再打 12 轮（25s+），卡片类目与 hint 全被污染。
  // 只有上游明说 400/INVALID_CATEGORY 才允许去 facet 重走；其余错误原样抛出。
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-transient-' + Date.now());
  const chainFetch = (failAt) => async (u) => {
    urls.push(u);
    if (failAt !== null && urls.length === failAt) throw new Error('python 取数失败：Traceback (most recent call last): timeout');
    const sp = new URL(u).searchParams;
    const cur = String(sp.get('cursor'));
    const idx = cur === 'start' ? 0 : Number(cur.replace(/^C/, ''));
    return mkCursorPage(48, idx * 48, 'C' + (idx + 1));
  };
  let threw = false;
  try { await searchSkillsMp({ query: '', page: 3, pageSize: 24, category: 'debugging', cache: c, fetchJson: chainFetch(2) }); }
  catch { threw = true; }
  check('瞬时错误直接抛出（不悄悄换成全库目录）', threw === true, 'threw=' + threw);
  check('没有为瞬时错误去掉 category 重走', urls.every((u) => paramsOf(u).get('category') === 'debugging'), JSON.stringify(urls));
  const before = urls.length;
  const r2 = await searchSkillsMp({ query: '', page: 3, pageSize: 24, category: 'debugging', cache: c, fetchJson: chainFetch(null) });
  check('下一次调用从断点续链（带的是已落盘的 nextCursor，不是 start）', paramsOf(urls[before]).get('cursor') === 'C1', String(urls[before]));
  check('续链后仍按分类筛（facetUsed 没被污染）', r2.facetUsed === 'debugging' && r2.serverFacet === true, String(r2.facetUsed) + '/' + String(r2.serverFacet));
  check('续链给的是第 49–72 行（本地目录攒到 96 再切第 3 页）', r2.items[0].slug === 'pdf-tool-48' && r2.items[23].slug === 'pdf-tool-71', JSON.stringify(r2.items.map((i) => i.slug).slice(0, 2)));
}

console.log('');
console.log('Test 23: 只有明说的 400/INVALID_CATEGORY 才允许去 facet 重走（游标链形状）');
{
  const urls = [];
  const c = makeCache(safeTempDir() + '/smp-400cur-' + Date.now());
  const fetchJson = async (u) => {
    urls.push(u);
    const sp = new URL(u).searchParams;
    if (sp.get('category') !== null) throw new Error('python 取数失败：urllib.error.HTTPError: HTTP Error 400: Bad Request');
    const cur = String(sp.get('cursor'));
    const idx = cur === 'start' ? 0 : Number(cur.replace(/^C/, ''));
    return mkCursorPage(48, idx * 48, 'C' + (idx + 1));
  };
  const r = await searchSkillsMp({ query: '', page: 1, pageSize: 24, category: 'nonexistent-cat', cache: c, fetchJson });
  check('400 后确实去掉了 category 重走', urls.length === 2 && paramsOf(urls[1]).get('category') === null, JSON.stringify(urls));
  check('400 拒绝如实回填（facetUsed 空、serverFacet false）', r.facetUsed === '' && r.serverFacet === false, String(r.facetUsed) + '/' + String(r.serverFacet));
  check('400 拒绝的 hint 说的是分类不存在', /没有「nonexistent-cat」这个分类/.test(String(r.hint)), String(r.hint));
  check('400 支仍走目录切片（catalogProgressive 在场）', r.catalogProgressive === true, String(r.catalogProgressive));
}

console.log('');
console.log('Test 21: 聚合层对渐进目录不得用 ceil(总数/页大小) 造出两万页');
{
  const mkProg = (o) => () => Promise.resolve(Object.assign({
    source: 'skillsmp',
    items: Array.from({ length: 24 }, (u, i) => ({ id: 'p' + i, name: 'p' + i, source: 'skillsmp', category: 'debugging' })),
    total: 545886, hasMore: true, totalPages: undefined, serverFacet: true, facetUsed: 'debugging',
    windowed: false, catalogProgressive: true, hint: '已取到前 48 条',
  }, o || {}));
  const r = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: 24, category: 'debugging', cache: makeCache(safeTempDir() + '/smp-agg-' + Date.now()), handlers: { skillsmp: mkProg() }, budgetMs: 5000 });
  console.log('   实测聚合: total=' + String(r.total) + ' pages=' + String(r.pages) + ' hasMore=' + String(r.hasMore) + ' hints=' + JSON.stringify(r.hints));
  check('渐进目录：聚合层不报由总数反推的页深', r.pages === undefined, String(r.pages));
  check('渐进目录：总数照常上报（chip 与 hint 同源不断）', r.total === 545886, String(r.total));
  check('渐进目录：hasMore 保持 true（还能往后取）', r.hasMore === true, String(r.hasMore));
  check('渐进目录：serverFacet 不被抹掉', r.serverFacet === true && !r.categoryNote, 'serverFacet=' + r.serverFacet + ' note=' + JSON.stringify(r.categoryNote));
  check('渐进目录：说明经 hints 通道到达展示层', (r.hints || []).some((h) => /48/.test(String(h))), JSON.stringify(r.hints));
  const ctl = await searchSkills({ query: '', source: 'skillsmp', page: 1, pageSize: 24, category: 'debugging', cache: makeCache(safeTempDir() + '/smp-ctl-' + Date.now()), handlers: { skillsmp: () => Promise.resolve({ source: 'skillsmp', items: [{ id: 'w1', name: 'w1', source: 'skillsmp' }], total: 545885, totalPages: 20, hasMore: true, serverFacet: true, facetUsed: 'debugging', windowed: true }) }, budgetMs: 5000 });
  check('对照：窗口封顶源仍夹到 20 页（旧行为不动）', ctl.pages === 20, 'pages=' + String(ctl.pages));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
