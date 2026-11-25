#!/usr/bin/env node
// test-shipped.mjs — src/shipped.js 的独立行为判据（此前该模块零直接覆盖）。
// 症状：shipped.js 是内置套件（mcp-client / skill-filesystem）的唯一定位入口，
// index.js:18 与 src/mcp.js 都靠它解析磁盘路径再 import。但门里没有任何判据直接
// 打它的导出：candidateRoots 顺序被调换、candidateFiles 少一组布局、importShipped
// 失败后不清缓存（一次瞬时失败就永久毒化该路径）——全都不会被抓到。
// 根因防护：本套件用临时目录造出五种真实布局，逐一断言命中路径；断言根优先级链
// explicit > DSH_SHIPPED_ROOT > resourcesPath > execDir/resources > execDir；断言
// 真实 import 拿到命名导出、失败后可达性切换能重试、pluginFrom 恰好五字段且
// reusable:true、SHIPPED 键集锁定。
// 生产码不改：只在进程内临时改写 DSH_SHIPPED_ROOT / process.resourcesPath /
// process.execPath（三者都是可写自有属性），断言完在 finally 里还原。

import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { SHIPPED, resolveShipped, importShipped, pluginFrom } from '../src/shipped.js';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log('  OK ' + n); }
  else { failed++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); }
};

const ENTRY = path.join('lib', 'index.js');
const segs = (name) => name.split('/');

// candidateFiles 的五组候选，顺序与 src/shipped.js:29 一致（0 基索引 = 组号）
const LAYOUTS = [
  (r, n) => path.join(r, 'app.asar', 'dsh', 'node_modules', ...segs(n), ENTRY),
  (r, n) => path.join(r, 'app.asar', 'node_modules', ...segs(n), ENTRY),
  (r, n) => path.join(r, 'dsh', 'node_modules', ...segs(n), ENTRY),
  (r, n) => path.join(r, 'node_modules', ...segs(n), ENTRY),
  (r, n) => path.join(r, 'resources', 'app.asar', 'dsh', 'node_modules', ...segs(n), ENTRY),
];

const made = [];
const tempRoot = (tag) => {
  const dir = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-shipped-' + tag + '-'));
  made.push(dir);
  return dir;
};

// 在 root 的第 layout 组候选位置写一个包入口，返回该文件绝对路径
function plant(root, layout, name, src) {
  const file = LAYOUTS[layout](root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, src);
  return file;
}

// 把三处进程级来源钉死：真实安装根（Electron 下的 resourcesPath / execDir）会抢在
// 临时根之前命中，断言就会随环境漂移。execPath 指到一个空目录 ⇒ execDir 与
// execDir/resources 两组根必然无命中。
function withStubbed(t, fn) {
  const savedEnv = process.env.DSH_SHIPPED_ROOT;
  const savedRes = process.resourcesPath;
  const savedExe = process.execPath;
  try {
    process.env.DSH_SHIPPED_ROOT = t.env ?? '';
    process.resourcesPath = t.resourcesPath ?? '';
    process.execPath = t.execPath ?? path.join(t.dead ?? safeTempDir(), 'no-such-dsh.exe');
    return fn();
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_SHIPPED_ROOT;
    else process.env.DSH_SHIPPED_ROOT = savedEnv;
    process.resourcesPath = savedRes;
    process.execPath = savedExe;
  }
}

const rel = (p) => (p || '').split(path.sep).join('/');
const markerOf = (file) => {
  try { return /MARK\s*=\s*"(\w+)"/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '?'; }
  catch { return 'unreadable'; }
};

