#!/usr/bin/env node
// test-install-progress.mjs — TDD: MCP 安装实时进度，消除 npx 冷启动假阴性。
//
// 实测事实（2026-11-19，playwright-mcp 案例）：
//   installedAt 08:29:55 → npx 缓存写入 08:31:29（冷启动下载 ~94s）
//   旧探针预算 8000ms → 必然在包下载完之前就宣布「未连上」，且英文文案把用户
//   推向「检查命令/网络/日志」的错误方向。连接器随后自行挂载 25 个工具（假阴性）。
//   RPC 分发实测真并发：慢查询进行到 1.5s 时 settings.get 仅 4ms 返回
//   → 客户端轮询 mcp.list 能拿到实时进度，无需服务端长阻塞。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { execSync } from 'node:child_process';
import { countHits } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const rd = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = rd('client.js');
const idx = rd('index.js');
const m = rd('src/mcp.js');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d.slice(0, 90) + ']' : '')); } };

console.log('');
console.log('Test 1: 服务端探针不再把「还没发布工具」当终局失败');
{
  check('probe 返回 pending 语义', /pending:\s*true/.test(m) || /pending: !mounted\.has/.test(m));
  check('面板 mcp.install 不再硬阻塞 8s', !/mcp\.probe\(definition\.serverName, 8000\)/.test(idx));
  check('CLI 通道仍可显式指定 probeTimeoutMs', /args\.probeTimeoutMs/.test(idx));
}

console.log('');
console.log('Test 2: 失败文案中文化 + 冷启动提示（不再甩锅网络/日志）');
{
  check('旧英文甩锅文案已移除', !m.includes('check the server command, network, and DSH logs'));
  check('提示可能是首次下载依赖', /下载|首次运行/.test(m));
}

console.log('');
console.log('Test 3: 客户端实时进度（轮询 mcp.list，非猜测）');
{
  check('进度 state', /const \[installProgress, setInstallProgress\] = useState\(/.test(c));
  // 语义锁：先切出 waitForTools 的作用域（两个唯一锚夹出的区间），再在切片内做无字符窗断言。
  // 旧判据是 setInterval( …{0,700}… call('mcp.list'))：生产码在轮询体里插一段注释就会把
  // 窗口撑爆而假红（test-mcp-full-edit 的 346 字符注释事故同因）；作用域切片没有字符窗。
  const sliceOf = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j > i ? s.slice(i, j) : ''; };
  const WF_ANCHOR = 'const waitForTools = (serverName) => new Promise((resolve) => {';
  const WF_END = 'const doInstallMcp = async (item, envValues) => {';
  const wfAt = c.indexOf(WF_ANCHOR);
  const wfScope = sliceOf(c, WF_ANCHOR, WF_END);
  check('waitForTools 作用域可切片（语义锁前置）', countHits(c, WF_ANCHOR) === 1 && countHits(c, WF_END) === 1 && wfScope.length > 200, 'len=' + wfScope.length);
  const polling = (wfScope.match(/call\('mcp\.list',\s*\{\}\)/g) || []).length;
  check('轮询 mcp.list 取实时工具数', countHits(wfScope, 'setInterval(') === 1 && polling === 1 && wfScope.indexOf('setInterval(') < wfScope.indexOf("call('mcp.list'"), 'setInterval=' + countHits(wfScope, 'setInterval(') + ' mcp.list=' + polling);
  {
    const pm = c.match(/const POLL_INTERVAL_MS = (\d+)/);
    check('轮询间隔常量 ≤ 1000ms', !!pm && Number(pm[1]) > 0 && Number(pm[1]) <= 1000, pm ? pm[1] + 'ms' : 'POLL_INTERVAL_MS 未定义');
    const pollName = pm ? pm[0].slice('const '.length).replace(/ =.*/, '') : '';
    const pollClose = pollName ? ', ' + pollName + ')' : '';
    check('setInterval 用该常量', pollName !== '' && countHits(wfScope, 'setInterval(') === 1 && countHits(wfScope, pollClose) === 1 && wfScope.indexOf('setInterval(') < wfScope.indexOf(pollClose), 'name=' + pollName + ' close=' + countHits(wfScope, pollClose));
  }
  check('有最长预算（不无限轮询）', countHits(wfScope, 'MAX_PROGRESS_MS') === 1 && /120_?000|120000|MAX_PROGRESS/.test(c), 'MAX=' + countHits(wfScope, 'MAX_PROGRESS_MS'));
  check('定时器一定被清理 clearInterval', countHits(wfScope, 'clearInterval(') >= 1, 'clear=' + countHits(wfScope, 'clearInterval('));
  check('进度文案含已等待秒数', /已等待/.test(c));
  // 语义锁：切出 doInstallMcp 的 pending 分支（在安装体里再切一层），冷启动提示必须落在这个分支内。
  const IB_END = 'const toggleGroupCollapsed = (key) => {';
  const installBody = sliceOf(c, WF_END, IB_END);
  const pdAt = installBody.indexOf('} else if (r.pending) {');
  const pdEnd = installBody.indexOf('} else {', pdAt);
  const pendingBranch = pdAt >= 0 && pdEnd > pdAt ? installBody.slice(pdAt, pdEnd) : '';
  check('doInstallMcp pending 分支可切片（语义锁前置）', countHits(c, IB_END) === 1 && countHits(installBody, '} else if (r.pending) {') === 1 && countHits(installBody, '} else {') === 1 && pendingBranch.length > 100, 'body=' + installBody.length + ' pending=' + pendingBranch.length);
  check('npx 冷启动提示', /下载/.test(pendingBranch) && (/npx/.test(pendingBranch) || /首次运行/.test(pendingBranch)) && countHits(pendingBranch, 'await waitForTools(r.serverName);') === 1, 'npx=' + countHits(pendingBranch, 'npx') + ' 首次运行=' + countHits(pendingBranch, '首次运行'));
}

console.log('');
console.log('Test 4: 终局判定由轮询结果给出，不再照抄服务端 pending 前的 ok=false');
{
  check('安装路径读取 pending 分支', /r\.pending/.test(c));
  check('超时后诚实建议刷新', /刷新|稍后/.test(c));
}

console.log('');
console.log('Test 5: 零新增 op + 语法');
{
  const ops = [...c.matchAll(/call\('([\w.]+)'/g)].map((x) => x[1]);
  // op 清单唯一事实源 = index.js 的 case 标签。此前三个套件各抄一份白名单，加一个 op
  // 就得同步三处，漏一处即假红（skillhub.evaluation 正是这样同时撞红三条）。
  // 提取一旦失效会变成「所有 op 都未知」这种全面假红，所以规模与核心 op 都要断言。
  const IX_SRC = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const IX_OPS = new Set([...IX_SRC.matchAll(/case "([\w.]+)":/g)].map((m) => m[1]));
  if (IX_OPS.size < 30 || !IX_OPS.has('skills.search')) throw new Error('index.js op 清单提取失效: ' + IX_OPS.size);
  const known = IX_OPS;
  const unknown = [...new Set(ops)].filter((o) => !known.has(o));
  check('未引入未知 op（进度复用 mcp.list）', unknown.length === 0, unknown.join(','));
  let ok = true;
  for (const f of ['client.js', 'index.js', 'src/mcp.js']) { try { execSync('node --check ' + JSON.stringify(f), { cwd: W, timeout: 20000, stdio: 'pipe' }); } catch { ok = false; console.log('  syntax broken: ' + f); } }
  check('三个文件语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);