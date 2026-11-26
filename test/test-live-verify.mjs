#!/usr/bin/env node
// test-live-verify.mjs — TDD: 「重启后一键复验服务端半边」的判据必须是纯函数，离线可断言。
//
// 为什么单独钉这套：本会话三轮误判全是同一类错 —— 把「看起来像新码」当成版本证据。
//   ① 读错字段：出参是 hints（数组），读 .hint 恒 undefined ⇒ 判成「没接线」。
//   ② 读错位置：只截 msCatHint 声明首行，漏掉 v0.5.165 的三元表达式 ⇒ 把 0.5.164 的中断态读成新码。
//   ③ 认错证据：把「分类态 items>0」当版本指纹 ⇒ 旧码命中缓存时照样成立。
// 这里把三条全部钉成断言，并钉住「未测成绝不写 PASS」「覆盖缺口不判红」。
import { fingerprintOf, pickHint, verdictB, usable, summarize, discoverPorts, portsFromPs, vocabOf, lobeWindowFold, wallVerdict, render } from './live-verify.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  \u2713 ' + n); } else { failed++; console.log('  \u2717 ' + n + (d ? '  ' + d : '')); } };
const skip = (n, d = '') => { skipped++; console.log('  SKIP ' + n + (d ? '  [' + String(d).slice(0, 70) + ']' : '')); };

// 逐字取自真实生产源码（不是手搓样例）：
//   v0.5.164:src/extra-sources.js:1440 正常态
//   v0.5.165:src/extra-sources.js:1496 正常态 / :1495 中断态
const HINT_164 = 'ModelScope \u4e0a\u6e38\u4e0d\u63d0\u4f9b\u670d\u52a1\u7aef\u5206\u7c7b\u8fc7\u6ee4\uff0830 \u7ec4\u53c2\u6570\u63a2\u9488\u5b9e\u6d4b\u5168\u90e8\u5ffd\u7565\uff09\uff0c\u5206\u7c7b\u5728\u53ef\u8fbe\u7684 969 \u884c\uff08\u76ee\u5f55\u5171 969 \u6761\uff09\u5185\u672c\u5730\u8fc7\u6ee4\uff0c\u8de8\u9875\u6709\u6548\uff1b\u672c\u7c7b\u5b9e\u6d4b 574 \u6761\uff1b\u53ef\u8fbe\u96c6\u5408\u5916\u7684\u5206\u7c7b\u4f1a\u6f0f';
const HINT_165 = 'ModelScope \u4e0a\u6e38\u4e0d\u63d0\u4f9b\u670d\u52a1\u7aef\u5206\u7c7b\u8fc7\u6ee4\uff0830 \u7ec4\u53c2\u6570\u63a2\u9488\u5b9e\u6d4b\u5168\u90e8\u5ffd\u7565\uff09\uff0c\u5206\u7c7b\u5728\u5df2\u53d6\u56de\u7684 45000 \u884c\uff08\u76ee\u5f55\u5171 88993 \u6761\uff09\u5185\u672c\u5730\u8fc7\u6ee4\uff0c\u8de8\u9875\u6709\u6548\uff1b\u672c\u7c7b\u5b9e\u6d4b 2257 \u6761\uff1b\u53ef\u8fbe\u96c6\u5408\u5916\u7684\u5206\u7c7b\u4f1a\u6f0f';
const HINT_165_INTR = 'ModelScope \u5206\u7c7b\u53d6\u6570\u4e2d\u65ad\uff08\u7b2c 43 \u9875\u8d85\u65f6\uff09\uff1a\u53ef\u8fbe\u96c6\u5408\u53ea\u5230\u5df2\u53d6\u56de\u7684 42000 \u884c\uff08\u76ee\u5f55\u5171 88993 \u6761\uff09\uff0c\u8be5\u7c7b\u5728\u8fd9\u4e9b\u884c\u5185\u547d\u4e2d 2100 \u6761\uff1b\u8fd9\u4e0d\u662f\u300c\u8be5\u5206\u7c7b\u6ca1\u6709\u5339\u914d\u300d\uff0c\u662f\u53d6\u6570\u5931\u8d25\uff0c\u4e0b\u6b21\u641c\u7d22\u4f1a\u4ece\u7b2c 44 \u9875\u7ee7\u7eed\u8865\u62c9';

