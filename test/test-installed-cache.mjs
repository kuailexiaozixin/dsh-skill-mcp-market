import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 判据：listInstalledSkills 的带 TTL 缓存（src/skills.js makeInstalledCache）+ index.js 接入。
// 约定：静态判据一律跑在 LF 归一化文本上（index.js / skills.js 现盘是 CRLF），行尾本身由 Test0 单独锁。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.js');
const SKILLS = path.join(ROOT, 'src', 'skills.js');
const SELF = fileURLToPath(import.meta.url);

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log('  OK   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? '  [' + String(detail).slice(0, 200) + ']' : '')); }
};
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const countHits = (src, needle) => {
  if (!needle) throw new Error('空 needle');
  return src.split(needle).length - 1;
};
const scopeOf = (t, start, end, label, sink) => {
  const a = countHits(t, start);
  const b = countHits(t, end);
  if (a !== 1 || b !== 1) { sink.push({ name: label + ' 锚唯一性', ok: false, detail: 'start=' + a + ' end=' + b }); return null; }
  const i = t.indexOf(start);
  const j = t.indexOf(end);
  if (j <= i) { sink.push({ name: label + ' 锚顺序', ok: false, detail: i + ' >= ' + j }); return null; }
  return t.slice(i, j);
};

console.log('== Test0 行尾 ==');
// 平台中立不变量：不许混用（同文件同时出现 CRLF 与孤立 LF）。仓库 blob 是 i/lf，
// core.autocrlf=true 的 Windows 工作副本全 CRLF、Linux CI 检出全 LF——「必须 CRLF」
// 在任何 Linux 上必红（test-search-fanout-latency.mjs Test12 已钉死该教训）。
const mixedEol = (s) => /\r\n/.test(s) && (s.replace(/\r\n/g, '').indexOf('\n') >= 0);
const indexRaw = fs.readFileSync(INDEX, 'utf8');
const skillsRaw = fs.readFileSync(SKILLS, 'utf8');
const selfRaw = fs.readFileSync(SELF, 'utf8');
check('index.js 无混合行尾', !mixedEol(indexRaw), JSON.stringify(mixedEol(indexRaw)));
check('src/skills.js 无混合行尾', !mixedEol(skillsRaw), JSON.stringify(mixedEol(skillsRaw)));
check('新建测试文件纯 LF', selfRaw.indexOf('\r') === -1, 'CR=' + (selfRaw.match(/\r/g) || []).length);

const indexText = lf(INDEX);
const skillsText = lf(SKILLS);

