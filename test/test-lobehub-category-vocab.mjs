#!/usr/bin/env node
// test-lobehub-category-vocab.mjs — lobehub 技能市场分类通道 + 多词查询真实送达（0.5.163）。
//
// 三条缺陷都有 live 指纹（2026-11-24 宿主 RPC 实测）与上游端点取证，不是推测：
//   1) 面板 chip 永不变化（用户报障：lobehub 与 modelscope 两个技能市场的分类标签没有变化）。
//      机制有两层：服务端侧 lobehub 根本没有词表通道（index.js 只下发 skillsmp/clawhub/trusttools）；
//      面板侧 client.js:1849 从**累积**的 skills 里派生再 .slice(0,10)，第一页凑满 10 个不同分类后
//      chip 就永久锁死。监测方逐页复算：14 页里上游真实分类 26 个，被 slice(0,10) 挤出 16 个
//      （含 browser-automation / gaming / finance），用户永远点不到。
//      上游权威词表端点真实存在：GET market.lobehub.com/api/v1/skills/categories → 200，
//      296 行 [{category,count}]，其中 246 行是规范 slug 形态、50 行是自由标签
//      （Agent & Orchestration、AI & Machine Learning、_meta、_persona、developer_tooling 等）。
//   2) searchLobeHubSkills 完全丢弃 category：签名里没有它，面板传了分类也只拿全量，再走聚合层
//      「仅当前页」本地兜底 — 与 0.5.148 之前 skillsmp、0.5.153 之前 clawhub 同形。真 CLI 实测：
//      skills search --category productivity 服务端真过滤（6/6 行 category 等于所请求值）；
//      --category developer 回 0 行（developer 是 MCP 侧标签）⇒ 词表必须取技能侧那份 categories，
//      不能照搬站点 MCP 导航的 15 类。
//   3) 多词查询整源失败：live 指纹「@lobehub/market-cli CLI failed: error: too many arguments
//      for search」。根因不在 lobehub，在 Windows 引号姿势：quoteForCmd 产出的内嵌引号是反斜杠+引号，
//      cmd 不认，--q 的值被拆成两段（实测 argv: ["--q","\"weather","forecast\""]）。
//      同仓库两份同构实现（src/cli-install.js:61-64、src/lobehub-market.js:38-42）必须一起判掉。
//
// 判据全部真跑：真 import 生产模块、真起进程（PATH 注入假 npx，argv 落盘自证）、真解析夹具，零网络。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeTempDir } from '../src/home.js';
import { once, lineOf, countHits, blockEnd } from './anchor-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', f), 'utf8');
const readLf = (f) => read(f).replace(/\r\n/g, String.fromCharCode(10));
const Q = String.fromCharCode(34);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

const esMod = await import('../src/extra-sources.js');
const srcMod = await import('../src/sources.js');
const makeCacheOf = srcMod.makeCache;
const searchSkills = srcMod.searchSkills;
const searchLobeHubSkills = esMod.searchLobeHubSkills;
// 缺导出时桩住而不是具名 import：链接期崩掉的红（NO-SUMMARY）拿不到判据原文，那种红是无效红。
// 缺导出时桩成「回 null」而不是 throw：throw 会让套件在第一条判据上崩掉（NO-SUMMARY），
// 拿不到逐条失败原文，那种红是无效红。桩件把缺失记进 MISSING_EXPORTS，末行一并打印。
const MISSING_EXPORTS = [];
const noExport = (name) => { if (!MISSING_EXPORTS.includes(name)) MISSING_EXPORTS.push(name); return null; };
const parseLobeHubSkillCategories = typeof esMod.parseLobeHubSkillCategories === "function"
    ? esMod.parseLobeHubSkillCategories : (p) => noExport("parseLobeHubSkillCategories");
const lobeHubSkillCategoryVocabulary = typeof esMod.lobeHubSkillCategoryVocabulary === "function"
    ? esMod.lobeHubSkillCategoryVocabulary : async (a) => noExport("lobeHubSkillCategoryVocabulary");
const readLobeHubSkillCategoryVocabulary = typeof esMod.readLobeHubSkillCategoryVocabulary === "function"
    ? esMod.readLobeHubSkillCategoryVocabulary : async (a) => noExport("readLobeHubSkillCategoryVocabulary");

let passed = 0;
let failed = 0;
let skipped = 0;
const check = (name, cond, detail) => {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + String(detail).slice(0, 300) : '')); }
};
const skip = (name, why) => { skipped++; console.log('  SKIP ' + name + (why ? '  ' + String(why).slice(0, 160) : '')); };
// ── 平台短路（CI 平台差异处置，方案 (a)：非 win32 显式 SKIP）─────────────
// SKIP 判据 = process.platform !== 'win32'（DSH_LH_WIN_ONLY=off 可在 Windows 上强制走该分支自证）。
// 为什么 SKIP 而不是改断言：这 22 条断言断的是 Windows 专有的生产分支——cmd.exe /d /s /c 拼串、
// quoteForCmd 引号姿势、windowsVerbatimArguments、.cmd shim 假 npx。ubuntu-latest 上没有对应分支可断，
// 且 npx 不在 PATH（CI 原文：spawn npx ENOENT）。断言一条不删、也不改成 Linux 也能过（那等于拿掉
// 本次修复的核心判据）。非 win32 时夹具整段不执行（绝不 spawn 真 npx 走真网络），其中每条断言
// 逐个点名 SKIP；纯函数与源码锁断言（词表解析、面板 chip 函数体、引号/接线锁）跨平台照跑。
const IS_WIN = process.platform === 'win32' && process.env.DSH_LH_WIN_ONLY !== 'off';
const WIN_SKIP_WHY = 'win32-only fixture (cmd.exe + .cmd shim + windowsVerbatimArguments); process.platform=' + process.platform + (process.env.DSH_LH_WIN_ONLY === 'off' ? ' forced-off' : '');
const needWinSkip = (names) => { if (IS_WIN) return; for (const n of names) skip(n, WIN_SKIP_WHY); };
let fixtureChecksRun = 0;
// 夹具可用性本身是 Windows 专有事实：非 win32 记 SKIP，不算失败也不算通过。
const checkPlat = (name, cond, detail) => {
    if (!IS_WIN) { skip(name, WIN_SKIP_WHY); return; }
    check(name, cond, detail);
};
// checkW/checkWPlat = 夹具分支内的断言入口：计数器自证「非 win32 时一条都没跑」，否则就是假绿。
const checkW = (...a) => { fixtureChecksRun += 1; return check(...a); };
const checkWPlat = (...a) => { fixtureChecksRun += 1; return checkPlat(...a); };
// 夹具目录必须是纯 ASCII：cmd.exe 走 OEM 代码页解析路径，含中文的用户名目录会让 npx.cmd 直接
// 「文件名、目录名或卷标语法不正确」（本机实测：Temp 在 C:\Users\<中文>\AppData\Local\Temp 下必挂）。
const asciiDir = (p) => typeof p === 'string' && /^[ -~]+$/.test(p);
const shimRoot = (() => {
    const cand = [
        path.join(here, '..', '.dsh-tmp'),
        process.env.DSH_SCRATCH_DIR || null,
        process.env.TEMP || null,
        process.env.TMP || null,
        safeTempDir(),
    ].filter(Boolean);
    for (const c of cand) {
        if (!asciiDir(c)) continue;
        try { mkdirSync(c, { recursive: true }); writeFileSync(path.join(c, '.dsh-lh-probe'), "1", "utf8"); return c; } catch (err) {}
    }
    return null;
})();

const freshCache = () => makeCacheOf(path.join(shimRoot || safeTempDir(), 'dsh-lh-cache-' + process.pid + '-' + Math.random().toString(36).slice(2)));

// 上游取数在修复前会真的抛错（live 指纹就是 CLI failed 抛进 degraded）。判据要拿到逐条红字
// 而不是让套件在第一条上崩掉，所以每次调用都过 soft：抛错也变成一条可断言的 FAIL。
const soft = async (fn) => {
    try { return { ok: true, v: await fn() }; }
    catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
};

// ---------------------------------------------------------------- 夹具
const FIX = path.join(here, 'fixtures', 'lobehub-skill-categories.json');
const FACET_FIX = path.join(here, 'fixtures', 'lobehub-skill-facet.json');
const MULTI_FIX = path.join(here, 'fixtures', 'lobehub-skill-multiword.json');
const vocabFixture = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : null;
const facetFixture = existsSync(FACET_FIX) ? JSON.parse(readFileSync(FACET_FIX, 'utf8')) : null;
const multiFixture = existsSync(MULTI_FIX) ? JSON.parse(readFileSync(MULTI_FIX, 'utf8')) : null;
check('三份夹具在位（真词表响应 / 真 facet 响应 / 真多词响应）',
    !!vocabFixture && !!facetFixture && !!multiFixture,
    'categories=' + !!vocabFixture + ' facet=' + !!facetFixture + ' multi=' + !!multiFixture);
if (!vocabFixture || !facetFixture || !multiFixture) {
    console.log('');
    console.log('0 passed, ' + failed + ' failed（夹具缺失，后续判据无从执行）');
    process.exit(1);
}
// 监测方 m13927 ①：词表类数不得少于他逐页数出来的 26，且必须包含第 1 页之外的分类。
const NAMED_SLUGS = ['browser-automation', 'gaming', 'finance', 'pdf-documents', 'devops-cloud', 'smart-home-iot', 'calendar-scheduling', 'speech-transcription'];
const RAW_NONEMPTY = vocabFixture.filter((r) => String(r.category || '').trim() !== '').length;
const RAW_SLUGFORM = vocabFixture.filter((r) => /^[a-z][a-z0-9-]*$/.test(String(r.category || '').trim())).length;
console.log('夹具实测：总行数=' + vocabFixture.length + ' 非空=' + RAW_NONEMPTY + ' 规范 slug 形态=' + RAW_SLUGFORM + ' 自由标签=' + (RAW_NONEMPTY - RAW_SLUGFORM));

