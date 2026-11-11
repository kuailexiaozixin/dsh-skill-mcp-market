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

console.log(failures === 0 ? "\nALL PAGING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
