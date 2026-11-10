// SkillHub community source adapter (public, unauthenticated JSON API).
const BASE = "https://api.skillhub.cn/api/skills";
const UA = { "User-Agent": "dsh-skill-mcp-market/0.1 (+skill market)", accept: "application/json" };

async function getJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`SkillHub HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error(`SkillHub error code ${payload?.code}`);
    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function toItem(raw) {
  const namespace = raw.namespace || {};
  const canonical = namespace.canonicalName || raw.slug || "";
  const downloads = Number(raw.downloads ?? raw.installs ?? 0) || 0;
  const stars = Number(raw.stars ?? 0) || 0;
  return {
    id: `skillhub:${canonical || raw.slug}`,
    slug: raw.slug || namespace.publicSlug || canonical,
    name: raw.name || namespace.publicSlug || raw.slug,
    description: raw.description_zh || raw.description || "",
    category: raw.category || "",
    source: "skillhub",
    sourceLabel: "SkillHub（社区）",
    owner: raw.ownerName || namespace.displayName || "",
    iconUrl: raw.iconUrl || "",
    homepage: raw.homepage || "",
    upstreamUrl: raw.upstream_url || "",
    downloads,
    stars,
    verified: Boolean(raw.verified),
    version: raw.version || "",
    installable: Boolean(raw.upstream_url),
    namespace: canonical,
  };
}

export async function searchSkills({ query = "", page = 1, pageSize = 20, category = "" } = {}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  params.set("page", String(Math.max(1, page)));
  params.set("pageSize", String(Math.min(50, Math.max(1, pageSize))));
  const data = await getJson(`${BASE}?${params.toString()}`);
  const rows = Array.isArray(data.skills) ? data.skills : Array.isArray(data.items) ? data.items : [];
  const items = rows.map(toItem);
  return {
    source: "skillhub",
    items,
    total: Number(data.total ?? items.length) || items.length,
    page: Number(data.page ?? page) || page,
    pageSize: items.length || pageSize,
    hasMore: items.length >= pageSize,
  };
}

export async function categories() {
  const data = await getJson(`${BASE}/categories`);
  const rows = Array.isArray(data) ? data : Array.isArray(data.categories) ? data.categories : [];
  return rows
    .map((row) => (typeof row === "string" ? { key: row, name: row } : { key: row.key || row.name, name: row.name || row.key }))
    .filter((row) => row.key);
}
