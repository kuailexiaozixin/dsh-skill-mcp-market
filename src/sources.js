// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { enrichPageDescriptions, enrichSkillsShFast } from "./enrich.js";
import { searchClawHub, searchLobeHubSkills, searchSkillsMp, searchTrustTools } from "./extra-sources.js";

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
/**
 * skills.sh has no listing API, but its home page links the skills it is featuring right
 * now. Scrape those links so an empty search box still shows a real catalogue instead of
 * a blank market.
 */
export async function browseSkillsSh({ pageSize = 24, cache } = {}) {
  let rows = cache ? await cache.get("skills_sh_home", 30 * 60 * 1000) : null;
  if (!Array.isArray(rows) || rows.length === 0) {
    const html = await fetchText("https://www.skills.sh/", 25000);
    const seen = new Set();
    rows = [];
    for (const match of html.matchAll(/\/([A-Za-z0-9_.-]+)\/skills\/([A-Za-z0-9_.-]+)/g)) {
      const key = `${match[1]}/${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ owner: `${match[1]}/skills`, slug: match[2] });
    }
    if (rows.length > 0 && cache) await cache.put("skills_sh_home", rows);
  }
  const items = rows.slice(0, pageSize).map(({ owner, slug }) => ({
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
  }));
  return { source: "skills.sh", items, total: rows.length };
}

/** skills.sh exposes a real JSON search API (Algolia-backed). */
export async function searchSkillsSh({ query = "", pageSize = 24, cache }) {
  // The upstream search API rejects queries shorter than 2 characters. Browsing with an
  // empty box is a legitimate state, so fall back to the home-page highlights and say so.
  if (query.trim().length < 2) {
    try {
      const browse = await browseSkillsSh({ pageSize, cache });
      if (browse.items.length > 0) {
        return {
          ...browse,
          hint: "未输入关键词：以下是 skills.sh 首页当前推荐的技能，输入至少 2 个字符可精确搜索",
        };
      }
    } catch {
      // fall through to the plain hint below
    }
    return { source: "skills.sh", items: [], total: 0, hint: "skills.sh 需要至少 2 个字符的关键词" };
  }
  const url = `https://www.skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${pageSize}`;
  const data = JSON.parse(await fetchText(url, 20000));
  const rows = Array.isArray(data.skills) ? data.skills : [];
  const items = rows.map((raw) => {
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
  return { source: "skills.sh", items, total: Number(data.count) || items.length };
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
export async function searchBrowseSh({ query = "", pageSize = 24, cache }) {
  let rows = await cache.get("browse_sh_api", 30 * 60 * 1000);
  if (!rows) {
    const data = JSON.parse(await fetchText("https://browse.sh/api/skills", 25000));
    rows = Array.isArray(data.skills) ? data.skills : [];
    if (rows.length) await cache.put("browse_sh_api", rows);
  }
  const q = query.trim().toLowerCase();
  const items = [];
  for (const raw of rows) {
    if (items.length >= pageSize) break;
    const hay = `${raw.title || ""} ${raw.description || ""} ${raw.slug || ""} ${(raw.tags || []).join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    items.push({
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
  return { source: "browse.sh", items, total: rows.length };
}

// ------------------------------------------------------------------ aggregation
const fallbackCache = makeCache(join(process.env.TEMP || process.env.TMPDIR || ".", "dsh-market-cache"));

export const ALL_SOURCES = ["skills.sh", "clawhub", "skillsmp", "trusttools", "browse.sh", "lobehub-agent", "skillhub"];

export async function searchSkills({ query, source = "all", pageSize = 24, cache = fallbackCache }) {
  const wanted = source === "all" ? ALL_SOURCES : [source];
  const items = [];
  const degraded = [];
  const hints = [];
  for (const name of wanted) {
    try {
      if (name === "skills.sh") {
        const result = await searchSkillsSh({ query, pageSize, cache });
        if (result.hint) hints.push(`skills.sh：${result.hint}`);
        items.push(...result.items);
      } else if (name === "clawhub") {
        const result = await searchClawHub({ query, pageSize });
        items.push(...result.items);
      } else if (name === "skillsmp") {
        const result = await searchSkillsMp({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "trusttools") {
        const result = await searchTrustTools({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "lobehub-agent") {
        const result = await searchLobeHubSkills({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "browse.sh") {
        const result = await searchBrowseSh({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "skillhub") {
        const result = await searchSkillHub({ query, pageSize });
        items.push(...result.items);
      }
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
  return { items, degraded, hints, sourceErrors, total: items.length };
}

/**
 * Warm the two catalogues that are expensive on a cold start (browse.sh ships ~700 KB,
 * skillsmp is a paged upstream). Called in the background once the plugin is applied, so
 * the first time the panel opens the cache is already populated instead of the user
 * staring at an empty grid while a 25-second fetch completes.
 */
export async function warmMarketCache(cache = fallbackCache) {
  const results = await Promise.allSettled([
    searchBrowseSh({ query: "", pageSize: 24, cache }),
    searchSkillsMp({ query: "", pageSize: 24, cache }),
  ]);
  return results.map((r) => (r.status === "fulfilled" ? r.value.items.length : 0));
}
