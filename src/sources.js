// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { enrichPageDescriptions, enrichSkillsShFast } from "./enrich.js";
import {
  searchClawHub,
  searchLobeHubSkills,
  searchModelScope,
  searchSkillsMp,
  searchTrustTools,
} from "./extra-sources.js";

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
const CATALOG_WAIT_MS = 6000;

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

export async function browseSkillsSh({ query = "", page = 1, pageSize = 24, cache } = {}) {
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
  const items = pageSlice(matched, p, size).map(skillsShCard);
  try {
    // 首页/sitemap 都不带描述，按可见的这一屏补（上限 10 条，避免 24 条逐个读太慢）。
    await enrichSkillsShFast(items, cache, 10);
  } catch {
    // descriptions are best-effort: a failed read never blocks the list
  }
  fillMissingDescriptions(items);
  return { source: "skills.sh", items, total: matched.length, hasMore: p * size < matched.length, hint };
}

/** skills.sh exposes a real JSON search API (Algolia-backed). */
export async function searchSkillsSh({ query = "", page = 1, pageSize = 24, cache }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  // The upstream search API rejects queries shorter than 2 characters; an empty box is a
  // legitimate state, so browse the (whole) catalogue instead.
  if (q.length < 2) return browseSkillsSh({ query: q, page: p, pageSize: size, cache });
  // 上游没有 offset：只能一次取到第 p 页的深度，再在本地切出最后一屏。
  const depth = Math.min(200, size * p);
  const url = `https://www.skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${depth}`;
  const data = JSON.parse(await fetchText(url, 40000));
  const rows = Array.isArray(data.skills) ? data.skills : [];
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
  try {
    // The search API has no description field; the skill page's own meta text does.
    await enrichSkillsShFast(items, cache, 10);
  } catch {
    // descriptions are best-effort
  }
  fillMissingDescriptions(items);
  const hasMore = rows.length >= depth;
  const total = hasMore ? Math.max(Number(data.count) || 0, depth + 1) : (p - 1) * size + rows.length;
  return { source: "skills.sh", items, total, hasMore };
}

// ------------------------------------------------------------------ LobeHub MCP
const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&nbsp;": " " };

function decodeHtml(text) {
  return text.replace(/&(quot|amp|lt|gt|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** Pull the first `<pre><code>{ "mcpServers": … }</code></pre>` block out of a LobeHub page. */
export function extractMcpServers(html) {
  const blocks = [...html.matchAll(/<pre[^>]*>\s*<code[^>]*>([\s\S]{0,4000}?)<\/code>\s*<\/pre>/g)];
  for (const block of blocks) {
    const text = decodeHtml(block[1]).trim();
    if (!text.includes("mcpServers")) continue;
    try {
      const parsed = JSON.parse(text);
      const servers = parsed.mcpServers || parsed.servers || {};
      const first = Object.entries(servers)[0];
      if (!first) continue;
      const [name, config] = first;
      return { name, ...config };
    } catch {
      // not JSON, keep looking
    }
  }
  return null;
}

async function lobehubSlugs(cache) {
  const cached = await cache.get("lobehub_slugs", 24 * 3600 * 1000);
  if (cached && cached.length) return cached;
  const index = await fetchText("https://lobehub.com/sitemap.xml");
  const shards = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((url) => /\/sitemap\/mcp-\d+\.xml$/.test(url))
    .slice(0, 16);
  const slugs = [];
  for (const shard of shards) {
    let xml = "";
    try {
      xml = await fetchText(shard, 12000);
    } catch {
      continue;
    }
    for (const match of xml.matchAll(/<loc>https:\/\/lobehub\.com\/mcp\/([^<]+)<\/loc>/g)) slugs.push(match[1]);
  }
  // Never persist an empty catalogue: a 24-hour cache of "no servers" would outlive the
  // upstream problem that caused it.
  if (slugs.length > 0) await cache.put("lobehub_slugs", slugs);
  return slugs;
}

/** Resolve one skills.sh page into the exact install target it advertises.
 *  The page embeds `npx skills add <repo> --skill <name>`; the repo path inside the
 *  repository is resolved later against the repository tree. */
export async function resolveSkillsShInstall(url) {
  const page = await fetchText(url, 25000);
  const command = page.match(/npx\s+skills\s+add\s+(\S+)(?:\s+--skill\s+(\S+))?/);
  if (!command) throw new Error("skills.sh 页面没有给出安装命令，可能页面结构已变化");
  const repoUrl = command[1];
  const skill = String(command[2] || "").split("<")[0].split(/[\s"']/)[0].trim();
  const repo = repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "");
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`无法从安装命令解析仓库：${repoUrl}`);
  return { repo, skill };
}

export async function searchLobeHubMcp({ query = "", pageSize = 24, cache }) {
  const slugs = await lobehubSlugs(cache);
  const q = query.trim().toLowerCase();
  const items = [];
  for (const slug of slugs) {
    if (items.length >= pageSize) break;
    if (q && !slug.includes(q.replace(/\s+/g, "-"))) continue;
    items.push({
      id: `lobehub:${slug}`,
      slug,
      name: slug.replace(/-/g, " "),
      description: "LobeHub 实时目录条目；安装时抓取该页的真实启动配置",
      source: "lobehub",
      sourceLabel: "LobeHub",
      homepage: `https://lobehub.com/mcp/${slug}`,
      transport: "stdio",
      installable: true,
    });
  }
  return { source: "lobehub", items, total: slugs.length };
}

/** Fetch and parse one LobeHub entry's real MCP definition. */
export async function lobehubMcpConfig(slug) {
  let html = "";
  try {
    html = await fetchText(`https://lobehub.com/mcp/${slug}`, 30000);
  } catch (error) {
    if (/HTTP 402/.test(String((error && error.message) || error))) {
      throw new Error(
        "LobeHub 目录已改为付费接口（HTTP 402 payment_required），自动化访问不再可用；请改用 MCP 官方注册表名称安装。",
      );
    }
    throw error;
  }
  const config = extractMcpServers(html);
  if (!config) {
    throw new Error(
      "LobeHub 该页面没有提供可直接使用的 mcpServers 配置（只给了说明文字）。请改用“手动配置”，或到该项目的 README 里取启动命令。",
    );
  }
  return config;
}

// ------------------------------------------------------------------ browse.sh
/** browse.sh exposes the whole catalogue with title, description, category and tags. */
export async function searchBrowseSh({ query = "", page = 1, pageSize = 24, cache }) {
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
      installable: false,
      note: "browse.sh 的技能源码仓库在 GitHub 上返回 404（私有或已迁走），只能浏览",
    });
  }
  // browse.sh 一次返回整份目录（约 480 条），本地切片即可真正翻页。
  const items = pageSlice(matched, p, size);
  return { source: "browse.sh", items, total: matched.length, hasMore: p * size < matched.length };
}

