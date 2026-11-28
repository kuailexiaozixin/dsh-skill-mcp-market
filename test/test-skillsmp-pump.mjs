#!/usr/bin/env node
// test-skillsmp-pump.mjs — 0.5.190 后台补链泵（用户 m41100：「技能的完整性是核心、关键问题，
// 必须确保所有技能被完整取回」）。0.5.189 只保证「取不满时绝不谎报」；本批把「取满」变成
// 不依赖用户翻页的后台推进：预算有界、串行、单飞、可续、断链自愈复用三条腿。
// 全部注入 fetchJson/假时钟，不打真网；真机腿在收口探针 sk34。
let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d !== undefined ? '  [' + String(d).slice(0, 160) + ']' : '')); } };

// 相对说明符按本文件位置解析（Windows 下 pathname 的 /D:/... 陷阱不复发）
const mod = await import('../src/extra-sources.js');
const { warmSkillsMpCatalog, skillsMpPumpLoop, createSkillsMpDemand, noteSkillsMpDemand, searchSkillsMp } = mod;

// ── 夹具 ──────────────────────────────────────────────────────────────
function rawRow(i) {
  return { id: 'sk-' + i, name: 'pdf-tool-' + i, skillName: 'pdf-tool-' + i,
    description: 'd', githubUrl: 'https://github.com/o/r' + (i % 7), stars: 100 - i,
    forks: 5, updatedAt: '2026-01-01', branch: 'main', route: '/creats/o/r/s' + i,
    authorAvatar: '', contentLanguage: 'en' };
}
// 每页 48 行。deadCursor 分代（同 Test 24 教训）：旧代 C* 一律抛 Traceback，
// start 重启链发新代 R*（真上游重启后 nextCursor 也是新生成的）。
// stopAt=n ⇒ 第 n 次请求（1 基）起上游明说到底（hasNext=false、nextCursor 空）：
// stopAt=3 就是「三跳见底」，断言里的 reqs.length 与它逐一对齐，别写成 0 基的 off-by-one。
function mkCursorFn({ stopAt = Infinity, deadCursor = false } = {}) {
  const reqs = [];
  const fn = async (url) => {
    reqs.push(url);
    const u = new URL(url);
    const cursor = String(u.searchParams.get('cursor') || 'start');
    if (deadCursor && /^C\d+$/.test(cursor)) throw new Error('python 取数失败：Traceback (most recent call last): cursor expired');
    const hop = cursor === 'start' ? 0 : Number(cursor.slice(1));
    const pfx = deadCursor ? 'R' : 'C';
    const off = hop * 48;
    if (hop + 1 >= stopAt) {
      return { skills: Array.from({ length: 48 }, (_, i) => rawRow(off + i)),
        filters: {}, pagination: { totalAll: off + 48, total: off + 48, totalIsExact: true,
          hasNext: false, cursorPagination: true, nextCursor: '' } };
    }
    return { skills: Array.from({ length: 48 }, (_, i) => rawRow(off + i)),
      filters: {}, pagination: { totalAll: 545886, total: 545886, totalIsExact: true,
        hasNext: true, cursorPagination: true, nextCursor: pfx + (hop + 1) } };
  };
  fn.reqs = reqs;
  return fn;
}
// 内存假 cache：记录每次 get 用的 ttl（判据 T7 要看进度 TTL 不再 6 小时清零）
function mkStore(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  const gets = [];
  return {
    gets,
    map,
    async get(key, ttlMs) { gets.push({ key, ttlMs }); return map.get(key); },
    async put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
  };
}
const CAT = '{{SECRET_b94gck2c}}';
const catKey = (f, s) => CAT + (f || 'any') + (s ? ':' + s : '');
const stateOf = (store, f, s) => store.map.get(catKey(f, s));

console.log('Test 1: 公开面存在');
check('warmSkillsMpCatalog 是函数', typeof warmSkillsMpCatalog === 'function');
check('skillsMpPumpLoop 是函数', typeof skillsMpPumpLoop === 'function');
check('createSkillsMpDemand 是函数', typeof createSkillsMpDemand === 'function');
check('noteSkillsMpDemand 是函数', typeof noteSkillsMpDemand === 'function');
if (!passed) { console.log(passed + ' passed, ' + failed + ' failed'); process.exit(1); }

