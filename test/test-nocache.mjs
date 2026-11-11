// Regression test: the agent tools (skill_market_search / mcp_market_search) call the
// source layer WITHOUT a cache object. That path used to crash with
// "fallbackCache is not defined" after the 0.5.10 paging rewrite, so keep it covered.
import { ALL_SOURCES, searchSkills, warmMarketCache } from "../src/sources.js";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("--- 无 cache 参数：每个源都要能返回条目（agent 工具走的路径）");
for (const source of ALL_SOURCES) {
  try {
    const p1 = await searchSkills({ query: "", source, page: 1, pageSize: 12 });
    const p2 = await searchSkills({ query: "", source, page: 2, pageSize: 12 });
    const ids1 = new Set(p1.items.map((item) => item.id));
    const overlap = p2.items.filter((item) => ids1.has(item.id)).length;
    check(
      p1.items.length > 0 && p2.items.length > 0 && overlap === 0,
      `${source} page1=${p1.items.length} page2=${p2.items.length} overlap=${overlap}`,
      `total=${p1.total} hasMore=${p1.hasMore}`,
    );
  } catch (error) {
    check(false, `${source} 抛错`, String(error && error.message ? error.message : error));
  }
}

console.log("--- 无 cache 参数的聚合与预热");
try {
  const all = await searchSkills({ query: "", source: "all", page: 1, pageSize: 8 });
  check(all.items.length > 0, `all page1=${all.items.length}`, `pages=${all.pages} total=${all.total}`);
} catch (error) {
  check(false, "all 抛错", String(error && error.message ? error.message : error));
}

try {
  await warmMarketCache();
  check(true, "warmMarketCache() 无参可执行");
} catch (error) {
  check(false, "warmMarketCache 抛错", String(error && error.message ? error.message : error));
}

console.log(failures === 0 ? "\nNO-CACHE CHECKS PASSED" : `\nNO-CACHE CHECKS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
