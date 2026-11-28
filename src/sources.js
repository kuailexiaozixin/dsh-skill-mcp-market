// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { enrichPageDescriptions, enrichSkillsShFast } from "./enrich.js";
import { supportsSort as capabilitySupports, sortKeysFor } from "./sort-capability.js";
import { categoryCapability, categoryCapableSources, isLocalFilterSource, isTailExhaustiveSource } from "./category-capability.js";
import {
  searchClawHub,
  warmClawHubCatalog,
  searchLobeHubSkills,
  searchModelScope,
  searchSkillsMp,
  searchTrustTools,
  startSkillsMpPump,
} from "./extra-sources.js";
import { safeTempDir, childEnv } from "./home.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.3 (+skill and mcp market)", accept: "application/json" };

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ disk cache
export function makeCache(dir) {
  const memory = new Map();
  return {
    async get(key, ttlMs) {
      const hit = memory.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const file = join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
      if (!existsSync(file)) return undefined;
      try {
        const stored = JSON.parse(await readFile(file, "utf8"));
        if (Date.now() - stored.at > ttlMs) return undefined;
        memory.set(key, stored);
        return stored.value;
      } catch {
        return undefined;
      }
    },
    async put(key, value) {
      const entry = { at: Date.now(), value };
      memory.set(key, entry);
      try {
        const file = join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(entry), "utf8");
      } catch {
        // cache is best-effort
      }
    },
  };
}

// ------------------------------------------------------------------ skills.sh
// 首页只挂了约 48 条精选；真正的目录在 sitemap（sitemap-skills-1/-2.xml，合计约 2 万条）。
// 把整份目录缓存一天、再本地切片，「加载更多」才可能翻到第 49 条之后的技能。
const SKILLS_SH_SITEMAP = "https://www.skills.sh/sitemap.xml";
const SKILLS_SH_CATALOG_KEY = "skills_sh_catalog_v2";
const SKILLS_SH_CATALOG_TTL = 24 * 3600 * 1000;
const SKILLS_SH_URL_RE = /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i;

/** skills.sh 的列表接口没有简介字段：读不到 SKILL.md 时给一句诚实的兜底，卡片才不会空着。 */
function fillMissingDescriptions(items) {
  for (const item of items || []) {
    if (item.description) continue;
    const where = item.owner ? `${item.owner} ` : "";
    item.description = `${where}收录于 skills.sh 的技能；上游未提供简介，安装后会读取它的 SKILL.md`;
  }
}

/** 本地分页切片：上游没有 page 参数的源都靠它实现真正的翻页。 */
// 补描述是「锦上添花」：上游每个技能要一次网络往返，整屏补完可能十几秒。
// 给一个总预算，超时就先把卡片发出去（描述留空/通用文案），绝不让面板等着转圈。
const DESCRIPTION_BUDGET_MS = 9000;

async function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function pageSlice(rows, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  return (Array.isArray(rows) ? rows : []).slice((p - 1) * size, p * size);
}

function skillsShCard(row) {
  const owner = row.owner;
  const slug = row.slug;
  return {
    id: `skills.sh:${owner}/${slug}`,
    slug,
    name: slug,
    description: "",
    source: "skills.sh",
    sourceLabel: "skills.sh",
    owner,
    homepage: `https://www.skills.sh/${owner}/${slug}`,
    upstreamUrl: owner,
    skillDir: "",
    // 安装需要「仓库 + --skill 名」：owner 是网站路径（可能是 owner/repo），
    // 真正的 GitHub 仓库与技能名由 skills.sh 详情页里的 `npx skills add` 命令解析得出。
    // 这里先给出页面地址，resolveSkillsShInstall 会读取它并解析。
    installRef: `https://www.skills.sh/${owner}/${slug}`,
    installs: 0,
    installable: true,
  };
}

/** 走 sitemap 取全量目录（首次约 1 分钟，之后一天内直接读缓存）。 */
export async function skillsShCatalog(cache) {
  const cached = cache ? await cache.get(SKILLS_SH_CATALOG_KEY, SKILLS_SH_CATALOG_TTL) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const index = await fetchText(SKILLS_SH_SITEMAP, 30000);
  const shards = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((url) => /sitemap-skills-\d+\.xml$/i.test(url));
  const settled = await Promise.allSettled(shards.map((shard) => fetchText(shard, 180000)));
  const out = [];
  const seen = new Set();
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const match of String(item.value).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const hit = SKILLS_SH_URL_RE.exec(match[1]);
      if (!hit) continue;
      const key = `${hit[1]}/${hit[2]}/${hit[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ owner: `${hit[1]}/${hit[2]}`, slug: hit[3] });
    }
  }
  if (out.length > 0 && cache) await cache.put(SKILLS_SH_CATALOG_KEY, out);
  return out;
}

/** 首页推荐的约 48 条：全量目录还没就绪时的兜底，保证首屏不空白。 */
async function skillsShHighlights(cache) {
  const cached = cache ? await cache.get("skills_sh_home", 30 * 60 * 1000) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const html = await fetchText("https://www.skills.sh/", 25000);
  const seen = new Set();
  const rows = [];
  for (const match of html.matchAll(/\/([A-Za-z0-9_.-]+)\/skills\/([A-Za-z0-9_.-]+)/g)) {
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ owner: `${match[1]}/skills`, slug: match[2] });
  }
  if (rows.length > 0 && cache) await cache.put("skills_sh_home", rows);
  return rows;
}

// 全量目录冷启动约 6 秒（索引 + 两个 10000 行的 shard）。首屏最多等这么久，
// 超时就先给首页推荐并让抓取在后台继续，否则打开技能市场会像卡死一样。
const CATALOG_WAIT_MS = 12000;

async function loadSkillsShCatalog(cache) {
  const cached = cache ? await cache.get(SKILLS_SH_CATALOG_KEY, SKILLS_SH_CATALOG_TTL) : undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const fetching = skillsShCatalog(cache);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_WAIT_MS);
  });
  try {
    const winner = await Promise.race([fetching.catch(() => null), timeout]);
    if (Array.isArray(winner) && winner.length > 0) return winner;
  } finally {
    clearTimeout(timer);
  }
  // 让后台把目录抓完写进缓存，下次打开（或下一次翻页）就是全量了。
  void fetching.catch(() => {});
  return null;
}

async function browseSkillsSh({ query = "", page = 1, pageSize = 24, cache, sort = "" } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  let catalog = await loadSkillsShCatalog(cache);
  let hint;
  if (!catalog) {
    catalog = await skillsShHighlights(cache);
    hint = "skills.sh 全量目录（约 2 万条）正在后台载入，首次约需 1 分钟；现在先显示首页推荐，稍后再点「加载更多」即可翻到更多";
  }
  const needle = String(query || "").trim().toLowerCase();
  const matched = needle
    ? catalog.filter((row) => `${row.owner}/${row.slug}`.toLowerCase().includes(needle))
    : catalog;
  // 切页前排序。必须排**副本**：无查询时 matched === catalog，就地排序会污染模块缓存，
  // 导致同一次会话里后续调用拿到已被重排的目录（实测：sort 改变了默认顺序）。
  const ordered = sortSkillsShRows(matched.slice(), sort);
  const items = pageSlice(ordered, p, size).map(skillsShCard);
  // 首页/sitemap 都不带描述：先读 SKILL.md 头，落空的再读 skills.sh 详情页的 meta。
  // 整段有总时间预算，超时就先发卡片（描述退回通用文案），面板不会为此转圈。
  await withDeadline(
    (async () => {
      try {
        // 详情页 meta 一次请求就有准确简介（concurrency 8，24 条约 3 秒）。
        await enrichPageDescriptions(items, cache, 8);
      } catch {
        // 详情页读不到就退回通用文案
      }
      try {
        // 少数详情页也没有 meta 时，再读仓库里的 SKILL.md 头（顺带补出 skillDir）。
        const missing = items.filter((item) => !item.description);
        if (missing.length > 0) await enrichSkillsShFast(missing, cache, 8);
      } catch {
        // descriptions are best-effort: a failed read never blocks the list
      }
    })(),
    DESCRIPTION_BUDGET_MS,
  );
  fillMissingDescriptions(items);
  return { source: "skills.sh", items, total: matched.length, totalPages: Math.max(1, Math.ceil(matched.length / size)), hasMore: p * size < matched.length, hint };
}

/** skills.sh exposes a real JSON search API (Algolia-backed). */
/** skills.sh 上游行排序（切页之前调用）。 */
function sortSkillsShRows(rows, sort) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  if (sort === "installCount") {
    // search API 的字段就叫 installs（实测 id,source,skillId,name,installs）；
    // 旧代码读 installCount ?? downloads → 恒 undefined → 排序静默退化成不排序。
    const v = (r) => Number(r.installs ?? r.installCount ?? r.downloads) || 0;
    return rows.sort((a, b) => v(b) - v(a));
  }
  if (sort === "name") {
    return rows.sort((a, b) => String(a.slug || a.name || "").localeCompare(String(b.slug || b.name || "")));
  }
  return rows;
}

// 上游单次硬顶：实测 2026-11-22 q=test/code/pdf 在 limit=200 与 limit=500 下都回 200 行，
// q=agent 回 144 行 —— 200 是「取不到的就不存在」的窗口上限，不是目录总数。
// 这个数只用于「请求窗口是否已撞顶」的判定，永远不参与对外报告的计数。
const SKILLS_SH_WINDOW_CAP = 200;

async function searchSkillsSh({ query = "", page = 1, pageSize = 24, cache, sort = "" }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  // The upstream search API rejects queries shorter than 2 characters; an empty box is a
  // legitimate state, so browse the (whole) catalogue instead.
  if (q.length < 2) return browseSkillsSh({ query: q, page: p, pageSize: size, cache, sort });
  // 上游没有 offset：只能一次取到第 p 页的深度，再在本地切出最后一屏。
  // 窗口多要 1 条：只有真的拿得到第 size*p+1 条，才有资格说「还有下一页」；
  // 少给一条就说明集合见底，此时行数是**精确总数**而不是下界。
  const probe = size * p + 1;
  const depth = Math.min(SKILLS_SH_WINDOW_CAP, probe);
  const url = `https://www.skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${depth}`;
  // 上游每次现算：同一查询短时内复用结果，重复搜索从 ~3s 降到 ~0ms。
  const searchKey = `skillssh:search:${q.toLowerCase()}:${depth}:${sort || ""}`;
  let data = cache ? await cache.get(searchKey, 5 * 60 * 1000) : undefined;
  if (!data) {
    data = JSON.parse(await fetchText(url, 40000));
    if (cache && Array.isArray(data.skills) && data.skills.length) await cache.put(searchKey, data);
  }
  const rows = Array.isArray(data.skills) ? data.skills : [];
  sortSkillsShRows(rows, sort);
  const items = rows.slice((p - 1) * size, p * size).map((raw) => {
    const sourceRepo = String(raw.source || raw.id || "").split("/").slice(0, 2).join("/");
    const slug = raw.skillId || raw.name || String(raw.id || "").split("/").pop();
    return {
      id: `skills.sh:${raw.id || `${sourceRepo}/${slug}`}`,
      slug,
      name: raw.name || slug,
      description: "",
      source: "skills.sh",
      sourceLabel: "skills.sh",
      owner: sourceRepo,
      homepage: `https://www.skills.sh/${sourceRepo}/${slug}`,
      upstreamUrl: sourceRepo,
      skillDir: "",
      installs: Number(raw.installs) || 0,
      installable: true,
    };
  });
  await withDeadline(
    (async () => {
      try {
        // The search API has no description field; the skill page's own meta text does.
        await enrichSkillsShFast(items, cache, 10);
        await enrichPageDescriptions(items.filter((item) => !item.description).slice(0, 10), cache, 6);
      } catch {
        // descriptions are best-effort
      }
    })(),
    DESCRIPTION_BUDGET_MS,
  );
  fillMissingDescriptions(items);
  // hasMore 与 total 同源于证据（旧写法用 rows.length >= depth 单独判「还有下一页」，
  // 于是正好取满一页就被说成还有下一页，还把 depth+1 报成总数）：
  // 旧口径的两个缺陷（实测同一个 q=agent 翻页报 25/49/73/312/336）：
  //   ① data.count 恒等于本次返回的行数（limit=10/24/30/60 → count=10/24/30/60），
  //      它不是目录总数，却被 Math.max 当成总数报出去；
  //   ② 另一支用 (p-1)*size+rows.length 把「已经翻过的页」加进总数，
  //      同一个查询每翻一页就长大一截。两条都是拿页码算数，不是拿证据算数。
  // 现在只剩三种可证明的形态：
  //   ① 取到探针那条 ⇒ 确实还有下一页，但上游没有总数可报 ⇒ total 未知（未知保持未知）；
  //   ② 窗口内没取满 ⇒ 行数就是**精确总数**，与页码无关；
  //   ③ 撞上游硬顶 ⇒ 再取也不会更多，总数仍未知（200 不是目录总数，不能冒充计数），
  //      并把原因写进 hint（聚合层 :607 收 hint，面板按行显示）。
  let hasMore = false;
  const hitCap = depth >= SKILLS_SH_WINDOW_CAP && rows.length >= SKILLS_SH_WINDOW_CAP;
  let total;
  let hint = "";
  if (rows.length > size * p) {
    // 探针那条到手 ⇒ 下一页确实存在；上游没有总数 ⇒ 保持未知。
    hasMore = true;
    total = undefined;
  } else if (hitCap) {
    total = undefined;
    hint = "skills.sh 这一轮最多返回 " + SKILLS_SH_WINDOW_CAP +
      " 条，已经取满；后面还有没有结果、有多少结果，上游不给数，所以这里报不出来。换个更具体的关键词能看到别的结果";
  } else {
    // 窗口内没取满 ⇒ 行数就是这个查询的完整集合，精确总数，与页码无关。
    hasMore = false;
    total = rows.length;
  }
  return { source: "skills.sh", items, total, hasMore, hint };
}

