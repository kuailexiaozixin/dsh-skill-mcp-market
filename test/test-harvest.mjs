#!/usr/bin/env node
// test-harvest.mjs — 0.5.174 渐进式加载（harvest.start / harvest.poll）判据。
//
// 语义：一边跑一边把已取到的行推给面板。三条不许破的底线，各自对应下面一组断言：
//   ① 不按时间预算截断（12s 预算属于聚合搜索，不属于 harvest）；
//   ② 某源慢/某源失败都不能丢掉已完成源的结果，失败要如实进 meta；
//   ③ skills.search 的出参逐字段不变（面板旧版本仍能用，harvest 字段不得串味）。
// 全部用注入的假 handlers + 假定时器，不打网络、不真等 13 秒。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { pathToFileURL } from 'node:url';
import { makeHarvestStore, searchSkills, HARVEST_BUDGET_MS, DEFAULT_BUDGET_MS_FOR_TEST } from '../src/sources.js';
import { absent } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 200) + ']' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowKey = (it) => String(it && it.source) + '|' + String(it && it.slug);
const keySet = (rows) => new Set(rows.map(rowKey));
// withFakeClock 会替换 globalThis.setTimeout；兜底判据必须走真实时钟，否则变异体是挂死而不是转红。
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const realSleep = (ms) => new Promise((r) => REAL_SET_TIMEOUT(r, ms));

const mkItem = (src, i) => ({ slug: src + '-' + i, name: src + '-' + i, source: src, installs: i });

// ── 假时钟：只替 setTimeout/clearTimeout（fanOutSources 的预算守卫用的就是它们），
// 真实 await 仍走微任务。不真等 13 秒也能让「12s 预算」这条路被真的走一遍。
function withFakeClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let vnow = 0;
  const timers = new Map();
  let tid = 1;
  const yieldReal = () => new Promise((r) => realSetTimeout(r, 0));
  globalThis.setTimeout = (cb, ms) => { const id = tid++; timers.set(id, { at: vnow + (Number(ms) || 0), cb }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  const tick = async (ms) => {
    // 先让微任务跑一轮：fanOutSources 的预算守卫是在 await 之后才 setTimeout 注册的，
    // 若直接扫描就会拿到空表、把 vnow 先推到 13000，守卫随后注册在 13000+12000 上，
    // 12s 截断路径等于没走 —— 对照组假绿（实测 slow-9 仍在 items 里）。
    for (let i = 0; i < 4; i++) await yieldReal();
    const target = vnow + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) { if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t]; }
      if (!pick) break;
      timers.delete(pick[0]);
      vnow = Math.max(vnow, pick[1].at);
      pick[1].cb();
      for (let i = 0; i < 8; i++) await yieldReal();
    }
    vnow = target;
    for (let i = 0; i < 8; i++) await yieldReal();
  };
  const restore = () => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; };
  return Promise.resolve(fn(tick, restore, yieldReal)).finally(restore);
}

console.log('Test 1: start 首包有行且 done=false；连续 poll 的行集与一次性 searchSkills 同集合');
{
  const handlers = {
    fast: async () => { await sleep(5); return { items: [mkItem('fast', 1), mkItem('fast', 2)], total: 2, totalPages: 1 }; },
    mid: async () => { await sleep(120); return { items: [mkItem('mid', 3)], total: 1, totalPages: 1 }; },
    slow: async () => { await sleep(240); return { items: [mkItem('slow', 4), mkItem('slow', 5)], total: 2, totalPages: 1 }; },
  };
  const store = makeHarvestStore();
  const start = await store.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers, cache: null });
  check('start 返回 id（字符串）', typeof start.id === 'string' && start.id.length > 0, JSON.stringify(start).slice(0, 120));
  check('start 首包 rows 非空（已取到的源立刻给出）', Array.isArray(start.rows) && start.rows.length > 0, JSON.stringify(start.rows));
  check('start 首包 done=false（还没跑完）', start.done === false, JSON.stringify(start.done));
  check('start 带 stage 字符串', typeof start.stage === 'string' && start.stage.length > 0, JSON.stringify(start.stage));
  check('start 带 meta 对象', start.meta && typeof start.meta === 'object', JSON.stringify(start.meta).slice(0, 120));
  const seen = [...start.rows];
  const deltas = [];
  let pollRes = null;
  for (let i = 0; i < 12; i++) {
    await sleep(30);
    pollRes = store.poll(start.id);
    if (!pollRes) break;
    deltas.push(pollRes.rows.length);
    seen.push(...pollRes.rows);
    if (pollRes.done) break;
  }
  check('poll 最终 done=true', Boolean(pollRes) && pollRes.done === true, JSON.stringify(pollRes).slice(0, 160));
  check('poll 有增量批次（不是一次性倒完）', deltas.filter((d) => d > 0).length >= 2, JSON.stringify(deltas));
  const oneShot = await searchSkills({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: {
    fast: async () => ({ items: [mkItem('fast', 1), mkItem('fast', 2)], total: 2, totalPages: 1 }),
    mid: async () => ({ items: [mkItem('mid', 3)], total: 1, totalPages: 1 }),
    slow: async () => ({ items: [mkItem('slow', 4), mkItem('slow', 5)], total: 2, totalPages: 1 }),
  }, cache: null });
  const a = keySet(seen), b = keySet(oneShot.items);
  const missing = [...b].filter((k) => !a.has(k));
  const extra = [...a].filter((k) => !b.has(k));
  check('harvest 累计行集 == 一次性 skills.search 行集', missing.length === 0 && extra.length === 0, 'missing=' + missing.join(',') + ' extra=' + extra.join(','));
  check('harvest 行对象带 installRef（与一次性同形）', seen.every((r) => 'installRef' in r), JSON.stringify(seen[0]));
  check('done=true 之后再 poll 返回空数组', (() => { const p2 = store.poll(start.id); return p2 && p2.done === true && Array.isArray(p2.rows) && p2.rows.length === 0; })(), JSON.stringify(store.poll(start.id)).slice(0, 140));
}


console.log('');
console.log('Test 2: 未知 id 与过期 id ⇒ poll 给出 null（dispatch 据此报 ok:false）');
{
  const store = makeHarvestStore();
  check('未知 id 返回 null（不是抛错、不是空对象）', store.poll('no-such-harvest-id') === null, String(store.poll('x')));
  check('空 id 返回 null', store.poll('') === null && store.poll(undefined) === null, '');
  const handlers = { a: async () => ({ items: [mkItem('a', 1)], total: 1, totalPages: 1 }) };
  const s = await store.start({ query: '', source: 'a', page: 1, pageSize: 24, handlers, cache: null, ttlMs: 0 });
  await sleep(10);
  check('ttlMs=0 的会话过期后 poll 返回 null', store.poll(s.id) === null, '仍在表里=' + String(store.poll(s.id)));
}

console.log('');
console.log('Test 3: harvest 不受 12s 预算截断（假时钟把某源拖到 13s 仍必须出现在最终 rows 里）');
{
  check('harvest 预算常量存在且远大于 DEFAULT_BUDGET_MS', typeof HARVEST_BUDGET_MS === 'number' && HARVEST_BUDGET_MS > DEFAULT_BUDGET_MS_FOR_TEST * 10, HARVEST_BUDGET_MS + ' vs ' + DEFAULT_BUDGET_MS_FOR_TEST);
  await withFakeClock(async (tick) => {
    let releaseSlow = null;
    const mk = () => ({
      fast: async () => ({ items: [mkItem('fast', 1)], total: 1, totalPages: 1 }),
      slow: async () => new Promise((r) => { releaseSlow = () => r({ items: [mkItem('slow', 9)], total: 1, totalPages: 1 }); }),
    });
    // 对照组：同一条聚合路径走一次性 skills.search（默认 12s 预算）——13s 的源必须被砍掉。
    const ctl = searchSkills({ query: 'ctl3', source: 'all', page: 1, pageSize: 24, handlers: mk(), cache: null });
    await tick(13000);
    releaseSlow();
    const ctlRes = await ctl;
    check('对照成立：默认 12s 预算确实会砍掉 13s 的源（否则本测试是假绿）', ctlRes.items.map((i) => i.source).indexOf('slow') < 0 && ctlRes.degraded.some((d) => d.source === 'slow'), JSON.stringify({ items: ctlRes.items.map((i) => i.slug), deg: ctlRes.degraded.map((d) => d.source) }));
    // 实验组：harvest 同条件、同样 13s，慢源必须出现在最终 rows。
    // 首包用真实计时上限兜底：若渐进通路被憋住（例如把行攒到 done 才推），这里得到的是
    // 明确的 FAIL 而不是整个套件挂死 —— 挂死的变异体证明不了判据能转红。
    let rel2 = null;
    const store = makeHarvestStore();
    const stP = store.start({ query: 'hv3', source: 'all', page: 1, pageSize: 24, cache: null, handlers: {
      fast: async () => ({ items: [mkItem('fast', 1)], total: 1, totalPages: 1 }),
      slow: async () => new Promise((r) => { rel2 = () => r({ items: [mkItem('slow', 9)], total: 1, totalPages: 1 }); }),
    } });
    await tick(13000);
    const raced = await Promise.race([stP.then(function (v) { return { ok: true, value: v }; }), realSleep(2500).then(function () { return { ok: false, value: null }; })]);
    const first = raced.value;
    const midRows = first ? first.rows : [];
    check('start 首包已把快源推出去（不用等慢源）', Boolean(first) && midRows.length > 0 && midRows.some((r) => r.source === 'fast'), first ? JSON.stringify(midRows.map((r) => r.slug)) : 'start 2.5s 真实时间内未返回首包（行被攒住 = 渐进失败）');
    if (rel2) rel2();
    let last = null;
    if (first) { const id = first.id; for (let i = 0; i < 10; i++) { last = store.poll(id); if (last && last.done) break; await tick(50); } }
    check('13s 的慢源仍在最终 rows 里（harvest 无截断）', Boolean(last) && last.done === true && last.rows.some((r) => r.source === 'slow'), last ? JSON.stringify(last.rows.map((r) => r.slug)) : '没有收口包');
    check('慢源没有被记成 degraded（harvest 没截它）', Boolean(last) && !((last.meta && last.meta.degraded) || []).some((d) => d.source === 'slow'), JSON.stringify(last && last.meta && last.meta.degraded));
  });
}

console.log('');
console.log('Test 4: 某源失败不丢已完成源的结果，失败如实进 meta');
{
  const store = makeHarvestStore();
  const handlers = {
    good: async () => ({ items: [mkItem('good', 1), mkItem('good', 2)], total: 2, totalPages: 1 }),
    boom: async () => { throw new Error('HTTP 503 from upstream'); },
  };
  const s = await store.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers, cache: null });
  let last = s;
  for (let i = 0; i < 10; i++) { const p = store.poll(s.id); if (!p) break; last = { rows: last.rows.concat(p.rows), meta: p.meta, done: p.done, hints: p.hints }; if (p.done) break; await sleep(30); }
  check('有源失败也标 done=true（保守判定）', last.done === true, JSON.stringify(last.done));
  check('成功源的行一条不少', keySet(last.rows).has('good|good-1') && keySet(last.rows).has('good|good-2'), JSON.stringify(last.rows.map((r) => r.slug)));
  check('失败源进 meta.degraded', Array.isArray(last.meta.degraded) && last.meta.degraded.some((d) => d.source === 'boom'), JSON.stringify(last.meta.degraded));
  check('失败源进 meta.sourceErrors（逐源点名）', Array.isArray(last.meta.sourceErrors) && last.meta.sourceErrors.some((x) => /boom/.test(String(x))), JSON.stringify(last.meta.sourceErrors));
}

