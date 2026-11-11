#!/usr/bin/env node
// test-sources.mjs — 海量测试 dsh-market 各技能源 + MCP 源的行为。
// 用法: node test-sources.mjs [--skill <src>] [--mcp <src>] [--query <q>] [--size N] [--mcp-page P] [--mcp-cat C] [--mcp-sort S]
// 输出: JSON { skill: {...}, mcp: {...} }，并打印人类可读摘要。
import { searchSkills, makeCache } from '../src/sources.js';
import { searchLobeHubMarket } from '../src/lobehub-market.js';
import { searchMcpRegistry } from '../src/mcp-registry.js';
import fs from 'node:fs';

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return dflt;
  return v;
}

const fs0 = await import('node:fs');
const os0 = await import('node:os');
const path0 = await import('node:path');
const cacheDir = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'dsh-market-test-'));
const cache = makeCache(cacheDir);
console.error('[test] cache dir:', cacheDir);
const query = opt('--query', '');
const size = Number(opt('--size', '24')) || 24;
const mcpPage = Number(opt('--mcp-page', '1')) || 1;
const mcpCat = opt('--mcp-cat', 'all');
const mcpSort = opt('--mcp-sort', 'default');

// ---- 技能源测试集：每个源 × 多种查询 ----
const skillSources = ['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'lobehub-agent', 'skillhub'];
const skillQueries = opt('--skill', '') ? [opt('--skill')] : null;

async function testSkillSource(source, q, pageSize) {
  const t0 = Date.now();
  const out = { source, query: q, pageSize, ms: 0, ok: false, itemCount: 0, items: [], hint: null, error: null, degraded: null };
  try {
    const d = await searchSkills({ query: q, source, pageSize, cache });
    out.ms = Date.now() - t0;
    out.ok = true;
    out.items = (d.items || []).slice(0, 50).map((it) => ({
      id: it.id, name: it.name, slug: it.slug, source: it.source, owner: it.owner,
      description: (it.description || '').slice(0, 120),
      hasDesc: Boolean(it.description), installable: it.installable, installs: it.installs,
    }));
    out.itemCount = (d.items || []).length;
    out.hint = d.hints ? d.hints.join('；') : null;
    out.degraded = d.degraded ? d.degraded.map((x) => x.source) : null;
    out.sourceErrors = d.sourceErrors || null;
    out.total = d.total;
  } catch (e) {
    out.ms = Date.now() - t0;
    out.error = String(e.message || e).slice(0, 400);
  }
  return out;
}

// ---- MCP 源测试 ----
async function testMcp(source, q, page, cat, sort) {
  const t0 = Date.now();
  const out = { source, query: q, page, category: cat, sort, ms: 0, ok: false, itemCount: 0, items: [], hint: null, error: null, total: null, totalPages: null };
  try {
    if (source === 'registry') {
      const d = await searchMcpRegistry({ query: q, pageSize: 24, cache });
      out.ms = Date.now() - t0; out.ok = true;
      out.items = (d.items || []).slice(0, 50).map((it) => ({
        id: it.id, name: it.name, serverName: it.serverName, owner: it.owner,
        description: (it.description || '').slice(0, 120), transport: it.transport,
        category: it.category, installs: it.installs, rating: it.rating,
      }));
      out.itemCount = (d.items || []).length;
      out.total = d.total; out.totalPages = d.totalPages;
      out.hint = d.hint || null;
    } else if (source === 'lobehub') {
      const d = await searchLobeHubMarket({ query: q, pageSize: 24, category: cat === 'all' ? '' : cat, sort: sort === 'default' ? '' : sort, page, cache });
      out.ms = Date.now() - t0; out.ok = true;
      out.items = (d.items || []).slice(0, 50).map((it) => ({
        id: it.id, name: it.name, identifier: it.identifier, owner: it.owner, author: it.author,
        description: (it.description || '').slice(0, 120), transport: it.transport,
        category: it.category, installs: it.installs, rating: it.rating,
      }));
      out.itemCount = (d.items || []).length;
      out.total = d.total; out.totalPages = d.totalPages;
      out.categories = d.categories;
      out.hint = d.hint || null;
    }
  } catch (e) {
    out.ms = Date.now() - t0;
    out.error = String(e.message || e).slice(0, 400);
  }
  return out;
}

async function main() {
  const results = { skill: {}, mcp: {} };

  // 技能源：默认跑每个源的「空查询浏览」+「真实查询」两种
  const sourcesToTest = skillQueries ? skillSources.filter((s) => s === skillQueries[0] || true) : skillSources;
  // 如果指定 --skill <src>，就只测那个源
  const targetSkillSources = skillQueries && skillQueries.length ? [skillQueries[0]] : skillSources;
  for (const s of targetSkillSources) {
    const browse = await testSkillSource(s, '', size);
    const search = await testSkillSource(s, query || 'github', size);
    results.skill[s] = { browse, search };
    const bDesc = browse.items.filter((i) => i.hasDesc).length;
    console.log(`[技能] ${s}: 浏览=${browse.itemCount}条(${browse.ms}ms, 有描述${bDesc}/${browse.items.length})${browse.hint ? ' 提示:' + browse.hint : ''}${browse.error ? ' 错误:' + browse.error : ''}`);
    console.log(`       ${s}: 查询"${search.query}"=${search.itemCount}条(${search.ms}ms, 有描述${search.items.filter((i) => i.hasDesc).length}/${search.items.length})${search.error ? ' 错误:' + search.error : ''}`);
  }

  // MCP 源：registry + lobehub，空查询 + 真实查询
  const mcpSources = opt('--mcp', '') ? [opt('--mcp')] : ['registry', 'lobehub'];
  for (const s of mcpSources) {
    const empty = await testMcp(s, '', mcpPage, mcpCat, mcpSort);
    const q = await testMcp(s, query || 'chrome', mcpPage, mcpCat, mcpSort);
    results.mcp[s] = { empty, query: q };
    console.log(`[MCP] ${s}: 空查询=${empty.itemCount}条(${empty.ms}ms)${empty.hint ? ' 提示:' + empty.hint : ''}${empty.error ? ' 错误:' + empty.error : ''}`);
    console.log(`       ${s}: 查询"${q.query}"=${q.itemCount}条(${q.ms}ms, 共${q.total} 页码${q.totalPages})${q.error ? ' 错误:' + q.error : ''}`);
  }

  fs.writeFileSync('test-results.json', JSON.stringify(results, null, 2));
  console.log('\n=== 完整结果写入 test-results.json ===');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
