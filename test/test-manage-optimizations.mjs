#!/usr/bin/env node
// test-manage-optimizations.mjs — 管理面板现有功能的三处优化（转入优化阶段的第一次交付）。
//
// A. 测试连接后刷新卡片：probe 是独立实例、不写 mounted（0.5.112 起语义如此，保持不变），
//    但 probe 成功意味着真实 fiber 已发布工具；卡片 phase/tools 来自 mcp.list 缓存，
//    不刷新就停留在旧值，用户要手动刷新页面。测试连接的产出应该可见。
// B. 全选口径修正：批量条「全选」把折叠分组里的技能也选进来 —— 用户看不见它们，
//    批量卸载却会动它们。与 0.5.122 定下的原则冲突（筛掉/隐藏的旧选择不得参与批量）。
//    口径修正为「当前展开可见的项」，与 selectedVisible 的诚实语义一致。
// C. 全部展开/折叠：分组多时逐个点折叠箭头太繁琐，分组头行加两个便捷操作。
import fs from 'node:fs';
import path from 'node:path';
// 锚定位只有一份实现：anchor-lib.mjs。本套件曾内联过 once/lineOf/countHits，
// 三份拷贝就是三个会各自漂移的判定（尤其空 needle 死循环那个 bug 只修在库里）。

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };
import { once, lineOf, countHits, blockEnd } from './anchor-lib.mjs';

console.log('');
console.log('Test A: 测试连接后刷新卡片');
{
  // 用函数体切片（saveMcpEdit 的教训：固定窗口会漏）。
  const PROBE_CALL = "const r = await call('mcp.probe'";
  const pi = once(c, PROBE_CALL, 'probe调用');
  check('probe 调用存在', pi > 0);
  // 语义锁（替掉旧的两类字符窗：lastIndexOf('onClick: async') + pi - start < 260 的手写跨度上限，
  // 以及 {0,200}/{0,80}/{0,160} 窗）：从包裹 probe 调用的 onClick 行按花括号深度扫到配对闭括号，
  // 得到真正的按钮处理体；「没跨到别的按钮」由块内锚点唯一性证明，不靠魔数。
  const NLL = String.fromCharCode(10);
  const cLines = c.replace(/\r\n/g, NLL).split(NLL);
  const piLine = cLines.findIndex((l) => l.includes(PROBE_CALL));
  let onClickLine = -1;
  for (let i = piLine; i >= 0; i--) { if (cLines[i].includes('onClick: async')) { onClickLine = i; break; } }
  const bodyEnd = onClickLine < 0 ? -1 : blockEnd(c, onClickLine, 'probe onClick');
  const body = onClickLine >= 0 && bodyEnd > onClickLine ? cLines.slice(onClickLine, bodyEnd + 1).join(NLL) : '';
  check('probe 处理体可切片', body.length > 100, 'onClickLine=' + onClickLine + ' bodyEnd=' + bodyEnd);
  check('probe 体区间不跨其它按钮', countHits(body, 'onClick: async') === 1 && countHits(body, 'await call(') === 1 && countHits(body, PROBE_CALL) === 1, 'onClick=' + countHits(body, 'onClick: async') + ' calls=' + countHits(body, 'await call('));
  const okAt = body.indexOf('if (r.ok) {');
  const pendAt = body.indexOf('else if (r.pending) {');
  const failAt = body.indexOf('else setNotice(');
  const catchAt = body.indexOf('} catch (e) {');
  const okBranch = okAt >= 0 && pendAt > okAt ? body.slice(okAt, pendAt) : '';
  const pendBranch = pendAt >= 0 && failAt > pendAt ? body.slice(pendAt, failAt) : '';
  const failBranch = failAt >= 0 && catchAt > failAt ? body.slice(failAt, catchAt) : '';
  check('三条结果分支各自可切片（语义锁前置）', countHits(body, 'if (r.ok) {') === 1 && countHits(body, 'else if (r.pending) {') === 1 && countHits(body, 'else setNotice(') === 1 && countHits(body, '} catch (e) {') === 1 && okBranch.length > 20 && pendBranch.length > 20 && failBranch.length > 20, 'ok=' + okBranch.length + ' pending=' + pendBranch.length + ' fail=' + failBranch.length);
  check('成功分支刷新列表', countHits(okBranch, 'await loadInstalled();') === 1, okBranch.replace(/\s+/g, ' ').slice(0, 140));
  check('pending 分支也刷新（启动完成后卡片相位会变）', countHits(body, 'loadInstalled') >= 2 && countHits(pendBranch, 'await loadInstalled();') === 1, 'loadInstalled 出现 ' + countHits(body, 'loadInstalled') + ' 次');
  // 用户实测（0.5.148）：点「测试连接」只看到一闪「处理中」，结果没地方看。
  // 三条分支都必须给出可读结果，且失败不能只写进红条（红条会被后续操作冲掉）。
  check('成功分支给工具数', okBranch.includes('测试连接成功') && okBranch.includes('个工具'), okBranch.replace(/\s+/g, ' ').slice(0, 140));
  check('失败分支也走 notice（不只 setError）', failBranch.includes('setNotice') && failBranch.includes('测试连接失败') && failBranch.includes('未连上'), '');
  check('pending 分支说明下一步动作', pendBranch.includes('稍后再点一次「测试连接」'), '');
}

