#!/usr/bin/env node
// test-rpc-surface.mjs — TDD: 面板需要的每个 RPC op 必须真的可达。
// 起因：0.5.98 把 sessions.repair 加进 HTTP_BLOCKED_OPS，而面板是它唯一的合法调用方，
// 结果「修复会话」按钮整个失效（实测连 dryRun 预演都被拒）。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };
const W = path.resolve(import.meta.dirname, '..');
const client = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
const index = fs.readFileSync(path.join(W, 'index.js'), 'utf8');

const clientOps = [...new Set([...client.matchAll(/call\(['\x22]?([\w.]+)['\x22]?\s*,/g)].map((m) => m[1]))].sort();
const clientOps2 = [...new Set([...client.matchAll(/call\('([\w.]+)'/g)].map((m) => m[1]))].sort();
// harvestCall(首参, 'OP')：harvest.start / harvest.poll 的 op 在第 2 参（大写 C 调用、op 为字符串字面量），clientOps2 的 call('OP', 抓不到⇒补一条抓 harvestCall 的第 2 参 op，并入 clientOpsAll。
const clientOps3 = [...new Set([...client.matchAll(/harvestCall\(\s*[\w.]+\s*,\s*'([\w.]+)'/g)].map((m) => m[1]))].sort();
const clientOpsAll = [...new Set([...clientOps2, ...clientOps3])].sort();
const serverOps = [...new Set([...index.matchAll(/case "([\w.]+)"/g)].map((m) => m[1]))];
const blockedMatch = index.match(/HTTP_BLOCKED_OPS = new Set\(\[([^\]]*)\]/);
const blocked = blockedMatch ? [...blockedMatch[1].matchAll(/"([\w.]+)"/g)].map((m) => m[1]) : [];

console.log('');
console.log('Test 1: 面板调用的每个 op 服务端都认识');
{
  const missing = clientOpsAll.filter((o) => !serverOps.includes(o));
  check('no unknown op', missing.length === 0, missing.join(', '));
}

console.log('');
console.log('Test 2: 面板调用的 op 不得被 HTTP_BLOCKED_OPS 拦掉');
{
  const blockedLive = clientOpsAll.filter((o) => blocked.includes(o));
  check('no client op is HTTP-blocked', blockedLive.length === 0, blockedLive.join(', '));
}

console.log('');
console.log('Test 3: sessions.repair 走 confirm 闸门而非整体封禁');
{
  const guard = fs.readFileSync(path.join(W, 'src/rpc-guard.js'), 'utf8');
  check('sessions.repair is a destructive op', guard.includes('"sessions.repair"'));
  check('dryRun is exempt from confirm', guard.includes('dryRun === true'));
  check('not in HTTP_BLOCKED_OPS', !blocked.includes('sessions.repair'), 'blocked=' + blocked.join(','));
}

console.log('');
console.log('Test 4: 面板对 sessions.repair 的调用带正确 confirm 语义');
{
  const seg = client.slice(client.indexOf("call('sessions.repair'"));
  check('confirm is !dryRun', seg.slice(0, 120).includes('confirm: !dryRun'), seg.slice(0, 90));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);