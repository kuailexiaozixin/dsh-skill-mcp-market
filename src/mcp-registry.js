// MCP catalogue backed by the official Model Context Protocol registry.
//
// Why this replaced the LobeHub sitemap scrape: LobeHub now answers
// `402 {"error":"payment_required","message":"Automated access to LobeHub marketplace pages
// requires an API plan."}` for both its sitemap and its /mcp/<slug> pages, so the old
// catalogue could not be rebuilt and even install-by-slug lost its definition source.
// registry.modelcontextprotocol.io is free, anonymous, official and carries the actual
// launch recipe (npm package + stdio transport, or a streamable-http endpoint), which is
// exactly what a connector install needs.
//
// Endpoint shape (verified live):
//   GET /v0/servers?search=<q>&limit=<n>[&cursor=<c>]
//   { servers: [ { server: { name, description, title?, repository?, packages?, remotes? },
//                  _meta: { "io.modelcontextprotocol.registry/official": { isLatest } } } ],
//     metadata: { nextCursor, count } }
import { getJson } from "./http.js";
import { normalizeServerName } from "./mcp.js";

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const CATALOGUE_TTL = 10 * 60 * 1000;
// Bumped whenever a card's shape changes, so an upgrade never serves cards built by the
// previous code from the disk cache.
const CACHE_VERSION = "v2";

/** Every entry is a distinct published version; keep the latest one per server name. */
function latestOnly(rows) {
  const chosen = new Map();
  for (const row of rows) {
    const server = row && row.server;
    if (!server || !server.name) continue;
    const official = (row._meta && row._meta["io.modelcontextprotocol.registry/official"]) || {};
    const current = chosen.get(server.name);
    if (!current) {
      chosen.set(server.name, { server, latest: official.isLatest === true });
      continue;
    }
    if (!current.latest && official.isLatest === true) chosen.set(server.name, { server, latest: true });
  }
  return [...chosen.values()].map((entry) => entry.server);
}

function isEnvName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""));
}

/** The registry's launch recipe for one server, in this plugin's definition shape. */
export function registryDefinition(server, serverNameHint = "") {
  const name = String(server.name || "");
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find((entry) => entry && entry.registryType === "npm") || null;
  const remote = (Array.isArray(server.remotes) ? server.remotes : [])[0] || null;
  const envRequired = [];
  const env = {};
  const envHints = {};

  if (npm && npm.identifier) {
    for (const variable of npm.environmentVariables || []) {
      if (!variable || !isEnvName(variable.name)) continue;
      if (variable.description) envHints[variable.name] = String(variable.description).slice(0, 200);
      // Only truly required values become blocking prompts. Registry entries routinely list
      // a dozen optional tunables (timeouts, paths, proxy settings); prompting for all of
      // them would make every install look broken, and an empty ${VAR} would override the
      // server's own default, so optional variables are documentation only.
      if (variable.isRequired === true) {
        // The config file keeps a ${VAR} placeholder; the value lives in the user's
        // environment, which is what the panel's secret prompt writes.
        env[variable.name] = `\${${variable.name}}`;
        envRequired.push(variable.name);
      }
    }
    const tail = name.split("/").pop();
    return {
      serverName: normalizeServerName(serverNameHint || tail || name),
      title: server.title || name,
      description: String(server.description || "").slice(0, 500),
      transport: "stdio",
      command: "npx",
      args: ["-y", npm.identifier],
      env,
      envRequired,
      envHints,
      url: "",
      headers: {},
      source: "registry",
      upstream: name,
      repository: (server.repository && server.repository.url) || "",
    };
  }

  if (remote && remote.url) {
    const headers = {};
    for (const header of remote.headers || []) {
      if (!header || !isEnvName(header.name)) continue;
      headers[header.name] = `\${${header.name}}`;
      envRequired.push(header.name);
      if (header.description) envHints[header.name] = String(header.description).slice(0, 200);
    }
    // DSH speaks stdio and streamable-http; a bare SSE endpoint has no supported transport.
    const transport = String(remote.type || "").includes("sse") ? "sse" : "streamable-http";
    return {
      serverName: normalizeServerName(serverNameHint || name.split("/").pop() || name),
      title: server.title || name,
      description: String(server.description || "").slice(0, 500),
      transport,
      command: "",
      args: [],
      env,
      envRequired,
      envHints,
      url: remote.url,
      headers,
      source: "registry",
      upstream: name,
      repository: (server.repository && server.repository.url) || "",
    };
  }

  return null;
}

/** Turn one registry server into a market card. */
export function registryCard(server) {
  const definition = registryDefinition(server);
  const name = String(server.name || "");
  const transports = [
    ...(Array.isArray(server.packages) ? server.packages.map((p) => p.registryType) : []),
    ...(Array.isArray(server.remotes) ? server.remotes.map((r) => r.type) : []),
  ].filter(Boolean);
  return {
    id: `registry:${name}`,
    slug: name,
    name: server.title || name.split("/").pop() || name,
    description: String(server.description || "").slice(0, 300),
    category: "",
    transport: definition ? definition.transport : "",
    command: definition ? definition.command : "",
    args: definition ? definition.args : [],
    envRequired: definition ? definition.envRequired : [],
    envHints: definition ? definition.envHints : {},
    homepage: (server.repository && server.repository.url) || "",
    installable: Boolean(definition),
    note: definition
      ? undefined
      : "该条目没有提供可用的启动方式（既无 npm 包也无远程端点），无法安装",
    transports,
    source: "registry",
  };
}

