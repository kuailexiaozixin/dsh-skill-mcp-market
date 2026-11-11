// Four more live sources, each following the reference implementation's own endpoint:
//   clawhub   — clawhub.ai/api/v1  (search + page-level GitHub resolution)
//   trusttools— ai.trusttools.cn/api/skills/search (POST, item carries repo_url/repo_path)
//   LobeHub   — chat-agents.lobehub.com/index.json (agent index, installable as a SKILL)
//   skillsmp  — skillsmp.com/api/skills (paged search; Cloudflare-fronted, needs the curl
//               transport because this process's own TLS fingerprint is refused)
// modelscope (api/v1/dolphin/skills → 404) is intentionally absent: the endpoint is gone.
import { getJsonEscalating, postJsonEscalating } from "./http.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.4", accept: "application/json" };

async function getJson(url, timeoutMs = 15000) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function postJson(url, body, timeoutMs = 15000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...UA, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

// ---------------------------------------------------------------- clawhub
export async function searchClawHub({ query = "", pageSize = 24 }) {
  const data = query.trim()
    ? await getJson(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query)}`)
    : await getJson("https://clawhub.ai/api/v1/skills");
  const rows = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
  const items = rows.slice(0, pageSize).map((raw) => {
    const install = raw.install || {};
    // Listing rows carry ownerHandle/slug instead of install.reference.
    const reference =
      String(install.reference || "").trim() ||
      (raw.ownerHandle && raw.slug ? `${raw.ownerHandle}/${raw.slug}` : "");
    const [owner, slug] = reference.includes("/") ? reference.split("/") : [];
    return {
      id: `clawhub:${raw.id || reference || raw.slug}`,
      slug: slug || raw.slug || String(raw.displayName || "").toLowerCase(),
      name: raw.displayName || raw.name || raw.slug || reference,
      description: raw.summary || raw.description || "",
      source: "clawhub",
      sourceLabel: "clawhub",
      owner: owner || raw.ownerHandle || "",
      homepage: `https://clawhub.ai${raw.canonicalUrl || `/${reference}`}`,
      upstreamUrl: "",
      installRef: reference,
      downloads: Number(raw.downloads || raw.metrics?.rolling60DayInstalls || 0) || 0,
      category: raw.category || "",
      installable: Boolean(reference),
    };
  });
  return { source: "clawhub", items, total: rows.length };
}

// ---------------------------------------------------------------- trusttools
export async function searchTrustTools({ query = "", pageSize = 24, cache } = {}) {
  // trusttools ignores `pageSize` and always answers with 10 rows per page, so a full grid
  // needs several pages stitched together (pages are disjoint, verified).
  const wanted = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const pagesNeeded = Math.min(6, Math.ceil(wanted / 10));
  const perPage = 10;
  const rows = [];
  const seen = new Set();
  let total = 0;
  for (let page = 1; page <= pagesNeeded; page += 1) {
    const key = `trusttools:${String(query).trim().toLowerCase()}:${page}`;
    let data = cache ? await cache.get(key, 10 * 60 * 1000) : undefined;
    if (!data) {
      data = await postJsonEscalating(
        "https://ai.trusttools.cn/api/skills/search",
        { q: query, page, pageSize: perPage },
        { timeoutMs: 25000 },
      );
      if (cache) await cache.put(key, data);
    }
    const batch = Array.isArray(data.data) ? data.data : [];
    if (data.pagination && Number(data.pagination.total) > 0) total = Number(data.pagination.total);
    let added = 0;
    for (const raw of batch) {
      const id = String(raw.id ?? raw.slug ?? raw.name ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(raw);
      added += 1;
    }
    if (batch.length === 0 || added === 0) break; // catalogue exhausted or the page repeats
  }
  const items = rows.slice(0, wanted).map((raw) => {
    const repo = String(raw.repo_url || "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const path = String(raw.repo_path || "").replace(/\/SKILL\.md$/i, "");
    return {
      id: `trusttools:${raw.id}`,
      slug: raw.slug || raw.name,
      name: raw.name || raw.slug,
      description: raw.description_zh || raw.description || raw.short_description || "",
      source: "trusttools",
      sourceLabel: "TrustTools",
      owner: repo,
      homepage: repo ? `https://github.com/${repo}` : "",
      upstreamUrl: repo,
      ref: raw.branch || "main",
      skillDir: path,
      stars: Number(raw.stars || 0),
      installs: Number(raw.install_count || raw.download_count || 0),
      security: raw.security_level || "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      category: (Array.isArray(raw.tags) && raw.tags[0]) || "",
      installable: Boolean(repo && path),
    };
  });
  return { source: "trusttools", items, total: total || items.length };
}

// ---------------------------------------------------------------- LobeHub agents (skills)
export async function searchLobeHubSkills({ query = "", pageSize = 24, cache }) {
  let agents = await cache.get("lobehub_agents", 6 * 3600 * 1000);
  if (!agents) {
    const data = await getJson("https://chat-agents.lobehub.com/index.json", 25000);
    agents = Array.isArray(data.agents) ? data.agents : [];
    await cache.put("lobehub_agents", agents);
  }
  const q = query.trim().toLowerCase();
  const items = [];
  for (const raw of agents) {
    if (items.length >= pageSize) break;
    const meta = raw.meta || {};
    const hay = `${raw.identifier} ${meta.title || ""} ${meta.description || ""} ${(meta.tags || []).join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    items.push({
      id: `lobehub-agent:${raw.identifier}`,
      slug: raw.identifier,
      name: meta.title || raw.identifier,
      description: meta.description || "",
      source: "lobehub-agent",
      sourceLabel: "LobeHub 智能体",
      owner: raw.author || "",
      homepage: `https://lobehub.com/agent/${raw.identifier}`,
      upstreamUrl: "",
      category: (Array.isArray(meta.tags) && String(meta.tags[0] || "")) || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      installable: true,
      note: "安装时会把该智能体的设定写成 SKILL.md",
    });
  }
  return { source: "lobehub-agent", items, total: agents.length };
}

