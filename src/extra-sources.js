// Four more live sources, each following the reference implementation's own endpoint:
//   clawhub   — clawhub.ai/api/v1  (browse honours limit; search answers 10 rows per page)
//   trusttools— ai.trusttools.cn/api/skills/search (POST, item carries repo_url/repo_path)
//   LobeHub   — chat-agents.lobehub.com/index.json (agent index, installable as a SKILL)
//   skillsmp  — skillsmp.com/api/skills (paged search; Cloudflare-fronted, needs the curl
//               transport because this process's own TLS fingerprint is refused)
//   modelscope— modelscope.cn/api/v1/dolphin/skills (PUT, PageNumber/PageSize + TotalCount)
// Every source here answers a real `page`: either the upstream pages, or a whole catalogue
// is fetched once and sliced locally. That is what makes「加载更多」actually extend the list.
import { getJsonEscalating, postJsonEscalating } from "./http.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.9", accept: "application/json" };

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

/** Local page slice for sources whose upstream hands over a whole catalogue at once. */
function slice(rows, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  const all = Array.isArray(rows) ? rows : [];
  return { rows: all.slice((p - 1) * size, p * size), start: (p - 1) * size, size, all };
}

// ---------------------------------------------------------------- clawhub
// clawhub 的 fetch 在本机偶发瞬时中断（fetch failed），做一次网络重试，
// 避免把一次抖动当成「不可达」误导用户。
async function getJsonClawHub(url, attempt = 0) {
  try {
    // clawhub 的前端 CDN 对 Node 的 TLS/连接指纹时好时坏，所以走 fetch→curl→python 逐级降级。
    return await getJsonEscalating(url, { headers: UA, timeoutMs: 25000 });
  } catch (error) {
    if (attempt < 1 && /fetch failed|ETIMEDOUT|ECONNRESET|socket|network|timeout/i.test(String((error && error.message) || error))) {
      return getJsonClawHub(url, attempt + 1);
    }
    throw error;
  }
}

function mapClawHubRows(rows, q, mode, limitOverride) {
  const limit = limitOverride ?? 24;
  const items = (Array.isArray(rows) ? rows : []).slice(0, limit).map((raw) => {
    const install = raw.install || {};
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
      // 搜索端点无分页；浏览端点支持 limit。让客户端据此决定「加载更多」是否可用
      paged: mode === "browse",
    };
  });
  return { source: "clawhub", items, total: items.length };
}

const CLAWHUB_CATALOG_KEY = "clawhub_catalog_v1";
const CLAWHUB_CATALOG_TTL = 6 * 3600 * 1000;

