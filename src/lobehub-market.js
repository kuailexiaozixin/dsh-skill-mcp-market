// The second MCP market: LobeHub's plugin marketplace.
//
// LobeHub used to be reachable only by scraping its pages, which is why this plugin kept it
// as a last-resort fallback. It now ships a documented marketplace API, used through its own
// CLI (`@lobehub/market-cli`), which handles the OAuth client registration for us:
//
//   npx -y @lobehub/market-cli register --base-url https://market.lobehub.com --name "DSH Market" --source dsh
//   npx -y @lobehub/market-cli mcp search --q "playwright" --sort installCount --output json
//   npx -y @lobehub/market-cli mcp view  <identifier> --output json
//
// Search results carry name/author/description/category/installCount/ratingAverage, i.e. the
// same fields the reference desktop app renders. The per-plugin manifest (command, args, url,
// env schema) is served anonymously at /api/v1/plugins/<identifier>/manifest, so installs do
// not need the CLI at all.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getJson } from "./http.js";

/** Marketplace origin; overridable for self-hosted or test instances. */
export const LOBEHUB_MARKET_BASE = process.env.LOBEHUB_MARKET_BASE_URL || "https://market.lobehub.com";

/** Where the CLI keeps the registered client credentials. */
export function lobehubCredentialsPath() {
  return join(homedir(), ".lobehub-market", "credentials.json");
}

export function lobehubRegistered() {
  try {
    return existsSync(lobehubCredentialsPath());
  } catch {
    return false;
  }
}

/** Quote one argv item for a `cmd /c` command line. */
function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runCli(args, timeoutMs = 90000) {
  // Windows cannot execFile a `.cmd` shim without a shell (EINVAL), so the CLI runs through
  // cmd.exe there with an explicitly quoted command line.
  const isWindows = process.platform === "win32";
  const file = isWindows ? process.env.ComSpec || "cmd.exe" : "npx";
  const argv = isWindows
    ? ["/d", "/s", "/c", ["npx", "-y", "@lobehub/market-cli", ...args].map(quoteForCmd).join(" ")]
    : ["-y", "@lobehub/market-cli", ...args];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, MARKET_BASE_URL: LOBEHUB_MARKET_BASE, NO_COLOR: "1", npm_config_yes: "true" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || "")
            .split(/\r?\n/)
            .filter((line) => !/^npm notice/.test(line.trim()))
            .join(" ")
            .replace(/\s+/g, " ")
            .slice(0, 300);
          const wrapped = new Error(`LobeHub 市场命令失败：${detail}`);
          wrapped.code = error.code;
          reject(wrapped);
        } else {
          resolve(String(stdout || ""));
        }
      },
    );
  });
}

/** Register this plugin as a marketplace client once; the CLI stores the credentials itself. */
export async function registerLobeHubClient(name = "DSH Market") {
  await runCli(["register", "--base-url", LOBEHUB_MARKET_BASE, "--name", name, "--source", "dsh"], 150000);
  return lobehubCredentialsPath();
}

function parseJsonOutput(text) {
  const start = String(text).indexOf("{");
  if (start < 0) throw new Error(`LobeHub 市场返回了非 JSON 内容：${String(text).slice(0, 120)}`);
  return JSON.parse(String(text).slice(start));
}

function mapItem(raw) {
  const connectionType = String(raw.connectionType || "").toLowerCase();
  const transport = connectionType === "local" || connectionType === "stdio"
    ? "stdio"
    : raw.haveCloudEndpoint || connectionType === "remote" || connectionType === "http"
      ? "streamable-http"
      : "stdio";
  return {
    id: `lobehub:${raw.identifier}`,
    slug: raw.identifier,
    name: raw.name || raw.identifier,
    description: raw.description || "",
    category: raw.category || "",
    transport,
    envRequired: Array.isArray(raw.envRequired) ? raw.envRequired : [],
    installable: Boolean(raw.identifier),
    homepage: raw.homepage || raw.github?.url || `https://market.lobehub.com/s/plugins/${raw.identifier}`,
    owner: raw.author || "",
    installs: Number(raw.installCount) || 0,
    rating: Number(raw.ratingAverage) || 0,
    ratingCount: Number(raw.ratingCount) || 0,
    stars: Number(raw.github?.stars) || 0,
    createdAt: raw.createdAt || "",
    featured: Boolean(raw.isFeatured),
    validated: Boolean(raw.isValidated),
    source: "lobehub",
    sourceLabel: "LobeHub",
    manifestUrl: raw.manifestUrl || "",
  };
}

/**
 * Search the LobeHub marketplace. Registered credentials are reused; a first run without any
 * registers this plugin automatically so the tab is never dead on arrival.
 */