console.log('');
console.log('Test B: 全选只选可见项');
{
  // 0.5.149 起面板里有两处「全不选/全选」切换：技能批量条（这里锁的）和 MCP 工具禁用浮窗
  // （由 test-tool-deny.mjs 锁）。锚必须带批量条自己的口径前缀，否则 once 命中 2 次直接崩套件。
  const sa = once(c, "expandedVisible.length > 0 ? '全不选' : '全选'", '技能批量条全选按钮');
  const seg = c.slice(Math.max(0, sa - 500), sa + 300);
  check('全选存在', sa > 0);
  // 口径：全选集合必须与 selectedVisible 同源（排除折叠/隐藏项），而不是 filteredInstalled 全集
  check('全选不再用 filteredInstalled 全集', !/new Set\(filteredInstalled\.map/.test(seg), seg.replace(/\s+/g, ' ').slice(0, 160));
  check('全选与 selectedVisible 同口径', /expandedVisible|visibleForBatch|selectedVisible/.test(seg));
  check('已选计数与全选同口径（防两套口径漂移）', (c.match(/selectedVisible\.length/g) || []).length >= 2);
  // 计数、全选、批量动作三者必须同一口径：都基于 expandedVisible（展开+未筛掉）。
  // 旧口径基于 filteredInstalled，用户展开→选中→再折叠后看不见的项仍参与批量卸载。
  check('selectedVisible 基于 expandedVisible', /const selectedVisible = expandedVisible\.filter/.test(c));
  check('批量链路不再引用 filteredInstalled 口径', (c.match(/selectedVisible\.length === filteredInstalled/g) || []).length === 0);
}

console.log('');
console.log('Test C: 全部展开/折叠');
{
  check('入口存在', /全部展开|全部折叠/.test(c));
  // 架构：按钮不直接 setCollapsedGroups，而是走 collapseAllGroups helper ——
  // 因为直接 set 会漏掉 localStorage 写入（单组折叠 toggleGroupCollapsed 是写两者的）。
  // 断言必须锁这条真实接线，而不是要求按钮行紧邻 setCollapsedGroups。
  check('按钮调用 helper', /onClick: \(\) => collapseAllGroups\(false\)/.test(c) && /onClick: \(\) => collapseAllGroups\(true\)/.test(c));
  const helperBody = /const collapseAllGroups = \(collapsed\) => \{[\s\S]*?\n      \};/.exec(c);
  check('helper 存在且可抽出', Boolean(helperBody));
  check('helper 写 state', Boolean(helperBody) && /setCollapsedGroups\(next\)/.test(helperBody[0]));
  check('helper 写持久化（与单组折叠同键）', Boolean(helperBody) && helperBody[0].includes("localStorage.setItem('dsh-skill-mcp-market.collapsedGroups'"));
  check('持久化（与单组折叠同一存储）', /collapsedGroups 写入|localStorage\.setItem\('dsh-skill-mcp-market\.collapsedGroups'/.test(c));
}

console.log('');
console.log('Test D: 既有行为不破');
{
  check('批量条仍是浮层零位移', /top: 46, zIndex: 55/.test(c));
  check('selectedVisible 派生仍在', /const selectedVisible = /.test(c));
  check('两步确认武装态仍在', /mcpConfirmArmed \? '确认保存/.test(c));
  check('probe 语义未变（仍走独立实例 op）', /call\('mcp\.probe'/.test(c));
  check('折叠持久化键未变', c.includes("dsh-skill-mcp-market.collapsedGroups"));
}

console.log('');
console.log('');
console.log('Test F: 批量条不得遮挡可点控件（live 实测发现；严格定位防假绿）');
{
  const expandAt = once(c, "collapseAllGroups(false) }, '全部展开') : null", '全部展开');
  const collapseAt = once(c, "collapseAllGroups(true) }, '全部折叠') : null", '全部折叠');
  check('列表头全部展开受 !batchMode 门控', /^\s*!batchMode \? h\('button'/.test(lineOf(c, expandAt)));
  check('列表头全部折叠受 !batchMode 门控', /^\s*!batchMode \? h\('button'/.test(lineOf(c, collapseAt)));
  // 打开目录：用唯一 title 锚回溯它自己的开器。[开器, title] 之间不得出现 collapseAllGroups，
  // 出现就说明抓到了上一个按钮（全部折叠）的开器，而不是打开目录的。
  const odTitle = once(c, "title: '在资源管理器中直接查看 / 编辑技能文件'", '打开目录title');
  // 开器必须是「任意」h('button'（不含门控前缀）——若用 lastIndexOf('!batchMode ? h('button'')，
  // 摘掉门控后它会退到上一个按钮的开器，那行同样以 !batchMode 开头，门控断言就白写了。
  const odOpener = c.lastIndexOf("h('button', {", odTitle);
  check('打开目录开器存在', odOpener > 0);
  const between = c.slice(odOpener, odTitle);
  check('开器确属打开目录（中间无其它按钮残留）', between.indexOf('collapseAllGroups') < 0 && between.indexOf("}, '") < 0, JSON.stringify(between.replace(/\s+/g, ' ').slice(0, 90)));
  check('打开目录受 !batchMode 门控', /^\s*!batchMode \? h\('button'/.test(lineOf(c, odOpener)));
  // 批量条内补折叠控制：批量条本身只在 batchMode 渲染，条内按钮无需再门控。
  // 区间用两个唯一锚（条起=已选计数、条尾=退出选择）夹住，避免窗口估算漂移。
  const barStart = once(c, "已选 \${selectedVisible.length} 项", '批量条起');
  const barEnd = once(c, "onClick: exitBatch }, '退出选择'))", '批量条尾');
  check('批量条区间有效', barEnd > barStart, 'start=' + barStart + ' end=' + barEnd);
  const barSeg = c.slice(barStart, barEnd);
  check('批量条内含双向折叠控制', barSeg.indexOf('collapseAllGroups(false)') >= 0 && barSeg.indexOf('collapseAllGroups(true)') >= 0);
}

console.log('');
console.log('Test G: 跨套件节点锚唯一性（防静默回退假绿）');
{
  // 起因（本轮 live 证伪实验）：Test F 曾用 lastIndexOf 找「打开目录」的开器，摘掉门控后
  // 该串静默退到上一个按钮（同样以 !batchMode 开头），断言仍判 PASS —— 它检查的已不是
  // 目标节点。仓库里还有几十个同样写法的锚点；逐文件改造风险高于收益，所以改成一处扫描：
  // 任何 var.indexOf(字面量)/lastIndexOf(字面量) 取的节点锚，必须在目标源文件里命中恰好 1 次。
  // 0 次 = 锚已失效、断言在空转；>1 次 = 存在静默回退风险。
  const VAR2SRC = { c: 'client.js', ix: 'index.js', mj: 'src/mcp.js', sk: 'src/skills.js', rg: 'src/rpc-guard.js' };
  const SELF = 'test-manage-optimizations.mjs';
  const SQ = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BS = String.fromCharCode(92);
  const LF = String.fromCharCode(10);
  const DOLLAR = String.fromCharCode(36);
  const srcs = {};
  for (const k of Object.keys(VAR2SRC)) { const rel = VAR2SRC[k]; if (!srcs[rel]) srcs[rel] = read(rel); }
  const varBefore = (line, dotIdx) => { let i = dotIdx - 1; while (i >= 0 && /[A-Za-z0-9_$]/.test(line[i])) i--; return line.slice(i + 1, dotIdx); };
  // 手工取字面量（不用正则字面量：跨层写文件时转义极易被破坏）
  const stringAt = (line, openIdx) => {
    const q = line[openIdx];
    if (q !== SQ && q !== DQ) return null;
    let out = '';
    for (let i = openIdx + 1; i < line.length; i++) {
      const ch = line[i];
      if (ch === BS) { const nx = line[i + 1]; if (nx === 'n') out += LF; else if (nx === 't') out += String.fromCharCode(9); else if (nx === 'r') out += String.fromCharCode(13); else out += nx; i++; continue; }
      if (ch === q) return { text: out, eq: i };
      out += ch;
    }
    return null;
  };
  // 从 openParenIdx（'(' 的位置）扫到配对的 ')'，用于判断调用结果是否被直接
  // 拿去和 0/-1 比较（存在性断言），那种用法不要求锚唯一。
  const callEnd = (line, openParenIdx) => {
    let depth = 0, q = 0;
    for (let i = openParenIdx; i < line.length; i++) {
      const ch = line.charCodeAt(i);
      if (q) { if (ch === 92) i++; else if (ch === q) q = 0; continue; }
      if (ch === 39 || ch === 34 || ch === 96) { q = ch; continue; }
      if (ch === 40) depth++;
      else if (ch === 41) { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  const zero = [], multi = [];
  let scanned = 0;
  const files = fs.readdirSync(path.join(W, 'test')).filter((f) => f.endsWith('.mjs') && f !== SELF);
  for (const f of files) {
    const lines = read(path.join('test', f)).split(LF);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const dot = line.indexOf('.indexOf(');
      const dot2 = line.indexOf('.lastIndexOf(');
      if (dot < 0 && dot2 < 0) continue;
      const useLast = dot2 > dot;
      const d = useLast ? dot2 : dot;
      const rel = VAR2SRC[varBefore(line, d)];
      if (!rel) continue;
      const openParen = d + (useLast ? 13 : 9);
      const found = stringAt(line, openParen);
      if (found === null) continue;
      const anchor = found.text;
      // 带第三参数 = 「从某位置往后找下一个」哨兵用法，天然多命中，不是节点定位锚。
      if (line.slice(found.eq + 1).trimStart().startsWith(',')) continue;
      // 存在性断言（<0 / >=0 / ===-1 / !==-1）只要求有或无，不要求唯一。
      const ce = callEnd(line, openParen - 1);
      const cmp = ce >= 0 ? line.slice(ce + 1).trimStart() : '';
      if (cmp.startsWith('< 0') || cmp.startsWith('>= 0') || cmp.startsWith('=== -1') || cmp.startsWith('!== -1')) continue;
      if (anchor.indexOf(LF) >= 0 || anchor.indexOf(DOLLAR + '{') >= 0 || anchor.length < 8) continue;
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      scanned++;
      const hits = countHits(srcs[rel], anchor);
      const where = f + ':' + (li + 1) + ' [' + rel + '] ' + JSON.stringify(anchor.slice(0, 52));
      if (hits === 0) zero.push(where);
      else if (hits > 1) multi.push(hits + 'x ' + where);
    }
  }
  check('扫描到足量节点锚', scanned >= 20, scanned + ' 个');
  check('无命中 0 次的失效锚（断言不得空转）', zero.length === 0, zero.join(' / '));
  check('无命中 >1 次的歧义锚（无静默回退面）', multi.length === 0, multi.join(' / '));
  // 真实代码是 h('button', { —— 引号在 button 之后，之前拼错成 button, { 导致自测 0 命中。
  const manyHits = 'h(' + SQ + 'button' + SQ + ', {';
  check('计数器能识别多命中', countHits(c, manyHits) > 1, countHits(c, manyHits));
  const uniq = 'title: ' + SQ + '在资源管理器中直接查看 / 编辑技能文件' + SQ;
  check('计数器能识别唯一串', countHits(c, uniq) === 1, countHits(c, uniq));
}

console.log('');
console.log('Test E: 语法');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
