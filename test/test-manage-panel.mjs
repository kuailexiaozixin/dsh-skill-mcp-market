#!/usr/bin/env node
// test-manage-panel.mjs — TDD: 「已安装」更名「管理」并拆 SKILL/MCP 双子页签。
//
// 设计事实（参照 Fishquito7/dsh-skill-mcp-panel src/client.ts:5680-5909）：
//   子页签状态持久化 localStorage 键 dsh-market:manage-tab，读失败静默退化为技能页；
//   容器带 data-manage-tab、页签行 role=tablist、按钮 aria-selected（兼作本测试锚点）；
//   过滤词按子页签拆开（旧 installedFilter 一个词同时过滤技能与 MCP，互相污染）；
//   回收站与上传区只属于技能侧（Q2 已拍板：SKILL 子页签底部）。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { execSync } from 'node:child_process';
import { countHits } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');

let passed = 0, failed = 0;
const check = (n, cond, d = '') => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + d.slice(0, 80) + ']' : '')); } };

console.log('');
console.log('Test 1: 主 tab 更名「管理」且选中态修复');
{
  check("tab 按钮文案为 '管理'", /setTab\('manage'\)\s*\},\s*'管理'/.test(c));
  check("旧 '已安装' tab 按钮消失", !/setTab\('installed'\)/.test(c));
  check('选中态接线 S.tab(tab === \'manage\')', c.includes("S.tab(tab === 'manage')"));
  check('内部值统一为 manage（无 installed tab 残留）', !/tab === 'installed'/.test(c));
}

console.log('');
console.log('Test 2: 双子页签状态机 + 持久化（参照模式）');
{
  check('manageTab state 存在', /const \[manageTab, setManageTab\] = useState\(/.test(c));
  check('localStorage 键 dsh-market:manage-tab', c.includes("dsh-market:manage-tab"));
  // 语义锁：切出 readManageTab / switchManageTab 两个函数体（三个唯一锚夹出的两段区间），
  // try/catch 必须包在各自函数体里。旧判据的 [^\r\n]*…{0,120} 窗只看「后面不远处有个 catch」。
  const sliceOf = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j > i ? s.slice(i, j) : ''; };
  const READ_ANCHOR = 'const readManageTab = () => {';
  const WRITE_ANCHOR = 'const switchManageTab = (next) => {';
  const QUERY_ANCHOR = "const [query, setQuery] = useState('');";
  const readTab = sliceOf(c, READ_ANCHOR, WRITE_ANCHOR);
  const writeTab = sliceOf(c, WRITE_ANCHOR, QUERY_ANCHOR);
  check('readManageTab/switchManageTab 可切片（语义锁前置）', countHits(c, READ_ANCHOR) === 1 && countHits(c, WRITE_ANCHOR) === 1 && countHits(c, QUERY_ANCHOR) === 1 && readTab.length > 40 && writeTab.length > 40, readTab.length + '/' + writeTab.length);
  check('localStorage 读写包 try/catch',
      countHits(readTab, 'localStorage.getItem(MANAGE_TAB_KEY)') === 1 && readTab.includes('try { return localStorage.getItem(MANAGE_TAB_KEY)') && readTab.indexOf("} catch { return 'skill'; }") > readTab.indexOf('try { return') &&
      countHits(writeTab, 'localStorage.setItem(MANAGE_TAB_KEY, next);') === 1 && writeTab.includes('try { localStorage.setItem(MANAGE_TAB_KEY, next); } catch {'),
      'read=' + readTab.length + ' write=' + writeTab.length);
  check('容器 data-manage-tab 锚点', c.includes("'data-manage-tab'"));
  check('页签行 role=tablist', c.includes("role: 'tablist'"));
  check('页签按钮 aria-selected', c.includes('aria-selected'));
}

console.log('');
console.log('Test 3: 过滤词拆分（旧缺陷：一个词过滤两侧）');
{
  check('installedFilter 全部移除', !/installedFilter/.test(c), (c.match(/installedFilter/g) || []).length + ' refs left');
  check('manageSkillFilter 使用 ≥2 处', (c.match(/manageSkillFilter/g) || []).length >= 2);
  check('manageMcpFilter 使用 ≥2 处', (c.match(/manageMcpFilter/g) || []).length >= 2);
}

