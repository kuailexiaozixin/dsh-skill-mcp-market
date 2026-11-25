#!/usr/bin/env node
// test-mcp-panel-p0.mjs — TDD: 已装 MCP 行必须有「编辑」与「测试连接」入口；probe 走新 op。
//
// 背景（本轮实测）：编辑抽屉已存在（detail drawer，含命令/URL/参数）但只能从**搜索 tab 市场抽屉**打开，
// 已装连接器（管理 tab 的卡片）没有任何入口；「测试连接」只嵌在安装流程里，装完想再验一次没有按钮。
// 参照 Fishquito7/dsh-skill-mcp-panel：probe 语义是「独立实例测试，pending 不是失败」（0.5.103 起我们同语义）。
import fs from 'node:fs';
import path from 'node:path';
import { blockEnd } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');
const ix = read('index.js');

// ---- 语义作用域切片：先切作用域再断言（替代旧 {0,N} 字符窗，插入无关代码不再假红）----
const NL = String.fromCharCode(10);
const norm = (s) => s.replace(/\r\n/g, NL);
const scopeOf = (src, startNeedle, label) => {
  const ls = norm(src).split(NL);
  const a = ls.findIndex((l) => l.includes(startNeedle));
  if (a < 0) return '';
  let b;
  try { b = blockEnd(norm(src), a, label); } catch { return ''; }
  return ls.slice(a, b + 1).join(NL);
};
const lineRange = (lines, startNeedle, endNeedle) => {
  const s = lines.findIndex((l) => l.includes(startNeedle));
  if (s < 0) return '';
  const e = lines.findIndex((l, i) => i > s && l.includes(endNeedle));
  return e > s ? lines.slice(s, e + 1).join(NL) : '';
};
const probeCase = scopeOf(ix, 'case "mcp.probe"', 'caseProbe');
const CL = norm(c).split(NL);
// 卡片作用域 = installedMcps map 行 → 「搜索栏提到 body 之外」注释行（行锚切片，替代 +3200/+4200 定宽窗）
const cardSeg = lineRange(CL, 'const installedMcps', '搜索栏提到 body 之外');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 已装 MCP 卡片带「编辑」与「测试连接」按钮');
{
  const s = c.indexOf('const installedMcps');
  const seg = cardSeg;
  check('installedMcps 存在', seg !== '');
  // 变异拒绝：卡片删掉「编辑」按钮 ⇒ 红（旧 +3200 定宽窗废弃）。
  check('编辑按钮', seg.includes("'编辑'"));
  // 变异拒绝：卡片删掉「测试连接」按钮 ⇒ 红。
  check('测试连接按钮', seg.includes("'测试连接'"));
  // 变异拒绝：编辑按钮不再调 openMcpDetail(item.serverName) ⇒ 红。
  check('编辑打开 openMcpDetail（同一抽屉复用，不另造表单）', seg.includes('openMcpDetail(item.serverName)'));
  // 变异拒绝：测试连接改走安装通道 ⇒ 红。
  check('测试走新 probe op 而非安装通道', seg.includes("call('mcp.probe'"));
}

console.log('');
console.log('Test 2: 服务端新增 mcp.probe op（封装已有内部方法）');
{
  check('index.js 有 case "mcp.probe"', ix.includes('case "mcp.probe"'));
  check('调用 mcp.probe 内部方法', /case "mcp\.probe"[\s\S]{0,300}\.probe\(/.test(ix));
  // 变异拒绝：probe case 体不再转调内部 mcp.probe ⇒ 红（旧 300 字符窗废弃）。
  check('调用 mcp.probe 内部方法', probeCase.includes('mcp.probe(body.serverName'));
}

console.log('');
console.log('Test 3: op 登记单源化（三处副本正是漂移假红的根源）');
// 旧锁逐处检查「每个套件的硬编码白名单里有 mcp.probe」—— 那是给 3 份副本打补丁，
// 而副本本身就是 skillhub.evaluation 上线时同时假红三条的原因（登记只需一处）。
// known 现在一律从 index.js 的 case 标签派生，所以锁升级为更强的性质：
// 登记只此一处，且任何套件都不许再写回硬编码 op 清单副本。
{
  check('index.js 仍是唯一登记处（case "mcp.probe"）', read('index.js').includes('case "mcp.probe"'));
  for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs', 'test-skill-subpanel-ui.mjs']) {
    const t = read('test/' + f);
    check(f + ' 从 index.js 派生 op 清单（声明形态 + known 指向，不接受仅提及）', t.includes('const IX_OPS = new Set(') && t.includes('const known = IX_OPS;') && t.includes('index.js'), '');
    check(f + ' 无硬编码白名单副本（副本会漂移）', !t.includes("new Set(['skills.list"), '');
  }
}

console.log('');
console.log('Test 4: probe 按钮防重复 + 结果文案区分 pending/失败');
{
  const s = c.indexOf('const installedMcps');
  const seg = cardSeg;
  // 变异拒绝：disabled 不再绑定 busy === `probe:` ⇒ 红（旧 +4200 定宽窗废弃）。
  check('按钮 disabled 绑定 busy:probe', seg.includes('busy === `probe:'));
  // 变异拒绝：pending 文案被改 ⇒ 红（旧二选一收紧为实锚「还在启动」）。
  check('pending 文案（服务器还在启动）', seg.includes('还在启动'));
  // 变异拒绝：失败态不再显示「未连上」或丢掉 r.error 原因 ⇒ 红（旧二选一收紧为两者都在）。
  check('失败文案', seg.includes('未连上') && seg.includes('r.error'));
}

console.log('');
console.log('Test 5: 编辑入口行为正确（打开抽屉不重新安装）');
{
  const seg = cardSeg;
  check('编辑 onClick 调 openMcpDetail(item.serverName)', seg.includes('openMcpDetail(item.serverName)'));
  // 变异拒绝：卡片区域出现 mcp.install ⇒ 红（编辑绝不重装）；行锚失效→空串也红，不再 vacuous 通过。
  check('编辑不调用 mcp.install', seg !== '' && !seg.includes('mcp.install'));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
