// MCP connector manager: definitions on disk, live mounts through the shipped dsh-mcp-client plugin.
import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeJson } from "./home.js";
import { importShipped, pluginFrom, SHIPPED } from "./shipped.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function normalizeServerName(raw) {
  const base = String(raw || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return NAME_RE.test(base) ? base : "";
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolvePlaceholders(value) {
  if (typeof value !== "string") return value;
  return value.replace(PLACEHOLDER, (_, key) => process.env[key] ?? "");
}

function resolveMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const resolved = resolvePlaceholders(String(value));
    if (resolved !== "") out[key] = resolved;
  }
  return out;
}

export function missingEnv(def) {
  const missing = [];
  const scan = (value) => {
    const text = String(value ?? "");
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!process.env[match[1]]) missing.push(match[1]);
    }
  };
  for (const value of Object.values(def.env || {})) scan(value);
  for (const value of Object.values(def.headers || {})) scan(value);
  for (const arg of def.args || []) scan(arg);
  for (const name of def.envRequired || []) {
    if (!(name in (def.env || {})) && !process.env[name]) missing.push(name);
  }
  return [...new Set(missing)];
}

export function toClientConfig(def) {
  const common = {
    serverName: def.serverName,
    failOnStartupError: false,
    toolCallTimeoutMs: Number(def.toolCallTimeoutMs) > 0 ? Number(def.toolCallTimeoutMs) : 60000,
    reconnect: { enabled: true },
  };
  if (def.transport === "streamable-http") {
    return { ...common, transport: "streamable-http", url: resolvePlaceholders(def.url || ""), headers: resolveMap(def.headers) };
  }
  return {
    ...common,
    transport: "stdio",
    command: resolvePlaceholders(def.command || ""),
    args: (def.args || []).map((arg) => resolvePlaceholders(String(arg))),
    env: resolveMap(def.env),
    ...(def.cwd ? { cwd: resolvePlaceholders(def.cwd) } : {}),
  };
}