console.log('Test 1: SHIPPED 键集与导出形状');
{
  check('SHIPPED 是对象', SHIPPED && typeof SHIPPED === 'object', typeof SHIPPED);
  const keys = Object.keys(SHIPPED).sort();
  check('键集恰好 mcpClient+skillFilesystem', JSON.stringify(keys) === JSON.stringify(['mcpClient', 'skillFilesystem']), keys.join(','));
  check('mcpClient 包名锁定', SHIPPED.mcpClient === '@deepseek-ai/dsh-mcp-client', SHIPPED.mcpClient);
  check('skillFilesystem 包名锁定', SHIPPED.skillFilesystem === '@deepseek-ai/dsh-skill-filesystem', SHIPPED.skillFilesystem);
  const bad = Object.entries(SHIPPED).filter(([, v]) => typeof v !== 'string' || !/^@deepseek-ai\/[a-z0-9-]+$/.test(v));
  check('值全为 @deepseek-ai 作用域包名', bad.length === 0, JSON.stringify(bad));
  check('无多余可枚举键', Object.getOwnPropertyNames(SHIPPED).length === 2, Object.getOwnPropertyNames(SHIPPED).join(','));
  check('resolveShipped 是函数', typeof resolveShipped === 'function', typeof resolveShipped);
  check('importShipped 是 async 函数', Object.getPrototypeOf(importShipped) === Object.getPrototypeOf(async function () { }), '');
  check('pluginFrom 是函数', typeof pluginFrom === 'function', typeof pluginFrom);
}

console.log('Test 2: resolveShipped 命中五组 candidateFiles 布局');
{
  const R = tempRoot('layouts');
  const dead = path.join(R, 'nothing');
  fs.mkdirSync(dead, { recursive: true });
  for (let i = 0; i < LAYOUTS.length; i++) {
    const name = '@lay/pkg-' + i;
    const file = plant(R, i, name, 'export const MARK="L' + i + '";\n');
    const got = withStubbed({ dead }, () => resolveShipped(name, R));
    check('布局组 ' + (i + 1) + ' 命中且路径精确', got === file, rel(got) + ' != ' + rel(file));
  }
  // 三段作用域名：锁 packageName.split('/') 逐段拼接，而不是整串当一层目录
  const deep = '@scope/deep/nested';
  const deepFile = plant(R, 3, deep, 'export const MARK="D";\n');
  check('三段包名按 / 拆段', withStubbed({ dead }, () => resolveShipped(deep, R)) === deepFile, rel(withStubbed({ dead }, () => resolveShipped(deep, R))));
  check('深层目录内容可读', markerOf(deepFile) === 'D', markerOf(deepFile));
  const flat = 'plain-pkg';
  const flatFile = plant(R, 3, flat, 'export const MARK="F";\n');
  check('单段包名命中', withStubbed({ dead }, () => resolveShipped(flat, R)) === flatFile, rel(withStubbed({ dead }, () => resolveShipped(flat, R))));
}

console.log('Test 3: 未命中与退化输入回 null（不抛）');
{
  const R = tempRoot('miss');
  const dead = path.join(R, 'nothing');
  fs.mkdirSync(dead, { recursive: true });
  fs.writeFileSync(path.join(R, 'a-file.txt'), 'not a dir\n');
  check('空根目录 → null', withStubbed({ dead }, () => resolveShipped('@no/such-pkg', R)) === null, '');
  check('未种植的作用域包 → null', withStubbed({ dead }, () => resolveShipped('@lay/pkg-9', R)) === null, '');
  check('显式根指向普通文件 → null', withStubbed({ dead }, () => resolveShipped('@no/such-pkg', path.join(R, 'a-file.txt'))) === null, '');
  check('空包名不抛（join 拼空段）', (() => { try { return withStubbed({ dead }, () => resolveShipped('', R)) === null; } catch { return false; } })(), '');
  check('execPath 为空串时不抛且回 null', (() => { try { return withStubbed({ dead, execPath: '' }, () => resolveShipped('@no/such-pkg-xyz', R)) === null; } catch { return false; } })(), '');
  check('缺显式根且三来源全空 → 不抛', (() => { try { withStubbed({ dead, env: '', resourcesPath: '' }, () => resolveShipped('@no/such-pkg-xyz')); return true; } catch { return false; } })(), '');
  const five = tempRoot('five');
  const f5 = plant(five, 4, '@five/pkg', 'export const MARK="5";\n');
  check('仅第 5 组存在时命中第 5 组', withStubbed({ dead: five }, () => resolveShipped('@five/pkg', five)) === f5, '');
  check('同根换包名即失效', withStubbed({ dead: five }, () => resolveShipped('@five/other', five)) === null, '');
}