console.log('');
console.log('Test 5: skills.search 出参不含 harvest 字段（防串味）');
{
  const r = await searchSkills({ query: '', source: 'x', page: 1, pageSize: 24, cache: null, handlers: { x: async () => ({ items: [mkItem('x', 1)], total: 1, totalPages: 1 }) } });
  const keys = Object.keys(r);
  const leaked = keys.filter((k) => ['id', 'rows', 'done', 'stage'].includes(k));
  check('searchSkills 返回体无 harvest 键', leaked.length === 0, leaked.join(','));
  check('searchSkills 仍是 items 口径（没有 rows）', Array.isArray(r.items) && !('rows' in r), keys.join(','));
  const ix = fs.readFileSync(path.join(W, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = ix.indexOf('case "skills.search"');
  const b = ix.indexOf('case "', a + 20);
  const block = ix.slice(a, b > 0 ? b : a + 1200);
  check('index.js 的 skills.search case 未被 harvest 改写', a > 0 && !/harvest/i.test(block), block.slice(0, 80));
  check('dispatch 注册了 harvest.start / harvest.poll', ix.includes('case "harvest.start"') && ix.includes('case "harvest.poll"'), '');
  check('harvest 路径不复用 DEFAULT_BUDGET_MS 截断（源码锁）', /budgetMs:\s*HARVEST_BUDGET_MS|budgetMs = HARVEST_BUDGET_MS|HARVEST_BUDGET_MS/.test(fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8')), 'sources.js 里没有 HARVEST_BUDGET_MS');
}

console.log('');
console.log('Test 6: RPC 运行时可达（真起 index.js，注入假 ctx，不碰网络）');
{
  // 父目录必须走 safeTempDir()：裸 os.tmpdir() 被 test-temp-hygiene 判红（无 TEMP/TMPDIR 时返回不可控路径）。
const home = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-harvest-home-'));
  fs.mkdirSync(path.join(home, 'market', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, 'market', 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'market', 'settings.json'), JSON.stringify({ skillDirs: [path.join(home, 'market', 'skills')], mcpDirs: [path.join(home, 'market', 'mcp')], disabledSkills: [], shippedRoot: '' }, null, 2));
  process.env.DSH_HOME = home;
  process.env.DSH_AGENTS_HOME = path.join(home, '.agents');
  const registered = [];
  const ctx = {
    config: { get: () => undefined, getAll: () => ({}) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: { dataDir: path.join(home, 'data'), metadata: { id: 'dsh-market' } },
    effect(fn) { try { fn(); } catch {} },
    tools: { register: () => (() => {}) },
    get(name) {
      if (name === 'webServer') return { register: (r) => registered.push(r) };
      if (name === 'scheduler') return { every: () => (() => {}), daily: () => (() => {}) };
      if (name === 'config') return { get: () => undefined, getAll: () => ({}) };
      return undefined;
    },
  };
  let bootErr = '';
  try {
    const mod = await import(pathToFileURL(path.join(W, 'index.js')).href + '?t=' + Date.now());
    const plugin = mod.default ?? mod;
    await plugin.apply(ctx, {});
  } catch (e) { bootErr = String((e && e.message) || e); }
  check('index.js apply 不抛（harvest 接线无 ReferenceError）', bootErr === '', bootErr.slice(0, 200));
  const handler = (registered.find((r) => r && r.path === '/api/dsh-market/rpc') || {}).handler;
  const rpc = async (payload) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = String(b || ''); } };
    const req = { method: 'POST', url: '/api/dsh-market/rpc', headers: { 'content-type': 'application/json' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)); } };
    try { await handler(req, res); } catch (e) { return { json: { ok: false, error: String((e && e.message) || e) } }; }
    try { return { json: JSON.parse(res.body) }; } catch { return { json: null, body: res.body }; }
  };
  if (typeof handler === 'function') {
    // 无 handler 的源名 ⇒ picked 为空 ⇒ 不打任何上游，只验 op 形状。
    const st = await rpc({ op: 'harvest.start', query: '', source: 'no-such-source-xyz', page: 1, pageSize: 5 });
    const j = st.json || {};
    check('harvest.start 运行时 ok:true', j.ok === true, JSON.stringify(j).slice(0, 160));
    check('harvest.start 契约形状 {id,rows,meta,done,stage}', typeof j.id === 'string' && Array.isArray(j.rows) && j.meta && typeof j.meta === 'object' && typeof j.done === 'boolean' && typeof j.stage === 'string', JSON.stringify(j).slice(0, 200));
    const pl = await rpc({ op: 'harvest.poll', id: j.id });
    check('harvest.poll 运行时 ok:true 且带 rows/done', pl.json && pl.json.ok === true && Array.isArray(pl.json.rows) && typeof pl.json.done === 'boolean', JSON.stringify(pl.json).slice(0, 160));
    const bad = await rpc({ op: 'harvest.poll', id: 'bogus-id-never-existed' });
    check('未知 id ⇒ ok:false + error（面板据此回落 skills.search）', bad.json && bad.json.ok === false && /不存在|过期/.test(String(bad.json.error)), JSON.stringify(bad.json).slice(0, 160));
    const ss = await rpc({ op: 'skills.search', query: '', source: 'no-such-source-xyz', page: 1, pageSize: 5 });
    const sj = ss.json || {};
    check('skills.search 出参无 harvest 字段（运行时）', sj.ok === true && !('rows' in sj) && !('done' in sj) && !('stage' in sj) && !('id' in sj), Object.keys(sj).join(','));
  } else {
    check('handler 已注册', false, 'registered=' + registered.length);
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log('Test 7: 收口包契约 —— final:true 的有序数组 === 同参数一次性 skills.search（R2/R3/R4）');
{
  // 落地顺序刻意与 picked 顺序相反：a 慢、b 快。一次性通路按 picked 顺序折叠（a 在前），
  // 到达序则是 b 在前 —— 只有真的走了同一套折叠口径，终态有序数组才对得上。
  const mkPair = () => ({
    a: async () => { await sleep(200); return { items: [mkItem('a', 1), mkItem('a', 2)], total: 2, totalPages: 1 }; },
    b: async () => { await sleep(5); return { items: [mkItem('b', 9)], total: 1, totalPages: 1 }; },
  });
  const store = makeHarvestStore();
  const s = await store.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: mkPair(), cache: null });
  const pkgs = [s];
  let finalPkg = s.final === true ? s : null;
  for (let i = 0; i < 14 && !finalPkg; i++) {
    await sleep(30);
    const p = store.poll(s.id);
    if (!p) break;
    pkgs.push(p);
    if (p.done) finalPkg = p;
  }
  const oneShot = await searchSkills({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: {
    a: async () => ({ items: [mkItem('a', 1), mkItem('a', 2)], total: 2, totalPages: 1 }),
    b: async () => ({ items: [mkItem('b', 9)], total: 1, totalPages: 1 }),
  }, cache: null });
  const ordered = (rows) => rows.map(rowKey).join(',');
  check('R4 收口包带 final:true（done=true 而 final 缺失属实现缺陷）', Boolean(finalPkg) && finalPkg.final === true, JSON.stringify(finalPkg && { done: finalPkg.done, final: finalPkg.final }).slice(0, 120));
  check('R4 有序数组等值：final.rows 与一次性 items 逐位相同（不只是 set）', Boolean(finalPkg) && ordered(finalPkg.rows) === ordered(oneShot.items), 'final=' + (finalPkg ? ordered(finalPkg.rows) : '-') + ' oneShot=' + ordered(oneShot.items));
  check('R4 一次性通路仍是 picked 序（对照组自身成立，a 在 b 前）', ordered(oneShot.items) === 'a|a-1,a|a-2,b|b-9', ordered(oneShot.items));
  const mids = pkgs.filter((p) => p !== finalPkg);
  check('R1 中间包一律不带 final（渐进值：早到早显示，不为排序憋行）', mids.every((p) => !('final' in p) || p.final !== true), JSON.stringify(mids.map((p) => Object.keys(p))));
  check('R1 首包按到达序给出且非空（b 先落地）', Array.isArray(s.rows) && s.rows.length > 0 && s.rows.every((r) => r.source === 'b'), JSON.stringify(s.rows.map((r) => r.slug)));
  const midTotal = mids.reduce((n, p) => n + p.rows.length, 0);
  // R1（集合口径）：中间包必须是真增量 —— ① 有行且少于终态（早到早显示，不为排序憋行）；
  // ② 包与包之间不重推（各包行数和 == 并集去重数）；③ 不丢行：已达的每一行都在 final 里。
  check('R1 中间包是真增量：有行、少于终态、且每行都在 final 行集里', mids.length >= 1 && midTotal > 0 && Boolean(finalPkg) && midTotal < finalPkg.rows.length && mids.every((p) => p.rows.every((r) => keySet(finalPkg.rows).has(rowKey(r)))), 'midPkgs=' + mids.length + ' midRows=' + midTotal + ' finalRows=' + (finalPkg ? finalPkg.rows.length : 0));
  const midUnion = new Set([].concat(...mids.map((p) => p.rows.map(rowKey))));
  const allUnion = new Set([].concat(...pkgs.map((p) => p.rows.map(rowKey))));
  check('R1 不重推：包间两两不相交（行数总和 == 并集去重数）', midTotal === midUnion.size, 'sum=' + midTotal + ' union=' + midUnion.size);
  check('R1 集合等值（对 rowKey 建集合，不比顺序）：中间包并集 ∪ final == final 行集 == 全部 3 行', keySet(finalPkg ? finalPkg.rows : []).size === allUnion.size && allUnion.size === 3 && midUnion.size >= 1 && mids.every((p) => p.rows.every((r) => allUnion.has(rowKey(r)))), 'midUnion=' + midUnion.size + ' allUnion=' + allUnion.size + ' final=' + (finalPkg ? finalPkg.rows.length : 0));
  const after = store.poll(s.id);
  check('R3 final 只发一次：之后的 poll 回到空增量且不再带 final', after && after.done === true && after.rows.length === 0 && after.final !== true, JSON.stringify(after).slice(0, 140));
  // 聚合排序口径也必须共用：source=all + sort=installCount 时一次性会按 installs 降序，
  // 终态 final 必须跟着一起降序（面板不许自己再排一次）。
  const store2 = makeHarvestStore();
  const s2 = await store2.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, sort: 'installCount', handlers: mkPair(), cache: null });
  let f2 = s2.final === true ? s2 : null;
  for (let i = 0; i < 14 && !f2; i++) { await sleep(30); const p = store2.poll(s2.id); if (!p) break; if (p.done) f2 = p; }
  const o2 = await searchSkills({ query: 'pdf', source: 'all', page: 1, pageSize: 24, sort: 'installCount', handlers: {
    a: async () => ({ items: [mkItem('a', 1), mkItem('a', 2)], total: 2, totalPages: 1 }),
    b: async () => ({ items: [mkItem('b', 9)], total: 1, totalPages: 1 }),
  }, cache: null });
  check('R4 排序态同样逐位相同（aggregateSort 口径共用，面板无需重排）', Boolean(f2) && ordered(f2.rows) === ordered(o2.items), 'final=' + (f2 ? ordered(f2.rows) : '-') + ' oneShot=' + ordered(o2.items));
  check('R4 排序态一次性确实按 installs 降序（对照自身成立）', ordered(o2.items) === 'b|b-9,a|a-2,a|a-1', ordered(o2.items));
  // 有源失败时终态 final 仍要如实：坏源折不进行，好源一行不少。
  const store3 = makeHarvestStore();
  const s3 = await store3.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: {
    good: async () => ({ items: [mkItem('good', 1), mkItem('good', 2)], total: 2, totalPages: 1 }),
    boom: async () => { throw new Error('HTTP 503 from upstream'); },
  }, cache: null });
  let f3 = s3.final === true ? s3 : null;
  for (let i = 0; i < 14 && !f3; i++) { await sleep(30); const p = store3.poll(s3.id); if (!p) break; if (p.done) f3 = p; }
  check('R4 有源失败时 final 只含好源的行且顺序与一次性一致', Boolean(f3) && ordered(f3.rows) === 'good|good-1,good|good-2', JSON.stringify(f3 && f3.rows.map((r) => r.slug)));
  check('R4 失败源仍如实进 final 包的 meta（done=true 且 degraded 有名）', Boolean(f3) && f3.done === true && (f3.meta.degraded || []).some((d) => d.source === 'boom'), JSON.stringify(f3 && f3.meta.degraded));
}