// ------------------------------------------------- 假 npx 夹具（真跑生产 npxRun 的姿势）
// 生产代码在 Windows 走 execFile(cmd.exe, ['/d','/s','/c', 拼串])，所以只要把 PATH 指向
// 一个假 npx.cmd，就能拿到「上游 CLI 实际收到的 argv」——这是唯一能在 CI 里复现 live 指纹、
// 又不打网络的办法。argv 落盘，判据直接读文件，不看 stdout 文案。
const SHIM = path.join(shimRoot || safeTempDir(), 'dsh-lh-shim-' + process.pid);
mkdirSync(SHIM, { recursive: true });
const ARGV_OUT = path.join(SHIM, 'argv.json');
const CLI_SCRIPT = path.join(SHIM, 'cli.cjs');
writeFileSync(CLI_SCRIPT, [
    "const fs = require(\"fs\");",
    "const argv = process.argv.slice(2);",
    "const out = process.env.LH_ARGV_OUT;",
    "if (out) fs.writeFileSync(out, JSON.stringify(argv));",
    "const src = process.env.LH_STDOUT_FILE;",
    "if (src) process.stdout.write(fs.readFileSync(src, \"utf8\"));",
    "process.exit(0);",
].join(NL), "utf8");
const NODE_BIN = path.normalize(existsSync('D:/nodejs/node.exe') ? 'D:/nodejs/node.exe' : process.execPath);
writeFileSync(path.join(SHIM, 'npx.cmd'), '@echo off' + NL + '"' + NODE_BIN + '" "' + CLI_SCRIPT + '" %*' + NL, 'utf8');
const SYSROOT = process.env.SystemRoot || process.env.windir || ('C:\\Windows');
const SYSTEM32 = SYSROOT + '\\System32\\';
checkPlat('假 npx 夹具可用（真 node.exe 与 cmd.exe 都在位）', existsSync(NODE_BIN) && existsSync(SYSTEM32 + 'cmd.exe'), NODE_BIN + ' / ' + SYSTEM32);
const savedPath = process.env.PATH;
const savedComSpec = process.env.ComSpec;
// shimPathApplied 只在真把 PATH 指向假 npx 时自增：非 win32 必须恒为 0（零 spawn 痕迹的凭据之一）。
let shimPathApplied = 0;
const useShim = (stdoutFile) => {
  if (!IS_WIN) { process.env.LH_STDOUT_FILE = stdoutFile; return; }
  shimPathApplied += 1;
  process.env.PATH = SHIM + ';' + SYSTEM32 + ';' + path.dirname(SYSTEM32);
  process.env.ComSpec = path.join(SYSTEM32, 'cmd.exe');
  process.env.LH_ARGV_OUT = ARGV_OUT;
  process.env.LH_STDOUT_FILE = stdoutFile;
};
const releaseShim = () => {
  process.env.PATH = savedPath;
  if (savedComSpec !== undefined) process.env.ComSpec = savedComSpec;
  delete process.env.LH_ARGV_OUT;
  delete process.env.LH_STDOUT_FILE;
};
const readArgv = () => {
  if (!existsSync(ARGV_OUT)) return null;
  return JSON.parse(readFileSync(ARGV_OUT, 'utf8'));
};

console.log('');


console.log('Test 1: 词表解析——上游权威端点，类数 >=26 且含第 1 页之外的分类');
{
    const rows = parseLobeHubSkillCategories(vocabFixture);
    check('返回数组且条数 >=26（监测方逐页数出的真实分类数）', Array.isArray(rows) && (rows || []).length >= 26,
        'rows=' + (Array.isArray(rows) ? (rows || []).length : typeof rows));
    const slugs = (rows || []).map((r) => r.slug);
    const missing = NAMED_SLUGS.filter((s) => !slugs.includes(s));
    check('点名分类全在词表内（第 1 页之外那些也必须能拿到）', missing.length === 0, 'missing=' + missing.join(','));
    check('规范 slug 一条不丢（246 条全入表）', slugs.length === RAW_SLUGFORM,
        'got=' + slugs.length + ' rawSlugForm=' + RAW_SLUGFORM);
    check('自由标签不入表（含空格/&/大写/下划线/前导数字那 50 条）',
        !slugs.some((s) => !/^[a-z][a-z0-9-]*$/.test(s)), JSON.stringify(slugs.filter((s) => !/^[a-z][a-z0-9-]*$/.test(s)).slice(0, 5)));
    check('无重复 slug', new Set(slugs).size === slugs.length,
        'dupes=' + slugs.filter((s, i) => slugs.indexOf(s) !== i).join(','));
    const counts = (rows || []).map((r) => Number(r.count) || 0);
    let desc = true;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[i - 1]) { desc = false; break; }
    check('按上游条数降序（chip 顺序稳定，不随页码漂移）', desc, counts.slice(0, 8).join(','));
    check('count 字段带真值（面板 chip 才能显示条数）',
        (rows || []).filter((r) => Number(r.count) > 0).length === (rows || []).length,
        'withCount=' + (rows || []).filter((r) => Number(r.count) > 0).length + '/' + (rows || []).length);
    check('facet 端点的 categories 字符串数组也能解析（同一词表两种形状）',
        (() => { const r2 = parseLobeHubSkillCategories({ categories: facetFixture.categories }); return Array.isArray(r2) && r2.length >= 26; })(),
        'from facet=' + (() => { const r2 = parseLobeHubSkillCategories({ categories: facetFixture.categories }); return Array.isArray(r2) ? r2.length : typeof r2; })());
}


console.log('');
console.log('Test 2: 词表抓取——只读缓存优先、失败与空表一律 null、绝不落空快照');
{
    const cache = freshCache();
    let calls = 0;
    const getJsonOk = async () => { calls++; return { categories: vocabFixture.map((r) => ({ category: r.category, count: r.count })) }; };
    const v1 = await lobeHubSkillCategoryVocabulary({ cache, getJson: getJsonOk });
    check('抓到词表且带 source 与 capturedAt', v1 && Array.isArray(v1.categories) && typeof v1.source === 'string' && Number.isFinite(v1.capturedAt),
        v1 ? 'keys=' + Object.keys(v1).join(',') + ' n=' + v1.categories.length : String(v1));
    check('词表条数 >=26（不是当前页派生那 10 个）', v1 && v1.categories.length >= 26, v1 && v1.categories.length);
    const v2 = await lobeHubSkillCategoryVocabulary({ cache, getJson: getJsonOk });
    check('热缓存命中回同一引用，不再打网络', calls === 1 && v2 === v1, 'calls=' + calls);
    const cold = freshCache();
    const getJsonBoom = async () => { calls += 100; throw new Error('fetch failed'); };
    const bad = await lobeHubSkillCategoryVocabulary({ cache: cold, getJson: getJsonBoom });
    check('上游失败返回 null（不抛给面板）', bad === null, JSON.stringify(bad));
    const again = await lobeHubSkillCategoryVocabulary({ cache: cold, getJson: getJsonBoom });
    check('失败不落空快照：下一次仍重新尝试而不是把 null 当真值缓存', again === null, JSON.stringify(again));
    const emptyCache = freshCache();
    const empty = await lobeHubSkillCategoryVocabulary({ cache: emptyCache, getJson: async () => ({ categories: [] }) });
    check('解析出 0 条同样返回 null（空表宁可用派生）', empty === null, JSON.stringify(empty));
    const shapeCache = freshCache();
    const junk = await lobeHubSkillCategoryVocabulary({ cache: shapeCache, getJson: async () => ({ data: { nope: 1 } }) });
    check('形态不符返回 null，不写坏快照', junk === null, JSON.stringify(junk));
    const readOnlyCache = freshCache();
    let readCalls = 0;
    await readLobeHubSkillCategoryVocabulary({ cache: readOnlyCache, getJson: async () => { readCalls++; return { categories: vocabFixture }; } });
    check('冷缓存下只读不取网络（面板打开不等上游）', readCalls === 0, 'getJson calls=' + readCalls);
    await lobeHubSkillCategoryVocabulary({ cache: readOnlyCache, getJson: async () => ({ categories: vocabFixture }) });
    const hot = await readLobeHubSkillCategoryVocabulary({ cache: readOnlyCache, getJson: async () => { readCalls += 10; return null; } });
    check('热缓存下只读取回词表', hot && Array.isArray(hot.categories) && hot.categories.length >= 26 && readCalls === 0,
        hot ? 'n=' + hot.categories.length : String(hot));
}

console.log('');
console.log('Test 3: searchLobeHubSkills 真收 category（假 npx 落盘 argv 自证）');
{
    needWinSkip([ 'CLI 真收到 --category（参数名与值都落在 argv 里）', '回 serverFacet=true（上游真过滤，不是本地滤当前页）', '回 totalPages（面板分页不再靠反推）', 'total 取上游 totalCount', 'items 都带所请求的分类', '换分类必须重新取数（cacheKey 含 category，不串缓存）', '浏览态不推空 --q（空串会被 CLI 当 positional）', '浏览态也不推 --category（无分类取全量）', '浏览态不得声明 serverFacet（没筛过就不许说筛过）' ]);
    if (IS_WIN) {
    const facetOut = path.join(SHIM, 'facet.json');
    writeFileSync(facetOut, JSON.stringify(facetFixture), 'utf8');
    useShim(facetOut);
    try {
        const cache = freshCache();
        const g1 = await soft(() => searchLobeHubSkills({ query: 'pdf', page: 1, pageSize: 5, cache, sort: '', category: 'pdf-documents' }));
        const argv = readArgv();
        checkW('CLI 真收到 --category（参数名与值都落在 argv 里）',
            !!argv && argv.indexOf('--category') >= 0 && argv[argv.indexOf('--category') + 1] === 'pdf-documents',
            (g1.ok ? '' : 'threw: ' + g1.err.slice(0, 120) + ' ') + 'argv=' + JSON.stringify(argv));
        const r1 = g1.v;
        checkW('回 serverFacet=true（上游真过滤，不是本地滤当前页）',
            g1.ok && r1 && r1.serverFacet === true,
            g1.ok ? JSON.stringify({ keys: Object.keys(r1 || {}), serverFacet: r1 && r1.serverFacet }) : 'threw: ' + g1.err.slice(0, 120));
        checkW('回 totalPages（面板分页不再靠反推）', g1.ok && r1 && r1.totalPages === 615, g1.ok && r1 ? r1.totalPages : '-');
        checkW('total 取上游 totalCount', g1.ok && r1 && r1.total === 3074, g1.ok && r1 ? r1.total : '-');
        checkW('items 都带所请求的分类', g1.ok && r1 && r1.items.length === 5 && r1.items.every((i) => i.category === 'pdf-documents'),
            g1.ok && r1 ? r1.items.map((i) => i.category).join(',') : '-');
        const argvPath2 = path.join(SHIM, 'argv2.json');
        process.env.LH_ARGV_OUT = argvPath2;
        const g2 = await soft(() => searchLobeHubSkills({ query: 'pdf', page: 1, pageSize: 5, cache, sort: '', category: 'gaming' }));
        const argv2 = existsSync(argvPath2) ? JSON.parse(readFileSync(argvPath2, 'utf8')) : null;
        checkW('换分类必须重新取数（cacheKey 含 category，不串缓存）',
            !!argv2 && argv2.indexOf('--category') >= 0 && argv2[argv2.indexOf('--category') + 1] === 'gaming',
            (g2.ok ? '' : 'threw: ' + g2.err.slice(0, 120) + ' ') + 'argv=' + JSON.stringify(argv2));
        const argvPath3 = path.join(SHIM, 'argv3.json');
        process.env.LH_ARGV_OUT = argvPath3;
        const g3 = await soft(() => searchLobeHubSkills({ query: '', page: 1, pageSize: 24, cache: freshCache(), sort: '', category: '' }));
        const argv3 = existsSync(argvPath3) ? JSON.parse(readFileSync(argvPath3, 'utf8')) : null;
        checkW('浏览态不推空 --q（空串会被 CLI 当 positional）', !!argv3 && !argv3.includes('--q'),
            (g3.ok ? '' : 'threw: ' + g3.err.slice(0, 120) + ' ') + 'argv=' + JSON.stringify(argv3));
        checkW('浏览态也不推 --category（无分类取全量）', !!argv3 && !argv3.includes('--category'), JSON.stringify(argv3));
        // 诚实性护栏：没发 --category 就绝不许声称服务端筛过（否则聚合层会跳过本地兜底过滤，
        // 用户点分类看到的是没筛的全量条目，比原来的假文案更坏）。
        checkW('浏览态不得声明 serverFacet（没筛过就不许说筛过）',
            g3.ok && g3.v && g3.v.serverFacet !== true,
            g3.ok ? 'serverFacet=' + JSON.stringify(g3.v.serverFacet) : 'threw: ' + g3.err.slice(0, 120));
        process.env.LH_ARGV_OUT = ARGV_OUT;
    } finally {
        releaseShim();
    }
    }
}


