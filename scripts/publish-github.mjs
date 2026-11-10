// Publish this directory to a GitHub repository through the REST API, forcing the
// api.github.com IP that works on this network. No `git push` needed.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.DSH_MARKET_REPO || "dsh-skill-mcp-market";
const PRIVATE = (process.env.DSH_MARKET_PRIVATE || "true") !== "false";
const IPS = (process.env.GITHUB_API_IPS || "140.82.112.5,20.205.243.168").split(",").map((s) => s.trim());

if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN。需要经典 PAT 的 repo 权限，或细粒度 PAT 的 Administration: Read and write。");
  process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache", ".tmp-cache"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

function curl(args) {
  return execFileSync(
    "curl",
    ["-s", "-m", "60", "--resolve", `api.github.com:443:${ips[0]}`, ...args],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}
// try each candidate IP until one answers with a JSON body
let ips = IPS;
function api(method, path, body) {
  const payload = body === undefined ? [] : ["-H", "Content-Type: application/json", "-d", JSON.stringify(body)];
  let last = "";
  for (const ip of ips) {
    const args = ["-s", "-m", "60", "--resolve", `api.github.com:443:${ip}`, "-X", method,
      "-H", `Authorization: Bearer ${TOKEN}`,
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28",
      ...payload,
      `https://api.github.com${path}`];
    const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const text = String(out).trim();
    if (!text.startsWith("<")) {
      last = text;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not json */
      }
      if (parsed && !parsed.message) {
        ips = [ip]; // stick to the IP that works
        return { status: 200, data: parsed };
      }
      if (parsed && parsed.message) {
        // keep the last structured error but stop trying other IPs
        return { status: parsed.status || 0, data: parsed };
      }
    }
  }
  return { status: 0, data: { message: last || "no response" } };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else {
      out.push(relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

const me = api("GET", "/user");
if (me.status !== 200) {
  console.error("token 不可用：", me.data.message || me.status);
  process.exit(3);
}
const login = me.data.login;
console.log(`账号：${login}`);

const existing = api("GET", `/repos/${login}/${REPO}`);
if (existing.status === 200) {
  console.log(`仓库已存在：${existing.data.html_url}`);
} else {
  const created = api("POST", "/user/repos", {
    name: REPO,
    description: "DSH 的 SKILL 技能市场与 MCP 连接器市场：实时在线源、装完即刻生效、安装路径自定义",
    private: PRIVATE,
    has_issues: true,
  });
  if (created.status !== 200 && created.status !== 201) {
    console.error("创建仓库失败：", created.data.message || created.status);
    console.error("→ 需要经典 PAT 的 repo 权限，或细粒度 PAT 的 Administration: Read and write。");
    process.exit(4);
  }
  console.log(`已创建：${created.data.html_url}`);
}

const files = walk(ROOT);
let ok = 0;
const failed = [];
for (const path of files) {
  const content = readFileSync(join(ROOT, path));
  const encoded = content.toString("base64");
  const current = api("GET", `/repos/${login}/${REPO}/contents/${encodeURI(path)}`);
  const body = {
    message: `chore: sync ${path}`,
    content: encoded,
    ...(current.status === 200 && current.data.sha ? { sha: current.data.sha } : {}),
  };
  const put = api("PUT", `/repos/${login}/${REPO}/contents/${encodeURI(path)}`, body);
  if (put.status === 200 || put.status === 201) {
    ok += 1;
    console.log(`  ✓ ${path}`);
  } else {
    failed.push(`${path}: ${put.data.message || put.status}`);
    console.log(`  ✗ ${path} — ${put.data.message || put.status}`);
  }
}

console.log(`\n上传完成：${ok}/${files.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(` - ${item}`);
  process.exit(5);
}
console.log(`仓库地址：https://github.com/${login}/${REPO}`);