console.log('');
console.log('Test 8: 口径唯一性源码锁 —— 全仓只有一份折叠实现（禁止两份 aggregateSort）');
{
  const src = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8').replace(/\r\n/g, '\n');
  const strip = src.split('\n').filter((l) => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  const ix = fs.readFileSync(path.join(W, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  check('折叠函数定义唯一（export async function foldFanResults ×1）', (strip.match(/export async function foldFanResults/g) || []).length === 1, String((strip.match(/export async function foldFanResults/g) || []).length));
  check('两条通路都调用它（await foldFanResults ×2：searchSkills + harvest 终态）', (strip.match(/await foldFanResults\(/g) || []).length === 2, String((strip.match(/await foldFanResults\(/g) || []).length));
  check('aggregateSort 判据全仓只有一份（不许另写比较器）', (strip.match(/const aggregateSort = /g) || []).length === 1, String((strip.match(/const aggregateSort = /g) || []).length));
  check('skills.sh 描述补全只有一份', (src.match(/await enrichSkillsShFast\(missing, cache, 10\)/g) || []).length === 1, String((src.match(/await enrichSkillsShFast\(missing, cache, 10\)/g) || []).length));
  check('installRef 折入只有一份（srcItems 那行不重复）', (strip.match(/\{ \.\.\.it, installRef: installRefOf\(it\) \}/g) || []).length === 1, String((strip.match(/\{ \.\.\.it, installRef: installRefOf\(it\) \}/g) || []).length));
  check('harvest 终态读的是落地盒子（s.boxes），不是到达序 s.rows', /s\.boxes\.set\(name, box\)/.test(strip) && /const box = s\.boxes\.get\(name\)/.test(strip), '');
  const hvRegion = (ix.split('case "harvest.start"')[1] || '').split('default:')[0];
  check('服务端 harvest 出参不再排第二次（index.js 无 aggregateSort，harvest 两个 case 体内无 .sort(）', !/aggregateSort/.test(ix) && !hvRegion.includes('.sort('), 'aggregateSort=' + /aggregateSort/.test(ix) + ' regionHasSort=' + hvRegion.includes('.sort('));
  check('面板契约注释已落到源码（final:true ⇒ 整表替换）', /final/.test(ix) && /整表替换/.test(ix), '');
  const mod = await import('../src/sources.js');
  check('foldFanResults 是可导出的共享口径（非仅内部函数）', typeof mod.foldFanResults === 'function', typeof mod.foldFanResults);
}

console.log('');
console.log('Test 9: 收口包 meta 携带分页口径（面板 final 整表替换时无需瞎猜 total/pages）');
{
  // 一次性通路返回 total/pages/hasMore/serverFacet；harvest 必须把同一批折叠值随收口包 meta 下发，
  // 否则面板整表替换时分页器只能沿用更早一次搜索的旧值 —— 数字与内容不符（0.5.101 起反复判死）。
  const mkPair9 = () => ({
    a: async () => { await sleep(200); return { items: [mkItem('a', 1), mkItem('a', 2)], total: 2, totalPages: 1 }; },
    b: async () => { await sleep(5); return { items: [mkItem('b', 9)], total: 1, totalPages: 1 }; },
  });
  const store9 = makeHarvestStore();
  const st9 = await store9.start({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: mkPair9(), cache: null });
  const pkgs9 = [st9];
  let fp9 = st9.final === true ? st9 : null;
  for (let i = 0; i < 14 && !fp9; i++) { await sleep(30); const p = store9.poll(st9.id); if (!p) break; pkgs9.push(p); if (p.done) fp9 = p; }
  const oneShot9 = await searchSkills({ query: 'pdf', source: 'all', page: 1, pageSize: 24, handlers: {
    a: async () => ({ items: [mkItem('a', 1), mkItem('a', 2)], total: 2, totalPages: 1 }),
    b: async () => ({ items: [mkItem('b', 9)], total: 1, totalPages: 1 }),
  }, cache: null });
  check('收口包 meta.total/pages 与一次性同值', Boolean(fp9) && fp9.meta.total === oneShot9.total && fp9.meta.pages === oneShot9.pages, 'final=' + (fp9 ? JSON.stringify({ t: fp9.meta.total, p: fp9.meta.pages }) : '-') + ' oneShot=' + JSON.stringify({ t: oneShot9.total, p: oneShot9.pages }));
  check('收口包 meta.serverFacet 与一次性同值', Boolean(fp9) && fp9.meta.serverFacet === oneShot9.serverFacet, 'final=' + (fp9 && fp9.meta.serverFacet) + ' oneShot=' + oneShot9.serverFacet);
  check('收口包 meta.hasMore 与一次性同值（undefined 必须保持 undefined）', Boolean(fp9) && fp9.meta.hasMore === oneShot9.hasMore, 'final=' + (fp9 && String(fp9.meta.hasMore)) + ' oneShot=' + String(oneShot9.hasMore));
  const mids9 = pkgs9.filter((p) => p !== fp9);
  check('中间包 meta 不带未折叠的分页口径（没算完不许先报 total）', mids9.every((p) => !('total' in p.meta) && !('pages' in p.meta)), JSON.stringify(mids9.map((p) => Object.keys(p.meta))));
}

console.log('');
console.log('Test 10: ModelScope 大源逐页推入 harvest（渐进式加载），且 harvest 通路不受 45s 预算截断');
{
  // 用户诉求原话：「不要设置时间预算，超过就停止加载，这会导致显示的结果不全」「有多少就显示多少，
  // 不断增加新结果」。假上游只经 transport 注入（fetchOne 的 PUT 体），绝不打网络。
  const es10 = await import('../src/extra-sources.js');
  const mkMsTransport = (o) => {
    const st = { calls: [], opts: [] };
    const delay = typeof o.delay === 'number' ? o.delay : 60;
    st.tr = async (_url, init) => {
      const b = JSON.parse(String(init.body));
      const page = Number(b.PageNumber) || 1;
      st.calls.push(page);
      if (typeof o.onCall === 'function') o.onCall(page);
      await sleep(delay);
      const rows = [];
      if (page <= o.pages) {
        for (let i = 0; i < o.perPage; i++) {
          rows.push({
            Name: 'ms-p' + page + '-i' + i,
            DisplayName: 'Ms p' + page + ' i' + i,
            Description: 'd' + page + i,
            Path: 'own' + page,
            DownloadCount: (o.pages - page) * 100 + (o.perPage - i),
            SourceStar: page * 10 + i,
            L1: { ChineseName: o.catOf ? o.catOf(page, i) : '开发工具' },
          });
        }
      }
      return { ok: true, json: async () => ({ Data: { SkillList: rows, TotalCount: o.total } }) };
    };
    return st;
  };
  const msHandlers = (st) => ({ modelscope: (opts) => { st.opts.push(opts); return es10.searchModelScope(Object.assign({}, opts, { transport: st.tr })); } });
  // 增量包 = 带行且不带 final 的包（首包若已有行同样属于增量流）
  const midPkgs = (pkgs) => pkgs.filter((p) => p.rows.length > 0 && p.final !== true);
  const ordered = (rows) => rows.map((r) => rowKey(r)).sort().join(',');
  const inOrder = (rows) => rows.map(rowKey).join(',');
  const drain = async (store, first, rounds) => {
    const pkgs = [first];
    if (first.done && first.final === true) return { pkgs, fin: first };
    let fin = null;
    for (let i = 0; i < rounds && !fin; i++) { await sleep(15); const p = store.poll(first.id); if (!p) break; pkgs.push(p); if (p.done) fin = p; }
    return { pkgs, fin };
  };

  // ── A. 逐页推：真实时钟，4 页 × 4 行（total=1500 ⇒ msPagesNeeded=4），每页 60ms ──
  const stA = mkMsTransport({ pages: 4, perPage: 4, total: 3500 });
  const storeA = makeHarvestStore();
  const firstA = await storeA.start({ query: 'msA', source: 'modelscope', sort: 'downloadCount', page: 1, pageSize: 24, handlers: msHandlers(stA), cache: null });
  const runA = await drain(storeA, firstA, 80);
  const pkgsA = runA.pkgs; const finA = runA.fin;
  const oneA = await searchSkills({ query: 'msA', source: 'modelscope', sort: 'downloadCount', page: 1, pageSize: 24, handlers: msHandlers(mkMsTransport({ pages: 4, perPage: 4, total: 3500 })), cache: null });
  check('A1 harvest 至少 2 个带行的中间包（逐页推，不是憋到收口）', midPkgs(pkgsA).length >= 2, 'mids=' + midPkgs(pkgsA).length + ' calls=' + stA.calls.join(','));
  const rcsA = midPkgs(pkgsA).map((p) => p.meta.rowCount);
  check('A2 中间包 meta.rowCount 严格单调递增', rcsA.every((v, i) => i === 0 || v > rcsA[i - 1]), JSON.stringify(rcsA));
  check('A3 中间包一律不带 final（final 只属于收口包）', midPkgs(pkgsA).length > 0 && midPkgs(pkgsA).every((p) => p.final !== true), JSON.stringify(midPkgs(pkgsA).map((p) => Boolean(p.final))));
  check('A4 中间包 meta 不含 total/pages（分页口径只在 finalMeta 里给）', midPkgs(pkgsA).every((p) => !('total' in p.meta) && !('pages' in p.meta)), JSON.stringify(midPkgs(pkgsA).map((p) => Object.keys(p.meta).filter((k) => k === 'total' || k === 'pages'))));
  check('A5 第一页落地即推进会话（源尚未 settled 时已有行）', pkgsA.some((p) => p.rows.length > 0 && /from 0\//.test(String(p.stage))), JSON.stringify(pkgsA.map((p) => p.stage).slice(0, 2)));
  check('A6 收口行集与同参数 skills.search 折叠结果同集合（唯一口径 foldFanResults）', Boolean(finA) && ordered(finA.rows) === ordered(oneA.items), 'final=' + ordered(finA && finA.rows) + ' oneShot=' + ordered(oneA.items));
  check('A7 收口行序与一次性折叠逐行一致', Boolean(finA) && inOrder(finA.rows) === inOrder(oneA.items), 'final=' + inOrder(finA && finA.rows) + ' oneShot=' + inOrder(oneA.items));
  const concatA = midPkgs(pkgsA).flatMap((p) => p.rows.map(rowKey));
  const finalKeysA = new Set((finA && finA.rows || []).map(rowKey));
  check('A8 逐页增量互不重复且都落在收口行集内（rowKeyOf 去重，收口不重复计行）',
    new Set(concatA).size === concatA.length && concatA.every((k) => finalKeysA.has(k)) && finA.meta.rowCount === finA.rows.length && concatA.length <= finA.rows.length,
    'midRows=' + concatA.length + ' distinct=' + new Set(concatA).size + ' final=' + finA.rows.length + ' rc=' + finA.meta.rowCount);

  // ── B. 分类过滤口径：中间包推的必须是已按当前分类过滤后的行 ──
  const stB = mkMsTransport({ pages: 3, perPage: 3, total: 3500, catOf: (page, i) => (i === 0 ? '开发工具' : '办公效率') });
  const storeB = makeHarvestStore();
  const firstB = await storeB.start({ query: 'msB', source: 'modelscope', sort: 'downloadCount', category: '开发工具', page: 1, pageSize: 24, handlers: msHandlers(stB), cache: null });
  const runB = await drain(storeB, firstB, 80);
  const midSlugsB = midPkgs(runB.pkgs).flatMap((p) => p.rows.map((r) => r.slug));
  check('B1 中间包只含当前分类的行（面板不许闪现别类条目）', midSlugsB.length >= 2 && midSlugsB.every((s) => /-i0$/.test(s)), JSON.stringify(midSlugsB));
  check('B2 收口行同样只含该分类', Boolean(runB.fin) && runB.fin.rows.length > 0 && runB.fin.rows.every((r) => /-i0$/.test(r.slug)), JSON.stringify(runB.fin && runB.fin.rows.map((r) => r.slug)));

  // ── C. 假 handler 直接验证注入与会话侧语义（去重/唤醒/installRef/钩子归属） ──
  let partialSeen = null;
  const storeC = makeHarvestStore();
  const firstC = await storeC.start({ query: 'msC', source: 'modelscope', page: 1, pageSize: 24, cache: null, handlers: {
    modelscope: async (opts) => {
      partialSeen = { bypass: opts.harvestBypass, cb: typeof opts.msOnPartial };
      if (typeof opts.msOnPartial === 'function') {
        opts.msOnPartial([{ slug: 'pX', source: 'modelscope', installs: 1 }, { slug: 'pX', source: 'modelscope', installs: 1 }]);
        opts.msOnPartial([{ slug: 'pY', source: 'modelscope', installs: 2 }]);
      }
      return { items: [{ slug: 'pY', source: 'modelscope', installs: 2 }], total: 1, totalPages: 1 };
    },
  } });
  check('C1 harvest 通路的 handler 收到 harvestBypass=true 与 msOnPartial 函数', partialSeen && partialSeen.bypass === true && partialSeen.cb === 'function', JSON.stringify(partialSeen));
  check('C2 msOnPartial 重复行被 rowKeyOf 去重（rowCount 只记一次）', firstC.meta.rowCount === 2 && firstC.rows.length === 2, 'rc=' + firstC.meta.rowCount + ' rows=' + firstC.rows.length);
  check('C3 msOnPartial 推进会话后立刻唤醒等待者（首包不等源 settled）', firstC.rows.length > 0 && firstC.done === false, 'done=' + firstC.done);
  check('C4 msOnPartial 推的行带 installRef（与会话口径一致）', Boolean(firstC.rows[0]) && 'installRef' in firstC.rows[0], JSON.stringify(firstC.rows[0]));
  const optsSeenC = {};
  const storeC5 = makeHarvestStore();
  await storeC5.start({ query: 'msC5', source: '', page: 1, pageSize: 24, cache: null, handlers: {
    modelscope: async (opts) => { optsSeenC.modelscope = { bypass: opts.harvestBypass, cb: typeof opts.msOnPartial }; return { items: [], total: 0, totalPages: 1 }; },
    lobehub: async (opts) => { optsSeenC.lobehub = { bypass: opts.harvestBypass, cb: opts.msOnPartial }; return { items: [], total: 0, totalPages: 1 }; },
  } });
  check('C5 钩子只属于 modelscope 大源（其它 handler 收到 msOnPartial:null）', optsSeenC.modelscope.cb === 'function' && optsSeenC.lobehub.cb === null && optsSeenC.lobehub.bypass === true, JSON.stringify(optsSeenC));

  // ── D. 一次性 skills.search 通路逐字段不变：不带新键、出参键序原样 ──
  const stE = mkMsTransport({ pages: 12, perPage: 2, total: 12000 });
  await searchSkills({ query: 'msE', source: 'modelscope', sort: 'downloadCount', page: 1, pageSize: 24, handlers: msHandlers(stE), cache: null });
  const optsE = stE.opts[0] || {};
  check('D1 一次性通路不传 harvestBypass/msOnPartial（零开销、出参字段不变）', !('harvestBypass' in optsE) && !('msOnPartial' in optsE), JSON.stringify(Object.keys(optsE)));
  const oneD2 = await searchSkills({ query: 'msD2', source: 'modelscope', page: 1, pageSize: 24, handlers: { modelscope: async () => ({ items: [{ slug: 'x1', source: 'modelscope', installs: 5 }], total: 1, totalPages: 1 }) }, cache: null });
  const keysD2 = Object.keys(oneD2);
  check('D2 一次性结果出参字段集合逐字不变（skills.search 契约未被扩展）', JSON.stringify(keysD2) === JSON.stringify(['items', 'categoryNote', 'serverFacet', 'filteredOut', 'page', 'pageSize', 'pages', 'totalPages', 'total', 'hasMore', 'degraded', 'hints', 'sourceErrors']), JSON.stringify(keysD2));

  // ── E. harvest 无 45s 截断 / 一次性仍截断：只推进 Date.now 的偏移，不真等 45 秒 ──
  const realNowE = Date.now;
  let offE = 0;
  globalThis.Date.now = () => realNowE() + offE;
  try {
    // 一次性：每页 +20000ms ⇒ 第 4 页前已越过 45s 预算（MS_FETCH_BUDGET_MS=45000），必须在第 3 页后停。
    const stF = mkMsTransport({ pages: 12, perPage: 2, total: 12000, delay: 5, onCall: () => { offE += 20000; } });
    const oneF = await searchSkills({ query: 'msF', source: 'modelscope', sort: 'downloadCount', page: 1, pageSize: 24, handlers: msHandlers(stF), cache: null });
    check('E1 非 harvest 通路仍在 45s 截断（保留旧行为）', stF.calls.length === 3 && oneF.items.length === 6, 'calls=' + stF.calls.join(',') + ' items=' + oneF.items.length);
    check('E2 截断态 hint 仍如实说明用完 45s 预算', JSON.stringify(oneF.hints).includes('用完 45s 时间预算'), JSON.stringify(oneF.hints));
    // harvest：同一偏移口径下必须取到 pagesNeeded=12 的全部页（直到上界为止）。
    offE = 0;
    const stG = mkMsTransport({ pages: 12, perPage: 2, total: 12000, onCall: () => { offE += 20000; } });
    const storeG = makeHarvestStore();
    const firstG = await storeG.start({ query: 'msG', source: 'modelscope', sort: 'downloadCount', page: 1, pageSize: 24, handlers: msHandlers(stG), cache: null });
    const runG = await drain(storeG, firstG, 200);
    const pkgsG = runG.pkgs; const finG = runG.fin;
    check('E3 harvest 通路无 45s 截断（模拟耗时越过 240s 仍把可达 12 页取到尽头）', stG.calls.length === 12 && finG && finG.rows.length === 24, 'calls=' + stG.calls.join(',') + ' final=' + (finG && finG.rows.length));
    check('E4 「没有中断」的 harvest 收口不得声称用完 45s 预算', JSON.stringify(finG && finG.meta.hints).includes('45s') === false, JSON.stringify(finG && finG.meta.hints));
    check('E5 harvest 中间包按页连续增长（每页都推，不憋）', midPkgs(pkgsG).length >= 11, 'mids=' + midPkgs(pkgsG).length + ' rc=' + midPkgs(pkgsG).map((p) => p.meta.rowCount).join(','));
  } finally {
    globalThis.Date.now = realNowE;
  }

  // ── F. 豁免边界锁：只豁免 45s，30s 单页超时与 30 页硬上界仍生效 ──
  const srcF = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  const segF = srcF.split('function searchModelScope')[1] || '';
  check('F1 预算旁路只包一处（!harvestBypass && 紧贴 MS_FETCH_BUDGET_MS 判据）', (segF.match(/!harvestBypass && next > cachedPages \+ 1 && rows\.length && Date\.now\(\) - startedAt > MS_FETCH_BUDGET_MS/g) || []).length === 1, String((segF.match(/!harvestBypass/g) || []).length));
  check('F2 逐页取数仍带 30s 单页超时兜底（fetchOne 传 MS_PAGE_TIMEOUT_MS）', /fetchOne\(next, MS_PAGE, MS_PAGE_TIMEOUT_MS\)/.test(segF), 'no call site');
  check('F3 30 页上界未被整段停用（msPagesNeeded 仍夹 MS_MAX_PAGES）', /Math\.min\(MS_MAX_PAGES,/.test(segF) && srcF.includes('const MS_MAX_PAGES = 30;'), '');
  const stH = mkMsTransport({ pages: 40, perPage: 1, total: 120000, delay: 0 });
  await es10.searchModelScope({ query: 'msH', page: 1, pageSize: 24, sort: 'downloadCount', transport: stH.tr });
  check('F4 上游谎报大 total 时仍停在 30 页硬上界（MS_MAX_PAGES 生效）', stH.calls.length === 30 && Math.max.apply(null, stH.calls) === 30, 'calls=' + stH.calls.length + ' max=' + Math.max.apply(null, stH.calls));

  // ── G. 单份口径源码锁（防第二份谓词/归一漂移） ──
  const srcS = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  check('G1 msRowInCategory 全仓只有一份定义', (srcF.match(/const msRowInCategory = /g) || []).length === 1, String((srcF.match(/const msRowInCategory = /g) || []).length));
  check('G2 msMapItems 全仓只有一份定义', (srcF.match(/function msMapItems/g) || []).length === 1, String((srcF.match(/function msMapItems/g) || []).length));
  check('G3 分类过滤与逐页推共用同一谓词（categoryRows/msPagePasses 都走 msRowInCategory）', /categoryRows = usableRows\.filter\(msRowInCategory\)/.test(srcF) && /usable\.filter\(msRowInCategory\)/.test(srcF), '');
  check('G4 归一只有一处口径且调用点传数组（msMapItems(pageRows) 而非 .map(msMapItems)）', (srcF.match(/msMapItems\(pageRows\)/g) || []).length === 1 && !/\.map\(msMapItems\)/.test(srcF), 'arr=' + (srcF.match(/msMapItems\(pageRows\)/g) || []).length + ' callback=' + /\.map\(msMapItems\)/.test(srcF));
  check('G5 收口唯一口径未被复制：sources.js 里 await foldFanResults 仍为 2', (srcS.match(/await foldFanResults\(/g) || []).length === 2, '');
  check('G6 harvest 会话行入口只有一份 pushRow（onSettled 与 msOnPartial 共用）', (srcS.match(/const pushRow = /g) || []).length === 1, '');
}
// ---------- Test 11: D1 页数谎言（源声明了有限 totalPages 且 hasMore=false，聚合 pages 不得越过声明深度） ----------
{
  const mkRows = (src, n) => Array.from({ length: n }, (_, i) => mkItem(src, i));
  const one = async (name, result, opts) => searchSkills(Object.assign({
    query: '',
    page: 1,
    pageSize: 24,
    category: '',
    source: name,
    cache: null,
    handlers: { [name]: async () => result }
  }, opts || {}));

  const w = await one('skillsmp', { items: mkRows('skillsmp', 24), total: 545885, totalPages: 20, hasMore: false, serverFacet: true, facetUsed: 'debugging' });
  check('D1 windowed 单源：pages 夹到声明深度 20（改前 22746）', w.pages === 20 && w.totalPages === 20, 'pages=' + w.pages);
  check('D1 windowed 单源：total 仍是上游目录数 545885', w.total === 545885, 'total=' + w.total);
  check('D1 windowed 单源：hasMore 仍为 false', w.hasMore === false, String(w.hasMore));
  check('D1 windowed 单源：items 条数不变', Array.isArray(w.items) && w.items.length === 24, 'n=' + (w.items || []).length);

  const e = await one('lobehub', { items: mkRows('lobehub', 24), total: 3074, totalPages: 615, hasMore: true, serverFacet: true });
  check('D1 对照：hasMore=true 的声明深度原样保留（615）', e.pages === 615, 'pages=' + e.pages);

  const m = await searchSkills({
    query: '', page: 1, pageSize: 24, source: 'all', cache: null,
    handlers: {
      clawhub: async () => ({ items: mkRows('a', 2), total: 2, totalPages: 1, hasMore: false }),
      lobehub: async () => ({ items: mkRows('b', 24), total: 3074, totalPages: 615, hasMore: true })
    }
  });
  check('D1 对照：含未闭合源时 ceil 口径不变（616）', m.pages === 616, 'pages=' + m.pages);

  const s2 = await searchSkills({
    query: '', page: 1, pageSize: 24, source: 'all', cache: null,
    handlers: {
      clawhub: async () => ({ items: mkRows('a', 24), total: 545885, totalPages: 20, hasMore: false }),
      lobehub: async () => ({ items: mkRows('b', 24), total: 480, totalPages: 20, hasMore: false })
    }
  });
  check('D1 多源闭合：声明深度求和 20+20=40', s2.pages === 40, 'pages=' + s2.pages);

  const c = await one('clawhub', { items: mkRows('clawhub', 24), total: undefined, totalPages: undefined, hasMore: true });
  check('D1 对照 cappedNoTotal：total/pages/totalPages 依旧缺省', c.total === undefined && c.pages === undefined && c.totalPages === undefined, 'total=' + String(c.total) + ' pages=' + String(c.pages));

  const lf = await one('skills.sh', { items: [
    { slug: 'x1', name: 'x1', source: 'skills.sh', category: 'dev' },
    { slug: 'x2', name: 'x2', source: 'skills.sh', category: 'dev' },
    { slug: 'x3', name: 'x3', source: 'skills.sh', category: 'ops' }
  ], total: 3, totalPages: 1 }, { category: 'dev' });
  check('D1 对照本地过滤形态不变：pages=1 total=2 filteredOut=1', lf.pages === 1 && lf.total === 2 && lf.filteredOut === 1 && lf.items.length === 2, 'pages=' + lf.pages + ' total=' + lf.total + ' fo=' + lf.filteredOut);

  // 真实上游形态（实调实测 2026-11-26）：skillsmp facet 首页 windowed=true、hasMore=true、
  // totalPages=20、total=545885。只认 hasMore===false 的夹取条件在真机上是漏的 —— 首屏仍会
  // 报 22746 页。windowed 声明本身即「可浏览深度权威封顶」，必须参与夹取。
  const wl = await one('skillsmp', { items: mkRows('skillsmp', 24), total: 545885, totalPages: 20, hasMore: true, serverFacet: true, facetUsed: 'debugging', windowed: true });
  check('D1 真机形态 windowed+hasMore=true：pages 仍夹到 20', wl.pages === 20 && wl.totalPages === 20, 'pages=' + wl.pages);
  check('D1 真机形态：total 不被改写、hasMore 不被改写', wl.total === 545885 && wl.hasMore === true, 'total=' + wl.total + ' hasMore=' + String(wl.hasMore));

  const p2 = await one('skills.sh', { items: mkRows('skills.sh', 2), total: 2, totalPages: 1, hasMore: false });
  check('C6 对照：小目录闭合态 pages=1 total=2 hasMore=false', p2.pages === 1 && p2.total === 2 && p2.hasMore === false, 'pages=' + p2.pages);
  check('C6 一次性出参键序逐字不变（13 键）', Object.keys(w).join(',') === 'items,categoryNote,serverFacet,filteredOut,page,pageSize,pages,totalPages,total,hasMore,degraded,hints,sourceErrors', Object.keys(w).join(','));
}

// ---------- Test 12: harvest tailCategories（C1-C5 + E1/E2） ----------
{
  const drain12 = async (store, first, rounds) => {
    const pkgs = [first];
    let fin = first;
    for (let i = 0; i < rounds && !fin.done; i++) { await sleep(15); const q = store.poll(first.id); if (!q) break; pkgs.push(q); fin = q; }
    return { pkgs, fin };
  };

  const mkTail = (log) => ({
    skillsmp: async (opts) => {
      log.push(opts);
      const cat = String(opts.category || '');
      if (cat === 'gamma') { await sleep(30); throw new Error('boom'); }
      if (cat === 'delta') { await sleep(20); return { source: 'skillsmp', items: [], total: 0, serverFacet: false, facetUsed: '' }; }
      if (cat === 'alpha') {
        await sleep(240);
        return { source: 'skillsmp', items: [mkItem('skillsmp', 0), mkItem('skillsmp', 1)], total: 1000, totalPages: 20, hasMore: false, serverFacet: true, facetUsed: 'alpha', windowed: true };
      }
      if (cat === 'beta') {
        await sleep(110);
        return { source: 'skillsmp', items: [mkItem('skillsmp', 1), mkItem('skillsmp', 2)], total: 2, totalPages: 1, hasMore: false, serverFacet: true, facetUsed: 'beta', windowed: false };
      }
      return { source: 'skillsmp', items: [], total: 0, totalPages: 1, hasMore: false, serverFacet: true, facetUsed: cat };
    }
  });

  const store = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const log = [];
  const first = await store.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 2,
    tailCategories: ['alpha', 'alpha', '', '  ', 'beta', 'gamma', 'delta', 'epsilon'],
    tailConcurrency: 2,
    handlers: {
      skillsmp: async (opts) => {
        if (opts.category) return mkTail(log).skillsmp(opts);
        // run 3 成员集合：默认页三行各有归属 —— alpha 属 covers（合法成员）、
        // window-slug 属窗内别类（拒收）、无分类那行不可证（拒收）。
        return { source: 'skillsmp', items: [
          { slug: 'a1-member', name: 'a1-member', source: 'skillsmp', category: 'alpha', installs: 5 },
          { slug: 'w-window', name: 'w-window', source: 'skillsmp', category: 'window-slug', installs: 6 },
          { slug: 'u-unknown', name: 'u-unknown', source: 'skillsmp', installs: 7 },
        ], total: 3, totalPages: 1, hasMore: false, serverFacet: false };
      }
    }
  });
  // tail 态成员集合：默认页 3 行里只有 alpha 那行是可证成员，首包因此只带 1 行
  // （窗内别类与无分类两行在 push 那一刻就被拒收，见 Test 14）。
  check('C2 首包只带扇出的合法成员行，不待任何 tail 类落地', first.done !== true && first.rows.length === 1 && first.rows[0].slug === 'a1-member' && (!first.meta || first.meta.tail === undefined), 'rows=' + JSON.stringify(first.rows.map((r) => r.slug)) + ' done=' + String(first.done));

  const seen = [];
  let last = first;
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    last = store.poll(first.id);
    seen.push(last);
    if (last.done) break;
    await sleep(25);
  }
  const tailMids = seen.filter((p) => !p.done && /tail/.test(String(p.stage || '')));
  check('C2 tail 中间包按类推进 stage', tailMids.length >= 1, 'tailMids=' + tailMids.length);
  // 逐批到达：把轮询到的 rowCount 压成「不同批」序列 —— 同一批内多次 poll 数值相同，
  // 不同的 poll 周期拿到相同计数不算新的一批；序列必须严格递增且至少 2 批。
  const rcs = seen.filter((p) => !p.done && (p.meta || {}).rowCount > 0).map((p) => p.meta.rowCount);
  const batches = [...new Set(rcs)];
  const grows = batches.length >= 2 && batches.every((v, i) => i === 0 || v > batches[i - 1]);
  check('C2 逐类增量：中间包 rowCount 逐批递增', grows, JSON.stringify(rcs));
  const tailMidPkts = seen.filter((p) => !p.done && p.meta && p.meta.tail);
  check('C2(0.5.184) tail 会话的 poll 中间包带 tail 账本（加载行才有真进度可用）', tailMidPkts.length >= 1, 'tailMidPkts=' + tailMidPkts.length);
  check('C2(0.5.184) 中间包 tail 六字段键序与收口一致（加第七字段即红）', tailMidPkts.length >= 1 && Boolean((last.meta || {}).tail) && tailMidPkts.every((p) => Object.keys(p.meta.tail).sort().join(',') === Object.keys(last.meta.tail).sort().join(',')), tailMidPkts.map((p) => Object.keys(p.meta.tail).sort().join(',')).join(' | ').slice(0, 200));

  const fm = last.meta || {};
  const t = fm.tail || {};
  check('C3 收口 tail 恰好六个字段', Object.keys(t).sort().join(',') === 'categoriesFailed,categoriesFetched,categoriesTotal,retrievedTotal,upstreamTotal,windowed', Object.keys(t).join(','));
  check('C1 categoriesTotal=去空去重后的 5', t.categoriesTotal === 5, String(t.categoriesTotal));
  check('C3 categoriesFetched=3（0 行成功类也算）', t.categoriesFetched === 3, String(t.categoriesFetched));
  check('E2 categoriesFailed=2（抛错 + facet 被拒）', t.categoriesFailed === 2, String(t.categoriesFailed));
  check('C3 upstreamTotal=成功类自报 total 之和 1002', t.upstreamTotal === 1002, String(t.upstreamTotal));
  check('C3 windowed=true（任一上游窗口封顶）', t.windowed === true, String(t.windowed));
  check('C3 retrievedTotal=跨类去重后 3（alpha+beta 重叠 1 行）', t.retrievedTotal === 3, String(t.retrievedTotal));
  check('C4 收口 total=可取回行数 4，既非 upstreamTotal 也非 ceil(upstreamTotal/size)', fm.total === 4 && fm.total !== t.upstreamTotal && fm.pages !== Math.ceil(t.upstreamTotal / 2), 'total=' + fm.total + ' pages=' + fm.pages);
  check('C4 收口 pages=ceil(4/2)=2 且 hasMore=false', fm.pages === 2 && fm.hasMore === false, 'pages=' + fm.pages + ' hasMore=' + String(fm.hasMore));
  check('C5 tail 态收口 serverFacet=false', fm.serverFacet === false, String(fm.serverFacet));
  check('C2 收口行集=扇出 1 行 + tail 去重 3 行', last.rows.length === 4, 'n=' + last.rows.length);
  check('C2 tail 逐类 query 一律空串', log.length === 5 && log.every((o) => String(o.query || '') === ''), 'calls=' + log.length);

  const store2 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const calls2 = [];
  const first2 = await store2.start({
    query: '', source: 'skills.sh', category: '', page: 1, pageSize: 24,
    tailCategories: ['whatever'],
    handlers: { 'skills.sh': async (opts) => { calls2.push(opts); return { source: 'skills.sh', items: [mkItem('skills.sh', 0)], total: 1, totalPages: 1, hasMore: false }; } }
  });
  const run2 = await drain12(store2, first2, 60);
  check('E1 无分类参数的源不逐类调上游，计入 categoriesFailed', (run2.fin.meta.tail || {}).categoriesFailed === 1 && (run2.fin.meta.tail || {}).categoriesFetched === 0 && calls2.every((o) => !o.category), 'failed=' + JSON.stringify(run2.fin.meta.tail) + ' calls=' + calls2.length);

  const store3 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  // 402 个互不相同的 slug（+1 重复 +1 空串 = 404 项入参）：截断点必须是 400，
  // 写 401 的变异要能被抓到，所以 slug 数量本身超过上限。
  const big = [];
  for (let i = 0; i < 402; i++) big.push('cat-' + i);
  big.push('cat-1');
  big.push('');
  const first3 = await store3.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 24, tailCategories: big,
    handlers: { skillsmp: async (opts) => ({ source: 'skillsmp', items: [], total: 0, serverFacet: true, facetUsed: String(opts.category || '') }) }
  });
  const run3 = await drain12(store3, first3, 400);
  check('C1 上限 400：402 项去空去重 401 截断为 400', (run3.fin.meta.tail || {}).categoriesTotal === 400, JSON.stringify(run3.fin.meta.tail));

  const store4 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const first4 = await store4.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 24, tailCategories: 'not-an-array',
    handlers: { skillsmp: async () => ({ source: 'skillsmp', items: [], total: 0 }) }
  });
  const run4 = await drain12(store4, first4, 60);
  check('C1 非数组 tailCategories 按空处理（收口不带 tail 对象）', run4.fin.done && run4.fin.meta.tail === undefined, JSON.stringify(run4.fin.meta.tail));

  const idx12 = await fs.promises.readFile(path.join(W, 'index.js'), 'utf8');
  const hsPos = idx12.indexOf('case "harvest.start": {');
  check('C1 index.js harvest.start 归一并透传 tailCategories', hsPos >= 0 && /tailCategories/.test(idx12.slice(hsPos, hsPos + 1400)), '');
}

// ---------- Test 13: I1–I7 tail 正向证明（无证即拒：什么都不声明的源不得把未过滤行洗进会话） ----------
{
  const drain13 = async (store, first, rounds) => {
    const pkgs = [first];
    let fin = first;
    for (let i = 0; i < rounds && !fin.done; i++) { await sleep(15); const q = store.poll(first.id); if (!q) break; pkgs.push(q); fin = q; }
    return { pkgs, fin };
  };
  const esMod13 = await import('../src/extra-sources.js');
  const KEY13 = 'items,categoryNote,serverFacet,filteredOut,page,pageSize,pages,totalPages,total,hasMore,degraded,hints,sourceErrors';

  // A. 真机形（lead 探针 ms177-tailbogus / ms177-msref）：handler 无 serverFacet、无 facetUsed，
  // 行是没按分类筛过的混合行，整源 total 被当成「该类目录数」。
  const leakRows = () => ([
    { slug: 'leak-1', name: 'leak-1', source: 'modelscope', category: '开发工具' },
    { slug: 'leak-2', name: 'leak-2', source: 'modelscope', category: '媒体处理' },
  ]);
  const storeA = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstA = await storeA.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['__bogus_category__', '__bogus_slow__'],
    // 两个沉默类错时返回：快的那个先落地，才能被轮询到「unproven」这一程的 stage
    // （慢的那个还在跑，会话未收口）。单类会话里拒证与收口同 tick，中间态不可观测。
    handlers: { modelscope: async (opts) => { if (!opts.category) return { source: 'modelscope', items: [mkItem('modelscope', 9)], total: 1, hasMore: true, categoryInfo: true }; await sleep(String(opts.category).indexOf('slow') < 0 ? 30 : 320); return { source: 'modelscope', items: leakRows(), total: 89063, hasMore: true, categoryInfo: true }; } },
  });
  const runA = await drain13(storeA, firstA, 120);
  const tA = (runA.fin.meta || {}).tail || {};
  check('I4 什么都不声明的 handler 不算成功（缺证 ⇒ unproven）', tA.categoriesTotal === 2 && tA.categoriesFetched === 0 && tA.categoriesFailed === 2, JSON.stringify(tA));
  check('I2 未过滤的行一条都不许进会话（retrievedTotal=0 且 leak 行不在行集）', tA.retrievedTotal === 0 && !runA.fin.rows.some((r) => String(r.slug).indexOf('leak-') === 0), JSON.stringify(runA.fin.rows.map((r) => r.slug)));
  check('I3 整源 total 不得冒充该类合计（upstreamTotal=0）', tA.upstreamTotal === 0, String(tA.upstreamTotal));
  // 拒因可见性另开一个会话测：A 会话里没有任何可证行（扇出无分类行被谓词拒收、
  // 逐类又全无正证），首包循环只能一路等到 done，中间包根本不存在——那不是缺证，
  // 是会话本来就没有可推的东西。A2 用一行「category 命中 covers」的合法扇出行打开
  // 首包，unproven 这一程的 stage 才真的可观测（run 3 谓词后 A 会话只剩这条能拆出来测）。
  const storeA2 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstA2 = await storeA2.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['__bogus_category__', '__bogus_slow__'],
    handlers: { modelscope: async (opts) => { if (!opts.category) return { source: 'modelscope', items: [{ slug: 'fan-member', name: 'fan-member', source: 'modelscope', category: '__bogus_category__' }], total: 1, hasMore: true, categoryInfo: true }; await sleep(String(opts.category).indexOf('slow') < 0 ? 30 : 320); return { source: 'modelscope', items: leakRows(), total: 89063, hasMore: true, categoryInfo: true }; } },
  });
  const runA2 = await drain13(storeA2, firstA2, 120);
  const tA2 = (runA2.fin.meta || {}).tail || {};
  check('I4 拒因可见：中间包 stage 带 unproven', runA2.pkgs.some((p) => p.done !== true && /unproven/.test(String(p.stage || ''))), JSON.stringify(runA2.pkgs.map((p) => p.stage).slice(0, 6)));
  check('T14b(甲) 谓词放行后首包即带合法成员行，不待逐类落地（A2 缺证类仍不计 fetched）', runA2.fin.rows.map((r) => r.slug).includes('fan-member') && tA2.categoriesFetched === 0 && tA2.categoriesFailed === 2 && tA2.retrievedTotal === 0 && (runA2.fin.meta || {}).total === 1, JSON.stringify({ slugs: runA2.fin.rows.map((r) => r.slug), tail: tA2, total: (runA2.fin.meta || {}).total }));
  // run 3：tail 态那条扇出默认页行没有分类，成员身份不可证 ⇒ 一并拒收（total=0）。
  check('I2 缺证态收口 total 只数可信行（tail 态无分类扇出行不入账 ⇒ 0）', (runA.fin.meta || {}).total === 0 && !runA.fin.rows.some((r) => r.slug === 'modelscope-9'), 'total=' + (runA.fin.meta || {}).total + ' rows=' + JSON.stringify(runA.fin.rows.map((r) => r.slug)));

  // B. 行「看着像」该分类也不作数：正证只能来自源的声明，不能从行反推（I4 字面）。
  const storeB = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstB = await storeB.start({
    query: '', source: 'lobehub', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['pdf'],
    handlers: { lobehub: async (opts) => (opts.category
      ? { source: 'lobehub', items: [{ slug: 'row-pdf', name: 'row-pdf', source: 'lobehub', category: String(opts.category) }], total: 4210, hasMore: false, categoryInfo: true }
      : { source: 'lobehub', items: [mkItem('lobehub', 9)], total: 1, hasMore: false }) },
  });
  const runB = await drain13(storeB, firstB, 120);
  const tB = (runB.fin.meta || {}).tail || {};
  check('I4 只凭行内分类反推不算证明（仍计 unproven，行数不入账）', tB.categoriesFetched === 0 && tB.categoriesFailed === 1 && tB.retrievedTotal === 0, JSON.stringify(tB));

  // C. facetUsed 与 slug 的大小写/空格差异必须仍算正证（归一化比较，不是逐字节比较）。
  const storeC = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstC = await storeC.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['alpha'],
    handlers: { skillsmp: async (opts) => (opts.category
      ? { source: 'skillsmp', items: [mkItem('skillsmp', 1)], total: 5, hasMore: false, facetUsed: '  ALPHA ' }
      : { source: 'skillsmp', items: [mkItem('skillsmp', 9)], total: 1, hasMore: false }) },
  });
  const runC = await drain13(storeC, firstC, 120);
  const tC = (runC.fin.meta || {}).tail || {};
  check('I4 facetUsed 归一后与 slug 相等即算正证（免 serverFacet）', tC.categoriesFetched === 1 && tC.retrievedTotal === 1 && tC.upstreamTotal === 5, JSON.stringify(tC));

  // D. 只有 serverFacet=true 的源（lobehub 形，无 facetUsed）同样是正证 —— 两个途径都要成立。
  const storeD = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstD = await storeD.start({
    query: '', source: 'lobehub', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['design'],
    handlers: { lobehub: async (opts) => (opts.category
      ? { source: 'lobehub', items: [mkItem('lobehub', 2)], total: 3074, totalPages: 615, hasMore: true, serverFacet: true }
      : { source: 'lobehub', items: [mkItem('lobehub', 9)], total: 1, hasMore: false }) },
  });
  const runD = await drain13(storeD, firstD, 120);
  const tD = (runD.fin.meta || {}).tail || {};
  check('I4 serverFacet===true 单独成立（lobehub 形无 facetUsed）', tD.categoriesFetched === 1 && tD.retrievedTotal === 1 && tD.upstreamTotal === 3074, JSON.stringify(tD));

  // E. I6：本地过滤源的合计口径与窗口封顶源不同，只能写在 hint 里，不得加第七个字段。
  const storeE = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstE = await storeE.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 2, cache: null,
    tailCategories: ['dev'], tailConcurrency: 1,
    handlers: { modelscope: async (opts) => (opts.category
      ? { source: 'modelscope', items: [mkItem('modelscope', 1), mkItem('modelscope', 2)], total: 900, hasMore: false, categoryInfo: true, facetUsed: 'dev' }
      : { source: 'modelscope', items: [mkItem('modelscope', 9)], total: 1, hasMore: false, categoryInfo: true }) },
  });
  const runE = await drain13(storeE, firstE, 120);
  const hintE = String((runE.fin.meta || {}).hints || []);
  check('I6 本地过滤源的合计口径写进 hint（不谎称上游目录数，也不写窗口话）', tA && (runE.fin.meta || {}).tail && (runE.fin.meta || {}).tail.categoriesFetched === 1 && /可达集合|本地过滤/.test(hintE) && !/窗口之外/.test(hintE), hintE.slice(0, 240));
  const storeF = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstF = await storeF.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 2, cache: null,
    tailCategories: ['win'], tailConcurrency: 1,
    handlers: { skillsmp: async (opts) => (opts.category
      ? { source: 'skillsmp', items: [mkItem('skillsmp', 1)], total: 545885, totalPages: 20, hasMore: true, serverFacet: true, facetUsed: 'win', windowed: true }
      : { source: 'skillsmp', items: [mkItem('skillsmp', 9)], total: 1, hasMore: false }) },
  });
  const runF = await drain13(storeF, firstF, 120);
  check('I6 窗口封顶源仍说窗口（两种口径不混写）', /窗口之外/.test(String((runF.fin.meta || {}).hints || [])), JSON.stringify((runF.fin.meta || {}).tail));

  // G. I7-1 串台：命中缓存条目带来的声明只能证明它自己那一类；换分类必须落到不同键。
  const readsG = [];
  const cacheG = {
    get: async (k) => { readsG.push(k); return { source: 'modelscope', items: [{ slug: 'cached-a', name: 'cached-a', source: 'modelscope', category: '开发工具' }], categoryInfo: true, facetUsed: '开发工具', total: 300, hasMore: false }; },
    put: async () => {},
  };
  const storeG = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstG = await storeG.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 24, cache: cacheG,
    tailCategories: ['开发工具', '媒体处理'], tailConcurrency: 1,
    handlers: { modelscope: async (opts) => esMod13.searchModelScope(Object.assign({}, opts, { transport: async () => { throw new Error('不该打上游'); } })) },
  });
  const runG = await drain13(storeG, firstG, 120);
  const tG = (runG.fin.meta || {}).tail || {};
  check('I7 A 分类的缓存声明不得替 B 分类作证（B 计 unproven）', tG.categoriesFetched === 1 && tG.categoriesFailed === 1 && tG.retrievedTotal === 1, JSON.stringify(tG));
  check('I7 换分类必须读到不同的缓存键（键含分类维度）', readsG.length >= 2 && new Set(readsG).size === readsG.length, JSON.stringify(readsG));
  const esBody13 = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  const msKeyLine13 = String(esBody13.split(/\r?\n/).find((l) => /const cacheKey = .modelscope:search:/.test(l)) || '');
  check('I7 源码锁：modelscope cacheKey 带分类 token', /modelscopeCategoryCacheToken\(category\)/.test(msKeyLine13), msKeyLine13.trim().slice(0, 160));

  // H. I7-2：旧版本写的、不带声明字段的缓存条目命中 ⇒ 计 rejected、不计 fetched（宁可少不可谎）。
  const cacheH = {
    get: async () => ({ source: 'modelscope', items: [{ slug: 'old-cache', name: 'old-cache', source: 'modelscope', category: '开发工具' }], categoryInfo: true, total: 300, hasMore: false }),
    put: async () => {},
  };
  const storeH = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstH = await storeH.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 24, cache: cacheH,
    tailCategories: ['开发工具'], tailConcurrency: 1,
    // 扇出那次不走缓存桩（否则 old-cache 行会从扇出合法进会话，判定就测不到东西）：
    // 只有带 category 的逐类调用命中「旧版本写的、无声明键」的缓存条目。
    handlers: { modelscope: async (opts) => (opts.category
      ? esMod13.searchModelScope(Object.assign({}, opts, { transport: async () => { throw new Error('不该打上游'); } }))
      : { source: 'modelscope', items: [mkItem('modelscope', 9)], total: 1, hasMore: true, categoryInfo: true }) },
  });
  const runH = await drain13(storeH, firstH, 120);
  const tH = (runH.fin.meta || {}).tail || {};
  check('I7 缓存里的无声明条目 ⇒ rejected（不得为旧缓存开后门）', tH.categoriesFetched === 0 && tH.categoriesFailed === 1 && tH.retrievedTotal === 0 && !runH.fin.rows.some((r) => r.slug === 'old-cache'), JSON.stringify(tH));

  // I. 源侧声明（extra-sources.js 范围内）：modelscope 词表内分类回 facetUsed=该分类，绝不声明 serverFacet。
  const mkTr = (cat) => async (_u, init) => {
    const b = JSON.parse(String(init.body));
    const rows = [];
    if (b.PageNumber <= 2) for (let i = 0; i < 3; i++) rows.push({ Name: 'm-p' + b.PageNumber + '-i' + i, DisplayName: 'M' + i, Path: 'o' + b.PageNumber, L1: { ChineseName: cat } });
    return { ok: true, json: async () => ({ Data: { SkillList: rows, TotalCount: 3500 } }) };
  };
  const directOk = await esMod13.searchModelScope({ query: '', page: 1, pageSize: 24, category: '开发工具', sort: '', cache: null, transport: mkTr('开发工具'), harvestBypass: true });
  check('源侧声明：modelscope 词表内分类 facetUsed === 该分类', directOk.facetUsed === '开发工具', JSON.stringify(directOk.facetUsed));
  check('I7 modelscope 的 serverFacet 不得为 true（本地过滤≠服务端已筛）', directOk.serverFacet === undefined && directOk.categoryInfo === true, JSON.stringify(directOk.serverFacet));
  const directBad = await esMod13.searchModelScope({ query: '', page: 1, pageSize: 24, category: '__bogus_category__', sort: '', cache: null, transport: mkTr('开发工具'), harvestBypass: true });
  check('源侧声明：表外分类 facetUsed 必须是空串（让 tail 判定拒掉）', directBad.facetUsed === '' && directBad.serverFacet === undefined, JSON.stringify({ f: directBad.facetUsed, s: directBad.serverFacet }));
  const msStart13 = esBody13.indexOf('export async function searchModelScope');
  const msEnd13 = esBody13.indexOf('export async function modelScopeSkill');
  check('I7 源码锁：searchModelScope 体内不出现 serverFacet 字样', msStart13 > 0 && msEnd13 > msStart13 && esBody13.slice(msStart13, msEnd13).indexOf('serverFacet') < 0, msStart13 + '/' + msEnd13);

  // J. skillhub 源侧声明本批不做（lead m00836 裁定，列 0.5.178）：src/skillhub.js 出参无 facetUsed/serverFacet
  // ⇒ 词表内成功类也只能走 unproven。这是刻意的过渡态，本条锁住「不许在聚合层凭空替 skillhub 作证」。
  const storeJ = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstJ = await storeJ.start({
    query: '', source: 'skillhub', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['office-efficiency'],
    handlers: { skillhub: async (opts) => (opts.category
      ? { source: 'skillhub', items: [mkItem('skillhub', 3)], total: 13966, hasMore: false }
      : { source: 'skillhub', items: [mkItem('skillhub', 9)], total: 1, hasMore: false }) },
  });
  const runJ = await drain13(storeJ, firstJ, 120);
  const tJ = (runJ.fin.meta || {}).tail || {};
  check('过渡态：skillhub 未自述 facet ⇒ 成功类也计 unproven（0.5.178 源侧自描述后翻正）', tJ.categoriesFetched === 0 && tJ.categoriesFailed === 1 && tJ.retrievedTotal === 0, JSON.stringify(tJ));

  // K. I5：收紧判定后，一次性 skills.search 出参键序仍逐字不变。
  const oneK13 = await searchSkills({ query: '', source: 'modelscope', page: 1, pageSize: 24, category: '', cache: null, handlers: { modelscope: async () => ({ source: 'modelscope', items: [mkItem('modelscope', 1)], total: 1, hasMore: false, categoryInfo: true, facetUsed: '开发工具' }) } });
  check('I5 modelscope 形一次性出参键序仍为 13 键', Object.keys(oneK13).join(',') === KEY13, Object.keys(oneK13).join(','));
  const oneK13b = await searchSkills({ query: '', source: 'skillhub', page: 1, pageSize: 24, category: '', cache: null, handlers: { skillhub: async () => ({ source: 'skillhub', items: [mkItem('skillhub', 1)], total: 1, hasMore: false }) } });
  check('I5 skillhub 形一次性出参键序仍为 13 键', Object.keys(oneK13b).join(',') === KEY13, Object.keys(oneK13b).join(','));
  const oneK13c = await searchSkills({ query: '', source: 'modelscope', page: 1, pageSize: 24, category: '开发工具', cache: null, handlers: { modelscope: async () => ({ source: 'modelscope', items: [mkItem('modelscope', 1)], total: 1, hasMore: false, categoryInfo: true, facetUsed: '开发工具' }) } });
  check('I5 分类态一次性通路不因 facetUsed 而跳服（facetUsed 不参与聚合 facet 计票）', oneK13c.serverFacet === false && oneK13c.items.length === 1, JSON.stringify({ sf: oneK13c.serverFacet, n: oneK13c.items.length }));
  check('I5 六字段口径未扩（tail 仍是 C3 的六个键）', Object.keys(tG).sort().join(',') === 'categoriesFailed,categoriesFetched,categoriesTotal,retrievedTotal,upstreamTotal,windowed', Object.keys(tG).join(','));
  // L. I7-1：声明必须写在「被缓存的那个对象」里。命中路径原样返回缓存条目 ⇒ 证明穿过缓存存活；
  //    把 facetUsed 挪到 return 之后再现造（缓存对象里没有）就会被这条抓到。
  const spyL = new Map();
  const cacheL = { get: async (k) => spyL.get(k), put: async (k, v) => { spyL.set(k, v); } };
  await esMod13.searchModelScope({ query: '', page: 1, pageSize: 24, category: '开发工具', sort: '', cache: cacheL, transport: mkTr('开发工具'), harvestBypass: true });
  const storedL = [...spyL.entries()].filter(([k]) => k.indexOf('modelscope:search:') === 0);
  check('I7 写进缓存的条目自带 facetUsed（声明不在 return 之后现造）', storedL.length === 1 && Boolean(storedL[0][1]) && storedL[0][1].facetUsed === '开发工具', JSON.stringify(storedL.map(([k, v]) => [k, v && v.facetUsed])));
  const hitL = await esMod13.searchModelScope({ query: '', page: 1, pageSize: 24, category: '开发工具', sort: '', cache: cacheL, transport: async () => { throw new Error('不该打上游'); }, harvestBypass: true });
  check('I7 命中路径带出 facetUsed 且不越权声明 serverFacet', hitL.facetUsed === '开发工具' && hitL.serverFacet === undefined, JSON.stringify({ f: hitL.facetUsed, s: hitL.serverFacet }));
  const storeL = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstL = await storeL.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 24, cache: cacheL,
    tailCategories: ['开发工具'], tailConcurrency: 1,
    handlers: { modelscope: async (opts) => esMod13.searchModelScope(Object.assign({}, opts, { transport: async () => { throw new Error('不该打上游'); } })) },
  });
  const runL = await drain13(storeL, firstL, 120);
  const tL = (runL.fin.meta || {}).tail || {};
  check('I7 缓存命中的声明足以作证（tail 计 fetched，行集非空）', tL.categoriesFetched === 1 && tL.categoriesFailed === 0 && tL.retrievedTotal >= 1, JSON.stringify(tL));
  const msBody13 = esBody13.slice(esBody13.indexOf('export async function searchModelScope'), esBody13.indexOf('export async function modelScopeSkill'));
  check('I7 源码锁：facetUsed 写在 result 字面量内（缓存 put 的同一个对象）', /const result = \{[\s\S]{0,240}facetUsed: catActive/.test(msBody13), msBody13.slice(msBody13.indexOf('const result ='), msBody13.indexOf('const result =') + 120).replace(/\r/g, ''));
}