console.log('');
console.log('Test 2: 一轮泵受自身预算约束且每跳落盘（need 不再是翻页深度）');
{
  const store = mkStore();
  const fn = mkCursorFn();
  const r = await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 5, sleep: async () => {} });
  check('跑满 5 跳即停（不被翻页 need 卡死，也不无限打）', fn.reqs.length === 5, fn.reqs.length);
  check('行数 = 5×48', r.rows === 240, r.rows);
  check('落盘游标是第 5 跳的后继 C5', stateOf(store, 'debugging').cursor === 'C5', stateOf(store, 'debugging').cursor);
  check('未完成（done=false）', r.done === false);
}

console.log('');
console.log('Test 3: 第二轮从落盘游标续推，跨轮零重复');
{
  const store = mkStore();
  const fn = mkCursorFn();
  await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 5, sleep: async () => {} });
  const before = fn.reqs.length;
  const r = await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 3, sleep: async () => {} });
  check('第二跳带的是上一轮落盘游标 C5（从断点续，不从头重放）', /cursor=C5(&|$)/.test(fn.reqs[before]), fn.reqs[before]);
  check('行数续到 8×48', r.rows === 384, r.rows);
  const ids = stateOf(store, 'debugging').rows.map((x) => x.id);
  check('跨轮零重复', new Set(ids).size === ids.length, ids.length + '/' + new Set(ids).size);
}

console.log('');
console.log('Test 4: 同一目录并发只有一条链（keyset 链不可并行，第二个 join 同一条）');
{
  const store = mkStore();
  const fn = mkCursorFn();
  const p1 = warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 6, sleep: async () => {} });
  const p2 = warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 6, sleep: async () => {} });
  const [a, b] = await Promise.all([p1, p2]);
  check('总请求数 = 一条链的 6 跳（不是 12）', fn.reqs.length === 6, fn.reqs.length);
  check('两个调用都拿到终态 rows=288', a.rows === 288 && b.rows === 288, a.rows + '/' + b.rows);
  check('第二个调用标记为 join（不谎称自己跑了链）', (a.joined === false && b.joined === true) || (a.joined === true && b.joined === false), a.joined + '/' + b.joined);
}

console.log('');
console.log('Test 5: 上游明说到底 ⇒ done 落盘，之后不再打网络');
{
  const store = mkStore();
  const fn = mkCursorFn({ stopAt: 3 });
  const r1 = await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 10, sleep: async () => {} });
  check('第 3 跳后停（上游 hasNext=false/nextCursor 空）', r1.done === true && fn.reqs.length === 3, fn.reqs.length);
  check('doneReason=upstream（中毒复位腿不会重开它）', stateOf(store, 'debugging').doneReason === 'upstream', stateOf(store, 'debugging').doneReason);
  const n = fn.reqs.length;
  const r2 = await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 10, sleep: async () => {} });
  check('已到底的目录再泵 = 0 请求', fn.reqs.length === n && r2.done === true, fn.reqs.length - n);
}

console.log('');
console.log('Test 6: 死游标自愈在泵路径同样生效（复用三条腿，不另写一份链）');
{
  const store = mkStore({ [catKey('debugging')]: { rows: Array.from({ length: 48 }, (_, i) => rawRow(i)), cursor: 'C1', done: false, totalAll: 545886 } });
  const fn = mkCursorFn({ deadCursor: true });
  let threw = null;
  let r = null;
  try { r = await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: fn, rounds: 4, sleep: async () => {} }); }
  catch (e) { threw = e.message; }
  check('泵不因死游标抛错', threw === null, threw);
  check('第一跳撞死游标，第二跳从 start 重启', /cursor=C1(&|$)/.test(fn.reqs[0]) && /cursor=start(&|$)/.test(fn.reqs[1]), fn.reqs.slice(0, 2).map((u) => new URL(u).searchParams.get('cursor')).join(','));
  check('重启后进入追赶态并继续增长（rows>48）', r && r.rows > 48, r && r.rows);
}

console.log('');
console.log('Test 7: 进度装载 TTL 不再是 6 小时（空闲一夜 = 半截进度清零重来，违 m41100）');
{
  const store = mkStore();
  await warmSkillsMpCatalog(store, { facet: 'debugging', fetchJson: mkCursorFn(), rounds: 1, sleep: async () => {} });
  const g = store.gets.find((x) => x.key === catKey('debugging'));
  check('目录状态装载 TTL ≥ 7 天', g && g.ttlMs >= 7 * 24 * 3600 * 1000, g && g.ttlMs);
}

