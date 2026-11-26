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

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