console.log('');
console.log('Test 4: Windows 引号姿势——两处实现都必须双写内嵌引号并声明 verbatim');
{
    const cliSrc = readLf('src/cli-install.js');
    const mkSrc = readLf('src/lobehub-market.js');
    const qf = (body) => {
        const i = body.indexOf('function quoteForCmd');
        return i < 0 ? '' : body.slice(i, body.indexOf(NL + '}', i));
    };
    const qc = qf(cliSrc);
    const qm = qf(mkSrc);
    check('cli-install.js quoteForCmd 内置引号改双写（cmd 只认 """"）', qc.includes(Q + Q) && !qc.includes(BS + Q), qc.slice(0, 160));
    check('lobehub-market.js 第二份同构实现同步改掉（否则安装路径仍拆参）', qm.includes(Q + Q) && !qm.includes(BS + Q), qm.slice(0, 160));
    check('cli-install.js execFile 选项加 windowsVerbatimArguments', /windowsVerbatimArguments:\s*true/.test(cliSrc), 'no match');
    check('lobehub-market.js 同样加 windowsVerbatimArguments', /windowsVerbatimArguments:\s*true/.test(mkSrc), 'no match');
    const noNaive = !/windowsVerbatimArguments:\s*false/.test(cliSrc + mkSrc);
    check('没有留下 false 的自伤写法', noNaive, 'found false');
}

console.log('');
console.log('Test 5: 真跑生产 npxRun——多词查询必须作为单个 argv 送达 CLI');
{
    const mod = await import('../src/cli-install.js');
    const npxRun = mod.npxRun;
    check('npxRun 可导入', typeof npxRun === 'function', typeof npxRun);
    needWinSkip([ 'argv 里 --q 的值是一段完整字符串（live 指纹 got 1. 的根因）', '后续参数没被值里的空格带跑（--page 1 仍在）', '含 & 的关键词不被 cmd 拆成多条命令', '带空格的值仍是一段（三段变一段）' ]);
    if (IS_WIN) {
    writeFileSync(path.join(SHIM, 'empty.json'), '{}', 'utf8');
    useShim(path.join(SHIM, 'empty.json'));
    try {
        const out = path.join(SHIM, 'argv5.json');
        process.env.LH_ARGV_OUT = out;
        const g = await soft(() => npxRun('@lobehub/market-cli', ['skills', 'search', '--q', 'weather forecast', '--page', '1'], { timeoutMs: 60000 }));
        const a = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
        checkW('argv 里 --q 的值是一段完整字符串（live 指纹 got 1. 的根因）',
            !!a && a.indexOf('--q') >= 0 && a[a.indexOf('--q') + 1] === 'weather forecast',
            (g.ok ? '' : 'threw: ' + g.err.slice(0, 140) + ' ') + 'argv=' + JSON.stringify(a));
        checkW('后续参数没被值里的空格带跑（--page 1 仍在）',
            !!a && a.indexOf('--page') >= 0 && a[a.indexOf('--page') + 1] === '1', JSON.stringify(a));
        const out2 = path.join(SHIM, 'argv5b.json');
        process.env.LH_ARGV_OUT = out2;
        const g2 = await soft(() => npxRun('@lobehub/market-cli', ['skills', 'search', '--q', 'Agent & Orchestration'], { timeoutMs: 60000 }));
        const b = existsSync(out2) ? JSON.parse(readFileSync(out2, 'utf8')) : null;
        checkW('含 & 的关键词不被 cmd 拆成多条命令',
            !!b && b[b.indexOf('--q') + 1] === 'Agent & Orchestration',
            (g2.ok ? '' : 'threw: ' + g2.err.slice(0, 140) + ' ') + 'argv=' + JSON.stringify(b));
        const out3 = path.join(SHIM, 'argv5c.json');
        process.env.LH_ARGV_OUT = out3;
        const g3 = await soft(() => npxRun('@lobehub/market-cli', ['skills', 'search', '--q', 'say hi now'], { timeoutMs: 60000 }));
        const c = existsSync(out3) ? JSON.parse(readFileSync(out3, 'utf8')) : null;
        checkW('带空格的值仍是一段（三段变一段）', !!c && c.indexOf('--q') >= 0 && c[c.indexOf('--q') + 1] === 'say hi now' && !c.some((x) => x.includes(BS)),
            (g3.ok ? '' : 'threw: ' + g3.err.slice(0, 140) + ' ') + 'argv=' + JSON.stringify(c));
        process.env.LH_ARGV_OUT = ARGV_OUT;
    } finally {
        releaseShim();
    }
    }
    needWinSkip([ '修复后多词搜索真的取到条目（改前是整源 CLI failed）', '上游收到的 --q 是完整两个词', '不再把 CLI 报错当数据返回' ]);
    if (IS_WIN) {
    const multiOut = path.join(SHIM, 'multi.json');
    writeFileSync(multiOut, JSON.stringify(multiFixture), 'utf8');
    useShim(multiOut);
    try {
        const gm = await soft(() => searchLobeHubSkills({ query: 'weather forecast', page: 1, pageSize: 24, cache: freshCache(), sort: '', category: '' }));
        const a = readArgv();
        checkW('修复后多词搜索真的取到条目（改前是整源 CLI failed）',
            gm.ok && gm.v && Array.isArray(gm.v.items) && gm.v.items.length === 3,
            gm.ok ? JSON.stringify({ n: gm.v.items.length }) : 'threw: ' + gm.err.slice(0, 180));
        checkW('上游收到的 --q 是完整两个词', !!a && a[a.indexOf('--q') + 1] === 'weather forecast', JSON.stringify(a));
        checkW('不再把 CLI 报错当数据返回', !String(gm.err || '').includes('too many arguments') &&
            !JSON.stringify(gm.v || {}).includes('too many arguments'), gm.ok ? '' : String(gm.err).slice(0, 180));
    } finally {
        releaseShim();
    }
    }
}


// 面板函数体真跑（0.5.153/0.5.155 既有形状：读真 client.js、切函数体、new Function 执行）。
const clientLines = readLf('client.js').split(NL);
const bodyOf = (needle) => {
    const at = clientLines.findIndex((l) => l.indexOf(needle) >= 0);
    if (at < 0) return null;
    for (let i = at + 1; i < clientLines.length; i++) if (clientLines[i] === '}') return clientLines.slice(at, i + 1).join(NL);
    return null;
};
const runChips = (args) => {
    const outer = bodyOf('function categoryChipsForSource(');
    if (outer === null) return { err: '未取到函数体 categoryChipsForSource' };
    const inner = bodyOf('function mergeCategoryVocab(');
    if (inner === null) return { err: '未取到函数体 mergeCategoryVocab' };
    try { return new Function(inner + NL + outer + NL + 'return categoryChipsForSource;')()(...args); }
    catch (e) { return { err: String((e && e.message) || e) }; }
};
const LH_ORIGIN = 'https://market.lobehub.com/api/v1/skills/categories';
// 词表必须给全（246 条），不是截 26：监测方点名的 smart-home-iot / calendar-scheduling 在条数
// 降序里排 28/29 名，只留 26 条它们照样被挤出窗口——那就是把用户报障原样复现。
const lhVocab = {
    capturedAt: 1,
    source: LH_ORIGIN,
    categories: vocabFixture
        .filter((r) => /^[a-z][a-z0-9-]*$/.test(String(r.category).trim()))
        .map((r) => ({ slug: String(r.category).trim(), label: String(r.category).trim(), totalAll: Number(r.count) || 0 }))
        .sort((a, b) => b.totalAll - a.totalAll),
};

