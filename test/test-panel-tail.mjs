#!/usr/bin/env node
// 0.5.177 面板「其他」（未列出的分类合并入口）逐类取数消费侧判据。
// 契约 C1-C6 字段名逐字对齐服务端（src/sources.js tail 通路）；本套只测 client.js 消费侧，
// 假服务端在测试内注入 meta.tail（不碰任何服务端文件）。全部判据从 client.js 真抽真跑，不复制实现。
// 行尾纪律（0.5.176 CI 红教训）：本文件只按 /\r?\n/ 读入 client.js，绝不对其行尾形态做任何断言。
// ⚠ 本套件会真写生产文件：H 段（B2 变异自证）把变异字节直接写进 ../client.js，跑完再从内存 PRISTINE
//   （:15 读入的原始字节）逐字节还原。⇒ 运行期间不得同时有人编辑 client.js，也不得并发跑本套
//   （两进程互踩 = 双双拿到假读数，且可能把对方的内容当自己的还原）。H 段用 safeTempDir() 下的
//   独占锁文件 dsh-panel-tail.mut.lock 自证：拿不到锁就显式判红并一次都不写盘。
//   run-gate 侧靠 DSH_GATE_PARALLEL 未设 ⇒ limit=1 串行；手工并行请自己避让。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { safeTempDir } from "../src/home.js";

const NL = String.fromCharCode(10);
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "..", "client.js");
// 独占锁必须在读 client.js 之前拿：先锁后读，才能保证 PRISTINE 与 A-G 段读到的同一份内容没有别的进程在写。
// 拿不到锁仍继续判据（显式判红、一次都不写盘），但末尾多一条污染自检。
const LOCK = join(safeTempDir(), "dsh-panel-tail.mut.lock");
let locked = false;
let LOCK_WHY = "";
let WRITE_ATTEMPTS = 0;
const tryLock = () => {
  const body = JSON.stringify({ pid: process.pid, at: Date.now(), client: CLIENT });
  try { writeFileSync(LOCK, body, { flag: "wx" }); return true; } catch (e) {
    let holder = null;
    try { holder = JSON.parse(readFileSync(LOCK, "utf8")); } catch { }
    let alive = false;
    if (holder && holder.pid && holder.pid !== process.pid) { try { process.kill(holder.pid, 0); alive = true; } catch { alive = false; } }
    if (alive) { LOCK_WHY = "held by pid " + holder.pid + " (self=" + process.pid + ")"; return false; }
    try { rmSync(LOCK, { force: true }); writeFileSync(LOCK, body, { flag: "wx" }); return true; } catch (e2) { LOCK_WHY = "stale takeover failed: " + String(e2 && e2.message); return false; }
  }
};
locked = tryLock();
const raw = readFileSync(CLIENT, "utf8");
const PRISTINE = Buffer.from(readFileSync(CLIENT));

let passed = 0, failed = 0;
const REDS = [];
const SECT_WANT = { A: 11, B: 12, C: 12, D: 9, E: 20, F: 3, G: 7, H: 8 }; // 0.5.183: D 段随 tailNote IIFE 化 + 白话文案重排为 9 条判据
const SECT_GOT = {};
let CURSECT = null;
const check = (n, cond, d) => { if (CURSECT) SECT_GOT[CURSECT] = (SECT_GOT[CURSECT] || 0) + 1; if (cond) { passed += 1; console.log("  PASS " + n); } else { failed += 1; REDS.push(n); console.log("  FAIL " + n + (d ? "  [" + String(d).slice(0, 170) + "]" : "")); } };
const canon = (o) => { const ks = Object.keys(o || {}).sort(); const out = {}; for (const k of ks) out[k] = o[k]; return JSON.stringify(out); };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const lastOf = (a) => (a && a.length ? a[a.length - 1] : undefined);
const quoted = (ls, name) => {
  const l = ls.find((x) => x.includes("const " + name + " = "));
  if (!l) return "";
  const i = l.indexOf("= ");
  return String(l.slice(i + 2)).trim().replace(/[;,]\s*$/, "").slice(1, -1);
};

// ── 抽取装置：任何一份 client.js 源码文本都能装配出可跑的 harvest 消费者 ──
const makeKit = (src) => {
  const ls = src.split(/\r?\n/);
  const iStart = ls.findIndex((l) => l.includes("渐进式加载（harvest）消费者"));
  const iEnd = ls.findIndex((l) => l.includes("const TOOL_BATCH = 60;"));
  const sIdx = ls.findIndex((l) => l.includes("const searchSkills = useCallback(async (text, options) => {"));
  const eIdx = ls.findIndex((l, k) => k > sIdx && l.trim() === "}, [sort, liveRef, source, size]);");
  const located = iStart > 0 && iEnd > iStart && sIdx > 0 && eIdx > sIdx;
  const cb = (name) => {
    const i = ls.findIndex((l) => l.includes("const " + name + " = ("));
    if (i < 0) return null;
    const out = [];
    for (let k = i; k < ls.length; k += 1) {
      out.push(ls[k]);
      if (k > i && ls[k].startsWith("    ") && (ls[k].trim() === "}" || ls[k].trim() === "};")) break;
    }
    return out.join(NL);
  };
  const tsrc = cb("trustedTotal");
  const ssrc = cb("shouldSkipInflight");
  const bodyOfFn = (needle) => {
    const i = ls.findIndex((l) => l.includes(needle));
    if (i < 0) return null;
    const out = [];
    for (let k = i; k < ls.length; k += 1) {
      out.push(ls[k]);
      if (ls[k].trim().endsWith("}")) break;
    }
    return out.join(NL);
  };
  const tailNoteSrc = (() => {
    const i = ls.findIndex((l) => l.includes("const tailNote = "));
    if (i < 0) return null;
    const out = [String(ls[i]).slice(String(ls[i]).indexOf("const tailNote = "))];
    // 0.5.183：tailNote 改自包含 IIFE（带嵌套 {}）后，旧「行尾 ); 即断」启发式会把中间 const C = Math.max(0, ...) 的 ); 误当语句尾⇒截断⇒new Function 抛 Unexpected end of input。改花括号深度匹配：深度回 0 且行尾 ; 才是真语句尾。
    let depth = 0;
    const scanDepth = (str) => { for (let c = 0; c < String(str).length; c += 1) { const ch = String(str).charAt(c); if (ch === "{") depth += 1; else if (ch === "}") depth -= 1; } };
    scanDepth(out[0]);
    for (let k = i + 1; k < ls.length; k += 1) {
      const L = String(ls[k]);
      out.push(L);
      scanDepth(L);
      if (depth === 0 && L.trim().endsWith(";")) break;
    }
    return out.join(NL);
  })();
  const renderSrc = (() => {
    const i = ls.findIndex((l) => l.includes("chipEntries.map((chip) =>"));
    if (i < 0) return null;
    for (let k = i + 1; k < ls.length; k += 1) if (ls[k].trim() === "})") return ls.slice(i, k + 1).join(NL);
    return null;
  })();
  return {
    ls, located, tailNoteSrc, renderSrc,
    islandText: located ? ls.slice(iStart, iEnd).join(NL) : "",
    bodyText: located ? ls.slice(sIdx + 1, eIdx).join(NL) : "",
    labelBody: bodyOfFn("function categoryLabelLite("),
    trustedTotal: tsrc ? new Function(tsrc + NL + "return trustedTotal;")() : (r) => r,
    shouldSkipInflight: ssrc ? new Function(ssrc + NL + "return shouldSkipInflight;")() : () => false,
    LABEL: quoted(ls, "CAT_TAIL_LABEL"),
    OTHER: quoted(ls, "CAT_OTHER"),
    COLLAPSE: quoted(ls, "CATS_COLLAPSE"),
  };
};
const KIT = makeKit(raw);

