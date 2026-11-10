// GitHub source adapter that avoids the GitHub API (blocked on some networks) by using
// jsDelivr: `data.jsdelivr.com` lists a repository tree, `cdn.jsdelivr.net` serves a file.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

const LIST = "https://data.jsdelivr.com/v1/packages/gh";
const CDN = "https://cdn.jsdelivr.net/gh";
const RAW = "https://raw.githubusercontent.com";

const UA = { "User-Agent": "dsh-market/0.1 (+skill installer)" };

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
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
 * Download one skill directory into `destDir`.
 * Returns the files written and the SKILL.md text.
 */
export async function downloadSkillDir({ repo, ref, skillDir, destDir, limit = 400 }) {
  const files = await listTree(repo, ref);
  const prefix = skillDir ? `${skillDir}/` : "";
  const selected = files.filter((path) => (prefix ? path.startsWith(prefix) : !path.includes("/")));
  if (!selected.some((path) => path === `${prefix}SKILL.md`)) {
    throw new Error(`no SKILL.md found at "${skillDir || "/"}" in ${repo}@${ref}`);
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