console.log('');
console.log('Test 4: 结构归属——回收站/上传区在技能子页签，MCP 子页签纯净');
{
  const skillBranch = c.indexOf("manageTab === 'skill' ? h('div'");
  const mcpBranch = c.indexOf("manageTab === 'mcp' ? h('div'");
  check('两个子页签分支都存在', skillBranch >= 0 && mcpBranch >= 0);
  if (skillBranch >= 0 && mcpBranch >= 0) {
    const seg = (a, b) => c.slice(a, b < 0 ? c.length : b);
    // 技能段 = manageTab==='skill' 条件起点到下一个兄弟条件；MCP 段同理到块尾
    const skillSeg = c.slice(skillBranch);
    const cut = skillSeg.indexOf("manageTab === 'mcp' ? h('div'");
    const skillOnly = skillSeg.slice(0, cut > 0 ? cut : 4000);
    const mcpOnly = skillSeg.slice(cut > 0 ? cut : 4000);
    check('回收站在技能段内', skillOnly.includes('回收站（'), 'skillOnly 未见回收站');
    check('上传区在技能段内', skillOnly.includes('浏览文件夹'));
    // 0.5.104：MCP 子页签现在有自己的「MCP 回收站」。旧断言的意图是「技能回收站不泄漏到 MCP 段」，
    // 因此按具体标记判定：技能回收站用 trashList，MCP 回收站用 mcpTrashList。
    check('MCP 段不含技能回收站', !mcpOnly.slice(0, 4000).includes('回收站（${trashList'));
    check('MCP 段含自己的 MCP 回收站', mcpOnly.includes('MCP 回收站（'));
    check('技能段不含 MCP 回收站', !skillOnly.includes('MCP 回收站（'));
    check('MCP 段不含上传区', !mcpOnly.slice(0, 3000).includes('浏览文件夹'));
    check('已装 MCP 卡片在 MCP 段', mcpOnly.includes('installedMcps') || mcpOnly.includes('filteredMounted'));
  }
}

console.log('');
console.log('Test 5: 无谓市场查询回归锁（进 manage/settings 不再 searchMcps）');
{
  const DEPS_ANCHOR = '}, [tab, loadSettings, loadInstalled';
  const eff = c.indexOf(DEPS_ANCHOR);
  check('tab effect 存在', eff >= 0);
  if (eff >= 0) {
    // 语义锁：向前回溯到包裹这个依赖数组的 useEffect 起点，切出真正的 effect 作用域。
    // 旧的 c.slice(Math.max(0, eff - 900), eff) 是位置窗：effect 上方多写几行注释就会把上一个
    // effect 的尾部卷进来，判据实际在判谁已经不确定。注释行另外滤掉——说明注释里就写着
    // searchMcps（client.js:1422），不滤会把它当成第二个调用点。
    const start = c.lastIndexOf('useEffect(() => {', eff);
    const effectScope = start >= 0 && start < eff ? c.slice(start, eff) : '';
    const codeOnly = effectScope.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    const mcpsHits = (codeOnly.match(/searchMcps/g) || []).length;
    check('tab effect 作用域可切片（语义锁前置）', countHits(c, DEPS_ANCHOR) === 1 && start >= 0 && effectScope.length > 200, 'len=' + effectScope.length);
    check('searchMcps 仅在 tab===mcp 分支', mcpsHits === 1 && !/else\s+searchMcps/.test(codeOnly), 'hits=' + mcpsHits);
    const guardAt = codeOnly.indexOf("tab === 'mcp'");
    check('存在 tab === \'mcp\' 守卫的 searchMcps', guardAt >= 0 && guardAt < codeOnly.indexOf('searchMcps'), codeOnly.slice(0, 120));
  } else {
    check('tab effect 作用域可切片（语义锁前置）', false, 'effect 依赖锚失效');
    check('searchMcps 仅在 tab===mcp 分支', false, 'effect 依赖锚失效');
    check('存在 tab === \'mcp\' 守卫的 searchMcps', false, 'effect 依赖锚失效');
  }
}

