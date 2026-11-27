// test-github-transport.mjs — src/github.js 传输层判据（0.5.183 批一：353 行 8 导出里 7 个零判据）。
// 注入面 = github.js 唯一裸 fetch（src/github.js:33）：import * as gh + globalThis.fetch=stub 即离线驱动。
// http.js/home.js/child_process 导入链离线安全（只定义函数，无顶层网络/fs 副作用）。
// tar 通路（pythonDownload/execFile tar）离线不可测 ⇒ 结构锁源码；basename 兜底 bug ⇒ TDD 红判据。
import { readFileSync } from "node:fs";
import * as gh from "../src/github.js";

const srcGh = readFileSync(new URL("../src/github.js", import.meta.url), "utf8");
let passed = 0, failed = 0;
const REDS = [];
const check = (n, cond, d) => { if (cond) { passed += 1; console.log("  PASS " + n); } else { failed += 1; REDS.push(n); console.log("  FAIL " + n + (d ? "  [" + String(d).slice(0, 170) + "]" : "")); } };

// --- 纯函数（零网络，直跑） ---
check("parseRepoRef owner/repo", gh.parseRepoRef("owner/repo").repo === "owner/repo");
check("parseRepoRef owner/repo/sub ⇒ subPath", (() => { const p = gh.parseRepoRef("o/r/sub/x"); return p.repo === "o/r" && p.ref === "" && p.subPath === "sub/x"; })());
check("parseRepoRef url strip prefix", (() => { const p = gh.parseRepoRef("https://github.com/o/r.git"); return p.repo === "o/r" && p.ref === "" && p.subPath === ""; })());
check("parseRepoRef 单段抛错", (() => { try { gh.parseRepoRef("onlyone"); return false; } catch { return true; } })());
check("skillDirsFrom 根 SKILL.md⇒空串", JSON.stringify(gh.skillDirsFrom(["SKILL.md", "docs/r.md"])) === '[""]');
check("skillDirsFrom 嵌套收集", JSON.stringify(gh.skillDirsFrom(["a/SKILL.md", "a/b/SKILL.md", "x/SKILL.md"])) === '["a","a/b","x"]');

// --- fetch 桩（驱动传输层 5 个 async 导出；只服务自己关心的 URL，其余 404） ---
const realFetch = globalThis.fetch;
const treeJson = JSON.stringify({ files: [{ name: "custom", type: "directory", files: [{ name: "tdd", type: "directory", files: [{ name: "SKILL.md", type: "file" }] }] }] });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("data.jsdelivr.com/v1/packages/gh")) return { ok: true, status: 200, text: async () => treeJson };
  if (u.endsWith("/custom/tdd/SKILL.md")) return { ok: true, status: 200, text: async () => "TDD SKILL" };
  return { ok: false, status: 404, text: async () => "" };
};
const found = await gh.findSkillDirFor({ repo: "own/rep", ref: "main", skill: "TDD", cache: {} });
check("findSkillDirFor 兜底按 basename 匹配（TDD 红：src/github.js:336 用 basename 但 :9 未导入⇒修前被 :340 catch 吞返空）", found === "custom/tdd", "found=" + JSON.stringify(found));
const list = await gh.listTree("own/rep", "main");
check("listTree 走 jsDelivr tree 出相对路径", JSON.stringify(list) === '["custom/tdd/SKILL.md"]', "list=" + JSON.stringify(list));
const rd = await gh.readRepoFile("own/rep", "main", "custom/tdd/SKILL.md");
check("readRepoFile raw 通路取回文本", rd === "TDD SKILL", "rd=" + JSON.stringify(rd));
const fm = await gh.fetchSkillMd({ repo: "own/rep", ref: "main", skillDir: "custom/tdd" });
check("fetchSkillMd 点名 skillDir 取回", fm.skillText === "TDD SKILL" && fm.skillDir === "custom/tdd", "fm=" + JSON.stringify(fm));
const rr = await gh.resolveRef("own/rep", "main");
check("resolveRef 首选 ref 直返", rr === "main", "rr=" + JSON.stringify(rr));
globalThis.fetch = realFetch;

// --- 结构锁（tar/python/execFile 离线不可测；basename 修复锁） ---
check("downloadSkillDir tar+python 通路在源码", srcGh.includes("pythonDownload") && /execFile\(/.test(srcGh) && srcGh.includes("tar"));
check("findSkillDirFor 兜底 :9 已导入 basename（0.5.183 修复）", /import\s+\{[^}]*\bbasename\b[^}]*\}\s+from\s+"node:path"/.test(srcGh), "import 行=" + srcGh.split("\n").find((l) => /from "node:path"/.test(l) || "").trim());

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) { console.log("REDS:\n" + REDS.map((r) => "  - " + r).join("\n")); process.exitCode = 1; }
