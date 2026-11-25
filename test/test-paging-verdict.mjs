#!/usr/bin/env node
// test-paging-verdict.mjs — 分页判据纯函数真值表（零网络）。
//
// test-nocache 直打真实上游，SKIP/重试分支没法靠上游恰好坏一次来验证 —— 那等于
// 没有锁。判定抽成纯函数后每条边界都能钉死，尤其「放宽绝不放行真回归」。
import { overlapVerdict, emptyPageAction, emptyWithoutEvidence, pagePairVerdict } from './paging-verdict.mjs';
import fs from 'node:fs';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + String(d).slice(0, 120) : '')); } };
const v = (o) => overlapVerdict(o).verdict;
const SRC = fs.readFileSync(new URL('./paging-verdict.mjs', import.meta.url), 'utf8');

console.log('');
console.log('Test 1: overlapVerdict 无重叠即 ok');
check('overlap 零 → ok', v({ source: 'skillhub', overlap: 0, pageCount: 12, sortedOverlap: 99 }) === 'ok');
check('与 sortedOverlap 无关', v({ source: 'trusttools', overlap: 0, pageCount: 12, sortedOverlap: 5 }) === 'ok');

console.log('');
console.log('Test 2: 整页重复永远 fail（page 参数被忽略）');
check('skillhub 整页重复 → fail', v({ source: 'skillhub', overlap: 12, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('其它源整页重复 → fail', v({ source: 'clawhub', overlap: 12, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('理由提到 page 参数', overlapVerdict({ source: 'skillhub', overlap: 12, pageCount: 12 }).reason.indexOf('page') >= 0);

console.log('');
console.log('Test 3: skillhub 部分重叠是放宽的唯一口子');
check('显式排序干净 → skip', v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0 }) === 'skip');
check('显式排序也重复 → fail（绝不放宽）', v({ source: 'skillhub', overlap: 2, pageCount: 12, sortedOverlap: 3 }) === 'fail');
check('sortedOverlap 缺失 → fail（不得当成 0 放行）', v({ source: 'skillhub', overlap: 7, pageCount: 12 }) === 'fail');
check('其它源部分重叠不得蹭口子 → fail', v({ source: 'clawhub', overlap: 3, pageCount: 12, sortedOverlap: 0 }) === 'fail');
check('同 overlap 下 sortedOverlap 决定结论', v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0 }) !== v({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 4 }));

console.log('');
console.log('Test 4: emptyPageAction 空第 2 页（重试一次，仍空必须红）');
const ep = (o) => emptyPageAction(o).verdict;
check('第 2 页有条目 → ok', ep({ p1: 12, p2: 12, total: 579074, hasMore: true, attempt: 1 }) === 'ok');
check('第 1 页就空 → fail（不是重试能解决的）', ep({ p1: 0, p2: 0, total: 0, hasMore: false, attempt: 1 }) === 'fail');
check('total 说还有更多且首次 → retry', ep({ p1: 12, p2: 0, total: 579074, hasMore: true, attempt: 1 }) === 'retry');
check('重试后仍空 → fail（分页回归，绝不静默放行）', ep({ p1: 12, p2: 0, total: 579074, hasMore: true, attempt: 2 }) === 'fail');
check('本就没有第 2 页 → ok 不重试', ep({ p1: 5, p2: 0, total: 5, hasMore: false, attempt: 1 }) === 'ok');
check('hasMore 为真也属于必须有第 2 页', ep({ p1: 12, p2: 0, total: 0, hasMore: true, attempt: 2 }) === 'fail');
check('fail 理由提到 offset/page 语义', emptyPageAction({ p1: 12, p2: 0, total: 99, hasMore: true, attempt: 2 }).reason.length > 4);

console.log('');
console.log('Test 5: 判据必须来自 helper（不是测试里另写一份）');
{
  // 真值表依赖的实现只有一份：helper 模块。若哪天测试改回内联判定，
  // 上游恰好不坏就没人验证过 SKIP —— 这条锁住 helper 里确实有两个导出。
  check('helper 导出 overlapVerdict', SRC.indexOf('export function overlapVerdict(') >= 0);
  check('helper 导出 emptyPageAction', SRC.indexOf('export function emptyPageAction(') >= 0);
  // 且 test-nocache 必须真的 import 并使用它们
  const nc = fs.readFileSync(new URL('./test-nocache.mjs', import.meta.url), 'utf8');
  check('test-nocache 使用 overlapVerdict', nc.indexOf('overlapVerdict(') >= 0);
  check('test-nocache 使用 emptyPageAction', nc.indexOf('emptyPageAction(') >= 0);
}

console.log('');
console.log('');
console.log('Test 7: emptyWithoutEvidence —— 上游静默空响应不得伪装成本仓库回归');
{
  const ew = (o) => emptyWithoutEvidence(o);
  check('degraded 有记录 → 有证据', ew({ degraded: 1, total: 0, hasMore: false }) === false);
  check('total>0 却空页 → 有证据（必须能判红）', ew({ degraded: 0, total: 579074, hasMore: false }) === false);
  check('hasMore=true 却空页 → 有证据', ew({ degraded: 0, total: 0, hasMore: true }) === false);
  check('三者皆无 → 无证据（实测 trusttools 门内形态）', ew({ degraded: 0, total: 0, hasMore: false }) === true);
  check('hasMore 未知也算无证据', ew({ degraded: 0, total: 0, hasMore: undefined }) === true);
  // 反向破坏：写成恒 true（一律当上游问题）就会放过 total>0 却空页这种真回归
  const weakened = () => true;
  check('削弱成恒 true 会被 total>0 那例抓到（判据有效）', weakened({ total: 9 }) !== ew({ degraded: 0, total: 9, hasMore: false }));
}

console.log('');
console.log('');
console.log('Test 8: pagePairVerdict —— 空页由上游自报失败时不得算本侧回归');
{
  // 门内两条红的同一根因（实测 trusttools 6/6 次均 degraded=来源响应超时）：
  //   test-paging  FAIL trusttools p1= 0 p2=12 —— 第 1 页超时、第 2 页正常；
  //   test-nocache FAIL 重试后第 2 页仍空而 total=579074 hasMore=true —— 第 2 页超时。
  // 两次都是「空的那一页自己声明了失败」。上游承认失败的页不能用来判我们的分页算术；
  // 但没有 degraded 时（该页成功返回却空手 + 上游说还有货）仍必须 FAIL，这条不能放宽。
  // 动态 import：函数还不存在时静态 import 会让套件在链接期崩掉（NO-SUMMARY），
  // 拿不到「具体哪条判据失败」的原文。
  let mod = null, err = '';
  try { mod = await import('./paging-verdict.mjs'); } catch (e) { err = String(e && e.message || e); }
  const fn = mod && mod.pagePairVerdict;
  check('导出 pagePairVerdict', typeof fn === 'function', err || '未导出');
  if (typeof fn === 'function') {
    const p = (o) => fn(o).verdict;
    check('两页都有条目 → ok（不干预）', p({ p1: 12, p2: 12, p1Degraded: 0, p2Degraded: 0 }) === 'ok');
    check('p1 超时且 p1 空 → skip（实测 test-paging 那条红）', p({ p1: 0, p2: 12, p1Degraded: 1, p2Degraded: 0 }) === 'skip');
    check('p2 超时且 p2 空 → skip（实测 test-nocache 那条红）', p({ p1: 12, p2: 0, p1Degraded: 0, p2Degraded: 1 }) === 'skip');
    check('没有 degraded 的空页不算外部状态 → judge', p({ p1: 12, p2: 0, p1Degraded: 0, p2Degraded: 0 }) === 'judge');
    check('degraded 属于另一页时不豁免本页 → judge', p({ p1: 0, p2: 12, p1Degraded: 0, p2Degraded: 1 }) === 'judge');
    check('两条都有问题 → skip 优先于 ok', p({ p1: 0, p2: 0, p1Degraded: 1, p2Degraded: 1 }) === 'skip');
    check('skip 理由写明是自报失败', /自报失败|degraded/.test(fn({ p1: 0, p2: 12, p1Degraded: 1, p2Degraded: 0 }).reason), '');
  }
}

console.log('');
console.log('');
console.log('Test 9: 部分重叠按「同页自稳证据」判定，且 FAIL 必须带源名');
{
  // 门内实测 test-nocache 一次 `FAIL 跨页重叠 overlap=5`，单跑 14/0 全绿 —— 而定不了性，
  // 因为 overlapVerdict 的理由里只有 overlap 数字、没有源名，日志看不出是谁。
  // 同时 ba-staging/nocache-churn.mjs 实测：八个源里七个 stabA=12（同一页重复请求完全自稳）。
  // 所以「部分重叠」有两种成因，必须用证据分开，而不是给某个源开永久特例：
  //   同页自稳却仍跨页重复 → 本侧 offset 真算错 → fail（对非 skillhub 源比旧判据更讲道理）；
  //   同页自身两次就不一致 → 上游默认序在重排 → skip（必须写明实测依据）；
  //   没测过（undefined）→ 不得凭未测放行 → fail（与 Test 3 的 sortedOverlap 同一原则）。
  // 整页重复（page 参数被忽略）优先于一切外部状态豁免。
  const w = (o) => overlapVerdict(o);
  check('自稳源部分重叠 → fail', w({ source: 'lobehub', overlap: 5, pageCount: 12, firstPageStable: true }).verdict === 'fail');
  check('同页自不稳 → skip（外部状态）', w({ source: 'lobehub', overlap: 5, pageCount: 12, firstPageStable: false }).verdict === 'skip');
  check('未测同页稳定性 → fail（不得凭未测放行）', w({ source: 'lobehub', overlap: 5, pageCount: 12 }).verdict === 'fail');
  check('整页重复即使同页自不稳也 fail（豁免不吃真回归）', w({ source: 'lobehub', overlap: 12, pageCount: 12, firstPageStable: false }).verdict === 'fail');
  check('overlap=0 一律 ok（不引入额外网络成本）', w({ source: 'lobehub', overlap: 0, pageCount: 12, firstPageStable: false }).verdict === 'ok');
  const rf = w({ source: 'trusttools', overlap: 5, pageCount: 12, firstPageStable: true });
  check('fail 理由带源名（可定性）', rf.reason.indexOf('trusttools') >= 0, rf.reason);
  check('skip 理由写明来自重复请求实测', /自稳|重复请求/.test(w({ source: 'trusttools', overlap: 5, pageCount: 12, firstPageStable: false }).reason), '');
  // skillhub 既有三条必须原样成立（旧口子不被新证据顶掉）
  check('skillhub 显式排序干净 → 仍 skip', w({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0 }).verdict === 'skip');
  check('skillhub 显式排序也重复 → 仍 fail', w({ source: 'skillhub', overlap: 2, pageCount: 12, sortedOverlap: 3 }).verdict === 'fail');
  check('skillhub 有 sortedOverlap 时优先于自稳证据', w({ source: 'skillhub', overlap: 7, pageCount: 12, sortedOverlap: 0, firstPageStable: true }).verdict === 'skip');
  // 削弱自证：把「未测」也当放行，第三条会绿；这里要求两者结论不同，证明判据有效。
  const weakened = { source: 'lobehub', overlap: 5, pageCount: 12 };
  check('未测与自稳都必须 fail（不接受静默放行）', w(weakened).verdict === 'fail' && w({ ...weakened, firstPageStable: true }).verdict === 'fail');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