// ── 真跑装置：绑 P1 三量（panel-harvest 的固定 deps 清单不含它们，生产码靠 typeof 守卫回落） ──
const buildRunner = (kit) => new Function("deps", "extra", "trustedTotal", "shouldSkipInflight",
  kit.islandText + NL +
  "const harvestCtlRef = extra.harvestCtlRef;" + NL +
  "return async (text, options) => {" + NL +
  "  const { liveRef, resultCacheRef, reqSeqRef, size, sort, call, setSkills, setSkillsPage," +
  "    setSkillsTotalPages, setSkillsTotal, setSkillsHasMore, setServerFacet, setNotice, setError, setBusy," +
  "    skillCacheKey, resolvePageSize, inflightRef, shouldSkipInflight, trustedTotal, totalBaseRef, CAT_OTHER," +
  "    tailCoversRef, tailStateRef, CAT_TAIL_LABEL } = deps;" +
  "  const { keepSortForForm } = extra;" + NL + kit.bodyText + NL + "};");

const keyOf = (r) => (r && (r.slug || r.id || "?")) + (r && r.installed ? "*" : "");
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((res, rej) => setTimeout(() => rej(new Error("timeout " + label)), ms))]);

// 夹具：tail 态下行内**可能没有 category 字段**（K3），这正是本地再筛会错杀的形状。
const K1 = { source: "clawhub", slug: "k-a", category: "ai", name: "K A", installed: false };
const K2 = { source: "clawhub", slug: "k-b", category: "office", name: "K B", installed: false };
const K3 = { source: "clawhub", slug: "k-c", name: "K C 行内无分类字段", installed: false };
const K4 = { source: "lobehub", slug: "k-d", category: "design", name: "K D", installed: false };
const META0 = { hints: [], degraded: [], sourceErrors: [] };
const TAIL1 = { categoriesTotal: 3, categoriesFetched: 1, categoriesFailed: 0, upstreamTotal: 900, windowed: true, retrievedTotal: 1 };
const TAIL2 = { categoriesTotal: 3, categoriesFetched: 2, categoriesFailed: 0, upstreamTotal: 900, windowed: true, retrievedTotal: 2 };
const TAILF = { categoriesTotal: 3, categoriesFetched: 2, categoriesFailed: 1, upstreamTotal: 940, windowed: true, retrievedTotal: 4 };
const TAILNF = { categoriesTotal: 3, categoriesFetched: 3, categoriesFailed: 0, upstreamTotal: 512, windowed: false, retrievedTotal: 4 };
const pkgTail = (rows, tail, m) => ({ rows, meta: Object.assign({}, META0, tail ? { tail } : {}, m || {}) });
const pkgFinal = (rows, tail, m) => Object.assign({}, pkgTail(rows, tail, Object.assign({ total: rows.length, pages: 1, hasMore: false, serverFacet: false }, m || {})), { final: true });
const COVERS = ["ai", "office", "design"];
const planTail = { start: Object.assign({ id: "h1" }, pkgTail([K1], TAIL1)), polls: [pkgTail([K2], TAIL2), pkgFinal([K1, K2, K3, K4], TAILF)] };
const planPlain = { start: Object.assign({ id: "h2" }, pkgTail([K1], null)), polls: [pkgTail([K2], null), pkgFinal([K1, K2, K3, K4], null, { total: 361758, pages: 15074, hasMore: true })] };
const SEARCH_OK = { items: [{ id: "b1" }, { id: "b2" }], pages: 1, total: 2, hasMore: false, hints: [], degraded: [], sourceErrors: [] };

const makeEnv = (kit, plan, opts) => {
  opts = opts || {};
  const ctl = opts.noHarvest ? null : { current: { timer: null, wake: null, token: null } };
  const resultCacheRef = { current: opts.cache || {} };
  const reqSeqRef = { current: 0 };
  const totalBaseRef = { current: opts.totalBase || {} };
  const inflightRef = { current: new Set() };
  const tailCoversRef = { current: opts.tailCovers === undefined ? null : opts.tailCovers };
  const tailStateRef = { current: opts.tailState === undefined ? null : opts.tailState };
  const logs = { skills: [], busy: [], notice: [], error: [], page: [], totalPages: [], total: [], hasMore: [], serverFacet: [] };
  const ops = [];
  const bodies = [];
  let pollCount = 0;
  let curSkills = [];
  const planFor = (p) => (plan && plan.for ? plan.for(p || {}) : plan);
  const call = async (op, p) => {
    ops.push(op);
    bodies.push({ op, p: JSON.parse(JSON.stringify(p || {})) });
    const pl = planFor(p || {});
    if (op === "harvest.start") {
      if (pl && pl.startThrow) throw new Error(pl.startThrow);
      if (pl && pl.startOkFalse) return { ok: false, error: "该 harvest 会话不存在或已过期，请改用 skills.search" };
      return pl ? pl.start : undefined;
    }
    if (op === "harvest.poll") {
      const i = pollCount; pollCount += 1;
      if (pl && pl.start && pl.start.id !== undefined && (!p || p.id !== pl.start.id)) return { ok: false, error: "bad id" };
      const r = pl && pl.polls ? pl.polls[i] : undefined;
      return r !== undefined ? r : { rows: [], meta: {}, done: false };
    }
    if (op === "skills.search") return pl ? pl.search : undefined;
    throw new Error("unknown operation " + op);
  };
  const run = buildRunner(kit)({
    liveRef: { current: { source: opts.src || "clawhub", category: opts.category === undefined ? "all" : opts.category, sortCaps: { skills: { clawhub: { browse: ["downloadCount", "stars"], search: ["downloadCount", "stars"] } } } } },
    resultCacheRef, reqSeqRef, totalBaseRef, inflightRef,
    size: 24, sort: "default", call,
    setSkills: (v) => { curSkills = typeof v === "function" ? v(curSkills) : v; logs.skills.push((curSkills || []).map(keyOf)); },
    setSkillsPage: (v) => logs.page.push(v),
    setSkillsTotalPages: (v) => logs.totalPages.push(v),
    setSkillsTotal: (v) => logs.total.push(v),
    setSkillsHasMore: (v) => logs.hasMore.push(v),
    setServerFacet: (v) => logs.serverFacet.push(v),
    setNotice: (v) => logs.notice.push(v),
    setError: (v) => logs.error.push(v),
    setBusy: (v) => logs.busy.push(v),
    skillCacheKey: (o) => ["sk", o.source, o.query || "", o.category === "all" ? "" : (o.category || ""), o.page, o.size, o.sort || ""].join("|"),
    resolvePageSize: (o, s) => (o && o.size) || s,
    shouldSkipInflight: kit.shouldSkipInflight,
    trustedTotal: kit.trustedTotal,
    CAT_OTHER: kit.OTHER,
    tailCoversRef, tailStateRef, CAT_TAIL_LABEL: kit.LABEL,
  }, { keepSortForForm: (s) => s, harvestCtlRef: ctl }, kit.trustedTotal, kit.shouldSkipInflight);
  return { run, logs, ops, bodies, ctl, resultCacheRef, tailCoversRef, tailStateRef, reqSeqRef, totalBaseRef, inflightRef, pollCount: () => pollCount };
};