export async function searchLobeHubMarket({ query = "", pageSize = 24, category = "", sort = "", page = 1, cache } = {}) {
  // The API rejects `--page-size 60` with "Bad Request"; 40 answers reliably.
  const size = Math.max(1, Math.min(40, Number(pageSize) || 24));
  const pageNumber = Math.max(1, Number(page) || 1);
  const key = `lobehub_market:${String(query).toLowerCase()}:${category}:${sort}:${pageNumber}:${size}`;
  if (cache) {
    const hit = await cache.get(key, 10 * 60 * 1000);
    if (hit) return hit;
  }
  const hasQuery = Boolean(String(query).trim());
  const args = ["mcp", "search", "--output", "json", "--page", String(pageNumber), "--page-size", String(size)];
  if (hasQuery) args.push("--q", String(query).trim());
  if (category) args.push("--category", category);
  // `--sort` without a query is rejected ("Bad Request"), so browsering keeps the API order
  // and the requested ordering is applied to the returned page locally.
  if (sort && hasQuery) args.push("--sort", sort);

  const attempt = async (timeoutMs) => {
    // "fetch failed" from the CLI is a transient reachability error on this network (the same
    // class of flakiness GitHub shows here), so a couple of retries turn it into a success.
    let lastError;
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        return await runCli(args, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!/fetch failed|ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(error.message || error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * (tries + 1)));
      }
    }
    throw lastError;
  };

  let text;
  try {
    text = await attempt(90000);
  } catch (error) {
    // A missing or rejected registration is the one failure worth repairing automatically.
    if (lobehubRegistered()) throw error;
    await registerLobeHubClient();
    text = await attempt(120000);
  }
  const data = parseJsonOutput(text);
  const items = (data.items || []).map(mapItem);
  if (!hasQuery && sort) {
    const byInstalls = (a, b) => (b.installs || 0) - (a.installs || 0);
    const byRating = (a, b) => (b.rating || 0) - (a.rating || 0) || (b.ratingCount || 0) - (a.ratingCount || 0);
    const byNewest = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    const order = sort === "ratingAverage" ? byRating : sort === "createdAt" ? byNewest : byInstalls;
    items.sort(order);
  }
  const result = {
    source: "lobehub",
    sourceLabel: "LobeHub",
    items,
    total: Number(data.totalCount) || items.length,
    // Upstream mixes display names ("Finance") with real filter codes ("finance"); only the
    // lowercase codes are valid `--category` values, so they are what the panel offers.
    categories: Array.isArray(data.categories)
      ? [...new Set(data.categories.filter((code) => typeof code === "string" && /^[a-z0-9-]+$/.test(code)))]
      : [],
    page: Number(data.currentPage) || 1,
    pageSize: Number(data.pageSize) || size,
    totalPages: Number(data.totalPages) || 1,
  };
  if (cache) await cache.put(key, result);
  return result;
}

/** Turn one manifest deployment option into the plugin's MCP definition shape. */
function definitionFromManifest(manifest, identifier) {
  const options = Array.isArray(manifest.deploymentOptions) ? manifest.deploymentOptions : [];
  const withCommand = options.find((option) => option.connection && option.connection.command);
  const withUrl = options.find((option) => option.connection && option.connection.url);
  const chosen = withCommand || withUrl || options[0] || {};
  const connection = chosen.connection || {};
  const schema = connection.configSchema && connection.configSchema.properties ? connection.configSchema.properties : {};
  const env = {};
  for (const [name, spec] of Object.entries(connection.env || schema)) {
    env[name] = typeof spec === "string" ? spec : String(spec?.default ?? spec?.example ?? "");
  }
  const isHttp = Boolean(connection.url);
  return {
    title: manifest.name || identifier,
    description: manifest.description || "",
    transport: isHttp ? "streamable-http" : "stdio",
    command: isHttp ? "" : connection.command || "",
    args: Array.isArray(connection.args) ? connection.args : [],
    url: connection.url || "",
    env,
    headers: connection.headers && typeof connection.headers === "object" ? connection.headers : {},
    homepage: manifest.homepage || "",
    category: manifest.category || "",
    source: "lobehub",
    slug: identifier,
    envHints: Object.fromEntries(
      Object.entries(connection.env || schema).map(([name, spec]) => [name, String((spec && (spec.description || spec.title)) || "")]),
    ),
  };
}

/** Read one plugin manifest (public endpoint) and reduce it to a runnable definition. */
export async function lobehubManifestDefinition(identifier) {
  const url = `${LOBEHUB_MARKET_BASE}/api/v1/plugins/${encodeURIComponent(identifier)}/manifest`;
  const manifest = await getJson(url, { timeoutMs: 25000 });
  const definition = definitionFromManifest(manifest, identifier);
  if (!definition.command && !definition.url) {
    throw new Error(`LobeHub 条目 "${identifier}" 没有声明可用的启动方式（既无命令也无远程地址）`);
  }
  return definition;
}
