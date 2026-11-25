#!/usr/bin/env node
// test-func-fixes.mjs — TDD: 本轮功能缺陷的回归测试。
// 1) TrustTools 上游参数应为 search（不是 q），查询必须真正生效。
// 2) 安装落在 @owner/slug/ 两层目录，listInstalledSkills 必须能看见。
// 3) searchSkills 必须接受并真正应用 category（切页前过滤）。
// 4) 客户端切源时必须重置分类，避免陈旧条件导致空列表。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { listInstalledSkills } from '../src/skills.js';
import { searchSkills, makeCache } from '../src/sources.js';
import { countHits } from './anchor-lib.mjs';

let passed = 0, failed = 0, skipped = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };
const skip = (n) => { skipped++; console.log('  SKIP ' + n); };

const W = path.resolve(import.meta.dirname, '..');

console.log('');
console.log('Test 1: TrustTools 传上游的参数名必须是 search');
{
  const src = fs.readFileSync(path.join(W, 'src/extra-sources.js'), 'utf8');
  // 0.5.159 起，trusttools 的单页请求被抽进模块级 fetchTrustToolsPage（在 searchTrustTools 之前）。
  // 只钉 searchTrustTools 函数体会让正常重构变成假红：断言范围必须覆盖真实请求构造路径。
  const fn = src.indexOf('export async function searchTrustTools');
  const hlp = src.indexOf('async function fetchTrustToolsPage');
  const call = src.slice(hlp >= 0 ? Math.min(hlp, fn) : fn, src.indexOf('const batch', fn));
  check('posts search: query', /search:\s*query/.test(call), 'still q:');
  check('no longer posts q: query', !/\bq:\s*query/.test(call));
}

console.log('');
console.log('Test 2: listInstalledSkills 能识别 @owner/slug 两层目录');
{
  const root = fs.mkdtempSync(path.join(safeTempDir(), 'dsh-inst-'));
  const mk = (rel) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + path.basename(rel) + '\ndescription: test\n---\nbody');
  };
  mk('flat-skill');                 // 一层
  mk('@someowner/nested-skill');    // clawhub CLI 的两层布局
  const found = await listInstalledSkills([root]);
  const slugs = found.map((s) => s.slug).sort();
  check('finds flat skill', slugs.includes('flat-skill'), slugs.join(','));
  check('finds @owner/nested skill', slugs.includes('nested-skill'), slugs.join(','));
  check('no duplicate entries', slugs.length === new Set(slugs).size);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('Test 3: searchSkills 接受 category 并在切页前过滤');
{
  const sig = fs.readFileSync(path.join(W, 'src/sources.js'), 'utf8');
  check('signature declares category', /export async function searchSkills\(\{[^}]*category/.test(sig));
  const cache = makeCache(path.join(safeTempDir(), 'dsh-cat-' + Date.now()));
  let r1, r2, err = null;
  try {
    r1 = await searchSkills({ query: '', source: 'lobehub', page: 1, pageSize: 24, cache });
    const cat = (r1.items.find((i) => i.category) || {}).category;
    if (!cat) { skip('lobehub returned no categories'); }
    else {
      r2 = await searchSkills({ query: '', source: 'lobehub', page: 1, pageSize: 24, cache, category: cat });
      check('filtered page only contains that category', r2.items.every((i) => !i.category || i.category === cat), JSON.stringify(r2.items.map(i=>i.category)));
      check('filter actually narrows or keeps a subset', r2.items.length <= r1.items.length);
    }
  } catch (e) { err = e; }
  if (err) skip('lobehub unreachable: ' + String(err.message).slice(0, 40));
}

console.log('');
console.log('Test 4: 客户端切源时重置分类');
{
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  // 语义锁：切出「切源那一段」（setSource(key); → 紧随的 searchSkills 下发）。
  // 旧的 indexOf 位置 ±200 窗是几何窗口不是作用域：切源逻辑加长就断，
  // 而 setCategory('all') 只要落在窗口里就算绿，落在哪个回调里它不管。
  const SET_SOURCE = 'setSource(key);';
  const SEARCH_CALL = 'searchSkills(query, { source: key';
  const ssAt = c.indexOf(SET_SOURCE);
  const seAt = c.indexOf(SEARCH_CALL);
  const seg = ssAt >= 0 && seAt > ssAt ? c.slice(ssAt, seAt) : '';
  check('切源段可切片（语义锁前置）', countHits(c, SET_SOURCE) === 1 && countHits(c, SEARCH_CALL) === 1 && seg.length > 20, 'len=' + seg.length);
  check('switching source resets category to all', countHits(seg, "setCategory('all')") + countHits(seg, 'setCategory("all")') === 1 && seg.search(/setCategory\((['"])all\1\)/) > 0, seg.slice(0, 120));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);