console.log('Test 4: candidateRoots 优先级链 explicit > env > resourcesPath > execDir/resources > execDir');
{
  const R = tempRoot('prio');
  const pkg = '@acme/prio-pkg';
  const E = path.join(R, 'E');
  const V = path.join(R, 'V');
  const P = path.join(R, 'P');
  const X = path.join(R, 'X');
  fs.mkdirSync(path.join(X, 'resources'), { recursive: true });
  const fE = plant(E, 0, pkg, 'export const MARK="E";\n');
  const fV = plant(V, 1, pkg, 'export const MARK="V";\n');
  const fP = plant(P, 2, pkg, 'export const MARK="P";\n');
  const fXR = plant(path.join(X, 'resources'), 0, pkg, 'export const MARK="XR";\n');
  const fXD = plant(X, 2, pkg, 'export const MARK="XD";\n');
  const exe = path.join(X, 'fake-harness.exe');

  const run = (o, explicit) => withStubbed({ ...o, execPath: exe }, () => resolveShipped(pkg, explicit));
  check('显式根压过其余全部', run({ env: V, resourcesPath: P }, E) === fE, markerOf(run({ env: V, resourcesPath: P }, E) || ''));
  check('无显式根时 env 胜 resourcesPath', run({ env: V, resourcesPath: P }) === fV, markerOf(run({ env: V, resourcesPath: P }) || ''));
  check('env 空串时 resourcesPath 胜', run({ env: '', resourcesPath: P }) === fP, markerOf(run({ env: '', resourcesPath: P }) || ''));
  check('resourcesPath 空时 execDir/resources 胜', run({ env: '', resourcesPath: '' }) === fXR, markerOf(run({ env: '', resourcesPath: '' }) || ''));
  fs.rmSync(fXR, { force: true });
  check('execDir/resources 落空时 execDir 胜', run({ env: '', resourcesPath: '' }) === fXD, markerOf(run({ env: '', resourcesPath: '' }) || ''));
  fs.rmSync(fXD, { force: true });
  check('五根全落空 → null', run({ env: '', resourcesPath: '' }) === null, '');
  // resolveShipped:42 是 roots 外层循环 ⇒ 显式根落空后继续试 env 根（不是「只试显式根」）
  check('显式根落空后继续试 env 根', run({ env: E }, path.join(R, 'nope')) === fE, markerOf(run({ env: E }, path.join(R, 'nope')) || ''));
  check('显式根命中时优先于 env（env 同包不同布局）', run({ env: E }, V) === fV, markerOf(run({ env: E }, V) || ''));
  check('resourcesPath 为 falsy 时不产生候选根', (() => {
    fs.mkdirSync(path.join(R, 'resources'), { recursive: true });
    return withStubbed({ env: '', resourcesPath: '', execPath: exe }, () => resolveShipped(pkg, '')) === null;
  })(), '');
  check('命中路径确实来自 E 组布局', rel(fE).includes('/E/app.asar/dsh/node_modules/@acme/prio-pkg/'), rel(fE));
}

