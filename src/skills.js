// Skill install / list / remove, plus the curated catalog shipped with this bundle.
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kebab, parseFrontmatter, skillMetaFromText } from "./frontmatter.js";
import { downloadSkillDir, listTree, parseRepoRef, readRepoFile, resolveRef, skillDirsFrom } from "./github.js";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { ensureDir, expandPath, writeJson } from "./home.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = join(HERE, "..", "catalog", "skills.json");

let catalogCache = null;

export async function curatedSkills() {
  if (catalogCache) return catalogCache;
  try {
    const raw = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
    catalogCache = Array.isArray(raw.items) ? raw.items : [];
  } catch {
    catalogCache = [];
  }
  return catalogCache;
}

/** List installed skills across the configured roots. */
export async function listInstalledSkills(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const skillFile = entry.isDirectory() ? join(full, "SKILL.md") : entry.name.endsWith(".md") ? full : "";
      if (!skillFile || !existsSync(skillFile)) continue;
      try {
        const text = await readFile(skillFile, "utf8");
        const meta = skillMetaFromText(text, entry.isDirectory ? entry.name : basename(entry.name, ".md"));
        out.push({
          slug: entry.isDirectory ? entry.name : basename(entry.name, ".md"),
          name: meta.name || entry.name,
          description: meta.description,
          whenToUse: meta.whenToUse,
          dir,
          path: skillFile,
          kind: entry.isDirectory ? "directory" : "file",
        });
      } catch {
        // unreadable skill: skip it, keep the rest
      }
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function uniqueSlug(base, taken) {
  let slug = base || "skill";
  let index = 2;
  while (taken.has(slug)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

async function existingSlugs(dirs) {
  const taken = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of await readdir(dir)) {
        taken.add(name.replace(/\.md$/i, ""));
      }
    } catch {
      // ignore
    }
  }
  return taken;
}

/**
 * Install a skill into the first configured skill directory.
 * Supported sources: `github` (owner/repo[/sub/path]), `url` (a SKILL.md or raw file URL), `skillhub` (needs upstream_url), `local` (a directory on disk).
 */