console.log('');
console.log('Test 6: 面板 chip 来自词表而不是当前页派生（用户报障「分类标签没有变化」的直接判据）');
{
    const bySource = { lobehub: lhVocab, skillsmp: { capturedAt: 1, source: 'https://skillsmp.com/zh/categories', categories: [{ slug: 'debugging', name: '调试工具', totalAll: 532411 }] } };
    const got = runChips(['lobehub', ['pdf-documents', 'coding-agents-ides'], bySource]);
    if (got && got.err) check('lobehub 按源取词表可执行', false, got.err);
    else {
        check('lobehub 拿到全量词表 chip（>=26 条，不是当前页那 10 个）', got.length >= 26 && got.every((c) => c.fixed === true),
            'n=' + got.length + ' first=' + JSON.stringify(got[0]).slice(0, 120));
        const vals = got.map((c) => c.value);
        const miss = NAMED_SLUGS.filter((s) => !vals.includes(s));
        check('被 slice(0,10) 挤出的分类现在全部出现', miss.length === 0, 'missing=' + miss.join(','));
        check('词表在手时不混入派生 chip', !got.some((c) => c.fixed === false), JSON.stringify(got.filter((c) => c.fixed === false).map((c) => c.value)));
        check('chip 带上游条数（totalAll 有真值，categoryLabelLite 才拼得出「标签 5,636」）', got.every((c) => Number(c.totalAll) > 0), JSON.stringify(got.slice(0, 2).map((c) => [c.label, c.totalAll])));
        const p1 = runChips(['lobehub', ['a', 'b'], bySource]);
        const p2 = runChips(['lobehub', ['x', 'y', 'z', 'w'], bySource]);
        check('翻页/换词后 chip 集合完全不变（词表驱动，不再随累积条目漂移）',
            JSON.stringify(p1.map((c) => c.value)) === JSON.stringify(p2.map((c) => c.value)),
            p1.length + ' vs ' + p2.length);
    }
    const crossed = runChips(['lobehub', ['pdf-documents'], { lobehub: bySource.skillsmp, skillsmp: bySource.skillsmp }]);
    check('词表串味（lobehub 位上放 skillsmp 词表）按来源拒绝', Array.isArray(crossed) && crossed.length === 1,
        JSON.stringify(crossed && crossed.err ? crossed : crossed.map((c) => c.value)));
    const failNull = runChips(['lobehub', ['douyin', 'pdf-documents'], { lobehub: null }]);
    check('词表抓取失败（字段 null）时派生入口仍可用',
        Array.isArray(failNull) && failNull.length === 2 && failNull.every((c) => c.fixed === false),
        JSON.stringify(failNull && failNull.err ? failNull : failNull.map((c) => c.value)));
    const failEmpty = runChips(['lobehub', ['douyin'], { lobehub: { capturedAt: 1, source: LH_ORIGIN, categories: [] } }]);
    check('词表解析为空（categories=[]）时派生入口仍可用',
        Array.isArray(failEmpty) && failEmpty.length === 1 && failEmpty[0].value === 'douyin' && failEmpty[0].fixed === false,
        JSON.stringify(failEmpty && failEmpty.err ? failEmpty : failEmpty.map((c) => c.value)));
    const failAbsent = runChips(['lobehub', ['douyin'], { skillsmp: bySource.skillsmp }]);
    check('分组里缺 lobehub 键时派生入口仍可用',
        Array.isArray(failAbsent) && failAbsent.length === 1 && failAbsent[0].fixed === false,
        JSON.stringify(failAbsent && failAbsent.err ? failAbsent : failAbsent.map((c) => c.value)));
    const smp = runChips(['skillsmp', ['pdf-documents'], bySource]);
    check('lobehub 接入不得改动 skillsmp 既有行为', Array.isArray(smp) && smp.length === 1 && smp[0].value === 'debugging' && smp[0].totalAll === 532411,
        JSON.stringify(smp && smp.err ? smp : smp.map((c) => c.value)));
    const other = runChips(['browse.sh', ['page-derived-slug'], bySource]);
    check('无词表市场仍走派生（不许把 lobehub 词表漏给别的源）',
        Array.isArray(other) && other.length === 1 && other[0].value === 'page-derived-slug',
        JSON.stringify(other && other.err ? other : other.map((c) => c.value)));
    const originLine = clientLines.find((l) => l.trim().startsWith('const ORIGIN = {'));
    check('client.js 的 ORIGIN 表登记 lobehub（按源归属，词表来源域名）',
        !!originLine && /lobehub:\s*String\.fromCharCode|lobehub:/.test(originLine) && String(originLine).includes('lobehub.com'),
        (originLine || '未取到 ORIGIN 行').trim().slice(0, 180));
}