console.log('Test 5: importShipped 真实 import 命名导出与缓存命中');
{
  const R = tempRoot('import');
  const name = '@ship/ok';
  const file = plant(R, 3, name, 'export const NAME = "ship-ok";\nexport const level = 3;\nexport default { tag: "d" };\n');
  const other = plant(R, 0, '@ship/two', 'export const NAME = "ship-two";\n');
  check('两处候选同根共存', rel(file).includes('/node_modules/@ship/ok/') && rel(other).includes('/app.asar/dsh/'), rel(file) + ' | ' + rel(other));

  const ns = await withStubbed({ dead: R }, () => importShipped(name, R));
  check('命名导出 NAME 正确', ns?.NAME === 'ship-ok', JSON.stringify(ns?.NAME));
  check('命名导出数值正确', ns?.level === 3, JSON.stringify(ns?.level));
  check('default 导出保留', ns?.default?.tag === 'd', JSON.stringify(ns?.default));
  const ns2 = await withStubbed({ dead: R }, () => importShipped(name, R));
  check('重复导入返回同一 namespace（命中缓存）', ns === ns2, 'identity=' + (ns === ns2));
  const nsB = await withStubbed({ dead: R }, () => importShipped('@ship/two', R));
  check('同根另一包互不串台', nsB?.NAME === 'ship-two' && nsB !== ns, nsB?.NAME);
  check('缓存键是解析出的文件路径', withStubbed({ dead: R }, () => resolveShipped(name, R)) === file, rel(file));
}

console.log('Test 6: importShipped 失败后可达性切换（cache.delete）与错误文案');
{
  const R = tempRoot('cache');
  const name = '@flip/late';
  plant(R, 3, name, "export * from './dep.js';\nexport const TOP = 'late';\n");
  let err = null;
  try { await withStubbed({ dead: R }, () => importShipped(name, R)); } catch (e) { err = e; }
  check('静态缺依赖时首次 import 失败', Boolean(err), String(err));
  check('失败错误码为 ERR_MODULE_NOT_FOUND', err?.code === 'ERR_MODULE_NOT_FOUND', err?.code);
  // 关键判据：失败必须从 Map 里删掉，否则这条 rejected promise 会被永久复用
  fs.writeFileSync(path.join(path.dirname(LAYOUTS[3](R, name)), 'dep.js'), "export const dep = 'now';\n");
  let ok = null, err2 = null;
  try { ok = await withStubbed({ dead: R }, () => importShipped(name, R)); } catch (e) { err2 = e; }
  check('补齐依赖后再次 import 成功（缓存已清除）', ok?.TOP === 'late' && ok?.dep === 'now', err2 ? 'still failing: ' + err2.message : JSON.stringify(Object.keys(ok || {})));
  const cached = await withStubbed({ dead: R }, () => importShipped(name, R));
  check('恢复后缓存复用同一 namespace', cached === ok, '');

  const entry = LAYOUTS[3](R, name);
  fs.rmSync(entry, { force: true });
  let err3 = null;
  try { await withStubbed({ dead: R }, () => importShipped(name, R)); } catch (e) { err3 = e; }
  check('入口不可达后 import 失败（不误返旧成功）', Boolean(err3), 'resolved anyway');
  check('错误文案含 cannot locate shipped package', /cannot locate shipped package/.test(err3?.message || ''), err3?.message);
  check('错误文案含包名', (err3?.message || '').includes(name), err3?.message);
  check('错误文案含 shippedRoot 修复提示', /Set shippedRoot in the market settings/.test(err3?.message || ''), err3?.message);
  check('错误文案含 resources 目录指引', /"resources" directory/.test(err3?.message || ''), err3?.message);
  check('未命中时抛 Error 实例', err3 instanceof Error, typeof err3);

  const boom = plant(R, 3, '@boom/mod', "throw new Error('boom-eval');\n");
  let err4 = null;
  try { await withStubbed({ dead: R }, () => importShipped('@boom/mod', R)); } catch (e) { err4 = e; }
  check('求值期抛错原样上抛', /boom-eval/.test(err4?.message || ''), err4?.message);
  check('抛错包已落盘（判据非假绿）', fs.existsSync(boom), rel(boom));
}

