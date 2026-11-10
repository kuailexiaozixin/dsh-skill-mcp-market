// Own skill provider: scans user-configured directories, honours the disabled list,
// and invalidates the catalog whenever the directories or the settings change.
//
// This replaces the shipped filesystem provider so that `disabledSkills` becomes a real
// configuration item rather than a directory trick.
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

const PROVIDER_NAME = "market-filesystem";

function summaryFrom(text, fallbackName, path, source) {
  const { data } = parseFrontmatter(text);
  const name = String(data.name || fallbackName || "").trim();
  const description = String(data.description || "").trim();
  const whenToUse = String(data.whenToUse || data.when_to_use || "").trim();
  const invocation = {
    modelInvocable: data["disable-model-invocation"] !== true,
    userInvocable: data["user-invocable"] !== false,
  };
  return { name, description, whenToUse, invocation, path, source, provider: PROVIDER_NAME };
}

/** Scan one root: `<root>/<name>/SKILL.md` and `<root>/<name>.md` (one level deep). */
async function scanRoot(root, rank, source) {
  const out = [];
  if (!existsSync(root)) return out;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
    const file = entry.isDirectory() ? join(root, entry.name, "SKILL.md") : join(root, entry.name);
    if (!existsSync(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      const summary = summaryFrom(text, name, file, source);
      if (!summary.name || !summary.description) continue;
      out.push({ ...summary, rank, locator: file });
    } catch {
      // unreadable skill: skip it, keep the rest
    }
  }
  return out;
}

export function createMarketSkillProvider({ getDirs, getDisabled, log }) {
  const watchers = [];

  const provider = {
    name: PROVIDER_NAME,
    async list(options) {
      const dirs = getDirs();
      const disabled = new Set((getDisabled() || []).map((x) => String(x).toLowerCase()));
      const candidates = [];
      let rank = 100;
      for (const dir of dirs) {
        const found = await scanRoot(dir, rank, "custom");
        rank += 10;
        for (const candidate of found) {
          const keys = [candidate.name.toLowerCase(), String(candidate.path).split(/[\\/]/).slice(-2, -1)[0]?.toLowerCase()];
          if (keys.some((key) => key && disabled.has(key))) continue;
          candidates.push(candidate);
        }
      }
      candidates.sort((a, b) => a.name.localeCompare(b.name));
      return { candidates, complete: true };
    },
    async get(candidate) {
      const file = candidate?.locator || candidate?.path;
      if (!file) return undefined;
      const text = await readFile(file, "utf8");
      const meta = summaryFrom(text, candidate.name, file, candidate.source);
      const body = parseFrontmatter(text).body;
      return { ...candidate, ...meta, content: body };
    },
  };

  function startWatching(onChange) {
    for (const dir of getDirs()) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          clearTimeout(startWatching.timer);
          startWatching.timer = setTimeout(onChange, 250);
        });
        watcher.on?.("error", () => {});
        watchers.push(watcher);
      } catch (error) {
        log?.("warn", `dsh-market: cannot watch ${dir}: ${String(error?.message || error)}`);
      }
    }
  }

  function dispose() {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.length = 0;
  }

  return { provider, startWatching, dispose };
}

/** Read one skill body by slug across the configured roots (used by the detail panel). */
export async function readSkillBody(dirs, slug) {
  for (const dir of dirs) {
    for (const candidate of [join(dir, slug, "SKILL.md"), join(dir, `${slug}.md`)]) {
      if (!existsSync(candidate)) continue;
      const text = await readFile(candidate, "utf8");
      const info = await stat(candidate);
      return { path: candidate, size: info.size, content: parseFrontmatter(text).body, raw: text };
    }
  }
  return null;
}
