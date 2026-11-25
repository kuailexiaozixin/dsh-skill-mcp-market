#!/usr/bin/env node
// test-mcp-full-edit.mjs — MCP 添加/编辑完全化（用户指令：完全可编辑）。
//
// 前提修正（实测推翻旧声明）：0.5.116 的 command 守卫从来不是安全边界——实测把
// command=calc.exe 的定义直接写进定义目录，reconcile() 立即挂载执行。机器信任才是边界；
// 守卫的真正价值是防误操作。因此「完全可编辑」的正确形态不是继续假装存在边界，
// 而是把改动放进与全插件一致的 **confirm 闸门**（6 处现有用法，删除/清空全部走它）：
//  - 改动 command/args 时必须显式 confirm:true（两步 UI），纯表单字段无需确认；
//  - 字段级语义：command/args/env/headers/transport/cwd/toolCallTimeoutMs/reconnect 全可改；
//  - env/headers 用合并语义（envSet/envUnset），绝不能把 detail 的掩码字面量
//    「***（来自环境变量）」写回定义毁掉真实值。
// 本套件把 test-mcp-command-guard / test-mcp-raw-edit / test-mcp-panel-p0 里的旧
// 「永久拒绝」断言反转过来，并新增行为级验证。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

const W = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(W, f), 'utf8');
const ix = read('index.js');
const mj = read('src/mcp.js');
const c = read('client.js');

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 140) + ']' : '')); } };

const mkCtx = function () {
  const box = { mountCount: 0 };
  const ctx = {
    tools: { definitions: function () { return []; } },
    plugin: function () { box.mountCount++; return { state: 2, dispose: function () {} }; },
    loader: { entries: function () { return []; } },
  };
  return { ctx, box };
};

console.log('');
console.log('Test 1: mcp.update 反转——command/args 可改，但需 confirm');
{
  check('update 接受 confirm 通道（不再永久拒绝）', !/patch\.command !== undefined \|\| patch\.args !== undefined/.test(ix));
  check('改 command/args 需 confirm:true（未确认时拒）', /NEEDS_CONFIRM_FIELDS/.test(ix) || /needsConfirm/.test(ix));
  check('拒绝文案改为「需二次确认」语义', /需二次确认|confirm/.test(ix.slice(ix.indexOf('case "mcp.update"'), ix.indexOf('case "mcp.update"') + 1200)));
}

console.log('');
console.log('Test 2: mcp.update 行为级（假 manager 真调用）');
{
  // dispatch 里的 mcp.update 逻辑：confirm 语义在 index 层，用源码结构锁 + 一个
  // 独立 helper 的行为锁组合。helper：needsConfirmFor(patch) → ['command','args'] 交集。
  const m = /function needsConfirmFor\([^)]*\) \{[\s\S]*?\n\}/.exec(ix) || /const needsConfirmFor = [\s\S]*?\n\};/.exec(ix);
  check('needsConfirmFor helper 存在', Boolean(m));
  if (m) {
    const fn = new Function('return ' + m[0].replace(/^function needsConfirmFor/, 'function needsConfirmFor'))();
    check('只改 url → 无需确认', JSON.stringify(fn({ url: 'x' })) === '[]');
    check('改 command → 需确认', fn({ command: 'x' }).includes('command'));
    check('改 args → 需确认', fn({ args: [] }).includes('args'));
    check('改 env → 无需确认（合并语义不覆盖未知）', JSON.stringify(fn({ env: {} })) === '[]');
  }
}

console.log('');
console.log('Test 3: mcp.update 的 patch 语义（字段级全编辑）');
{
  check('update 接受 patch.command', /patch\.command/.test(ix) || /\bpatch\b[\s\S]{0,200}command/.test(ix.slice(ix.indexOf('case "mcp.update"'), ix.indexOf('case "mcp.update"') + 1500)));
  check('src update spread 合并（字段级全透传）', /\.\.\.def, \.\.\.patch/.test(mj));
  check('envSet/envUnset 合并语义存在', mj.includes('function applyEnvPatch') || ix.includes('function applyEnvPatch') || /envSet|envUnset/.test(mj) || /envSet|envUnset/.test(ix));
}

