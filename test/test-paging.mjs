// 逐个源验证「下一页」真的取到不同的条目（而不是重复第一页）。
import { tmpdir } from "node:os";
import { makeCache, searchSkills, ALL_SOURCES, skillsShCatalog } from "../src/sources.js";

const cache = makeCache(tmpdir());
const pageSize = 12;
let failures = 0;

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
    const p2 = await searchSkills({ query: "", source, page: 2, pageSize, cache });
    const a = ids(p1.items);
    const b = ids(p2.items);
    const overlap = b.filter((id) => a.includes(id));
    const ok = p1.items.length > 0 && b.length > 0 && overlap.length === 0;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${source.padEnd(14)} p1=${String(a.length).padStart(2)} p2=${String(b.length).padStart(2)} ` +
        `overlap=${overlap.length} total=${p1.total} pages=${p1.pages} hasMore=${p1.hasMore} ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s` +
        (p1.hint ? ` hint=${p1.hint.slice(0, 40)}` : ""),
    );
    if (!ok) {
      console.log(`     p1=${a.slice(0, 3).join(" | ")}`);
      console.log(`     p2=${b.slice(0, 3).join(" | ")}`);
    }
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${source.padEnd(14)} ${String(e.message || e).slice(0, 160)}`);
  }
}

// 聚合源也要能翻页
const all1 = await searchSkills({ query: "", source: "all", page: 1, pageSize, cache });
const all2 = await searchSkills({ query: "", source: "all", page: 2, pageSize, cache });
const dup = ids(all2.items).filter((id) => ids(all1.items).includes(id));
console.log(`\nall: p1=${all1.items.length} p2=${all2.items.length} overlap=${dup.length} hasMore=${all1.hasMore} total=${all1.total}`);
if (all2.items.length === 0) failures += 1;

// 关键词搜索也翻页（skills.sh 搜索 API 没有 offset，靠 depth 切片）
const q1 = await searchSkills({ query: "agent", source: "skills.sh", page: 1, pageSize, cache });
const q2 = await searchSkills({ query: "agent", source: "skills.sh", page: 2, pageSize, cache });
const qd = ids(q2.items).filter((id) => ids(q1.items).includes(id));
console.log(`skills.sh 搜索 agent: p1=${q1.items.length} p2=${q2.items.length} overlap=${qd.length} hasMore=${q1.hasMore}`);
if (q1.items.length === 0 || q2.items.length === 0 || qd.length > 0) failures += 1;

// MCP 官方注册表：cursor 分页 —— 连续三页零重叠、缓存命中后仍能翻、越界页为空
{
  const { searchMcpRegistryPage, REGISTRY_PAGE_SIZE } = await import("../src/mcp-registry.js");
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
  if (!okSizes || overlaps.length > 0) failures += 1;

  // 缓存命中后（第二次读 p1）仍然要能翻页：cursor 必须随缓存一起保存
  const again1 = await searchMcpRegistryPage({ query: "", page: 1, pageSize: REGISTRY_PAGE_SIZE, cache });
  const again2 = await searchMcpRegistryPage({ query: "", page: 2, pageSize: REGISTRY_PAGE_SIZE, cache });
  const cachedOverlap = ids(again2.items).filter((id) => ids(again1.items).includes(id));
  const cachedOk = ids(again1.items).join() === pageIds[0].join() && ids(again2.items).join() === pageIds[1].join();
  console.log(`registry \u7f13\u5b58\u547d\u4e2d p1/p2 \u4e0e\u9996\u6b21\u4e00\u81f4=${cachedOk} overlap=${cachedOverlap.length}`);
  if (!cachedOk || cachedOverlap.length > 0) failures += 1;

  const beyond = await searchMcpRegistryPage({ query: "", page: 9999, pageSize: REGISTRY_PAGE_SIZE, cache });
  console.log(`registry \u8d8a\u754c\u9875 9999 \u2014 ${beyond.items.length} \u6761, hasMore=${beyond.hasMore}`);
  if (beyond.items.length !== 0 || beyond.hasMore) failures += 1;
}

console.log(failures === 0 ? "\nALL PAGING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