const drive = async (label, kit, plan, opts) => {
  const e = makeEnv(kit, plan, opts);
  e.thrown = "";
  try { await withTimeout(e.run("pdf", (opts && opts.arg) || {}), 6000, label); } catch (err) { e.thrown = String((err && err.message) || err); }
  return e;
};

// ── A. 静态锁（C1 形状 / 计数锁 / N1 改名 / 旧词零硬编码） ──
CURSECT = "A";
check("N1 client.js 零旧词「翻页才会取回更多」（尾会话收口后翻页已是本地真分页，再说这句就是谎）", KIT.ls.filter((l) => String(l).indexOf(String(0x7ffb) + String(0x9875) + String(0x624d) + String(0x4f1a) + String(0x53d6) + String(0x56de) + String(0x66f4) + String(0x591a)) >= 0).length === 0, JSON.stringify(KIT.ls.map((l, i) => [i + 1, String(l).trim().slice(0, 70)]).filter((x2) => String(x2[1]).length > 0 && x2[1].indexOf(String.fromCharCode(0x7ffb, 0x9875, 0x624d, 0x4f1a, 0x53d6, 0x56de, 0x66f4, 0x591a)) >= 0)));
check("A 装置定位成功（island 与 searchSkills 体都能抽出来）", KIT.located && !!KIT.islandText && !!KIT.bodyText, "located=" + KIT.located);
check("N1 CAT_TAIL_LABEL 恰好是「其他」（用户 m23543/m23544 定名，代码引用常量）", KIT.LABEL === "其他", "LABEL=" + KIT.LABEL);
check("C1/P1 island 的 harvest.start 体内有 tailCategories 条件展开", KIT.islandText.includes("...(env.tailCovers ? { tailCategories: env.tailCovers } : {}),"), "(spread missing)");
check("G2 island 的 category 归一行原文在场（upstreamCat 降级未被动过）", KIT.islandText.includes("category: env.upstreamCat === 'all' ? '' : env.upstreamCat,"), "(locked line missing)");
const stTimeout = (KIT.islandText.match(/setTimeout\(/g) || []).length;
const stClear = (KIT.islandText.match(/clearTimeout\(/g) || []).length;
const stFinal = (KIT.islandText.match(/pkg\.final === true/g) || []).length;
check("G3 轮询计数锁未破（setTimeout 1 / clearTimeout 1 / pkg.final 2）", stTimeout === 1 && stClear === 1 && stFinal === 2, JSON.stringify([stTimeout, stClear, stFinal]));
check("P1 一次性 skills.search 分支体不含 tailCategories（C6 逐字段不变）", (() => {
  const i = KIT.bodyText.indexOf("const d = await call('skills.search'");
  if (i < 0) return false;
  const j = KIT.bodyText.indexOf("});", i);
  return KIT.bodyText.slice(i, j).indexOf("tailCategories") < 0;
})(), "(one-shot body polluted)");
check("G2 searchSkills 体保留 upstreamCat 映射行", KIT.bodyText.includes("const upstreamCat = cat === CAT_OTHER ? 'all' : cat;"), "(mapping line gone)");
const codeWindowHits = KIT.ls.filter((l) => {
  const t = String(l).trim();
  if (t.indexOf("//") === 0 || t.indexOf("*") === 0) return false;
  const q = t.replace(/\/\*.*?\*\//g, "");
  return q.indexOf("'") >= 0 || q.indexOf('"') >= 0 || q.indexOf(String.fromCharCode(96)) >= 0;
}).filter((l) => l.indexOf("窗外") >= 0);
check("N1 用户可见文案零硬编码「窗外」（改名后带引号的行不含旧词）", codeWindowHits.length === 0, JSON.stringify(codeWindowHits.map((x) => x.trim().slice(0, 70))));
check("N1 client.js 零「窗内之外」（该字面只有合并入口 title 与兜底说明行在用，任一处回退即红）", KIT.ls.filter((l) => String(l).indexOf('窗内之外') >= 0).length === 0, JSON.stringify(KIT.ls.map((l, i) => [i + 1, String(l).trim().slice(0, 70)]).filter((x) => String(x[1]).indexOf('窗内之外') >= 0)));
check("N1 合并入口 title 锚唯一（client.js 恰 1 处 title: '未列出的分类还有 '，与兜底说明行互不顶替）", KIT.ls.filter((l) => String(l).indexOf("title: '未列出的分类还有 '") >= 0).length === 1, 'count=' + KIT.ls.filter((l) => String(l).indexOf("title: '未列出的分类还有 '") >= 0).length);

// ── B. 真跑 harvest 消费者：P1 下发 / P2 进度 / P4 收口口径 / G2 防线 ──
CURSECT = "B";
const startBody = (e) => (e.bodies.find((b) => b.op === 'harvest.start') || {}).p || {};
const searchBodies = (e) => e.bodies.filter((b) => b.op === 'skills.search').map((b) => b.p);

const eT = await drive('tail', KIT, planTail, { category: KIT.OTHER, tailCovers: COVERS.slice() });
check("P1 合并态 harvest.start body.tailCategories 恰为 covers（逐字 C1）", canon(startBody(eT).tailCategories) === canon(COVERS), canon(startBody(eT).tailCategories));
check("P1 合并态六参齐全且同旧口径（query/source/category/page/pageSize/sort）", canon(Object.assign({}, startBody(eT), { tailCategories: undefined })) === canon({ query: 'pdf', source: 'clawhub', category: '', page: 1, pageSize: 24, sort: 'installCount' }), canon(startBody(eT)));
check("0.5.183 P2 中间包一行「陆续加载中，已到达 1 条，还有 900 条在途」（S1 锁不回归 + 在途数）", eT.logs.notice.length >= 2 && String(eT.logs.notice[0]).indexOf('陆续加载中，已到达 1 条') >= 0 && String(eT.logs.notice[0]).indexOf('还有 900 条在途') >= 0, JSON.stringify(eT.logs.notice));
check("0.5.183 P2 第二个中间包已到达 2 条、还有 900 条在途", String(eT.logs.notice[1]).indexOf('已到达 2 条') >= 0 && String(eT.logs.notice[1]).indexOf('还有 900 条在途') >= 0, JSON.stringify(eT.logs.notice));
check("0.5.183 P2 加载态一行白话（旧逐类进度「已取回 N/M 类」退场，零「窗外」词）", String(eT.logs.notice[0]).indexOf('陆续加载中') >= 0 && String(eT.logs.notice[0]).indexOf('已取回') < 0 && String(eT.logs.notice[0]).indexOf('窗外') < 0, String(eT.logs.notice[0]));
check("P4 final 落数是尾口径（total/pages/hasMore/serverFacet 来自收口包）", lastOf(eT.logs.total) === 4 && lastOf(eT.logs.totalPages) === 1 && lastOf(eT.logs.hasMore) === false && lastOf(eT.logs.serverFacet) === false, JSON.stringify([eT.logs.total, eT.logs.totalPages, eT.logs.hasMore, eT.logs.serverFacet]));
const keyT = 'sk|clawhub|pdf|' + KIT.OTHER + '|1|24|installCount';
const crecT = eT.resultCacheRef.current[keyT] || {};
check("P4 resultCache 写在合并态同一 cacheKey（G4 键规则未改）", Object.prototype.hasOwnProperty.call(eT.resultCacheRef.current, keyT), Object.keys(eT.resultCacheRef.current).join(','));
check("P4 cache 记录 tail 逐字等于收口包 meta.tail", canon(crecT.tail) === canon(TAILF), canon(crecT.tail));
check("P4 cache 记录 total/pages 是尾口径不是整源", crecT.total === 4 && crecT.pages === 1 && crecT.serverFacet === false, JSON.stringify([crecT.total, crecT.pages, crecT.serverFacet]));
check("P4 tailStateRef 收口写入 tail 声明（会话内 memo）", !!eT.tailStateRef.current && eT.tailStateRef.current.cat === KIT.OTHER && canon(eT.tailStateRef.current.tail) === canon(TAILF), JSON.stringify(eT.tailStateRef.current));
check("G2 合并态全程 category 绝不下发 __cat_other", [startBody(eT)].concat(searchBodies(eT)).every((p) => p.category !== KIT.OTHER), JSON.stringify([startBody(eT).category, searchBodies(eT).map((p) => p.category)]));
check("P1 合并态零 skills.search（未误回落）", eT.ops.indexOf('skills.search') < 0 && eT.ops[0] === 'harvest.start', eT.ops.join(','));

// ── C. P1 反向：tailCategories 绝不出现在不该出现的通路 ──
CURSECT = "C";
const eN = await drive('normal', KIT, planTail, { category: 'all', tailCovers: COVERS.slice() });
check("P1 全部分类态 body 逐键与旧口径一致（无 tailCategories 键）", !has(startBody(eN), 'tailCategories') && canon(startBody(eN)) === canon({ query: 'pdf', source: 'clawhub', category: '', page: 1, pageSize: 24, sort: 'installCount' }), canon(startBody(eN)));
const eC = await drive('cat', KIT, planTail, { category: 'ai', tailCovers: COVERS.slice(), src: 'clawhub' });
check("P1 普通分类态 body 无 tailCategories 且 category 原样下发", !has(startBody(eC), 'tailCategories') && startBody(eC).category === 'ai', canon(startBody(eC)));
const eE1 = await drive('empty-covers', KIT, planTail, { category: KIT.OTHER, tailCovers: [] });
check("P1 合并态但 covers 为空数组 ⇒ 无 tailCategories 键", !has(startBody(eE1), 'tailCategories'), canon(startBody(eE1)));
const eE2 = await drive('null-covers', KIT, planTail, { category: KIT.OTHER, tailCovers: null });
check("P1 合并态但 coversRef 为 null ⇒ 无 tailCategories 键（covers 为空/无合并入口）", !has(startBody(eE2), 'tailCategories'), canon(startBody(eE2)));
const ckLocal = 'sk|clawhub|pdf|' + KIT.OTHER + '|1|2|installCount';
const ePB = await drive('local-page', KIT, { search: SEARCH_OK }, { category: KIT.OTHER, tailCovers: COVERS.slice(), arg: { page: 2, size: 2 }, cache: { [ckLocal]: { items: [K1, K2, K3, K4], pages: 2, total: 4, hasMore: false, serverFacet: false, hints: [], sourceErrors: [], degraded: [], tail: TAILF, wholeView: true } } });
check("P1 尾会话收口后翻页零 RPC（既不打 skills.search，也不开新 harvest）", ePB.ops.length === 0, ePB.ops.join(','));
check("P1 翻页渲染本地第 2 页切片、页数按已取回行集算、tail 声明不被清", (lastOf(ePB.logs.skills) || []).join(',') === 'k-c,k-d' && lastOf(ePB.logs.page) === 2 && lastOf(ePB.logs.totalPages) === 2 && lastOf(ePB.logs.total) === 4 && lastOf(ePB.logs.hasMore) === false && !!ePB.tailStateRef.current && canon(ePB.tailStateRef.current.tail) === canon(TAILF), JSON.stringify([lastOf(ePB.logs.skills), lastOf(ePB.logs.page), lastOf(ePB.logs.totalPages), lastOf(ePB.logs.total), ePB.tailStateRef.current]));
const eP2 = await drive('page2-nostore', KIT, { search: SEARCH_OK }, { category: KIT.OTHER, tailCovers: COVERS.slice(), arg: { page: 2 } });
check("P1 未收口（缓存里没有 wholeView 整集）⇒ 翻页仍走一次性通路且 body 无 tailCategories", eP2.ops.join(',') === 'skills.search' && searchBodies(eP2).every((p) => !has(p, 'tailCategories')) && canon(searchBodies(eP2)[0] || {}) === canon({ query: 'pdf', source: 'clawhub', category: '', page: 2, pageSize: 24, sort: 'installCount' }), eP2.ops.join(',') + ' ' + canon(searchBodies(eP2)[0] || {}));
const eAP = await drive('append', KIT, { search: SEARCH_OK }, { category: KIT.OTHER, tailCovers: COVERS.slice(), arg: { append: true } });
check("P1 append 追加态零 harvest 且 body 无 tailCategories", eAP.ops.join(',') === 'skills.search' && searchBodies(eAP).every((p) => !has(p, 'tailCategories')), eAP.ops.join(','));
const eFB = await drive('fallback', KIT, { startThrow: 'unknown operation "harvest.start"', search: SEARCH_OK }, { category: KIT.OTHER, tailCovers: COVERS.slice() });
check("P1 harvest 不可用回落：先按 C1 发出合并集合请求（body 带 tailCategories），再交回一次性通路", eFB.ops.join(',') === 'harvest.start,skills.search' && canon(startBody(eFB).tailCategories) === canon(COVERS), eFB.ops.join(',') + ' ' + canon(startBody(eFB)));
check("P1 回落后的一次性 skills.search body 无 tailCategories 且六参同旧口径（C6 逐字段不变）", searchBodies(eFB).every((p) => !has(p, 'tailCategories')) && canon(searchBodies(eFB)[0] || {}) === canon({ query: 'pdf', source: 'clawhub', category: '', page: 1, pageSize: 24, sort: 'installCount' }), canon(searchBodies(eFB)[0] || {}));
const eNoH = await drive('no-gate', KIT, { search: SEARCH_OK }, { noHarvest: true, category: KIT.OTHER, tailCovers: COVERS.slice() });
check("P1 harvest 门不可用（无 ctl）⇒ 一次性通路干净，无 tailCategories", eNoH.ops.join(',') === 'skills.search' && searchBodies(eNoH).every((p) => !has(p, 'tailCategories')), eNoH.ops.join(','));
const eCL = await drive('clamp', KIT, planTail, { category: KIT.OTHER, tailCovers: COVERS.concat(Array.from({ length: 500 }, (x, i) => 'c' + i)) });
check("C1 客户端侧夹上限 400（与服务端 normalizeTailCategories 同夹法）", Array.isArray(startBody(eCL).tailCategories) && startBody(eCL).tailCategories.length === 400, 'len=' + (startBody(eCL).tailCategories || []).length);

// ── D. P3 tailNote 三态（真抽 client 表达式，真跑） ──
CURSECT = "D";
const runNote = (kit, env) => new Function('category', 'CAT_OTHER', 'chipFold', 'tailMemo', 'skills', 'visibleSkills', 'serverFacet',
  String(kit.tailNoteSrc || '') + NL + 'return tailNote;')(
  env.category, kit.OTHER, env.chipFold, env.tailMemo, env.skills || [], env.visible || [], Boolean(env.serverFacet));
const CF = { other: { value: KIT.OTHER, label: KIT.LABEL, totalAll: 743, covers: COVERS.slice(), otherCount: 0 }, otherCount: 3, otherTotal: 743 };
check("D 装置：tailNote 表达式可抽出", !!KIT.tailNoteSrc && KIT.tailNoteSrc.indexOf('const tailNote = ') === 0, String(KIT.tailNoteSrc).slice(0, 80));
const nW = runNote(KIT, { category: KIT.OTHER, chipFold: CF, tailMemo: TAILF, skills: [K1, K2, K3, K4], visible: [K1, K2, K3, K4] });
check('0.5.183 P3 tail windowed 白话：共 940 + 本次取回 4 + 未取全 + 还有 1 类没取到（其中 1 类取数失败）+ 建议稍后重试', nW === '共 940 条，本次取回 4 条，未取全。还有 1 类没取到（其中 1 类取数失败）。建议：稍后重试。', nW);
check('0.5.183 P3 tail 态零旧词（上游合计/共约/不再联网取数/往后翻页/部分类可能取不全 一律不许）', nW.indexOf('上游合计') < 0 && nW.indexOf('共约') < 0 && nW.indexOf('不再联网取数') < 0 && nW.indexOf('往后翻页') < 0 && nW.indexOf('部分类可能取不全') < 0, nW);
const nF = runNote(KIT, { category: KIT.OTHER, chipFold: CF, tailMemo: TAILNF, skills: [K1, K2, K3, K4], visible: [K1, K2, K3, K4] });
check('0.5.183 P3 tail !windowed 且全取回（3/3 类、0 失败）⇒ 全部取到，不出提示语（恒空）', nF === '', nF);
const nO = runNote(KIT, { category: KIT.OTHER, chipFold: CF, tailMemo: null, skills: [K1, K2, K3, K4], visible: [K1, K2] });
check('0.5.183 P3 兜底态（本地筛源）白话：本次取回 4 + 未取全 + 还有 3 类没取到 + 建议稍后重试，绝不显示虚高总数', nO === '本次取回 4 条，未取全。还有 3 类没取到。建议：稍后重试。', nO);
check('0.5.183 P3 兜底态零旧词（上游合计/共约/不再联网取数/往后翻页/在列表中 一律不许）', nO.indexOf('上游合计') < 0 && nO.indexOf('共约') < 0 && nO.indexOf('不再联网取数') < 0 && nO.indexOf('往后翻页') < 0 && nO.indexOf('在列表中') < 0, nO);
const nO2 = runNote(KIT, { category: KIT.OTHER, chipFold: CF, tailMemo: null, skills: [K1, K2, K3, K4], visible: [K1, K2] });
check('0.5.183 P3 兜底态建议句在场（稍后重试）', nO2.indexOf('建议：稍后重试。') >= 0, nO2);
const nW2 = runNote(KIT, { category: KIT.OTHER, chipFold: CF, tailMemo: TAILF, skills: [K1, K2, K3, K4], visible: [K1, K2, K3, K4] });
check('0.5.183 P3 tail 态与兜底态并存：tail 态报「共 940 条」，兜底态不报总数（两者都无 不再联网取数/往后翻页）', nW2.indexOf('共 940 条') >= 0 && nO2.indexOf('共 940 条') < 0 && nW2.indexOf('不再联网取数') < 0 && nO2.indexOf('不再联网取数') < 0, nW2 + ' | ' + nO2);
check('P3 非合并态 tailNote 恒空', runNote(KIT, { category: 'ai', chipFold: CF, tailMemo: TAILF }) === '' && runNote(KIT, { category: KIT.OTHER, chipFold: { other: null, otherCount: 0, otherTotal: 0 }, tailMemo: TAILF }) === '', 'not empty');

// ── E. P5 谓词真跑 + P6 整源数字不复用 + 缓存续命 ──
CURSECT = "E";
const vline = (kit) => String((kit.ls.find((l) => l.includes('const visibleSkills = orderedSkills.filter')) || ''));
const runVisible = (kit, item, env) => {
  const v = vline(kit);
  const ARROW = String.fromCharCode(61, 62);
  const inner = v.slice(v.indexOf('.filter(') + 8, v.lastIndexOf(')'));
  const body = inner.slice(inner.indexOf(ARROW) + 2).trim();
  return new Function('item', 'serverFacet', 'category', 'CAT_OTHER', 'chipFold', 'return (' + body + ');')(item, Boolean(env.serverFacet), env.category, kit.OTHER, env.chipFold);
};
const CF5 = (declared) => ({ other: { value: KIT.OTHER, label: KIT.LABEL, totalAll: 743, covers: COVERS.slice(), tailDeclared: declared }, otherCount: 3 });
check("E 装置：visibleSkills 行抽出且含 covers/serverFacet", vline(KIT).indexOf('covers.indexOf') >= 0 && vline(KIT).indexOf('serverFacet') >= 0, vline(KIT).trim().slice(0, 90));
check("P5 tail 声明态：行内无 category 的行不再被错杀", runVisible(KIT, K3, { category: KIT.OTHER, chipFold: CF5(true) }) === true, 'K3 filtered in declared state');
check("P5 tail 声明态：covers 之外的成功行也放行（服务端已逐类取数）", runVisible(KIT, { source: 'clawhub', slug: 'k-x', category: 'unlisted-in-covers' }, { category: KIT.OTHER, chipFold: CF5(true) }) === true, 'foreign row filtered in declared state');
check("P5 未声明态（旧服务端）：无 category 行仍不算成员（宁缺毋滥未回归）", runVisible(KIT, K3, { category: KIT.OTHER, chipFold: CF5(false) }) === false, 'K3 leaked in fallback state');
check("P5 未声明态：covers 外分类仍被筛掉", runVisible(KIT, { source: 'clawhub', slug: 'k-x', category: '开发工具' }, { category: KIT.OTHER, chipFold: CF5(false) }) === false, 'foreign row leaked');
check("P5 未声明态：covers 内分类保留（兜底筛仍生效）", runVisible(KIT, K1, { category: KIT.OTHER, chipFold: CF5(false) }) === true && runVisible(KIT, K4, { category: KIT.OTHER, chipFold: CF5(false) }) === true, 'covers member dropped');
check("P5 声明态不得被 serverFacet 短路成整页（facet 只作用在非合并集合分支）", vline(KIT).indexOf('tailDeclared') < vline(KIT).indexOf(' : serverFacet ||'), 'branch order moved');
check("P6 final 收口按已取回行集切片上屏（island 有 wholeView 切片调用点）", KIT.islandText.includes('d.setSkills(wholeView ? harvestSliceOf(rows, env.pageSize, env.pageNo) : rows);'), '(slice call missing)');
check("P6 final 总页数按已取回行集算（island 有 harvestPagesOf 调用点）", KIT.islandText.includes('harvestPagesOf(rows.length, env.pageSize)'), '(pagesOf call missing)');
check("P1 searchSkills 体有尾会话本地翻页分支且走 typeof 防御", KIT.bodyText.includes("typeof harvestSliceOf === 'function'") && KIT.bodyText.includes('wholeView'), '(local-page branch missing)');
const staleKey = KIT.OTHER + '|clawhub|pdf|installCount|24';
const staleViewKey = 'clawhub|pdf|' + KIT.OTHER + '|installCount|24';
const eP6 = await drive('stale-total', KIT, planTail, { category: KIT.OTHER, tailCovers: COVERS.slice(), totalBase: { [staleViewKey]: 361758 } });
check("P6 合并集合收口绝不回落到整源旧数（361758 不得上屏）", lastOf(eP6.logs.total) === 4 && eP6.logs.total.every((v) => v !== 361758), JSON.stringify(eP6.logs.total));
check("P6 合并集合收口 pages/hasMore 是尾口径（不是 ceil(upstreamTotal/size)）", lastOf(eP6.logs.totalPages) === 1 && lastOf(eP6.logs.hasMore) === false && lastOf(eP6.logs.serverFacet) === false, JSON.stringify([lastOf(eP6.logs.totalPages), lastOf(eP6.logs.hasMore), lastOf(eP6.logs.serverFacet)]));
const ePT = await drive('plain-final', KIT, planPlain, { category: KIT.OTHER, tailCovers: COVERS.slice() });
const crecPT = ePT.resultCacheRef.current['sk|clawhub|pdf|' + KIT.OTHER + '|1|24|installCount'] || {};
check("旧服务端（meta 无 tail）收口 ⇒ 声明为空，P5/P3 走兜底态", (ePT.tailStateRef.current || {}).tail == null && crecPT.tail == null, JSON.stringify([ePT.tailStateRef.current, crecPT.tail]));
const ePL = await drive('plain-notice', KIT, planPlain, { category: KIT.OTHER, tailCovers: COVERS.slice() });
check("旧服务端中间包仍是原文案（陆续加载中 + 已到达 N 条，无假逐类进度）", String(ePL.logs.notice[0]).indexOf('陆续加载中，已到达 1 条') >= 0 && String(ePL.logs.notice[0]).indexOf('类，') < 0, JSON.stringify(ePL.logs.notice));
const ck = 'sk|clawhub|pdf|' + KIT.OTHER + '|1|24|installCount';
const eSL = await drive('slice', KIT, planTail, { category: KIT.OTHER, tailCovers: COVERS.slice(), arg: { size: 2 } });
check("P6 每页 2 条时 final 只上屏第 1 页两行（不再整表灌屏=虚构页码）", (lastOf(eSL.logs.skills) || []).join(',') === 'k-a,k-b', JSON.stringify(lastOf(eSL.logs.skills)));
check("P6 每页 2 条时总页数=ceil(4/2)=2、总数仍是已取回 4 条", lastOf(eSL.logs.totalPages) === 2 && lastOf(eSL.logs.total) === 4, JSON.stringify([lastOf(eSL.logs.totalPages), lastOf(eSL.logs.total)]));
const eCH = await drive('cache-hit', KIT, planTail, { category: KIT.OTHER, tailCovers: COVERS.slice(), cache: { [ck]: { items: [K1, K2], pages: 1, total: 2, hasMore: false, serverFacet: false, hints: [], sourceErrors: [], degraded: [], tail: TAILF } } });
check("缓存续命：命中带 tail 的旧包 ⇒ tailStateRef 恢复声明（P5 memo 不因刷新丢失）", !!eCH.tailStateRef.current && canon(eCH.tailStateRef.current.tail) === canon(TAILF), JSON.stringify(eCH.tailStateRef.current));
const eCH2 = await drive('cache-plain', KIT, { search: SEARCH_OK }, { noHarvest: true, category: KIT.OTHER, tailCovers: COVERS.slice(), tailState: { src: 'clawhub', q: 'pdf', cat: KIT.OTHER, tail: TAILF }, cache: { [ck]: { items: [K1], pages: 1, total: 1, hasMore: false, serverFacet: false, hints: [], sourceErrors: [], degraded: [] } } });
check("缓存续命：命中不带 tail 的旧包 ⇒ 清声明（不把旧声明骗到现在）", eCH2.tailStateRef.current === null, JSON.stringify(eCH2.tailStateRef.current));
// 0.5.182 症状2（用户 m28155）：合并态收口「无 tail」也是整集视图（兜底旧服务端）：缓存记录必须 wholeView=true
// + 第 2 页本地翻、零 RPC——老代码把「无 tail」当「非全集」，翻页被发去一次性通路
// （整源浏览 + covers 筛到 0 条 = 空页，正是 m28155 症状 2 的落空形状）。
const eMP0 = await drive('merged-plain', KIT, planPlain, { category: KIT.OTHER, tailCovers: COVERS.slice() });
const crecMP0 = eMP0.resultCacheRef.current['sk|clawhub|pdf|' + KIT.OTHER + '|1|24|installCount'] || {};
check('E-sym2 合并态收口无 tail ⇒ 缓存记录 wholeView=true、tail=null（整集视图，不冒充 tail 声明）', crecMP0.wholeView === true && crecMP0.tail === null, JSON.stringify({ wholeView: crecMP0.wholeView, tail: crecMP0.tail }));
const ckMP = 'sk|clawhub|pdf|' + KIT.OTHER + '|1|2|installCount';
const eMP2 = await drive('merged-plain-page2', KIT, { search: SEARCH_OK }, { category: KIT.OTHER, tailCovers: COVERS.slice(), arg: { page: 2, size: 2 }, cache: { [ckMP]: { items: [K1, K2, K3, K4], pages: 2, total: 4, hasMore: false, serverFacet: false, hints: [], sourceErrors: [], degraded: [], tail: null, wholeView: true } } });
check('E-sym2 合并无 tail 第 2 页：零 RPC、本地第 2 页切片 k-c,k-d（m28155 症状 2 的落空形状）', eMP2.ops.length === 0 && (lastOf(eMP2.logs.skills) || []).join(',') === 'k-c,k-d' && lastOf(eMP2.logs.totalPages) === 2 && lastOf(eMP2.logs.total) === 4, JSON.stringify({ ops: eMP2.ops, skills: lastOf(eMP2.logs.skills), totalPages: lastOf(eMP2.logs.totalPages), total: lastOf(eMP2.logs.total) }));

// ── F. G2 总账：本套跑过的每一次请求体，category 都不许是 __cat_other ──
CURSECT = "F";
const ENVS = [eT, eN, eC, eE1, eE2, eP2, ePB, eAP, eFB, eNoH, eCL, eP6, ePT, eCH, eCH2];
const ALLP = [];
for (const e of ENVS) for (const b of e.bodies) ALLP.push({ op: b.op, cat: b.p.category });
check("G2 全通路请求体无一携带 __cat_other（对拍 S4 语义）", ALLP.length > 20 && ALLP.every((x) => x.cat !== KIT.OTHER && x.cat !== '__cat_other'), 'bodies=' + ALLP.length + ' leak=' + JSON.stringify(ALLP.filter((x) => x.cat === KIT.OTHER)));
check("G2 全通路 category 只可能是 undefined、空串、all 或上游真 slug", ALLP.every((x) => x.cat === undefined || x.cat === '' || x.cat === 'all' || COVERS.indexOf(x.cat) >= 0 || x.cat === 'ai'), JSON.stringify(ALLP.map((x) => x.cat).filter((v) => v !== undefined && v !== '' && v !== 'all')));
check("G2 合并态的 harvest.start 全部降级为 ''/all（D 防线未断）", (() => {
  const t = [eT, ePT, eE1, eE2, eCL, eP6, eCH, eCH2].map((e) => (e.bodies.find((b) => b.op === 'harvest.start') || {}).p).filter(Boolean);
  return t.length >= 4 && t.every((p) => p.category === '' || p.category === 'all');
})(), 'start cats=' + JSON.stringify([eT, ePT, eE1, eE2].map((e) => ((e.bodies.find((b) => b.op === 'harvest.start') || {}).p || {}).category)));

// ── G. N1/N2 chip 本体与 title（真跑 client 的 chipEntries.map 块） ──
CURSECT = "G";
const runChipBlock = (kit, cat) => {
  const h = (tag, props, kid) => ({ tag: tag, props: props || {}, kids: [kid] });
  const S = { chip: (active) => ({ active: Boolean(active) }) };
  let liteSrc = String(kit.labelBody || '');
  liteSrc = liteSrc.replace(/^\s*function\s+categoryLabelLite\s*\([^)]*\)\s*\{/, '').replace(/\}\s*$/, '');
  const lite = new Function('chip', liteSrc || 'return String((chip && chip.label) || "");');
  const other = { value: kit.OTHER, label: kit.LABEL, totalAll: 743, fixed: true, covers: COVERS.slice() };
  const entries = [
    { value: 'all', label: '全部分类', totalAll: 0, fixed: true },
    { value: 'models', label: '模型', totalAll: 2360 },
    other,
  ];
  const calls = [];
  const toggles = [];
  const src = kit.renderSrc;
  if (!src) return { err: 'render block not located' };
  const expr = src.indexOf('chipEntries.map((chip) =>') >= 0 ? src.slice(src.indexOf('chipEntries.map((chip) =>')).replace(/;\s*$/, '') : src;
  let g;
  try {
    g = new Function('chipEntries', 'chipFold', 'categoryLabelLite', 'h', 'S', 'category', 'setCategory', 'searchSkills', 'query', 'source', 'size', 'sort', 'window', 'CATS_COLLAPSE', 'CAT_OTHER', 'bucketSlug', 'toggleCats',
      'const __out = ' + expr + ';' + NL + 'return __out;');
  } catch (err) { return { err: 'compile2: ' + String(err && err.message).slice(0, 120) }; }
  let nodes;
  try {
    nodes = g(entries, { other: other, otherCount: 1 }, lite, h, S, cat, () => {}, (q, o) => calls.push(o), 'pdf', 'clawhub', 24, 'installCount', { scrollTo: () => {} }, kit.COLLAPSE, kit.OTHER, 'all', (v) => toggles.push(v));
  } catch (err) { return { err: 'run: ' + String(err && err.message).slice(0, 160) }; }
  return { nodes: (nodes || []).filter(Boolean), calls: calls, toggles: toggles };
};
const G1N = runChipBlock(KIT, 'ai');
check("G 装置：渲染块可真跑且出 3 个按钮", !G1N.err && G1N.nodes.length === 3, JSON.stringify(G1N.err || G1N.nodes.map((n) => n.props.key)));
const G2N = runChipBlock(KIT, KIT.OTHER);
check("N1/N2 合并入口 chip 本体恰好「其他」二字（无数字无后缀）", !G2N.err && G2N.nodes[2].kids[0] === KIT.LABEL && String(G2N.nodes[2].kids[0]).indexOf('其他') === 0 && String(G2N.nodes[2].kids[0]) === '其他', JSON.stringify(G2N.err || G2N.nodes[2].kids[0]));
check("N1/N2 普通上游真桶仍由 categoryLabelLite 自带条数（数字拼在 label 后，与合并入口天然区分）", G2N.nodes[1].kids[0] === '模型 ' + (2360).toLocaleString(), JSON.stringify(G2N.nodes[1].kids[0]));
check("N1/N2 合并入口 title 报「未列出的分类还有 1 类」，合计约 743 条（数字进 title 不进本体）", String(G2N.nodes[2].props.title || "").indexOf("未列出的分类还有 1 类") === 0 && String(G2N.nodes[2].props.title).indexOf("合计约 743 条") >= 0, String(G2N.nodes[2].props.title));
check("N1/N2 合并入口按下走真筛选（setCategory(CAT_OTHER) + page:1），不再兼任展开", (() => {
  G2N.nodes[2].props.onClick();
  return G2N.calls.length === 1 && G2N.calls[0].category === KIT.OTHER && G2N.calls[0].page === 1 && G2N.toggles.length === 0;
})(), JSON.stringify(G2N.calls));
check("N2 普通分类按钮无 title（数字只给合并入口与说明行）", G2N.nodes[1].props.title === undefined, String(G2N.nodes[1].props.title));
check("G2 渲染层 onClick 只把变量 cat 交给面板态，块内无字面量 __cat_other 下发", (() => {
  const rs = String(KIT.renderSrc || '');
  return rs.indexOf("category: cat,") >= 0 && rs.indexOf("'__cat_other'") < 0 && !/category:\s*CAT_OTHER/.test(rs);
})(), JSON.stringify([/category:\s*CAT_OTHER/.test(String(KIT.renderSrc)), (String(KIT.renderSrc).match(/category: cat,/g) || []).length]));

// ── H. B2 磁盘态变异自证：把变异真写进 client.js，用子进程跑完整套，再从内存 Buffer 逐字节还原 ──
CURSECT = "H";
// F1：每例 mutate→跑→还原 全程 try/finally，finally 无条件把 PRISTINE 写回去（幂等，重复写无害）；
//     窗口内任何异常都被记成显式 FAIL 判据（H_CRASH），绝不把「套件崩掉」当结束、更不留脏文件在盘上。
// F2：MUTDIR 之外再建独占锁文件；拿不到锁 ⇒ 显式判红且一次都不写 client.js（两进程互踩 = 双双拿到假读数）。
// F3：变异窗口内故意抛一次异常，证明 finally 真在还原（mid-window 字节确实异于 PRISTINE，跑完又逐字节相同）。
// 子进程 stdio 走 ignore（Windows 沙箱下捕获管道会 EPERM），计数经标记文件回传，自建自删。
if (process.env.DSH_MUT_MARK) {
  try { writeFileSync(process.env.DSH_MUT_MARK, JSON.stringify({ passed: passed, failed: failed, reds: REDS.slice(0, 10) })); } catch { }
  process.exit(0);
}
const { spawnSync } = await import("node:child_process");
const MUTDIR = mkdtempSync(join(safeTempDir(), "dsh-panel-tail-mut-"));
const writeClient = (buf) => {
  if (!locked) throw new Error("F2 未持锁，拒绝写 client.js");
  WRITE_ATTEMPTS += 1;
  writeFileSync(CLIENT, buf);
};
const restoreClient = () => { try { writeFileSync(CLIENT, PRISTINE); } catch (e) { return "restore-failed: " + String(e && e.message); } return ""; };
const CASES = [
  { name: "X1 spread 改成无条件键（C1 退化为无条件下发）", needle: "...(env.tailCovers ? { tailCategories: env.tailCovers } : {}),", to: "tailCategories: env.tailCovers," },
  { name: "X2 合并态判据删除（普通分类也下发 tailCategories）", needle: "cat === CAT_OTHER && typeof tailCoversRef !== 'undefined'", to: "typeof tailCoversRef !== 'undefined'" },
  { name: "X3 cache 记录不存 tail（缓存续命丢失）", needle: "tail: m.tail || null,", to: "tail: null," },
  { name: "X4 逐类进度分支被删（P2 退化成旧文案）", needle: "if (m.tail && m.tail.categoriesTotal > 0) {", to: "if (false) {" },
  { name: "X5 声明态本地筛回归（P5 又把无分类行错杀）", needle: "chipFold.other.tailDeclared || ", to: "" },
  { name: "X6 windowed 句写反（取不全时说不受窗口限制）", needle: "(tailMemo.windowed === true ?", to: "(tailMemo.windowed === false ?" },
  { name: "X7 D 防线拆除（upstreamCat 不再降级 CAT_OTHER）", needle: "const upstreamCat = cat === CAT_OTHER ? 'all' : cat;", to: "const upstreamCat = cat;" },
  { name: "X9 尾会话本地翻页分支被短路（收口后翻页又打网络）", needle: "const tailView = pageNo > 1 && !append && typeof harvestSliceOf === 'function' ? resultCacheRef.current[tailViewKey] : null;", to: "const tailView = false && pageNo > 1 && !append && typeof harvestSliceOf === 'function' ? resultCacheRef.current[tailViewKey] : null;" },
  { name: "X10 final 不切片（整表灌屏=虚构页码回归）", needle: "d.setSkills(wholeView ? harvestSliceOf(rows, env.pageSize, env.pageNo) : rows);", to: "d.setSkills(rows);" },
  { name: "X8 合并入口 title 回退旧比喻（零「窗内之外」锁必须咬合）", needle: "title: '未列出的分类还有 '", to: "title: '窗内之外还有 '" },
];
const runCounts = (label) => {
  const mark = join(MUTDIR, "count.json");
  const st = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: join(here, ".."), stdio: "ignore", timeout: 180000,
    env: Object.assign({}, process.env, { DSH_MUT_CASE: label, DSH_MUT_MARK: mark }),
  });
  let j = null;
  try { j = JSON.parse(readFileSync(mark, "utf8")); } catch { j = null; }
  try { rmSync(mark, { force: true }); } catch { }
  return { status: st.status, err: st.error ? String(st.error.message || st.error) : "", counts: j };
};
const MUT = [];
const H_CRASH = [];
if (locked) {
  for (const cs of CASES) {
    const hits = raw.split(cs.needle).length - 1;
    if (hits !== 1) { MUT.push({ name: cs.name, skip: "needle-hits=" + hits }); continue; }
    const rec = { name: cs.name, mfailed: "NO-COUNTS", mpassed: "-", rfailed: "NO-COUNTS", restored: false, reds: "(none)", codes: "" };
    try {
      writeClient(Buffer.from(raw.replace(cs.needle, cs.to), "utf8"));
      let mres;
      try { mres = runCounts(cs.name); } finally { const rr = restoreClient(); if (rr) rec.restoreErr = rr; }
      const rres = runCounts("restore:" + cs.name);
      rec.mfailed = mres.counts ? mres.counts.failed : "NO-COUNTS";
      rec.mpassed = mres.counts ? mres.counts.passed : "-";
      rec.rfailed = rres.counts ? rres.counts.failed : "NO-COUNTS";
      rec.restored = Buffer.compare(readFileSync(CLIENT), PRISTINE) === 0;
      rec.reds = mres.counts && mres.counts.reds ? mres.counts.reds.join(" | ").slice(0, 220) : "(none)";
      rec.codes = "m" + mres.status + "/r" + rres.status + (mres.err || rres.err ? " spawn-err" : "");
    } catch (e) {
      rec.crashed = String((e && e.message) || e);
      H_CRASH.push(cs.name + " :: " + rec.crashed);
      rec.restored = Buffer.compare(readFileSync(CLIENT), PRISTINE) === 0;
    }
    MUT.push(rec);
  }
} else {
  for (const cs of CASES) MUT.push({ name: cs.name, skip: "not-locked: " + LOCK_WHY });
}
for (const m of MUT) console.log("MUT| " + [m.name, "mutFailed=" + m.mfailed, "mutPassed=" + m.mpassed, "restoreFailed=" + m.rfailed, "byteRestored=" + m.restored, m.codes, "reds=" + m.reds, m.crashed ? "CRASHED=" + m.crashed : "", m.restoreErr || "", m.skip || ""].filter((x) => x !== undefined && x !== "").join(" :: "));
// F3 非空洞性反证：窗口内真的写过脏字节（midDiff），再由 finally 归零（restored）。
const F3 = (() => {
  if (!locked) return { skipped: "not-locked: " + LOCK_WHY, midDiff: false, restored: false, caught: "" };
  let midDiff = false, restored = false, caught = "", rerr = "";
  try {
    writeClient(Buffer.from(raw.replace(CASES[0].needle, CASES[0].to), "utf8"));
    try {
      midDiff = Buffer.compare(readFileSync(CLIENT), PRISTINE) !== 0;
      throw new Error("injected mid-window failure (F3 non-vacuity proof for F1 finally)");
    } finally { rerr = restoreClient(); }
  } catch (e) { caught = String((e && e.message) || e); }
  restored = Buffer.compare(readFileSync(CLIENT), PRISTINE) === 0;
  return { midDiff: midDiff, restored: restored, caught: caught, restoreErr: rerr };
})();
check("F2 独占运行锁已获取（本套真会写 client.js，禁止并发/与他人同时编辑）", locked === true, LOCK_WHY || "(locked)");
check("F2 未持锁时一次都不写 client.js（且盘上内容未被本进程改过）", locked || (WRITE_ATTEMPTS === 0 && Buffer.compare(readFileSync(CLIENT), PRISTINE) === 0), "writes=" + WRITE_ATTEMPTS + " locked=" + locked);
check("B2 变异针唯一命中（每例恰好 1 处，能真替换）", MUT.length === CASES.length && MUT.every((m) => !m.skip), JSON.stringify(MUT.filter((m) => m.skip).map((m) => [m.name, m.skip])));
check("B2 每例变异跑都出红（变异未被打绿说明判据不咬合）", MUT.length === CASES.length && MUT.every((m) => Number(m.mfailed) > 0), JSON.stringify(MUT.map((m) => [m.name.slice(0, 2), m.mfailed])));
check("B2 每例还原跑都零红（还原后全套再绿）", MUT.length === CASES.length && MUT.every((m) => Number(m.rfailed) === 0), JSON.stringify(MUT.map((m) => [m.name.slice(0, 2), m.rfailed])));
check("B2 还原后 client.js 与 PRISTINE 逐字节一致（不依赖 git）", MUT.length === CASES.length && MUT.every((m) => m.restored === true), JSON.stringify(MUT.map((m) => [m.name.slice(0, 2), m.restored])));
check("F1 变异窗口内零未捕获异常（异常必须显式进判据，不得崩掉套件或留脏文件）", H_CRASH.length === 0, JSON.stringify(H_CRASH).slice(0, 220));
check("F3 窗口内故意抛异常后仍逐字节还原（F1 的 finally 非空洞反证）", F3.midDiff === true && F3.restored === true && String(F3.caught).indexOf("injected") === 0 && !F3.restoreErr, JSON.stringify(F3).slice(0, 220));
if (locked) { try { rmSync(LOCK, { force: true }); } catch { } }
if (locked && WRITE_ATTEMPTS > 0 && Buffer.compare(readFileSync(CLIENT), PRISTINE) !== 0) restoreClient();
try { rmSync(MUTDIR, { recursive: true, force: true }); } catch { }

CURSECT = null;
for (const k of Object.keys(SECT_WANT)) check("条数自证 " + k + " 段应有 " + SECT_WANT[k] + " 条判据（防中途崩掉被静默吞掉）", SECT_GOT[k] === SECT_WANT[k], k + " got=" + SECT_GOT[k]);
for (const r of REDS) console.log("RED| " + r);
console.log(passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