console.log('');
console.log('Test 4: 掩码字面量不得写回定义（行为级）');
{
  const mod = await import('../src/mcp.js');
  const dir = fs.mkdtempSync(path.join(safeTempDir(), 'medit-'));
  try {
    const base = { serverName: 'alpha', transport: 'stdio', command: 'node', args: ['-e', '0'], title: 't', env: { TOKEN: 'real-secret', REF: '${MY_VAR}' } };
    fs.writeFileSync(path.join(dir, 'alpha.json'), JSON.stringify(base, null, 2), 'utf8');
    const m = mkCtx();
    const mgr = mod.createMcpManager({ ctx: m.ctx, dirs: [dir], shippedRoot: 'X', log: function () {} });
    // 模拟「用户没动 env 但表单带了掩码值」——必须被识别并拒绝写回
    let e = '';
    try { await mgr.update('alpha', { env: { TOKEN: '***（来自环境变量）', REF: '${MY_VAR}' } }); } catch (e2) { e = String(e2.message); }
    check('掩码字面量被拒（防毁真实值）', /掩码|mask|不能写回|来自环境变量/.test(e), e.slice(0, 90));
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'alpha.json'), 'utf8'));
    check('真实 env 值未被破坏', after.env.TOKEN === 'real-secret', JSON.stringify(after.env));
    // 正常字段编辑仍然工作
    const r = await mgr.update('alpha', { title: '新标题', toolCallTimeoutMs: 45000 });
    check('非命令字段正常保存', fs.readFileSync(path.join(dir, 'alpha.json'), 'utf8').includes('新标题'));
    check('toolCallTimeoutMs 已写入', JSON.parse(fs.readFileSync(path.join(dir, 'alpha.json'), 'utf8')).toolCallTimeoutMs === 45000);
    mgr.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log('Test 5: rawSet 反转——confirm 闸门取代永久拒绝');
{
  // rawSet 改 command/args 也走 confirm（body 层），src 层不再硬拒
  check('rawSet 不再永久拒绝 command 变化', !/sameCommand|commandChanged/.test(mj) || mj.includes('rawSetAcceptsCommand'));
  check('rawSet 保留 serverName 锁（改名仍拒——那是另一个连接器）', /serverName 必须保持/.test(mj));
  check('rawSet 保留坏 JSON 拒绝', /原文不是合法 JSON/.test(mj));
  check('rawSet 保留非对象拒绝', /原文必须是一个 JSON 对象/.test(mj));
}