console.log('\nTest 1: \u7248\u672c\u6307\u7eb9\u53ea\u8ba4\u63aa\u8f9e\uff08\u4e09\u8f6e\u8bef\u5224\u7684\u7ed3\u8bba\uff09');
{
  check('0.5.164 \u6b63\u5e38\u6001\u539f\u6587 \u2192 old', fingerprintOf(HINT_164) === 'old', fingerprintOf(HINT_164));
  check('0.5.165 \u6b63\u5e38\u6001\u539f\u6587 \u2192 new', fingerprintOf(HINT_165) === 'new', fingerprintOf(HINT_165));
  check('0.5.165 \u4e2d\u65ad\u6001\u539f\u6587 \u2192 new\uff08\u4e2d\u65ad\u5206\u652f\u662f 0.5.165 \u624d\u6709\u7684\uff09', fingerprintOf(HINT_165_INTR) === 'new', fingerprintOf(HINT_165_INTR));
  check('\u4e24\u7248\u90fd\u542b\u300c\u53ef\u8fbe\u96c6\u5408\u5916\u7684\u5206\u7c7b\u4f1a\u6f0f\u300d\uff0c\u4f46 164 \u4ecd\u5f52 old', HINT_164.includes('\u53ef\u8fbe\u96c6\u5408\u5916\u7684\u5206\u7c7b\u4f1a\u6f0f') && HINT_165.includes('\u53ef\u8fbe\u96c6\u5408\u5916\u7684\u5206\u7c7b\u4f1a\u6f0f') && fingerprintOf(HINT_164) === 'old');
  check('\u7a7a\u6587\u672c \u2192 unknown\uff08\u4e0d\u5f97\u76d7\u5224\u65b0\u7801\uff09', fingerprintOf('') === 'unknown' && fingerprintOf(null) === 'unknown');
  check('\u65e0\u5173\u6587\u6848 \u2192 unknown', fingerprintOf('\u4e0a\u6e38\u4e0d\u53ef\u8fbe') === 'unknown');
  // 交叉验证：判据用的两个标记必须与真实 tag 源码一致（否则判据自己会漂）
  let b164 = '', b165 = '';
  try { b164 = execFileSync('git', ['show', 'v0.5.164:src/extra-sources.js'], { cwd: path.join(process.cwd()), encoding: 'utf8', env: process.env, windowsHide: true }); } catch { /* 无 tag 历史 ⇒ SKIP */ }
  try { b165 = execFileSync('git', ['show', 'v0.5.165:src/extra-sources.js'], { cwd: path.join(process.cwd()), encoding: 'utf8', env: process.env, windowsHide: true }); } catch { /* 同上 */ }
  if (b164 && b165) {
    check('\u771f\u5b9e\u6e90\u7801\u4e92\u8bc1\uff1a164 \u6709\u300c\u5206\u7c7b\u5728\u53ef\u8fbe\u7684\u300d\u3001\u65e0\u300c\u5df2\u53d6\u56de\u300d', b164.includes('\u5206\u7c7b\u5728\u53ef\u8fbe\u7684') && !b164.includes('\u5206\u7c7b\u5728\u5df2\u53d6\u56de\u7684'));
    check('\u771f\u5b9e\u6e90\u7801\u4e92\u8bc1\uff1a165 \u6709\u300c\u5206\u7c7b\u5728\u5df2\u53d6\u56de\u7684\u300d\u4e0e\u300c\u53d6\u6570\u4e2d\u65ad\u300d\u3001\u65e0\u300c\u5206\u7c7b\u5728\u53ef\u8fbe\u7684\u300d', b165.includes('\u5206\u7c7b\u5728\u5df2\u53d6\u56de\u7684') && b165.includes('\u53d6\u6570\u4e2d\u65ad') && !b165.includes('\u5206\u7c7b\u5728\u53ef\u8fbe\u7684'));
  } else {
    skip('\u771f\u5b9e\u6e90\u7801\u4e92\u8bc1\uff08\u672c\u4ed3\u65e0 tag \u5386\u53f2\uff0cCI fetch-depth=1 \u5e38\u89c1\uff09', 'git show tag failed');
  }
}

console.log('\nTest 2: \u63a2\u9488\u8bfb\u5bf9\u5b57\u6bb5\uff08hints \u6570\u7ec4\uff0c\u4e0d\u662f hint\uff09');
{
  const shaped = { hints: ['skillhub\uff1a\u672c\u5730\u8fc7\u6ee4 3', 'modelscope\uff1a' + HINT_165] };
  check('\u4ece hints \u6570\u7ec4\u53d6\u5230 modelscope \u90a3\u6761', pickHint(shaped, 'modelscope').startsWith('modelscope\uff1a'));
  const wrong = { hint: HINT_165 };
  check('\u53ea\u6709 hint\uff08\u5355\u6570\uff09\u65f6\u53d6\u4e0d\u5230 \u2192 \u7a7a\u4e32\uff08\u6362 unknown\uff0c\u4e0d\u8bfb\u9519\u5b57\u6bb5\u4e5f\u4e0d\u76d7\u5224\uff09', pickHint(wrong, 'modelscope') === '');
  check('\u7f3a\u5b57\u6bb5\u4e0d\u629b', pickHint(null, 'modelscope') === '' && pickHint({}, 'modelscope') === '' && pickHint({ hints: 'x' }, 'modelscope') === '');
  check('\u6ca1\u6709\u547d\u4e2d\u6e90\u65f6\u4e0d\u4e71\u62ff\u522b\u5bb6', pickHint({ hints: ['skillhub\uff1ax'] }, 'modelscope') === '');
}