// ---------------------------------------------------------------- 行为判据（工厂本体）
async function factoryChecks(make) {
  const out = [];
  const add = (name, cond, detail = '') => out.push({ name, ok: Boolean(cond), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let calls = 0;
  const scan = async (dirs) => { calls += 1; return [{ slug: 'a', dir: String(dirs) }]; };
  const c = make({ ttlMs: 5000, scan });
  const r1 = await c.list(['x']);
  const r2 = await c.list(['x']);
  add('TTL 命中不再重扫', calls === 1, 'scan calls=' + calls);
  add('命中返回新数组实例（不是缓存本体）', r1 !== r2, 'r1===r2');
  add('同 key 内容一致', r1.length === 1 && r2.length === 1 && r2[0].slug === 'a');
  let pushOk = false;
  try { r1.push({ slug: 'ghost' }); pushOk = r1.length === 2; } catch { pushOk = false; }
  const r3 = await c.list(['x']);
  add('调用方可安全改动，且不回写缓存', pushOk && r3.length === 1, 'pushOk=' + pushOk + ' r3len=' + r3.length);
  add('TTL 命中返回的也不是缓存本体（可改且实例唯一）', r2 !== r3 && !Object.isFrozen(r2) && !Object.isFrozen(r3), 'r2===r3:' + (r2 === r3) + ' frozenR2:' + Object.isFrozen(r2));

  let inflight = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = make({ ttlMs: 5000, scan: async (dirs) => { inflight += 1; await gate; return [{ slug: String(dirs) }]; } });
  const trioP = [slow.list(['s']), slow.list(['s']), slow.list(['s'])];
  await new Promise((tick) => setTimeout(tick, 10));
  release();
  const trio = await Promise.all(trioP);
  add('并发同 key 只扫一次（面板 250ms 轮询不打穿）', inflight === 1, 'inflight=' + inflight);
  add('并发合并仍各自返回可用副本', trio.every((x) => Array.isArray(x) && x[0].slug === 's') && new Set(trio).size === 3);

  let cold = 0;
  const expiring = make({ ttlMs: 40, scan: async () => { cold += 1; return []; } });
  await expiring.list(['e']);
  await expiring.list(['e']);
  const withinTtl = cold;
  await sleep(90);
  await expiring.list(['e']);
  add('TTL 内复用 / 过期后重取', withinTtl === 1 && cold === 2, 'within=' + withinTtl + ' after=' + cold);

  let inv = 0;
  const invC = make({ ttlMs: 60000, scan: async () => { inv += 1; return []; } });
  await invC.list(['i']);
  await invC.list(['i']);
  const preInvalidate = inv;
  invC.invalidate();
  await invC.list(['i']);
  add('invalidate 全清（下一次必重扫）', preInvalidate === 1 && inv === 2, 'pre=' + preInvalidate + ' post=' + inv);

  // 代际丢弃：扫描启动早于 invalidate()、落地晚于 invalidate() 的那次结果，绝不能写回缓存。
  let genCalls = 0;
  let releaseGen;
  const genGate = new Promise((r) => { releaseGen = r; });
  const stale = make({ ttlMs: 60000, scan: async () => {
    genCalls += 1;
    if (genCalls === 1) { await genGate; return [{ slug: 'stale-before-invalidate' }]; }
    return [{ slug: 'fresh-after-invalidate' }];
  } });
  const inFlight = stale.list(['g']);
  await sleep(10);
  stale.invalidate();
  releaseGen();
  await inFlight;
  add('在途扫描期间 invalidate：那次结果不写回缓存（size 归 0）', stale.size() === 0, 'size=' + stale.size());
  const afterStale = await stale.list(['g']);
  add('脏写被代际丢弃，下一次拿到新扫描的结果', genCalls === 2 && afterStale[0].slug === 'fresh-after-invalidate', 'calls=' + genCalls + ' slug=' + afterStale[0].slug);

  const keys = [];
  const iso = make({ ttlMs: 60000, scan: async (dirs) => { keys.push(JSON.stringify(dirs)); return [{ slug: 'of-' + dirs.join('+') }]; } });
  const listA = await iso.list(['dirA']);
  const listB = await iso.list(['dirB']);
  const listA2 = await iso.list(['dirA']);
  add('不同 dirs 互不污染', listA[0].slug === 'of-dirA' && listB[0].slug === 'of-dirB' && listA2[0].slug === 'of-dirA', JSON.stringify([listA[0].slug, listB[0].slug, listA2[0].slug]));
  add('不同 dirs 各自只扫一次', keys.length === 2, 'scans=' + keys.length + ' ' + JSON.stringify(keys));
  const listAB = await iso.list(['dirA', 'dirB']);
  add('dirs 数组顺序参与 key（[a,b] 与 [b,a] 不复用）', keys.length === 3 && listAB[0].slug === 'of-dirA+dirB', 'scans=' + keys.length);

  const cap = make({ ttlMs: 60000, maxEntries: 2, scan: async (dirs) => [{ slug: String(dirs) }] });
  await cap.list(['k1']);
  await cap.list(['k2']);
  await cap.list(['k3']);
  add('超容量淘汰（size 受 maxEntries 约束）', cap.size() === 2, 'size=' + cap.size());
  let k1Calls = 0;
  const cap2 = make({ ttlMs: 60000, maxEntries: 2, scan: async (dirs) => { if (String(dirs) === 'k1') k1Calls += 1; return []; } });
  await cap2.list(['k1']);
  await cap2.list(['k2']);
  await cap2.list(['k3']);
  await cap2.list(['k1']);
  add('被淘汰的 key 重新扫描', k1Calls === 2, 'k1Calls=' + k1Calls);

  let thrown = '';
  const bad = make({ ttlMs: 60000, scan: async () => { throw new Error('boom-scan'); } });
  try { await bad.list(['z']); } catch (e) { thrown = String(e.message); }
  let badAgain = 0;
  try { await bad.list(['z']); } catch { badAgain += 1; }
  add('扫描抛错透传', thrown === 'boom-scan', 'thrown=' + thrown);
  add('失败结果不入缓存（下一次仍重扫）', badAgain === 1, 'retried=' + badAgain);

  return out;
}

console.log('== Test1 makeInstalledCache 行为 ==');
const mod = await import(pathToFileURL(SKILLS).href + '?t=' + Date.now());
check('src/skills.js 导出 makeInstalledCache', typeof mod.makeInstalledCache === 'function', typeof mod.makeInstalledCache);
check('listInstalledSkills 仍然导出（未破坏既有 API）', typeof mod.listInstalledSkills === 'function');
const factorySourceStart = skillsText.indexOf('export function makeInstalledCache');
const factorySourceEnd = skillsText.indexOf('function uniqueSlug(base, taken)');
check('工厂源码位于 listInstalledSkills 与 uniqueSlug 之间', factorySourceStart > 0 && factorySourceEnd > factorySourceStart, factorySourceStart + '/' + factorySourceEnd);
const factoryText = factorySourceStart > 0 && factorySourceEnd > factorySourceStart
  ? skillsText.slice(factorySourceStart, factorySourceEnd)
  : '';
check('默认 ttlMs=3000', /ttlMs = 3000/.test(factoryText), 'factory text missing');
check('默认 maxEntries=32', /maxEntries = 32/.test(factoryText));
check('默认 scan=listInstalledSkills', /scan = listInstalledSkills/.test(factoryText));
check('缓存数组入库前冻结（注释外的事实）', /Object\.freeze\(/.test(factoryText));
check('失效时递增代际（丢弃在途结果）', /generation \+= 1;/.test(factoryText));

let behaviour = [];
if (typeof mod.makeInstalledCache === 'function') {
  behaviour = await factoryChecks(mod.makeInstalledCache);
} else {
  behaviour = [{ name: '行为判据跳过（无工厂导出）', ok: false, detail: 'makeInstalledCache 未实现' }];
}
for (const b of behaviour) check(b.name, b.ok, b.detail);

// ---------------------------------------------------------------- index.js 静态契约
const CONTRACT = (t) => {
  const out = [];
  const add = (name, cond, detail = '') => out.push({ name, ok: Boolean(cond), detail });
  const req = (needle, n, name) => add(name || ('命中 ' + JSON.stringify(needle).slice(0, 48)), countHits(t, needle) === n, 'hits=' + countHits(t, needle) + ' expect=' + n);

  req('await listInstalledSkills(', 0, 'index.js 不再直调 listInstalledSkills（D2/D4）');
  req('listInstalledSkills, listTrash', 0, 'import 行已换成 makeInstalledCache');
  req('listTrash, makeInstalledCache', 1, 'import 引入 makeInstalledCache');
  req('const installedCache = makeInstalledCache();', 1, '模块级缓存实例（默认 TTL）');
  req('installedCache.invalidate();', 14, '失效点总数 = 13 变更点 + 重挂载');
  req('installedCache.list(', 8, '只读调用点 = 8');

  // 只读点位语义逐字保持（D2）
  req('        items = await installedCache.list([root.dir]);', 1, 'collectInstalledGrouped 仍传 [root.dir]');
  req('      const installed = await installedCache.list(settings.skillDirs);', 1, 'skill_market_search 仍传 settings.skillDirs');
  req('      const items = await installedCache.list(dirs);', 1, 'skill_market_list 仍传 dirs');
  req('        const installedNow = await installedCache.list(settings.skillDirs);', 1, 'skills.search 仍传 settings.skillDirs');
  req('          const all = await installedCache.list(await collectDshNativeSkillDirs());', 1, 'market.openDir 仍传 collectDshNativeSkillDirs()');
  req('new Set((await installedCache.list(settings.skillDirs)).map((item) => item.slug));', 2, 'harvest.start/poll 仍传 settings.skillDirs');

  // D4：upload 循环外单扫 + 先失效再读
  const upload = scopeOf(t, '      case "skills.upload"', '      case "skills.preview"', 'skills.upload', out);
  if (upload) {
    const iInv = upload.indexOf('installedCache.invalidate();');
    const iList = upload.indexOf('const uploaded = await installedCache.list(settings.skillDirs);');
    const iLoop = upload.indexOf('        for (const item of result.items || []) {');
    const iRet = upload.indexOf('        return result;');
    add('upload：失效发生在读取之前', iInv >= 0 && iList > iInv, 'inv=' + iInv + ' list=' + iList);
    add('upload：全盘读取只在循环外一次（D4）', iList >= 0 && iLoop > iList && iRet > iLoop, 'list=' + iList + ' loop=' + iLoop);
    add('upload：循环体不再含任何扫描调用', iLoop >= 0 && !/await (listInstalledSkills|installedCache[.]list)[(]/.test(upload.slice(iLoop, iRet)), upload.slice(iLoop, iRet).slice(0, 80));
    add('upload：循环内只做 find + register', /uploaded\.find\(\(s\) => s\.slug === item\.slug\)/.test(upload) && /registerInstalledSkillToCatalog\(match, log\)/.test(upload));
  }

  // D3：harvest 只读，禁止每次 poll 强制失效
  const hStart = scopeOf(t, '      case "harvest.start": {', '      case "harvest.poll": {', 'harvest.start', out);
  const hPoll = scopeOf(t, '      case "harvest.poll": {', '      default:', 'harvest.poll', out);
  if (hStart) add('harvest.start 走缓存且不强制失效', hStart.includes('installedCache.list(') && !hStart.includes('invalidate()'), hStart.slice(0, 60));
  if (hPoll) add('harvest.poll 走缓存且不强制失效（轮询白扫防线）', hPoll.includes('installedCache.list(') && !hPoll.includes('invalidate()'), hPoll.slice(0, 60));

  // 13 个变更点：失效必须落在各自作用域内
  const sites = [
    ['toggleSkillFile 之后', '      const result = await toggleSkillFile({ dirs: fileDirs, slug: key, enabled });', '        scope: "file",'],
    ['tool skill_market_install', '      const result = await installSkill({\n        source: args.source || "github",', '      const mounted = Boolean(disposeProvider);'],
    ['tool skill_market_uninstall', '      properties: { slug: { type: "string" }, dir: { type: "string" } },', '  // ---------------------------------------------------------------- tools: mcp'],
    ['skills.install', '      case "skills.install": {', '      case "skills.list": {'],
    ['skills.uninstall', '      case "skills.uninstall":', '      case "skills.trash": {'],
    ['skills.restore', '      case "skills.restore": {', '      case "skills.trashEmpty": {'],
    ['skills.trashEmpty', '      case "skills.trashEmpty": {', '      case "skills.import": {'],
    ['skills.import', '      case "skills.import": {', '      case "skills.importZip": {'],
    ['skills.importZip', '      case "skills.importZip": {', '      case "skills.upload"'],
    ['skills.preview clawhub', '            const installed = await installSkill({\n              source: body.source,', '          } catch (previewErr) {'],
    ['skills.preview generic', '          const installed = await installSkill({\n            source: body.source || "github",', '        } finally {\n          await rm(tmpRoot, { recursive: true, force: true });\n        }\n      }\n      case "skills.toggle"'],
    ['skills.update', '      case "skills.update": {', '        return updated;'],
    ['skills.upload（登记前置失效）', '      case "skills.upload"', '      case "skills.preview"'],
  ];
  for (const [name, a, b] of sites) {
    const s = scopeOf(t, a, b, name, out);
    if (s) add('变更点失效：' + name, s.includes('installedCache.invalidate()'), s.slice(0, 60));
  }

  // 重挂载后必须作废
  const remount = scopeOf(t, '  const marketCache = makeCache(join(dirname(settingsPath()), "cache"));', '  // ---------------------------------------------------------------- skill provider', 'remount', out);
  if (remount) add('重挂载/改路径后 invalidate（模块级实例不留旧盘）', remount.includes('installedCache.invalidate()'), remount.slice(0, 60));

  // 宿主面缓存控制不得被复用/改名
  req('  let invalidateSkills = null;', 1, 'invalidateSkills 声明原样（:362）');
  req('invalidateSkills?.()', 5, 'invalidateSkills 五个调用点原样（:497/:515/:1307/:1317/:1593）');
  req('makeInstalledSkillsCache', 0, '未与宿主面缓存同名');
  return out;
};

console.log('== Test2 index.js 接入契约 ==');
const contract = CONTRACT(indexText);
for (const c of contract) check(c.name, c.ok, c.detail);

// ---------------------------------------------------------------- 变异自证
console.log('== Test3 变异自证（内存内，绝不写生产文件）==');
const replaceOnce = (src, needle, repl) => {
  if (countHits(src, needle) !== 1) return null;
  return src.replace(needle, repl);
};

let mutRed = 0;
let mutGreen = 0;
let mutTotal = 0;
const factoryMutants = [
  ['F1 TTL 命中判据恒假（每次都重扫）', 'Date.now() - hit.at < ttlMs', 'Date.now() - hit.at < -1'],
  ['F2 TTL 判据恒真（永不过期）', 'Date.now() - hit.at < ttlMs', 'Date.now() - hit.at >= 0'],
  ['F3 invalidate 不清表', '    store.clear();', ''],
  ['F4 key 退化成一个常量（dirs 互相污染）', '    const key = keyOf(dirs);', '    const key = "all";'],
  ['F5 命中直接返回缓存本体（可被原地改）', '< ttlMs) return hit.value.slice();', '< ttlMs) return hit.value;'],
  ['F6 摘掉代际丢弃（在途脏写落库）', '        if (generation !== at) return rows;\n', ''],
  ['F7 代际判据取反（新鲜结果被判过期）', 'if (generation !== at) return rows;', 'if (generation === at) return rows;'],
];
for (const [name, needle, repl] of factoryMutants) {
  mutTotal += 1;
  const mutated = replaceOnce(factoryText, needle, repl);
  if (mutated === null) { check(name + '（锚失效，无法变异）', false, 'needle hits=' + countHits(factoryText, needle)); continue; }
  let make = null;
  try {
    make = new Function('listInstalledSkills', mutated.replace('export function makeInstalledCache', 'function makeInstalledCache') + '\nreturn makeInstalledCache;')(mod.listInstalledSkills);
  } catch (e) { check(name + '（变异体不可编译）', false, e.message); continue; }
  const res = await factoryChecks(make);
  const caught = res.filter((r) => !r.ok);
  check(name + ' → 判据转红', caught.length > 0, '变异体仍然全绿');
  if (caught.length > 0) mutRed += 1;
  console.log('       捕获：' + caught.map((r) => r.name).join(' / ').slice(0, 160));
  const back = await factoryChecks(mod.makeInstalledCache || (() => { throw new Error('no factory'); }));
  const backOk = back.every((r) => r.ok);
  check(name + ' → 还原转绿', backOk, back.filter((r) => !r.ok).map((r) => r.name).join(' / '));
  if (caught.length > 0 && backOk) mutGreen += 1;
}

const indexMutants = [
  ['M1 摘掉 toggleSkillFile 后的失效', '      installedCache.invalidate();\n      return {\n        ok: true,\n        slug: key,\n        enabled: Boolean(enabled),\n        scope: "file",', '      return {\n        ok: true,\n        slug: key,\n        enabled: Boolean(enabled),\n        scope: "file",'],
  ['M2 upload 还原成循环内直扫', '        installedCache.invalidate();\n        const uploaded = await installedCache.list(settings.skillDirs);', '        const uploaded = await listInstalledSkills(settings.skillDirs);'],
  ['M3 harvest.poll 强制失效', '      case "harvest.poll": {', '      case "harvest.poll": {\n        installedCache.invalidate();'],
  ['M4 collectInstalledGrouped 还原直扫', '        items = await installedCache.list([root.dir]);', '        items = await listInstalledSkills([root.dir]);'],
  ['M5 摘掉重挂载后的失效', '  installedCache.invalidate();\n\n  // ---------------------------------------------------------------- skill provider', '\n  // ---------------------------------------------------------------- skill provider'],
];
for (const [name, needle, repl] of indexMutants) {
  mutTotal += 1;
  const mutated = replaceOnce(indexText, needle, repl);
  if (mutated === null) { check(name + '（锚失效，无法变异）', false, 'needle hits=' + countHits(indexText, needle)); continue; }
  const res = CONTRACT(mutated);
  const caught = res.filter((r) => !r.ok);
  check(name + ' → 判据转红', caught.length > 0, '变异体仍然全绿');
  if (caught.length > 0) mutRed += 1;
  console.log('       捕获：' + caught.map((r) => r.name).join(' / ').slice(0, 160));
  const back = CONTRACT(indexText);
  const backOk = back.every((r) => r.ok);
  check(name + ' → 还原转绿', backOk, back.filter((r) => !r.ok).map((r) => r.name).join(' / '));
  if (caught.length > 0 && backOk) mutGreen += 1;
}

console.log('');
console.log('变异自证：红=' + mutRed + '/' + mutTotal + ' 绿=' + mutGreen + '/' + mutTotal + '（红=变异体被判据捕获，绿=还原后整体判据回到全绿）');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