// 浏览端点每屏 50 条并带 nextCursor（JSON 字符串），顺着它累积成本地目录再按页切片：
// 这样第 2 页、第 20 页拿到的都是真正的新条目，而不是上游的第一屏。
async function extendClawHubCatalog(cache, need) {
  let state = cache ? await cache.get(CLAWHUB_CATALOG_KEY, CLAWHUB_CATALOG_TTL) : undefined;
  if (!state || !Array.isArray(state.rows)) state = { rows: [], cursor: null, done: false };
  const seen = new Set(state.rows.map((raw) => String(raw.id ?? raw.slug ?? "")));
  let guard = 0;
  while (!state.done && state.rows.length < need && guard < 10) {
    guard += 1;
    const cursor = state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : "";
    const data = await getJsonClawHub(`https://clawhub.ai/api/v1/skills?limit=50${cursor}`);
    const rows = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
    for (const raw of rows) {
      const key = String(raw.id ?? raw.slug ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      state.rows.push(raw);
    }
    const next = data.nextCursor || null;
    if (rows.length === 0 || !next || next === state.cursor) state.done = true;
    else state.cursor = next;
  }
  if (cache) await cache.put(CLAWHUB_CATALOG_KEY, state);
  return state;
}

export async function searchClawHub({ query = "", page = 1, pageSize = 24, cache }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const q = String(query || "").trim();
  if (q) {
    // search 端点固定回 10 条/页，顺着 page 取到当前页并拼接上首页，避免翻页拿空。
    const wanted = Math.min(60, size * p);
    const pages = [];
    const perPage = 10;
    for (let i = 1; i <= Math.min(6, Math.ceil(wanted / perPage)); i += 1) {
      pages.push(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}&page=${i}&limit=${perPage}`);
    }
    const settled = await Promise.allSettled(pages.map((url) => getJsonClawHub(url)));
    if (settled.every((item) => item.status === "rejected")) {
      throw new Error("clawhub 搜索不可达（网络中断，已重试一次）");
    }
    const seen = new Set();
    const merged = [];
    for (const item of settled) {
      if (item.status !== "fulfilled") continue;
      const rows = Array.isArray(item.value?.results) ? item.value.results : Array.isArray(item.value?.items) ? item.value.items : [];
      for (const raw of rows) {
        const key = String(raw.id ?? raw.slug ?? raw.displayName ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(raw);
      }
    }
    const slicedRows = merged.slice((p - 1) * size, p * size);
    const out = mapClawHubRows(slicedRows, q, "search", slicedRows.length);
    out.total = merged.length >= wanted ? wanted + 1 : merged.length;
    out.hasMore = merged.length >= wanted;
    return out;
  }
  // 浏览：顺着 nextCursor 把目录累积到需要的深度，再本地切出这一页。
  const need = Math.min(600, size * p);
  const state = await extendClawHubCatalog(cache, need);
  const rows = state.rows;
  const matched = rows.slice((p - 1) * size, p * size);
  const out = mapClawHubRows(matched, q, "browse", matched.length);
  if (!rows.length) out.hint = "clawhub 当前没有返回条目（可达，但列表为空）";
  out.hasMore = p * size < rows.length || (!state.done && rows.length >= p * size);
  out.total = state.done ? rows.length : Math.max(rows.length, p * size) + 1;
  return out;
}

export async function searchTrustTools({ query = "", page = 1, pageSize = 24, cache } = {}) {
  // trusttools ignores `pageSize` and always answers with 10 rows per page, so a page of 24
  // needs three upstream pages stitched together (pages are disjoint, verified).
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const perPage = 10;
  const perBatch = Math.ceil(size / perPage);
  const first = (p - 1) * perBatch + 1;
  const rows = [];
  const seen = new Set();
  let total = 0;
  for (let index = 0; index < perBatch; index += 1) {
    const upstreamPage = first + index;
    const key = `trusttools:${String(query).trim().toLowerCase()}:${upstreamPage}`;
    let data = cache ? await cache.get(key, 10 * 60 * 1000) : undefined;
    if (!data) {
      data = await postJsonEscalating(
        "https://ai.trusttools.cn/api/skills/search",
        { q: query, page: upstreamPage, pageSize: perPage },
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
  const items = rows.slice(0, size).map((raw) => {
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
  const known = total || 0;
  return {
    source: "trusttools",
    items,
    total: known,
    hasMore: known ? p * size < known : items.length >= size,
  };
}

// ---------------------------------------------------------------- LobeHub agents (skills)
export async function searchLobeHubSkills({ query = "", page = 1, pageSize = 24, cache }) {
  let agents = await cache.get("lobehub_agents", 6 * 3600 * 1000);
  if (!agents) {
    const data = await getJson("https://chat-agents.lobehub.com/index.json", 25000);
    agents = Array.isArray(data.agents) ? data.agents : [];
    await cache.put("lobehub_agents", agents);
  }
  const q = query.trim().toLowerCase();
  const matched = [];
  for (const raw of agents) {
    const meta = raw.meta || {};
    const hay = `${raw.identifier} ${meta.title || ""} ${meta.description || ""} ${(meta.tags || []).join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    matched.push(raw);
  }
  const { rows } = slice(matched, page, pageSize);
  const items = rows.map((raw) => {
    const meta = raw.meta || {};
    return {
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
    };
  });
  return { source: "lobehub-agent", items, total: matched.length, hasMore: (Number(page) || 1) * pageSize < matched.length };
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

export async function searchSkillsMp({ query = "", page = 1, pageSize = 24, cache }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const key = `skillsmp:${q || "all"}:${p}:${size}`;
  const cached = cache ? await cache.get(key, SKILLSMP_TTL) : undefined;
  if (cached && Array.isArray(cached.items) && cached.items.length) return { ...cached, source: "skillsmp" };
  const params = new URLSearchParams({ q, page: String(p), limit: String(Math.max(size, 10)) });
  const data = await getJsonEscalating(`https://skillsmp.com/api/skills?${params.toString()}`, {
    headers: { referer: "https://skillsmp.com/" },
    timeoutMs: 20000,
  });
  const rows = Array.isArray(data.skills) ? data.skills : [];
  const items = rows.slice(0, size).map((raw) => {
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
  const total = Number(data.pagination && data.pagination.total) || p * size + (rows.length >= size ? 1 : 0);
  const payload = { source: "skillsmp", items, total, hasMore: p * size < total };
  // An empty page is never cached: one upstream hiccup must not blank the market for ten
  // minutes, and the next request should retry immediately.
  if (cache && items.length) await cache.put(key, payload);
  return payload;
}

// ---------------------------------------------------------------- ModelScope
// PUT https://modelscope.cn/api/v1/dolphin/skills {PageNumber,PageSize,Query?} → Data.SkillList,
// Data.TotalCount（实测 88k+ 条、页与页不重复）。技能正文挂在 SourceURL 的 GitHub 地址上。
const MODELSCOPE_SKILLS_URL = "https://modelscope.cn/api/v1/dolphin/skills";

export async function searchModelScope({ query = "", page = 1, pageSize = 24 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const body = { PageNumber: p, PageSize: size };
  const q = String(query || "").trim();
  if (q) body.Query = q;
  const response = await fetch(MODELSCOPE_SKILLS_URL, {
    method: "PUT",
    headers: { ...UA, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`ModelScope HTTP ${response.status}`);
  const payload = await response.json();
  const data = payload.Data || {};
  const rows = Array.isArray(data.SkillList) ? data.SkillList : [];
  const total = Number(data.TotalCount) || 0;
  const items = rows.filter((raw) => raw && raw.Name).map((raw) => {
    const owner = raw.Path || raw.Owner || "";
    const name = raw.Name || "";
    const ident = owner ? `${owner}/${name}` : name;
    const source = String(raw.SourceURL || "");
    const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/i.exec(source);
    const repo = gh ? `${gh[1]}/${gh[2]}` : "";
    const branch = gh ? gh[3] : "main";
    const skillDir = gh ? gh[4].replace(/\/?SKILL\.md$/i, "") : "";
    return {
      id: `modelscope:${ident}`,
      slug: name,
      name: raw.DisplayName || name,
      description: raw.Description || raw.DescriptionEn || "",
      category: raw.L1 && typeof raw.L1 === "object" ? raw.L1.ChineseName || "" : "",
      source: "modelscope",
      sourceLabel: "ModelScope",
      owner,
      homepage: source || `https://modelscope.cn/skills/${ident}`,
      upstreamUrl: repo ? `${repo}@${branch}` : "",
      ref: branch,
      skillDir,
      downloads: Number(raw.DownloadCount || 0),
      tags: Array.isArray(raw.Tags) ? raw.Tags : [],
      installable: Boolean(repo),
    };
  });
  return { source: "modelscope", items, total: total || p * size + (rows.length >= size ? 1 : 0), hasMore: total ? p * size < total : rows.length >= size };
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
