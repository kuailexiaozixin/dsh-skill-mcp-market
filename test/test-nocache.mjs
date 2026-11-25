// Regression test: the agent tools (skill_market_search / mcp_market_search) call the
// source layer WITHOUT a cache object. That path used to crash with
// "fallbackCache is not defined" after the 0.5.10 paging rewrite, so keep it covered.
import { ALL_SOURCES, searchSkills, warmMarketCache } from "../src/sources.js";
import { overlapVerdict, emptyPageAction, emptyWithoutEvidence, pagePairVerdict, countOverlap } from './paging-verdict.mjs';

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log('--- 无 cache 参数：每个源都要能返回条目（agent 工具走的路径）');
let skipped = 0;
for (const source of ALL_SOURCES) {
  try {
    const p1 = await searchSkills({ query: '', source, page: 1, pageSize: 12 });
    let p2 = await searchSkills({ query: '', source, page: 2, pageSize: 12 });
    // 上游整体不可达（degraded 命中）与「无 cache 路径坏了」是两件事：前者是外部状态，
    // 记 SKIP 而不是 FAIL —— 否则某个市场宕机就会把这条契约伪装成代码回归。
    // 判据与 test-paging.mjs 同口径（degraded 里有这个源，或 hint 说不可达）。
    // 「外部状态 vs 本侧回归」统一用 helper 判（emptyWithoutEvidence），不在此另写一套：
    // 两套相近判据互相打架是本轮明确要避开的（test-paging 用的就是同一个函数）。
    const unreachable = (p1.degraded || []).some((d) => d.source === source) || emptyWithoutEvidence({ degraded: (p1.degraded || []).length, total: p1.total, hasMore: p1.hasMore });
    if (unreachable && p1.items.length === 0) {
      skipped += 1;
      console.log(`SKIP ${source} 上游不可达（外部状态，非回归）`);
      continue;
    }
    // 空第 2 页有两种可能：上游瞬时故障（本轮实测 trusttools 一次 p1=12/p2=0，
    // 复测三次都 12/12）或 page/offset 真算错。只靠一次结果分不清，判据交给
    // emptyPageAction：允许重试一次，重试后仍空必须 FAIL —— 否则分页回归会被
    // 「上游偶尔坏」永久掩盖。
    const ep1 = emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: 1 });
    if (ep1.verdict === 'retry') {
      await new Promise((r) => setTimeout(r, 1500));
      p2 = await searchSkills({ query: '', source, page: 2, pageSize: 12 });
    }
    const overlap = countOverlap(p1.items, p2.items);
    // 「上游在重排」与「我们 offset 算错」必须靠实测分开，而不是给某个源发永久通行证。
    // 证据 = 同一页用同一参数再请求一次：两次逐条一致 ⇒ 该页自稳（stable=true）；
    // 对不上 ⇒ 上游默认序自身在漂（stable=false）⇒ overlapVerdict 记 SKIP 并写明依据。
    // 取不到可用的重复页（空或自报 degraded）⇒ 留 undefined，helper 一律 fail：
    // 「没测过」不等于「没问题」，与 sortedOverlap 同一条原则。
    let firstPageStable;
    if (overlap > 0 && overlap < p1.items.length) {
      for (let attempt = 1; attempt <= 2 && firstPageStable === undefined; attempt++) {
        await new Promise((r) => setTimeout(r, 1200));
        const p1b = await searchSkills({ query: '', source, page: 1, pageSize: 12 });
        const usable = p1b.items.length > 0 && !(p1b.degraded || []).some((d) => d.source === source);
        if (usable) firstPageStable = countOverlap(p1.items, p1b.items) === p1.items.length;
      }
    }
    // skillhub 默认榜（不带 sortBy）自身在重排：实测同一请求首条在 icon-design 与
    // govwriter-pro 之间漂移，跨页重叠一次 2、一次 7。外部数据状态不该伪装成代码回归，
    // 但放宽必须有边界与自证 —— 判定交给纯函数 overlapVerdict（可被真值表证伪）：
    //   整页重复 → fail（page 参数被忽略，这是我们的分页回归）；
    //   部分重复 + 显式排序路径 overlap=0 → skip（上游默认序在重排，下发的分页参数没错）；
    //   显式排序路径也重复 → fail（这条判据绝不放宽）。
    let sortedOverlap;
    if (overlap > 0 && source === 'skillhub') {
      const s1 = await searchSkills({ query: '', source, page: 1, pageSize: 12, sort: 'installCount' });
      const s2 = await searchSkills({ query: '', source, page: 2, pageSize: 12, sort: 'installCount' });
      sortedOverlap = countOverlap(s1.items, s2.items);
    }
    const vd = overlapVerdict({ source, overlap, pageCount: p1.items.length, sortedOverlap, firstPageStable });
    if (vd.verdict === 'skip') { skipped += 1; console.log('SKIP ' + source + ' overlap=' + overlap + ' — ' + vd.reason); continue; }
    const ep = emptyPageAction({ p1: p1.items.length, p2: p2.items.length, total: p1.total, hasMore: p1.hasMore, attempt: ep1.verdict === 'retry' ? 2 : 1 });
    // 重试之后再看：空页若由该页自报失败（degraded），是上游状态，不判本侧回归。
    const pvN = pagePairVerdict({
      p1: p1.items.length,
      p2: p2.items.length,
      p1Degraded: (p1.degraded || []).length,
      p2Degraded: (p2.degraded || []).length,
    });
    if (pvN.verdict === 'skip') {
      skipped += 1;
      console.log('SKIP ' + source + ' ' + pvN.reason + '（p1=' + p1.items.length + ' p2=' + p2.items.length + '）');
      continue;
    }
    check(p1.items.length > 0 && ep.verdict === 'ok' && vd.verdict === 'ok',
      [vd.reason, ep.reason].filter(Boolean).join('；') || ('total=' + p1.total + ' hasMore=' + p1.hasMore));
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

