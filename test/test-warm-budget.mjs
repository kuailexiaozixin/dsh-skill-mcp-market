#!/usr/bin/env node
// test-warm-budget.mjs — TDD: clawhub 预热必须有行数预算，不能对着 28k+ 的无限 cursor 流一直爬。
// 症状：catalogue 已 28800 条仍 done=false，warm-up 永不终止 → 内存与 API 无界增长。
import { warmClawHubCatalog } from '../src/extra-sources.js';
import { makeCache } from '../src/sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };
const skip = (n, d = '') => { skipped++; console.log('  SKIP ' + n + (d ? '  [' + String(d).slice(0, 70) + ']' : '')); };

// Test 1 与 Test 2 共用一个缓存目录：Test 1 爬到的行数正好是 Test 2 的起点，
// 默认预算那一轮因此只需补到 1200 行而不是从零重爬。2026-11-25 门内实测：从零两连爬
// 167s + 165s = 332s，在全门（71 套件）的负载下撞上线程级 420s 超时被杀；
// 复用后第二跳只剩 ~18 页。缓存复用本身就是预热的既有契约（test-warmup Test 3 守这条），
// 不是把断言搬走。
const sharedDir = path.join(safeTempDir(), 'dsh-wb-shared-' + Date.now());

console.log('\nTest 1: warmClawHubCatalog respects a row budget and terminates');
let rowsFromTest1 = 0;
{
  const cache = makeCache(sharedDir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache, { budget: 300 });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  rowsFromTest1 = r.rows.length;
  check('returns rows array', Array.isArray(r.rows));
  // warmClawHubCatalog 内部吞掉上游错误（连续 3 次失败即停），上游不可达时 rows=0。
  // 那是上游侧状态，不是预算逻辑回归 —— 必须 SKIP，否则 CI（GitHub 出口 IP 常被 clawhub
  // CDN 限流/TLS 指纹拒绝）无条件红。2026-11-19 的 0.5.109 CI 失败根因即此类。
  // rows=0 有两种：done=false = 连续 3 次错误被吞（不可达，SKIP）；
  // done=true = 上游正常应答但首批即空（真数据症状，必须 FAIL，不能掩盖）。
  if (!r.rows.length && !r.done) {
    skip('clawhub 不可达（rows=0 且 done=false），预算与耗时断言无从判定');
  } else {
    check('rows <= budget + slack (300..360)', r.rows.length >= 200 && r.rows.length <= 360, 'got ' + r.rows.length);
    // 耗时上限的量纲交代（2026-11-25 本机实测）：干净页 ~7s（Test 2 从零 24 页 165s），
    // 命中重试的页 ~28s（Test 1 六页 167s：每页降级链 fetch→curl→python 各带 25s 超时 + 3s 退避）。
    // 120s 的旧门等于「六页一次都不许重试」，那是上游抖动不是本侧逻辑，门内因此长期不可靠；
    // 240s 仍能一刀砍死无界爬取：28k+ 目录按 50 页/爬满算下界就是十几分钟量级。
    // 真正「预算存在」的确定性证据改由 Test 3 的文本锁守，不靠掐表。
    check('terminates in < 240s', elapsed < 240, 'took ' + elapsed + 's');
  }
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's)');
}

console.log('\nTest 2: default budget is finite (not 99999 / not infinite)');
{
  const cache = makeCache(sharedDir);
  const t0 = Date.now();
  const r = await warmClawHubCatalog(cache);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  // 上限断言（rows <= 2200）在 rows=0 时仍成立，可保留；耗时断言在无数据时只是网络耗时，无意义。
  check('default rows <= 2200', r.rows.length <= 2200, 'got ' + r.rows.length);
  check('默认预算确实接着上一跳补（不是从零重爬）', r.rows.length >= rowsFromTest1, rowsFromTest1 + '→' + r.rows.length);
  if (!r.rows.length && !r.done) skip('clawhub 不可达（rows=0 且 done=false），默认预算耗时不判');
  // 同上：默认预算 1200 行 ≈ 24 页，干净路径实测 165s；给重试留同量级余量。
  else check('default run terminates in < 400s', elapsed < 400, 'took ' + elapsed + 's');
  console.log('  (rows=' + r.rows.length + ', ' + elapsed + 's, done=' + r.done + ')');
}

console.log('\nTest 3: 预算与错误上限的文本锁（不联网，门内必判）');
{
  // 为什么还要一道文本锁：warmClawHubCatalog 的取页直调 getJsonClawHub（:64），
  // 不吃可注入的 fetchJson ⇒ 无法离线造「游标无限」的上游来证明预算真的生效。
  // 那就不再假装能测，改成把预算三要素钉在源码形态上（与 test-clawhub-quality 同一口径），
  // 并逐条给变异反证，保证锁不是恒绿。
  const esSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'extra-sources.js'), 'utf8');
  const esClean = esSrc.split('\n').map((l) => l.replace(/\r$/, ''));
  const s = esClean.findIndex((l) => l.trimStart().startsWith('export async function warmClawHubCatalog('));
  check('warmClawHubCatalog 起点存在', s >= 0, String(s));
  let e = s + 1;
  while (e < esClean.length && esClean[e] !== '}') e++;
  const body = esClean.slice(s, e + 1).join('\n');
  const LOCKS = [
    ['循环条件里带着行数预算', /while\s*\([^)]*rows\.length < budget[^)]*\)/],
    ['循环条件里带着连续错误上限', /while\s*\([^)]*consecutiveErrors < 3[^)]*\)/],
    ['默认预算是有限字面量 1200', /const budget = Math\.max\(50, Number\(options\.budget\) \|\| 1200\);/],
    ['游标断掉时立刻收工（不空转补页）', /if \(!batch\.length \|\| !next \|\| next === cursor\) \{ done = true; break; \}/],
    ['爬完把游标与 done 落缓存（复用而非重爬）', /cache\.put\(CLAWHUB_CATALOG_KEY, \{ rows, cursor, done \}\)/],
  ];
  for (const [name, re] of LOCKS) check(name, re.test(body), '体内未出现该形态');
  const MUTANTS = [
    ['抹掉 rows.length < budget ⇒ 预算锁必须红', body.replace(/rows\.length < budget && /, ''), /rows\.length < budget/],
    ['抹掉 consecutiveErrors 上限 ⇒ 错误锁必须红', body.replace(/ && consecutiveErrors < 3/, ''), /consecutiveErrors < 3/],
    ['默认预算换成 Infinity ⇒ 有限性锁必须红', body.replace('|| 1200', '|| Infinity'), /Number\(options\.budget\) \|\| 1200/],
    ['抹掉游标断掉的收工分支 ⇒ 空转锁必须红', body.replace('done = true; break;', 'done = false;'), /done = true; break;/],
    ['抹掉落缓存 ⇒ 复用锁必须红', body.replace('{ rows, cursor, done }', '{ rows }'), /\{ rows, cursor, done \}/],
  ];
  for (const [name, mutated, re] of MUTANTS) check('反证：' + name, !re.test(mutated), '变异体上锁仍为真 = 该锁恒绿');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