export function registryQueryUrl(query, pageSize, cursor) {
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (String(query || "").trim()) params.set("search", String(query).trim());
  if (cursor) params.set("cursor", cursor);
  return `${REGISTRY_URL}?${params.toString()}`;
}

/**
 * Search the registry. Results are cached per query; an empty page is never cached so a
 * single upstream hiccup cannot blank the market until the TTL expires.
 */
export async function searchMcpRegistry({ query = "", pageSize = 60, cursor = "", cache } = {}) {
  const terms = String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // The registry `search` parameter is token-exact: "playwright stealth" returns nothing
  // while each word alone returns hits. Search the tokens separately and rank the union by
  // how many of them a card actually matches.
  if (!cursor && terms.length > 1) {
    const lists = await Promise.all(terms.slice(0, 3).map((term) => searchRegistryTerm(term, pageSize, cache)));
    const merged = new Map();
    for (const item of lists.flatMap((list) => list.items)) {
      const hay = `${item.slug} ${item.name} ${item.description}`.toLowerCase();
      const score = terms.filter((term) => hay.includes(term.toLowerCase())).length;
      const previous = merged.get(item.slug);
      if (!previous || score > previous.score) merged.set(item.slug, { item, score });
    }
    const items = [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, pageSize)
      .map((entry) => entry.item);
    if (items.length > 0) return { items, nextCursor: "", cached: false };
  }
  return searchRegistryTerm(query, pageSize, cache, cursor);
}

async function searchRegistryTerm(query, pageSize, cache, cursor = "") {
  const key = `registry:${CACHE_VERSION}:${String(query || "").trim().toLowerCase() || "all"}:${pageSize}`;
  if (!cursor && cache) {
    const cached = await cache.get(key, CATALOGUE_TTL);
    if (Array.isArray(cached) && cached.length) return { items: cached, nextCursor: "", cached: true };
  }
  const data = await getJson(registryQueryUrl(query, pageSize, cursor), { timeoutMs: 20000 });
  const servers = latestOnly(Array.isArray(data.servers) ? data.servers : []);
  const items = servers.map(registryCard);
  if (!cursor && cache && items.length) await cache.put(key, items);
  return { items, nextCursor: (data.metadata && data.metadata.nextCursor) || "", cached: false };
}

/** Resolve one registry server name to an installable definition (exact match wins). */
export async function registryDefinitionByName(name, serverNameHint = "") {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const tail = wanted.split("/").pop();
  // The API has no exact-lookup route, so search for the last path segment and then
  // require a literal name match; a fuzzy hit must never install a different server.
  for (const term of [wanted, tail]) {
    let data;
    try {
      data = await getJson(registryQueryUrl(term, 50, ""), { timeoutMs: 20000 });
    } catch {
      continue;
    }
    const servers = latestOnly(Array.isArray(data.servers) ? data.servers : []);
    const exact = servers.find((server) => server.name === wanted);
    if (exact) return registryDefinition(exact, serverNameHint);
  }
  return null;
}

/**
 * Last-resort cards when every catalogue call fails and no cached result exists. These are
 * real, verified registry names (checked live), not invented placeholders; installing one
 * still resolves through the registry, so a wrong guess fails loudly instead of silently.
 */
export const FALLBACK_SERVERS = [
  {
    name: "io.github.Async23/chrome-devtools-mcp",
    description: "Chrome DevTools 自动化：调试、网络与性能分析（npm @async23/chrome-devtools-mcp）",
  },
  {
    name: "com.pulsemcp/playwright-stealth",
    description: "带反检测的 Playwright 浏览器自动化（npm playwright-stealth-mcp-server）",
  },
  {
    name: "io.github.arifulislamat/database-mcp-sqlite",
    description: "SQLite 数据库查询与结构检查（npm @database-mcp/sqlite）",
  },
  {
    name: "com.foreverworks/notion",
    description: "Notion 页面与数据库读写（npm @foreverworks/mcp-notion，需要 NOTION_TOKEN）",
  },
];

/** Static cards used only when the registry is unreachable and nothing is cached. */
export function fallbackCards(query = "") {
  const q = String(query || "").trim().toLowerCase();
  return FALLBACK_SERVERS.filter((entry) => !q || `${entry.name} ${entry.description}`.toLowerCase().includes(q)).map(
    (entry) => ({
      id: `registry:${entry.name}`,
      slug: entry.name,
      name: entry.name.split("/").pop(),
      description: entry.description,
      category: "",
      transport: "stdio",
      command: "npx",
      args: [],
      envRequired: [],
      envHints: {},
      homepage: "",
      installable: true,
      catalogFallback: true,
      source: "registry",
    }),
  );
}
