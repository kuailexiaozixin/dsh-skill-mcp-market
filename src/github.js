// GitHub source adapter that avoids the GitHub API (blocked on some networks) by using
// jsDelivr: `data.jsdelivr.com` lists a repository tree, `cdn.jsdelivr.net` serves a file.
// jsDelivr's tree listing omits dot-directories (`.agents/`, `.claude/`), which is exactly
// where several market catalogues keep their skills, so the GitHub contents API is a
// documented fallback for those paths.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { execFile } from "node:child_process";
import { curlText, pythonDownload, pythonText } from "./http.js";

const LIST = "https://data.jsdelivr.com/v1/packages/gh";
const CDN = "https://cdn.jsdelivr.net/gh";
const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.1 (+skill installer)" };

/**
 * Fetch one text resource from GitHub's CDN/API hosts. Node's fetch does not read the
 * Windows system proxy, so on networks where GitHub is only reachable through that proxy
 * every request here would time out; the Python transport does honour it, and curl is the
 * last resort. Order: fetch (fast) → python (system proxy) → curl.
 */
async function fetchText(url, timeoutMs = 20000) {
  let firstError = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: UA, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    firstError = error;
  }
  if (/HTTP 404/.test(String((firstError && firstError.message) || ""))) throw firstError;
  try {
    return await pythonText(url, { headers: UA, timeoutMs });
  } catch (pythonError) {
    try {
      return await curlText(url, { headers: UA, timeoutMs });
    } catch {
      throw firstError || pythonError;
    }
  }
}

/**
 * Read one repository file. `raw.githubusercontent.com` is preferred because it is
 * reachable on more networks than the jsDelivr CDN; the CDN is the fallback.
 */
export async function fetchFileText(repo, ref, path) {
  const sources = [
    `${RAW}/${repo}/${encodeURIComponent(ref)}/${path}`,
    `${CDN}/${repo}@${encodeURIComponent(ref)}/${path}`,
  ];
  let lastError = null;
  for (const url of sources) {
    try {
      return await fetchText(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`cannot read ${path} from ${repo}`);
}

/** Parse `owner/repo`, `owner/repo@ref`, a github URL, or a jsDelivr URL. */
export function parseRepoRef(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("empty repository");
  let text = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/^https?:\/\/cdn\.jsdelivr\.net\/gh\//i, "");
  text = text.replace(/\.git$/i, "");
  const [pathPart, refPart] = text.split("@");
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error(`expected owner/repo, got "${input}"`);
  const repo = `${segments[0]}/${segments[1]}`;
  const subPath = segments.slice(2).join("/");
  return { repo, ref: (refPart || "").trim(), subPath };
}

export async function resolveRef(repo, preferred) {
  if (preferred) return preferred;
  for (const ref of ["main", "master"]) {
    try {
      const listing = await listTree(repo, ref);
      if (listing.length > 0) return ref;
    } catch {
      // try the next candidate
    }
  }
  try {
    const meta = await fetchText(`${LIST}/${repo}`);
    const versions = JSON.parse(meta)?.versions ?? [];
    if (versions.length > 0) return versions[0];
  } catch {
    // fall through
  }
  throw new Error(`cannot resolve a branch for ${repo}`);
}

/** Flat list of file paths in the repository at `ref`. */
export async function listTree(repo, ref) {
  const data = JSON.parse(await fetchText(`${LIST}/${repo}@${encodeURIComponent(ref)}`));
  const out = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes || []) {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      if (node.type === "directory") walk(node.files, path);
      else out.push(path);
    }
  };
  walk(data.files, "");
  return out;
}

/** Candidate skill directories (the directory that contains SKILL.md). */
export function skillDirsFrom(files) {
  return files
    .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .map((path) => (path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length)));
}

export function safeJoin(root, relative) {
  const target = normalize(join(root, relative));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  if (target !== normalize(root) && !target.startsWith(base)) {
    throw new Error(`refusing path outside the target directory: ${relative}`);
  }
  return target;
}

/**
 * Enumerate one repository subtree through the GitHub contents API, returning paths
 * relative to the repository root. Needed because jsDelivr's tree listing omits
 * dot-directories, and several market catalogues keep skills under `.agents/skills/`.
 */