/**
 * Parse a skills.sh page URL into its owner/repo + skill name without fetching the page.
 * The page URL shape is `https://www.skills.sh/<owner>/<repo>/<slug>` (see SKILLS_SH_URL_RE).
 * The install target is the `owner/repo` GitHub repo with skill dir `slug`, which matches
 * what the page's `npx skills add <repo> --skill <slug>` command resolves to, so when the
 * URL matches this shape we can skip the 25-second page fetch entirely. Returns null when
 * the URL does not match (caller should fall back to resolveSkillsShInstall).
 */
export function lookupSkillShRepo(url) {
  const match = SKILLS_SH_URL_RE.exec(String(url || ""));
  if (!match) return null;
  return { repo: `${match[1]}/${match[2]}`, skill: match[3] };
}

/**
 * Fast-path install resolution for skills.sh: first try the local URL parse (zero network),
 * then the on-disk resolved cache, and only fetch the page when both miss.
 */
export async function resolveSkillsShInstall(url, cache) {
  const direct = lookupSkillShRepo(url);
  if (direct) return direct;
  const key = `skills_sh_resolve_${String(url).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)}`;
  if (cache) {
    const cached = await cache.get(key, SKILLS_SH_CATALOG_TTL);
    if (cached && cached.repo && cached.skill !== undefined) return { repo: cached.repo, skill: cached.skill };
  }
  const page = await fetchText(url, 25000);
  const command = page.match(/npx\s+skills\s+add\s+(\S+)(?:\s+--skill\s+(\S+))?/);
  if (!command) throw new Error("skills.sh 页面没有给出安装命令，可能页面结构已变化");
  const repoUrl = command[1];
  const skill = String(command[2] || "").split("<")[0].split(/[\s"']/)[0].trim();
  const repo = repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "");
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`无法从安装命令解析仓库：${repoUrl}`);
  const result = { repo, skill };
  if (cache) await cache.put(key, result);
  return result;
}

// ------------------------------------------------------------------ browse.sh
/** browse.sh exposes the whole catalogue with title, description, category and tags. */
async function searchBrowseSh({ query = "", page = 1, pageSize = 24, cache, sort = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  let rows = cache ? await cache.get("browse_sh_api", 30 * 60 * 1000) : undefined;
  if (!rows) {
    const data = JSON.parse(await fetchText("https://browse.sh/api/skills", 25000));
    rows = Array.isArray(data.skills) ? data.skills : [];
    if (rows.length && cache) await cache.put("browse_sh_api", rows);
  }
  const q = String(query || "").trim().toLowerCase();
  const matched = [];
  for (const raw of rows) {
    const hay = `${raw.title || ""} ${raw.description || ""} ${raw.slug || ""} ${(raw.tags || []).join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    matched.push({
      id: `browse.sh:${raw.slug}`,
      slug: raw.name || String(raw.slug || "").split("/").pop(),
      name: raw.title || raw.name || raw.slug,
      description: raw.description || "",
      category: raw.category || "",
      tags: raw.tags || [],
      source: "browse.sh",
      sourceLabel: "browse.sh",
      owner: raw.hostname || "",
      homepage: `https://browse.sh/skills/${raw.slug}`,
      upstreamUrl: "",
      skillDir: "",
      reference: raw.slug,
      // 上游字段叫 installCount（实测 459/479 条有值），是真安装数 → 名称与字段一致，
      // 保留 installCount 键；去掉 ?? raw.downloads 回落，避免缺字段的行显示下载数冒充安装数。
      installs: Number(raw.installCount) || 0,
      updated: raw.updated || "",
      installable: true,
      note: "通过官方 browse CLI 安装（npx browse skills add）",
    });
  }
  // browse.sh 一次返回整份目录（约 480 条），本地切片即可真正翻页。
  // 排序在完整 matched 集合上做（不是窗口）：这就是真实全盘排序。
  // 479 条一次全给 → 本地排 = 真实全盘排（不是窗口近似）。
  // 上游原生字段：installCount、updated（实测 2026-05-19 等）。
  if (sort === "installCount") {
    matched.sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0));
  } else if (sort === "updated") {
    matched.sort((a, b) => (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0));
  } else if (sort === "name") {
    matched.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  const items = pageSlice(matched, p, size);
  // Web API 无结果且带查询词 → 用官方 browse CLI（真 JSON）复核；仅 API 故障/无结果时启用。
  if (items.length === 0 && q) {
    try {
      const isWin = process.platform === "win32";
      const cliPkg = "browse", cliArgs = ["skills", "find", q, "--json", "--limit", String(size)];
      const cmd = isWin
        ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", "npx -y " + cliPkg + " " + cliArgs.map((a) => JSON.stringify(a)).join(" ")]
        : ["npx", "-y", cliPkg, ...cliArgs];
      const text = await new Promise((resolve, reject) => {
        execFile(cmd[0], cmd.slice(1), { timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
          if (err) reject(new Error("browse CLI 失败：" + String((stderr || err.message || "")).slice(0, 160)));
          else resolve(String(stdout || ""));
        });
      });
      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      const cliRows = Array.isArray(parsed.skills) ? parsed.skills : [];
      if (cliRows.length) {
        const cliItems = cliRows.map((raw) => ({
          id: "browse.sh:" + raw.slug,
          slug: raw.name || String(raw.slug || "").split("/").pop(),
          name: raw.title || raw.name || raw.slug,
          description: raw.description || "",
          category: raw.category || "",
          tags: raw.tags || [],
          source: "browse.sh",
          sourceLabel: "browse.sh",
          owner: raw.hostname || "",
          homepage: "https://browse.sh/skills/" + raw.slug,
          upstreamUrl: "",
          skillDir: "",
          reference: raw.slug,
          installable: true,
          note: "通过官方 browse CLI 安装（npx browse skills add）；本次结果来自 CLI 备用通道",
        }));
        if (cache) await cache.put("browse_sh_api", items.length ? rows : cliRows);
        // 0.5.144（D6）：CLI 只 --limit size，窗口条数不是目录总数；取满即如实说「还有取不到的」。
        return { source: "browse.sh", items: cliItems, total: undefined, hasMore: cliItems.length >= size, hint: "browse.sh Web API 无结果，结果来自官方 CLI；CLI 单次最多返回 " + size + " 条，窗口之外取不到也不计数" };
      }
    } catch (cliErr) {
      matched.hint = "browse.sh Web API 与官方 CLI 均无结果或不可达";
    }
  }
    return { source: "browse.sh", items, total: matched.length, hasMore: p * size < matched.length };
}