// 没带 cache 时（例如 agent 直接调 skill_market_search 工具）退回进程级临时目录缓存。
const fallbackCache = makeCache(join(process.env.TEMP || process.env.TMPDIR || ".", "dsh-market-cache"));

export const ALL_SOURCES = [
  "skills.sh",
  "clawhub",
  "skillsmp",
  "trusttools",
  "browse.sh",
  "lobehub-agent",
  "skillhub",
  "modelscope",
];

// 每个源现在都实现了真正的翻页：有 page 参数的服务端分页，没有的把整份目录缓存后本地切片。
export const LOAD_MORE_CAPABLE = new Set(ALL_SOURCES);

const SOURCE_HANDLERS = {
  "skills.sh": searchSkillsSh,
  clawhub: searchClawHub,
  skillsmp: searchSkillsMp,
  trusttools: searchTrustTools,
  "browse.sh": searchBrowseSh,
  "lobehub-agent": searchLobeHubSkills,
  skillhub: searchSkillHub,
  modelscope: searchModelScope,
};

export async function searchSkills({ query, source = "all", page = 1, pageSize = 24, cache = fallbackCache }) {
  const wanted = source === "all" ? ALL_SOURCES : [source];
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const items = [];
  const degraded = [];
  const hints = [];
  let total = 0;
  let hasMore = false;
  for (const name of wanted) {
    const handler = SOURCE_HANDLERS[name];
    if (!handler) continue;
    try {
      const result = await handler({ query, page: p, pageSize: size, cache });
      if (result && result.hint) hints.push(`${name}：${result.hint}`);
      if (result && Array.isArray(result.items) && result.items.length) items.push(...result.items);
      total += Number(result && result.total) || 0;
      if (result && result.hasMore) hasMore = true;
    } catch (error) {
      degraded.push({ source: name, error: String(error?.message || error) });
    }
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
  const sourceErrors =
    items.length > 0 || String(query || "").trim()
      ? []
      : degraded.length
        ? degraded.map((entry) => `${entry.source} 不可达：${entry.error}`.slice(0, 200))
        : hints.length
          ? hints
          : ["所选市场暂时没有取到数据，可能是上游不可达或响应超时，请稍后重试"];
  if (!total || total < items.length) total = hasMore ? p * size + 1 : (p - 1) * size + items.length;
  return {
    items,
    page: p,
    pageSize: size,
    pages: Math.max(1, Math.ceil(total / size)),
    total,
    hasMore,
    degraded,
    hints,
    sourceErrors,
  };
}

/**
 * Warm the catalogues that are expensive on a cold start (browse.sh ships ~480 entries,
 * skills.sh needs the ~2 MB sitemap, LobeHub's index is ~500 agents, skillsmp is a paged
 * upstream). Runs in the background so the first panel open is already populated.
 */
export async function warmMarketCache(cache = fallbackCache) {
  const results = await Promise.allSettled([
    searchBrowseSh({ query: "", page: 1, pageSize: 24, cache }),
    searchLobeHubSkills({ query: "", page: 1, pageSize: 24, cache }),
    searchModelScope({ query: "", page: 1, pageSize: 24 }),
    skillsShCatalog(cache),
  ]);
  return results.map((r) => (r.status === "fulfilled" ? (Array.isArray(r.value) ? r.value.length : (r.value.items || []).length) : 0));
}
