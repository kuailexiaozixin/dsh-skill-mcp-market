// Skill install / list / remove, plus the curated catalog shipped with this bundle.
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kebab, parseFrontmatter, skillMetaFromText } from "./frontmatter.js";
import { downloadSkillDir, listTree, parseRepoRef, readRepoFile, resolveRef, skillDirsFrom } from "./github.js";
import { searchSkills as searchSkillHub } from "./skillhub.js";
import { resolveSkillsShInstall } from "./sources.js";
import { describeFindings, scanSkillBundle } from "./verify.js";
import { locateSkillRoot, readZip, stripCommonPrefix } from "./zip.js";
import { clawhubResolve, lobehubAgentSkill } from "./extra-sources.js";
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
export async function installSkill({ source = "github", reference = "", skillDir = "", dir = "", name = "", ref = "", force = false, skillDirs }) {
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
    const scan = scanSkillBundle({ files, skillText });
    if (!scan.allowed && !force) {
      throw new Error(`安全检查未通过（${scan.stats.high} 项高危）：${describeFindings(scan.findings.filter((f) => f.severity === "high"))}。确认可信后可加 force:true 强制安装。`);
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
    const response = await fetch(url, { headers: { "User-Agent": "dsh-skill-mcp-market/0.1" } });
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
      // A bare `owner/repo` usually means "the skill named like the repo": repos that ship
      // several skills still carry the flagship one under the repo's own name. Without this
      // a plain `owner/repo` install would stop at the ambiguity error.
      const repoWanted = kebab(String(repo || "").split("/").pop() || "");
      const basenameOf = (path) => (path || "").split("/").pop().toLowerCase();
      chosen =
        (wanted && candidates.find((path) => basenameOf(path) === wanted)) ||
        (wanted && candidates.find((path) => path.toLowerCase().endsWith(`/${wanted}`))) ||
        (!wanted && repoWanted && candidates.find((path) => basenameOf(path) === repoWanted)) ||
        (!wanted && repoWanted && candidates.find((path) => path.toLowerCase().endsWith(`/${repoWanted}`))) ||
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

  if (source === "skillsmp") {
    // Every skillsmp row carries its exact GitHub location, so installation is the plain
    // github path. `upstreamUrl` is already shaped as `owner/repo@ref` by the source.
    if (!reference) throw new Error("该 skillsmp 条目没有给出 GitHub 源仓库，无法下载");
    return installSkill({
      source: "github",
      reference,
      skillDir: skillDir || "",
      name: name || "",
      dir: targetRoot,
      force,
      skillDirs,
    });
  }

  if (source === "browse.sh") {
    return installSkill({
      source: "github",
      reference: reference || "browserbase/browse.sh",
      skillDir: skillDir || "",
      name: name || "",
      dir: targetRoot,
      force,
      skillDirs,
    });
  }

  if (source === "zip") {
    const archivePath = expandPath(reference);
    const buffer = await readFile(archivePath);
    const { files: raw, skipped } = readZip(buffer);
    const flat = stripCommonPrefix(raw);
    const root = locateSkillRoot(flat);
    if (root === null) throw new Error("ZIP 里没有找到 SKILL.md");
    const prefix = root ? `${root}/` : "";
    const files = {};
    for (const [entry, content] of Object.entries(flat)) {
      if (prefix && !entry.startsWith(prefix)) continue;
      files[entry.slice(prefix.length)] = content;
    }
    const skillText = files["SKILL.md"] || "";
    const written = await writeSkill({
      slug: name || skillMetaFromText(skillText, "").name || root.split("/").pop() || basename(archivePath, ".zip"),
      files,
      skillText,
      origin: { source: "zip", path: archivePath },
    });
    return skipped.length ? { ...written, skipped } : written;
  }

  if (source === "skills.sh" || source === "skillssh") {
    const raw = String(reference || "").trim();
    // Accept a bare `owner/repo` (what the tool interface and CLI users type) as well as a
    // skills.sh page URL. Only a URL needs the extra hop through the page to learn the repo
    // and the skill name; a bare repo is already the install target.
    if (!/^https?:\/\//i.test(raw)) {
      if (!/^[\w.-]+\/[\w.-]+/.test(raw)) {
        throw new Error(`skills.sh 引用应为页面 URL 或 owner/repo，收到 "${raw}"`);
      }
      return installSkill({
        source: "github",
        reference: raw,
        skillDir: skillDir || "",
        name: name || "",
        dir: targetRoot,
        force,
        skillDirs,
      });
    }
    const { repo, skill } = await resolveSkillsShInstall(raw);
    return installSkill({
      source: "github",
      reference: ref ? `${repo}@${ref}` : repo,
      skillDir: skillDir || "",
      name: name || skill,
      dir: targetRoot,
      force,
      skillDirs,
    });
  }

  if (source === "trusttools") {
    const repo = String(reference || "");
    if (!repo) throw new Error("trusttools 条目缺少 repo_url");
    const target = ref ? `${repo}@${ref}` : repo;
    return installSkill({ source: "github", reference: target, skillDir: skillDir || "", name: name || "", dir: targetRoot, force, skillDirs });
  }

  if (source === "clawhub") {
    const target = await clawhubResolve(reference);
    return installSkill({ source: "github", reference: target.repo, skillDir: target.skillDir, name: name || "", dir: targetRoot, force, skillDirs });
  }

  if (source === "lobehub-agent") {
    const bundle = await lobehubAgentSkill(reference);
    const scan = scanSkillBundle({ files: bundle.files, skillText: bundle.files["SKILL.md"] });
    if (!scan.allowed && !force) {
      throw new Error(`安全检查未通过：${describeFindings(scan.findings.filter((f) => f.severity === "high"))}`);
    }
    return writeSkill({
      slug: name || bundle.name || reference,
      files: bundle.files,
      skillText: bundle.files["SKILL.md"],
      origin: { source: "lobehub-agent", identifier: reference },
    });
  }

  throw new Error(`unknown skill source "${source}"`);
}

/** Remove an installed skill by moving it into the market trash. */
export async function uninstallSkill({ slug, dirs, trashDir }) {  const key = kebab(slug);
  const removed = [];
  for (const dir of dirs) {
    const candidates = [join(dir, key), join(dir, `${key}.md`)];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      // Trash inside the skill's own directory: a cross-drive rename fails with EXDEV.
      const localTrash = join(dir, ".trash");
      await ensureDir(localTrash);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(localTrash, `${key}-${stamp}${candidate.endsWith(".md") ? ".md" : ""}`);
      try {
        await rename(candidate, dest);
      } catch (error) {
        if (error && error.code === "EXDEV") {
          await cp(candidate, dest, { recursive: true });
          await rm(candidate, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
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

/** Rewrite an installed skill's `name`, `description` and body in place, preserving every
 *  other frontmatter key exactly as written. */
export async function updateSkill({ dirs, slug, name, description, body }) {
  let file = "";
  for (const dir of dirs || []) {
    for (const candidate of [join(dir, slug, "SKILL.md"), join(dir, `${slug}.md`)]) {
      if (existsSync(candidate)) file = candidate;
    }
  }
  if (!file) throw new Error(`未找到技能 ${slug}`);
  const raw = await readFile(file, "utf8");
  const fmEnd = raw.indexOf("\n---", 3);
  const block = fmEnd > 0 ? raw.slice(3, fmEnd) : "";
  const oldBody = fmEnd > 0 ? raw.slice(fmEnd + 4).replace(/^\r?\n/, "") : raw;
  const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
  const setKey = (key, value) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    const line = `${key}: ${JSON.stringify(String(value).trim())}`;
    const index = lines.findIndex((item) => new RegExp(`^${key}\\s*:`).test(item));
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  };
  setKey("name", name);
  setKey("description", description);
  const next = `---\n${lines.join("\n")}\n---\n${body !== undefined ? body : oldBody}`;
  await writeFile(file, next, "utf8");
  const meta = skillMetaFromText(next, slug);
  return { ok: true, slug, path: file, name: meta.name, description: meta.description };
}

export { readRepoFile };