// 没带 cache 时（例如 agent 直接调 skill_market_search 工具）退回进程级临时目录缓存。
// 必须用 os.tmpdir()：process.env.TEMP 在某些进程（如 CI、无环境注入的调用）中是空的，
// 旧写法会退化成字面量 "undefined\\temp\\..." 并让 mkdtemp 直接 ENOENT。
const fallbackCache = makeCache(join(safeTempDir(), "dsh-market-cache"));


// 排序能力矩阵见 src/sort-capability.js（唯一事实源，实测得出）。

/** 该源的该项排序是否有真实数据支撑。 */

/**
 * 安装参考的统一口径：每个源在自己的 handler 里产出 installRef，
 * 客户端只读这一个字段，不再堆叠 per-source 三元表达式（旧的 7 层链极易静默失败）。
 *
 * 各源形态：
 *   skills.sh  owner="owner/repo"  + skillDir=slug
 *   clawhub    installRef 已是 "owner/slug"（CLI 直吃）
 *   github 系  upstreamUrl="owner/repo"（+ ref/skillDir 可选）
 *   modelscope id="modelscope:owner/name"
 */
export function installRefOf(item) {
  if (!item) return "";
  const source = String(item.source || "");
  if (item.installRef) return String(item.installRef);
  if (source === "skills.sh") return String(item.installRef || item.homepage || item.owner || "");
  if (source === "clawhub") return String(item.installRef || item.upstreamUrl || item.slug || "");
  if (source === "modelscope") return String(item.modelScopeIdent || String(item.id || "").replace(/^modelscope:/, ""));
  if (source === "skillhub") return String(item.upstreamUrl || item.slug || item.id || "");
  if (source === "browse.sh") return String(item.upstreamUrl || item.reference || item.slug || "");
  if (source === "lobehub") return String(item.reference || item.upstreamUrl || item.slug || "");
  return String(item.upstreamUrl || item.id || "");
}

export const supportsSort = capabilitySupports;
export { sortKeysFor };

/** 排序与展示使用同一个取值口径，避免「排了但看起来没排」。 */
export function sortKeyOf(item, sort) {
  if (!item) return 0;
  if (String(sort) === "installCount") return Number(item.installs) || 0;
  if (String(sort) === "name") return String(item.name || item.slug || "");
  return 0;
}

export const ALL_SOURCES = [
  "skills.sh",
  "clawhub",
  "skillsmp",
  "trusttools",
  "browse.sh",
  "lobehub",
  "skillhub",
  "modelscope",
];


const SOURCE_HANDLERS = {
  "skills.sh": searchSkillsSh,
  clawhub: searchClawHub,
  skillsmp: searchSkillsMp,
  trusttools: searchTrustTools,
  "browse.sh": searchBrowseSh,
  "lobehub": searchLobeHubSkills,
  skillhub: searchSkillHub,
  modelscope: searchModelScope,
};

// 「其他」分类逐类取数（tail）：面板把窗内未覆盖的分类 slug 列表随 harvest.start 下发，
// 服务端按 slug 逐类向**该源**取数。两个上限都是护栏而非功能：400 项防住异常长的下发，
// 并发 4 防住 214 类全并发把上游打死（lobehub 单类实测 4.4~11.8s，走的是 npx CLI）。
const TAIL_CATEGORY_CAP = 400;
const TAIL_CONCURRENCY = 4;
// 0.5.186 逐类翻尽的单类页数护栏：撞到这里说明该类确实没翻完，如实记 windowed。
const TAIL_PAGE_CAP = 200;
// 哪个源能按分类取数、声明是服务端口径还是本地口径，唯一事实源在 src/category-capability.js
//（照 sort-capability.js 的实测纪律，缺表键按「不支持」保守处理）。

// tailCategories 归一化：非数组一律按空；每项 String + trim；去空串；去重；上限截断。
// index.js 与 harvest 会话两侧共用这一份（口径唯一），测试亦直接调用它。
export function normalizeTailCategories(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const rawItem of list) {
    const slug = String(rawItem == null ? "" : rawItem).trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= TAIL_CATEGORY_CAP) break;
  }
  return out;
}

/**
 * 逐类取数的源选择（唯一入口）：picked 里第一个「能力表声明支持分类」的源。
 * 注入 capableOf 是给判据用的自证通路 —— 测试用自己的谓词就能证明这条通路可达，
 * 不必把名单抄进测试。表外/无能力一律空串（不取数）。
 */
export function pickTailCategorySource(picked, capableOf) {
  const list = Array.isArray(picked) ? picked : [];
  const ok = typeof capableOf === "function" ? capableOf : (name) => categoryCapability(name).supportsCategory;
  return list.find((name) => ok(name)) || "";
}

// 短冷却只属于聚合路径（agent 的 source=all 搜索）：面板每个 tab 只有一个源，
// 把源永久拉黑会让用户「再点一次看看」直接吃空面板。时长从字面量提为具名常量，
// 便于源码锁判定归属（test-search-latency-recovery Test 5/Test 7）。
const AGGREGATE_COOLDOWN_MS = 120000;

// 每源预算的默认值与可配置表。默认表为空 ⇒ 每个源拿到的预算与 DEFAULT_BUDGET_MS 逐毫秒相同，
// 也就是说这套机制启用与否不改变任何用户可见结果（items/total/超时文案里的秒数都不动）。
// 要调某个源就在表里写名字，或在调用处传 budgetOverrides（测试与灰度用）。
const DEFAULT_BUDGET_MS = 12000;
const SOURCE_BUDGET_OVERRIDES = {};

// 解析某个源本轮实际可用的预算：表里没有该源（或值不是正数）就原样返回调用方的预算。
const budgetFor = (name, budgetMs, overrides) => {
  const table = overrides || SOURCE_BUDGET_OVERRIDES;
  const v = table ? table[name] : undefined;
  return typeof v === "number" && v > 0 ? v : budgetMs;
};

// 在途合并键里的预算段：没有任何源被改预算时必须逐字符等于旧写法 String(budgetMs)，
// 否则合并命中率会在默认路径上白白掉下去（Test 8 锁这一条）。
const budgetKey = (names, budgetMs, overrides) => {
  let same = true;
  for (const n of names) { if (budgetFor(n, budgetMs, overrides) !== budgetMs) { same = false; break; } }
  return same ? String(budgetMs) : names.map((n) => budgetFor(n, budgetMs, overrides)).join(",");
};

/**
 * 并发拉取多个来源，并按 names 顺序折叠结果。
 *
 * 为什么要它：聚合搜索原来是 for (const name of wanted) { await handler(...) } —— 串行，
 * 总耗时等于各源之和；一个不可达源会把它自己的 20s fetch 超时全额加到用户等待上
 * （本机实测：8 源聚合 >20s，单源 skills.sh 7.1s / clawhub 2.1s / lobehub 4.8s）。
 * 并发后总耗时接近最慢的那一个源。
 *
 * budgetMs 给每个源单独设上限：超预算的源记为 degraded 并写明超时，不再拖住整次搜索。
 * 需要按源区分时用 budgetOverrides（或表里预置的名字）——解析只发生在 settle 与文案两处，
 * 默认表为空时每个源拿到的预算等于 budgetMs，可见结果逐条不变。
 * results 与 degraded 都按 names 顺序输出 —— 并发完成先后不能影响展示顺序，
 * 否则同一条件搜两次会得到不同的列表。
 *
 * cooldownMs 默认 0 = 本函数不冷却任何源。冷却是聚合路径的专属策略，由调用方
 * （fanOnce 在 picked.length > 1 时）显式传入；面板单源路径因此每次搜索都会真打
 * 上游，不会因为上一次超时就在窗口内被静默跳过。
 */