async function listContentsViaApi(repo, ref, path = "", depth = 0, budget = { left: 400 }) {
  if (depth > 6 || budget.left <= 0) return [];
  const url = `${API}/repos/${repo}/contents/${path}${path ? "?" : "?"}ref=${encodeURIComponent(ref)}`;
  const data = JSON.parse(await fetchText(url, 25000));
  const entries = Array.isArray(data) ? data : [data];
  const out = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    if (!entry || !entry.name) continue;
    const full = path ? `${path}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      out.push(...await listContentsViaApi(repo, ref, full, depth + 1, budget));
    } else if (entry.type === "file") {
      budget.left -= 1;
      out.push(full);
    }
  }
  return out;
}

/**
 * Last-resort bundle fetch: download the repository tarball once and copy the skill subtree
 * out of it. jsDelivr's tree listing cannot see every directory (`.agents/` among them) and
 * the GitHub contents API is rate limited, but the archive endpoint is neither.
 */
async function downloadSkillViaTarball({ repo, ref, skillDir, destDir, limit }) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-market-tar-"));
  try {
    const archive = join(tmp, "repo.tgz");
    const extract = join(tmp, "x");
    await mkdir(extract, { recursive: true });
    const candidates = [
      `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`,
      `https://codeload.github.com/${repo}/tar.gz/${ref}`,
    ];
    let lastError = null;
    for (const url of candidates) {
      try {
        await pythonDownload(url, archive, { timeoutMs: 180000 });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    const { size } = await stat(archive);
    if (size > 200 * 1024 * 1024) throw new Error(`repository archive is ${Math.round(size / 1048576)} MB, too large`);
    await new Promise((resolve, reject) => {
      execFile("tar", ["-xzf", archive, "-C", extract], { timeout: 180000, windowsHide: true }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`tar 解包失败：${String(stderr || error.message).slice(0, 160)}`));
        else resolve();
      });
    });
    const roots = await readdir(extract, { withFileTypes: true });
    const root = roots.find((entry) => entry.isDirectory());
    if (!root) throw new Error("archive had no root directory");
    const source = join(extract, root.name, skillDir || "");
    if (!existsSync(join(source, "SKILL.md"))) {
      throw new Error(`no SKILL.md found at "${skillDir || "/"}" in ${repo}@${ref}`);
    }
    const written = [];
    const walk = async (current, prefix) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (written.length >= limit) return;
        if (entry.isDirectory()) await walk(join(current, entry.name), relative);
        else {
          const target = safeJoin(destDir, relative);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(current, entry.name), target);
          written.push(relative);
        }
      }
    };
    await walk(source, "");
    const skillText = await readFile(join(destDir, "SKILL.md"), "utf8");
    return { files: written, skipped: [], skillText, repo, ref, skillDir };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Download one skill directory into `destDir`.
 * Returns the files written and the SKILL.md text.
 */
export async function downloadSkillDir({ repo, ref, skillDir, destDir, limit = 400 }) {
  const files = await listTree(repo, ref).catch(() => []);
  const prefix = skillDir ? `${skillDir}/` : "";
  let selected = files.filter((path) => (prefix ? path.startsWith(prefix) : !path.includes("/")));
  if (!selected.some((path) => path === `${prefix}SKILL.md`)) {
    // jsDelivr's listing skips some directories, so ask the GitHub contents API next, and
    // fall back to the repository archive when that is unavailable (it is rate limited).
    const viaApi = await listContentsViaApi(repo, ref, skillDir).catch(() => []);
    const fromApi = viaApi.filter((path) => (prefix ? path.startsWith(prefix) : !path.includes("/")));
    if (fromApi.some((path) => path === `${prefix}SKILL.md`)) {
      selected = fromApi;
    } else {
      return downloadSkillViaTarball({ repo, ref, skillDir, destDir, limit });
    }
  }
  if (selected.length > limit) throw new Error(`skill has ${selected.length} files, over the ${limit} file limit`);
  const written = [];
  const skipped = [];
  let skillText = "";
  for (const path of selected) {
    const relative = prefix ? path.slice(prefix.length) : path;
    if (!relative || relative.includes("..")) continue;
    let content;
    try {
      content = await fetchFileText(repo, ref, path);
    } catch (error) {
      if (relative === "SKILL.md") throw new Error(`cannot read SKILL.md: ${String(error?.message || error)}`);
      skipped.push(relative);
      continue;
    }
    const target = safeJoin(destDir, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relative);
    if (relative === "SKILL.md") skillText = content;
  }
  return { files: written, skipped, skillText, repo, ref, skillDir };
}

export async function readRepoFile(repo, ref, path) {
  return fetchFileText(repo, ref, path);
}