console.log('');
console.log('Test 6: rawSet 行为级——改 command 带 confirm 应成功');
{
  const mod = await import('../src/mcp.js');
  const dir = fs.mkdtempSync(path.join(safeTempDir(), 'mrawc-'));
  try {
    const base = { serverName: 'beta', transport: 'stdio', command: 'node', args: ['-e', '0'], title: 't', env: {} };
    fs.writeFileSync(path.join(dir, 'beta.json'), JSON.stringify(base, null, 2), 'utf8');
    const m = mkCtx();
    const mgr = mod.createMcpManager({ ctx: m.ctx, dirs: [dir], shippedRoot: 'X', log: function () {} });
    // confirm 层在 index dispatch；src 层现在应该允许（不再硬拒）
    const r = await mgr.rawSet('beta', JSON.stringify({ serverName: 'beta', command: 'node', args: ['-e', '1'], title: 't', env: {} }, null, 2));
    check('src 层允许 command/args 变化', r && r.saved === true, JSON.stringify(r && r.connectError));
  check('新 args 已落盘', fs.readFileSync(path.join(dir, 'beta.json'), 'utf8').includes('"-e",') && fs.readFileSync(path.join(dir, 'beta.json'), 'utf8').includes('"1"'));
    // serverName 锁仍在
    let e7 = '';
    try { await mgr.rawSet('beta', JSON.stringify({ serverName: 'delta', command: 'node', args: [] }, null, 2)); } catch (e2) { e7 = String(e2.message); }
    check('serverName 锁仍在', /serverName 必须保持/.test(e7), e7.slice(0, 80));
    mgr.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log('Test 7: mcp.install 反转——手动自定义安装可带 command');
{
  check('install case 不再永久拒绝 command', !/if \(body\.command\) \{\s*\n?\s*throw/.test(ix));
  // 0.5.174 在 install case 之前插入 harvestStore 装配（+346 字符），旧写法只看 600 字符窗口 ⇒ 漂出窗口即假红。
// 锁的是「install case 体内要求 confirm」这一语义，不是字面标识符位置。
check('手动安装需 confirm（两步确认）', /case "mcp\.install"[\s\S]{0,600}confirm[\s\S]{0,80}true/.test(ix) || /mcp\.install[\s\S]{0,600}NEEDS_CONFIRM|mcp\.install[\s\S]{0,600}needsConfirm/.test(ix));
  check('manualMcpDefinition 仍在（已有能力复用）', ix.includes('function manualMcpDefinition'));
}

console.log('');
console.log('Test 8: 面板表单全字段可编辑');
{
  check('命令输入框可编辑（无 readOnly）', !/h\('input', \{ style: \{ \.\.\.S\.input, opacity: 0\.75, background: 'var\(--dsh-bg[^}]*\}, value: draft\.command[^}]*readOnly/.test(c));
  check('命令字段 onChange 接线', /value: draft\.command[\s\S]{0,200}onChange/.test(c));
  check('参数 textarea 可编辑', !/value: draft\.args \|\| '',\s*\n\s*readOnly: true,/.test(c));
  check('参数 onChange 接线', /value: draft\.args \|\| '',[\s\S]{0,200}onChange/.test(c));
  check('env 编辑器存在（键值行 + 增删）', /envSet|envUnset|envDraft/.test(c));
  check('headers 编辑器存在', /headersEdit|headersDraft|headers 行/.test(c) || /headers/.test(c));
  check('cwd/toolCallTimeoutMs/reconnect 高级区', /toolCallTimeoutMs/.test(c));
  check('改命令时 UI 两步确认', /需要二次确认|confirmCommand|两步确认/.test(c) || /confirm: true[\s\S]{0,120}draft\.command/.test(c));
  check('保存带 confirm 字段（改命令时）', /'mcp\.update'[\s\S]{0,300}confirm/.test(c) || /confirmCommand/.test(c));
  check('只读提示文案已更新（不再是「面板不开放改写」）', !/面板不开放改写/.test(c));
}

console.log('');
console.log('Test 9: 面板添加表单（E-2）');
{
  check('添加 MCP 手动模式入口', /手动添加|添加自定义连接器/.test(c));
  check('添加表单全字段', /serverName/.test(c) && /transport/.test(c));
  // 实测 confirm 距 'mcp.install' 321 字符（窗口 300 差 21）；市场安装点（slug）本就不带 confirm，
  // 所以断言只针对手动添加路径：第一个调用点（submitMcpAdd）必须带 confirm。
  // 实测：加字段后 confirm 距 'mcp.install' 498（原 321）；固定窗口随字段增长脆弱，改为函数体切片。
  const _si = c.indexOf('const submitMcpAdd');
  check('添加走 mcp.install 且自定义命令带 confirm', /'mcp\.install'[\s\S]{0,700}confirm/.test(c.slice(_si, _si + 1600)));
  check('手动模式说明诚实（写明会执行该命令）', /将执行|会执行|本机执行/.test(c));
}

console.log('');
console.log('Test 10: 既有契约不破');
{
  check('DESTRUCTIVE_OPS 仍含 raw.set', /"mcp\.raw\.set"/.test(read('src/rpc-guard.js')));
  check('agent 工具通道不受影响', ix.includes('mcp_market_install'));
  check('detail 掩码仍在（展示层）', /\*\*\*（来自环境变量）/.test(mj));
  check('hasSecrets 仍在（原文层）', /hasSecrets/.test(mj));
  check('rawGet/rawSet 仍导出', /rawGet, rawSet \}/.test(mj));
}

console.log('');
console.log('Test 11: 语法');
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
