#!/usr/bin/env node
// test-mcp-tools-popup.mjs — TDD: 管理面板点已装 MCP 卡片 → 浮窗显示工具清单与详情。
//
// 需求：点击「管理 → MCP 连接器」子面板里已装列表的卡片本体时，弹出浮窗列出该连接器
// 注册的全部工具（名称 + 描述 + 参数 schema），而不是只有卡片上那句「N 个工具」。
//
// 数据面事实：mcp.list/detail 的 tools 只有名字（toolNamesFor 取 definition.name，
// src/mcp.js:163-173）。描述与参数在宿主 definition 上真实存在（ToolSchema：
// name/description/parameters，dsh-llm types.ts；dsh-mcp-client/tools.ts 把上游
// inputSchema 原样放进 parameters），所以不需要新增上游请求，只需把 definition
// 的完整字段透出——这是纯读操作，不进 DESTRUCTIVE_OPS。
import fs from 'node:fs';
import path from 'node:path';
import { blockEnd } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const mcp = read('src/mcp.js');
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
const tdfSeg = scopeOf(mcp, 'function toolDetailsFor(', 'toolDetailsFor');
const detailSeg = scopeOf(mcp, 'async function detail(', 'detail');
const openToolsSeg = scopeOf(c, 'const openMcpTools = async', 'openMcpTools');
const rgSrc = read('src/rpc-guard.js');
const setSeg = rgSrc.slice(rgSrc.indexOf('export const DESTRUCTIVE_OPS = new Set(['), rgSrc.indexOf(']);'));
const CL = norm(c).split(NL);
// 卡片作用域 = installedMcps map 行 → 「搜索栏提到 body 之外」注释行（行锚切片，替代定宽字符窗）
const cardSeg = lineRange(CL, 'const installedMcps', '搜索栏提到 body 之外');
// 浮窗作用域 = 唯一锚「搜索工具名或描述」回溯到遮罩起点 ? h('div', {，读到遮罩末段「保存禁用列表」
const overlaySeg = (() => {
  const s = CL.findIndex((l) => l.includes('搜索工具名或描述'));
  if (s < 0) return '';
  let a = s;
  while (a > 0 && !CL[a].trim().startsWith("? h('div', {")) a--;
  if (a <= 0) return '';
  const e = CL.findIndex((l, i) => i > a && l.includes('保存禁用列表'));
  return e > a ? CL.slice(a, e + 1).join(NL) : '';
})();

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

