// Fill in real descriptions for sitemap-only sources.
//
// skills.sh and browse.sh publish catalogues without descriptions: the sitemap only has
// URLs. The reference implementation avoided this by reading each source's own search API,
// which returns `description` directly. Where no API exists, read the authoritative text:
// the skill's own SKILL.md frontmatter (GitHub) or the page's own meta description.
import { parseFrontmatter } from "./frontmatter.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.3 (+skill market)" };

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with a bounded number of in-flight requests. */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await worker(items[index], index);
      } catch {
        out[index] = items[index];
      }
    }
  });
  await Promise.all(runners);
  return out;
}

const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&nbsp;": " " };

function decodeEntities(text) {
  return String(text).replace(/&(quot|amp|lt|gt|#39|nbsp);/g, (match) => ENTITIES[match] ?? match);
}

/** File index of a GitHub repository (cached 24h), used to locate `<skill>/SKILL.md`. */
async function repoFileIndex(repo, ref, cache) {
  const key = `gh-index:${repo}@${ref}`;
  const cached = await cache.get(key, 24 * 3600 * 1000);
  if (cached) return new Set(cached);
  const data = JSON.parse(await fetchText(`https://data.jsdelivr.com/v1/packages/gh/${repo}@${encodeURIComponent(ref)}`, 25000));
  const files = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes || []) {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      if (node.type === "directory") walk(node.files, path);
      else files.push(path);
    }
  };
  walk(data.files, "");
  await cache.put(key, files);
  return new Set(files);
}

function locateSkillFile(index, skill) {
  const wanted = String(skill || "").toLowerCase();
  const candidates = [...index].filter((path) => path.toLowerCase().endsWith("/skill.md") || path.toLowerCase() === "skill.md");
  const byBase = candidates.filter((path) => path.split("/").slice(-2, -1)[0]?.toLowerCase() === wanted);
  if (byBase.length > 0) return byBase[0];
  return candidates.length === 1 ? candidates[0] : "";
}

/**
 * Read each skills.sh entry's own SKILL.md frontmatter: that is the authoritative name and
 * description. One jsDelivr index request per repository, then one raw request per skill.
 */
export async function enrichSkillsSh(items, cache) {
  const withTarget = [];
  for (const item of items) {
    const parts = String(item.owner || "").split("/");
    if (parts.length !== 2) continue;
    withTarget.push({ item, repo: item.owner, skill: item.slug });
  }
  const repos = [...new Set(withTarget.map((entry) => entry.repo))];
  const indexes = new Map();
  await mapLimit(repos, 4, async (repo) => {
    try {
      indexes.set(repo, await repoFileIndex(repo, "main", cache));
    } catch {
      try {
        indexes.set(repo, await repoFileIndex(repo, "master", cache));
      } catch {
        indexes.set(repo, new Set());
      }
    }
  });

  await mapLimit(withTarget, 6, async ({ item, repo, skill }) => {
    const index = indexes.get(repo);
    if (!index || index.size === 0) return item;
    const path = locateSkillFile(index, skill);
    if (!path) return item;
    const cacheKey = `skillmd:${repo}:${path}`;
    try {
      let text = await cache.get(cacheKey, 24 * 3600 * 1000);
      if (!text) {
        text = await fetchText(`https://raw.githubusercontent.com/${repo}/main/${path}`);
        await cache.put(cacheKey, text);
      }
      const { data } = parseFrontmatter(text);
      if (data.description) item.description = String(data.description).trim();
      if (data.name) item.name = String(data.name).trim();
      item.skillDir = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
      item.describedBy = "SKILL.md";
    } catch {
      // keep whatever the sitemap gave us
    }
    return item;
  });
  return items;
}

/**
 * skills.sh has no description field. Reading the page costs ~2s per skill, so read the
 * skill's own SKILL.md frontmatter from raw.githubusercontent instead (about 0.3s).
 */
export async function enrichSkillsShFast(items, cache, limit = 10) {
  const targets = items.slice(0, limit);
  await mapLimit(targets, 8, async (item) => {
    if (item.description) return item;
    const repo = String(item.owner || "");
    const skill = String(item.slug || "");
    if (!repo.includes("/") || !skill) return item;
    const candidates = [`${skill}/SKILL.md`, `skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`];
    for (const path of candidates) {
      const key = `skillmd:${repo}:${path}`;
      try {
        let text = await cache.get(key, 24 * 3600 * 1000);
        if (!text) {
          // raw.githubusercontent is intermittently unreachable here; jsDelivr mirrors the
          // same file and has been stable, so try it first and keep raw as the fallback.
          const hosts = [
            `https://cdn.jsdelivr.net/gh/${repo}@main/${path}`,
            `https://raw.githubusercontent.com/${repo}/main/${path}`,
          ];
          text = "";
          for (const url of hosts) {
            try {
              const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(6000) });
              if (!response.ok) continue;
              text = await response.text();
              break;
            } catch {
              // try the next host
            }
          }
          if (!text) continue;
          await cache.put(key, text);
        }
        const { data } = parseFrontmatter(text);
        if (data.description) {
          item.description = String(data.description).trim();
          if (data.name) item.name = String(data.name).trim();
          item.skillDir = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
          const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
          const category = data.category || meta.category || "";
          if (category) item.category = String(category).trim();
          item.describedBy = "SKILL.md";
          return item;
        }
      } catch {
        // try the next candidate layout
      }
    }
    return item;
  });
  return items;
}

/** Read a page's own meta description — used for sources whose search API omits it. */
export async function enrichPageDescriptions(items, cache, concurrency = 6) {
  await mapLimit(items, concurrency, async (item) => {
    if (item.description || !item.homepage) return item;
    if (!item.homepage) return item;
    const cacheKey = `page-desc:${item.homepage}`;
    try {
      let text = await cache.get(cacheKey, 24 * 3600 * 1000);
      if (!text) {
        text = await fetchText(item.homepage);
        await cache.put(cacheKey, text);
      }
      const meta =
        /<meta[^>]+property="og:description"[^>]+content="([^"]{10,400})"/i.exec(text) ||
        /<meta[^>]+name="description"[^>]+content="([^"]{10,400})"/i.exec(text);
      if (meta) {
        const description = decodeEntities(meta[1]).replace(/\s+/g, " ").trim();
        if (description) {
          item.description = description;
          item.describedBy = "page-meta";
        }
      }
      const title = /<title>([^<]{3,160})<\/title>/i.exec(text);
      if (title && (!item.name || item.name === item.slug)) {
        item.name = decodeEntities(title[1]).split("|")[0].trim();
      }
    } catch {
      // keep the fallback text
    }
    return item;
  });
  return items;
}
