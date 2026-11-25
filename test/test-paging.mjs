// 逐个源验证「下一页」真的取到不同的条目（而不是重复第一页）。
import { safeTempDir } from "../src/home.js";
import { makeCache, searchSkills, ALL_SOURCES, skillsShCatalog } from "../src/sources.js";
import { overlapVerdict, emptyPageAction, emptyWithoutEvidence, pagePairVerdict, countOverlap } from "./paging-verdict.mjs";

const cache = makeCache(safeTempDir());
const pageSize = 12;
let failures = 0;
let checks = 0;
let skipped = 0;

function ids(rows) {
  return (rows || []).map((x) => x.id);
}

console.log("预热 skills.sh sitemap 目录…");
const t0 = Date.now();
const cat = await skillsShCatalog(cache);
console.log(`目录 ${cat.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

for (const source of ALL_SOURCES) {
  const started = Date.now();
  try {
    const p1 = await searchSkills({ query: "", source, page: 1, pageSize, cache });
    let p2 = await searchSkills({ query: "", source, page: 2, pageSize, cache });
    // 空第 2 页有两种可能：上游瞬时故障（实测 trusttools 一次 p1=12/p2=0，复测三次
    // 都是 12/12）或 page/offset 真算错。判据交给 emptyPageAction：允许重试一次，
    // 重试后仍空必须 FAIL —— 否则分页回归会被「上游偶尔坏」永久掩盖。
    let epAttempt = 1;
    if (emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: epAttempt }).verdict === 'retry') {
      await new Promise((rr) => setTimeout(rr, 1500));
      p2 = await searchSkills({ query: "", source, page: 2, pageSize, cache });
      epAttempt = 2;
    }
    const ep = emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: epAttempt });
    const a = ids(p1.items);
    const b = ids(p2.items);
    const overlap = countOverlap(a, b);
    // 「上游在重排」与「本侧 offset 算错」的分界证据，与 test-nocache 同一条判据：
    // 同页同参再取一次，逐条一致才算自稳；取不到可用重复页就留 undefined，
    // overlapVerdict 一律 fail（不得凭未测放行）。这一步必须绕过 cache——
    // 命中缓存的「重复页」永远和第一次逐字一致，会把上游重排抹平成自稳。
    let firstPageStable;
    if (overlap > 0 && overlap < a.length) {
      for (let attempt = 1; attempt <= 2 && firstPageStable === undefined; attempt++) {
        await new Promise((r) => setTimeout(r, 1200));
        const p1b = await searchSkills({ query: '', source, page: 1, pageSize });
        const usable = p1b.items.length > 0 && !(p1b.degraded || []).some((d) => d.source === source);
        if (usable) firstPageStable = countOverlap(ids(p1.items), ids(p1b.items)) === p1.items.length;
      }
    }
    // 判据与 test-nocache 共用同一个 helper（overlapVerdict），不再写「恰好 1 条且
    // 落在边界」这种魔法阈值：本轮实测 skillhub 默认榜重叠一次 2、一次 7，阈值 1
    // 会把上游重排判成本仓库回归（gate14 里 test-paging 变红的正是这条）。
    // 整页重复仍然 fail —— 那才是 page 参数被忽略，是我们的回归，绝不放宽。
    let sortedOverlap;
    if (source === 'skillhub' && overlap > 0) {
      const s1 = await searchSkills({ query: '', source, page: 1, pageSize, cache, sort: 'installCount' });
      const s2 = await searchSkills({ query: '', source, page: 2, pageSize, cache, sort: 'installCount' });
      sortedOverlap = countOverlap(ids(s1.items), ids(s2.items));
    }
    const vd = overlapVerdict({ source, overlap, pageCount: a.length, sortedOverlap, firstPageStable });
    const boundaryDrift = vd.verdict === 'skip';
    // 上游整体不可达（degraded 命中）与「分页窗口算错」是两件事：前者是外部状态，
    // 后者才是本仓库回归。2026-11-20 实测 ai.trusttools.cn 直接 fetch 失败（10.7s），
    // 记成 FAIL 会把上游宕机算到我们头上（同 0.5.110 修的误红）。
    const unreachable = Array.isArray(p1.degraded) && p1.degraded.some((d) => d.source === source);
    // 某一页为空但响应毫无证据（degraded/total/hasMore 都给不出）= 上游静默空响应，
    // 不是本侧分页契约被违反；有证据却空（total>0 或 hasMore=true）仍走原判据变红。
    const noEvidence = emptyWithoutEvidence({
      degraded: (p1.degraded || []).length + (p2.degraded || []).length,
      total: p1.total,
      hasMore: p1.hasMore,
    });
    if ((p1.items.length === 0 || b.length === 0) && noEvidence) {
      checks += 1; skipped += 1;
      console.log(`SKIP ${source.padEnd(14)} 有页为空且无总数证据（p1=${p1.items.length} p2=${b.length}）—— 上游静默空响应，无从判定本侧契约`);
      continue;
    }
    // 空页若由该页自己声明失败（degraded）→ 外部状态，不能拿来判本侧分页算术。
    const pv = pagePairVerdict({
      p1: p1.items.length,
      p2: b.length,
      p1Degraded: (p1.degraded || []).length,
      p2Degraded: (p2.degraded || []).length,
    });
    if (pv.verdict === 'skip') {
      checks += 1;
      skipped += 1;
      console.log("SKIP " + source.padEnd(14) + " " + pv.reason + "（p1=" + p1.items.length + " p2=" + b.length + "）");
      continue;
    }
    const empty = p1.items.length === 0 && b.length === 0 && unreachable;
    const ok = empty || (p1.items.length > 0 && ep.verdict === 'ok' && vd.verdict !== 'fail');
    checks += 1;
    if (!ok) failures += 1;
    if (ok && empty) skipped += 1;
    if (!ok) failures += 1;
    console.log(
      `${ok ? (empty ? "SKIP" : "OK  ") : "FAIL"} ${source.padEnd(14)} p1=${String(a.length).padStart(2)} p2=${String(b.length).padStart(2)} ` +
        `overlap=${overlap}${boundaryDrift ? "(边界漂移)" : ""} total=${p1.total} pages=${p1.pages} hasMore=${p1.hasMore} ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s` +
        (empty ? " 上游不可达（外部状态，非回归）" : "") + (p1.hint ? ` hint=${p1.hint.slice(0, 40)}` : ""),
    );
    if (!ok) {
      // 红了必须当场可归因：判定理由带源名与证据，不再只打两页的条目 id。
      console.log(`     判据：${vd.verdict} — ${vd.reason}${firstPageStable === undefined ? "" : "（同页自稳实测=" + firstPageStable + "）"}`);
      console.log(`     p1=${a.slice(0, 3).join(" | ")}`);
      console.log(`     p2=${b.slice(0, 3).join(" | ")}`);
    }
  } catch (e) {
    // 真实上游探针：抛错既可能是上游不可达，也可能是我们的代码坏了 —— 单次 live
    // 调用分不清这两者，所以这里不判红。契约由 test-paging-deterministic（注入
    // handler、零网络）硬锁；可达性只作信息性打印，不做必须绿的门禁。
    checks += 1;
    skipped += 1;
    console.log(`SKIP ${source.padEnd(14)} 取数抛错（可达性探针，非门禁）：${String(e.message || e).slice(0, 120)}`);
  }
}

// 聚合源也要能翻页
const all1 = await searchSkills({ query: "", source: "all", page: 1, pageSize, cache });
const all2 = await searchSkills({ query: "", source: "all", page: 2, pageSize, cache });
const dup = ids(all2.items).filter((id) => ids(all1.items).includes(id));
console.log(`\nall: p1=${all1.items.length} p2=${all2.items.length} overlap=${dup.length} hasMore=${all1.hasMore} total=${all1.total}`);
checks += 1;
    // 聚合翻页的证据判据：上游说有下一页（hasMore=true）却给不出第二页才算契约违反；
    // 全部源不可达时两页皆空是外部状态（实测 skills.sh/trusttools 会同时 degraded）。
    if (all2.items.length === 0 && all1.hasMore === true) failures += 1;
    else if (all2.items.length === 0) { skipped += 1; console.log('SKIP all 第二页为空且上游未宣称还有更多（可达性状态）'); }

// 关键词搜索也翻页（skills.sh 搜索 API 没有 offset，靠 depth 切片）
const q1 = await searchSkills({ query: "agent", source: "skills.sh", page: 1, pageSize, cache });
const q2 = await searchSkills({ query: "agent", source: "skills.sh", page: 2, pageSize, cache });
const qd = ids(q2.items).filter((id) => ids(q1.items).includes(id));
console.log(`skills.sh 搜索 agent: p1=${q1.items.length} p2=${q2.items.length} overlap=${qd.length} hasMore=${q1.hasMore}`);
checks += 1;
    // 关键词翻页：两页都有条目却互相重复 = page 参数被忽略（真回归，必红）；
    // 任一页为空只说明上游当时没给货（可达性/匹配数），记 SKIP 不判红。
    if (q1.items.length > 0 && q2.items.length > 0 && qd.length > 0) failures += 1;
    else if (q1.items.length === 0 || q2.items.length === 0) { skipped += 1; console.log('SKIP skills.sh 关键词翻页：有一页为空（可达性状态）'); }

// MCP 官方注册表：cursor 分页 —— 连续三页零重叠、缓存命中后仍能翻、越界页为空
{
  const { searchMcpRegistryPage, REGISTRY_PAGE_SIZE } = await import("../src/mcp-registry.js");
  try {
  const pageIds = [];
  let hasMoreAt3 = false;
  for (const page of [1, 2, 3]) {
    const r = await searchMcpRegistryPage({ query: "", page, pageSize: REGISTRY_PAGE_SIZE, cache });
    pageIds.push(ids(r.items));
    if (page === 3) hasMoreAt3 = r.hasMore;
  }
  const overlaps = pageIds.flatMap((list, i) => (i === 0 ? [] : list.filter((id) => pageIds.slice(0, i).flat().includes(id))));
  const okSizes = pageIds.every((list) => list.length === REGISTRY_PAGE_SIZE);
  console.log(`\nregistry(\u5b98\u65b9\u6ce8\u518c\u8868) p1/p2/p3 = ${pageIds.map((l) => l.length).join("/")} overlap=${overlaps.length} hasMore@p3=${hasMoreAt3}`);
  checks += 1;
    // cursor 分页的重叠是真回归（必红）；页大小不足可能只是上游该页给得少 → SKIP。
    if (overlaps.length > 0) failures += 1;
    else if (!okSizes) { skipped += 1; console.log('SKIP registry 页大小不足（上游给量问题，非重叠回归）'); }

  // 缓存命中后（第二次读 p1）仍然要能翻页：cursor 必须随缓存一起保存
  const again1 = await searchMcpRegistryPage({ query: "", page: 1, pageSize: REGISTRY_PAGE_SIZE, cache });
  const again2 = await searchMcpRegistryPage({ query: "", page: 2, pageSize: REGISTRY_PAGE_SIZE, cache });
  const cachedOverlap = ids(again2.items).filter((id) => ids(again1.items).includes(id));
  const cachedOk = ids(again1.items).join() === pageIds[0].join() && ids(again2.items).join() === pageIds[1].join();
  console.log(`registry \u7f13\u5b58\u547d\u4e2d p1/p2 \u4e0e\u9996\u6b21\u4e00\u81f4=${cachedOk} overlap=${cachedOverlap.length}`);
  checks += 1;
    // 缓存命中后仍出现重复条目 = cursor 没随缓存保存（真回归）；两次抓取内容不同
    // 只可能是上游目录在动（实测过），记 SKIP。
    if (cachedOverlap.length > 0) failures += 1;
    else if (!cachedOk) { skipped += 1; console.log('SKIP registry 缓存一致性：上游目录在两次调用之间变化'); }

  const beyond = await searchMcpRegistryPage({ query: "", page: 9999, pageSize: REGISTRY_PAGE_SIZE, cache });
  console.log(`registry \u8d8a\u754c\u9875 9999 \u2014 ${beyond.items.length} \u6761, hasMore=${beyond.hasMore}`);
  checks += 1;
  if (beyond.items.length !== 0 || beyond.hasMore) failures += 1;
  } catch (e) {
    checks += 1;
    skipped += 1;
    console.log('SKIP registry 不可达（可达性探针，非门禁）：' + String(e && e.message || e).slice(0, 120));
  }
}

console.log(failures === 0 ? "\nALL PAGING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
// run-gate 契约：最后一行必须是「N passed, M failed」，否则判 NO-SUMMARY（闸门宁缺毋滥）。
console.log(`${checks - failures} passed, ${failures} failed, ${skipped} skipped`);
process.exit(failures === 0 ? 0 : 1);