export async function installSkill({ source = "github", reference = "", skillDir = "", dir = "", name = "", force = false, skillDirs }) {
  const roots = skillDirs && skillDirs.length > 0 ? skillDirs : [];
  if (roots.length === 0) throw new Error("no skill directories are configured");
  const targetRoot = dir ? expandPath(dir) : roots[0];
  await ensureDir(targetRoot);
  const taken = await existingSlugs(roots);

  const writeSkill = async ({ slug, files, skillText, origin }) => {
    const finalSlug = force ? kebab(slug) || slug : uniqueSlug(kebab(slug) || slug, taken);
    const targetDir = join(targetRoot, finalSlug);
    const meta = skillMetaFromText(skillText || "", finalSlug);
    if (!meta.name || !meta.description) {
      throw new Error("SKILL.md must declare both `name` and `description` in its frontmatter");
    }
    await ensureDir(targetDir);
    for (const [relative, content] of Object.entries(files)) {
      const target = join(targetDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await writeJson(join(targetDir, ".market-install.json"), {
      slug: finalSlug,
      name: meta.name,
      origin,
      installedAt: new Date().toISOString(),
    });
    return { ok: true, slug: finalSlug, name: meta.name, description: meta.description, dir: targetDir, files: Object.keys(files).length };
  };

  if (source === "local") {
    const from = expandPath(reference);
    if (!existsSync(from)) throw new Error(`local path not found: ${from}`);
    const info = await stat(from);
    if (!info.isDirectory()) throw new Error("local source must be a directory that contains SKILL.md");
    const skillText = await readFile(join(from, "SKILL.md"), "utf8");
    const files = {};
    const walk = async (current, prefix) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full, relative);
        else files[relative] = await readFile(full, "utf8");
      }
    };
    await walk(from, "");
    return writeSkill({ slug: name || basename(from), files, skillText, origin: { source: "local", path: from } });
  }

  if (source === "url") {
    const url = String(reference || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("url source needs an http(s) reference");
    const response = await fetch(url, { headers: { "User-Agent": "dsh-market/0.1" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const text = await response.text();
    if (!text.startsWith("---")) throw new Error("the fetched file is not a SKILL.md (missing frontmatter)");
    const meta = skillMetaFromText(text, name || basename(url).replace(/\.md$/i, ""));
    return writeSkill({
      slug: name || meta.name,
      files: { "SKILL.md": text },
      skillText: text,
      origin: { source: "url", url },
    });
  }

  if (source === "skillhub") {
    const upstream = String(reference || "");
    if (!upstream) throw new Error("this SkillHub entry has no upstream_url, so its files cannot be downloaded");
    return installSkill({ source: "github", reference: upstream, skillDir, dir: targetRoot, name, force, skillDirs });
  }

  if (source === "github") {
    const { repo, ref, subPath } = parseRepoRef(reference);
    const resolvedRef = await resolveRef(repo, ref);
    let chosen = skillDir || subPath;
    if (!chosen) {
      const files = await listTree(repo, resolvedRef);
      const candidates = skillDirsFrom(files);
      if (candidates.length === 0) throw new Error(`no SKILL.md found in ${repo}@${resolvedRef}`);
      const wanted = kebab(name || "");
      chosen =
        (wanted && candidates.find((path) => path.toLowerCase().endsWith(wanted))) ||
        (candidates.length === 1 ? candidates[0] : "");
      if (chosen === "" && candidates.length > 1) {
        throw new Error(
          `${repo}@${resolvedRef} contains ${candidates.length} skills; pass skillDir. Candidates: ${candidates.slice(0, 12).join(", ")}`,
        );
      }
    }
    const staging = join(targetRoot, `.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await ensureDir(staging);
    try {
      const result = await downloadSkillDir({ repo, ref: resolvedRef, skillDir: chosen, destDir: staging });
      const files = {};
      const walk = async (current, prefix) => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = join(current, entry.name);
          if (entry.isDirectory()) await walk(full, relative);
          else files[relative] = await readFile(full, "utf8");
        }
      };
      await walk(staging, "");
      const written = await writeSkill({
        slug: name || basename(chosen || repo),
        files,
        skillText: result.skillText,
        origin: { source: "github", repo, ref: resolvedRef, skillDir: chosen },
      });
      return result.skipped?.length ? { ...written, skipped: result.skipped } : written;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  throw new Error(`unknown skill source "${source}"`);
}

/** Remove an installed skill by moving it into the market trash. */
export async function uninstallSkill({ slug, dirs, trashDir }) {
  const key = kebab(slug);
  const removed = [];
  for (const dir of dirs) {
    const candidates = [join(dir, key), join(dir, `${key}.md`)];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      await ensureDir(trashDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(candidate, join(trashDir, `${key}-${stamp}${candidate.endsWith(".md") ? ".md" : ""}`));
      removed.push(candidate);
    }
  }
  return { ok: removed.length > 0, removed };
}

export async function searchFromSources({ query = "", source = "all", page = 1, pageSize = 20, category = "" }) {
  const wanted = source === "all" ? ["skillhub", "curated"] : [source];
  const results = [];
  const degraded = [];
  for (const name of wanted) {
    try {
      if (name === "skillhub") {
        const hub = await searchSkillHub({ query, page, pageSize, category });
        results.push(...hub.items);
      } else if (name === "curated") {
        const q = query.trim().toLowerCase();
        const items = (await curatedSkills())
          .filter((item) =>
            !q
              ? true
              : `${item.name} ${item.description} ${item.slug} ${item.category}`.toLowerCase().includes(q),
          )
          .map((item) => ({
            id: `curated:${item.repo}:${item.path}`,
            slug: item.slug,
            name: item.name,
            description: item.description,
            category: item.category || "skills",
            source: "curated",
            sourceLabel: "精选技能库",
            owner: item.repo,
            homepage: `https://github.com/${item.repo}`,
            upstreamUrl: `${item.repo}${item.ref ? `@${item.ref}` : ""}`,
            skillDir: item.dir || "",
            verified: true,
            installable: true,
            downloads: 0,
            stars: 0,
          }));
        results.push(...items);
      }
    } catch (error) {
      degraded.push({ source: name, error: String(error?.message || error) });
    }
  }
  return { items: results, degraded, total: results.length, page, pageSize };
}

export { readRepoFile };