console.log('');
console.log('Test 1: 服务端透出工具详情（名称+描述+参数 schema）');
{
  check('toolDetailsFor 存在', /function toolDetailsFor\(/.test(mcp));
  // 变异拒绝：toolDetailsFor 被删/改名 ⇒ tdfSeg 空串 ⇒ 红。
  check('toolDetailsFor 存在', tdfSeg !== '');
  // 变异拒绝：映射体不再读 definition.description（描述丢失）⇒ 红（旧 420 字符窗废弃）。
  check('读 definition.description', tdfSeg.includes('definition.description'));
  // 变异拒绝：映射体不再读 definition.parameters（schema 丢失）⇒ 红。
  check('读 definition.parameters', tdfSeg.includes('definition.parameters'));
  // 变异拒绝：前缀串改掉（与 toolNamesFor 规则脱钩）⇒ 红。
  check('按 mcp__<name>__ 前缀过滤（与 toolNamesFor 同规则）', tdfSeg.includes('mcp__${serverName}__'));
  // 变异拒绝：detail 返回体删掉 toolDetails 字段 ⇒ 红（旧 1400 字符窗废弃）。
  check('detail 返回 toolDetails', detailSeg.includes('toolDetails: toolDetailsFor'));
}

console.log('');
console.log('Test 2: 卡片本体可点击打开浮窗');
{
  const s = c.indexOf('const installedMcps');
  const seg = cardSeg;
  // 变异拒绝：卡片删掉 onClick 打开浮窗的接线 ⇒ 红（旧 900 字符定宽窗废弃）。
  check('卡片 div 带 onClick', seg.includes('key: `m-${item.serverName}`') && seg.indexOf('onClick: () => openMcpTools(item.serverName)') > seg.indexOf('key: `m-${item.serverName}`'));
  // 变异拒绝：cursor 或 title 任一被删 ⇒ 红（旧析取任一命中即过，已收紧为两者都在）。
  check('卡片有可点击提示（cursor/标题）', seg.includes("cursor: 'pointer'") && seg.includes("title: '查看工具清单'"));
  // 变异拒绝：按钮行 stopPropagation 被删 ⇒ 红（点按钮会误开浮窗）。
  check('操作按钮行 stopPropagation（点按钮不误开浮窗）', seg.includes('e.stopPropagation()'));
}

console.log('');
console.log('Test 3: 浮窗组件与状态');
{
  check('mcpTools state 存在', /const \[mcpTools, setMcpTools\] = useState\(null\)/.test(c));
  // 变异拒绝：openMcpTools 函数体不再调 mcp.detail ⇒ 红（旧 400 字符窗废弃）。
  check('openMcpTools 走 mcp.detail', openToolsSeg.includes("call('mcp.detail'"));
  // 变异拒绝：openMcpTools 声明被挪到 installedMcps 之后（引用前使用）⇒ 红（TDZ 顺序锁，非窗口）。
  check('openMcpTools 声明在卡片渲染之前（TDZ）',
    c.indexOf('const openMcpTools = async') >= 0 &&
    c.indexOf('const openMcpTools = async') < c.indexOf('const installedMcps'));
  // 变异拒绝：mcpTools state 声明挪到 installedMcps 之后 ⇒ 红。
  check('mcpTools state 声明在使用之前（TDZ）',
    c.indexOf('const [mcpTools,') < c.indexOf('const installedMcps'));
}

console.log('');
console.log('Test 4: 浮窗渲染工具清单与详情');
{
  // 浮窗渲染段：从 map 调用回溯到遮罩开头（state 声明处也有同名注释，故不能用 indexOf(注释)）
  const seg = overlaySeg;
  // 变异拒绝：遮罩不再 position: 'fixed'（或行锚失效→空串）⇒ 红。
  check('浮窗存在（fixed 遮罩）', seg !== '' && seg.includes("position: 'fixed'"));
  // 变异拒绝：渲染体删掉 tool.name ⇒ 红。
  check('渲染工具名', seg.includes('tool.name'));
  // 变异拒绝：渲染体删掉 tool.description ⇒ 红。
  check('渲染工具描述', seg.includes('tool.description'));
  // 变异拒绝：展开文案「展开参数」被改 ⇒ 红（旧三选一析取收紧为实锚）。
  check('参数 schema 可展开', seg.includes('展开参数'));
  // 变异拒绝：渲染体删掉 tool.parameters ⇒ 红。
  check('渲染 parameters', seg.includes('tool.parameters'));
  // 变异拒绝：关闭入口 setMcpTools(null) 被换掉 ⇒ 红。
  check('有关闭入口', seg.includes('setMcpTools(null)'));
  // 变异拒绝：未挂载/无工具两个诚实分支任一被删 ⇒ 红（旧二选一收紧为两者都在）。
  check('未挂载时诚实提示（不假装空清单=没有工具）', seg.includes('未挂载') && seg.includes('还没发布工具'));
  // 旧服务端不返回 toolDetails：必须说「需重启」，不能说「还没发布工具」（那是假陈述）
  // 变异拒绝：hasDetails 标记或重启提示任一被删 ⇒ 红。
  check('旧服务端降级为重启提示（非假陈述）', seg.includes('hasDetails') && seg.includes('重启应用与 Host'));
}

console.log('');
console.log('Test 5: 既有行为不被破坏');
{
  check('mcp.list 的 tools 仍是名字数组（卡片计数没变）', /tools: toolNamesFor\(def\.serverName\)/.test(mcp));
  check('编辑抽屉入口仍在', /'编辑'/.test(c) && /openMcpDetail\(item\.serverName\)/.test(c));
  check('测试连接按钮仍在', /'测试连接'/.test(c));
  check('toolDetailsFor 不进 DESTRUCTIVE_OPS（只读）', !/DESTRUCTIVE_OPS[\s\S]{0,400}detail/.test(read('src/rpc-guard.js')));
  // 变异拒绝：detail 被加进 DESTRUCTIVE_OPS 集合 ⇒ 红（旧 400 字符窗废弃，改为集合体切片）。
  check('toolDetailsFor 不进 DESTRUCTIVE_OPS（只读）', setSeg !== '' && !setSeg.includes('detail'));
}

console.log('');
console.log('Test 6: 语法');
{
  const { execSync } = await import('node:child_process');
  for (const f of ['client.js', 'src/mcp.js']) {
    let ok = true;
    try { execSync('node --check ' + JSON.stringify(path.join(W, f)), { stdio: 'pipe' }); } catch { ok = false; }
    check(f + ' 语法通过', ok);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