console.log('Test 7: pluginFrom 五字段形状与 reusable:true');
{
  const apply = (cfg) => ({ applied: cfg });
  class Config { }
  const inject = (a, b) => a + b;
  const ns = { apply, Config, inject, extra: 'must-not-pass-through', name: 'wrong' };
  const p = pluginFrom(ns, 'dsh-mcp-client');
  const keys = Object.keys(p).sort();
  check('字段集恰为五键', JSON.stringify(keys) === JSON.stringify(['Config', 'apply', 'inject', 'name', 'reusable']), keys.join(','));
  check('name 取第二个参数', p.name === 'dsh-mcp-client', p.name);
  check('reusable 为布尔 true', p.reusable === true, JSON.stringify(p.reusable));
  check('apply 引用同一函数', p.apply === ns.apply, '');
  check('Config 引用同一构造器', p.Config === ns.Config, '');
  check('inject 引用同一函数', p.inject === ns.inject, '');
  check('不透传 namespace 其他字段', p.extra === undefined && !('extra' in p), JSON.stringify(p.extra));
  check('不被入参 name 覆盖', p.name !== 'wrong', p.name);
  check('apply 可调用且行为来自入参', p.apply('c').applied === 'c', JSON.stringify(p.apply('c')));
  check('inject 可调用', p.inject(1, 2) === 3, String(p.inject(1, 2)));
  check('Config 可实例化', new p.Config() instanceof ns.Config, '');
  const empty = pluginFrom({}, 'bare');
  check('空命名空间仍回五键不抛', Object.keys(empty).length === 5 && empty.name === 'bare' && empty.reusable === true, JSON.stringify(Object.keys(empty)));
  check('空命名空间三字段为 undefined', empty.apply === undefined && empty.Config === undefined && empty.inject === undefined, '');
  const twice = [pluginFrom(ns, 'a'), pluginFrom(ns, 'b')];
  check('两次调用返回不同对象', twice[0] !== twice[1] && twice[0].name === 'a' && twice[1].name === 'b', '');
}

console.log('Test 8: SHIPPED 两个内置包名在五组布局下逐一命中 ENTRY');
{
  // 同一根内同时种五组会让第 1 组必然抢先命中（那是 Test 4 要锁的优先级），所以这里
  // 每轮换一种布局、种完即删，保证「只有该组存在」这一前提成立。
  const R = tempRoot('names');
  for (const [key, pkg] of Object.entries(SHIPPED)) {
    for (let i = 0; i < LAYOUTS.length; i++) {
      const file = plant(R, i, pkg, 'export const KEY = "' + key + '";\nexport const LAYOUT = ' + i + ';\n');
      const got = withStubbed({ dead: R }, () => resolveShipped(pkg, R));
      check(key + ' 仅布局 ' + (i + 1) + ' 存在时命中', got === file && rel(got).endsWith('lib' + '/index.js'), rel(got) + ' != ' + rel(file));
      if (i === 3) {
        const ns = await withStubbed({ dead: R }, () => importShipped(pkg, R));
        check(key + ' 布局 4 可 import 且导出正确', ns?.KEY === key && ns?.LAYOUT === 3, JSON.stringify(ns?.KEY) + '/' + ns?.LAYOUT);
      }
      fs.rmSync(file, { force: true });
    }
  }
  // 真实安装环境探针：非 Electron 进程看不到 app.asar 内部（asar 是单文件），此时
  // resolveShipped 必然回 null —— 这是被锁住的行为，不是缺陷，故两种结果都收。
  const untouched = resolveShipped(SHIPPED.mcpClient);
  if (untouched === null) {
    skipped++;
    console.log('  SKIP 本机 node 进程无可见的 app.asar 安装根，真实命中断言不适用');
  } else {
    check('真实安装根命中的路径以 lib/index.js 结尾', rel(untouched).endsWith('lib' + '/index.js'), rel(untouched));
  }
}

for (const dir of made) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