// ---------- Test 14: tail 态成员集合（一条谓词管住 push 与收口；不可证的行不许挂到「其他」下） ----------
{
  const drain14 = async (store, first, rounds) => {
    const pkgs = [first];
    let fin = first;
    for (let i = 0; i < rounds && !fin.done; i++) { await sleep(15); const q = store.poll(first.id); if (!q) break; pkgs.push(q); fin = q; }
    return { pkgs, fin };
  };
  const R = (slug, cat) => {
    const it = { slug: slug, name: slug, source: 'skillsmp', installs: 1 };
    if (cat !== null) it.category = cat;
    return it;
  };
  // covers = alpha + gamma。扇出默认页三行：f-cover(alpha 属合并集，合法成员)、
  // f-out(beta 是窗内别类，拒收)、f-plain(无分类，成员身份不可证，拒收)。
  // 逐类取数：alpha 作证后回 2 行（含一行无分类 —— 该类已被上游接受，整类归因成立）、
  // gamma 作证后回 1 行、delta 被 facet 拒 ⇒ 计 failed 且不推行。
  const tailStore14 = () => makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const handlers14 = {
    skillsmp: async (opts) => {
      if (!opts.category) return { source: 'skillsmp', items: [R('f-cover', 'alpha'), R('f-out', 'beta'), R('f-plain', null)], total: 3, totalPages: 1, hasMore: false };
      if (opts.category === 'alpha') return { source: 'skillsmp', items: [R('t-a1', 'alpha'), R('t-plain', null)], total: 10, hasMore: false, serverFacet: true, facetUsed: 'alpha' };
      if (opts.category === 'gamma') return { source: 'skillsmp', items: [R('t-g1', 'gamma')], total: 20, hasMore: false, facetUsed: 'gamma' };
      return { source: 'skillsmp', items: [R('t-d1', 'alpha')], total: 99, hasMore: false, facetUsed: '' };
    },
  };
  const store14 = tailStore14();
  const first14 = await store14.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 2, cache: null,
    tailCategories: ['alpha', 'gamma', 'delta'], tailConcurrency: 1, handlers: handlers14,
  });
  const run14 = await drain14(store14, first14, 160);
  const slugs14 = run14.fin.rows.map((r) => r.slug);
  const t14 = (run14.fin.meta || {}).tail || {};
  check('T14a 扇出里 category 不属于 covers 的行不进收口行集', !slugs14.includes('f-out'), JSON.stringify(slugs14));
  check('T14a 扇出里 category 不属于 covers 的行也不进任何中间包', run14.pkgs.every((p) => (p.rows || []).every((r) => r.slug !== 'f-out')), JSON.stringify(run14.pkgs.map((p) => (p.rows || []).map((r) => r.slug))));
  check('T14c 扇出的无分类行被拒收（收口与中间包都不含）', !slugs14.includes('f-plain') && run14.pkgs.every((p) => (p.rows || []).every((r) => r.slug !== 'f-plain')), JSON.stringify(slugs14));
  check('T14b 扇出里 category 属于 covers 的行照常进（不许一刀切丢默认页）', slugs14.includes('f-cover'), JSON.stringify(slugs14));
  check('T14c 逐类取数返回的无分类行被放行（两类来源不同答案）', slugs14.includes('t-plain') && slugs14.includes('t-a1') && slugs14.includes('t-g1'), JSON.stringify(slugs14));
  check('T14 被 facet 拒的类一行都不进（t-d1 不入账）', !slugs14.includes('t-d1'), JSON.stringify(slugs14));
  check('T14d 收口 meta.total === 行集条数 === tail.retrievedTotal + 扇出合法成员数', run14.fin.meta.total === run14.fin.rows.length && run14.fin.meta.total === t14.retrievedTotal + 1, JSON.stringify({ total: run14.fin.meta.total, n: run14.fin.rows.length, retrieved: t14.retrievedTotal }));
  check('T14d 可加性读数：retrievedTotal=3（逐类）／扇出合法成员=1／total=4', t14.retrievedTotal === 3 && run14.fin.rows.length === 4 && run14.fin.meta.total === 4, JSON.stringify({ retrieved: t14.retrievedTotal, rows: run14.fin.rows.length, total: run14.fin.meta.total }));
  check('T14 谓词拒收不改 categories* 口径（fetched=2／failed=1／upstream=30）', t14.categoriesTotal === 3 && t14.categoriesFetched === 2 && t14.categoriesFailed === 1 && t14.upstreamTotal === 30 && t14.windowed === false, JSON.stringify(t14));
  check('T14 六字段仍冻结（一个不加一个不改名）', Object.keys(t14).sort().join(',') === 'categoriesFailed,categoriesFetched,categoriesTotal,retrievedTotal,upstreamTotal,windowed', Object.keys(t14).join(','));
  check('T14 收口分页口径与行集自洽（pages=ceil(4/2)=2、hasMore=false、serverFacet=false）', run14.fin.meta.pages === 2 && run14.fin.meta.hasMore === false && run14.fin.meta.serverFacet === false, JSON.stringify({ pages: run14.fin.meta.pages, hasMore: run14.fin.meta.hasMore, sf: run14.fin.meta.serverFacet }));

  // T14e 谓词只作用于 tail 态：非 tail 会话（单类态 / all 态）行集逐条不变。
  const store14b = tailStore14();
  const first14b = await store14b.start({
    query: '', source: 'skillsmp', category: '', page: 1, pageSize: 2, cache: null, handlers: handlers14,
  });
  const run14b = await drain14(store14b, first14b, 60);
  check('T14e 非 tail 会话（浏览态）行集与 meta 逐条不变（pages=1 由 D1 夹深度口径给出，谓词不改它）', run14b.fin.rows.map((r) => r.slug).join(',') === 'f-cover,f-out,f-plain' && run14b.fin.meta.total === 3 && run14b.fin.meta.pages === 1 && run14b.fin.meta.tail === undefined, JSON.stringify({ slugs: run14b.fin.rows.map((r) => r.slug), total: run14b.fin.meta.total, pages: run14b.fin.meta.pages, tail: run14b.fin.meta.tail }));
  const store14c = tailStore14();
  const first14c = await store14c.start({
    query: '', source: 'all', category: 'alpha', page: 1, pageSize: 2, cache: null,
    handlers: {
      skillsmp: async () => ({ source: 'skillsmp', items: [R('s-plain', null), R('s-out', 'beta')], total: 2, hasMore: false }),
      lobehub: async () => ({ source: 'lobehub', items: [{ slug: 'l-1', name: 'l-1', source: 'lobehub', category: 'alpha', installs: 2 }], total: 1, hasMore: false }),
    },
  });
  const run14c = await drain14(store14c, first14c, 60);
  const got14c = run14c.fin.rows.map((r) => r.slug).sort().join(',');
  check('T14e all 态单类浏览不因谓词丢行（本地过滤口径照旧：s-out 被旧有过滤剔掉，非谓词所为）', got14c === 'l-1,s-plain' && run14c.fin.meta.tail === undefined, got14c);
  check('T14e 非 tail 会话收口 meta 仍取折叠口径（本地过滤重算 total=2，谓词不改它）', run14c.fin.meta.total === 2 && run14c.fin.meta.tail === undefined, JSON.stringify({ total: run14c.fin.meta.total, tail: run14c.fin.meta.tail }));
}

