// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { enrichPageDescriptions, enrichSkillsShFast } from "./enrich.js";
import { searchClawHub, searchLobeHubSkills, searchTrustTools } from "./extra-sources.js";

const UA = { "User-Agent": "dsh-market/0.3 (+skill and mcp market)", accept: "application/json" };

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
/** skills.sh exposes a real JSON search API (Algolia-backed). */
export async function searchSkillsSh({ query = "", pageSize = 24, cache }) {
  // The upstream API rejects queries shorter than 2 characters; browsing with an empty
  // box is a legitimate state, so return an empty page with a hint instead of failing.
  if (query.trim().length < 2) {
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
  if (cached) return cached;
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
  await cache.put("lobehub_slugs", slugs);
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
  const html = await fetchText(`https://lobehub.com/mcp/${slug}`, 30000);
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
    await cache.put("browse_sh_api", rows);
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

export async function searchSkills({ query, source = "all", pageSize = 24, cache = fallbackCache }) {
  const wanted = source === "all" ? ["skills.sh", "clawhub", "trusttools", "browse.sh", "lobehub-agent", "skillhub"] : [source];
  const items = [];
  const degraded = [];
  for (const name of wanted) {
    try {
      if (name === "skills.sh") {
        const result = await searchSkillsSh({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "clawhub") {
        const result = await searchClawHub({ query, pageSize });
        items.push(...result.items);
      } else if (name === "trusttools") {
        const result = await searchTrustTools({ query, pageSize });
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
  return { items, degraded, total: items.length };
}