console.log('');
console.log('Test 6: 语法与零新增 op');
{
  let ok = true;
  try { execSync('node --check client.js', { cwd: W, timeout: 20000, stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
  const ops = [...c.matchAll(/call\('([\w.]+)'/g)].map((m) => m[1]);
  // 0.5.104 起新增 MCP 回收站三 op（Test 5 的「零新增 op」承诺随之更新为「只增已登记的 op」）
  // op 清单唯一事实源 = index.js 的 case 标签。此前三个套件各抄一份白名单，加一个 op
  // 就得同步三处，漏一处即假红（skillhub.evaluation 正是这样同时撞红三条）。
  // 提取一旦失效会变成「所有 op 都未知」这种全面假红，所以规模与核心 op 都要断言。
  const IX_SRC = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const IX_OPS = new Set([...IX_SRC.matchAll(/case "([\w.]+)":/g)].map((m) => m[1]));
  if (IX_OPS.size < 30 || !IX_OPS.has('skills.search')) throw new Error('index.js op 清单提取失效: ' + IX_OPS.size);
  const known = IX_OPS;
  const unknown = [...new Set(ops)].filter((o) => !known.has(o));
  check('未引入未登记 op', unknown.length === 0, unknown.join(','));
}

console.log('');
console.log('Test 7: 首次进入技能子页签自动拉取回收站（旧行为要手点「读取回收站」）');
{
  // 语义锁：切出回收站 effect 的完整作用域（useEffect 起点 → 依赖数组锚），
  // 条件与调用点都在切片里数，不再靠 {0,80}/{0,140} 字符窗猜「后面应该有」。
  const TRASH_COND = "if (tab === 'manage' && manageTab === 'skill' && trashList === null && !trashBusy) {";
  const TRASH_DEPS = '}, [tab, manageTab, trashList, trashBusy, loadTrash]);';
  const condAt = c.indexOf(TRASH_COND);
  const depsAt = c.indexOf(TRASH_DEPS);
  const trashStart = condAt < 0 ? -1 : c.lastIndexOf('useEffect(() => {', condAt);
  const trashScope = trashStart >= 0 && depsAt > trashStart ? c.slice(trashStart, depsAt) : '';
  const nullAt = c.indexOf('trashList === null');
  const nullLine = (() => {
    if (nullAt < 0) return '';
    const s = c.lastIndexOf('\n', nullAt) + 1;
    const e = c.indexOf('\n', nullAt);
    return c.slice(s, e < 0 ? c.length : e);
  })();
  check('回收站 effect 可切片（语义锁前置）', countHits(c, TRASH_COND) === 1 && countHits(c, TRASH_DEPS) === 1 && countHits(c, 'trashList === null') === 1 && trashStart >= 0 && trashStart < condAt && condAt < depsAt && trashScope.length > 40, 'start=' + trashStart + ' len=' + trashScope.length);
  check('effect 条件含 manageTab skill + trashList null', nullLine.includes("tab === 'manage'") && nullLine.includes("manageTab === 'skill'") && nullLine.includes('trashList === null'), nullLine.trim().slice(0, 90));
  check('effect 调 loadTrash', countHits(trashScope, 'loadTrash()') === 1, 'calls=' + countHits(trashScope, 'loadTrash()'));
  // TDZ 回归锁：依赖数组在渲染时求值，effect 必须排在 const loadTrash 定义之后
  check('effect 位于 loadTrash 定义之后（TDZ 回归锁）', countHits(c, 'const loadTrash = async') === 1 && condAt >= 0 && c.indexOf('const loadTrash = async') < condAt);
}

console.log('');
console.log('Test 8: 回收站操作的结果提示不得被列表刷新覆盖（实测 notice 被吞）');
{
  // 症状：handler 先 setNotice(已恢复…) 再 await loadTrash()/loadMcpTrash()，
  // 而这两个 loader 内部也 setNotice(回收站共 N 项) → 用户最终只看到刷新提示。
  // 锁法：handler 体内最后一次 setNotice 必须排在 loader await 之后。
  const cases = [
    ['restoreTrashEntry', 'await loadTrash();'],
    ['restoreMcpTrashEntry', 'await loadMcpTrash();'],
    ['emptyMcpTrash', 'await loadMcpTrash();'],
  ];
  for (const item of cases) {
    const name = item[0], loader = item[1];
    const start = c.indexOf('const ' + name + ' = async');
    if (start < 0) { check(name + ' 存在', false, '未找到'); continue; }
    const cut = c.indexOf('\n      };', start);
    const body = c.slice(start, cut > start ? cut : start + 1200);
    const loaderAt = body.indexOf(loader);
    const noticeAt = body.lastIndexOf('setNotice(');
    check(name + ' 结果提示排在刷新之后', loaderAt < 0 || noticeAt > loaderAt, 'loader@' + loaderAt + ' lastNotice@' + noticeAt);
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);