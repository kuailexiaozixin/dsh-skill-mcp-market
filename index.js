// dsh-market — SKILL skill market + MCP connector market for DeepSeek Harness.
//
// Design notes
// * Skills are plain `<dir>/<name>/SKILL.md` directories. They are made live by mounting the
//   shipped `@deepseek-ai/dsh-skill-filesystem` provider over the user-configured directories;
//   that provider watches its roots and invalidates the catalog, so a freshly installed skill
//   reaches the next model step without restarting DSH.
// * MCP servers are plain `<dir>/<serverName>.json` definitions. Each enabled definition is
//   mounted as a live `@deepseek-ai/dsh-mcp-client` plugin instance, whose tools register on
//   `ctx.tools` immediately — also without restarting DSH.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, ensureDir, expandPath, loadSettings, saveSettings, settingsPath, agentsHome } from "./src/home.js";
import { importShipped, pluginFrom, resolveShipped, SHIPPED } from "./src/shipped.js";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { installSkill, listInstalledSkills, uninstallSkill, updateSkill } from "./src/skills.js";
import { fetchSkillMd, parseRepoRef } from "./src/github.js";
import { skillMetaFromText, kebab } from "./src/frontmatter.js";
import { createMcpManager, missingEnv, normalizeServerName } from "./src/mcp.js";
import { REGISTRY_PAGE_SIZE, fallbackCards, registryCatalogueCacheKey, registryDefinitionByName, searchMcpRegistryPage } from "./src/mcp-registry.js";
import { createMarketSkillProvider, readSkillBody } from "./src/provider.js";
import { makeCache, lookupSkillShRepo, searchSkills, warmMarketCache } from "./src/sources.js";
import { lobehubManifestDefinition, lobehubRegistered, searchLobeHubMarket } from "./src/lobehub-market.js";
import { setUserEnvironmentVariable } from "./src/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const name = "dsh-skill-mcp-market";
export const inject = ["tools"];

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

/**
 * Decide whether `url` may be embedded in an iframe of the DSH web UI.
 *
 * A blocked frame fires no error event in the embedding page, so the panel cannot
 * detect the rejection from the browser side; it asks the host instead. The host
 * reads `X-Frame-Options` and the CSP `frame-ancestors` directive, which is what
 * the browser obeys. `frame-ancestors` is only satisfied for a cross-origin
 * embedder by `*` (or by an explicit DSH origin, which no catalogue site lists),
 * so any other directive means "render the detail panel instead of an iframe".
 */
async function checkFrameable(url) {
  if (!/^https?:\/\//i.test(url)) return { embeddable: false, reason: "invalid url", status: 0 };
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; dsh-market)" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { embeddable: false, reason: `fetch failed: ${String((error && error.message) || error)}`, status: 0 };
  }
  // Only the headers matter; never buffer the body of a catalogue page.
  try {
    if (response.body && typeof response.body.cancel === "function") await response.body.cancel();
  } catch {
    /* the body is already closed or not cancellable */
  }
  const xfo = String(response.headers.get("x-frame-options") || "").toLowerCase();
  const csp = String(response.headers.get("content-security-policy") || "").toLowerCase();
  let reason = "";
  if (xfo.includes("deny")) reason = "X-Frame-Options: DENY";
  else if (xfo.includes("sameorigin")) reason = "X-Frame-Options: SAMEORIGIN";
  const ancestors = csp.match(/frame-ancestors([^;]*)/);
  if (ancestors) {
    const value = ancestors[1].trim();
    if (value.includes("'none'")) reason = "CSP frame-ancestors 'none'";
    else if (value !== "" && !value.split(/\s+/).includes("*")) reason = reason || `CSP frame-ancestors ${value}`;
  }
  return { embeddable: reason === "", reason, status: response.status };
}


/** Tool values must be lossless JSON: drop `undefined`, functions and other non-JSON members. */
function lossless(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { error: "result could not be serialized", detail: String(value) };
  }
}

function defineTool(ctx, { name: toolName, description, parameters, handler }) {
  ctx.effect(
    () =>
      ctx.tools.register({
        name: toolName,
        description,
        parameters: parameters ?? { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", properties: {}, additionalProperties: true },
          render(_args, value) {
            return textResult(value);
          },
        },
        execute: async (args) => lossless(await handler(args ?? {})),
      }),
    `dsh-market.tool.${toolName}`,
  );
}

function makeLogger(ctx) {
  const emit = (level, message) => {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === "function") logger[level](message);
  };
  return emit;
}

/** The MCP market is a live registry lookup; nothing is a hand-maintained definition list. */
function shortError(error) {
  return String((error && error.message) || error || "").slice(0, 160);
}

/**
 * The MCP catalogue. The panel switches between two independent markets:
 *   - "registry": the official Model Context Protocol registry, degrading to the last
 *     catalogue that worked (cached on disk) and then to a tiny built-in list of names;
 *   - "lobehub": LobeHub's marketplace through its own CLI, degrading to its cached list.
 * Every degraded level attaches a `hint`, because an empty list is unreadable on its own:
 * "nothing matched" and "the catalogue is down" look identical, and only one of them is
 * worth acting on. Installation never depends on this function — a `slug` resolves on its
 * own — so a degraded list never blocks a real install.
 */
/**
 * The LobeHub marketplace, as its own source: it is a separate catalogue with its own
 * identifiers, categories and install manifests, so the panel switches between the two
 * markets instead of blending them.
 */
async function loadLobeHubCatalog(cache, query = "", options = {}) {
  const category = String(options.category || "").trim();
  const sort = String(options.sort || "").trim();
  const page = Math.max(1, Number(options.page) || 1);
  const key = `lobehub:list:${String(query || "").trim().toLowerCase() || "all"}:${category}:${sort}:${page}`;
  try {
    const result = await searchLobeHubMarket({ query, pageSize: Math.max(1, Math.min(40, Number(options.size) || 40)), category, sort, page, cache });
    if (result.items.length > 0) {
      await cache.put(key, result.items);
      return {
        items: result.items,
        hint: "",
        live: true,
        categories: result.categories,
        source: "lobehub",
        page: result.page,
        totalPages: result.totalPages,
        total: result.total,
      };
    }
    return {
      items: [],
      hint: String(query || "").trim()
        ? `LobeHub 里没有匹配「${String(query).trim()}」的连接器，换个关键词（单个词更好）试试。`
        : "LobeHub 目录暂时没有返回条目，稍后再试。",
      live: true,
      categories: result.categories,
      source: "lobehub",
      page: result.page,
      totalPages: result.totalPages,
      total: result.total,
    };
  } catch (error) {
    const stale = await cache.get(key, 7 * 24 * 3600 * 1000);
    if (Array.isArray(stale) && stale.length > 0) {
      return { items: stale, hint: `LobeHub 暂时不可达（${shortError(error)}），下面是上次取到的列表。`, live: false, categories: [], source: "lobehub" };
    }
    const registerHint = lobehubRegistered()
      ? ""
      : "（还没有注册市场客户端，可运行 npx -y @lobehub/market-cli register --base-url https://market.lobehub.com --name \"DSH Market\" --source dsh）";
    return { items: [], hint: `LobeHub 暂时不可达：${shortError(error)}${registerHint}`, live: false, categories: [], source: "lobehub" };
  }
}

