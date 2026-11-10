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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, ensureDir, expandPath, loadSettings, saveSettings, settingsPath } from "./src/home.js";
import { importShipped, pluginFrom, resolveShipped, SHIPPED } from "./src/shipped.js";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { installSkill, listInstalledSkills, uninstallSkill, updateSkill } from "./src/skills.js";
import { createMcpManager, missingEnv, normalizeServerName } from "./src/mcp.js";
import { createMarketSkillProvider, readSkillBody } from "./src/provider.js";
import { lobehubMcpConfig, makeCache, searchLobeHubMcp, searchSkills } from "./src/sources.js";
import { setUserEnvironmentVariable } from "./src/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const name = "dsh-market";
export const inject = ["tools"];

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
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

/** LobeHub is the only MCP source: every list and every install comes from the live site. */
async function loadMcpCatalog(cache, query = "") {
  const result = await searchLobeHubMcp({ query, pageSize: 60, cache });
  return result.items;
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
  const config = await lobehubMcpConfig(slug);
  const name = normalizeServerName(serverName || config.name || slug);
  return {
    serverName: name,
    title: slug,
    description: "",
    transport: config.url ? "streamable-http" : "stdio",
    command: config.command || "",
    args: config.args || [],
    env: config.env || {},
    url: config.url || "",
    headers: config.headers || {},
    source: "lobehub",
    slug,
    homepage: `https://lobehub.com/mcp/${slug}`,
  };
}