console.log('');
console.log('Test 7: 端到端——带分类的 lobehub 请求必须服务端过滤，多词查询整链路可用');
{
    needWinSkip([ '聚合层认定服务端已过滤（serverFacet=true）', '不再出现「仅当前页本地过滤/不提供分类信息」那类兜底文案', 'total/pages 用上游真值（不反推、不虚增）', '可见条目 5 条一条不少（完整呈现）', '多词查询端到端出条目（改前 items=0 + CLI failed）', '多词成功时 sourceErrors 为空（不再谎称没找到）' ]);
    if (IS_WIN) {
    const facetOut = path.join(SHIM, 'facet7.json');
    writeFileSync(facetOut, JSON.stringify(facetFixture), 'utf8');
    useShim(facetOut);
    try {
        const handlers = { lobehub: (a) => searchLobeHubSkills(a) };
        const g = await soft(() => searchSkills({ query: 'pdf', source: 'lobehub', page: 1, pageSize: 5, cache: freshCache(), handlers, category: 'pdf-documents' }));
        const r = g.v || {};
        const blob = JSON.stringify({ notes: [r.categoryNote, r.hints], se: r.sourceErrors });
        checkW('聚合层认定服务端已过滤（serverFacet=true）', g.ok && r.serverFacet === true,
            g.ok ? JSON.stringify({ serverFacet: r.serverFacet, filteredOut: r.filteredOut, note: r.categoryNote }) : 'threw: ' + g.err.slice(0, 160));
        checkW('不再出现「仅当前页本地过滤/不提供分类信息」那类兜底文案', !/仅当前页|不提供分类信息/.test(blob), blob.slice(0, 240));
        checkW('total/pages 用上游真值（不反推、不虚增）', g.ok && r.total === 3074 && r.pages === 615,
            JSON.stringify({ total: r.total, pages: r.pages, totalPages: r.totalPages }));
        checkW('可见条目 5 条一条不少（完整呈现）', g.ok && r.items.length === 5 && (r.filteredOut || 0) === 0,
            JSON.stringify({ n: (r.items || []).length, filteredOut: r.filteredOut }));
        const multiOut = path.join(SHIM, 'multi7.json');
        writeFileSync(multiOut, JSON.stringify(multiFixture), 'utf8');
        process.env.LH_STDOUT_FILE = multiOut;
        const g2 = await soft(() => searchSkills({ query: 'weather forecast', source: 'lobehub', page: 1, pageSize: 24, cache: freshCache(), handlers, category: '' }));
        const r2 = g2.v || {};
        checkW('多词查询端到端出条目（改前 items=0 + CLI failed）',
            g2.ok && (r2.items || []).length === 3 && (r2.degraded || []).length === 0,
            g2.ok ? JSON.stringify({ n: (r2.items || []).length, degraded: (r2.degraded || []).map((d) => d.error) }).slice(0, 220) : 'threw: ' + g2.err.slice(0, 200));
        checkW('多词成功时 sourceErrors 为空（不再谎称没找到）', JSON.stringify(r2.sourceErrors || []) === '[]', JSON.stringify(r2.sourceErrors));
    } finally {
        releaseShim();
    }
    }
    const idx = readLf('index.js');
    // 只认装配真正需要的两件：parse 是纯函数，只属于 extra-sources 与它的单测，
    // index.js 用不到就不许为了源码锁塞一个无用 import（死 import 会进 dead-export 面）。
    check('index.js 从 extra-sources 导入 lobehub 词表（read + 抓取两件）',
        /readLobeHubSkillCategoryVocabulary/.test(idx) && /lobeHubSkillCategoryVocabulary/.test(idx),
        (idx.match(/import[^\n]*extra-sources\.js/) || ['(无 import 行)'])[0].slice(0, 180));
    // 语义锁：切出 index.js 的词表装配作用域（let categoryVocabulary = null; → trusttools 补装行），
    // 再到装配对象字面量本身里面找 lobehub 键。旧的 {0,1200} 窗会被 sortCapabilities.mcp.lobehub
    // （index.js:1237）满足——那是假绿：词表键跑到排序表里，判据照样绿。
    const sliceOf = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j > i ? s.slice(i, j) : ''; };
    const VOC_HEAD = 'let categoryVocabulary = null;';
    const VOC_TAIL = 'if (categoryVocabulary) categoryVocabulary.trusttools = ttVocab;';
    const VOC_PAYLOAD = 'categoryVocabulary: categoryVocabulary || undefined,';
    const vocScope = sliceOf(idx, VOC_HEAD, VOC_TAIL);
    const vocAsm = sliceOf(vocScope, 'categoryVocabulary = {', '};');
    check('词表装配作用域可切片（语义锁前置）',
        countHits(idx, VOC_HEAD) === 1 && countHits(idx, VOC_TAIL) === 1 && countHits(idx, VOC_PAYLOAD) === 1 && vocScope.length > 200 && vocAsm.length > 40,
        'scope=' + vocScope.length + ' asm=' + vocAsm.length);
    // 键名必须整词匹配：把 lobehub 改名成 lhlobehub 时，子串式 needle 'lobehub:' 与无左界的
    // /lobehub:/ 都照样命中，判据会假绿（变异自证 M14 就是这么暴露的）。这里取装配对象的
    // 真实键名集合，再取 lobehub 键自己的值，两者都必须是语义结果而非字符窗。
    const vocKeys = [...vocAsm.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
    const lhVal = (vocAsm.match(/(?:^|[{,\s])lobehub:\s*([^,}]+)/) || [])[1] || '';
    check('settings.get 按源下发 lobehub 词表（分组里必须有 lobehub 键）',
        vocKeys.includes('lobehub') && lhVal.includes('lhVocab'),
        'keys=' + vocKeys.join(',') + ' value=' + lhVal.trim());
    check('面板装配只读缓存、不等网络（read + void 补取）',
        /readLobeHubSkillCategoryVocabulary\(\{\s*cache:/.test(idx) && /void lobeHubSkillCategoryVocabulary\(/.test(idx), 'read/void 组合缺失');
    const esSrc = readLf('src/extra-sources.js');
    check('extra-sources.js 导出三件', /export function parseLobeHubSkillCategories/.test(esSrc)
        && /export async function lobeHubSkillCategoryVocabulary/.test(esSrc)
        && /export async function readLobeHubSkillCategoryVocabulary/.test(esSrc), '');
}

console.log('');
// 0.5.169 撞名判据的家（m19018 取证，port=54733 settings.get → categoryVocabulary）：
//   lobehub 第 190 类 slug=general / label「其他」（1 条）；modelscope 第 7 类 slug「其他」；clawhub 第 14 类 slug=other。
// 上游真有这些杂项桶，而面板自造的合并入口以前也叫「其他」——两个「其他」并排，用户分不清哪个能点出什么；
// 且上游桶点开来往往是空的（skillsmp 的 education/design 实测 total 上千但 facet 抖动，桶类则 1 条），
// 0.5.169 起入口一度改叫「窗外」；0.5.177 用户 m23543/m23544 又叫回「其他」，撞名改由渲染层文本区分：
const BUCKET_TOKENS = ['other', 'others', 'general', '其他'];
const bucketNorm = (text) => String(text === undefined || text === null ? '' : text).toLowerCase().replace(/[\s_/·．.\-]+/g, '');
const isBucketText = (text) => BUCKET_TOKENS.indexOf(bucketNorm(text)) >= 0;
const isBucketChip = (chip) => !!chip && (isBucketText(chip.value) || isBucketText(chip.label));
const isBucketSlug = (slug) => isBucketText(slug);
// 可喂假源码的锁函数自证：面板里的桶判定必须与这里同一套 token，否则下面的判据是在判自己的实现。
const bucketLockSrc = [
    'function isGenericBucketText(text) {',
    '    const s = String(text || EMPTY_STRING).toLowerCase().replace(STRIPPED, EMPTY_STRING);',
    '    if (!s) { return false; }',
    '    return TOKENS.indexOf(s) >= 0;',
    '}',
].join(String.fromCharCode(10));
const runBucketLock = (tokens) => new Function('EMPTY_STRING', 'STRIPPED', 'TOKENS', bucketLockSrc + String.fromCharCode(10) + 'return isGenericBucketText;')('', '/[\\s_/·．.-]+/g', tokens);
check('桶判定锁函数自证（喂同一套 token 才认桶，喂错的名单不认）',
    runBucketLock(BUCKET_TOKENS)('其他') === true && runBucketLock(BUCKET_TOKENS)('General') === true &&
    runBucketLock(BUCKET_TOKENS)('开发工具') === false && runBucketLock(['nope'])('其他') === false, '');
const tailTextRe = /^其他$/;
const isTailText = (text) => tailTextRe.test(String(text));
check('合并入口文案自证：恰好「其他」二字通过，带数字的旧形与上游桶形都不通过',
    isTailText('其他') === true && isTailText('其他 214 类合计 743 条') === false && isTailText('其他 2360') === false, '');

console.log('Test 8: 派生兜底的截断上限（词表缺失时不得再只留 10 个分类）');
{
    const client = readLf('client.js');
    // 语义锁：isGenericBucket 用 blockEnd 按花括号深度切函数体（旧的 {0,600}? 惰性窗会随
    // 实现加长而截断），mergeCategoryVocab 用两个唯一函数名夹作用域——「桶沉到底」的
    // 三件套必须落在同一个函数体里才算数，不再对着整个 client.js 数。
    const sliceOf = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j > i ? s.slice(i, j) : ''; };
    const GB_ANCHOR = 'const isGenericBucket = (r) => {';
    const gbStart = clientLines.findIndex((l) => l.includes(GB_ANCHOR));
    const gbEnd = gbStart < 0 ? -1 : blockEnd(client, gbStart, 'isGenericBucket');
    const genericBody = gbStart >= 0 && gbEnd > gbStart ? clientLines.slice(gbStart, gbEnd + 1).join(NL) : '';
    const MG_ANCHOR = 'function mergeCategoryVocab(derived, vocab) {';
    const MGE_ANCHOR = 'function categoryChipLabel(value, vocab) {';
    const mergeScope = sliceOf(client, MG_ANCHOR, MGE_ANCHOR);
    check('isGenericBucket/mergeCategoryVocab 可切片（语义锁前置）',
        countHits(client, GB_ANCHOR) === 1 && countHits(client, MG_ANCHOR) === 1 && countHits(client, MGE_ANCHOR) === 1
        && gbStart >= 0 && gbEnd > gbStart && genericBody.trimEnd().endsWith('};') && genericBody.length > 40 && mergeScope.length > 400,
        'gb=' + genericBody.length + ' merge=' + mergeScope.length);
    check('client.js 的桶判定用同一套 token，且在 mergeCategoryVocab 里真把桶沉到底',
        BUCKET_TOKENS.every((t) => genericBody.indexOf(t) >= 0) &&
        countHits(mergeScope, 'const ranked = [];') === 1 && countHits(mergeScope, 'const sunk = [];') === 1 &&
        /const sorted = ranked\.concat\(sunk\);/.test(mergeScope) && /for \(const r of sorted\)/.test(mergeScope) &&
        countHits(client, 'const expandedChips = splitBuckets(vocabChips.filter(realChip));') === 1, genericBody.slice(0, 120));
    const _dl = client.split(NL).find((l) => l.includes("new Set(skills.map(") && l.includes(".slice(")) || "";
    const derivedLine = (_dl === undefined ? '' : _dl).trim();
    check('派生行的 10 上限已放开（词表在手时是权威，缺词表时用户也不该只看到 10 个入口）',
        derivedLine !== '' && !/\.slice\(0,\s*10\)/.test(derivedLine) && /\.slice\(0,\s*\d{2,}\)/.test(derivedLine),
        derivedLine.slice(0, 180));
    // 真判据（不是源码锁）：默认窗口必须容得下用户点名的分类。做法=从 client.js 读出当前
    // CAT_CHIP_FOLD 的实际值，对词表驱动的真 chip 序列取同样的窗口宽度，再断言 8 个点名分类全在窗内；
    // 同时断言 246 类仍大于窗口（折叠入口还在，UI 不会被 246 个 chip 挤没）。
    const foldMatch = client.match(/const CAT_CHIP_FOLD = (\d+);/);
    const foldN = foldMatch ? Number(foldMatch[1]) : 0;
    check('折叠常量存在且是两位数（既没被删成不折叠，也没退回个位数）', foldN >= 10 && foldN <= 60, 'fold=' + foldN);
    const winChips = runChips(['lobehub', [], { lobehub: lhVocab }]);
    const winVals = Array.isArray(winChips) ? winChips.slice(0, foldN).map((c) => c.value) : [];
    const winMiss = NAMED_SLUGS.filter((s) => !winVals.includes(s));
    check('点名分类全部落在默认窗口内（不点任何展开就能看见、能点）',
        Array.isArray(winChips) && winChips.length > foldN && winMiss.length === 0,
        'chip=' + (winChips && winChips.length) + ' fold=' + foldN + ' 未点名类=' + winMiss.join(','));
    // 未逐个列出的分类不再铺开（用户 m16072 定的产品决策：合并成一个「其他」入口），
    // 所以承接判据从「更多分类」换成「其他」：窗口 = 前 foldN 类 + 1 个其他，
    // 「其他」的条数必须是这些类合计的上游真数，covers 必须盖住全部未点名 slug，
    // 且用户点名的分类绝不被卷进「其他」（那等于把报障的分类藏得更深）。
    const foldBody = bodyOf('function foldChips(');
    check('client.js 里 foldChips 合并岛可被真跑（bodyOf 取到函数体）', foldBody !== null, foldBody === null ? '未取到函数体' : '');
    const otherSlug = (client.match(/const CAT_OTHER = '([^']+)';/) || [])[1] || '';
    const tailLabel = (client.match(/const CAT_TAIL_LABEL = '([^']+)';/) || [])[1] || '';
    check('合并入口的标签常量恰好是「其他」（0.5.177 用户 m23543/m23544 定名）', tailLabel === '其他', 'CAT_TAIL_LABEL=' + tailLabel);
    const runFold = (() => {
        if (foldBody === null || !Array.isArray(winChips)) return { err: 'unavailable' };
        try {
            return new Function('CAT_OTHER', 'CAT_TAIL_LABEL', foldBody + NL + 'return foldChips;')(otherSlug, tailLabel)(winChips, foldN, tailLabel);
        } catch (e) { return { err: String((e && e.message) || e) }; }
    })();
    const tail = Array.isArray(winChips) ? winChips.slice(foldN) : [];
    const tailTotal = tail.reduce((n, c) => n + (Number(c.totalAll) || 0), 0);
    check('未逐个列出的分类由「其他」入口承接：窗口 = 前 foldN 类 + 1 个合并入口（246 类不再逐个铺开）',
        !runFold.err && runFold.window.length === foldN + 1 && !!runFold.other && runFold.other.label === '其他',
        JSON.stringify({ win: runFold.window && runFold.window.length, label: runFold.other && runFold.other.label, err: runFold.err }));
    check('「其他」的条数 = 未点名各类合计的上游真数（实测只有几百，不是全目录总数）',
        !!runFold.other && runFold.other.totalAll === tailTotal && tailTotal > 0 && tailTotal < 1000,
        JSON.stringify({ other: runFold.other && runFold.other.totalAll, tailTotal }));
    check('「其他」covers 盖住全部未点名 slug，且不含任何点名分类',
        !!runFold.other && runFold.other.covers.length === tail.length &&
        NAMED_SLUGS.every((s) => runFold.other.covers.indexOf(s) < 0),
        JSON.stringify({ covers: runFold.other && runFold.other.covers.length, tail: tail.length }));
    const many = Array.from({ length: 40 }, (_, i) => 'cat-' + i);
    const got = runChips(['skills.sh', many, {}]);
    check('无词表源在 40 个派生分类时给出 40 个入口（改前被截到 10）', Array.isArray(got) && got.length === 40,
        JSON.stringify(got && got.length !== 40 ? { n: got.length } : { n: got.length }));
    const fold = clientLines.filter((l) => /CAT_CHIP_FOLD/.test(l)).length;
    check('窗口外仍有承接入口（现在是可点的「其他」，不是靠截断分类）', fold >= 2 && !!runFold.other && runFold.otherCount > 0,
        'lines=' + fold + ' otherCount=' + (runFold.other && runFold.otherCount));
    // 渲染层真判据（0.5.165 自伤复盘 + 0.5.168 报障）：foldChips 之后 chipFold.window 里是 chip 对象，
    // 渲染 map 曾照 0.5.164 的字符串数组写——集合判据全绿，面板上「全部分类」却消失、文案塌成
    // [object Object]、onClick 把对象塞进 category。所以这里从 client.js 取真实渲染块执行，不复制实现。
    const renderSrc = (() => {
        const at2 = clientLines.findIndex((l) => l.includes('chipEntries.map((chip) =>'));
        if (at2 < 0) return null;
        for (let i = at2 + 1; i < clientLines.length; i++) if (clientLines[i].trim() === '})') return clientLines.slice(at2, i + 1).join(NL);
        return null;
    })();
    check('渲染块可从 client.js 整段取到（chipEntries.map 收口完整）', renderSrc !== null, renderSrc === null ? '未取到：map 行或 }) 收口不在' : '');
    const winValsAsSlugs = winChips.map((c) => String(c.value));
    const labelBody = bodyOf('function categoryLabelLite(');
    const collapseSlug = (client.match(/const CATS_COLLAPSE = '([^']+)';/) || [])[1] || '';
    check('收起哨兵 slug 存在且不是上游分类名', collapseSlug !== '' && collapseSlug.indexOf('其他') < 0, 'CATS_COLLAPSE=' + collapseSlug);
    // 两套渲染集合都真跑：收起态=窗口+「其他」，展开态=全部上游类+「收起分类」哨兵。
const runRenderFor = (entries, fold) => {
        if (renderSrc === null || labelBody === null || runFold.err) return { err: 'unavailable' };
        const clickCalls = [];
        const toggleCalls = [];
        const hh = (tag, props, ...kids) => ({ tag, props, kids });
        const SS = { chip: (active) => ({ active: Boolean(active) }) };
        const winStub = { scrollTo: () => {} };
        const lite = new Function(labelBody + NL + 'return categoryLabelLite;')();
        try {
            const nodesRun = new Function('chipEntries', 'chipFold', 'categoryLabelLite', 'h', 'S', 'category', 'setCategory',
                'searchSkills', 'query', 'source', 'size', 'sort', 'window', 'CATS_COLLAPSE', 'CAT_OTHER', 'bucketSlug', 'toggleCats',
                'return (' + renderSrc + NL + ');')(entries, fold || runFold, lite, hh, SS, 'all',
                (v) => clickCalls.push({ kind: 'setCategory', v }), (q, o) => clickCalls.push({ kind: 'searchSkills', o }),
                '天气 预报', 'lobehub', 24, 'installCount', winStub, collapseSlug, otherSlug, bucketSlug, (v) => toggleCalls.push(v));
            return { nodes: nodesRun, calls: clickCalls, toggles: toggleCalls };
        } catch (e) { return { err: String((e && e.message) || e) }; }
    };
// 渲染集合按 0.5.174 的口径自己算一遍：lobehub tail=214 > CAT_TAIL_EXPAND_MAX=40 属大尾巴源，
// 收起态与展开态成员相同（全部分类 + 窗内 + 1 个合并筛选 chip），因此不渲染展开/收起哨兵：
// 成员不变的切换就是装饰假控件（0.5.165 假控件同判，m00282 B1）。小尾巴源（tail<=40，skillsmp
// 63 类 tail=31）才保留两态哨兵，其成员差异由下面的装配段真跑 + 63 类夹具证明（跑同一段生产码）。
    // bucketSlug 仍是渲染块的绑定量（下游杂项桶的身份判定），realChips 是它的来源。
    const realChips = winChips.filter((c) => c && c.value && c.value !== otherSlug);
    const bucketSlug = realChips.map((c) => String(c.value)).filter(isBucketSlug)[0] || 'general';
    // 大尾巴源（本夹具 246 类，tail=214）：tailExpandable=false ⇒ 两个 catsExpanded 取值拿到
    // 完全相同的渲染集合，且哨兵不在场——所以只造一套 entries，跑两遍自证两态同集。
    const bigEntries = [{ value: 'all', label: '全部分类', totalAll: 0, fixed: true }]
        .concat(runFold.window);
    const runCollapsed = runRenderFor(bigEntries);
    const runExpanded = runRenderFor(bigEntries.slice());
    const nodes = Array.isArray(runCollapsed.nodes) ? runCollapsed.nodes : [];
    const texts = nodes.map((n) => String(n.kids[0]));
    check('收起态渲染块真跑（不抛、返回节点数组）', !runCollapsed.err && nodes.length > 0, JSON.stringify({ err: runCollapsed.err, n: nodes.length }));
    check('「全部分类」仍是首个 chip（渲染集合自带 all 入口，不靠折叠窗口）',
        nodes.length > 0 && nodes[0].props.key === 'all' && texts[0] === '全部分类', texts.slice(0, 2).join(' | '));
    check('chip 数量 = 全部分类 + 前 foldN 类 + 合并入口（大尾巴源两态同窗，无展开哨兵）',
        nodes.length === foldN + 2, 'nodes=' + nodes.length + ' 期望=' + (foldN + 2));
    check('没有任何 chip 文案塌成 [object Object]',
        texts.every((t) => t !== '' && t.indexOf('[object Object]') < 0), JSON.stringify(texts.slice(0, 3)));
    check('未选中时高亮只落在「全部分类」一处（拿对象与字符串比较会全灰）',
        nodes.filter((n) => n.props.style.active).length === 1 && nodes[0].props.style.active === true,
        'active=' + nodes.filter((n) => n.props.style.active).length);
    const otherNode = nodes[foldN + 1];
    const otherText = otherNode ? String(otherNode.kids[0]) : '';
    check('合并入口文案不带冗余：恰好「其他」二字，数字一律不进 chip 本体（用户 m23544）',
        !!otherNode && isTailText(otherText),
        JSON.stringify(otherText));
    const pdfIdx = nodes.findIndex((n) => n.props.key === 'pdf-documents');
    check('窗内分类 chip 带上游真条数（categoryLabelLite 真接到渲染层）',
        pdfIdx > 0 && /[\d,]{4,}/.test(texts[pdfIdx]), JSON.stringify({ pdfIdx, text: texts[pdfIdx] }));
// 0.5.168 用户报障（m18209）前半仍成立：合并入口必须是真 button。0.5.172 用户 m00001 把后半
// 翻了面：它不再只是展开入口，而是真筛选态——按下得到这些类的并集集合（并集口径见 visibleSkills）。
    check('「其他」是可点按钮（只有文字无法点=假控件，正是用户报的那一半）',
        !!otherNode && String(otherNode.tag) === 'button' && typeof otherNode.props.onClick === 'function',
        JSON.stringify({ tag: otherNode && otherNode.tag, hasClick: !!(otherNode && otherNode.props.onClick) }));
    const otherBaseC = (runCollapsed.calls || []).length;
    const otherBaseT = (runCollapsed.toggles || []).length;
    if (otherNode && otherNode.props.onClick) otherNode.props.onClick();
    const otherToggles = runCollapsed.toggles.slice(otherBaseT);
    const otherClicks = runCollapsed.calls.slice(otherBaseC);
    // CAT_OTHER 进 category 是 0.5.172 的新口径（面板内的合法筛选值）；它进上游前由 client.js:959
    // upstreamCat 映射回 'all'，那条映射的源码锁在 test-category-info-declaration Test 6，这里不重复实现。
    check('按下「其他」= 进合并筛选态：setCategory 与渲染层下发的 category 都是 CAT_OTHER，且不再顺手展开集合',
        otherClicks.length === 2 && otherClicks[0].v === otherSlug && !!otherClicks[1].o &&
        otherClicks[1].o.category === otherSlug && otherClicks[1].o.page === 1 && otherToggles.length === 0,
        JSON.stringify({ kinds: otherClicks.map((c) => c.kind), toggles: otherToggles, sent: otherClicks[1] && otherClicks[1].o && otherClicks[1].o.category }));
    check('「其他」按钮的 key 不是上游 slug 也不是 CAT_OTHER（面板自造值不进下发链路）',
        !!otherNode && String(otherNode.props.key).indexOf('__cat_other') < 0 && String(otherNode.props.key) !== otherSlug,
        'key=' + (otherNode && otherNode.props.key));
    const buttonKeys = nodes.filter((n) => n.tag === 'button').map((n) => String(n.props.key));
    check('上游杂项桶（other/General/其他）不进可点 chip（点了没货=假控件，m19018 后半）',
        buttonKeys.filter((k) => isBucketSlug(k)).length === 0, JSON.stringify(buttonKeys.filter((k) => isBucketSlug(k))));
    check('收起态可点 chip = all + 前 foldN 真 slug + 合并入口，行尾无哨兵（不掺派生值）',
        buttonKeys.length === foldN + 2 && buttonKeys[0] === 'all' &&
        buttonKeys.slice(1, foldN + 1).every((k) => winValsAsSlugs.indexOf(k) >= 0) &&
        buttonKeys[foldN + 1] === 'cat_tail' && buttonKeys.indexOf('cat_collapse') < 0,
        JSON.stringify({ n: buttonKeys.length, keys: buttonKeys.slice(foldN) }));
    const clickBase = (runCollapsed.calls || []).length;
    if (nodes.length > 1) nodes[1].props.onClick();
    const clicks = runCollapsed.calls.slice(clickBase);
    check('窗内 chip 按下：setCategory 与下发的 category 都是上游真 slug（对象/自造值一律不许）',
        clicks.length === 2 && typeof clicks[0].v === 'string' && clicks[0].v === nodes[1].props.key &&
        !!clicks[1].o && clicks[1].o.category === nodes[1].props.key &&
        String(clicks[0].v).indexOf('__cat_other') < 0,
        JSON.stringify(clicks.map((c) => c.kind + '=' + JSON.stringify(c.v !== undefined ? c.v : c.o && c.o.category)).slice(0, 2)));
    check('按下 chip 回第 1 页并带上当前源（渲染层仍接得住既有口径）',
        clicks.length === 2 && !!clicks[1].o && clicks[1].o.page === 1 && clicks[1].o.source === 'lobehub' && !!clicks[1].o.sort,
        JSON.stringify(clicks[1] && clicks[1].o));
    const xnodes = Array.isArray(runExpanded.nodes) ? runExpanded.nodes : [];
    check('展开态渲染块真跑：大尾巴源展开=收起成员（all + 窗口 + 合并入口，246 类绝不逐个铺开）',
        !runExpanded.err && xnodes.length === foldN + 2,
        JSON.stringify({ err: runExpanded.err, n: xnodes.length, want: foldN + 2 }));
    const xkeys = xnodes.map((n) => String(n.props.key));
    const tailSlugs = winValsAsSlugs.slice(foldN).filter((s) => !isBucketSlug(s));
    check('未点名 slug 在两态都不逐个成点（用户 m00001：只要一个「其他」按钮，不要每类单独显示）',
        tailSlugs.length > 0 && tailSlugs.every((s) => xkeys.indexOf(s) < 0 && buttonKeys.indexOf(s) < 0),
        JSON.stringify({ tail: tailSlugs.length, leaked: tailSlugs.filter((s) => xkeys.indexOf(s) >= 0).slice(0, 3) }));
    // m00282 B1：展开态与收起态成员相同 ⇒ 「展开分类」是装饰按钮。判据从「两态文案不同」翻成
    // 「大尾巴源两态都没有哨兵」，两态哨兵本身改由下方 tail<=40 装配夹具真跑（同一段生产码）。
    check('大尾巴源两态都不渲染展开/收起哨兵（无意义控件=假控件，0.5.174 口径）',
        buttonKeys.indexOf('cat_collapse') < 0 && xkeys.indexOf('cat_collapse') < 0 &&
        String(nodes[nodes.length - 1].props.key) === 'cat_tail' && String(xnodes[xnodes.length - 1].props.key) === 'cat_tail',
        JSON.stringify({ c: String(nodes[nodes.length - 1].props.key), x: String(xnodes[xnodes.length - 1].props.key) }));
    const winLastSlug = String(winValsAsSlugs[foldN - 1]);
    const winLastIdx = xnodes.findIndex((n) => String(n.props.key) === winLastSlug);
    const xBase = (runExpanded.calls || []).length;
    if (winLastIdx >= 0) xnodes[winLastIdx].props.onClick();
    const xclicks = runExpanded.calls.slice(xBase);
    check('展开态点窗内 chip 仍下发窗内真 slug（收缩/展开与筛选互不顶替）',
        winLastIdx >= 0 && xclicks.length === 2 && xclicks[0].v === winLastSlug &&
        !!xclicks[1].o && xclicks[1].o.category === winLastSlug,
        JSON.stringify(xclicks.map((c) => c.kind + '=' + JSON.stringify(c.v !== undefined ? c.v : c.o && c.o.category)).slice(0, 2)));
    // 装配段真跑（判据从字符串锁升级为执行生产码）：从 client.js 切 realChip→chipEntries 整段，
    // 绑 vocabChips/chipFold/catsExpanded 后执行。tailExpandable 门控的任何改动都会翻转成员集合，
    // 所以「大尾巴无哨兵、小尾巴有两态」两条都是真跑判据，不依赖任何被复制的实现。
    const asmStart = clientLines.findIndex((l) => l.includes('const realChip = (chip) =>'));
    const asmEnd = clientLines.findIndex((l) => l.includes('.concat(chipFold.other && tailExpandable ? [toggleChip] : []);'));
    const asmBody = (asmStart >= 0 && asmEnd > asmStart) ? clientLines.slice(asmStart, asmEnd + 1).join(NL) : '';
    const expandMax = Number((client.match(/const CAT_TAIL_EXPAND_MAX = (\d+);/) || [])[1]) || 0;
    const runChipEntries = (expanded, chips, fold) => {
        if (!asmBody) return { err: 'unavailable' };
        try {
            return { v: new Function('CAT_OTHER', 'CATS_COLLAPSE', 'CAT_TAIL_EXPAND_MAX', 'vocabChips', 'chipFold',
                'catsExpanded', 'setCatsExpanded',
                asmBody + NL + 'return chipEntries;')(otherSlug, collapseSlug, expandMax, chips, fold, expanded, () => {})
            };
        } catch (e) { return { err: String((e && e.message) || e) }; }
    };
    const hasChip = (list, v) => list.some((c) => c && c.value === v);
    const lastVal = (list) => (list.length ? String(list[list.length - 1].value) : '(empty)');
    check('装配段可从 client.js 整段真跑（realChip→tailExpandable→toggleChip→chipEntries）',
        asmBody.split(NL).length >= 10 && asmBody.includes('const chipEntries ='),
        'lines=' + asmBody.split(NL).length + ' expandMax=' + expandMax);
    const bigAsmC = runChipEntries(false, winChips, runFold);
    const bigAsmX = runChipEntries(true, winChips, runFold);
    const bigCv = Array.isArray(bigAsmC.v) ? bigAsmC.v : [];
    const bigXv = Array.isArray(bigAsmX.v) ? bigAsmX.v : [];
    check('大尾巴源装配真跑：两态成员逐项相同且哨兵不在场（tail=214 > 阈值=40）',
        !bigAsmC.err && !bigAsmX.err && bigCv.length === foldN + 2 && bigCv.length === bigXv.length &&
        bigCv.every((c, i) => c && bigXv[i] && c.value === bigXv[i].value) &&
        !hasChip(bigCv, collapseSlug) && !hasChip(bigXv, collapseSlug) && hasChip(bigCv, otherSlug),
        JSON.stringify({ c: bigCv.length, x: bigXv.length, err: bigAsmC.err || bigAsmX.err }));
    // skillsmp 形状的 63 类夹具（tail=31 <= 40）：小尾巴源才给两态入口（用户 m20051）。
    const smChips = Array.from({ length: 63 }, (_, i) => ({ value: 'c-' + i, label: 'c-' + i, totalAll: 5000 - i }));
    const smFold = foldBody === null ? { err: 'no foldBody' }
        : new Function('CAT_OTHER', 'CAT_TAIL_LABEL', foldBody + NL + 'return foldChips;')(otherSlug, tailLabel)(smChips, foldN, tailLabel);
    check('小尾巴夹具成立：63 类 → head 32 + tail 31，tail 31 落在阈值 40 内',
        !smFold.err && !!smFold.other && smFold.otherCount === 31 && smFold.otherCount <= expandMax,
        JSON.stringify({ otherCount: smFold && smFold.otherCount, expandMax, err: smFold.err }));
    const smAsmC = runChipEntries(false, smChips, smFold);
    const smAsmX = runChipEntries(true, smChips, smFold);
    const smCv = Array.isArray(smAsmC.v) ? smAsmC.v : [];
    const smXv = Array.isArray(smAsmX.v) ? smAsmX.v : [];
    check('小尾巴收起态 = 全部分类 + 前 foldN 类 + 合并入口 + 展开哨兵（未点名类不逐个在场）',
        !smAsmC.err && smCv.length === foldN + 3 && lastVal(smCv) === collapseSlug &&
        ['c-32', 'c-40', 'c-62'].every((v) => !hasChip(smCv, v)),
        JSON.stringify({ n: smCv.length, last: lastVal(smCv), err: smAsmC.err }));
    check('小尾巴展开态 = 全部 63 个上游真类 + 合并入口 + 收起哨兵（展开是真集合变化，不是装饰）',
        !smAsmX.err && smXv.length === 66 && hasChip(smXv, 'c-62') && hasChip(smXv, otherSlug) &&
        lastVal(smXv) === collapseSlug,
        JSON.stringify({ n: smXv.length, last: lastVal(smXv), err: smAsmX.err }));
    const smRunC = runRenderFor(smCv, smFold);
    const smRunX = runRenderFor(smXv, smFold);
    const smNodes = Array.isArray(smRunC.nodes) ? smRunC.nodes : [];
    const smXNodes = Array.isArray(smRunX.nodes) ? smRunX.nodes : [];
    const lastKeyOf = (a) => (a.length ? String(a[a.length - 1].props.key) : '(empty)');
    const lastKidOf = (a) => (a.length ? String(a[a.length - 1].kids[0]) : '(empty)');
    check('小尾巴渲染真跑：收起态行尾「展开分类」、展开态行尾「收起分类」（m20051 两态入口可用）',
        smNodes.length === smCv.length && smXNodes.length === smXv.length &&
        lastKeyOf(smNodes) === 'cat_collapse' && lastKidOf(smNodes) === '展开分类' &&
        lastKeyOf(smXNodes) === 'cat_collapse' && lastKidOf(smXNodes) === '收起分类',
        JSON.stringify({ c: smNodes.length, x: smXNodes.length, err: smRunC.err || smRunX.err }));
    const xBaseT = (smRunX.toggles || []).length;
    const xBaseC = (smRunX.calls || []).length;
    if (smXNodes.length && smXNodes[smXNodes.length - 1].props.onClick) smXNodes[smXNodes.length - 1].props.onClick();
    check('小尾巴展开态行尾「收起分类」按下只收起，不产生筛选下发（展示态与筛选态互不顶替）',
        (smRunX.toggles || []).length === xBaseT + 1 && smRunX.toggles[xBaseT] === false && (smRunX.calls || []).length === xBaseC,
        JSON.stringify({ toggles: smRunX.toggles, calls: (smRunX.calls || []).length - xBaseC }));
    check('大尾巴源渲染集合里既没有哨兵也没有 CAT_OTHER 之外的派生值（两态同集 = 窗内 + 合并入口）',
        bigCv.length === foldN + 2 && bigCv[bigCv.length - 1].value === otherSlug &&
        bigCv.filter((c) => c && c.value === collapseSlug).length === 0,
        JSON.stringify({ n: bigCv.length, last: lastVal(bigCv) }));
    // 源码锁：阈值常量必须存在且是两位数——真跑装配吃的就是这个值，常量删掉装配就抛。
    check('展开阈值常量 CAT_TAIL_EXPAND_MAX=40 在场（依据：skillsmp tail=31 阈内 / lobehub tail=214 阈外）',
        /const CAT_TAIL_EXPAND_MAX = (\d+);/.test(client) && expandMax >= 10 && expandMax <= 99,
        'expandMax=' + expandMax);
    check('旧 allRealChips 双态集合已删除（展开集合由 tailExpandable 门控表达）',
        !/const allRealChips *=/.test(client) && /catsExpanded && tailExpandable \? expandedChips/.test(client) &&
        /const tailExpandable = !!chipFold\.other && chipFold\.otherCount <= CAT_TAIL_EXPAND_MAX;/.test(client),
        (client.split(NL).find((l) => l.includes('tailExpandable')) || '(none)').trim().slice(0, 160));
    // B3 诚实口径（m00282，0.5.181 短句化）：未声明 tail（旧服务端）时三处必须同锁——只报本次已取回
    // 的集合（如上）、分页器只在这些条里翻不再打上游、「共约」是整源总数。短句化删的是重复叙述，
    // 不是诚实口径。分页器实参两行原样不动（test-search-fanout-latency :442/:446 锁死），
    // 所以说实话的通道只有 tailNote。
    check('tailNote 旧服务端兜底三处诚实口径在场（已取回集合如上 + 分页器短句 + 共约是整源总数），两态渲染走同一行',
        /本次已取回 .*条.*如上/.test(client) &&
        /分页器只在这些条里翻、不再打上游，「共约」是整个来源的总数。集合以本行为准。'/.test(client) &&
        /tailNote \? h\('div', \{ style: \{ \.\.\.S\.status, marginTop: 8 \} \}, tailNote\) : null,/.test(client),
        (client.split(NL).find((l) => l.includes('不是这些类的条数')) || '(none)').trim().slice(0, 170));
    check('分页器实参两行未被顺手改动（边界外判据 test-search-fanout-latency :442/:446 依赖）',
        /tab === 'skills' \? '共约' : ''/.test(client) && /tab === 'skills' \? skillsTotal : mcpTotal/.test(client), '');
    // 展开态纵向滚动形态（用户 m20051「保持展开后可上下拖动的形态」）源码锁。
    check('展开态限高纵向滚动样式仍在场（catsRow 是展开态唯一行样式）',
        /catsRow: \{[^\n]*maxHeight: 116[^\n]*overflowY: 'auto'/.test(client) &&
        /style: catsExpanded \? S\.catsRow : S\.chipRow/.test(client), '');
    // 重启路径判据（用户 m19770①）：展开态曾经落 localStorage ⇒ 宿主重启后每次开面板都全量展开，
    // 只剩 catsRow 的 maxHeight:116 兜底——「默认就该是一行」这个报障口径被持久化吃掉了。
    // 口径：展开是本次浏览的临时动作，不是偏好；重挂载 / 刷新 / 重启一律默认收起。
    check('展开态不落持久化：CATS_EXPANDED_KEY 与 cats-expanded 字样在 client.js 里彻底不存在（留着不读同样是隐患）',
        !/CATS_EXPANDED_KEY/.test(client) && !/cats-expanded/.test(client),
        JSON.stringify({ key: (client.match(/CATS_EXPANDED_KEY/g) || []).length, ls: (client.match(/cats-expanded/g) || []).length }));
    check('展开态初值是字面量 false（不是惰性初始化函数——函数体里读存储是最容易看漏的写法）',
        /const \[catsExpanded, setCatsExpanded\] = useState\(false\);/.test(client),
        (client.split(NL).find((l) => l.includes('const [catsExpanded, setCatsExpanded]')) || '(none)').trim().slice(0, 130));
    // 切源复位：chip 词表随源变（lobehub 246 类 / modelscope 20 类），展开态跨源残留会让用户在
    // 新源上直接看到一屏不相干的铺开标签，正是 m19004 抱怨的形状。复位必须落在切源那一段里。
    check('切源时复位展开态（setSource 那一段里必须 setCatsExpanded(false)）',
        (() => {
            const at = clientLines.findIndex((l) => l.includes('setSource(key);'));
            if (at < 0) return false;
            const seg = clientLines.slice(at, at + 14).join(NL);
            return /setCatsExpanded\(false\)/.test(seg) && /searchSkills\(query, \{ source: key/.test(seg);
        })(),
        (() => { const at = clientLines.findIndex((l) => l.includes('setSource(key);')); return at < 0 ? '(no setSource(key);)' : clientLines.slice(at, at + 14).filter((l) => /setCatsExpanded|searchSkills\(query/.test(l)).map((l) => l.trim()).join(' | '); })());
    check('展开/收起入口仍走 toggleCats（去持久化不许把 toggleCats 一起删掉，渲染块靠它）',
        /const toggleCats = \(next\) => \{/.test(client) && !/localStorage\.setItem\(CATS_EXPANDED_KEY/.test(client),
        (client.split(NL).find((l) => l.includes('localStorage.setItem(CATS_EXPANDED_KEY')) || '(removed)').trim().slice(0, 130));
    check('收起态 chip 行是单行横向滚动（报障主诉求：不占大半个空间）',
        /chipRow: \{[^\n]*flexWrap: 'nowrap'/.test(client) && /style: catsExpanded \? S\.catsRow : S\.chipRow/.test(client), '');
    // 现网新缺陷（0.5.169 装机后 modelscope 面板实拍）：一行 20 个中文 chip 被压成一列一字竖排。
    // 根因不是 chipRow 的 nowrap，而是 S.chip 自己没有拒绝压缩：flex 子项默认 flex-shrink:1，
    // 中文词的 min-content 只有一个字宽 ⇒ 空间不够就逐字折行。lobehub 的英文 slug 整词不可断，
    // 所以这条在 lobehub 上看不出来——判据必须真跑样式函数，光看 chipRow 是抓不到的。
    // 语义锁：chip 样式体用 blockEnd 按花括号深度切，不再用 {0,600}? 惰性窗
    // （注释一插就截断，截断后的半截还会让 new Function 抛在夹具里）。
    const CHIP_ANCHOR = 'chip: (active) => ({';
    const chipStart = clientLines.findIndex((l) => l.includes(CHIP_ANCHOR));
    const chipEnd = chipStart < 0 ? -1 : blockEnd(client, chipStart, 'S.chip');
    const chipStyleSrc = chipStart >= 0 && chipEnd > chipStart ? clientLines.slice(chipStart, chipEnd + 1).join(NL) : '';
    check('S.chip 样式体可被真跑取到（不复制实现）', countHits(client, CHIP_ANCHOR) === 1 && /\}\),?$/.test(chipStyleSrc.trimEnd()) && /padding: '4px 10px'/.test(chipStyleSrc), chipStyleSrc.slice(0, 90));
    const chipStyleFn = (() => {
        // 切片尾部带对象字面量后的逗号，必须剥掉再求值；剥完仍是「(active) => ({...})」一个箭头函数。
        try { return new Function('return (' + chipStyleSrc.replace('chip: ', '').replace(/,\s*$/, '') + ');')(); }
        catch (e) { return { err: String((e && e.message) || e) }; }
    })();
    check('chip 样式函数真跑出不抛（取到的是箭头函数本身，不是结果对象）',
        typeof chipStyleFn === 'function', JSON.stringify(chipStyleFn && chipStyleFn.err));
    // 自由量纪律（本会话踩过 CAT_TAIL_LABEL / splitBuckets 漏绑直接 ReferenceError）：
    // 重取切片后若样式体引用了新自由量，这里调用一次就会暴露，而不是留到后面的断言里炸。
    const chipFreeVarProbe = (() => {
        try { chipStyleFn(false); return ''; } catch (e) { return String((e && e.message) || e); }
    })();
    check('chip 夹具自由量集合不变（调用一次不抛，只需参数 active）',
        typeof chipStyleFn === 'function' && chipFreeVarProbe === '', chipFreeVarProbe.slice(0, 120));
    const chipStyle = typeof chipStyleFn === 'function' ? chipStyleFn(false) : chipStyleFn;
    check('chip 拒绝压缩折行（whiteSpace nowrap + flexShrink 0：中文分类名一列一字=现网缺陷）',
        chipStyle.whiteSpace === 'nowrap' && chipStyle.flexShrink === 0, JSON.stringify({ ws: chipStyle.whiteSpace, fs: chipStyle.flexShrink }));
    check('展开态 chip 行限高并内部纵向滚动（m19004：246 类不再铺满半屏）',
        /catsRow: \{[^\n]*maxHeight: 116[^\n]*overflowY: 'auto'/.test(client), (client.split(NL).find((l) => l.includes('catsRow:')) || '(none)').trim().slice(0, 160));
    check('foldChips 外露 tail（合并集合可点的前提；旧实现只给 covers 不给行）',
        Array.isArray(runFold.tail) && runFold.tail.length === tail.length &&
        runFold.tail.every((c) => c && c.value && c.value !== otherSlug),
        JSON.stringify({ tail: runFold.tail && runFold.tail.length, covers: runFold.other && runFold.other.covers.length }));
    check('未点名 chip 仍带各自上游真条数（展开态不靠合计糊弄）',
        Array.isArray(runFold.tail) && runFold.tail.reduce((n, c) => n + (Number(c.totalAll) || 0), 0) === tailTotal,
        JSON.stringify({ tailTotal }));
    check('0.5.164/0.5.165 的中间量 chipSlugs / chipBySlug / chipWindow 不再是无人消费的死声明',
        !/const chipSlugs =/.test(client) && !/const chipBySlug =/.test(client) && !/const chipWindow =/.test(client),
        'chipSlugs=' + /const chipSlugs =/.test(client) + ' chipBySlug=' + /const chipBySlug =/.test(client) + ' chipWindow=' + /const chipWindow =/.test(client));
}


console.log('');

console.log('');
console.log('Test 9: 平台分支自证（零假绿 / 零 spawn 痕迹）');
{
    // 非 win32 分支必须一条夹具断言都没执行、PATH 从未被指向假 npx、SHIM 里除夹具自身
    // 文件之外没有任何 argv/stdout 落盘（那些文件只有真 spawn 过才会生成）。
    // 注意 leftovers 用 readdirSync 实读目录：目录不存在时视作零落盘（未 spawn 的正确形态），
    // 不能把「读不到」算成痕迹——CI 上第一次就是这么误判的（本断言自身写错，已改测试侧）。
    const leftovers = (() => {
        let names = null;
        try { names = readdirSync(SHIM); } catch (e) { return []; }
        return names.filter((f) => !/^cli\.cjs$|^npx\.cmd$/.test(f));
    })();
    check('平台分支自证：win32 跑过夹具 / 非 win32 零 spawn 痕迹',
        IS_WIN ? shimPathApplied > 0 && fixtureChecksRun === 22 : (shimPathApplied === 0 && fixtureChecksRun === 0 && leftovers.length === 0),
        JSON.stringify({ IS_WIN, platform: process.platform, shimPathApplied, fixtureChecksRun, leftovers }));
}
releaseShim();
check('假 npx 夹具未污染真实 PATH（判据跑完必须还原）', process.env.PATH === savedPath, (process.env.PATH || '').slice(0, 80));
const { rmSync } = await import('node:fs');
try { rmSync(SHIM, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log('[FIXTURE] 夹具分支内实际执行断言=' + fixtureChecksRun + '（IS_WIN=' + IS_WIN + '；非 win32 必须为 0，否则即假绿）');
console.log('[PLATFORM] process.platform=' + process.platform + ' DSH_LH_WIN_ONLY=' + (process.env.DSH_LH_WIN_ONLY || '(unset)') + ' SKIP点名=' + skipped);
console.log(passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));

console.log('');
process.exit(failed ? 1 : 0);