console.log('\nTest 3: \u5224\u636e B \u56db\u6001\uff08PASS / LIVE-FAIL / GAP / NOT-TESTED\uff09');
{
  const okBrowse = { http: 200, total: 8993 };
  const ok = { http: 200, total: 2257, categoryNote: '', degraded: [], hint: HINT_165 };
  check('\u6709\u6761\u76ee + \u65e0\u8c0e\u6587\u6848 + \u65e0\u964d\u7ea7 \u2192 PASS', verdictB(ok, { hard: true, browse: okBrowse }).verdict === 'PASS');
  check('\u4ecd\u8bf4\u300c\u4e0d\u63d0\u4f9b\u5206\u7c7b\u4fe1\u606f\u300d\u2192 LIVE-FAIL', verdictB({ http: 200, total: 2257, categoryNote: '\u6240\u9009\u6765\u6e90\u4e0d\u63d0\u4f9b\u5206\u7c7b\u4fe1\u606f\uff0c\u5df2\u5ffd\u7565\u5206\u7c7b\u7b5b\u9009' }, { hard: true, browse: okBrowse }).verdict === 'LIVE-FAIL');
  check('\u5e26\u964d\u7ea7 \u2192 LIVE-FAIL', verdictB({ http: 200, total: 2257, degraded: ['modelscope|timeout'] }, { hard: true, browse: okBrowse }).verdict === 'LIVE-FAIL');
  const z = { http: 200, total: 0, categoryNote: '', degraded: [], hint: HINT_165 };
  check('\u786c\u5206\u7c7b 0 \u6761 + \u6d4f\u89c8\u6001\u6709\u8d27 \u2192 LIVE-FAIL', verdictB(z, { hard: true, browse: okBrowse }).verdict === 'LIVE-FAIL');
  check('\u786c\u5206\u7c7b 0 \u6761 + \u6d4f\u89c8\u6001\u4e5f 0 \u6761 \u2192 NOT-TESTED', verdictB(z, { hard: true, browse: { http: 200, total: 0 } }).verdict === 'NOT-TESTED');
  check('\u786c\u5206\u7c7b 0 \u6761 + \u6d4f\u89c8\u6001\u672a\u53d6\u5f97 \u2192 NOT-TESTED', verdictB(z, { hard: true, browse: null }).verdict === 'NOT-TESTED');
  // 监测方 07:17 实测的坑：监控 类 0 条但同词浏览态 total=1512，那是覆盖缺口不是回归
  check('\u8f6f\u62a5\u5206\u7c7b 0 \u6761\u4e14\u65e0\u4e2d\u65ad\u63aa\u8f9e \u2192 GAP\uff08\u4e0d\u5224\u7ea2\uff09', verdictB(z, { hard: false }).verdict === 'GAP');
  check('0 \u6761\u4f46\u6587\u6848\u81ea\u627f\u53d6\u6570\u4e2d\u65ad \u2192 LIVE-FAIL\uff08\u8f6f\u62a5\u4e5f\u4e0d\u653e\u8fc7\u9a97\u8bcd\uff09', verdictB({ http: 200, total: 0, hint: HINT_165_INTR }, { hard: false }).verdict === 'LIVE-FAIL');
  check('RPC \u975e 200 \u2192 LIVE-FAIL', verdictB({ http: 500 }, { hard: false }).verdict === 'LIVE-FAIL');
  check('RPC 连不上（http=0 无状态码）→ NOT-TESTED（判据未执行，不判红）', verdictB({ http: 0 }, { hard: true }).verdict === 'NOT-TESTED' && verdictB({ http: 0 }, { hard: false }).verdict === 'NOT-TESTED' && verdictB(null, { hard: true }).verdict === 'NOT-TESTED');
  // ── 0.5.179 遗留①（冷缓存抖动误报）──
  // 凭据：0.5.178 台账里同一条「监控」判据两轮 LIVE-FAIL（wall=30.1s/53.6s）、一轮 GAP（wall=2ms），
  // 差别只在服务端这一轮是否正在拉整份行集。冷态不是回归，判红就是把抖动当故障；
  // 但「未定性」也不是通过，所以单列 NOT-WARM 态：不判红、也绝不写 PASS。
  const coldRow = { http: 200, total: 0, categoryNote: '', degraded: [], hint: HINT_165_INTR, wall: 53625 };
  check('冷态形状（0 条 + 中断措辞 + wall 53625ms）→ NOT-WARM（不判红）', verdictB(coldRow, { hard: true, browse: okBrowse }).verdict === 'NOT-WARM', JSON.stringify(verdictB(coldRow, { hard: true, browse: okBrowse })));
  check('冷态行 kind=WARM（不参与「一行红就全红」的 HARD 取容）', verdictB(coldRow, { hard: true, browse: okBrowse }).kind === 'WARM', JSON.stringify(verdictB(coldRow, { hard: true, browse: okBrowse })));
  check('冷态 why 说实话（点明冷缓存与「不写 PASS」）', /COLD/.test(verdictB(coldRow, { hard: true, browse: okBrowse }).why) && /PASS/.test(verdictB(coldRow, { hard: true, browse: okBrowse }).why), verdictB(coldRow, { hard: true, browse: okBrowse }).why);
  check('热态仍自承中断（wall 300ms）→ LIVE-FAIL（真取数失败不放过）', verdictB({ http: 200, total: 0, hint: HINT_165_INTR, wall: 300 }, { hard: false }).verdict === 'LIVE-FAIL', JSON.stringify(verdictB({ http: 200, total: 0, hint: HINT_165_INTR, wall: 300 }, { hard: false })));
  check('wall 缺失 + 中断措辞 → LIVE-FAIL（无从定冷态时守旧口径判红）', verdictB({ http: 200, total: 0, hint: HINT_165_INTR }, { hard: false }).verdict === 'LIVE-FAIL');
  check('中断措辞但有条目（拉到一半）→ PASS，冷态只看 0 条分支', verdictB({ http: 200, total: 2100, hint: HINT_165_INTR, wall: 53625 }, { hard: true, browse: okBrowse }).verdict === 'PASS');
  check('冷阈值边界：wall=25000 不算冷、25001 算冷', verdictB({ http: 200, total: 0, hint: HINT_165_INTR, wall: 25000 }, { hard: false }).verdict === 'LIVE-FAIL' && verdictB({ http: 200, total: 0, hint: HINT_165_INTR, wall: 25001 }, { hard: false }).verdict === 'NOT-WARM');
  check('非中断措辞的 0 条不受冷态分支影响（软报仍 GAP）', verdictB({ http: 200, total: 0, hint: HINT_165, wall: 53625 }, { hard: false }).verdict === 'GAP');
  check('谎文案/降级仍然优先于冷态豁免', verdictB({ http: 200, total: 0, categoryNote: '所选来源不提供分类信息，已忽略分类筛选', hint: HINT_165_INTR, wall: 53625 }, { hard: true, browse: okBrowse }).verdict === 'LIVE-FAIL' && verdictB({ http: 200, total: 0, degraded: ['modelscope|timeout'], hint: HINT_165_INTR, wall: 53625 }, { hard: true, browse: okBrowse }).verdict === 'LIVE-FAIL');
}

