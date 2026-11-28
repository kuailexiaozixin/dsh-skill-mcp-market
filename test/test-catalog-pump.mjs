// 0.5.191 逐源补链泵：clawhub 目录链挂上同一套「后台推进 + 单飞 + 进度 durable」。
// 为什么必须做（用户 m41100：「技能的完整性是核心、关键问题，必须确保所有技能被完整取回」）：
// clawhub 的 browse 是 28k+ 的无界游标流，而 extendClawHubCatalog 的轮次上界 MAX_ROUNDS=40、
// searchClawHub 的 need 又封顶 Math.min(2000, …)，目录装载 TTL 只有 6 小时（:251）——
// 也就是说用户不翻页它就不动，页面关了六小时后连已攒的进度都清零。0.5.190 已给 skillsmp
// 上了泵，本批把同样的泵扩到 clawhub，并把目录进度 TTL 换成 7 天（与 VOCAB_TTL 同量级）。
// 刻意不动 warmClawHubCatalog：test-warm-budget.mjs Test 3 用五条文本锁 + 五条变异反证
// 钉死了它的体内形态（含「取页直调 getJsonClawHub、不吃注入」），改它就是一片假红。
// 泵走的是可注入的 extendClawHubCatalog(cache, need, sortBy, category, fetchJson, rounds)。
import fs from 'node:fs';
import path from 'node:path';

