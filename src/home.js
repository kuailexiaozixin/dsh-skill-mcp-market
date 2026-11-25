// Path resolution and persisted market settings.
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * 一个在任何进程里都真实可写的临时目录。
 * os.tmpdir() 依赖 TEMP/TMPDIR/TMP 环境变量：某些宿主进程（如 CI、被清空环境的
 * Electron 子进程）里三者全空，Windows 会拼出字面量 "undefined\temp"（实测），
 * 后续 mkdtemp/writeFile 全部 ENOENT。这里显式校验并逐级回退：
 *   TEMP/TMP 环境变量 → os.tmpdir() → ~/.dsh/tmp
 * 并确保目录存在。所有 mkdtemp/临时写入都应使用本函数，而不是裸 tmpdir()。
 */
export function safeTempDir() {
  const envCandidates = [process.env.DSH_TMP, process.env.TEMP, process.env.TMP, process.env.TMPDIR]
    .filter((v) => typeof v === "string" && v.trim() && !v.includes("undefined"));
  for (const c of envCandidates) {
    try { mkdirSync(c, { recursive: true }); if (existsSync(c)) return c; } catch { /* next */ }
  }
  const std = tmpdir();
  const stdLooksReal = std && !std.includes("undefined") && !std.includes("null");
  if (stdLooksReal) {
    try { mkdirSync(std, { recursive: true }); if (existsSync(std)) return std; } catch { /* next */ }
  }
  // 最后兜底：用户目录下的 .dsh/tmp（一定可写，因为整个插件就装在 ~/.dsh 下）
  const fallback = join(dshHome(), "tmp");
  // 兜底也必须真的创建出来；创建失败（如 HOME 指向非法卷）时绝不能 return 一个不存在的目录，
  // 否则调用方的 mkdtempSync 会 ENOENT —— 这正是 0.5.110 CI 红灯的确切成因。
  try { mkdirSync(fallback, { recursive: true }); if (existsSync(fallback)) return fallback; } catch { /* fall through */ }
  // 最后一条真实退路：当前工作目录下的 .dsh-tmp（进程能跑就说明 cwd 可解析）。
  const last = join(process.cwd(), ".dsh-tmp");
  try { mkdirSync(last, { recursive: true }); } catch { /* last resort also failed */ }
  return last;
}

/**
 * The environment block handed to every child process.
 *
 * Root cause this guards (two live regressions, 0.5.161 and 0.5.163, same origin): on Windows a
 * child that never receives `SystemDrive` cannot expand `%SystemDrive%`. npm does exactly that in
 * its own config, so the un-expanded literal becomes a *relative* path and the grandchild creates a
 * whole cache tree in the current working directory under a folder literally named `%SystemDrive%`.
 * DSH hosts often start us with a trimmed environment, so we must not assume the key is there.
 *
 * Contract (test/test-child-env.mjs is the authority):
 *  - fill only what is missing; a key the caller passed in `extra` is never overwritten, not even
 *    when its value is an empty string (an empty value from `extra` is the caller's decision);
 *  - an empty string coming from `base` counts as missing (Windows blocks stripped by a host carry
 *    `KEY=` more often than they carry a real value);
 *  - never mutate `base`, never write `process.env`, always return a fresh object;
 *  - non-Windows: pass `{...base, ...extra}` through untouched — inventing Windows keys there would
 *    be noise, and the literal-expansion bug cannot exist off Windows.
 *
 * @param {Record<string,string>|undefined} extra  caller-specific additions (win over base)
 * @param {Record<string,string>|undefined} baseEnv  base block; defaults to process.env
 */
export function childEnv(extra, baseEnv) {
  const base = baseEnv || process.env;
  const add = extra || {};
  const merged = { ...base, ...add };
  if (process.platform !== "win32") return merged;
  // Keys the caller named explicitly: honoured verbatim, empty string included.
  const given = new Set(Object.keys(add));
  const driveFrom = (value) => (/^[A-Za-z]:/.test(String(value || "")) ? String(value).slice(0, 2) : "");
  // Derivation order matters: SystemRoot first (it anchors both the drive and ComSpec), then
  // SystemDrive, which may itself have to come from the extra-supplied SystemRoot.
  const home = homedir();
  // homedir 在非 Windows 上没有盘符（CI 实测 /home/runner），故兜底顺序先看真实 SystemDrive，
  // 再看 homedir 前缀，最后落回 C:：保证任何平台上拼出来的都是绝对路径。
  const homeDrive = driveFrom(process.env.SystemDrive) || driveFrom(home) || "C:";
  if (!merged.SystemRoot && !given.has("SystemRoot")) {
    // 兜底盘符必须与 homedir 无关：CI 跑在 ubuntu 上，homedir() 是 /home/runner（无盘符），
    // 旧写法 "\\Windows" 会退化成无盘符路径，孙进程的 %SystemRoot% 就成了相对路径 —— 与本次修的 bug 同形。
    merged.SystemRoot = homeDrive + "\\Windows";
  }
  if (!merged.SystemDrive && !given.has("SystemDrive")) {
    merged.SystemDrive = driveFrom(merged.SystemRoot) || driveFrom(home) || "C:";
  }
  if (!merged.ComSpec && !given.has("ComSpec")) {
    merged.ComSpec = merged.SystemRoot + "\\system32\\cmd.exe";
  }
  if (!merged.UserProfile && !given.has("UserProfile")) {
    merged.UserProfile = home;
  }
  if (!merged.ProgramData && !given.has("ProgramData")) {
    merged.ProgramData = merged.SystemDrive + "\\ProgramData";
  }
  if (!merged.AppData && !given.has("AppData")) {
    merged.AppData = merged.UserProfile + "\\AppData\\Roaming";
  }
  if (!merged.LocalAppData && !given.has("LocalAppData")) {
    merged.LocalAppData = merged.UserProfile + "\\AppData\\Local";
  }
  return merged;
}

export function defaultSettings() {
  const home = dshHome();
  return {
    // Where the market looks for skills and where it installs them: the first entry is the default target.
    skillDirs: [join(home, "market", "skills")],
    // Where MCP server definitions (<serverName>.json) live.
    mcpDirs: [join(home, "market", "mcp")],
    // The `skills.disabled` idea as a DSH config item: names that stay on disk but are
    // hidden from the catalog. Absent from this list means enabled.
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
