// Fast-path skill installers using official CLIs and direct API downloads,
// to avoid the slow GitHub API + tarball fallback path.
//
// Strategy per source:
//   skills.sh / skillssh  → `npx -y skills add <repo> --skill <slug> -g`
//   clawhub               → direct download from clawhub.ai API (zip), or `npx clawhub install <slug>`
//   browse.sh             → `npx -y browse skills add <slug>`
//   trusttools            → `npx -y trusttools install <reference>`
//   lobehub-agent         → already has npx CLI path in lobehub-market.js
//
// Each fast path returns { ok: true, ... } on success, or throws to signal
// the caller should fall back to the generic GitHub path.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { kebab, skillMetaFromText } from "./frontmatter.js";
import { writeJson, ensureDir, expandPath } from "./home.js";
import { readZip, stripCommonPrefix, locateSkillRoot } from "./zip.js";

const isWindows = process.platform === "win32";

/** Run a command via npx (Windows-safe: wraps .cmd shims through cmd.exe). */
function npxRun(pkg, args, { timeoutMs = 90000, env = {} } = {}) {
  const file = isWindows ? process.env.ComSpec || "cmd.exe" : "npx";
  const argv = isWindows
    ? ["/d", "/s", "/c", ["npx", "-y", pkg, ...args].map(quoteForCmd).join(" ")]
    : ["-y", pkg, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...env, NO_COLOR: "1", npm_config_yes: "true" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || "")
            .split(/\r?\n/)
            .filter((line) => !/^npm notice/.test(line.trim()))
            .join(" ")
            .replace(/\s+/g, " ")
            .slice(0, 300);
          const wrapped = new Error(`${pkg} CLI failed: ${detail}`);
          wrapped.code = error.code;
          wrapped.isCliError = true;
          reject(wrapped);
        } else {
          resolve(String(stdout || ""));
        }
      },
    );
  });
}