let passed = 0, failed = 0;
function check(name, ok, got) {
  if (ok) { passed += 1; console.log('  OK ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (got === undefined ? '' : ' :: ' + got)); }
}

const es = await import('../src/extra-sources.js');

console.log('Test 1: 泵公开面在场');
{
  const want = ['pumpClawHubCatalog', 'createCatalogDemand', 'catalogPumpLoop', 'startClawHubPump', 'noteClawHubDemand'];
  const missing = want.filter((n) => typeof es[n] !== 'function');
  check('公开面齐备', missing.length === 0, missing.join(','));
  if (missing.length) {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
}

// 上游注入：每屏 50 行 + nextCursor（真 browse 端点的形状，见 :271 的 URL 与 :279 的 nextCursor）。
// dup=true 复现 test-clawhub-category-vocab Test 10 的病态上游：每页同一批条目、每页换新 cursor。
function mkUpstream({ stopAt = Infinity, dup = false } = {}) {
  const urls = [];
  const fetchJson = async (u) => {
    urls.push(u);
    const n = urls.length;
    const tag = dup ? 'same' : 'hop' + n;
    return {
      items: Array.from({ length: 50 }, (_, k) => ({
        slug: `${tag}-${k}`, ownerHandle: 'o', displayName: 'D' + k, summary: '',
        categories: ['security'], topics: [], stats: { downloads: 10 },
        latestVersion: '1.0.0', updatedAt: 1, createdAt: 1,
      })),
      nextCursor: n >= stopAt ? '' : 'c' + n,
    };
  };
  return { urls, fetchJson };
}
function cursorOf(u) {
  const m = /[?&]cursor=([^&]*)/.exec(u);
  return m ? decodeURIComponent(m[1]) : '';
}
function mkStore() {
  const raw = new Map();
  const gets = [];
  const puts = [];
  return {
    raw, gets, puts,
    async get(key, ttlMs) { gets.push({ key, ttlMs }); const h = raw.get(key); return h ? h.value : undefined; },
    async put(key, value) { puts.push({ key, value }); raw.set(key, { value }); },
  };
}

console.log('');
console.log('Test 2: 一轮受 rounds 预算，落盘带游标与进度');
{
  const store = mkStore();
  const up = mkUpstream();
  const r = await es.pumpClawHubCatalog(store, { rounds: 3, fetchJson: up.fetchJson });
  check('恰打三轮（预算自手中，不再被 need 牵着）', up.urls.length === 3, 'calls=' + up.urls.length);
  check('rows=150', r.rows === 150, 'rows=' + r.rows);
  check('未到底则 done=false（不谎称取完）', r.done === false, String(r.done));
  const st = [...store.raw.values()].pop().value;
  check('落盘带上一跳游标', st.cursor === 'c3', String(st.cursor));
  check('落盘 150 行', st.rows.length === 150, 'rows=' + st.rows.length);
}

console.log('');
console.log('Test 3: 第二轮从落盘游标续推，跨轮零重复');
{
  const store = mkStore();
  const up = mkUpstream();
  await es.pumpClawHubCatalog(store, { rounds: 3, fetchJson: up.fetchJson });
  const before = up.urls.length;
  const r2 = await es.pumpClawHubCatalog(store, { rounds: 2, fetchJson: up.fetchJson });
  check('第二腿第一跳带上一次落盘的游标 c3', cursorOf(up.urls[before]) === 'c3', up.urls[before]);
  check('累计 250 行', r2.rows === 250, 'rows=' + r2.rows);
  const st = [...store.raw.values()].pop().value;
  const ids = st.rows.map((raw) => raw.slug);
  check('跨轮零重复（seen 去重生效）', new Set(ids).size === ids.length, ids.length + ' vs ' + new Set(ids).size);
}

console.log('');
console.log('Test 4: 同一目录并发只开一条链（单飞）');
{
  const store = mkStore();
  const up = mkUpstream();
  const [a, b] = await Promise.all([
    es.pumpClawHubCatalog(store, { rounds: 2, fetchJson: up.fetchJson }),
    es.pumpClawHubCatalog(store, { rounds: 2, fetchJson: up.fetchJson }),
  ]);
  check('上游只被这条链打两次（不是四次）', up.urls.length === 2, 'calls=' + up.urls.length);
  check('恰有一条是接手的（joined）', (a.joined === true) + (b.joined === true) === 1, a.joined + '/' + b.joined);
  check('两条都报同一进度 rows=100', a.rows === 100 && b.rows === 100, a.rows + '/' + b.rows);
}

console.log('');
console.log('Test 5: 上游游标断掉即算取完，再泵不再发一次上游');
{
  const store = mkStore();
  const up = mkUpstream({ stopAt: 2 });
  const r = await es.pumpClawHubCatalog(store, { rounds: 8, fetchJson: up.fetchJson });
  check('两跳见底就停（不把 need 当上限硬撑）', up.urls.length === 2, 'calls=' + up.urls.length);
  check('done=true 并落盘', r.done === true, String(r.done));
  const up2 = mkUpstream();
  const r2 = await es.pumpClawHubCatalog(store, { rounds: 8, fetchJson: up2.fetchJson });
  check('已取完的目录再泵零请求', up2.urls.length === 0 && r2.done === true, 'calls=' + up2.urls.length);
}

console.log('');
console.log('Test 6: 带分类的目录各走各的键，互不串游标');
{
  const store = mkStore();
  const upA = mkUpstream();
  await es.pumpClawHubCatalog(store, { category: 'security', rounds: 2, fetchJson: upA.fetchJson });
  const upB = mkUpstream();
  await es.pumpClawHubCatalog(store, { category: 'research', rounds: 2, fetchJson: upB.fetchJson });
  check('两个分类各自起链（游标不共享）', upA.urls.every((u) => /category=security/.test(u)) && upB.urls.every((u) => /category=research/.test(u)), upA.urls[0] + ' | ' + upB.urls[0]);
  const keys = new Set(store.puts.map((p) => p.key));
  check('两份进度分别落盘（键不同）', keys.size === 2, 'keys=' + keys.size);
}

console.log('');
console.log('Test 7: 进度装载的 TTL 必须是「天」级，不是一夜清零');
{
  const store = mkStore();
  const up = mkUpstream();
  await es.pumpClawHubCatalog(store, { rounds: 1, fetchJson: up.fetchJson });
  await es.pumpClawHubCatalog(store, { rounds: 1, fetchJson: up.fetchJson });
  const got = store.gets.map((g) => Number(g.ttlMs));
  check('装载进度用的 TTL ≥ 7 天', got.length > 0 && got.every((t) => t >= 7 * 24 * 3600 * 1000), JSON.stringify(got));
}

console.log('');
console.log('Test 8: 病态上游（同批条目 + 换新 cursor）在泵路径下同样有界');
{
  const store = mkStore();
  const up = mkUpstream({ dup: true });
  const r = await es.pumpClawHubCatalog(store, { rounds: 4, fetchJson: up.fetchJson });
  check('轮次被预算切断（不无限串行 cursor）', up.urls.length === 4, 'calls=' + up.urls.length);
  check('没到底就诚实 done=false', r.done === false, String(r.done));
  check('只收一批真条目（重复行被去重）', r.rows === 50, 'rows=' + r.rows);
}

console.log('');
console.log('Test 9: 跨源需求队列（按源+分类记，去重、轮转、取完退场）');
{
  const q = es.createCatalogDemand();
  q.note('clawhub', 'security');
  q.note('skillsmp', 'debugging');
  q.note('clawhub', 'security');
  q.note('clawhub', '');
  check('重复登记不双份入队，空分类（全库）也算一格', q.size() === 3, 'size=' + q.size());
  const a = q.next();
  const b = q.next();
  const c = q.next();
  const d = q.next();
  check('next() 给 {source,facet} 形状', !!a && typeof a.source === 'string' && typeof a.facet === 'string', JSON.stringify(a));
  check('轮转不饿死（第四个回到第一个）', d.source === a.source && d.facet === a.facet, JSON.stringify(a) + '→' + JSON.stringify(d));
  q.done(b);
  check('取完的退场后队列只剩两个', q.size() === 2, 'size=' + q.size());
}

console.log('');
console.log('Test 10: 通用泵循环按队列轮转推进、可停、瞬时失败留队列');
{
  const seen = [];
  const q = es.createCatalogDemand();
  q.note('clawhub', 'security');
  q.note('skillsmp', 'debugging');
  let boom = true;
  const r = await es.catalogPumpLoop(null, {
    queue: q,
    maxRounds: 3,
    sleep: async () => {},
    advance: async (item) => {
      seen.push(item.source + ':' + item.facet);
      if (item.source === 'skillsmp' && boom) { boom = false; throw new Error('python 取数失败：Traceback'); }
      return { done: false };
    },
  });
  check('三轮各推一面（失败那轮也计为已推进）', r.rounds === 3 && seen.length === 3, 'rounds=' + r.rounds + ' seen=' + JSON.stringify(seen));
  check('按队列轮转推进，不是死盯一面', seen[0] === 'clawhub:security' && seen[1] === 'skillsmp:debugging', JSON.stringify(seen));
  check('瞬时失败不把那个面踢出队列（下一轮再接）', q.size() === 2, 'size=' + q.size());
  const q2 = es.createCatalogDemand();
  const r2 = await es.catalogPumpLoop(null, { queue: q2, maxRounds: 4, sleep: async () => {}, advance: async () => ({ done: false }) });
  check('空队列即刻收工（不空转）', r2.rounds === 0, 'rounds=' + r2.rounds);
  const q3 = es.createCatalogDemand();
  q3.note('clawhub', 'research');
  const r3 = await es.catalogPumpLoop(null, { queue: q3, maxRounds: 5, sleep: async () => {}, advance: async () => ({ done: true }) });
  check('取完的面退场，后续轮不再推它', r3.rounds === 1 && q3.size() === 0, 'rounds=' + r3.rounds + ' size=' + q3.size());
}

console.log('');
console.log('Test 11: 源码锁——泵复用同一条链实现，翻页挂点与调度挂点在位');
{
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'extra-sources.js'), 'utf8').replace(/\r\n/g, '\n');
  // 取函数体：起点到下一个 0 列 } 行（嵌套的闭合括号都带缩进，0 列那个才是函数尾）。
  // 不用括号深度扫描：签名行里的内层花括号（默认参数对象）会让深度当场归零，取到一行假体。
  const bodyOf = (head) => {
    const s = src.indexOf(head);
    if (s < 0) return null;
    const e = src.indexOf('\n}\n', s);
    return e < 0 ? null : src.slice(s, e + 2);
  };
  const pumpBody = bodyOf('export async function pumpClawHubCatalog(');
  check('pumpClawHubCatalog 存在且体可取', !!pumpBody);
  check('泵复用 extendClawHubCatalog（不许第二份爬取代码）', !!pumpBody && /extendClawHubCatalog\(/.test(pumpBody), '');
  check('泵把 need 放开、预算只由 rounds 定', !!pumpBody && /Infinity/.test(pumpBody), '');
  const scBody = bodyOf('export async function searchClawHub(');
  check('searchClawHub 浏览态登记需求（用户翻过的面优先补满）', !!scBody && /noteClawHubDemand\(/.test(scBody), '');
  check('进度 TTL 常量是 7 天量级', /const CLAWHUB_PROGRESS_TTL = 7 \* 24 \* 3600 \* 1000;/.test(src), '');
  check('旧的 6 小时目录 TTL 不再留着（一夜清零就是它）', !/const CLAWHUB_CATALOG_TTL/.test(src), '仍存在');
  check('泵常量在场（轮次与间隔显式命名）', /const CLAWHUB_PUMP_ROUNDS = \d+;/.test(src) && /const CLAWHUB_PUMP_GAP_MS = \d+;/.test(src), '');
  check('泵定时器不阻止宿主退出', /CLAWHUB_PUMP_TIMER[\s\S]{0,600}?\.unref\(\)/.test(src), '');
  const warmBody = bodyOf('export async function warmClawHubCatalog(');
  check('未破 warmClawHubCatalog 的既有形态（预算/错误上限/落盘）', !!warmBody && /rows\.length < budget/.test(warmBody) && /consecutiveErrors < 3/.test(warmBody) && /cache\.put\(CLAWHUB_CATALOG_KEY, \{ rows, cursor, done \}\)/.test(warmBody), '');
  const sources = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'sources.js'), 'utf8').replace(/\r\n/g, '\n');
  check('warmMarketCache 同时挂两面泵', /startSkillsMpPump\(/.test(sources) && /startClawHubPump\(/.test(sources), '');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
