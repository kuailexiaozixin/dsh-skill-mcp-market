// Live online sources only. No bundled catalog: every list comes from an upstream
// that is reachable right now, and every install resolves its content live.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { searchSkills as searchSkillHub } from "./skillhub.js";

const UA = { "User-Agent": "dsh-market/0.2 (+skill and mcp market)" };

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
/** skills.sh publishes its whole catalogue in a sitemap: /<owner>/<repo>/<skill>. */
export async function searchSkillsSh({ query = "", pageSize = 24, cache }) {
  const urls = await cache.get("skills_sh_urls", 24 * 3600 * 1000);
  let list = urls;
  if (!list) {
    const index = await fetchText("https://www.skills.sh/sitemap.xml");
    const shards = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((url) => /sitemap-skills-\d+\.xml$/.test(url));
    const collected = [];
    for (const shard of shards.slice(0, 2)) {
      const xml = await fetchText(shard, 30000);
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) collected.push(match[1]);
    }
    list = collected;
    await cache.put("skills_sh_urls", list);
  }
  const q = query.trim().toLowerCase();
  const items = [];
  for (const url of list) {
    if (items.length >= pageSize) break;
    if (q && !url.toLowerCase().includes(q)) continue;
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length < 3) continue;
    const [owner, repo, ...rest] = parts;
    const skill = rest.join("/");
    items.push({
      id: `skills.sh:${owner}/${repo}/${skill}`,
      slug: skill.split("/").pop(),
      name: skill.split("/").pop(),
      description: `${owner}/${repo} · 来自 skills.sh 实时目录`,
      source: "skills.sh",
      sourceLabel: "skills.sh",
      owner: `${owner}/${repo}`,
      homepage: url,
      upstreamUrl: `${owner}/${repo}`,
      skillDir: "",
      installable: true,
    });
  }
  return { source: "skills.sh", items, total: list.length };
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
    .slice(0, 8);
  const slugs = [];
  for (const shard of shards) {
    const xml = await fetchText(shard, 30000);
    for (const match of xml.matchAll(/<loc>https:\/\/lobehub\.com\/mcp\/([^<]+)<\/loc>/g)) slugs.push(match[1]);
  }
  await cache.put("lobehub_slugs", slugs);
  return slugs;
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

// ------------------------------------------------------------------ aggregation
const fallbackCache = makeCache(join(process.env.TEMP || process.env.TMPDIR || ".", "dsh-market-cache"));

export async function searchSkills({ query, source = "all", pageSize = 24, cache = fallbackCache }) {
  const wanted = source === "all" ? ["skills.sh", "skillhub"] : [source];
  const items = [];
  const degraded = [];
  for (const name of wanted) {
    try {
      if (name === "skills.sh") {
        const result = await searchSkillsSh({ query, pageSize, cache });
        items.push(...result.items);
      } else if (name === "skillhub") {
        const result = await searchSkillHub({ query, pageSize });
        items.push(...result.items);
      }
    } catch (error) {
      degraded.push({ source: name, error: String(error?.message || error) });
    }
  }
  return { items, degraded, total: items.length };
}