// ---------- Test 15: 分类能力自描述（category-capability）—— 名单只活一份，声明只认正证 ----------
{
  const cc15 = await import('../src/category-capability.js');
  const sources15 = await import('../src/sources.js');
  const cap15 = await import('../src/skillhub.js');
  // Test 13/14 的 drain 是块级作用域，本块自带一份（轮询节奏一致）。
  const drain15 = async (store, first, rounds) => {
    const pkgs = [first];
    let fin = first;
    for (let i = 0; i < rounds && !fin.done; i++) { await sleep(15); const q = store.poll(first.id); if (!q) break; pkgs.push(q); fin = q; }
    return { pkgs, fin };
  };

  // K1 名单只活一份：sources.js 里不得再出现硬编码 TAIL_CATEGORY_SOURCES（主锚，改前必红）。
  const src15 = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  check('K1 TAIL_CATEGORY_SOURCES 硬名单已删（选源唯一入口 pickTailCategorySource）', absent(src15, 'TAIL_CATEGORY_SOURCES') && src15.includes('pickTailCategorySource(picked)'), '残留次数=' + (src15.split('TAIL_CATEGORY_SOURCES').length - 1));
  const cc15Body = fs.readFileSync(path.join(W, 'src/category-capability.js'), 'utf8');
  check('K1 能力表覆盖 ALL_SOURCES 八源逐字（一份表，零名单抄写）', ['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'browse.sh', 'lobehub', 'skillhub', 'modelscope'].every((n) => cc15Body.includes('"' + n + '"')), '');

  // K2 逐源能力判读：八源各自的能力与口径，与实测记录一致（改表先重新实测）。
  const wantK2 = [
    ['skills.sh', false, 'none'], ['clawhub', true, 'declared'], ['skillsmp', true, 'declared'],
    ['trusttools', true, 'declared'], ['browse.sh', false, 'none'], ['lobehub', true, 'declared'],
    ['skillhub', true, 'declared'], ['modelscope', true, 'local-filter'],
  ];
  for (const pair of wantK2) {
    const got = cc15.categoryCapability(pair[0]);
    check('K2 ' + pair[0] + ' => supportsCategory=' + pair[1] + ' facetProof=' + pair[2], got.supportsCategory === pair[1] && got.facetProof === pair[2], JSON.stringify(got));
  }
  const capList15 = cc15.categoryCapableSources(['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'browse.sh', 'lobehub', 'skillhub', 'modelscope']);
  check('K2 categoryCapableSources 派生名单 = 旧硬名单逐字（不存在第二份名单）', capList15.join(',') === 'clawhub,skillsmp,trusttools,lobehub,skillhub,modelscope', capList15.join(','));
  check('K2 modelscope 属 local-filter（合计口径写 hint，不冒充服务端已筛）', cc15.isLocalFilterSource('modelscope') === true && cc15.isLocalFilterSource('clawhub') === false && cc15.isLocalFilterSource('') === false, '');

  // K3 保守回落 + 注入谓词的自证通路。
  check('K3 表外源 github 保守 false（unknown 不是 capability）', cc15.categoryCapability('github').supportsCategory === false && cc15.categoryCapability('github').known === false, JSON.stringify(cc15.categoryCapability('github')));
  check('K3 空串与 undefined 同为 false 且不抛', cc15.categoryCapability('').supportsCategory === false && cc15.categoryCapability(undefined).supportsCategory === false, '');
  check('K3 pickTailCategorySource 默认谓词取首个有能力源', sources15.pickTailCategorySource(['skills.sh', 'clawhub', 'skillsmp']) === 'clawhub', String(sources15.pickTailCategorySource(['skills.sh', 'clawhub', 'skillsmp'])));
  check('K3 pickTailCategorySource 注入谓词可达（判据自证注入通路）', sources15.pickTailCategorySource(['a', 'b', 'c'], (n) => n === 'b') === 'b' && sources15.pickTailCategorySource(['x'], () => false) === '', '');
  check('K3 非数组 picked 返回空串不抛', sources15.pickTailCategorySource(undefined) === '' && sources15.pickTailCategorySource(null) === '', '');

  // K4 无能力源整批计失败，一次上游都不打（旧名单语义由能力表接住）。
  const callsK4 = [];
  const storeK4 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstK4 = await storeK4.start({
    query: '', source: 'github', category: '', page: 1, pageSize: 2, cache: null,
    tailCategories: ['c1', 'c2'],
    handlers: { github: async (opts) => { callsK4.push(String(opts.category || '')); return { source: 'github', items: [mkItem('github', 1)], total: 1, hasMore: false }; } },
  });
  const runK4 = await drain15(storeK4, firstK4, 60);
  const tK4 = (runK4.fin.meta || {}).tail || {};
  check('K4 无能力源 failed=2/fetched=0/retrieved=0', tK4.categoriesFailed === 2 && tK4.categoriesFetched === 0 && tK4.retrievedTotal === 0, JSON.stringify(tK4));
  // 只数「带分类的逐类调用」：基础扇出那次 category='' 是浏览页本身，不属于 tail 通路。
  const tailCallsK4 = callsK4.filter((c) => c !== '');
  check('K4 无能力源零逐类调用（一次分类请求都不发）', tailCallsK4.length === 0, JSON.stringify(callsK4));

  // K5 六源各起一次 tail：按各源真实声明形回包，fetched=1 且行集非空、六字段口径不扩。
  const handlersK5 = {
    clawhub: async (opts) => (opts.category ? { source: 'clawhub', items: [mkItem('clawhub', 1)], total: 100, hasMore: false, facetUsed: opts.category } : { source: 'clawhub', items: [mkItem('clawhub', 9)], total: 1, hasMore: false }),
    skillsmp: async (opts) => (opts.category ? { source: 'skillsmp', items: [mkItem('skillsmp', 1)], total: 200, hasMore: false, serverFacet: true, facetUsed: opts.category } : { source: 'skillsmp', items: [mkItem('skillsmp', 9)], total: 1, hasMore: false }),
    trusttools: async (opts) => (opts.category ? { source: 'trusttools', items: [mkItem('trusttools', 1)], total: 300, hasMore: false, serverFacet: true } : { source: 'trusttools', items: [mkItem('trusttools', 9)], total: 1, hasMore: false }),
    lobehub: async (opts) => (opts.category ? { source: 'lobehub', items: [mkItem('lobehub', 1)], total: 400, totalPages: 5, hasMore: false, serverFacet: true } : { source: 'lobehub', items: [mkItem('lobehub', 9)], total: 1, hasMore: false }),
    skillhub: async (opts) => (opts.category ? { source: 'skillhub', items: [mkItem('skillhub', 1)], total: 500, hasMore: false, facetUsed: opts.category, serverFacet: true } : { source: 'skillhub', items: [mkItem('skillhub', 9)], total: 1, hasMore: false }),
    modelscope: async (opts) => (opts.category ? { source: 'modelscope', items: [{ slug: 'ms-k5', name: 'ms-k5', source: 'modelscope', category: opts.category, installs: 1 }], total: 600, hasMore: false, categoryInfo: true, facetUsed: opts.category } : { source: 'modelscope', items: [mkItem('modelscope', 9)], total: 1, hasMore: false, categoryInfo: true }),
  };
  const slugsK5 = [['clawhub', 'c-cat'], ['skillsmp', 's-cat'], ['trusttools', 't-cat'], ['lobehub', 'l-cat'], ['skillhub', 'office-efficiency'], ['modelscope', '开发工具']];
  for (const pair of slugsK5) {
    const storeK5 = makeHarvestStore({ ttlMs: 30000, maxSessions: 8 });
    const firstK5 = await storeK5.start({
      query: '', source: pair[0], category: '', page: 1, pageSize: 2, cache: null,
      tailCategories: [pair[1]], handlers: handlersK5,
    });
    const runK5 = await drain15(storeK5, firstK5, 120);
    const tK5 = (runK5.fin.meta || {}).tail || {};
    check('K5 ' + pair[0] + ' 正证通过（fetched=1/failed=0/行集非空）', tK5.categoriesFetched === 1 && tK5.categoriesFailed === 0 && tK5.retrievedTotal >= 1, JSON.stringify(tK5));
    check('K5 ' + pair[0] + ' 六字段口径不扩', Object.keys(tK5).sort().join(',') === 'categoriesFailed,categoriesFetched,categoriesTotal,retrievedTotal,upstreamTotal,windowed', Object.keys(tK5).join(','));
  }

  // K6 本地过滤口径只走 isLocalFilterSource：源名字面量不再出现在决策行。
  const storeK6 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstK6 = await storeK6.start({
    query: '', source: 'modelscope', category: '', page: 1, pageSize: 2, cache: null,
    tailCategories: ['开发工具'], tailConcurrency: 1, handlers: handlersK5,
  });
  const runK6 = await drain15(storeK6, firstK6, 120);
  const hintK6 = String((runK6.fin.meta || {}).hints || []);
  check('K6 modelscope 本地过滤口径写进 hint（可达集合，不说窗口之外）', /可达集合|本地过滤/.test(hintK6) && !/窗口之外/.test(hintK6), hintK6.slice(0, 200));
  const msLines = src15.split('\n').filter((l) => l.indexOf('msOnPartial:') >= 0 && String(l).trim().indexOf('//') !== 0);
  check('K6 源码锁：两处 msOnPartial 决策都不再写死源名', msLines.length === 2 && msLines.every((l) => l.indexOf('modelscope') < 0 && l.indexOf('isLocalFilterSource') >= 0), JSON.stringify(msLines));

  // K7 skillhub 源侧声明三形：全等才作证；不带类 / 混别类都闭嘴（反证主锚）。
  const feedK7 = (rows) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, message: 'success', data: { skills: rows, total: rows.length } }) }); };
  let ok7, none7, mixed7;
  try {
    feedK7([{ slug: 'sh-a', name: 'A', category: 'office-efficiency' }, { slug: 'sh-b', name: 'B', category: 'office-efficiency' }]);
    ok7 = await cap15.searchSkills({ query: '', page: 1, pageSize: 20, category: 'office-efficiency', cache: null });
    feedK7([{ slug: 'sh-a', name: 'A', category: 'office-efficiency' }]);
    none7 = await cap15.searchSkills({ query: '', page: 1, pageSize: 20, category: '', cache: null });
    feedK7([{ slug: 'sh-a', name: 'A', category: 'office-efficiency' }, { slug: 'sh-x', name: 'X', category: 'dev-programming' }]);
    mixed7 = await cap15.searchSkills({ query: '', page: 1, pageSize: 20, category: 'office-efficiency', cache: null });
  } finally { delete globalThis.fetch; }
  check('K7 带类且行集全等 => facetUsed=该类 + serverFacet=true', ok7.facetUsed === 'office-efficiency' && ok7.serverFacet === true, JSON.stringify({ f: ok7.facetUsed, s: ok7.serverFacet }));
  check('K7 不带类 => 声明位空/false（浏览态不作证）', none7.facetUsed === '' && none7.serverFacet === false, JSON.stringify({ f: none7.facetUsed, s: none7.serverFacet }));
  check('K7 混别类 => 闭嘴（空串/false，反证「全等才作证」）', mixed7.facetUsed === '' && mixed7.serverFacet === false, JSON.stringify({ f: mixed7.facetUsed, s: mixed7.serverFacet }));
  check('K7 出参前六键序未动（只在末尾追加声明位）', Object.keys(none7).slice(0, 6).join(',') === 'source,items,total,page,pageSize,hasMore', Object.keys(none7).join(','));

  // K8 过渡态翻正：skillhub 词表内成功类现在计 fetched（0.5.180 源侧自描述已落）。
  const storeK8 = makeHarvestStore({ ttlMs: 30000, maxSessions: 4 });
  const firstK8 = await storeK8.start({
    query: '', source: 'skillhub', category: '', page: 1, pageSize: 24, cache: null,
    tailCategories: ['office-efficiency'],
    handlers: { skillhub: async (opts) => (opts.category
      ? { source: 'skillhub', items: [mkItem('skillhub', 3)], total: 13966, hasMore: false, facetUsed: opts.category, serverFacet: true }
      : { source: 'skillhub', items: [mkItem('skillhub', 9)], total: 1, hasMore: false }) },
  });
  const runK8 = await drain15(storeK8, firstK8, 120);
  const tK8 = (runK8.fin.meta || {}).tail || {};
  check('K8 skillhub 成功类翻正 fetched=1/failed=0/retrieved=1', tK8.categoriesFetched === 1 && tK8.categoriesFailed === 0 && tK8.retrievedTotal === 1, JSON.stringify(tK8));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