/** Turn a LobeHub agent document into a SKILL.md bundle. */
export async function lobehubAgentSkill(identifier) {
  const doc = await getJson(`https://chat-agents.lobehub.com/${encodeURIComponent(identifier)}.json`, 20000);
  const meta = doc.meta || {};
  const name = String(meta.title || doc.identifier || identifier).trim();
  const description = String(doc.summary || meta.description || "").trim();
  if (!description) throw new Error("该智能体没有提供描述，无法生成技能");
  const body = [
    `# ${name}`,
    "",
    `> 来源：LobeHub 智能体 \`${identifier}\``,
    "",
    String(doc.config?.systemRole || doc.openingMessage || "").trim(),
  ].join("\n");
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(identifier)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
  ].join("\n");
  return { name, description, files: { "SKILL.md": frontmatter + body } };
}

// ---------------------------------------------------------------- skillsmp
// skillsmp.com answers 403 "Just a moment…" to this process's fetch/https but 200 to the
// curl transport (see src/http.js): the edge fingerprints the TLS client, not the headers.
// The payload is `{ skills: [...], pagination: { total } }`; every row carries the exact
// GitHub location, so an install is a plain repo+skillDir download.
const SKILLSMP_TTL = 10 * 60 * 1000;

function skillsmpTarget(raw) {
  const route = raw.route || {};
  const url = String(raw.githubUrl || "");
  const tree = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i);
  const branch = String(raw.branch || (tree ? tree[3] : "") || "main");
  let skillDir = String(route.sourceSkillPath || "").replace(/\/?SKILL\.md$/i, "");
  if (!skillDir && tree) skillDir = tree[4];
  const repo = tree ? `${tree[1]}/${tree[2]}` : "";
  return { repo, branch, skillDir };
}

export async function searchSkillsMp({ query = "", pageSize = 24, cache }) {
  const q = String(query || "").trim();
  const key = `skillsmp:${q || "all"}:${pageSize}`;
  const cached = cache ? await cache.get(key, SKILLSMP_TTL) : undefined;
  if (Array.isArray(cached) && cached.length) {
    return { source: "skillsmp", items: cached, total: cached.length };
  }
  const params = new URLSearchParams({ q, page: "1", limit: String(Math.max(pageSize, 10)) });
  const data = await getJsonEscalating(`https://skillsmp.com/api/skills?${params.toString()}`, {
    headers: { referer: "https://skillsmp.com/" },
    timeoutMs: 20000,
  });
  const rows = Array.isArray(data.skills) ? data.skills : [];
  const items = rows.slice(0, pageSize).map((raw) => {
    const { repo, branch, skillDir } = skillsmpTarget(raw);
    return {
      id: `skillsmp:${raw.id || raw.name}`,
      slug: raw.name || String(raw.id || ""),
      name: raw.name || String(raw.id || ""),
      description: raw.description || "",
      source: "skillsmp",
      sourceLabel: "skillsmp",
      owner: raw.author || "",
      homepage: raw.githubUrl || "",
      // parseRepoRef understands `owner/repo@ref`, so the branch rides along here.
      upstreamUrl: repo ? `${repo}@${branch}` : "",
      skillDir,
      ref: branch,
      // The upstream `stars` field is a placeholder (identical across unrelated rows),
      // so it is not surfaced as a popularity signal.
      stars: 0,
      category: "",
      installable: Boolean(repo),
    };
  });
  // An empty page is never cached: one upstream hiccup must not blank the market for ten
  // minutes, and the next request should retry immediately.
  if (cache && items.length) await cache.put(key, items);
  return { source: "skillsmp", items, total: Number(data.pagination && data.pagination.total) || items.length };
}

/** Resolve a clawhub reference (`owner/slug`) to its GitHub-backed skill directory. */
export async function clawhubResolve(reference) {
  const [owner, slug] = String(reference || "").split("/");
  if (!owner || !slug) throw new Error("clawhub 引用格式应为 owner/slug");
  const page = await (await fetch(`https://clawhub.ai/${owner}/skills/${slug}`, { headers: UA, signal: AbortSignal.timeout(20000) })).text();
  const match = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/[\w.-]+\/([\w./-]+))?/.exec(page);
  if (!match) throw new Error("clawhub 页面里没有找到 GitHub 源仓库");
  return { repo: match[1], skillDir: match[2] || "" };
}
