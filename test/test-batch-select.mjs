#!/usr/bin/env node
// test-batch-select.mjs — 技能批量多选 + 批量启停 + 批量卸载（差距清单 Task D-1）。
//
// 范围：参照面板的批量还有「迁移到工作区」「加入分组」，那两项依赖工作区维度与
// 用户自定义分组（本插件都没有），不属于可独立落地的一半，本套件不锁它们。
//
// 复用现有 op（skills.toggle / skills.uninstall），零新增 op。核心风险是逐项 RPC
// 循环把失败吞成成功文案 —— summarizeBatch 用真实函数求值验证，不是正则锁。
import fs from 'node:fs';
import path from 'node:path';
import { countHits } from './anchor-lib.mjs';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 130) + ']' : '')); } };

// 按字符码扫描完整函数体（正则会在内层 } 提前截断）。
function extractFn(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  let quote = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (quote !== 0) {
      if (ch === 92) i++;
      else if (ch === quote) quote = 0;
      continue;
    }
    if (ch === 39 || ch === 34 || ch === 96) { quote = ch; continue; }
    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      const nl2 = source.indexOf('\n', i);
      i = nl2 < 0 ? source.length : nl2;
      continue;
    }
    if (ch === 123) depth++;
    else if (ch === 125) { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}

console.log('');
console.log('Test 1: 批量结果汇总的行为级验证（失败不得被吞）');
{
  const body = extractFn(c, 'function summarizeBatch(label, results) {');
  check('summarizeBatch 存在', Boolean(body));
  let fn = null;
  if (body) {
    try { fn = new Function('return (' + body + ')')(); } catch (e) { check('summarizeBatch 可求值', false, String(e.message).slice(0, 90)); }
  }
  if (fn) {
    const all = fn('停用', [{ ok: true }, { ok: true }, { ok: true }]);
    check('全成功无失败字样', all.hasFailure === false && all.text.indexOf('已停用 3 项') >= 0, JSON.stringify(all));
    const part = fn('卸载', [{ ok: true }, { ok: false, error: '权限不足' }, { ok: true }]);
    check('部分成功必须报失败数', part.hasFailure === true && part.text.indexOf('1 项失败') >= 0, JSON.stringify(part));
    check('失败原因进文案', part.text.indexOf('权限不足') >= 0, part.text);
    check('成功数不得算上失败项', part.text.indexOf('已卸载 2 项') >= 0, part.text);
    const none = fn('启用', [{ ok: false, error: 'a' }, { ok: false, error: 'b' }]);
    check('全失败不得出现成功计数', none.hasFailure === true && !/已启用 \d/.test(none.text), JSON.stringify(none));
    check('空结果不谎报', fn('停用', []).hasFailure === false, JSON.stringify(fn('停用', [])));
  } else {
    for (let k = 0; k < 6; k++) check('summarizeBatch 可用', false, '无法求值');
  }
}
console.log('');
console.log('Test 2: 选择态与入口');
{
  check('batchMode state', /const \[batchMode, setBatchMode\] = useState\(false\)/.test(c));
  check('selected 用 Set', /const \[selected, setSelected\] = useState\(\(\) => new Set\(\)\)/.test(c));
  check('batchConfirm state', /const \[batchConfirm, setBatchConfirm\] = useState\(false\)/.test(c));
  check('工具行有选择入口', /'退出选择' : '选择'/.test(c));
  // 语义锁：切出 checkbox 的元素属性块（batchMode ? h('input', { → 该调用的 }) : null,），
  // 在切片内断言属性与顺序。旧的 {0,200}/{0,60} 字符窗只锁「附近有个 type: 'checkbox'」：
  // 加一行注释就能撑窗假红，跨到无关代码也照样绿。
  const sliceOf = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j > i ? s.slice(i, j) : ''; };
  const INPUT_ANCHOR = "batchMode ? h('input', {";
  const INPUT_END = '}) : null,';
  const checkboxProps = sliceOf(c, INPUT_ANCHOR, INPUT_END);
  check('checkbox 属性块可切片（语义锁前置）', countHits(c, INPUT_ANCHOR) === 1 && countHits(c, INPUT_END) === 1 && checkboxProps.length > 100, 'len=' + checkboxProps.length);
  check('批量模式下卡片带 checkbox', countHits(checkboxProps, "type: 'checkbox'") === 1, 'checkbox=' + countHits(checkboxProps, "type: 'checkbox'"));
  const BT = String.fromCharCode(96);
  const ARIA_NEEDLE = "'aria-label': " + BT + '选择 ${item.slug}' + BT;
  check('checkbox 有 aria-label', countHits(checkboxProps, ARIA_NEEDLE) === 1, 'aria=' + countHits(checkboxProps, ARIA_NEEDLE));
  const stopAt = checkboxProps.indexOf('onClick: (e) => e.stopPropagation(),');
  const changeAt = checkboxProps.indexOf('onChange: () => setSelected');
  check('checkbox 阻止冒泡（不触发卡片展开）', countHits(checkboxProps, 'onClick: (e) => e.stopPropagation(),') === 1 && stopAt >= 0 && changeAt >= 0 && stopAt < changeAt, 'stop=' + stopAt + ' change=' + changeAt);
}