console.log('\nTest 4: \u6c47\u603b\u2014\u2014\u672a\u6d4b\u6210\u7edd\u4e0d\u5199 PASS\uff0cGAP \u4e0d\u62c9\u4f4e\u7ed3\u8bba');
{
  const H = (v) => ({ verdict: v, kind: 'HARD' }), G = { verdict: 'GAP', kind: 'GAP' };
  check('fp=old \u2192 STALE-SERVER\uff08\u5148\u4e8e\u4e00\u5207\u884c\u7ed3\u8bba\uff09', summarize([H('PASS'), H('PASS')], 'old') === 'STALE-SERVER');
  check('fp=unknown \u2192 NOT-RUN', summarize([H('PASS')], 'unknown') === 'NOT-RUN');
  check('\u4e00\u884c LIVE-FAIL \u2192 LIVE-FAIL', summarize([H('PASS'), H('LIVE-FAIL')], 'new') === 'LIVE-FAIL');
  check('\u5168\u90e8 NOT-TESTED \u2192 NOT-RUN\uff08\u4e0d\u662f PASS\uff09', summarize([H('NOT-TESTED'), H('NOT-TESTED')], 'new') === 'NOT-RUN');
  check('\u90e8\u5206 NOT-TESTED + \u5176\u4f59 PASS \u2192 PASS', summarize([H('NOT-TESTED'), H('PASS')], 'new') === 'PASS');
  check('\u53ea\u6709 GAP \u884c \u2192 PASS\uff08\u8986\u76d6\u7f3a\u53e3\u4e0d\u662f\u5931\u8d25\uff09', summarize([H('PASS'), G], 'new') === 'PASS');
  // GAP \u884c\u4e0d\u5f97\u628a\u300c\u5176\u4f59\u5168\u672a\u6d4b\u6210\u300d\u63fd\u6210 PASS\uff08\u5426\u5219\u6574\u8f6e\u7a7a\u8dd1\u4e5f\u4f1a\u62a5\u7eff\uff09
  check('GAP + \u5176\u4f59\u5168 NOT-TESTED \u2192 NOT-RUN', summarize([G, H('NOT-TESTED'), H('NOT-TESTED')], 'new') === 'NOT-RUN');
  check('GAP + \u4e00\u6761\u771f\u76ee\u51fb \u2192 PASS', summarize([G, H('PASS')], 'new') === 'PASS');
  // 0.5.179 遗留①：冷态行绝不许把整轮兜成 PASS，也不许掩掉真红。
  const W = { verdict: 'NOT-WARM', kind: 'WARM' };
  check('NOT-WARM + 其余 PASS → NOT-WARM（未定性不写 PASS）', summarize([H('PASS'), H('PASS'), W], 'new') === 'NOT-WARM', summarize([H('PASS'), H('PASS'), W], 'new'));
  check('NOT-WARM + 真 LIVE-FAIL → LIVE-FAIL（真失败压过冷态告警）', summarize([H('LIVE-FAIL'), W], 'new') === 'LIVE-FAIL', summarize([H('LIVE-FAIL'), W], 'new'));
  check('全部 NOT-WARM → NOT-WARM（既不是 PASS 也不是 NOT-RUN）', summarize([W, W], 'new') === 'NOT-WARM');
  check('NOT-WARM + 其余 NOT-TESTED → NOT-WARM（目击过一轮就比没测成强）', summarize([W, H('NOT-TESTED')], 'new') === 'NOT-WARM');
  check('GAP + NOT-WARM → NOT-WARM（覆盖缺口可放行，未定性不能放行）', summarize([G, W], 'new') === 'NOT-WARM');
}

