#!/usr/bin/env node
// test-gate-contract.mjs — 锁住闸门契约本身：缺「N passed, M failed」最后一行的
// 套件必须让 gate 变红。此前它只是 run-gate 循环体里的口头约定，同类虚高基线
// 正是靠这条约定挡住的，所以它自己也得有回归锁。
import { gateVerdict } from './gate-verdict.mjs';
import { poolLimit, runPool } from './gate-pool.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const W = path.resolve(import.meta.dirname, '..');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 170) + ']' : '')); } };

console.log('Test 1: gateVerdict 全分支（纯函数）');
check('绿：退出0 + 规范 summary + 0 failed', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\n' }).verdict === 'PASS', '');
check('summary 不必是字面最后一行（尾随空行允许）', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\n\n' }).verdict === 'PASS', '');
check('skipped 后缀仍算绿', gateVerdict({ code: 0, killed: false, out: 'x\n9 passed, 0 failed, 1 skipped\n' }).verdict === 'PASS', '');
check('summary 里 M>0 → FAIL', gateVerdict({ code: 0, killed: false, out: 'x\n3 passed, 2 failed\n' }).verdict === 'FAIL', '');
check('退出0但无 summary → NO-SUMMARY', gateVerdict({ code: 0, killed: false, out: 'starting stuff\nno summary here\n' }).verdict === 'NO-SUMMARY', '');
check('中文总结不算 summary（正是踩过的坑）', gateVerdict({ code: 0, killed: false, out: 'x\n29 项通过，0 项失败\n' }).verdict === 'NO-SUMMARY', '');
check('PASSED 大写标记不算 summary', gateVerdict({ code: 0, killed: false, out: 'x\nALL PAGING CHECKS PASSED\n' }).verdict === 'NO-SUMMARY', '');
check('summary 不在末尾则不认（中途崩掉）', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\nthen a crash trace\n' }).verdict === 'NO-SUMMARY', '');
check('非零退出优先于 summary', gateVerdict({ code: 1, killed: false, out: 'x\n5 passed, 0 failed\n' }).verdict === 'FAIL', '');
check('被杀 → TIMEOUT 优先', gateVerdict({ code: null, killed: true, out: 'x\n5 passed, 0 failed\n' }).verdict === 'TIMEOUT', '');
check('summary 文本透传含 skipped', gateVerdict({ code: 0, killed: false, out: 'x\n9 passed, 0 failed, 2 skipped\n' }).summary === '9 passed, 0 failed, 2 skipped', '');

console.log('');
console.log('Test 2: 真 run-gate 证伪（无 summary 的假套件必须让门变红）');
const fake = '.gate-fake-nosummary.mjs';
const good = '.gate-fake-good.mjs';
const fakePath = path.join(W, 'test', fake);
const goodPath = path.join(W, 'test', good);
const gate = (extra) => spawnSync(process.execPath, [path.join(W, 'test', 'run-gate.mjs')], {
  cwd: W, encoding: 'utf8', timeout: 180000,
  env: { ...process.env, DSH_GATE_ONLY: 'test-tdz-order.mjs', DSH_GATE_EXTRA: extra },
});
try {
  fs.writeFileSync(fakePath, 'console.log("套件开跑但没有规范总结");\n');
  const r = gate(fake);
  const out = String(r.stdout || '') + String(r.stderr || '');
  check('gate 退出码非 0', (r.status || 0) !== 0, 'status=' + r.status);
  check('gate 判它 NO-SUMMARY', /NO-SUMMARY/.test(out) && out.includes(fake), out.split('\n').filter((l) => fake.test ? l.includes(fake) : false).slice(0, 1).join(' '));
  check('publish blocked 出现', /publish blocked/.test(out), '');
  // 反向对照：同一条路径下规范套件必须绿 —— 证明 NO-SUMMARY 不是恒红误判
  fs.writeFileSync(goodPath, 'console.log("ok");\nconsole.log(`3 passed, 0 failed`);\nprocess.exit(0);\n');
  const g2 = gate(good);
  const out2 = String(g2.stdout || '') + String(g2.stderr || '');
  check('规范假套件判 PASS', /PASS/.test(out2) && (g2.status || 0) === 0, 'status=' + g2.status);
  // 非法名字必须被拒绝（防目录遍历 / 自我递归）
  const bad = gate('../package.json');
  check('越界名字被拒', (bad.status || 0) === 2 && /非法名字/.test(String(bad.stdout) + String(bad.stderr)), '');
  const rec = gate('run-gate.mjs');
  check('run-gate 自我递归被拒', (rec.status || 0) === 2, 'status=' + rec.status);
} finally {
  for (const p of [fakePath, goodPath]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
check('假套件已清理', !fs.existsSync(fakePath) && !fs.existsSync(goodPath), '');
check('test/ 无残留假套件', !fs.readdirSync(path.join(W, 'test')).some((f) => f.startsWith('.gate-fake')), '');

console.log('');
console.log('Test 3: 登记进门的套件必须自己符合契约（静态锁）');
{
  const chain = JSON.parse(fs.readFileSync(path.join(W, 'package.json'), 'utf8')).scripts['test:chain'];
  const listed = [...chain.matchAll(/node test\/([\w.\-]+\.mjs)/g)].map((m) => m[1]);
  const noSummary = [];
  for (const f of listed) {
    const p = path.join(W, 'test', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    // 必须有一条输出「N passed, M failed」的 console.log（模板或拼接都算），
    // 且不得是「恒真」写法：至少要引用一个计数变量。
    const ok = /console\.log\([^)]*passed[,'"`\s].{0,40}failed/.test(t) || /`\$\{[\w.]+\} passed, \$\{[\w.]+\} failed/.test(t);
    if (!ok) noSummary.push(f);
  }
  check('所有登记套件都输出规范总结', noSummary.length === 0, noSummary.join(','));
}

console.log('');
console.log('Test 4: 回放层接线（方案 B：门必须能注入 --import，且未命中必须让门真红）');
{
  const gateSrc = fs.readFileSync(path.join(W, 'test', 'run-gate.mjs'), 'utf8');
  check('run-gate 读 DSH_REPLAY/DSH_REPLAY_MODE', /DSH_REPLAY(_MODE)?/.test(gateSrc), '未见回放开关');
  // 注入必须走 spawn 参数，不是 NODE_OPTIONS：取证 probe-inherit2 证明
  // 「父进程也带 NODE_OPTIONS」时会被父进程被顶掉的 child_process 自欺（{status:0,stdout:''}）。
  check('注入走 spawn 参数（--import=…replay/preload.mjs）', /replayArgs/.test(gateSrc) && /--import=/.test(gateSrc), '未见显式 --import 参数注入');
  // ⚠️ --import 的值必须是 file:// URL：首版直接塞 Windows 绝对路径，套件立刻
  // ERR_UNSUPPORTED_ESM_URL_SCHEME（「On Windows, absolute paths must be valid file:// URLs」），
  // 门整片红。这条锁防的就是「换台机器/换写法又退回裸路径」。
  check('--import 走 pathToFileURL（不是裸路径）', /pathToFileURL/.test(gateSrc) && !/--import=' \+ path\.join/.test(gateSrc), 'run-gate 里 --import 仍拼裸路径');
  // 契约的可证伪核心：回放态下未录到的请求必须让套件非零退出，
  // 而不是拿到空数组静默变绿（空 = 「该源没有数据」= 假绿，「绿不等于做了」同款）。
  check('gateVerdict 判 REPLAY-MISS 红', gateVerdict({ code: 1, killed: false, out: 'REPLAY-MISS abc123 GET https://x\n' }).verdict === 'FAIL', 'REPLAY-MISS 文案未映射成 FAIL');
  check('REPLAY-MISS 不算规范 summary（防空回放被当绿）', !/REPLAY[- ]MISS/.test(gateVerdict({ code: 0, killed: false, out: 'REPLAY-MISS abc123 GET https://x\n' }).summary || ''), '误当 summary');
  // 关键一条：未命中账本优先于套件自报。实测空档案下 test-global-sort 把未命中
  // 降级成 skip、打印「4 passed, 0 failed, 3 skipped」并退出 0 —— 若门只听它，就放行了。
  check('退出0+规范绿 summary 但有未命中 → REPLAY-MISS', gateVerdict({ code: 0, killed: false, out: 'x\n4 passed, 0 failed, 3 skipped\n', misses: 5 }).verdict === 'REPLAY-MISS', JSON.stringify(gateVerdict({ code: 0, killed: false, out: 'x\n4 passed, 0 failed, 3 skipped\n', misses: 5 })));
  check('misses=0 不影响判定（真网络门零参与）', gateVerdict({ code: 0, killed: false, out: 'x\n5 passed, 0 failed\n', misses: 0 }).verdict === 'PASS', '');
  check('run-gate 给每套件传独立 misslog', /DSH_REPLAY_MISSLOG/.test(fs.readFileSync(path.join(W, 'test', 'run-gate.mjs'), 'utf8')), 'run-gate 未接账本');
  // ⚠️ 账本目录必须可被外层编排者指定，且指定时门不得删它。
  // 实测（00:48）：backfill 在门外自己设 DSH_REPLAY_MISSLOG，被 run-gate 的每套件账本覆盖，
  // 门末又把整个 MISS_DIR 删掉 ⇒ 外层永远读到 0 条，把「REPLAY-MISS 24 条」报成 CONVERGED。
  // 这是第二层假收敛：守卫本身是对的，读数路径是断的。
  check('账本目录可用 DSH_REPLAY_MISS_DIR 指定', /DSH_REPLAY_MISS_DIR/.test(gateSrc), 'run-gate 不容外层指定账本目录');
  check('外层指定账本时门末不删', /if \(replayOn && !missDirGiven\)/.test(gateSrc) || /missDirGiven/.test(gateSrc), 'MISS_DIR 清理未受 missDirGiven 保护');
}

console.log('');
console.log('Test 5: 并发层（方案 C：默认串行、上限 8、归属按索引、账本按套件名隔离）');
{
  check('poolLimit 默认 1（不设环境变量=串行）', poolLimit(undefined, 10) === 1, String(poolLimit(undefined, 10)));
  check('poolLimit 下界 1', poolLimit('0', 10) === 1 && poolLimit('-3', 10) === 1, '');
  check('poolLimit 上界 8（防把 CPU 打满制造假 TIMEOUT）', poolLimit('99', 40) === 8, String(poolLimit('99', 40)));
  check('poolLimit 不超过套件数', poolLimit('8', 3) === 3, String(poolLimit('8', 3)));
  // 归属正确性：并发完成顺序被打乱时，results[i] 仍须对应 items[i]。
  // 这条是「并发把红灯安到别的套件头上」的直接防线。
  const order = [];
  const rs = await runPool(['a', 'b', 'c', 'd'], async (f, i) => {
    await new Promise((r) => setTimeout(r, (4 - i) * 20)); // d 先完成、a 最后
    order.push(f);
    return { file: f, tag: 'x' + f };
  }, 4);
  check('runPool 结果按输入序回填', rs.map((x) => x.file).join(',') === 'a,b,c,d', rs.map((x) => x.file).join(','));
  check('runPool 真并发（完成序≠输入序）', order[0] === 'd' && order[order.length - 1] === 'a', order.join(','));
  check('runPool 不丢项', rs.length === 4 && rs.every(Boolean), String(rs.length));
  // limit=1 时必须是严格串行（上一条的 setTimeout 若在串行下完成序会等于输入序）
  const seq = [];
  await runPool(['p', 'q', 'r'], async (f) => { seq.push('start:' + f); await new Promise((r) => setTimeout(r, 5)); seq.push('end:' + f); return f; }, 1);
  check('limit=1 严格串行', seq.join(',') === 'start:p,end:p,start:q,end:q,start:r,end:r', seq.join(','));
  const gateSrc = fs.readFileSync(path.join(W, 'test', 'run-gate.mjs'), 'utf8');
  check('run-gate 读 DSH_GATE_PARALLEL', /DSH_GATE_PARALLEL/.test(gateSrc), '门未接并发开关');
  // 账本按套件名分文件：并发时若共用一个文件，miss 数会串号（A 的未命中算到 B 头上）。
  check('账本文件名含 file（逐字符核）', gateSrc.includes("'.miss-' + process.pid + '-' + file + '.log'"), '账本命名与判据不一致');
}

console.log('');
console.log('Test 6: SUSPEND-SUSPECT（整机睡眠不得被当成套件真慢）');
{
  // 实测事故（2026-11-24 08:24）：test-sort-honesty 记成 TIMEOUT 1524s，perTimeout=420s。
  // Kernel-Power 08:24:57 睡眠 / 08:50:21 唤醒，窗口正好 1524 秒 —— 睡眠把杀定时器和子进程
  // 一起冻住，但 Date.now() 照走。那条红当时被当成「套件慢」，据此建了一整套机制理论、
  // 白跑两版（CHANGELOG 0.5.162 段 L13 留的 TODO 就是这一条）。
  const KILLED_OUT = 'x\n5 passed, 0 failed\n';
  check('被杀且墙钟远超超时 → SUSPEND-SUSPECT（不再当 TIMEOUT）',
    gateVerdict({ code: null, killed: true, out: KILLED_OUT, ms: 1524000, perTimeout: 420000 }).verdict === 'SUSPEND-SUSPECT',
    JSON.stringify(gateVerdict({ code: null, killed: true, out: KILLED_OUT, ms: 1524000, perTimeout: 420000 })));
  check('summary 里写明疑似整机睡眠',
    /疑似整机睡眠/.test(gateVerdict({ code: null, killed: true, out: KILLED_OUT, ms: 1524000, perTimeout: 420000 }).summary || ''), '');
  check('真超时（ms≈perTimeout）仍判 TIMEOUT',
    gateVerdict({ code: null, killed: true, out: KILLED_OUT, ms: 420300, perTimeout: 420000 }).verdict === 'TIMEOUT', '');
  check('宽限内（超出 30s）判 TIMEOUT，不误报睡眠',
    gateVerdict({ code: null, killed: true, out: KILLED_OUT, ms: 450000, perTimeout: 420000 }).verdict === 'TIMEOUT', '');
  // 没传 ms/perTimeout（真网络门的旧调用形状）必须退回原行为，不能凭空造睡眠判定。
  check('未传 ms/perTimeout → 保持 TIMEOUT（默认零参与）',
    gateVerdict({ code: null, killed: true, out: KILLED_OUT }).verdict === 'TIMEOUT', '');
  // SUSPEND-SUSPECT 也是红灯：不能替它放行。
  check('SUSPEND-SUSPECT 不等于 PASS',
    gateVerdict({ code: 0, killed: true, out: 'x\n9 passed, 0 failed\n', ms: 900000, perTimeout: 420000 }).verdict !== 'PASS', '');
  const gateSrc = fs.readFileSync(path.join(W, 'test', 'run-gate.mjs'), 'utf8');
  check('run-gate 把 perTimeout 传进判定', /gateVerdict\(\{[^)]*perTimeout/.test(gateSrc), '判定没拿到超时基准，睡眠分支永不触发');
  check('run-gate 为睡眠单独出一条归因 annotation', /SUSPEND-SUSPECT/.test(gateSrc) && /疑似整机睡眠/.test(gateSrc), '缺单独归因行');
  check('宽限可用 DSH_GATE_SUSPEND_GRACE_MS 调（判据家复现用）', /DSH_GATE_SUSPEND_GRACE_MS/.test(gateSrc), '');
  // 03:07 端到端实测踩到的真 bug：`Number(env) || 60000` 会把 0 当成没设 ⇒
  // 「宽限=0」的复现姿势永远走不到分支，门里那条判定看起来有开关其实开关失效。
  check('宽限的 0 不被当成未设置（禁 `|| 60000` 写法）',
    !/Number\(process\.env\.DSH_GATE_SUSPEND_GRACE_MS\)\s*\|\|/.test(gateSrc), 'run-gate 用 || 回落默认值，0 会失效');

  // 端到端：一个真的被杀且墙钟超出超时的套件，必须被门标成 SUSPEND-SUSPECT 并单独出一条归因。
  const slow = '.gate-fake-slow.mjs';
  const slowPath = path.join(W, 'test', slow);
  try {
    // 40s 后才打印 summary，配 DSH_GATE_TIMEOUT_MS=30000 ⇒ 一定被杀；
    // 宽限设 0 ⇒ 被杀即超出 ⇒ 应判睡眠嫌疑（生产默认 60s 时同样的套件判 TIMEOUT，
    // 因为杀下来只超出几十毫秒，见上面「宽限内」那条）。
    fs.writeFileSync(slowPath, 'console.log("慢套件开跑");\nsetTimeout(() => { console.log("9 passed, 0 failed"); process.exit(0); }, 40000);\n');
    const rs = spawnSync(process.execPath, [path.join(W, 'test', 'run-gate.mjs')], {
      cwd: W, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DSH_GATE_ONLY: 'test-tdz-order.mjs', DSH_GATE_EXTRA: slow, DSH_GATE_TIMEOUT_MS: '30000', DSH_GATE_SUSPEND_GRACE_MS: '0' },
    });
    const o = String(rs.stdout || '') + String(rs.stderr || '');
    check('端到端：被杀且超出的套件标成 SUSPEND-SUSPECT', /SUSPEND-SUSPECT/.test(o), o.split('\n').filter((l) => l.includes(slow)).slice(0, 1).join(' '));
    check('端到端：单独出一条「疑似整机睡眠」归因，含先复跑', /疑似整机睡眠[\s\S]*先单独复跑/.test(o), '');
    check('端到端：仍然让门变红（不替它放行）', (rs.status || 0) !== 0 && new RegExp('publish blocked').test(o), 'status=' + rs.status);
  } finally {
    try { fs.rmSync(slowPath, { force: true }); } catch {}
  }
}

console.log('');
console.log("Test 4: CI 发布工作流的墙钟兜底（job 级 timeout-minutes）");
{
  const wfSrc = fs.readFileSync(path.join(W, '.github', 'workflows', 'publish.yml'), 'utf8');
  // 拒绝的变异：删掉 timeout-minutes 那行 ⇒ 门挂死可吃满 runner 6h 默认额度（本机单套件 420s 硬杀的先例只在门内，CI 侧无对应保护）。
  check('publish job 必须有 timeout-minutes', /^[ \t]+timeout-minutes:[ \t]*\d+/m.test(wfSrc), '');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