export async function fanOutSources({ names, run, budgetMs = DEFAULT_BUDGET_MS, cache = null, cooldownMs = 0, cooldownKey = "", budgetOverrides = null, onSettled = null }) {
  const list = Array.isArray(names) ? names : [];
  const cooldownPrefix = cooldownKey ? "market_src_timeout:" + cooldownKey + ":" : "market_src_timeout:";
  const cooling = async (name) => {
    if (!cache || !(cooldownMs > 0)) return false;
    try { return Boolean(await cache.get(cooldownPrefix + name, cooldownMs)); } catch { return false; }
  };
  const markCooldown = async (name) => {
    if (!cache || !(cooldownMs > 0)) return;
    try { await cache.put(cooldownPrefix + name, true); } catch {}
  };
  const settle = (name) => {
    const base = Promise.resolve().then(() => run(name)).then(
      (result) => ({ result }),
      (error) => ({ error: String(error && error.message ? error.message : error) }),
    );
    // onSettled 为 null（skills.search 的既有路径）时 work 就是 base 本身：一个微任务都不多走，
    // 行为与改动前逐字节相同。只有 harvest 传回调时才挂上「某源一落地就推送」这层链。
    const work = onSettled ? base.then((box) => {
      try { onSettled(name, box); } catch { /* 回调自己出错绝不影响 fan-out 的结算 */ }
      return box;
    }) : base;
    const b = budgetFor(name, budgetMs, budgetOverrides);
    if (!(b > 0)) return work;
    let timer = null;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), b); });
    return Promise.race([work, guard]).finally(() => clearTimeout(timer));
  };
  const cooldownNow = await Promise.all(list.map(cooling));
  // 不做「names 里同名去重复用」：picked 来自 wanted（ALL_SOURCES 去重集 / handlers 的对象键），
  // 永远不含重复名，那 3 行是测不到的死分支（M5 反向破坏 29 passed 0 failed 证实）。
  // 真正需要的合并是跨调用同条件只打一次上游，见下面 fanOnce 的 inflight 表。
  const settleWith = (name, i) => (cooldownNow[i] ? Promise.resolve({ cooldown: true }) : settle(name));
  const settled = await Promise.all(list.map((name, i) => settleWith(name, i)));
  // 只有真的等满预算才写冷却记忆；抛错与真实空结果绝不进冷却（recover 套件 Test 2）。
  await Promise.all(settled.map(async (box, i) => {
    if (box && box.timeout && !cooldownNow[i]) await markCooldown(list[i]);
  }));
  const results = [];
  const degraded = [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    const box = settled[i];
    if (box && box.cooldown) {
      const message = '来源响应超时（预算 ' + Math.round(budgetFor(name, budgetMs, budgetOverrides) / 1000) + 's），已跳过（冷却中，本轮不再重试）';
      degraded.push({ source: name, error: message });
      results.push({ name, ok: false, result: null, error: message });
      continue;
    }
    if (box && box.timeout) {
      const message = '来源响应超时（预算 ' + Math.round(budgetFor(name, budgetMs, budgetOverrides) / 1000) + 's），已跳过';
      degraded.push({ source: name, error: message });
      results.push({ name, ok: false, result: null, error: message });
      continue;
    }
    if (box && box.error) {
      degraded.push({ source: name, error: box.error });
      results.push({ name, ok: false, result: null, error: box.error });
      continue;
    }
    results.push({ name, ok: true, result: box ? box.result : null });
  }
  return { results, degraded };
}

// 在途合并：同条件（query/来源/页码/页大小/排序/分类/预算）的并发调用共享同一次上游
// fan-out —— 面板切页或重复提交不再把同一批上游打两遍。合并只在「在途」窗口内成立，
// settle 后立即清除，因此不是缓存：结束后的下一次调用会重新取数。各调用方拿到同一个
// fan 对象后各自折叠，items 数组互不共享。
const inflight = new Map();