console.log('\nTest 4b: \u5899\u949f\u9884\u7b97\uff080.5.165 \u5206\u9875\u63d0\u901f\u7684\u670d\u52a1\u7aef\u5224\u636e\uff09');
{
  check('87999ms \u2192 PASS', wallVerdict(87999).verdict === 'PASS');
  check('88001ms \u2192 LIVE-FAIL\uff08\u65e7\u7801 90s abort \u524d\u6cbf\uff09', wallVerdict(88001).verdict === 'LIVE-FAIL');
  check('\u81ea\u5b9a\u4e49\u4e0a\u9650\u751f\u6548', wallVerdict(5000, 3000).verdict === 'LIVE-FAIL' && wallVerdict(2000, 3000).verdict === 'PASS');
  check('wall \u7f3a\u5931/\u8d1f\u503c \u2192 NOT-TESTED', wallVerdict(undefined).verdict === 'NOT-TESTED' && wallVerdict(-1).verdict === 'NOT-TESTED');
  check('17412ms\uff08\u672c\u8f6e\u5b9e\u6d4b\u65e7\u7801\u6700\u6162\u503c\uff09\u2192 PASS\uff08\u9884\u7b97\u53ea\u6293\u65e7\u7801\u7ea7\u574d\uff0c\u4e0d\u6293\u6296\u52a8\uff09', wallVerdict(17412).verdict === 'PASS');
  check('90300ms\uff080.5.164 \u5b9e\u6d4b abort \u503c\uff09\u2192 LIVE-FAIL', wallVerdict(90300).verdict === 'LIVE-FAIL');
}

console.log('\nTest 5: \u7aef\u53e3\u81ea\u53d1\u73b0\uff08\u4e0d\u5199\u6b7b 60027\uff09');
{
  const sample = [
    '  TCP    127.0.0.1:60027        0.0.0.0:0              LISTENING       18360',
    '  TCP    127.0.0.1:52849        0.0.0.0:0              LISTENING       18360',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:3425         127.0.0.1:52849        ESTABLISHED     18360',
    '  TCP    127.0.0.1:3425         0.0.0.0:0              LISTENING       9999',
  ].join('\n');
  const ps = discoverPorts(sample);
  check('\u53ea\u6536 127.0.0.1 \u4e14\u53ea\u6536 LISTENING', ps.length === 3 && ps.includes(60027) && ps.includes(52849) && ps.includes(3425), JSON.stringify(ps));
  check('\u53bb\u91cd', new Set(ps).size === ps.length);
  check('\u7a7a\u8f93\u5165 \u2192 \u7a7a\u6570\u7ec4\uff08\u4e0d\u629b\uff09', discoverPorts('').length === 0 && discoverPorts(null).length === 0);
  check('powershell \u7aef\u53e3\u56de\u9000\u8def\u5f84\u540c\u6837\u53bb\u91cd\u4e14\u4e22\u975e\u6570\u5b57', JSON.stringify(portsFromPs('60027\n52849\n60027\n\nabc\n')) === '[60027,52849]', JSON.stringify(portsFromPs('60027\n52849\n60027\n\nabc\n')));
}

console.log('\nTest 6: \u8bcd\u8868\u5f62\u72b6\u9501\uff08\u8bfb categories\uff0c\u8bfb rows \u6052 0\uff09');
{
  const settings = { categoryVocabulary: { modelscope: { capturedAt: 1, source: 'modelscope', categories: [{ slug: 'a', label: 'A' }, { slug: 'b', label: 'B' }] } } };
  const v = vocabOf(settings, 'modelscope');
  check('\u4ece categories \u6570\u7ec4\u8bfb\u5230 2 \u6761', v.count === 2 && v.cats.length === 2);
  check('capturedAt \u4e00\u5e76\u5e26\u51fa', v.capturedAt === 1);
  check('\u8bfb .rows \u4f1a\u5f97 0\uff08\u56e0\u6b64\u4e0d\u8bb8\u8bfb rows\uff09', vocabOf({ categoryVocabulary: { modelscope: { rows: 8 } } }, 'modelscope').count === 0);
  check('\u6e90\u7f3a\u5931\u4e0d\u629b', vocabOf({}, 'modelscope').count === 0 && vocabOf(null, 'x').count === 0);
}

console.log('\nTest 7: lobehub \u7a97\u53e3/\u672a\u5217\u51fa\u7684\u5206\u7c7b\u590d\u7b97\uff08\u4e0e\u9762\u677f\u6587\u6848\u5bf9\u8d26\u7684\u7b97\u6cd5\uff09');
{
  const cats = [];
  for (let i = 0; i < 40; i++) cats.push({ slug: 'c' + i, count: 100 - i });
  const f = lobeWindowFold(cats, 32);
  check('\u7a97\u53e3\u9ed8\u8ba4 32 \u4e2a', f.winCount === 32 && f.outCount === 8);
  check('\u5e94\u7528\u4fa7\u603b\u548c = \u7a97\u5185 + \u7a97\u5916', f.sumAll === f.winSum + f.outSum);
  check('\u7a97\u5916\u6761\u76ee\u5c31\u662f\u6392\u5e8f\u540e\u7684\u5c3e\u90e8', f.outSum === [100 - 32, 100 - 33, 100 - 34, 100 - 35, 100 - 36, 100 - 37, 100 - 38, 100 - 39].reduce((s, x) => s + x, 0));
  check('\u7a7a/\u975e\u6570\u7ec4\u4e0d\u629b', lobeWindowFold(null, 32).total === 0 && lobeWindowFold([], 32).outSum === 0);
  check('totalAll \u4f5c count \u56de\u9000\uff08\u771f\u5b9e\u8bcd\u8868\u53ea\u6709 totalAll\uff09', lobeWindowFold([{ slug: 'x', totalAll: 5 }], 1).sumAll === 5);
}