export function createMcpManager({ ctx, dirs, shippedRoot, log }) {
  const mounted = new Map();
  const watchers = [];
  let disposed = false;

  const logInfo = (message) => log?.("info", message);
  const logWarn = (message) => log?.("warn", message);

  async function readDefs() {
    const defs = new Map();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of names) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        try {
          const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
          const serverName = normalizeServerName(raw.serverName || file.replace(/\.json$/, ""));
          if (!serverName) continue;
          defs.set(serverName, { ...raw, serverName, filePath: join(dir, file), dir });
        } catch {
          // malformed definition: skip, keep the rest
        }
      }
    }
    return defs;
  }

  function toolNamesFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    try {
      return ctx.tools
        .definitions()
        .map((definition) => definition.name)
        .filter((name) => name.startsWith(prefix));
    } catch {
      return [];
    }
  }

  async function mount(def) {
    if (mounted.has(def.serverName)) return { ok: true, alreadyMounted: true, tools: toolNamesFor(def.serverName) };
    const missing = missingEnv(def);
    if (missing.length > 0) {
      return { ok: false, serverName: def.serverName, error: "missing environment values", missing };
    }
    const namespace = await importShipped(SHIPPED.mcpClient, shippedRoot);
    const fiber = ctx.plugin(pluginFrom(namespace, `market-mcp-${def.serverName}`), toClientConfig(def));
    mounted.set(def.serverName, { fiber, def });
    logInfo(`mounted MCP server "${def.serverName}"`);
    return { ok: true, serverName: def.serverName, mounted: true };
  }

  function unmount(serverName) {
    const entry = mounted.get(serverName);
    if (!entry) return false;
    try {
      entry.fiber?.dispose?.();
    } catch (error) {
      logWarn(`disposing MCP server "${serverName}" failed: ${String(error?.message || error)}`);
    }
    mounted.delete(serverName);
    return true;
  }

  async function list() {
    const defs = await readDefs();
    return [...defs.values()].map((def) => ({
      serverName: def.serverName,
      title: def.title || def.serverName,
      description: def.description || "",
      transport: def.transport || "stdio",
      command: def.command || "",
      args: def.args || [],
      url: def.url || "",
      enabled: def.enabled !== false,
      mounted: mounted.has(def.serverName),
      tools: toolNamesFor(def.serverName),
      envKeys: [...Object.keys(def.env || {}), ...(def.envRequired || [])],
      source: def.source || "manual",
      slug: def.slug || "",
      path: def.filePath,
      installedAt: def.installedAt || "",
    }));
  }

  async function save(def) {
    const dir = def.dir || dirs[0];
    if (!dir) throw new Error("no MCP directory is configured");
    await ensureDir(dir);
    const serverName = normalizeServerName(def.serverName);
    if (!serverName) throw new Error("serverName must match [A-Za-z0-9_-]{1,32}");
    const payload = { ...def, serverName, installedAt: def.installedAt || new Date().toISOString() };
    delete payload.filePath;
    delete payload.dir;
    await writeJson(join(dir, `${serverName}.json`), payload);
    return { ...payload, dir, filePath: join(dir, `${serverName}.json`) };
  }

  async function reconcile() {
    if (disposed) return;
    const defs = await readDefs();
    for (const [name] of [...mounted]) {
      const def = defs.get(name);
      if (!def || def.enabled === false) unmount(name);
    }
    for (const def of defs.values()) {
      if (def.enabled === false) continue;
      if (mounted.has(def.serverName)) continue;
      const result = await mount(def);
      if (!result.ok) logWarn(`MCP server "${def.serverName}" not mounted: ${result.error}`);
    }
  }

  async function install(def) {
    const saved = await save(def);
    if (saved.enabled === false) return { ok: true, serverName: saved.serverName, enabled: false };
    unmount(saved.serverName);
    const result = await mount({ ...saved, filePath: saved.filePath, dir: saved.dir });
    return { ...result, serverName: saved.serverName };
  }

  async function uninstall(serverName) {
    const name = normalizeServerName(serverName);
    unmount(name);
    const removed = [];
    for (const dir of dirs) {
      const file = join(dir, `${name}.json`);
      if (!existsSync(file)) continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trash = join(dir, ".trash", `${name}-${stamp}.json`);
      await ensureDir(join(dir, ".trash"));
      try {
        const text = await readFile(file, "utf8");
        await writeJson(trash, JSON.parse(text));
      } catch {
        // keep going: the definition file is removed regardless
      }
      await rm(file, { force: true });
      removed.push(file);
    }
    return { ok: removed.length > 0, serverName: name, removed };
  }

  async function setEnabled(serverName, enabled) {
    const name = normalizeServerName(serverName);
    const defs = await readDefs();
    const def = defs.get(name);
    if (!def) throw new Error(`no MCP definition named "${name}"`);
    const saved = await save({ ...def, enabled: Boolean(enabled) });
    if (enabled) {
      unmount(name);
      await mount({ ...saved, filePath: saved.filePath, dir: saved.dir });
    } else {
      unmount(name);
    }
    return { ok: true, serverName: name, enabled: Boolean(enabled) };
  }

  async function probe(serverName, timeoutMs = 8000) {
    const name = normalizeServerName(serverName);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const tools = toolNamesFor(name);
      if (tools.length > 0) return { ok: true, serverName: name, tools, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      ok: false,
      serverName: name,
      tools: [],
      waitedMs: Date.now() - started,
      error: mounted.has(name)
        ? "the MCP client is mounted but has not published tools yet; check the server command, network, and DSH logs"
        : "the MCP client is not mounted",
    };
  }

  function startWatching() {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          clearTimeout(startWatching.timer);
          startWatching.timer = setTimeout(() => {
            reconcile().catch((error) => logWarn(`MCP rescan failed: ${String(error?.message || error)}`));
          }, 300);
        });
        watcher.on?.("error", () => {});
        watchers.push(watcher);
      } catch (error) {
        logWarn(`cannot watch ${dir}: ${String(error?.message || error)}`);
      }
    }
  }

  async function init() {
    for (const dir of dirs) await ensureDir(dir);
    await reconcile();
    startWatching();
  }

  function dispose() {
    disposed = true;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.length = 0;
    for (const name of [...mounted.keys()]) unmount(name);
  }

  return { init, dispose, list, install, uninstall, setEnabled, probe, reconcile, mount, unmount, toolNamesFor, readDefs };
}