export async function apply(ctx, config = {}) {
  const log = makeLogger(ctx);
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
  // We own the provider so `disabledSkills` (Hermes' config.yaml `skills.disabled`
  // equivalent) is a real configuration item instead of a directory trick.
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

  /** Enable/disable a skill by writing settings.disabledSkills, mirroring Hermes'
   *  config.yaml `skills.disabled` + prompt-cache invalidation. */
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

  async function applyPaths(args) {
    const next = { ...settings };
    if (Array.isArray(args.skillDirs)) next.skillDirs = args.skillDirs.map(expandPath).filter(Boolean);
    if (Array.isArray(args.mcpDirs)) next.mcpDirs = args.mcpDirs.map(expandPath).filter(Boolean);
    if (typeof args.shippedRoot === "string") next.shippedRoot = expandPath(args.shippedRoot);
    if (next.skillDirs.length === 0) throw new Error("skillDirs cannot be empty");
    if (next.mcpDirs.length === 0) throw new Error("mcpDirs cannot be empty");
    settings = await saveSettings(next);
    for (const dir of [...settings.skillDirs, ...settings.mcpDirs]) await ensureDir(dir);
    await mountSkillProvider();
    await rebuildMcp();
    return {
      ok: true,
      skillDirs: settings.skillDirs,
      mcpDirs: settings.mcpDirs,
      skillProviderMounted: Boolean(disposeProvider),
      skillProviderError: skillProviderError || undefined,
      note: "Paths saved. Skills already on disk are live immediately; MCP definitions were remounted.",
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
        mcp: ["LobeHub（实时目录 + 详情页解析真实配置）", "manual config", "Claude/Cursor mcpServers JSON import"],
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
      "Search the SKILL skill market. Sources: `curated` (a verified catalog of real skills), `skillhub` (community marketplace), or `all`. Returns installable entries with the identifier each installer needs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query. Empty lists popular entries." },
        source: { type: "string", enum: ["all", "curated", "skillhub（社区实时 API）"], description: "Defaults to all." },
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
      "Install a SKILL skill into the configured skill directory and make it live immediately (no restart). `github` takes `owner/repo` or `owner/repo/sub/path` or a GitHub URL; `url` takes a raw SKILL.md URL; `local` copies a directory from disk; `skillhub` takes an upstream URL.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["github", "url", "local", "skillhub（社区实时 API）"], description: "Defaults to github." },
        reference: { type: "string", description: "owner/repo[/path], an http(s) URL, or a local directory." },
        skillDir: { type: "string", description: "Sub-directory inside the repository that holds SKILL.md (multi-skill repos)." },
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
        name: args.name || "",
        dir: args.dir || "",
        force: Boolean(args.force),
        skillDirs: settings.skillDirs,
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
      return uninstallSkill({ slug: args.slug, dirs, trashDir });
    },
  });

  // ---------------------------------------------------------------- tools: mcp
  defineTool(ctx, {
    name: "mcp_market_search",
    description:
      "Search the MCP connector market: the curated catalog of standard MCP servers plus everything already installed. Entries that need environment values report them in `envRequired`.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        includeInstalled: { type: "boolean", description: "Include installed connectors. Defaults to true." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = String(args.query || "").trim().toLowerCase();
      const catalog = await loadMcpCatalog(marketCache);
      const items = catalog
        .filter((item) =>
          !query ? true : `${item.slug} ${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query),
        )
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
          homepage: item.homepage,
          source: "curated",
        }));
      const installed = args.includeInstalled === false ? [] : await mcp.list();
      return {
        total: items.length,
        items,
        installed,
        mcpDirs: settings.mcpDirs,
        hint: "Install with mcp_market_install({slug, env}) or mcp_market_install({serverName, transport, command|url, ...}).",
      };
    },
  });

  defineTool(ctx, {
    name: "mcp_market_install",
    description:
      "Install an MCP connector and connect it immediately (no restart). Either pass `slug` from the curated catalog (plus `env`), or pass a full definition: `serverName` with `transport` and `command`/`args`/`env` (stdio) or `url`/`headers` (streamable-http). Also accepts `importJson` containing a Claude/Cursor `mcpServers` object. Returns a live probe of the connection.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Curated catalog slug, e.g. filesystem." },
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
        const live = await resolveLobeHubDefinition(args.slug, args.serverName);
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
        const result = await searchSkills({
          query: body.query || "",
          source: body.source || "all",
          category: body.category || "",
          page: body.page || 1,
          pageSize: body.pageSize || 24,
        });
        const installedNow = await listInstalledSkills(settings.skillDirs);
        const taken = new Set(installedNow.map((item) => item.slug));
        return { ...result, items: result.items.map((item) => ({ ...item, installed: taken.has(item.slug) })) };
      }
      case "skills.install":
        return installSkill({
          source: body.source || "github",
          reference: body.reference,
          skillDir: body.skillDir || "",
          name: body.name || "",
          dir: body.dir || "",
          force: Boolean(body.force),
          skillDirs: settings.skillDirs,
        });
      case "skills.list":
        return { dirs: settings.skillDirs, items: await listInstalledSkills(settings.skillDirs) };
      case "skills.uninstall":
        return uninstallSkill({ slug: body.slug, dirs: settings.skillDirs, trashDir });
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
      case "skills.preview": {
        const tmpRoot = join(tmpdir(), `dsh-market-preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        try {
          const installed = await installSkill({
            source: body.source || "github",
            reference: body.reference,
            skillDir: body.skillDir || "",
            name: body.name || "",
            dir: tmpRoot,
            force: true,
            skillDirs: [tmpRoot],
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
        const query = String(body.query || "").trim().toLowerCase();
        const catalog = await loadMcpCatalog(marketCache);
        return {
          items: catalog
            .filter((item) => (!query ? true : `${item.slug} ${item.name} ${item.description}`.toLowerCase().includes(query)))
            .map((item) => ({
              id: `mcp:${item.slug}`,
              slug: item.slug,
              name: item.name,
              description: item.description,
              category: item.category,
              transport: item.transport,
              envRequired: item.envRequired || [],
              source: "curated",
            })),
        };
      }
      case "mcp.install": {
        const envWritten = applyEnvValues(body.envValues);
        const definition = await resolveLobeHubDefinition(body.slug, body.serverName);
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
      case "mcp.list":
        return { mcpDirs: settings.mcpDirs, items: await mcp.list() };
      case "mcp.toggle":
        return mcp.setEnabled(body.serverName, body.enabled);
      case "mcp.uninstall":
        return mcp.uninstall(body.serverName);
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
}

export { defaultSettings };