// 面板与工具的单源路径没有任何超时预算：慢源必须等到真返回或真网络失败（用户 2026-11-24
// 口径「不管快慢，都得等待面板加载完毕」）。预算截断只属于 picked.length > 1 的聚合路径；
// 单源传 0 让 settle 走 !(b > 0) 的无预算分支，超时文案与冷却标记都无从触发。
async function fanOnce({ query, source, cache, sort, category, handlers, budgetMs, effectiveSort, p, size, picked, budgetOverrides }) {
  const aggregate = picked.length > 1;
  const fanBudget = aggregate ? budgetMs : 0;
  const fanOverrides = aggregate ? budgetOverrides : null;
  const key = [
    handlers ? "test" : "live",
    String(query == null ? "" : query),
    String(source || "all"),
    String(p),
    String(size),
    String(sort || ""),
    String(category || ""),
    budgetKey(picked, fanBudget, fanOverrides),
  ].join("\u0001");
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = (async () => {
    return await fanOutSources({
      names: picked,
      budgetMs: fanBudget,
      budgetOverrides: fanOverrides,
      cache,
      cooldownMs: aggregate ? AGGREGATE_COOLDOWN_MS : 0,
      cooldownKey: String(query == null ? "" : query).trim().toLowerCase(),
      run: (name) => {
        const handler = (handlers && handlers[name]) || SOURCE_HANDLERS[name];
        return handler({ query, page: p, pageSize: size, cache, sort: effectiveSort, category });
      },
    });
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

// ── 空结果与取数失败必须区分开（逐源实测的 S1 缺陷）──────────────────────────
// 旧判据把「查询词非空」当成用户在搜索，于是一次上游超时会被面板说成「没有找到匹配的
// 技能」。真实失败有四种形态（0.5.161 逐源 sweep 取证）：撞满预算的超时、上游 HTTP 4xx、
// 取数脚本异常（python traceback）、纯网络连接失败。它们必须各说一句实话，且绝不把多行
// 原始输出原样塞进面板：先折叠成一行，再按已知形态归类，截断只是兜底、不是归类手段。
const FAILURE_DETAIL_CAP = 56;
const FAILURE_LINE_CAP = 80;
const onelineFailure = (text) => String(text == null ? "" : text)
  .replace(/[\r\n\t]+/g, " ")
  .replace(/ {2,}/g, " ")
  .trim();

// 单个来源的失败归类。超时文案由 fanOutSources 写好（「来源响应超时（预算 Ns），已跳过」，
// 秒数是该源自己那份预算），这里原样转述、绝不改写数字；其余形态各归各的原因。
const classifyFailure = (errorText) => {
  const msg = onelineFailure(errorText);
  if (/响应超时/.test(msg)) return msg.replace(/^来源/, "");
  const http = msg.match(/HTTP\s+(\d{3})/i);
  if (http) return "上游返回 HTTP " + http[1] + "（该来源拒绝或找不到这次请求）";
  if (/取数脚本|Traceback|urlopen|urllib/.test(msg)) return "该来源的取数脚本异常，未取到数据";
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|getaddrinfo|network/i.test(msg)) {
    return "网络连接失败，该来源不可达（" + (msg.length > FAILURE_DETAIL_CAP ? msg.slice(0, FAILURE_DETAIL_CAP) : msg) + "）";
  }
  if (/非 JSON|形态不符|SyntaxError|Unexpected token/.test(msg)) return "上游响应形态不符（不是可解析的数据）";
  return msg ? (msg.length > FAILURE_DETAIL_CAP ? msg.slice(0, FAILURE_DETAIL_CAP) : msg) : "本轮未取到数据（上游未给出原因）";
};

// 一条完整披露 = 源名 + 归类后的原因；整行再兜一次上限，保证面板单行可读。
const describeFailure = (sourceName, errorText) => {
  const line = sourceName + "：" + classifyFailure(errorText);
  return line.length > FAILURE_LINE_CAP ? line.slice(0, FAILURE_LINE_CAP) : line;
};

// 一次性搜索与 harvest 终态共用同一套折叠口径（0.5.174 run3）。搬进这里的内容：逐源条目折入
// （installRefOf）、聚合排序兜底、skills.sh 描述补全、空结果逐源点名、总数/页数反推、
// 分类本地兜底。为什么只能有一份：面板会把 harvest 的终态行直接渲染成列表，两条通路各写
// 一遍折叠就会让同一个 query 得到两种顺序、两种描述完整度 —— 那是本项目从 0.5.101 起反复
// 判死的「同一次动作两种结果」。唯一性由 test/test-harvest.mjs Test 7 的源码锁钉住。
export async function foldFanResults({ entries, wanted, degraded, query, p, size, category, cache, effectiveSort }) {
  const items = [];
  const hints = [];
  let total = 0;
  // handler 显式声明「我不知道总数」的标记（见下面 srcItems 分支的注释）。
  let totalUnknown = false;
  let pagesSum = 0;
  // D1（页数谎言）：源自己声明了有限 totalPages，并且该声明对「还能走多远」是权威的 ——
  // 要么明说 hasMore===false（集合到底），要么自报 windowed===true（skillsmp 窗口硬封顶：
  // 首页 hasNext 依旧为 true，但 maxResults/totalAll 已说死只有 depth 页可走）。聚合 pages
  // 不得越过这类声明的深度之和，否则 ceil(上游目录总数/页大小) 会把 20 页的窗口报成 22746 页。
  let closedDepth = 0;
  let windowedDepth = false;
  let pagesUnknown = false;
  let hasMore = false;
  // facet 计票：只有**取到数据的源**参与，全部明说 serverFacet===true 才算这一页已被服务端筛过。
  // 失败源没有贡献条目，所以不进分母；handler 不提这个字段（六个旧源都是）一律按 false 计。
  let facetAnswered = 0;
  let facetConfirmed = 0;
  // 分类能力声明位：handler 明说「本行都带分类信息」时置真（见 extra-sources.js 的 categoryInfo）。
  // 与 facetAnswered 同座，因为两者都是「逐源听声明」，不是「看这一页凑到什么」。
  let declaredCategoryInfo = false;
  for (const entry of entries) {
    if (!entry.ok) {
      // 取数失败的源什么也没告诉我们 —— 它既不能证明目录为空，也不能证明只有 1 页。
      // 旧写法在这里直接 continue，于是 pagesSum 停在 0、pages 落到 Math.max(..., 1)
      // 的兜底上：一次上游超时被报成「共 1 页 / 共 0 个」，而同一视图的下一页（成功那次）
      // 又是 pages=undefined —— 一个情况两种口径。单源失败时把两处未知标记都立起来，
      // 让「失败」与「空目录」在返回值上不再可混淆。多源聚合部分失败时保持既有口径：
      // 成功源照报数字，坏源只进 degraded（聚合的计数语义由 Test 4 锁住）。
      if (wanted.length === 1) {
        pagesUnknown = true;
        totalUnknown = true;
      }
      continue;
    }
    const name = entry.name;
    const result = entry.result;
    if (result && result.hint) hints.push(name + '：' + result.hint);
    facetAnswered++;
    if (result && result.serverFacet === true) facetConfirmed++;
    if (result && result.categoryInfo === true) declaredCategoryInfo = true;
    const srcItems = result && Array.isArray(result.items) ? result.items : [];
    if (srcItems.length) items.push(...srcItems.map((it) => ({ ...it, installRef: installRefOf(it) })));
    const srcTotal = Number(result && result.total) || 0;
    total += srcTotal;
    // clawhub 这类 cursor 无界流的 handler 会把 total/totalPages 显式置 undefined 来表示
    // 「未知」（extra-sources.js:253-260 明确写着不许谎报下界）。undefined 不是「没报总数」，
    // 聚合层必须记住这个区别，否则下面的兜底会把未知伪装成随页码增长的计数
    // （实测 page=1 total=13、page=60 total=721）。
    if (result && result.total === undefined && srcItems.length) totalUnknown = true;
    // 页数判定：handler 给了数字就用它；没给但有真实 total 就用 total 反推；
    // 两者都没有（clawhub 无界流把 total/totalPages 都置 undefined）才算「未知」。
    const declared = result && typeof result.totalPages === "number" ? Number(result.totalPages) : null;
    // catalogProgressive：这一页来自「还能一直往后取」的顺序游标目录。它的 total 是整面目录的
    // 条数，但已取回的行远少于它，用 ceil(total/size) 反推页深等于凭空造出两万页——页深只能由
    // 目录自己报（取全后 handler 才给数字），这里如实算「未知」。
    const srcPages = result && result.catalogProgressive === true ? null
      : declared !== null ? declared
      : srcTotal > 0 ? Math.ceil(srcTotal / size)
      : null;
    if (srcPages === null) pagesUnknown = true;
    else pagesSum += srcPages;
    // hasMore===true / undefined 且没声明窗口的源不参与夹取：那种源的 total 反推仍然合理
    // （对照测试：totalPages=615 & hasMore=true 时不得夹到 615 以下）。
    if (declared !== null && Number.isFinite(declared) && declared >= 0 && result) {
      if (result.hasMore === false) closedDepth += declared;
      else if (result.windowed === true) { closedDepth += declared; windowedDepth = true; }
    }
    if (result && result.hasMore) hasMore = true;
  }
  // 本地排序兜底只对**多源聚合**生效（既有契约 extra-sources.js:223：单源排序责任在
  // handler，dispatcher 只负责把各源结果合并后再排一次）。两个缺陷都在这几行：
  //   ① 判据用原始 sort 而不是 effectiveSort —— 557 行的注释说「该源没有对应数据时降级为
  //      不排序，保持上游顺序」，可 supportsSort 为假时 effectiveSort 是空串，这里却照排
  //      不误，等于把注释承诺的降级行为直接推翻；
  //   ② 单源路径上游已经服务端全盘排好，dispatcher 再 localeCompare 一遍会改乱它
  //      （实测上游 sort=name 是码位序 Zeta,alpha,…，被重排成 alpha,…,Zeta）。
  // 判据是 wanted.length 与 effectiveSort 这两个既有语义，不是任何阈值。
  const aggregateSort = wanted.length > 1 ? effectiveSort : "";
  if (aggregateSort === "installCount") {
    items.sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0));
  } else if (aggregateSort === "name") {
    items.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  // skills.sh entries get their description from the skill page; browse.sh ships one.
  try {
    const missing = items.filter((item) => item.source === "skills.sh" && !item.description);
    if (missing.length) await enrichSkillsShFast(missing, cache, 10);
  } catch {
    // best-effort: a failed description never blocks the list
  }
  // An empty browsing page is almost never "no matches" — it is an upstream that timed out
  // or refused us. Say so instead of showing a blank market, and name the sources that
  // failed so the user can tell "nothing here" from "could not reach it".
  // 空列表 + 有源失败 = 上游问题，必须逐源点名。这一条与查询词是否为空无关：旧写法把
  // 「查询词非空」排除在外，于是「搜 pdf 而 trusttools 撞满预算」被面板说成「没有找到匹配
  // 的技能」——那是把网络故障谎报成内容不存在。全源正常返回空才是真的没有匹配。
  const sourceErrors =
    items.length > 0
      ? []
      : degraded.length
        ? degraded.map((entry) => describeFailure(entry.source, entry.error))
        : hints.length
          ? hints.map((entry) => onelineFailure(entry))
          : String(query || "").trim()
            ? ["没有找到匹配的技能。"]
            : ["所选市场暂时没有取到数据，可能是上游不可达或响应超时，请稍后重试"];
  // 反推兜底只在「本页确实有货、上游却没报总数」时成立。items=0 时补 (p-1)*size
  // 会凭空造数：trusttools 每页超时（items=0、total=0）时 total 竟随页码涨成 12/24 ——
  // 一个条目都没有却报「共 24 个」，属于计数与真实集合不符的口径缺陷。
  if (items.length > 0 && !totalUnknown && (!total || total < items.length)) total = hasMore ? p * size + 1 : (p - 1) * size + items.length;
  // 分类筛选：无 category 的源无法参与，如实告知而不是静默返回全量。
  const catNeedle = String(category || "").trim();
  // 服务端 facet：这一页本身就是上游按分类筛出来的集合，本地再过滤一遍只有两种坏结果——
  // 重复筛（无害但白算）或把上游回填不一致的条目误删（有害）。所以只在没拿到 facet 确认时
  // 才走下面那段「仅当前页」的本地兜底过滤。
  const serverFacet = catNeedle !== "" && catNeedle !== "all" && facetAnswered > 0 && facetConfirmed === facetAnswered;
  // 「这个源提不提供分类信息」得听 handler 的声明，不能只看这一页凑没凑到分类行：
  // modelscope 每行都带 L1.ChineseName（categoryInfo=true），但服务端 facet 实测不成立、
  // 过滤在客户端做，小分类的深页合法地回 0 条 —— 只看页内样本会把「本类实测 0 条」
  // 谎报成「该源不提供分类信息」（0.5.164 判据：test/test-category-info-declaration.mjs）。
  const catSupported = items.some((item) => item.category) || (items.length === 0 && declaredCategoryInfo);
  // 「取数失败」与「该源不提供分类」是两件事，必须分开说：0.5.164 的 live 复验里 modelscope
  // 分类态撞满单次超时（handler 抛 abort）⇒ 没有 result ⇒ declaredCategoryInfo 仍为 false
  // ⇒ 旧口径把这次失败讲成「所选来源不提供分类信息」，而每行其实都带 L1.ChineseName。
  // 判据位：test/test-category-info-declaration.mjs Test 7。sourceErrors 已经逐源点名失败原因，
  // 这里只负责不再把失败翻译成内容不存在（也绝不谎称已按分类过滤）。
  const fetchFailedOnly = degraded.length > 0 && items.length === 0;
  let visible = items;
  let categoryNote = "";
  let filteredOut = 0;
  if (catNeedle && catNeedle !== "all" && !serverFacet) {
    if (fetchFailedOnly) {
      categoryNote = "所选来源本次取数失败或超时，未能确认该分类下的条目（这不等于该来源没有分类信息）";
    } else if (!catSupported) {
      categoryNote = "所选来源不提供分类信息，已忽略分类筛选";
    } else {
      visible = items.filter((item) => !item.category || item.category === catNeedle);
      filteredOut = items.length - visible.length;
      // 没有分类信息的条目是被**保留**的（严格过滤会让不提供分类的源整源消失，
      // 那是数据丢失而不是过滤），所以它们也在 visible 里。不写出来的话，用户选
      // douyin 看到 18 条会以为都是 douyin —— 实测正是这样（1 条 douyin + 17 条无分类）。
      const keptUncat = visible.filter((item) => !item.category).length;
      if (filteredOut > 0) {
        // 本地过滤只作用于当前页：上游的 total/pages 是按未过滤集合算的，
        // 继续沿用就是与实际不符的计数。重算为可见集合，并说明这是本地兜底过滤。
        total = visible.length + (p - 1) * size;
        pagesSum = Math.max(1, Math.ceil(total / size));
        pagesUnknown = false;
        hasMore = false;
        categoryNote = "分类为面板本地过滤（仅当前页），已过滤掉 " + filteredOut +
          " 项；分类过滤只作用于当前页，上游不提供过滤后的总数";
      }
      if (keptUncat > 0) {
        categoryNote = (categoryNote ? categoryNote + "；" : "") +
          "另有 " + keptUncat + " 项该源未标注分类，按「无分类不过滤」一并保留";
      }
    }
  }
  // 「未知」必须一路保持未知：numeric 累加量与对外报告值分开。
  // 若把未知塌成 0，客户端 Number(d.total) || rows.length 会把 0 冒充成「本页条数」，
  // 几千条的目录就显示成「共约 12 个」—— 与谎报下界同一类缺陷（本轮实测）。
  // 空页 + 没有总数证据时不得宣称「没有下一页」。本轮门内实测 trusttools 首页静默
  // 空（items=0、degraded=0、total=0），handler 的 hasMore 退化成 items.length>=size=false，
  // 聚合层便报「已是最后一页」—— 一次抓取失败被说成目录已到底，比谎报总数更糟。
  // false 只有在响应带真实总数证据时才是结论；否则保持 undefined（未知）。
  const reportedHasMore = items.length === 0 && total === 0 ? undefined : hasMore;
  const reportedTotal = totalUnknown && total === 0 ? undefined : total;
  const rawPages = Math.max(pagesSum, Math.ceil(total / size), 1);
  // 夹取条件：所有源都没说「还有下一页」（全闭合），或至少有一个源声明了窗口硬封顶
  // （windowed 源的 depth 就是权威可浏览深度，hasNext true 只表示窗口内还没走完）。
  // 两者都不成立的源不参与夹取，否则会把诚实的大页数（未闭合源）一起压掉。
  const pages = pagesUnknown && wanted.length === 1 ? undefined
    : (closedDepth > 0 && (!hasMore || windowedDepth) && rawPages > closedDepth ? closedDepth : rawPages);
  return {
    items: visible,
    categoryNote,
    serverFacet,
    filteredOut,
    page: p,
    pageSize: size,
    pages,
    total: reportedTotal,
    hasMore: reportedHasMore,
    hints,
    degraded,
    sourceErrors,
  };
}

export async function searchSkills({ query, source = "all", page = 1, pageSize = 24, cache = fallbackCache, sort = "", category = "", handlers = null, budgetMs = DEFAULT_BUDGET_MS, budgetOverrides = null }) {
  // 注入 handlers 时（测试态）"all" 展开为注入的源集合：否则 fake handler 会被 8 个真实
  // 源淹没，测试照样打真实网络 —— 那测的就不是并发语义，而是上游当时的心情。
  const wanted = source === "all" ? (handlers && Object.keys(handlers).length ? Object.keys(handlers) : ALL_SOURCES) : [source];
  // 该源没有安装量数据时，忽略按安装数排序（保持上游顺序），而不是打乱它
  // 该源没有对应数据时，降级为「不排序」而不是打乱上游顺序。
  let effectiveSort = "";
  if (sort && supportsSort(source, sort)) effectiveSort = sort;
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const picked = wanted.filter((name) => Boolean((handlers && handlers[name]) || SOURCE_HANDLERS[name]));
  // handlers 是测试注入点：fake handler 才能在没有网络、没有上游波动的情况下断言
  // 并发与顺序性质。生产路径 handlers 为 null，仍走 SOURCE_HANDLERS。
  const fan = await fanOnce({
    query, source, cache, sort, category, handlers, budgetMs, budgetOverrides,
    effectiveSort, p, size, picked,
  });
  const degraded = fan.degraded;
  // 折叠口径只住一份：一次性通路把 fan.results 交给 foldFanResults，harvest 终态把同样形状的
  // results 交给同一个函数。aggregateSort/enrichSkillsShFast 的既有源码锁读全文正则，搬进
  // 共用函数后照样命中（test-search-fanout-latency.mjs:177-178）。
  const folded = await foldFanResults({ entries: fan.results, wanted, degraded, query, p, size, category, cache, effectiveSort });
  return {
    items: folded.items,
    categoryNote: folded.categoryNote,
    serverFacet: folded.serverFacet,
    filteredOut: folded.filteredOut,
    page: folded.page,
    pageSize: folded.pageSize,
    pages: folded.pages,
    totalPages: folded.pages,
    total: folded.total,
    hasMore: folded.hasMore,
    degraded: folded.degraded,
    hints: folded.hints,
    sourceErrors: folded.sourceErrors,
  };
}

/**
 * Warm the catalogues that are expensive on a cold start (browse.sh ships ~480 entries,
 * skills.sh needs the ~2 MB sitemap, LobeHub's CLI search is a 30 s npx round-trip,
 * skillsmp is a paged upstream). Runs in the background so the first panel open is already populated.
 */
export async function warmMarketCache(cache = fallbackCache) {
  // 0.5.190：skillsmp 目录补链泵挂在这里——宿主起来就挂一次，之后每 SKILLSMP_PUMP_GAP_MS
  // 推进队列里的一面（队列由用户翻页 + 词表播种）。定时器 unref，不阻止进程退出；
  // 重复调用（test-nocache 无参也走到这里）由 startSkillsMpPump 内部幂等挡住。
  startSkillsMpPump(cache);
  const results = await Promise.allSettled([
    searchBrowseSh({ query: "", page: 1, pageSize: 24, cache }),
    searchLobeHubSkills({ query: "", page: 1, pageSize: 24, cache }),
    searchModelScope({ query: "", page: 1, pageSize: 24 }),
    skillsShCatalog(cache),
    warmClawHubCatalog(cache),
  ]);
  return results.map((r) => (r.status === "fulfilled" ? (Array.isArray(r.value) ? r.value.length : (r.value.items || []).length) : 0));
}

// ── 渐进式 harvest（0.5.174）───────────────────────────────────────────────
// harvest 与一次性搜索的分工：搜索受聚合预算（DEFAULT_BUDGET_MS 那一档）截断，慢源会被砍；
// harvest 的语义是「一边跑一边把已经取到的行推给面板」，所以
//   ① 只用它自己的 HARVEST_BUDGET_MS 上限（兜底，防一个永久挂起的源让会话永远不结束），
//      绝不复用 12s 那档预算 —— 行推送发生在每个源落地的瞬间（fanOutSources 的 onSettled）；
//   ② 单源失败或被截断都不会丢掉已完成源的行：行早就推出去了，失败只进 meta；
//   ③ 源展开与行折叠口径与 searchSkills 一致（同一套 wanted/picked 展开 + installRefOf），
//      因此「累计 poll 行集 == 一次性 skills.search 行集」是可断言的硬性质。
// 会话按 poll 滑动续期；未知或过期 id 由 poll 返回 null，dispatch 据此报 ok:false，
// 不认识这两个 op 的旧面板继续走 skills.search，互不影响。
export const HARVEST_BUDGET_MS = 3600000;

// 测试侧要拿「搜索那一档预算」做对照断言，但不想重复写默认值文本：
// test-search-latency-recovery.mjs:272 锁死 `budgetMs = DEFAULT_BUDGET_MS` 只允许出现两次。
export const DEFAULT_BUDGET_MS_FOR_TEST = DEFAULT_BUDGET_MS;

export function makeHarvestStore({ ttlMs = 120000, maxSessions = 8, budgetMs = HARVEST_BUDGET_MS } = {}) {
  const sessions = new Map();
  let seq = 0;
  const rowKeyOf = (item) => String(item && item.source) + "|" + String(item && item.slug);
  const sweep = () => {
    const now = Date.now();
    for (const entry of sessions) {
      if (entry[1].expiresAt <= now) sessions.delete(entry[0]);
    }
  };
  const metaOf = (s, withTail) => ({
    // finalMeta 只在收口时落（折叠口径的分页字段）；中间包没有它，meta 形状不变。
    // 0.5.184 withTail：poll 的中间包把逐类账本原样带下去，加载行才有真进度（start 首包
    // 仍不带——C2 锁首包 meta.tail===undefined，收口包走 finalMeta.tail）。
    ...(withTail && s.tail ? { tail: s.tail } : {}),
    ...(s.finalMeta || {}),
    degraded: s.degraded.slice(),
    sourceErrors: s.sourceErrors.slice(),
    hints: s.hints.slice(),
    page: s.page,
    pageSize: s.pageSize,
    sources: s.sources.slice(),
    rowCount: s.rows.length,
    settled: s.settled,
    totalSources: s.sources.length,
    budgetMs: s.budgetMs,
  });

  const start = async (opts) => {
    const o = opts || {};
    const query = o.query == null ? "" : String(o.query);
    const source = String(o.source || "all");
    const sort = String(o.sort || "");
    const category = String(o.category || "");
    const cache = o.cache === undefined ? fallbackCache : o.cache;
    const handlers = o.handlers || null;
    const p = Math.max(1, Number(o.page) || 1);
    const size = Math.max(1, Math.min(60, Number(o.pageSize) || 24));
    const ttl = Number.isFinite(Number(o.ttlMs)) ? Math.max(0, Number(o.ttlMs)) : ttlMs;
    const budget = Number(o.budgetMs) > 0 ? Number(o.budgetMs) : budgetMs;
    // 与 searchSkills 同口径：注入 handlers 时 "all" 展开为注入集合，测试态绝不打真实上游。
    const wanted = source === "all"
      ? (handlers && Object.keys(handlers).length ? Object.keys(handlers) : ALL_SOURCES)
      : [source];
    const picked = wanted.filter((name) => Boolean((handlers && handlers[name]) || SOURCE_HANDLERS[name]));
    const effectiveSort = sort && supportsSort(source, sort) ? sort : "";
    sweep();
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    seq += 1;
    const s = {
      id: "hv" + Date.now().toString(36) + "-" + seq.toString(36),
      rows: [],
      sent: 0,
      seen: new Set(),
      degraded: [],
      hints: [],
      sourceErrors: [],
      settled: 0,
      done: false,
      stage: "starting",
      page: p,
      pageSize: size,
      sources: picked.slice(),
      budgetMs: budget,
      ttlMs: ttl,
      expiresAt: Date.now() + ttl,
      waiters: [],
      boxes: new Map(),
      finalMeta: null,
    };
    sessions.set(s.id, s);
    const signal = () => {
      while (s.waiters.length) s.waiters.shift()();
    };
    // 「其他」成员集合（run 3）：tailList 非空时，任何行进入会话前必须过 tailAdmissible，
    // 扇出 push、逐类 push、收口并集三条路共用这同一个谓词；非 tail 会话恒放行（单类态/
    // all 态行集逐条不变）。判定只看「这一行能不能证明自己是合并集合的成员」：
    //   (1) 行内 category 命中 covers ⇒ 放行（扇出默认页里恰好属于合并类的行也是合法成员）；
    //   (2) 行内 category 不在 covers ⇒ 拒收（窗内别类的行挂到「其他」标签下就是谎报）；
    //   (3) category 为空/缺失 ⇒ 只有来自已作证逐类取数的行放行（正证门已确认该类被上游接受，
    //       整类归因成立）；扇出默认页的无分类行一律拒收 —— 与面板 client.js:2293「unknown 不是
    //       杂项桶，宁缺毋滥」同口径，绝不让两个状态对同一件事给出两种答案。
    // 谓词拒收只影响行集，不影响 categoriesFailed：那不是取数失败，是不属于合并集合。
    const tailList = normalizeTailCategories(o.tailCategories);
    const tailCovers = new Set(tailList.map((slug) => String(slug).trim().toLowerCase()));
    // 正证通路推进过的行键：收口并集据此复用当次作证，不必（也不能）从行内容反推。
    const tailProvenKeys = new Set();
    const tailAdmissible = (it, provenClass) => {
      if (!tailList.length) return true;
      const cat = it && it.category != null ? String(it.category).trim() : "";
      if (cat === "") return provenClass === true;
      return tailCovers.has(cat.toLowerCase());
    };
    // 行入会话的唯一入口（源收口与逐页增量共用同一份口径）：带 installRef、按 source|slug 去重。
    // 返回值 = 这一行是否真的新增（tail 逐类计数要靠它，不能用「seen.size 前后差」——
    // 并发池里别的类会在 await 期间往 seen 里塞行，差值会把别人的行算到自己头上）。
    // 成员集合不过的行连 seen 都不进：同一行日后从可证通路再来时还得放行。
    const pushRow = (it, provenClass) => {
      if (!tailAdmissible(it, provenClass)) return false;
      const row = Object.assign({}, it, { installRef: installRefOf(it) });
      const key = rowKeyOf(row);
      if (s.seen.has(key)) return false;
      s.seen.add(key);
      if (provenClass === true) tailProvenKeys.add(key);
      s.rows.push(row);
      return true;
    };
    // 每个源落地的第一时间把它的行推入会话 —— 这就是「不等别人」的那一半语义。
    const onSettled = (name, box) => {
      s.boxes.set(name, box);
      s.settled += 1;
      if (box && box.error) {
        s.degraded.push({ source: name, error: box.error });
        s.sourceErrors.push(describeFailure(name, box.error));
      } else {
        const result = box ? box.result : null;
        if (result && result.hint) s.hints.push(name + "：" + result.hint);
        const srcItems = result && Array.isArray(result.items) ? result.items : [];
        for (const it of srcItems) pushRow(it);
      }
      if (!s.done) s.stage = "collected " + s.rows.length + " rows from " + s.settled + "/" + picked.length + " sources";
      signal();
    };
    const fan = fanOutSources({
      names: picked,
      budgetMs: budget,
      cache,
      // harvest 不写冷却记忆：一次搜索的超时不该让后续 harvest 静默少一个源。
      cooldownMs: 0,
      cooldownKey: query.trim().toLowerCase(),
      onSettled,
      run: (name) => {
        const handler = (handlers && handlers[name]) || SOURCE_HANDLERS[name];
        // harvest 专属钩子（一次性 skills.search 通路不带这两个键，那条路径行为逐字节不变）：
        //   harvestBypass —— 豁免 ModelScope 的 45s 单次调用预算（30s 单页超时与 30 页上界保留）；
        //   msOnPartial —— 每取回一页就把过滤+归一后的行推进会话并唤醒等待者，面板因此
        //                  「有多少就显示多少，不断增加新结果」，而不是等整个大源落地。
        return handler({
          query, page: p, pageSize: size, cache, sort: effectiveSort, category,
          harvestBypass: true,
          msOnPartial: isLocalFilterSource(name)
            ? (pageItems) => {
                for (const it of pageItems) pushRow(it);
                if (!s.done) s.stage = "collected " + s.rows.length + " rows from " + s.settled + "/" + picked.length + " sources";
                signal();
              }
            : null,
        });
      },
    });
    // ---- 「其他」分类逐类取数（C1-C5 / E1-E2）----
    // 与上面的源扇出并行：扇出照常跑、照常增量，逐类取数只是**额外**多推一批行。
    // 绝不用 fanOutSources —— 它无上界全并发（sources.js:618 注释），214 类一起发会打死上游；
    // 这里自己开一个小并发池，且每类只取一页（窗口封顶源一页即到顶、越界翻页取不到新行；本地过滤源这一页即该类在可达集合内的实测切片，不是窗口封顶）。
    // tailList / tailCovers / tailAdmissible 在 pushRow 之前就位（成员集合与入会话同生命周期）。
    // 收口 tail 计数：六字段，键序即契约。未落地前为 null（非 tail 会话永远不带这个键）。
    s.tail = tailList.length ? {
      categoriesTotal: tailList.length,
      categoriesFetched: 0,
      categoriesFailed: 0,
      upstreamTotal: 0,
      windowed: false,
      retrievedTotal: 0,
    } : null;
    // 逐类取数只能发给「handler 真带 category 参数」的源：单源态就是它自己，
    // source:"all" 态取 picked 里第一个有分类能力的源（面板从不下发 all+tail）。
    const tailSourceName = tailList.length
      ? pickTailCategorySource(picked)
      : "";
    let tailDone = 0;
    const tailSettle = () => {
      tailDone += 1;
      if (!s.done) s.stage = "tail " + tailDone + "/" + tailList.length + " classes, collected " + s.rows.length + " rows";
      signal();
    };
    const tailRejected = (slug, why) => {
      if (s.tail) s.tail.categoriesFailed += 1;
      if (!s.done) s.stage = "tail " + tailDone + "/" + tailList.length + " classes (" + slug + " " + why + "), collected " + s.rows.length + " rows";
      signal();
    };
    const fetchTailCategory = async (slug) => {
      const tailHandler = (handlers && handlers[tailSourceName]) || SOURCE_HANDLERS[tailSourceName];
      // landed：本类新增行数（ModelScope 走 msOnPartial 提前落地，也记在同一本账上）。
      let landed = 0;
      // 0.5.186 tailExhaustive 源：这一类要翻到尽头（取全），不是取一页就交差。
      // 终止有四道：源说没有下一页 / 源报的页数翻完 / 本页零新增行（上游翻不出东西）/ 单类页数护栏。
      // 非 exhaustive 源仍是「每类一页」，逐键行为与 0.5.185 一致（C1/I4/K5 数值不破）。
      const exhaustive = isTailExhaustiveSource(tailSourceName);
      let page = 1;
      for (;;) {
        let result = null;
        try {
          // query 一律空串：带关键词时上游会静默丢掉分类参数（extra-sources.js:1114），
          // 逐类取数就退化成「同一份全目录取 N 遍」。
          result = await tailHandler({
            query: "", page, pageSize: size, cache, sort: "", category: slug,
            harvestBypass: true,
            // 逐页增量此刻还没有正证（证明门在取数返回之后），所以这里刻意不传 provenClass：
            // 提前落地的行只靠行内 category 自证 membership，证不了就不入账。
            msOnPartial: isLocalFilterSource(tailSourceName)
              ? (pageItems) => {
                  for (const it of pageItems) if (pushRow(it)) landed += 1;
                  signal();
                }
              : null,
          });
        } catch {
          // 首页就炸 = 该类没取到；续页炸 = 已落地的部分照旧入账，这一类不再往前翻。
          if (page === 1) { tailRejected(slug, "failed"); return; }
          break;
        }
        if (!result || typeof result !== "object") {
          if (page === 1) { tailRejected(slug, "failed"); return; }
          break;
        }
        if (page === 1) {
          // I4 正向证明：逐类取数只认源自己的声明 —— 明说 serverFacet === true，或 facetUsed
          // 归一（trim + 小写）后等于所请求的那个 slug。什么都不说（旧出参、旧缓存条目）一律
          // 计 unproven：那批行是没按分类筛过的全目录，推进会话等于把谎继续传下去（I2），
          // 把整源 total 记进该类合计同样是谎（I3）。旧写法只看「源主动声明了拒绝」的两条形，
          // 对沉默形（无声明位的出参）整条判据是漏的 —— 沉默既不是成功也不是拒绝。
          const proofSlug = String(slug).trim().toLowerCase();
          const proofGiven = String(result.facetUsed == null ? "" : result.facetUsed).trim().toLowerCase();
          const proven = result.serverFacet === true || (proofGiven !== "" && proofGiven === proofSlug);
          if (!proven) { tailRejected(slug, "unproven"); return; }
          if (s.tail) {
            s.tail.categoriesFetched += 1;
            // upstreamTotal 只记首页自报的那一份：续页的 total 是同一个目录规模，逐页累加会翻虚。
            s.tail.upstreamTotal += Number(result.total) || 0;
            if (result.windowed === true) s.tail.windowed = true;
          }
        }
        const srcItems = Array.isArray(result.items) ? result.items : [];
        // 正证已过的类：整类归因成立，本类行即使不带 category 也放行（谓词第 (3) 档）。
        let pageLanded = 0;
        for (const it of srcItems) if (pushRow(it, true)) { landed += 1; pageLanded += 1; }
        if (!exhaustive) break;
        // 上游还在说「有下一页」但一页新行都挤不出来：继续要下去只是空转（真机见过这种形）。
        if (pageLanded === 0) break;
        if (result.hasMore !== true) break;
        const pages = Number(result.totalPages) || 0;
        if (pages > 0 && page >= pages) break;
        if (page >= TAIL_PAGE_CAP) {
          // 护栏撞到：这个类确实还没翻尽，按窗口封顶口径如实记着。
          if (s.tail) s.tail.windowed = true;
          break;
        }
        page += 1;
        signal();
      }
      if (s.tail) s.tail.retrievedTotal += landed;
      tailSettle();
    };
    const tailPool = (async () => {
      if (!tailList.length) return;
      if (!tailSourceName) {
        // 该会话选中的源没有分类能力（skills.sh / browse.sh）：整批计失败，一次上游都不打。
        for (const slug of tailList) tailRejected(slug, "unsupported");
        return;
      }
      const want = Math.max(1, Math.min(8, Number(o.tailConcurrency) || TAIL_CONCURRENCY));
      let cursor = 0;
      const workers = [];
      const n = Math.min(want, tailList.length);
      for (let k = 0; k < n; k++) {
        workers.push((async () => {
          while (cursor < tailList.length) {
            const slug = tailList[cursor];
            cursor += 1;
            await fetchTailCategory(slug);
          }
        })());
      }
      await Promise.all(workers);
    })();
    tailPool.catch(() => {});
    const finish = async () => {
      let res = null;
      try {
        res = await fan;
      } catch {
        res = { degraded: [] };
      }
      // 撞预算这类截断由 fanOutSources 自己记账、走不到 onSettled（慢源的 promise 还在飞），
      // 在这里补进 meta —— 但它只影响它自己那一源，已经推出去的行一条不会少。
      for (const d of (res && res.degraded) || []) {
        if (!s.degraded.some((x) => x.source === d.source)) s.degraded.push({ source: d.source, error: d.error });
        const line = describeFailure(d.source, d.error);
        if (!s.sourceErrors.some((x) => x === line)) s.sourceErrors.push(line);
      }
      // 终态全量（R2）：各源落地 box 按 picked 顺序重排成 fan.results 的同形 entries，交给与
      // searchSkills 共用的 foldFanResults 折叠 —— installRef、source|slug 去重、聚合排序、
      // skills.sh 描述补全全走同一份口径，终态列表与一次性搜索逐位同序。被预算砍掉的源在这里
      // 只有 timeout 盒子，折不进行、只进 degraded，与一次性同语义。
      const entries = [];
      for (const name of picked) {
        const box = s.boxes.get(name);
        // 没有盒子＝这一源被 harvest 自己的兜底预算砍在途中（box.timeout 同理）：按失败记账，
        // 绝不把 undefined 当成「成功但空目录」—— 与一次性通路 entry.ok:false 同语义。
        if (!box || box.timeout) {
          entries.push({ name, ok: false, result: null, error: "来源响应超时（预算 " + Math.round(s.budgetMs / 1000) + "s），已跳过" });
        } else if (box.error) entries.push({ name, ok: false, result: null, error: box.error });
        else entries.push({ name, ok: true, result: box.result });
      }
      // tail 与扇出并行，收口前必须等它跑完：否则 categories* 是半程数字（谎报进度）。
      await tailPool;
      try {
        const folded = await foldFanResults({ entries, wanted, degraded: s.degraded, query, p, size, category, cache, effectiveSort });
        let finalRows = folded.items.slice();
        // 收口同样过谓词：folded.items 是折叠层按盒子重算的，没经过 pushRow 那道闸，
        // 只在 push 侧过滤会把不可证的行从这条路漏进行集（两条路必须同口径）。
        if (s.tail) finalRows = finalRows.filter((it) => tailAdmissible(it, tailProvenKeys.has(rowKeyOf(it))));
        // 分页/口径字段随收口包 meta 下发（与一次性 skills.search 同源同值）：面板 final
        // 整表替换时才有 total/pages/hasMore/serverFacet 可写缓存，分页器不必瞎猜。
        if (s.tail) {
          // tail 态分页口径 = 可取回行集，绝不等于 upstreamTotal、也绝不是 ceil(upstreamTotal/size)：
          // 上游那个数是目录规模（skillsmp 单类自报 545885），不是本会话真能交付的行数。
          const have = new Set(finalRows.map(rowKeyOf));
          for (const it of s.rows) {
            const key = rowKeyOf(it);
            if (have.has(key)) continue;
            if (!tailAdmissible(it, tailProvenKeys.has(key))) continue;
            have.add(key);
            finalRows.push(it);
          }
          // 0.5.186：「取全」看的是类有没有落地，不再拿 upstreamTotal（跨类重叠的目录计数）和行数比大小
          // —— 那个比法把永远追不平的虚高数当缺口感，于是提示怎么写都像「还差很多」，用户重试两天也取不完。
          // 逐类翻尽的源（tailExhaustive）全部落地时一条 hint 都不发：界面那行提示整行消失，这才是「已取全」。
          const tailPending = Math.max(0, s.tail.categoriesTotal - s.tail.categoriesFetched - s.tail.categoriesFailed);
          if (s.tail.categoriesFailed > 0 || tailPending > 0) {
            const miss = s.tail.categoriesFailed + tailPending;
            const line = "「其他」分类未取全：还有 " + miss + " 个分类没取到"
              + (s.tail.categoriesFailed > 0 ? "（其中 " + s.tail.categoriesFailed + " 个取数失败）" : "")
              + "。";
            if (!s.hints.includes(line)) s.hints.push(line);
          } else if (!isTailExhaustiveSource(tailSourceName) || isLocalFilterSource(tailSourceName)) {
            // 两类源仍要发口径 hint：
            //  ① 每类只取一页的源（skillsmp 窗外单类最大 155,772 条 ≈ 5.0 万页，结构性取不全）；
            //  ② 本地过滤源（modelscope）—— 它的「可达集合」本身就是上游 30,000 行 offset 硬窗口，
            //     实测 5 个有效排序各取满 30 页并集也只有 50,657/89,122=56.84%，翻尽本地集合 ≠ 覆盖全目录，
            //     所以即便 tailExhaustive 已把本地集合翻到底，这句 caveat 语义上依然成立（0.5.186 修法①）。
            // I6 口径按源声明分两写：窗口封顶说取不到后面的，本地过滤只报已取回的那部分。
            // 0.5.187（用户 m31212①）：两句都去掉「可达集合/本地过滤」这类工程词，
            // 且不再写「建议稍后重试」——面板上没有重试入口，那句话承诺了不存在的操作。
            const caliber = s.tail.windowed
              ? "（其余在上游窗口之外取不到）"
              : "（受上游限制，只能统计已经取回的那部分）";
            const line = "「其他」分类未取全" + caliber + "。";
            if (!s.hints.includes(line)) s.hints.push(line);
          }
        }
        s.final = finalRows;
        s.finalMeta = s.tail ? {
          total: finalRows.length,
          pages: Math.max(1, Math.ceil(finalRows.length / size)),
          hasMore: false,
          // 这是本地按 covers 集合并出来的行集，不是上游单分类 facet（C5）。
          serverFacet: false,
          categoryNote: folded.categoryNote,
          filteredOut: folded.filteredOut,
          tail: s.tail,
        } : {
          total: folded.total,
          pages: folded.pages,
          hasMore: folded.hasMore,
          serverFacet: folded.serverFacet,
          categoryNote: folded.categoryNote,
          filteredOut: folded.filteredOut,
        };
      } catch {
        // 折叠兜底失败也不能让会话悬死：终态退化为到达序全量（仍然一行不丢）。
        s.final = s.rows.slice();
        s.finalHints = s.hints.slice();
      }
      s.done = true;
      s.stage = "done";
      signal();
    };
    const running = finish();
    running.catch(() => {});
    // 首包：第一个有行的源落地就返回，面板不必等最慢的那个源。若启动瞬间就跑完（picked 为空
    // 或全部源同步落地），这第一个返回包就是收口包：直接带 final:true 与完整折叠列表
    // （R3：done=true 必须 final；面板收到 final ⇒ 整表替换，否则增量 upsert）。
    for (;;) {
      if (s.done || s.rows.length > 0) break;
      await new Promise((resolve) => s.waiters.push(resolve));
    }
    if (s.done && !s.finalSent) {
      s.finalSent = true;
      return { id: s.id, rows: (s.final || []).slice(), meta: metaOf(s), done: true, final: true, stage: s.stage };
    }
    const rows = s.rows.slice(s.sent);
    s.sent = s.rows.length;
    return { id: s.id, rows, meta: metaOf(s), done: s.done, stage: s.stage };
  };

  const poll = (id) => {
    if (!id) return null;
    const s = sessions.get(String(id));
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      sessions.delete(s.id);
      return null;
    }
    const rows = s.rows.slice(s.sent);
    s.sent = s.rows.length;
    s.expiresAt = Date.now() + s.ttlMs;
    if (s.done && !s.finalSent) {
      // 收口包（R2/R3）：done 翻真的这一次必须带 final:true 与完整折叠后的全量列表；
      // 发出之后不再重复 final，后续 poll 回到空增量（面板契约 final ⇒ 整表替换一次）。
      s.finalSent = true;
      return { rows: (s.final || []).slice(), meta: metaOf(s), done: true, final: true, hints: (s.finalHints || s.hints).slice() };
    }
    // stage 随中间包下发：tail 逐类取数的进度（tail k/n classes）只有在这里才看得见，
    // 面板与测试都靠它判断「按类推进」而不是最后一把砸完。
    return { rows, meta: metaOf(s, true), done: s.done, stage: s.stage, hints: s.hints.slice() };
  };

  return { start, poll, size: () => sessions.size };
}