console.log('\nTest 8: \u811a\u672c\u81ea\u8eab\u7684\u5f62\u72b6\u9501\uff08\u4e00\u952e\u4ee4\u4ee4\u53ef\u88ab\u673a\u5668\u6d88\u8d39\uff09');
{
  const v = readFileSync(path.join(process.cwd(), 'test', 'live-verify.mjs'), 'utf8');
  check('\u9000\u51fa\u7801\u533a\u5206 NOT-RUN(3) \u4e0e STALE-SERVER(4)', /process\.exit\(3\)/.test(v) && /STALE-SERVER/.test(v));
  check('\u627e\u4e0d\u5230\u7aef\u70b9\u65f6\u6253 NOT-RUN \u4e14\u58f0\u660e\u4e0d\u5199 PASS/FAIL', /NOT-RUN/.test(v) && /\u4e0d\u5199 PASS\/FAIL/.test(v));
  check('\u4e0d\u5199\u6b7b\u7aef\u53e3\uff08\u53ea\u8d70 settings.get + categoryVocabulary \u8ba4\u6307\u7eb9\uff09', /categoryVocabulary/.test(v) && !/127\.0\.0\.1:60027/.test(v));
  check('\u4e0d\u76d1\u542c\u65f6\u4e5f\u4e0d\u56de\u9000\u6210\u786c\u7f16\u7801\u7aef\u53e3', /process\.exit\(3\)/.test(v.slice(v.indexOf('NOT-RUN'))) || /process\.exit\(3\)/.test(v));
  check('\u5bfc\u5165\u65e0\u526f\u4f5c\u7528\uff08\u8499\u4e0a isMain \u5b88\u536b\uff09', /const isMain/.test(v));
  const rep = { port: 1, fp: 'new', hint: 'x', rows: [{ name: 'a', verdict: 'PASS', why: 'w', kind: 'HARD' }] };
  const txt = render(rep, false);
  check('render \u975e json \u6253\u6bcf\u884c\u5224\u8bcd + \u8ba1\u6570', txt.includes('[PASS] a') && /rows=1 LIVE-FAIL=0 NOT-TESTED=0 GAP=0/.test(txt), txt.split('\n')[0]);
  check('render --json \u53ef\u89e3\u6790', JSON.parse(render(rep, true)).rows[0].name === 'a');
  // 本批修过的真实缺陷：--json 既打 JSON 又打 RESULT 行，机器消费者 JSON.parse 直接炸
  const main = v.slice(v.indexOf('const isMain'));
  const jsonBranch = main.indexOf('if (asJson) {');
  const resultLine = main.indexOf("console.log('RESULT: '");
  check('--json \u5206\u652f\u5b58\u5728\u4e14\u5728 RESULT \u884c\u4e4b\u524d\u9000\u51fa', jsonBranch >= 0 && resultLine > jsonBranch);
  check('--json \u5206\u652f\u5185\u81ea\u5df1 exit\uff08\u4e0d\u4f1a\u843d\u5230\u540e\u9762\u7684\u6587\u672c\u6253\u5370\uff09', /if \(asJson\) \{[\s\S]{0,400}?process\.exit\(/.test(main));
  check('--json \u6253\u7684\u662f\u542b verdict \u7684\u5355\u4efd\u5bf9\u8c61', /JSON\.stringify\(\{ result: v/.test(main));
  // M7 变式（json 分支改打 RESULT 行并恒退 0）必须被抓：分支里先打 JSON，退出码必须区分四态
  check('--json 分支内 JSON 打印在 exit 之前', /if \(asJson\) \{[\s\S]{0,80}?console\.log\(JSON\.stringify/.test(main));
  const branchExit = main.slice(main.indexOf('if (asJson) {'), main.indexOf('if (asJson) {') + 500);
  check('--json 分支的 exit 不得恒退 0', !/process\.exit\(0\)/.test(branchExit) && /STALE-SERVER' \? 4/.test(branchExit));
  // 双重防线：即使分支落到文本打印，消费者截取第一个 '{' 也会吞进 RESULT 尾巴；正确形状只能是单份完整文档
  const single = render(rep, true);
  check('--json 单份文档且无 RESULT 尾巴', JSON.parse(single).rows[0].name === 'a' && !/RESULT:/.test(single));
  // 0.5.179 遗留①：防抖必须落在脚本里，且只重试一次（无限等热会把回归藏成慢）。
  check('冷态常量在位（COLD_MARK / COLD_WALL_MS）', /COLD_MARK/.test(v) && /COLD_WALL_MS/.test(v));
  check('同轮重试有预算上限（MAX_WARM_RETRIES）且无 while(true) 等热循环', /MAX_WARM_RETRIES/.test(v) && !/while\s*\(\s*true\s*\)/.test(v));
  check('重试等待可用 --retry-wait 覆盖', /--retry-wait/.test(v));
  check('重试次数留在 shape 里可审计（warmRetries 记账）', /warmRetries/.test(v));
  check('退出码新增 NOT-WARM=5，旧码 3/4 仍在位', /NOT-WARM' \? 5/.test(v) && /STALE-SERVER' \? 4/.test(v) && /process\.exit\(3\)/.test(v));
  check('计数行带 NOT-WARM 计数', /NOT-WARM=' \+ /.test(v));
  const repW = { port: 1, fp: 'new', hint: 'x', rows: [{ name: 'a', verdict: 'NOT-WARM', why: 'w', kind: 'WARM' }] };
  check('render 计数含 NOT-WARM=1', /NOT-WARM=1/.test(render(repW, false)), render(repW, false).split('\n').slice(-1)[0]);
}


// Test 9（新增段；原文件只到 Test 8）：端到端 —— RPC 打不通时脚本必须优雅退 3，绝不抛 TypeError。
// 现网事故形状：node test/live-verify.mjs --port <死端口> --timeout 3000
//   ⇒ TypeError: Cannot read properties of undefined (reading 'slice') at runAll（:214 的 JSON.stringify(zz.categoryNote).slice）
//   exit=1 绕过 :16 的退出码契约（3=NOT-RUN 判据未执行，绝不写 PASS/FAIL），一个 row 都出不来。
// 端口 59999 必须没人监听：本段绝不联网打活端口，只打 127.0.0.1 上的死端口。
console.log('\nTest 9: 端到端 —— RPC 打不通 ⇒ exit=3 + NOT-RUN 行，绝不 TypeError');
{
  const ROOT = path.resolve(process.cwd());
  const SCRIPT = path.join('test', 'live-verify.mjs');
  const run = (extra) => {
    const argv = [SCRIPT, '--port', '59999', '--timeout', '1500'].concat(extra || []);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true });
    return { r, wall: Date.now() - t0 };
  };
  const plain = run([]);
  check('死端口文本形态 exit=3（NOT-RUN 契约，不是崩溃的 1）', plain.r.status === 3, 'status=' + String(plain.r.status) + ' wall=' + plain.wall + 'ms');
  check('死端口 stdout 无 TypeError 字样', !/TypeError/.test(String(plain.r.stdout || '')), String(plain.r.stderr || '').slice(0, 160));
  check('死端口 stderr 无 TypeError（崩溃兜不住时这里必现）', !/TypeError/.test(String(plain.r.stderr || '')), String(plain.r.stderr || '').slice(0, 200));
  check('死端口 stdout 含 NOT-RUN「判据未执行」行', /NOT-RUN/.test(String(plain.r.stdout || '')) && /判据未执行/.test(String(plain.r.stdout || '')), String(plain.r.stdout || '').slice(0, 200));
  check('死端口 stdout 不写 PASS/FAIL', !/RESULT: (PASS|LIVE-FAIL)/.test(String(plain.r.stdout || '')), String(plain.r.stdout || '').split('\n').slice(-2).join(' / '));
  check('死端口 stdout 逐行列出判据（NOT-TESTED 行在位，不是空表）', /\[NOT-TESTED\]/.test(String(plain.r.stdout || '')), String(plain.r.stdout || '').split('\n').length + ' lines');
  const jsonRun = run(['--json']);
  check('死端口 --json 形态 exit=3', jsonRun.r.status === 3, 'status=' + String(jsonRun.r.status) + ' wall=' + jsonRun.wall + 'ms');
  let doc = null, perr = '';
  try { doc = JSON.parse(String(jsonRun.r.stdout || '')); } catch (e) { perr = String((e && e.message) || e); }
  check('死端口 --json 是单份可 JSON.parse 的文档', doc !== null, perr + ' | ' + String(jsonRun.r.stdout || '').slice(0, 120));
  check('死端口 --json result=NOT-RUN 且 rows 非空', !!doc && doc.result === 'NOT-RUN' && Array.isArray(doc.rows) && doc.rows.length > 0, doc ? String(doc.result) + ' rows=' + (doc.rows || []).length : 'unparsable');
}


// Test 10：冷态判据自证 —— 每条静态锁都要能被一次内存变异打掉，否则它是空转的装饰。
// 变异只作用于 readFileSync 得到的字符串副本，绝不写盘（本仓另有真写 client.js 的变异针，这里不需要）。
console.log('\nTest 10: 冷态判据自证（内存变异，不落盘）');
{
  const v10 = readFileSync(path.join(process.cwd(), 'test', 'live-verify.mjs'), 'utf8');
  const RE = /while\s*\(\s*true\s*\)/;
  const ln2 = (txt, frag) => new RegExp(frag.replace(/[().*+?^${}|\\]/g, '\\  const ln = (pred) =>'));
  const ln = (pred) => v10.split('\n').filter((l) => !l.trimStart().startsWith('//')).find(pred) || '';
  // L1：NOT-WARM 必须同时被 COLD_MARK 与 COLD_WALL_MS 守护
  const coldLine = ln((l) => l.includes("verdict: 'NOT-WARM'") && l.includes('if (hint.includes(COLD_MARK)'));
  check('L1 冷态行在位且带 COLD_MARK/COLD_WALL_MS 双守护', coldLine.includes('COLD_MARK') && coldLine.includes('> COLD_WALL_MS'), coldLine.trim().slice(0, 90));
  check('L1 变异：删掉墙钟守护后该锁必红（否则热态真失败会被放过）', !!coldLine && !coldLine.replace(' && numOr(cat.wall, 0) > COLD_WALL_MS', '').includes('> COLD_WALL_MS'));
  // L2：重试循环必须有预算上限
  const loopLine = ln((l) => l.includes('while (tried < MAX_WARM_RETRIES'));
  check('L2 重试走有界 while 且全文件无 while(true) 等热', !!loopLine && !RE.test(v10), loopLine.trim().slice(0, 70));
  const loopMut = loopLine.replace('tried < MAX_WARM_RETRIES && isCold(c)', 'true');
  check('L2 变异一：上限退化成 while (true) 后 RE 必命中（锁会红）', !!loopLine && RE.test(loopMut), loopLine.trim().slice(0, 58) + '  ==>  ' + loopMut.trim());
  const findIn = (txt) => (frag) => txt.split('\n').filter((l) => !l.trimStart().startsWith('//')).find((l) => l.includes(frag)) || '';
  const noLoop = v10.split('\n').filter((l) => !l.includes('while (tried < MAX_WARM_RETRIES')).join('\n');
  check('L2 变异二：删掉整条有界 while 后 loopLine 取空 ⇒ 主锁 !!loopLine 会红', findIn(noLoop)('while (tried < MAX_WARM_RETRIES') === '' && findIn(v10)('while (tried < MAX_WARM_RETRIES') === loopLine);
  // L3：重试触发面必须窄
  const isColdLine = ln((l) => l.includes('const isCold ='));
  check('L3 isCold 四条件齐备', isColdLine.includes('c.http === 200') && isColdLine.includes('c.total, 0) === 0') && isColdLine.includes('COLD_MARK') && isColdLine.includes('COLD_WALL_MS'), isColdLine.trim().slice(0, 130));
  check('L3 变异：放宽到不看 http 后该锁必红', !!isColdLine && !isColdLine.replace('c.http === 200 &&', '').includes('c.http === 200'));
  // L4：WARM 不混进 HARD 取容，且冷态结论排在真红之后
  const hardLine = ln((l) => l.includes('const hard = rows.filter'));
  check('L4 hard 取容排除 GAP 与 WARM', hardLine.includes("!== 'GAP'") && hardLine.includes("!== 'WARM'"), hardLine.trim());
  const iFail = v10.indexOf("r.verdict === 'LIVE-FAIL')) return 'LIVE-FAIL'");
  const iWarm = v10.indexOf("if (warm) return 'NOT-WARM'");
  check('L4 冷态结论排在真红之后（冷不许掩红）', iFail >= 0 && iWarm > iFail, 'LIVE-FAIL@' + iFail + ' warm@' + iWarm);
  // L5：NOT-WARM=5 必须排在兜底 :3 之前，否则冷态被误报成 NOT-RUN
  const ex = v10.split('\n').filter((l) => l.includes("process.exit(v === 'PASS'"));
  check('L5 两处 exit 都是 PASS0/STALE4/FAIL1/WARM5/兜底3 次序', ex.length === 2 && ex.every((l) => l.indexOf("'NOT-WARM' ? 5") > l.indexOf("'LIVE-FAIL' ? 1") && l.indexOf("'NOT-WARM' ? 5") < l.lastIndexOf(': 3)')), ex.join(' ~ ').slice(0, 170));
  // L6：RPC 连不上时绝不判冷（端到段 NOT-RUN 通路不被重试拖慢）
  const coldOff = verdictB({ http: 0, total: 0, hint: HINT_165_INTR, wall: 60000 }, { hard: false });
  check('L6 http=0 即便带中断措辞也不判冷', coldOff.verdict === 'NOT-TESTED', JSON.stringify(coldOff));
  // L7：render 的行内标记与计数同源
  const repW7 = { port: 1, fp: 'new', hint: 'x', rows: [{ name: 'a', verdict: 'NOT-WARM', why: 'w', kind: 'WARM' }, { name: 'b', verdict: 'PASS', why: 'w', kind: 'HARD' }] };
  const t7 = render(repW7, false);
  check('L7 render 同时给出 (冷态) 标记与 NOT-WARM=1', t7.includes('(冷态)') && /rows=2 LIVE-FAIL=0 NOT-TESTED=0 GAP=0 NOT-WARM=1/.test(t7), t7.split('\n').pop());
  // L8：冷态不改指纹优先级（STALE-SERVER 仍先于一切）
  check('L8 fp=old 压过冷态（服务端没换就是没换）', summarize([{ verdict: 'NOT-WARM', kind: 'WARM' }], 'old') === 'STALE-SERVER');
}
console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
