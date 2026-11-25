#!/usr/bin/env node
// test-mcp-status-p1.mjs — TDD: 已装 MCP 的连接状态必须是生命周期，而不是布尔。
//
// 现状：mcp.list 只给 mounted（布尔）+ tools 数。用户看到的是「已连接/未连接」，
// 但真实形态至少有 5 种：未挂载、启动中、已就绪、失败、已停用。把「启动中」显示成
// 「未连接」会让用户以为坏了（0.5.103 的假阴性就是同一类误读）；把「失败」显示成
// 「未连接」则丢掉了原因。
//
// 实现约束（重要）：宿主 loader 在 app.asar 内不可静态审计，因此状态探测必须
// 多路宽松匹配 + 诚实回退：匹配不到就回落到 mounted 布尔，绝不猜一个假 phase。
import fs from 'node:fs';
import path from 'node:path';
import { blockEnd } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mcp = read('src/mcp.js');
const ix = read('index.js');
const c = read('client.js');

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
const MCPL = norm(mcp).split(NL);
// reconnect 作用域 = DEFAULT_RECONNECT 声明整行 + toClientConfig 的 spread 整行（行锚，不用字符窗）
const reconnectConst = MCPL.find((l) => l.includes('export const DEFAULT_RECONNECT')) || '';
const reconnectSpread = MCPL.find((l) => l.includes('reconnect: { ...DEFAULT_RECONNECT')) || '';
const fiberFn = scopeOf(mcp, 'function fiberPhaseOf(', 'fiberPhaseOf');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 重连参数从硬编码变为可配置（默认值与参照实现一致）');
{
  // 实现是 spread 合并（{ ...DEFAULT_RECONNECT, ...def.reconnect }），不含 enabled: 字面量，
  // 因此断言 spread 形态 + def.reconnect 读取，而非旧的内联对象。
  check('reconnect 读 def.reconnect', /reconnect:\s*\{\s*\.\.\.DEFAULT_RECONNECT[^\n]*def\.reconnect/.test(mcp));
  // 变异拒绝：spread 行不再读 def.reconnect（用户覆盖断链）⇒ 红（旧 [^\n] 宽松窗升级为整行锚）。
  check('reconnect 读 def.reconnect', reconnectSpread.includes('...(def.reconnect'));
  // 变异拒绝：DEFAULT_RECONNECT 声明行删掉/改值任一默认 ⇒ 红（作用域=该声明整行）。
  check('默认 initialDelayMs 500', reconnectConst.includes('initialDelayMs: 500'));
  check('默认 maxDelayMs 30000', reconnectConst.includes('maxDelayMs: 30000'));
  check('默认 maxAttempts 10', reconnectConst.includes('maxAttempts: 10'));
  // 覆盖方向：DEFAULT 在前、def.reconnect 在后 → 用户键胜出（运行时实测已证 maxAttempts:3 覆盖 10）
  // 变异拒绝：spread 顺序反转 ⇒ 红（默认值会盖掉用户值）。
  check('用户值覆盖默认值（spread 顺序正确）', reconnectSpread.includes('...DEFAULT_RECONNECT, ...(def.reconnect'));
}

console.log('');
console.log('Test 2: 新增 status 探测（多路匹配 + 诚实回退）');
{
  check('src/mcp.js 导出 status', /return \{[^}]*status[^}]*\}/.test(mcp) || /status,/.test(mcp.split('return { init, dispose').pop() || ''));
  check('内部有 status 函数', /async function status\(|function status\(/.test(mcp));
  check('读 fiber.status（自己的对象，不依赖宿主内部）', /entry\.fiber\?\.status|fiber\.status/.test(mcp));
  // 变异拒绝：fiberPhaseOf 不再直接读 fiber.state（主路断）⇒ 红（旧全文件窗 + 0 命中死侧 entry.fiber?.status 已删）。
  check('读 fiber.status（自己的对象，不依赖宿主内部）', fiberFn.includes('normalizePhase(fiber && fiber.state)'));
  // 变异拒绝：loader 补充路被删（ctx.loader 或 e.fiber 兜底丢失）⇒ 红（旧 240 字符窗废弃）。
  check('探测 loader 作为补充路', fiberFn.includes('ctx.loader?.entries') && fiberFn.includes('e.fiber ? e.fiber.state : undefined'));
  // 变异拒绝：诚实回退 return { phase: "unknown", detail } 被删（匹配不到就猜 phase）⇒ 红。
  check('匹配不到时回退布尔语义', fiberFn.includes('return { phase: "unknown", detail }'));
}

console.log('');
console.log('Test 3: 面板显示生命周期而非布尔');
{
  const s = c.indexOf('const installedMcps');
  const seg = c.slice(s, s + 3600);
  check('不再只有 已连接/未连接 两态', /启动中|loading|pending/.test(seg));
  check('状态文案来自 phase 映射表', /PHASE_LABEL|phaseLabel|phaseOf/.test(seg));
  check('失败态显示原因', /error|原因/.test(seg));
}

console.log('');
console.log('Test 4: op 登记单源化（status 无需多处同步）');
for (const f of ['test-manage-panel.mjs', 'test-install-progress.mjs', 'test-skill-subpanel-ui.mjs']) {
  const t = read('test/' + f);
  check(f + ' 从 index.js 派生（含 status）', t.includes('const IX_OPS = new Set(') && t.includes('const known = IX_OPS;') && read('index.js').includes('case ' + String.fromCharCode(34) + 'mcp.status' + String.fromCharCode(34)), '');
  check(f + ' 无硬编码白名单副本', !t.includes("new Set(['skills.list"), '');
}

console.log('');
console.log('Test 5: status 是只读 op（不得进 DESTRUCTIVE_OPS）');
{
  const rg = read('src/rpc-guard.js');
  check('mcp.status 不在 DESTRUCTIVE_OPS', !/DESTRUCTIVE_OPS[\s\S]{0,400}"mcp\.status"/.test(rg));
  const setSeg = rg.slice(rg.indexOf('export const DESTRUCTIVE_OPS = new Set(['), rg.indexOf(']);'));
  // 变异拒绝：mcp.status 被加进 DESTRUCTIVE_OPS 集合 ⇒ 红（旧 400 字符窗废弃，改为集合体切片）。
  check('mcp.status 不在 DESTRUCTIVE_OPS', setSeg !== '' && !setSeg.includes('mcp.status'));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'index.js', 'src/mcp.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