async function registerInstalledSkillToCatalog(installed, log) {
  // 把已安装技能注册到 DSH 的"技能目录"（对话框 / 浮窗用的那份）：
  // 往 $AGENTS_HOME/skills 写一份 junction（Windows）/ symlink（其它平台），指向技能实际安装位置。
  // 这份 junction 是 DSH 原生扫描路径，DSH 会把它列进"技能目录"，/ 浮窗随之更新，无需重启。
  if (!installed || !installed.dir) return;
  const fs = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const { homedir } = await import("node:os");
  const agentsHome = process.env.AGENTS_HOME || joinPath(homedir(), ".agents");
  const skillsDir = joinPath(agentsHome, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const linkPath = joinPath(skillsDir, installed.slug);
  if (fs.existsSync(linkPath)) return;
  try {
    await new Promise((resolve, reject) => {
      fs.symlink(installed.dir, linkPath, process.platform === "win32" ? "junction" : "dir",
        (err) => (err ? reject(err) : resolve()));
    });
    if (log) log("info", `dsh-market: 已注册技能 ${installed.slug} 到 $AGENTS_HOME/skills（/ 浮窗可见）`);
  } catch (e) {
    if (log) log("warn", `dsh-market: 注册 ${installed.slug} 到 / 浮窗失败：${e.message}`);
  }
}

async function loadMcpCatalog(cache, query = "", source = "registry", options = {}) {
  if (source === "lobehub") return loadLobeHubCatalog(cache, query, options);
  const page = Math.max(1, Number(options.page) || 1);
  const category = String(options.category || "").trim();
  const problems = [];
  let answered = false;

  try {
    const result = await searchMcpRegistryPage({ query, page, pageSize: Math.max(1, Math.min(48, Number(options.size) || REGISTRY_PAGE_SIZE)), category, cache });
    answered = true;
    if (result.items.length > 0) {
      return {
        items: result.items,
        hint: "",
        live: true,
        source: "registry",
        page: result.page,
        hasMore: result.hasMore,
      };
    }
  } catch (error) {
    problems.push(`官方注册表：${shortError(error)}`);
  }

  // Both catalogues answered and neither had a match: that is an empty search result, not
  // an outage, and it must not be dressed up as a degraded catalogue.
  if (answered && problems.length === 0) {
    return {
      items: [],
      hint: `没有匹配「${String(query || "").trim()}」的连接器。换个关键词（单个词更好），或直接按注册表名称安装。`,
      live: true,
      source: "registry",
      page,
      hasMore: false,
    };
  }

  const stale = await cache.get(registryCatalogueCacheKey(query, REGISTRY_PAGE_SIZE, category), 30 * 24 * 3600 * 1000);
  const staleItems = Array.isArray(stale) ? stale : (stale && Array.isArray(stale.items) ? stale.items : []);
  if (staleItems.length > 0) {
    return {
      items: staleItems.slice((page - 1) * REGISTRY_PAGE_SIZE, page * REGISTRY_PAGE_SIZE),
      hint: `目录暂时不可达（${problems.join("；")}），下面是上次成功获取的目录；仍可直接按名称安装。`,
      source: "registry",
      page,
      hasMore: staleItems.length > page * REGISTRY_PAGE_SIZE,
    };
  }
  return {
    items: fallbackCards(query),
    hint: `目录暂时不可达（${problems.join("；")}）。下面是内置的常见条目；也可以直接 mcp_market_install({slug:"registry 名称"})，或用 command/args 手动配置。`,
    source: "registry",
    page: 1,
    hasMore: false,
  };
}

/** Write user-supplied values into the system environment, then keep only ${VAR} placeholders. */
function applyEnvValues(envValues) {
  const written = [];
  for (const [name, value] of Object.entries(envValues || {})) {
    if (typeof value !== "string" || value === "") continue;
    setUserEnvironmentVariable(name, value);
    written.push(name);
  }
  return written;
}

/** Resolve one LobeHub slug into a runnable MCP definition by reading its page. */
async function resolveLobeHubDefinition(slug, serverName) {
  // A LobeHub identifier resolves through its public marketplace manifest, which declares the
  // real command/args (or remote URL) plus the environment variables the server expects.
  const definition = await lobehubManifestDefinition(slug);
  return {
    ...definition,
    serverName: normalizeServerName(serverName || definition.title || slug),
    slug,
  };
}

/**
 * Resolve one identifier into a runnable MCP definition. Registry names win (that is the
 * catalogue the panel shows); a LobeHub slug is still tried afterwards for compatibility,
 * but that site now requires a paid API plan, so its failure is reported as such instead of
 * as a generic network error.
 */
async function resolveMcpDefinition(slug, serverName) {
  let registryError = null;
  try {
    const definition = await registryDefinitionByName(slug, serverName);
    if (definition) return definition;
  } catch (error) {
    registryError = error;
  }
  try {
    return await resolveLobeHubDefinition(slug, serverName);
  } catch (error) {
    const detail = registryError ? `注册表查询失败：${shortError(registryError)}` : "注册表里没有这个名称";
    throw new Error(
      `无法解析 MCP 连接器 "${slug}"（${detail}；LobeHub manifest 也失败：${shortError(error)}）。` +
        `可改用 MCP 官方注册表名称（例如 io.github.Async23/chrome-devtools-mcp）或 LobeHub 标识符（例如 microsoft-playwright-mcp），` +
        `也可以直接给 command/args（stdio）或 url（streamable-http）手动安装。`,
    );
  }
}

/** A definition built purely from caller-supplied fields — no catalogue lookup at all. */
function manualMcpDefinition(body) {
  const rawName = body.serverName || body.slug || body.title || "mcp";
  return {
    serverName: normalizeServerName(rawName),
    title: body.title || rawName,
    description: body.description || "",
    transport: body.transport || (body.url ? "streamable-http" : "stdio"),
    command: body.command || "",
    args: Array.isArray(body.args) ? body.args : [],
    env: body.env && typeof body.env === "object" ? body.env : {},
    url: body.url || "",
    headers: body.headers && typeof body.headers === "object" ? body.headers : {},
    source: "manual",
  };
}

/** Row id of this plugin's own entry in the composed profile. */
const MARKET_ROW_ID = "dsh-skill-mcp-market";

/**
 * A second mount of this plugin — typically a hand-written `insert` in the profile's
 * cordis.patch.yml on top of the package being listed in `dsh.profile.bundles` — makes the
 * plugin impossible to uninstall: the plugin manager disables the bundle, still finds a row
 * with the same id and name mounted, and answers "bundle-in-use". Report it instead of
 * letting the user discover it from a failed uninstall.
 */
function warnAboutDuplicateMount(ctx, log) {
  try {
    const loader = ctx.loader && typeof ctx.loader.entries === "function" ? ctx.loader : null;
    if (!loader) return;
    const rows = [...loader.entries()].filter((entry) => entry && entry.options && entry.options.id === MARKET_ROW_ID);
    if (rows.length > 1) {
      log(
        "warn",
        `[dsh-market] 检测到 ${rows.length} 条 id 为 ${MARKET_ROW_ID} 的插件行：一条来自本组合包，另一条大概率写在你 profile 的 cordis.patch.yml 里。` +
          '这会让「卸载」报「其他配置仍在使用的组合包的组件，请先停用它们」。只保留 dsh.profile.bundles 里的包名，删掉 profile 里手写的 insert 即可恢复正常。',
      );
    }
  } catch {
    // Loader introspection is best-effort; a failure here must never block the plugin.
  }
}

export async function apply(ctx, config = {}) {
  const log = makeLogger(ctx);
  warnAboutDuplicateMount(ctx, log);
  let settings = await loadSettings();

  // Row config only provides initial defaults; persisted settings win afterwards.
  if (Array.isArray(config.skillDirs) && config.skillDirs.length > 0) {
    settings.skillDirs = config.skillDirs.map(expandPath).filter(Boolean);
  }
  if (Array.isArray(config.mcpDirs) && config.mcpDirs.length > 0) {
    settings.mcpDirs = config.mcpDirs.map(expandPath).filter(Boolean);
  }
  if (typeof config.shippedRoot === "string" && config.shippedRoot.trim() !== "") {
    settings.shippedRoot = expandPath(config.shippedRoot);
  }

  for (const dir of [...settings.skillDirs, ...settings.mcpDirs]) await ensureDir(dir);

  const trashDir = join(dirname(settingsPath()), "trash");
  const marketCache = makeCache(join(dirname(settingsPath()), "cache"));

  // ---------------------------------------------------------------- skill provider
  // We own the provider so `disabledSkills` (a `skills.disabled: [name]` list, as used by
  // several agent runtimes) is a real configuration item instead of a directory trick.
  let disposeProvider = null;
  let invalidateSkills = null;
  let skillProviderError = "";

  function mountSkillProvider() {
    try {
      disposeProvider?.();
    } catch {
      /* ignore */
    }
    disposeProvider = null;
    invalidateSkills = null;
    skillProviderError = "";
    const skills = ctx.get("skills");
    if (!skills) {
      skillProviderError = "ctx.skills unavailable";
      return;
    }
    const holder = createMarketSkillProvider({
      getDirs: () => settings.skillDirs,
      getDisabled: () => settings.disabledSkills,
      log,
    });
    try {
      disposeProvider = skills.registerProvider((control) => {
        invalidateSkills = control.invalidate;
        holder.startWatching(() => control.invalidate());
        return { name: holder.provider.name, list: holder.provider.list, get: holder.provider.get };
      });
      log("info", `dsh-market: skill provider watching ${settings.skillDirs.join(", ")}`);
    } catch (error) {
      skillProviderError = String(error?.message || error);
      log("warn", `dsh-market: skill provider registration failed — ${skillProviderError}`);
    }
  }

  mountSkillProvider();

  // ---------------------------------------------------------------- MCP manager
  let mcp = createMcpManager({
    ctx,
    dirs: settings.mcpDirs,
    shippedRoot: settings.shippedRoot,
    log,
  });
  await mcp.init();

  async function rebuildMcp() {
    mcp.dispose();
    mcp = createMcpManager({ ctx, dirs: settings.mcpDirs, shippedRoot: settings.shippedRoot, log });
    await mcp.init();
  }

  ctx.effect(() => () => {
    try {
      disposeProvider?.();
    } catch {
      /* ignore */
    }
    try {
      mcp.dispose();
    } catch {
      /* ignore */
    }
  }, "dsh-market.lifecycle");

  /** Enable/disable a skill by writing settings.disabledSkills: the name stays on disk but
   *  leaves the catalog, then the prompt cache is invalidated. */
  async function setSkillEnabled(slug, enabled) {
    const key = String(slug || "").trim().toLowerCase();
    if (!key) throw new Error("slug 不能为空");
    const disabled = new Set(settings.disabledSkills || []);
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    settings = await saveSettings({ ...settings, disabledSkills: [...disabled] });
    try {
      invalidateSkills?.();
    } catch {
      /* ignore */
    }
    return { ok: true, slug: key, enabled: Boolean(enabled), disabledSkills: settings.disabledSkills };
  }

  // 计算 DSH 原生扫描的技能目录：market 的 settings.skillDirs 是用户自定义的"安装目录"，
  // 但 DSH 的"技能目录"（对话框 / 浮窗用的那份）是另一套，包括 $AGENTS_HOME/skills、
  // 应用内置 skills/、插件包内 assets/**/SKILL.md。这里把这两套合并起来，让面板"已安装"
  // 能列出所有已安装的技能（不只是 market 装的那部分）。
  async function collectDshNativeSkillDirs() {
    const dirs = [];
    // 1) $AGENTS_HOME/skills（DSH 原生扫描路径）
    const agentsHome = process.env.AGENTS_HOME || join(homedir(), ".agents");
    dirs.push(join(agentsHome, "skills"));
    // 2) market settings.skillDirs（用户自定义安装目录）
    for (const d of settings.skillDirs) dirs.push(d);
    // 3) 宿主安装目录内的应用内置技能（resources/runtime/office-skills 等，
    //    是 app.asar 解包后的真实目录，可直接读）
    const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
    if (resourcesPath) {
      const runtimeDir = join(resourcesPath, "runtime");
      if (existsSync(runtimeDir)) {
        for (const d of findSkillDirs(runtimeDir)) dirs.push(d);
      }
    }
    // 4) 插件包内携带的 SKILL.md（profile node_modules 下每个插件的 assets/**/SKILL.md）
    //    app.asar 内部的 @deepseek-ai 技能由 DSH 原生 catalog 扫描处理（asar 不是真目录，
    //    无法直接 readdir），这里只补 profile node_modules 里插件包自带的 SKILL.md
    //    （如 @zseven-w/dsh-openpencil 的 openpencil-design）。
    const profileNMDir = findProfileNodeModules();
    if (profileNMDir && existsSync(profileNMDir)) {
      for (const entry of readdirSync(profileNMDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginPkgDir = join(profileNMDir, entry.name);
        // scoped packages: @scope/name — look under the scope dir too
        if (entry.name.startsWith("@")) {
          let scoped = [];
          try {
            scoped = readdirSync(pluginPkgDir, { withFileTypes: true }).filter((s) => s.isDirectory());
          } catch {
            /* ignore */
          }
          for (const sub of scoped) {
            for (const d of findSkillDirs(join(pluginPkgDir, sub.name))) dirs.push(d);
          }
        } else {
          for (const d of findSkillDirs(pluginPkgDir)) dirs.push(d);
        }
      }
    }
    // 去重 + 去空
    const seen = new Set();
    return dirs.filter((d) => d && !seen.has(d) && seen.add(d));
  }

  // 递归查找包目录内所有"含 SKILL.md 子目录"的父目录（深度上限 4，避免遍历过深）。
  // 返回的是 listInstalledSkills 能直接扫描的目录——即"技能子目录的父目录"，
  // 因为 listInstalledSkills(dirs) 对每个 dir 做 readdir 找子目录里的 SKILL.md。
  function findSkillDirs(pkgDir, depth = 0) {
    if (depth > 4) return [];
    const out = [];
    let entries = [];
    try {
      entries = readdirSync(pkgDir, { withFileTypes: true });
    } catch {
      return out;
    }
    // 检查 pkgDir 是否有子目录含 SKILL.md → pkgDir 本身就是一个可扫描的"技能根目录"
    let hasSkillChild = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (existsSync(join(pkgDir, entry.name, "SKILL.md"))) {
        hasSkillChild = true;
        break;
      }
    }
    if (hasSkillChild) out.push(pkgDir);
    // 继续向下递归
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...findSkillDirs(join(pkgDir, name), depth + 1));
    }
    return out;
  }

  // 定位 profile 的 node_modules 目录（宿主内 process.env.DSH_PROFILE_DIR 优先，
  // 否则扫描 $DSH_HOME/profiles/*/node_modules，取第一个存在的）
  function findProfileNodeModules() {
    const profileDir = process.env.DSH_PROFILE_DIR;
    if (profileDir && existsSync(join(profileDir, "node_modules"))) {
      return join(profileDir, "node_modules");
    }
    const profilesDir = join(homedir(), ".dsh", "profiles");
    if (existsSync(profilesDir)) {
      try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const nm = join(profilesDir, entry.name, "node_modules");
          if (existsSync(nm)) return nm;
        }
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  async function applyPaths(args) {
    const next = { ...settings };
    if (Array.isArray(args.skillDirs)) next.skillDirs = args.skillDirs.map(expandPath).filter(Boolean);
    if (Array.isArray(args.mcpDirs)) next.mcpDirs = args.mcpDirs.map(expandPath).filter(Boolean);
    if (typeof args.shippedRoot === "string") next.shippedRoot = expandPath(args.shippedRoot);
    if (next.skillDirs.length === 0) throw new Error("skillDirs cannot be empty");
    if (next.mcpDirs.length === 0) throw new Error("mcpDirs cannot be empty");
    settings = await saveSettings(next);
    for (const dir of [...settings.skillDirs, ...settings.mcpDirs]) await ensureDir(dir);
    if (hostCtx) {
      await mountSkillProvider();
      await rebuildMcp();
    }
    return {
      ok: true,
      skillDirs: settings.skillDirs,
      mcpDirs: settings.mcpDirs,
      skillProviderMounted: hostCtx ? Boolean(disposeProvider) : false,
      skillProviderError: skillProviderError || undefined,
      note: hostCtx
        ? "Paths saved. Skills already on disk are live immediately; MCP definitions were remounted."
        : "Paths saved. (Headless run: no host to mount skill/MCP providers.)",
    };
  }

  // ---------------------------------------------------------------- tools: settings
  defineTool(ctx, {
    name: "market_get_settings",
    description:
      "Show where dsh-market loads and installs SKILL skills and MCP server definitions, whether the live watchers are active, and every available skill/MCP source.",
    handler: async () => ({
      settings: {
        skillDirs: settings.skillDirs,
        mcpDirs: settings.mcpDirs,
        dshNativeSkillDirs: await collectDshNativeSkillDirs(),
        shippedRoot: settings.shippedRoot || "(auto-detected)",
        settingsPath: settingsPath(),
            disabledSkills: settings.disabledSkills,
      },
      skillProvider: { mounted: Boolean(disposeProvider), error: skillProviderError || undefined },
      shipped: {
        mcpClient: resolveShipped(SHIPPED.mcpClient, settings.shippedRoot) || "NOT FOUND",
        skillFilesystem: resolveShipped(SHIPPED.skillFilesystem, settings.shippedRoot) || "NOT FOUND",
      },
      sources: {
        skills: ["skills.sh（实时目录 2 万条）", "skillhub（社区实时 API）", "github owner/repo", "url", "local"],
        mcp: ["MCP 官方注册表（实时）", "LobeHub 市场（官方 market-cli，卡片带作者/分类/安装量）", "manual config", "Claude/Cursor mcpServers JSON import"],
      },
    }),
  });

  defineTool(ctx, {
    name: "market_set_paths",
    description:
      "Choose where SKILL skills and MCP connectors live. Both lists accept absolute paths, `~`, `$DSH_HOME`, `$AGENTS_HOME` and %ENV% placeholders. The first skill directory is the install target. Applies immediately: the skill watcher is remounted and every MCP definition is reloaded.",
    parameters: {
      type: "object",
      properties: {
        skillDirs: { type: "array", items: { type: "string" }, description: "Directories scanned for `<name>/SKILL.md`." },
        mcpDirs: { type: "array", items: { type: "string" }, description: "Directories scanned for `<serverName>.json`." },
        shippedRoot: { type: "string", description: "DeepSeek Harness `resources` directory holding app.asar. Usually auto-detected." },
      },
      additionalProperties: false,
    },
    handler: async (args) => applyPaths(args),
  });

  // ---------------------------------------------------------------- tools: skills
  defineTool(ctx, {
    name: "skill_market_search",
    description:
      "Search the SKILL market across its live sources (skills.sh / clawhub / skillsmp / trusttools / browse.sh / lobehub-agent / skillhub / modelscope) or `all`. Returns installable entries with the identifier each installer needs. Paging is real: pass page=2 to get the next, different batch.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query. Empty lists popular entries." },
        source: {
          type: "string",
          enum: [
            "all",
            "skills.sh",
            "clawhub",
            "skillsmp",
            "trusttools",
            "browse.sh",
            "lobehub-agent",
            "skillhub",
            "modelscope",
          ],
          description: "Defaults to all.",
        },
        category: { type: "string" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await searchSkills({
        query: args.query || "",
        source: args.source || "all",
        category: args.category || "",
        page: args.page || 1,
        pageSize: args.pageSize || 20,
      });
      const installed = await listInstalledSkills(settings.skillDirs);
      const installedSlugs = new Set(installed.map((item) => item.slug));
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, installed: installedSlugs.has(item.slug) })),
        installTarget: settings.skillDirs[0],
        hint: "Use skill_market_install with {source, reference, skillDir} taken from an item.",
      };
    },
  });

  defineTool(ctx, {
    name: "skill_market_install",
    description:
      "Install a SKILL skill into the configured skill directory and make it live immediately (no restart). `github` takes `owner/repo` or `owner/repo@ref` or `owner/repo/sub/path` or a GitHub URL; `skills.sh` takes either a skills.sh page URL or a bare `owner/repo`; `url` takes a raw SKILL.md URL; `local` copies a directory from disk; `skillhub` takes an upstream URL.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["github", "skills.sh", "clawhub", "skillsmp", "trusttools", "browse.sh", "lobehub-agent", "skillhub", "url", "local", "zip"],
          description: "Market source; defaults to github.",
        },
        reference: {
          type: "string",
          description: "For skills.sh: a page URL or `owner/repo`. For github: `owner/repo[/path]` or `owner/repo@ref` or a GitHub URL. Otherwise a URL or local directory.",
        },
        skillDir: { type: "string", description: "Sub-directory inside the repository that holds SKILL.md (multi-skill repos)." },
        ref: { type: "string", description: "Git ref (branch/tag) to read; defaults to the repository's default branch." },
        name: { type: "string", description: "Override the installed directory name." },
        dir: { type: "string", description: "Override the install target directory." },
        force: { type: "boolean", description: "Replace an existing skill with the same name." },
      },
      required: ["reference"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await installSkill({
        source: args.source || "github",
        reference: args.reference,
        skillDir: args.skillDir || "",
        ref: args.ref || "",
        name: args.name || "",
        dir: args.dir || "",
        force: Boolean(args.force),
        skillDirs: settings.skillDirs,
        cache: marketCache,
      });
      const mounted = Boolean(disposeProvider);
      return {
        ...result,
        skillProviderMounted: mounted,
        live: mounted,
        note: mounted
          ? "Installed into a watched directory; the skill catalog refreshes on the next model step."
          : `Installed, but the skill watcher is not mounted (${skillProviderError || "unknown reason"}). Restart DSH or call market_set_paths to remount.`,
      };
    },
  });

  defineTool(ctx, {
    name: "skill_market_list",
    description: "List installed SKILL skills found in the configured skill directories, with the path of each SKILL.md.",
    parameters: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false },
    handler: async (args) => {
      const dirs = args.dir ? [expandPath(args.dir)] : settings.skillDirs;
      const items = await listInstalledSkills(dirs);
      return { dirs, total: items.length, items };
    },
  });

  defineTool(ctx, {
    name: "skill_market_uninstall",
    description: "Remove an installed SKILL skill by moving it from the skill directory into the market trash folder.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string" }, dir: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const dirs = args.dir ? [expandPath(args.dir)] : settings.skillDirs;
      return uninstallSkill({ slug: args.slug, dirs, trashDir, agentsHomeSkillsDir: join(agentsHome(), "skills") });
    },
  });

  // ---------------------------------------------------------------- tools: mcp
  defineTool(ctx, {
    name: "mcp_market_search",
    description:
      "Search the MCP connector market: the official Model Context Protocol registry (live, registry.modelcontextprotocol.io) plus everything already installed. Each entry reports `slug` (the registry name to install), `transport`, and the `envRequired` values it needs. When the catalogue is unreachable the result is a degraded list plus `catalogHint`; an empty list never means installation is impossible — `mcp_market_install({slug})` can still resolve any registry name directly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        includeInstalled: { type: "boolean", description: "Include installed connectors. Defaults to true." },
        source: {
          type: "string",
          enum: ["registry", "lobehub"],
          description:
            "Which MCP market to search: `registry` (official Model Context Protocol registry, default) or `lobehub` (LobeHub marketplace, richer cards with author/install counts).",
        },
        sort: {
          type: "string",
          description: "Ordering (LobeHub only): `installCount`, `ratingAverage` or `createdAt`. Omit for the market default.",
        },
        page: { type: "number", description: "1-based page (LobeHub returns 40 per page). Defaults to 1." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = String(args.query || "").trim();
      const wanted = String(args.source || "registry") === "lobehub" ? "lobehub" : "registry";
      const catalog = await loadMcpCatalog(marketCache, query, wanted, {
        category: args.category,
        sort: args.sort,
        page: args.page,
      });
      const rows = catalog.live
        ? catalog.items
        : catalog.items.filter((item) =>
            !query ? true : `${item.slug} ${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.toLowerCase()),
          );
      const items = rows
        .filter((item) => !args.category || item.category === args.category)
        .map((item) => ({
          id: `mcp:${item.slug}`,
          slug: item.slug,
          name: item.name,
          description: item.description,
          category: item.category,
          transport: item.transport,
          command: item.command,
          args: item.args,
          envRequired: item.envRequired || [],
          envHints: item.envHints || {},
          installable: item.installable !== false,
          note: item.note,
          homepage: item.homepage,
          owner: item.owner,
          installs: item.installs,
          rating: item.rating,
          source: item.source || "registry",
        }));
      const installed = args.includeInstalled === false ? [] : await mcp.list();
      const page = Number(catalog.page) || 1;
      return {
        total: catalog.total || items.length,
        items,
        installed,
        page,
        totalPages: catalog.totalPages || 0,
        // Paging is real for BOTH markets now: LobeHub has a page count, the registry walks
        // cursors, and either one reports whether another page exists.
        canLoadMore: catalog.hasMore !== undefined ? Boolean(catalog.hasMore) : page < (catalog.totalPages || 1),
        categories: catalog.categories || [],
        source: wanted,
        mcpDirs: settings.mcpDirs,
        // A degraded catalogue must say so; an empty list alone cannot distinguish
        // "no match" from "the catalogue is unreachable".
        catalogHint: catalog.hint || undefined,
        hint:
          items.length === 0
            ? "列表为空时仍可直接安装：mcp_market_install({slug}) 传 MCP 官方注册表名称（如 io.github.Async23/chrome-devtools-mcp），或 mcp_market_install({serverName, transport, command|url, ...}) 手动配置。"
            : "Install with mcp_market_install({slug, env}) or mcp_market_install({serverName, transport, command|url, ...}).",
      };
    },
  });

  defineTool(ctx, {
    name: "mcp_market_install",
    description:
      "Install an MCP connector and connect it immediately (no restart). Pass `slug` with any MCP registry name (e.g. `io.github.Async23/chrome-devtools-mcp`) and the launch recipe is fetched and resolved for you; a legacy LobeHub slug is still attempted afterwards. Or pass a full definition: `serverName` with `transport` and `command`/`args`/`env` (stdio) or `url`/`headers` (streamable-http). Also accepts `importJson` containing a Claude/Cursor `mcpServers` object. Returns a live probe of the connection.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "MCP registry server name, e.g. io.github.Async23/chrome-devtools-mcp (a legacy LobeHub slug also works)." },
        serverName: { type: "string", description: "[A-Za-z0-9_-]{1,32}." },
        title: { type: "string" },
        description: { type: "string" },
        transport: { type: "string", enum: ["stdio", "streamable-http"] },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Values; `${ENV_VAR}` placeholders are resolved at connect time." },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        cwd: { type: "string" },
        toolCallTimeoutMs: { type: "integer" },
        enabled: { type: "boolean" },
        importJson: { type: "string", description: "JSON text with an `mcpServers` object." },
        probeTimeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const definitions = [];

      if (args.importJson) {
        const parsed = JSON.parse(args.importJson);
        const servers = parsed.mcpServers || parsed.servers || parsed;
        for (const [rawName, raw] of Object.entries(servers || {})) {
          if (!raw || typeof raw !== "object") continue;
          definitions.push({
            serverName: normalizeServerName(rawName),
            title: rawName,
            description: raw.description || "",
            transport: raw.url ? "streamable-http" : "stdio",
            command: raw.command || "",
            args: raw.args || [],
            env: raw.env || {},
            url: raw.url || "",
            headers: raw.headers || {},
            source: "import",
          });
        }
      } else if (args.slug) {
        applyEnvValues(args.envValues);
        // Registry name first (that is what the market lists); a LobeHub slug still resolves
        // when the registry does not know it, so older instructions keep working.
        const live = await resolveMcpDefinition(args.slug, args.serverName);
        definitions.push({
          ...live,
          env: { ...live.env, ...(args.env || {}) },
          envRequired: live.envRequired || [],
        });
      } else {
        if (!args.serverName) throw new Error("pass either `slug` or `serverName`");
        if (!args.command && !args.url) throw new Error("pass `command` (stdio) or `url` (streamable-http)");
        definitions.push({
          serverName: normalizeServerName(args.serverName),
          title: args.title || args.serverName,
          description: args.description || "",
          transport: args.transport || (args.url ? "streamable-http" : "stdio"),
          command: args.command || "",
          args: args.args || [],
          env: args.env || {},
          url: args.url || "",
          headers: args.headers || {},
          cwd: args.cwd || "",
          toolCallTimeoutMs: args.toolCallTimeoutMs,
          enabled: args.enabled !== false,
          source: "manual",
        });
      }

      const results = [];
      for (const definition of definitions) {
        if (!definition.serverName) {
          results.push({ ok: false, error: "invalid serverName", definition });
          continue;
        }
        const missing = missingEnv(definition);
        if (missing.length > 0) {
          results.push({
            ok: false,
            serverName: definition.serverName,
            missing,
            error: "missing environment values — pass them in `env` (use \"${VAR}\" to read one from the environment)",
          });
          continue;
        }
        const installed = await mcp.install(definition);
        const probe = installed.ok === false ? { ok: false, error: installed.error, missing: installed.missing } : await mcp.probe(definition.serverName, Number(args.probeTimeoutMs) || 8000);
        results.push({
          ok: Boolean(probe.ok),
          serverName: definition.serverName,
          transport: definition.transport,
          tools: probe.tools || [],
          toolCount: (probe.tools || []).length,
          waitedMs: probe.waitedMs,
          error: probe.error,
          note: probe.ok
            ? `Connected immediately. The model can call ${probe.tools.length} new tool(s) on the next step.`
            : "Definition saved. The connector stays enabled and will report tools once it connects; call mcp_market_probe to retry.",
        });
      }
      return { total: results.length, results };
    },
  });

  defineTool(ctx, {
    name: "mcp_market_list",
    description: "List installed MCP connectors with transport, enabled state, mount state and the live tool names each one publishes.",
    handler: async () => ({ mcpDirs: settings.mcpDirs, items: await mcp.list() }),
  });

  defineTool(ctx, {
    name: "mcp_market_probe",
    description: "Wait for an installed MCP connector to publish its tools and report them. Use after fixing an environment value or a launch command.",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" }, timeoutMs: { type: "integer", minimum: 500, maximum: 60000 } },
      required: ["serverName"],
      additionalProperties: false,
    },
    handler: async (args) => mcp.probe(args.serverName, Number(args.timeoutMs) || 8000),
  });

  defineTool(ctx, {
    name: "mcp_market_set_enabled",
    description: "Enable or disable an MCP connector. Disabling disconnects it and removes its tools immediately; enabling reconnects it immediately.",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" }, enabled: { type: "boolean" } },
      required: ["serverName", "enabled"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await mcp.setEnabled(args.serverName, args.enabled);
      if (!args.enabled) return result;
      const probe = await mcp.probe(args.serverName, 8000);
      return { ...result, tools: probe.tools, live: probe.ok, error: probe.ok ? undefined : probe.error };
    },
  });

  defineTool(ctx, {
    name: "mcp_market_uninstall",
    description: "Disconnect an MCP connector and delete its definition, keeping a copy in the trash folder.",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" } },
      required: ["serverName"],
      additionalProperties: false,
    },
    handler: async (args) => mcp.uninstall(args.serverName),
  });

  // ---------------------------------------------------------------- client panel RPC
  async function dispatch(op, body) {
    switch (op) {
      case "settings.get":
        return {
          settings: {
            skillDirs: settings.skillDirs,
            mcpDirs: settings.mcpDirs,
            shippedRoot: settings.shippedRoot || "(auto-detected)",
            settingsPath: settingsPath(),
            disabledSkills: settings.disabledSkills,
          },
          skillProvider: { mounted: Boolean(disposeProvider), error: skillProviderError || undefined },
          shipped: {
            mcpClient: resolveShipped(SHIPPED.mcpClient, settings.shippedRoot) || "NOT FOUND",
            skillFilesystem: resolveShipped(SHIPPED.skillFilesystem, settings.shippedRoot) || "NOT FOUND",
          },
        };
      case "settings.set":
        return applyPaths(body);
      case "skills.search": {
        const wantedSource = String(body.source || "all");
        const result = await searchSkills({
          query: body.query || "",
          source: wantedSource,
          category: body.category || "",
          page: body.page || 1,
          pageSize: body.pageSize || 24,
        });
        const installedNow = await listInstalledSkills(settings.skillDirs);
        const taken = new Set(installedNow.map((item) => item.slug));
        // 每个源都实现了真正的翻页（服务端 page，或缓存全量目录后本地切片），
        // 所以「加载更多」是否可用完全由这一页返回的 hasMore 决定。
        const canLoadMore = Boolean(result.hasMore);
        return {
          ...result,
          canLoadMore,
          items: result.items.map((item) => ({ ...item, installed: taken.has(item.slug) })),
        };
      }
      case "skills.install": {
        const installed = await installSkill({
          source: body.source || "github",
          reference: body.reference,
          skillDir: body.skillDir || "",
          name: body.name || "",
          ref: body.ref || "",
          dir: body.dir || "",
          force: Boolean(body.force),
          skillDirs: settings.skillDirs,
          cache: marketCache,
        });
        // 让新装技能立即出现在对话框 / 浮窗里：往 DSH 原生扫描路径写一份 junction/symlink
        await registerInstalledSkillToCatalog(installed, log);
        return installed;
      }
      case "skills.list":
        return { dirs: await collectDshNativeSkillDirs(), items: await listInstalledSkills(await collectDshNativeSkillDirs()) };
      case "skills.uninstall":
        return uninstallSkill({ slug: body.slug, dirs: settings.skillDirs, trashDir, agentsHomeSkillsDir: join(agentsHome(), "skills") });
      case "skills.import": {
        const target = expandPath(body.path || "");
        if (!target) throw new Error("请提供本地目录或 .zip 路径");
        const info = await stat(target);
        const kind = info.isDirectory() ? "local" : /\.zip$/i.test(target) ? "zip" : "";
        if (!kind) throw new Error("只支持目录或 .zip 文件");
        return installSkill({
          source: kind,
          reference: target,
          name: body.name || "",
          force: Boolean(body.force),
          skillDirs: settings.skillDirs,
        });
      }
      case "skills.upload": {
        // 面板「上传技能」按钮弹系统文件夹选择器，选中路径回传到这里。
        // 一次拷入整个技能根目录（含 SKILL.md），子目录里每个含 SKILL.md 的逐个安装。
        // 也支持前端把整个文件夹的文件读出来 POST 回宿主，宿主解包到临时目录再上传。
        const { uploadSkillFromFolder } = await import("./src/skills.js");
        let result;
        if (body.files && Array.isArray(body.files) && body.files.length) {
          // 前端 <input type=file webkitdirectory> 路径：解包到临时目录
          const tmpRoot = join(tmpdir(), `dsh-market-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
          await mkdir(tmpRoot, { recursive: true });
          try {
            for (const f of body.files) {
              if (!f || !f.path) continue;
              const dest = join(tmpRoot, f.path);
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, f.content || "", "utf8");
            }
            result = await uploadSkillFromFolder({
              folder: tmpRoot,
              skillDirs: settings.skillDirs,
              force: Boolean(body.force),
            });
          } finally {
            await rm(tmpRoot, { recursive: true, force: true });
          }
        } else {
          const folder = expandPath(body.path || "");
          if (!folder) throw new Error("请提供要上传的文件夹路径或 files 数组");
          result = await uploadSkillFromFolder({
            folder,
            skillDirs: settings.skillDirs,
            force: Boolean(body.force),
          });
        }
        for (const item of result.items || []) {
          try {
            const installed = await listInstalledSkills(settings.skillDirs);
            const match = installed.find((s) => s.slug === item.slug);
            if (match) await registerInstalledSkillToCatalog(match, log);
          } catch {
            /* registration is best-effort */
          }
        }
        return result;
      }
      case "skills.preview": {
        const tmpRoot = join(tmpdir(), `dsh-market-preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        // Fast path: for github references, fetch only SKILL.md instead of the whole skill
        // directory. Falls back to the full-download path when the single-file fetch fails.
        if ((body.source || "github") === "github") {
          let parsed = null;
          try {
            const { repo, ref: refFromRef } = parseRepoRef(body.reference || "");
            parsed = { repo, ref: refFromRef || body.ref || "" };
          } catch { /* non-github-looking reference; fall through */ }
          if (parsed) {
            try {
              const { skillText } = await fetchSkillMd({
                repo: parsed.repo,
                ref: parsed.ref,
                skillDir: body.skillDir || "",
              });
              const meta = skillMetaFromText(skillText, body.name || "");
              const repoName = parsed.repo.split("/")[1] || "skill";
              return {
                slug: kebab(meta.name || body.name || repoName),
                name: meta.name || body.name || repoName,
                description: meta.description || "",
                files: ["SKILL.md"],
                content: skillText.slice(0, 20000),
                previewOnly: true,
                fastPath: true,
              };
            } catch { /* single-file fetch failed; fall back to full download */ }
          }
        } else if ((body.source || "github") === "skills.sh" || (body.source || "github") === "skillssh") {
          // Fast path for bare owner/repo references: skip the extra page-fetch hop
          // (resolveSkillsShInstall) entirely — that is only needed for page URLs.
          const raw = String(body.reference || "").trim();
          if (!/^https?:\/\/\//i.test(raw) && /^[\w.-]+\/[\w.-]+/.test(raw)) {
            try {
              const { skillText } = await fetchSkillMd({
                repo: raw,
                ref: body.ref || "",
                skillDir: body.skillDir || "",
              });
              const meta = skillMetaFromText(skillText, body.name || "");
              const repoName = raw.split("/")[1] || "skill";
              return {
                slug: kebab(meta.name || body.name || repoName),
                name: meta.name || body.name || repoName,
                description: meta.description || "",
                files: ["SKILL.md"],
                content: skillText.slice(0, 20000),
                previewOnly: true,
                fastPath: true,
              };
            } catch { /* fall through to full download */ }
          } else if (lookupSkillShRepo(raw)) {
            // Fast path for skills.sh page URLs: parse the repo locally (zero network),
            // then fetch only the single SKILL.md file.
            const { repo, skill } = lookupSkillShRepo(raw);
            try {
              const { skillText } = await fetchSkillMd({
                repo,
                ref: body.ref || "",
                skillDir: skill || "",
              });
              const meta = skillMetaFromText(skillText, skill || "");
              return {
                slug: kebab(meta.name || skill || body.name || repo.split("/")[1]),
                name: meta.name || skill || body.name || repo.split("/")[1],
                description: meta.description || "",
                files: ["SKILL.md"],
                content: skillText.slice(0, 20000),
                previewOnly: true,
                fastPath: true,
              };
            } catch { /* fall through to full download */ }
          }
        }
        // For clawhub: when the full-download path fails (e.g. no GitHub source found),
        // return a structured "open in browser" response instead of throwing, so the
        // client can show a useful fallback instead of a dead-end error.
        if ((body.source || "github") === "clawhub") {
          const detailUrl = `https://clawhub.ai/${String(body.reference || "").replace(/^clawhub:/, "")}`;
          try {
            const installed = await installSkill({
              source: body.source,
              reference: body.reference,
              skillDir: body.skillDir || "",
              name: body.name || "",
              ref: body.ref || "",
              dir: tmpRoot,
              force: true,
              skillDirs: [tmpRoot],
              cache: marketCache,
            });
            const detail = await readSkillBody([tmpRoot], installed.slug);
            return {
              slug: installed.slug,
              name: installed.name,
              description: installed.description,
              files: installed.files,
              content: (detail && detail.content ? detail.content : "").slice(0, 20000),
              previewOnly: true,
            };
          } catch (previewErr) {
            const slugFromRef = String(body.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || String(body.reference || "");
            return {
              slug: slugFromRef,
              name: body.name || body.reference,
              description: "",
              files: [],
              content: "",
              previewOnly: true,
              openUrl: detailUrl,
              previewError: String(previewErr && previewErr.message || previewErr),
            };
          } finally {
            await rm(tmpRoot, { recursive: true, force: true });
          }
        }
        try {
          const installed = await installSkill({
            source: body.source || "github",
            reference: body.reference,
            skillDir: body.skillDir || "",
            name: body.name || "",
            ref: body.ref || "",
            dir: tmpRoot,
            force: true,
            skillDirs: [tmpRoot],
            cache: marketCache,
          });
          const detail = await readSkillBody([tmpRoot], installed.slug);
          return {
            slug: installed.slug,
            name: installed.name,
            description: installed.description,
            files: installed.files,
            content: (detail && detail.content ? detail.content : "").slice(0, 20000),
            previewOnly: true,
          };
        } finally {
          await rm(tmpRoot, { recursive: true, force: true });
        }
      }
      case "skills.toggle":
        return setSkillEnabled(body.slug, body.enabled);
      case "skills.detail": {
        const detail = await readSkillBody(settings.skillDirs, body.slug);
        if (!detail) throw new Error(`未找到技能 ${body.slug}`);
        return {
          slug: body.slug,
          path: detail.path,
          size: detail.size,
          content: detail.content.slice(0, 20000),
          disabled: (settings.disabledSkills || []).includes(String(body.slug).toLowerCase()),
        };
      }
      case "skills.update": {
        const updated = await updateSkill({
          dirs: settings.skillDirs,
          slug: body.slug,
          name: body.name,
          description: body.description,
          body: body.body,
        });
        try {
          invalidateSkills?.();
        } catch {
          /* ignore */
        }
        return updated;
      }
      case "mcp.detail":
        return mcp.detail(body.serverName);
      case "mcp.update":
        return mcp.update(body.serverName, body.patch || {});
      case "mcp.search": {
        const query = String(body.query || "").trim();
        const wanted = String(body.source || "registry") === "lobehub" ? "lobehub" : "registry";
        const catalog = await loadMcpCatalog(marketCache, query, wanted, {
          category: body.category,
          sort: body.sort,
          page: body.page,
          size: body.size,
        });
        // A live registry search is already filtered server-side; fallback and cached lists
        // are not, so only those get a local filter.
        const rows = catalog.live
          ? catalog.items
          : catalog.items.filter((item) =>
              !query ? true : `${item.slug} ${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()),
            );
        return {
          items: rows.map((item) => ({
            id: `mcp:${item.slug}`,
            slug: item.slug,
            name: item.name,
            description: item.description,
            category: item.category,
            transport: item.transport,
            envRequired: item.envRequired || [],
            envHints: item.envHints || {},
            installable: item.installable !== false,
            note: item.note,
            homepage: item.homepage,
            source: item.source || "registry",
          })),
          hint: catalog.hint,
          categories: catalog.categories || [],
          source: wanted,
          page: catalog.page || 1,
          totalPages: catalog.totalPages || 0,
          total: catalog.total || catalog.items.length,
          // The registry has no published total; it walks cursors, so only `hasMore` can
          // answer "is there another page" — the panel must not guess from totalPages.
          canLoadMore: catalog.hasMore !== undefined
            ? Boolean(catalog.hasMore)
            : (catalog.page || 1) < (catalog.totalPages || 1),
        };
      }
      case "mcp.install": {
        const envWritten = applyEnvValues(body.envValues);
        const definition =
          body.command || body.url ? manualMcpDefinition(body) : await resolveMcpDefinition(body.slug, body.serverName);
        if (body.env && typeof body.env === "object") definition.env = { ...definition.env, ...body.env };
        const overrideOf = ["command", "args", "url", "headers", "transport"];
        for (const key of overrideOf) {
          if (body[key] !== undefined && body[key] !== "" && !(Array.isArray(body[key]) && body[key].length === 0)) {
            definition[key] = body[key];
          }
        }
        const missing = missingEnv(definition);
        if (missing.length > 0) {
          return { results: [{ ok: false, serverName: definition.serverName, missing, error: "missing environment values" }] };
        }
        const installedNow = await mcp.install(definition);
        const probe = await mcp.probe(definition.serverName, 8000);
        return {
          results: [{
            ok: Boolean(probe.ok),
            serverName: definition.serverName,
            toolCount: (probe.tools || []).length,
            tools: probe.tools || [],
            error: probe.ok ? undefined : probe.error,
            missing: installedNow.missing,
            envWritten,
          }],
        };
      }
      case "market.openDir": {
        // "Where are my installed skills?" — open the folder in the OS file manager so the
        // user can inspect or edit SKILL.md / the MCP JSON in place.
        // 支持两种用法：
        //   { kind: "skills" | "mcp" }            → 打开对应的配置目录
        //   { kind: "skill", slug: "..." }        → 直接打开某个技能的文件夹
        //   { kind: "mcp-item", serverName: "..." } → 直接打开某个 MCP 定义所在目录
        const kind = String(body.kind || "skills");
        const { join: joinPath } = await import("node:path");
        let target = "";
        if (kind === "skill") {
          // 打开某个技能的文件夹
          const slug = String(body.slug || "");
          if (!slug) throw new Error("market.openDir: skill 需要一个 slug");
          const all = await listInstalledSkills(await collectDshNativeSkillDirs());
          const item = all.find((x) => x.slug === slug);
          if (!item) throw new Error(`未找到技能 ${slug}`);
          target = item.dir ? joinPath(item.dir, item.slug) : item.path;
        } else if (kind === "mcp-item") {
          // 打开某个 MCP 定义所在目录
          const serverName = String(body.serverName || "");
          if (!serverName) throw new Error("market.openDir: mcp-item 需要一个 serverName");
          const defs = await mcp.list();
          const item = defs.find((x) => x.serverName === serverName);
          if (!item) throw new Error(`未找到 MCP ${serverName}`);
          target = item.path ? joinPath(item.path, "..") : settings.mcpDirs[0];
        } else {
          // 打开配置目录
          const dirs = kind === "mcp" ? settings.mcpDirs : settings.skillDirs;
          target = (dirs || []).find(Boolean);
          if (!target) throw new Error(kind === "mcp" ? "还没有配置 MCP 目录" : "还没有配置技能目录");
        }
        if (kind !== "skill" && kind !== "mcp-item") await ensureDir(target);
        await new Promise((resolve) => {
          const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
          // Windows 上 explorer.exe 用 "/select," 定位到具体文件
          const args = process.platform === "win32" && (kind === "skill" || kind === "mcp-item")
            ? ["/select,", target]
            : [target];
          execFile(command, args, { windowsHide: false }, () => resolve());
        });
        return { opened: target, kind };
      }
      case "mcp.list":
        return { mcpDirs: settings.mcpDirs, items: await mcp.list() };
      case "mcp.toggle":
        return mcp.setEnabled(body.serverName, body.enabled);
      case "mcp.uninstall":
        return mcp.uninstall(body.serverName);
      case "frame.check":
        return await checkFrameable(String(body.url || ""));
      default:
        throw new Error(`unknown operation "${op}"`);
    }
  }

  const webServer = ctx.get("webServer");
  if (webServer && typeof webServer.register === "function") {
    ctx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: "/api/dsh-market/rpc",
          handler: async (req, res) => {
            let payload = { ok: false, error: "invalid request" };
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const text = Buffer.concat(chunks).toString("utf8");
              const body = text ? JSON.parse(text) : {};
              payload = { ok: true, ...(await dispatch(String(body.op || ""), body)) };
            } catch (error) {
              payload = { ok: false, error: String(error && error.message ? error.message : error) };
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(payload));
          },
        }),
      "dsh-market.route",
    );
  } else {
    log("warn", "dsh-market: webServer unavailable, the market panel has no data endpoint");
  }

  log("info", `dsh-market ready: ${settings.skillDirs.length} skill dir(s), ${settings.mcpDirs.length} MCP dir(s)`);

  // Warm the two slow catalogues in the background so the first panel open is instant.
  // A failed warmup is harmless: the search path retries on demand.
  void warmMarketCache(marketCache).catch((error) => {
    log("debug", `dsh-market warmup skipped: ${String((error && error.message) || error).slice(0, 120)}`);
  });
}

export { defaultSettings };