console.log('');
console.log('Test 3: 计数只算可见项（筛掉的旧选择不得参与批量）');
{
  // 0.5.128 口径收紧：selectedVisible 基于 expandedVisible（展开 + 未被筛掉），比旧版
  // filteredInstalled 更强 —— 折叠分组里的项也不再悄悄参与计数与批量。
  check('selectedVisible 派生（基于 expandedVisible）', /const selectedVisible = expandedVisible\.filter\(\(i\) => selected\.has\(String\(i\.slug\)\)\)/.test(c));
  check('计数用 selectedVisible', /已选 \$\{selectedVisible\.length\} 项/.test(c));
  check('启用作用于 selectedVisible', /runBatch\('启用', 'enable', selectedVisible\)/.test(c));
  check('停用作用于 selectedVisible', /runBatch\('停用', 'disable', selectedVisible\)/.test(c));
  check('卸载作用于 selectedVisible', /runBatch\('卸载', 'uninstall', selectedVisible\)/.test(c));
}

console.log('');
console.log('Test 4: 批量条与动作');
{
  check('全部启用动作', /'全部启用'/.test(c));
  check('全部停用动作', /'全部停用'/.test(c));
  check('批量卸载动作', /'批量卸载'/.test(c));
  check('退出批量清空选择', /setSelected\(new Set\(\)\)/.test(c));
  check('全选/全不选切换', /'全不选' : '全选'/.test(c));
  check('批量条是浮层零位移', /position: 'absolute', left: 0, right: 0, top: 46, zIndex: 55/.test(c));
  check('无选中项时动作禁用', /disabled: selectedVisible\.length === 0/.test(c));
}

console.log('');
console.log('Test 5: 危险动作要二次确认');
{
  check('卸载分两步（先确认再执行）', /!batchConfirm/.test(c) && /setBatchConfirm\(true\)/.test(c));
  check('确认按钮文案带数量', /确认卸载 \$\{selectedVisible\.length\} 项/.test(c));
  check('未确认时只置位不执行', /onClick: \(\) => setBatchConfirm\(true\)/.test(c));
  check('取消回到未确认态', /onClick: \(\) => setBatchConfirm\(false\) \}, '取消'/.test(c));
  check('卸载按钮用危险色', /S\.danger \}, disabled: selectedVisible\.length === 0,/.test(c));
}

console.log('');
console.log('Test 6: 复用现有 op，零新增');
{
  const ix = read('index.js');
  check('未新增 skills.batch* op', !/case .skills\.batch/.test(ix));
  check('批量启停走 skills.toggle', /call\('skills\.toggle', \{ slug: item\.slug, enabled: verb === 'enable' \}\)/.test(c));
  check('批量卸载走 skills.uninstall 且带 confirm', /call\('skills\.uninstall', \{ slug: item\.slug, confirm: true \}\)/.test(c));
  // 语义锁：用本套件已有的 extractFn 按花括号深度切出 runBatch 完整函数体，
  // 在函数体内断言「汇总之后刷新列表」的顺序（旧 {0,120} 字符窗撑不住插入的注释，
  // 而且它并不知道自己有没有跨进别的按钮体）。
  const RUN_BATCH_HEADER = 'const runBatch = async (label, verb, items) => {';
  const runBatchSrc = extractFn(c, RUN_BATCH_HEADER) || '';
  check('runBatch 函数体可切片（语义锁前置）', countHits(c, RUN_BATCH_HEADER) === 1 && runBatchSrc.length > 200, runBatchSrc ? 'len=' + runBatchSrc.length : 'extractFn 返回 null');
  const sumAt = runBatchSrc.search(/summarizeBatch\(label, results\);/);
  const refreshAt = runBatchSrc.search(/await loadInstalled\(\);/);
  check('动作后刷新列表', sumAt >= 0 && refreshAt > sumAt && countHits(runBatchSrc, 'await loadInstalled();') === 1, 'summary=' + sumAt + ' refresh=' + refreshAt);
  check('逐项失败被收集不抛出', /results\.push\(\{ ok: false, slug: item\.slug, error: String\(e\.message \|\| e\) \}\)/.test(c));
}

console.log('');
console.log('Test 7: 既有行为不破');
{
  check('单项启停仍在', /toggleSkill\(item\.slug, off/.test(c));
  check('工具禁用 checkbox 未被误伤', /toolDenyDraft/.test(c));
  check('上传门控仍在', /uploadOpen \? h\('div'/.test(c));
  check('回收站折叠锁仍在', c.includes('回收站（'));
  check('搜索框仍在批量条之前', c.indexOf('搜索已装技能') < c.indexOf('batchMode && filteredInstalled'));
}

console.log('');
console.log('Test 8: 语法');
{
  const { execSync } = await import('node:child_process');
  let ok = true;
  try { execSync('node --check ' + JSON.stringify(path.join(W, 'client.js')), { stdio: 'pipe' }); } catch { ok = false; }
  check('client.js 语法通过', ok);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