function quoteForCmd(text) {
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Install a skill from skills.sh via the official `skills` CLI.
 * `npx skills add <owner/repo>@<slug> -g` downloads the skill into the
 * global skills directory. We then copy it into our target directory.
 */
export async function installViaSkillsShCli({ repo, slug, targetRoot, dir, name, force, skillDirs }) {
  if (!repo || !slug) throw new Error("skills.sh CLI install requires repo and slug");
  // The skills CLI installs into its own global dir; we run it and then copy the
  // resulting skill into our target. The CLI writes to ~/<agent>/skills/<slug>/
  // where <agent> varies by detected harness (claude, cursor, codex, windsurf, etc).
  // Use `owner/repo@slug` format for the CLI reference.
  const cliRef = `${repo}@${slug}`;
  await npxRun("skills", ["add", cliRef, "-g", "-y"], {
    timeoutMs: 120000,
  });
  // Find the CLI-installed skill in any known agent skill directory and copy into targetRoot.
  // The CLI installs into ~/<agent>/skills/<slug>/ where <agent> varies by detected harness.
  // Search common agent skill dirs on this platform.
  const homeDir = isWindows
    ? process.env.APPDATA || join(process.env.USERPROFILE || ".", "AppData", "Roaming")
    : process.env.HOME || process.env.USERPROFILE || ".";
  const userHome = process.env.HOME || process.env.USERPROFILE || ".";
  const agentDirs = isWindows
    ? [
        join(homeDir, "claude", "skills"),
        join(userHome, ".claude", "skills"),
        join(userHome, ".cursor", "skills"),
        join(userHome, ".codex", "skills"),
        join(userHome, ".windsurf", "skills"),
        join(userHome, ".agents", "skills"),
      ]
    : [
        join(userHome, ".claude", "skills"),
        join(userHome, ".cursor", "skills"),
        join(userHome, ".codex", "skills"),
        join(userHome, ".windsurf", "skills"),
        join(userHome, ".agents", "skills"),
      ];
  const kebabSlug = kebab(slug) || slug;
  for (const baseDir of agentDirs) {
    if (!existsSync(baseDir)) continue;
    // Try exact slug first, then kebab variant, then scan for SKILL.md.
    const direct = join(baseDir, slug);
    if (existsSync(direct)) {
      return copyInstalled(direct, { targetRoot, dir, name, slug, force, skillDirs, originSource: "skills.sh", reference: repo });
    }
    const kebabMatch = join(baseDir, kebabSlug);
    if (existsSync(kebabMatch)) {
      return copyInstalled(kebabMatch, { targetRoot, dir, name, slug: kebabSlug, force, skillDirs, originSource: "skills.sh", reference: repo });
    }
    // Last resort: scan for any directory containing SKILL.md
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateDir = join(baseDir, entry.name);
        if (existsSync(join(candidateDir, "SKILL.md"))) {
          return copyInstalled(candidateDir, { targetRoot, dir, name, slug: entry.name, force, skillDirs, originSource: "skills.sh", reference: repo });
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  throw new Error(`skills CLI did not produce a skill directory for "${slug}" in any known agent path`);
}

/**
 * Install a skill from clawhub via the official API (zip download).
 * clawhub.ai serves skill bundles as zip at /api/v1/download?slug=<slug>.
 * This avoids the slow GitHub API + tarball path entirely.
 */
export async function installViaClawHubApi({ slug, reference, targetRoot, dir, name, force, skillDirs }) {
  if (!slug) throw new Error("clawhub install requires a slug");
  // The clawhub download API expects the bare skill slug (e.g. "concept-design"),
  // not the owner-qualified reference (e.g. "agenticweb4/concept-design").
  // Strip the owner prefix if present.
  const bareSlug = slug.includes("/") ? slug.split("/").pop() : slug;
  // Download the zip directly from clawhub's API
  const url = `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(bareSlug)}`;
  const tmp = await mkdtemp(join(tmpdir(), "dsh-market-clawhub-"));
  try {
    const target = join(tmp, `${bareSlug}.zip`);
    await downloadFile(url, target, 90000);
    const buffer = await readFile(target);
    const { files: raw, skipped } = readZip(buffer);
    if (Object.keys(raw).length === 0) {
      throw new Error(`clawhub ZIP 没有可解析的文本文件（${skipped.length} 项被跳过）`);
    }
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
    if (!skillText) throw new Error("clawhub ZIP 解压后缺少 SKILL.md");
    // Validate frontmatter before writing
    const meta = skillMetaFromText(skillText, kebab(bareSlug) || bareSlug);
    if (!meta.name || !meta.description) {
      throw new Error("clawhub SKILL.md 缺少 name 或 description frontmatter");
    }
    // Write the skill into the target root
    const finalSlug = kebab(bareSlug) || bareSlug;
    const targetDir = join(targetRoot, finalSlug);
    await ensureDir(targetDir);
    for (const [relative, content] of Object.entries(files)) {
      const target = join(targetDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await writeJson(join(targetDir, ".market-install.json"), {
      slug: finalSlug,
      name: meta.name,
      origin: { source: "clawhub", reference: reference || slug, apiDownload: true },
      installedAt: new Date().toISOString(),
    });
    return { ok: true, slug: finalSlug, name: meta.name, description: meta.description, dir: targetDir, files: Object.keys(files).length };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Install a skill from browse.sh via the official `browse` CLI.
 * `npx -y browse skills add <slug>` — npx auto-downloads the CLI if not installed.
 * slug is the raw slug from the browse.sh catalogue (e.g. "alltrails.com" or
 * "yelp.com/extract-reviews"). The CLI installs into ~/<agent>/skills/<slug>/
 * where <agent> varies by detected harness.
 */
export async function installViaBrowseShCli({ slug, targetRoot, dir, name, force, skillDirs }) {
  if (!slug) throw new Error("browse.sh install requires a slug");
  await npxRun("browse", ["skills", "add", slug], {
    timeoutMs: 180000,
  });
  // The browse CLI places the skill under the detected agent's global skills dir.
  // Search all known agent skill directories, same strategy as the skills CLI.
  const userHome = process.env.HOME || process.env.USERPROFILE || ".";
  const homeDir = isWindows
    ? process.env.APPDATA || join(userHome, "AppData", "Roaming")
    : userHome;
  const agentDirs = isWindows
    ? [
        join(homeDir, "claude", "skills"),
        join(userHome, ".claude", "skills"),
        join(userHome, ".cursor", "skills"),
        join(userHome, ".codex", "skills"),
        join(userHome, ".windsurf", "skills"),
        join(userHome, ".agents", "skills"),
        join(userHome, ".browse", "skills"),
      ]
    : [
        join(userHome, ".claude", "skills"),
        join(userHome, ".cursor", "skills"),
        join(userHome, ".codex", "skills"),
        join(userHome, ".windsurf", "skills"),
        join(userHome, ".agents", "skills"),
        join(userHome, ".browse", "skills"),
      ];
  // The browse CLI may install under the slug's basename (last segment) or the full slug.
  const baseSlug = slug.includes("/") ? slug.split("/").pop() : slug;
  const kebabSlug = kebab(baseSlug) || baseSlug;
  for (const baseDir of agentDirs) {
    if (!existsSync(baseDir)) continue;
    // Try exact slug first, then basename, then kebab variant.
    for (const trySlug of [slug, baseSlug, kebabSlug]) {
      const direct = join(baseDir, trySlug);
      if (existsSync(direct)) {
        return copyInstalled(direct, { targetRoot, dir, name, slug: trySlug, force, skillDirs, originSource: "browse.sh", reference: slug });
      }
    }
    // Last resort within this dir: scan for any subdirectory containing SKILL.md
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateDir = join(baseDir, entry.name);
        if (existsSync(join(candidateDir, "SKILL.md"))) {
          return copyInstalled(candidateDir, { targetRoot, dir, name, slug: entry.name, force, skillDirs, originSource: "browse.sh", reference: slug });
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  throw new Error(
    `browse CLI 未在任何已知 agent 目录中生成技能 "${slug}"。` +
    "请手动运行 `npx browse skills add " + slug + "` 并检查输出。",
  );
}

/**
 * Install a skill from trusttools via the official `trusttools` CLI.
 * `npx -y trusttools install <reference>` auto-detects the agent environment.
 */
export async function installViaTrustToolsCli({ reference, targetRoot, dir, name, force, skillDirs }) {
  if (!reference) throw new Error("trusttools install requires a reference");
  await npxRun("trusttools", ["install", reference], {
    timeoutMs: 120000,
  });
  // trusttools installs into agent skill dirs; search common locations
  const userHome = process.env.HOME || process.env.USERPROFILE || ".";
  const homeDir = isWindows ? process.env.APPDATA || join(userHome, "AppData", "Roaming") : userHome;
  const baseSlug = basename(reference).split("/").pop();
  const kebabSlug = kebab(baseSlug) || baseSlug;
  const candidates = [
    join(homeDir, "trusttools", "skills", baseSlug),
    join(homeDir, "trusttools", "skills", kebabSlug),
    join(userHome, ".trusttools", "skills", baseSlug),
    join(userHome, ".trusttools", "skills", kebabSlug),
    join(userHome, ".claude", "skills", baseSlug),
    join(userHome, ".claude", "skills", kebabSlug),
    join(userHome, ".cursor", "skills", baseSlug),
    join(userHome, ".cursor", "skills", kebabSlug),
    join(userHome, ".agents", "skills", baseSlug),
    join(userHome, ".agents", "skills", kebabSlug),
  ];
  for (const cliTarget of candidates) {
    if (existsSync(cliTarget)) {
      return copyInstalled(cliTarget, { targetRoot, dir, name, slug: baseSlug, force, skillDirs, originSource: "trusttools", reference });
    }
  }
  // Last resort: scan trusttools skills dir for any dir with SKILL.md
  const scanBases = [join(homeDir, "trusttools", "skills"), join(userHome, ".trusttools", "skills")];
  for (const scanBase of scanBases) {
    if (!existsSync(scanBase)) continue;
    try {
      const entries = await readdir(scanBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(scanBase, entry.name);
        if (existsSync(join(candidate, "SKILL.md"))) {
          return copyInstalled(candidate, { targetRoot, dir, name, slug: entry.name, force, skillDirs, originSource: "trusttools", reference });
        }
      }
    } catch {
      // ignore unreadable
    }
  }
  throw new Error(`trusttools CLI did not produce a skill directory for "${baseSlug}" in any known path`);
}

/** Copy an installed skill directory into the target root and return the result. */
async function copyInstalled(cliSource, { targetRoot, dir, name, slug, force, skillDirs, originSource, reference }) {
  const roots = skillDirs && skillDirs.length > 0 ? skillDirs : [];
  const resolvedRoot = dir ? expandPath(dir) : roots[0];
  if (!resolvedRoot) throw new Error("no skill directories are configured");
  await ensureDir(resolvedRoot);

  const finalSlug = kebab(slug) || slug;
  const targetDir = join(resolvedRoot, finalSlug);
  await ensureDir(targetDir);

  // Walk the CLI-installed skill and copy all files
  const files = {};
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else files[relative] = await readFile(full, "utf8");
    }
  };
  await walk(cliSource, "");

  const skillText = files["SKILL.md"] || "";
  const meta = skillMetaFromText(skillText, finalSlug);
  if (!meta.name || !meta.description) {
    throw new Error("CLI-installed skill is missing name/description in SKILL.md frontmatter");
  }

  for (const [relative, content] of Object.entries(files)) {
    const target = join(targetDir, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await writeJson(join(targetDir, ".market-install.json"), {
    slug: finalSlug,
    name: meta.name,
    origin: { source: originSource, reference: reference || slug, cliInstall: true },
    installedAt: new Date().toISOString(),
  });
  return { ok: true, slug: finalSlug, name: meta.name, description: meta.description, dir: targetDir, files: Object.keys(files).length };
}

/** Download a file to a local path using fetch with fallback to curl/python. */
async function downloadFile(url, target, timeoutMs = 60000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(target, buffer);
    clearTimeout(timer);
    return target;
  } catch (error) {
    // Fall back to curl
    await new Promise((resolve, reject) => {
      const curlArgs = ["-sL", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--retry", "2", "-o", target, url];
      execFile("curl", curlArgs, { timeout: timeoutMs + 20000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`download failed: ${String(stderr || error.message).slice(0, 200)}`));
        else resolve(target);
      });
    });
  }
}
