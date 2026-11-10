// Path resolution and persisted market settings.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".dsh");
}

export function agentsHome() {
  if (process.env.DSH_AGENTS_HOME) return process.env.DSH_AGENTS_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".agents");
}

/** Expand `~`, `$DSH_HOME`, `$HOME` and resolve to an absolute path. */
export function expandPath(input) {
  if (typeof input !== "string" || input.trim() === "") return "";
  let p = input.trim();
  p = p.replace(/^\$DSH_HOME(?=$|[\\/])/, dshHome());
  p = p.replace(/^\$AGENTS_HOME(?=$|[\\/])/, agentsHome());
  p = p.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || homedir());
  p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, k) => process.env[k] ?? "");
  if (!isAbsolute(p)) p = resolve(p);
  return p;
}

export function settingsPath() {
  return join(dshHome(), "market", "settings.json");
}

export function defaultSettings() {
  const home = dshHome();
  return {
    // Where the market looks for skills and where it installs them: the first entry is the default target.
    skillDirs: [join(home, "market", "skills")],
    // Where MCP server definitions (<serverName>.json) live.
    mcpDirs: [join(home, "market", "mcp")],
    // DSH equivalent of Hermes' config.yaml `skills.disabled`: names that stay on disk but
    // are hidden from the catalog. Absent from this list means enabled.
    disabledSkills: [],
    // Extra root that holds the shipped dsh packages (app.asar). Empty means auto-detect.
    shippedRoot: "",
    createdAt: new Date().toISOString(),
  };
}

function normalize(raw, fallback) {
  const merged = { ...fallback, ...(raw || {}) };
  const toList = (value, fb) => {
    const list = Array.isArray(value) ? value : [];
    const cleaned = [];
    for (const item of list) {
      const p = expandPath(item);
      if (p && !cleaned.includes(p)) cleaned.push(p);
    }
    return cleaned.length > 0 ? cleaned : fb;
  };
  merged.skillDirs = toList(merged.skillDirs, fallback.skillDirs);
  merged.mcpDirs = toList(merged.mcpDirs, fallback.mcpDirs);
  merged.disabledSkills = Array.isArray(merged.disabledSkills)
    ? merged.disabledSkills.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : [];
  merged.shippedRoot = typeof merged.shippedRoot === "string" ? expandPath(merged.shippedRoot) : "";
  return merged;
}

export async function loadSettings() {
  const base = defaultSettings();
  const file = settingsPath();
  if (!existsSync(file)) {
    const created = normalize({}, base);
    await writeJson(file, created);
    return created;
  }
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return normalize(raw, base);
  } catch {
    return normalize({}, base);
  }
}

export async function saveSettings(next) {
  const base = defaultSettings();
  const merged = normalize(next, base);
  merged.updatedAt = new Date().toISOString();
  await writeJson(settingsPath(), merged);
  return merged;
}

export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}
