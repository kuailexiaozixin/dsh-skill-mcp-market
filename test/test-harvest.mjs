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
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