console.log('');
console.log('Test 8: 需求队列——最近翻过的优先，轮转不饿死，取完退场');
{
  const q = createSkillsMpDemand();
  q.note('pdf-tools'); q.note('debugging'); q.note('pdf-tools');
  check('重复 note 同一面不双份入队', q.size() === 2 && q.peek()[0] === 'pdf-tools', JSON.stringify(q.peek()));
  const q2 = createSkillsMpDemand();
  q2.note('a'); q2.note('b');
  const s1 = q2.next(); const s2 = q2.next(); const s3 = q2.next();
  check('next() 轮转：a→b→a（一面卡住不会饿死其余面）', s1.facet === 'a' && s2.facet === 'b' && s3.facet === 'a', [s1.facet, s2.facet, s3.facet].join(','));
  const q3 = createSkillsMpDemand();
  q3.note('a'); q3.note('b');
  q3.done('a');
  const after = q3.next();
  check('done() 的facet 退场', after.facet === 'b', after.facet);
  q3.done('b');
  check('空队列 next() 返回 null', q3.next() === null);
  const q4 = createSkillsMpDemand();
  q4.note(''); q4.note(''); q4.note('x');
  check('全库面（空 facet）也在队列且去重', q4.size() === 2, q4.size());
}

console.log('');
console.log('Test 9: 泵循环按队列轮转推进，可停');
{
  const store = mkStore();
  const fnA = mkCursorFn(); const fnB = mkCursorFn();
  const q = createSkillsMpDemand();
  q.note('alpha'); q.note('beta');
  const seen = [];
  const r = await skillsMpPumpLoop(store, {
    queue: q, rounds: 2, maxRounds: 2, sleep: async () => {},
    fetchJson: (url, o) => { const u = new URL(url); return (u.searchParams.get('category') === 'beta' ? fnB : fnA)(url, o); },
    onRound: (f) => seen.push(f),
  });
  check('两轮各推进一个 facet（轮转）', seen.length === 2 && seen[0] === 'alpha' && seen[1] === 'beta', seen.join(','));
  check('两面各得 2×48 行', stateOf(store, 'alpha').rows.length === 96 && stateOf(store, 'beta').rows.length === 96, stateOf(store, 'alpha') && stateOf(store, 'alpha').rows.length);
  check('loop 正常返回（跑完 maxRounds 自退，不吊住进程）', r && typeof r.rounds === 'number' && r.rounds === 2, JSON.stringify(r));
  // 已到底的 facet 从队列退场，不再占轮次
  const store2 = mkStore();
  const fn = mkCursorFn({ stopAt: 1 });
  const q2 = createSkillsMpDemand(); q2.note('alpha');
  const seen2 = [];
  await skillsMpPumpLoop(store2, { queue: q2, rounds: 20, maxRounds: 3, sleep: async () => {}, fetchJson: fn, onRound: (f) => seen2.push(f) });
  check('取完的 facet 退场（后续轮次空转不再打网络）', stateOf(store2, 'alpha').done === true && q2.size() === 0 && fn.reqs.length === 1, fn.reqs.length);
}

console.log('');
console.log('Test 10: 生产接线（源码锁）');
{
  const fs = await import('node:fs');
  const srcExt = fs.readFileSync(new URL('../src/extra-sources.js', import.meta.url), 'utf8');
  const srcSources = fs.readFileSync(new URL('../src/sources.js', import.meta.url), 'utf8');
  const srcIndex = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  check('泵复用 extendSkillsMpCatalog（链实现只有一份）', /warmSkillsMpCatalog[\s\S]{0,1200}?extendSkillsMpCatalog\(/.test(srcExt));
  check('searchSkillsMp 翻哪面就把哪面记进需求队列', /noteSkillsMpDemand\(/.test(srcExt.slice(srcExt.indexOf('export async function searchSkillsMp'))));
  check('warmMarketCache 挂泵（进程活就持续取全）', /skillsMpPumpLoop|startSkillsMpPump/.test(srcSources));
  check('调度定时器 unref（后台泵绝不阻止宿主退出）', /unref\?\.\(\)|\.unref\(\)/.test(srcExt));
  check('泵预算常量在场', /SKILLSMP_PUMP_ROUNDS/.test(srcExt) && /SKILLSMP_PUMP_GAP_MS/.test(srcExt));
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