console.log('');
console.log('--- 端到端证伪：注入真忽略 page 的假 handler，自证判据必须 FAIL');
{
  // 上面的分支全在打真实上游，无法构造「我们的分页坏了」这一确定场景；
  // searchSkills 支持 handlers 注入，于是能造一个第 2 页返回同样条目的假源。
  // 若自证判据形同虚设（外部状态分支顺带放行真回归），这里就会绿 —— 那才是问题。
  const fake = 'fakedupe';
  const mk = (n) => Array.from({ length: n }, (unused, k) => ({ id: fake + ':x' + k, slug: 'x' + k, source: fake, name: 'x' + k }));
  const handlers = {
    [fake]: async ({ pageSize }) => ({ source: fake, items: mk(12), total: 5000, pageSize: pageSize || 12, hasMore: true }),
  };
  const p1f = await searchSkills({ query: '', source: fake, page: 1, pageSize: 12, handlers });
  const p2f = await searchSkills({ query: '', source: fake, page: 2, pageSize: 12, handlers });
  const ovF = countOverlap(p1f.items, p2f.items);
  check(ovF === p1f.items.length && ovF > 0, '假 handler 构造成立（第 2 页整页重复）', 'overlap=' + ovF);
  const vdF = overlapVerdict({ source: fake, overlap: ovF, pageCount: p1f.items.length, sortedOverlap: undefined });
  check(vdF.verdict === 'fail', '整页重复判 fail（外部状态分支不得放行真回归）', vdF.verdict + ' / ' + vdF.reason);
  const vdP = overlapVerdict({ source: fake, overlap: 3, pageCount: 12, sortedOverlap: 0 });
  check(vdP.verdict === 'fail', '非 skillhub 的部分重叠也 fail（口子只有 skillhub 一处）', vdP.verdict);
  const epF = emptyPageAction({ p1: 12, p2: 0, total: 5000, hasMore: true, attempt: 2 });
  check(epF.verdict === 'fail', '重试后仍空判 fail（回归不被上游抖动掩盖）', epF.verdict);
}

console.log(`（不可达而跳过的源: ${skipped}）`);
console.log(failures === 0 ? "\nNO-CACHE CHECKS PASSED" : `\nNO-CACHE CHECKS FAILED (${failures})`);
// run-gate 契约：最后一行必须是「N passed, M failed」。中文总结行匹配不上会被判
// NO-SUMMARY —— 闸门宁缺毋滥：没有规范总结说明可能中途崩了没跑完，不能替它放行。
console.log(`${checks - failures} passed, ${failures} failed, ${skipped} skipped`);
process.exit(failures === 0 ? 0 : 1);




