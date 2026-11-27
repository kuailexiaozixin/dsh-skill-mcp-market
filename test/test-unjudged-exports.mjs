// 0.5.181 批一（测试判据补齐）：给「有生产调用方、零测试引用」的五个导出补判据。
//
// 名单与调用方（行号以 HEAD e9a2e45 为准；调用行由下面的 Test 逐条锁死，行号本身不锁）：
//   src/env.js:25            setUserEnvironmentVariable  index.js:36 import / index.js:250 调用
//   src/mcp-registry.js:228  registryCatalogueCacheKey   index.js:26 import / index.js:225 调用
//   src/mcp-registry.js:318  fallbackCards               index.js:26 import / index.js:237 调用
//   src/lobehub-market.js:29 lobehubRegistered           index.js:35 import / index.js:156 调用
//   src/lobehub-market.js:249 viewLobeHubMcp             index.js:35 import / index.js:1633 调用
// 补判据之前这五个在 test/ 目录里零引用：改坏它们任何一行，全链没有一段会红。
// test-dead-exports.mjs 的 Test 3 只锁「有引用」，不锁「有判据」——引用在、判据空在当时是合规状态；
// 现在它的 Test 6 把「调用方 + 判据 + 已挂链」三条一起钉住，本套件负责判据那一侧。
//
// 为什么带副作用的通路走「取源码函数体 + new Function 注入依赖」（姿势同本目录
// test-modelscope-category-vocab.mjs 的 bodyOf/runChips）：ESM 具名导入在链接期就绑定了
// node:child_process 的原函数，运行时改模块命名空间对象对 src/ 里的引用完全无效。
// 实测：把 cp.spawnSync 换成假函数再 import src/env.js 调用 setUserEnvironmentVariable，
// 假函数收到 0 次调用，而真的 powershell.exe 跑了一次并写进了用户环境变量——
// 「桩没生效」在这里是静默的，判据照样绿。所以 setUserEnvironmentVariable 的两条分支与
// viewLobeHubMcp 的 CLI 通路由注入依赖跑真函数体；纯函数与被动路径谓词打真模块。
//
// viewLobeHubMcp 的纪律（任务书硬约束）：判据只在注入桩下跑，绝不真发网络请求。
//   - CLI 通路：PATH 换成「假 npx 目录 + system32」（不含真 node 所在目录，真 npx 因此不可达），
//     runCli 到 execFile 到 cmd.exe 到假 npx.cmd 按真实代码走，落地是本地假程序；假程序把实收
//     argv 写盘，用来证明 CLI 包名与参数面没被改坏。
//   - manifest 通路：globalThis.fetch 桩且必须 resolve——src/http.js:87 在 fetch reject 后会
//     降级去 spawn curl，桩要在 fetch 层就成功返回，别把 curl 拖进来。
//   - 不依赖超时：没有 sleep、没有 setTimeout 等待，快且不会 flaky。
//
// 反证（变异段）：变异只在内存里的源码字符串上做（按行号定位变异针，先断言针落对了行），
// 绝不落盘到 src/。
import fs from "node:fs";
import path from "node:path";
import { safeTempDir } from "../src/home.js";

const W = path.resolve(import.meta.dirname, "..");
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const SQ = String.fromCharCode(39);
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const DOLLAR = String.fromCharCode(36);
const PLACEHOLDER = DOLLAR + "{NOTION_TOKEN}";
const PLACEHOLDER_VAR = DOLLAR + "X";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  PASS " + name); }
  else { failed += 1; console.log("  FAIL " + name + (detail === undefined ? "" : "  [" + String(detail).slice(0, 220) + "]")); }
};
const block = async (title, fn) => {
  console.log("");
  console.log(title);
  try { await fn(); } catch (e) {
    failed += 1;
    console.log("  FAIL " + title + " 执行期抛错（判据要红，不许崩掉汇总行）  [" + String((e && e.message) || e) + "]");
  }
};
// 断言「必须抛，且消息含 needle」。返回空串表示符合，否则返回不符原因。
const whyNotThrow = (fn, needle) => {
  try { fn(); return "没有抛错"; } catch (e) {
    const msg = String((e && e.message) || e);
    return msg.indexOf(needle) >= 0 ? "" : "消息不符：" + msg;
  }
};
const readRepo = (rel) => fs.readFileSync(path.join(W, rel), "utf8").split(CR).join("");
const stripExports = (s) => s.split(NL).map((l) => (l.indexOf("export ") === 0 ? l.slice(7) : l)).join(NL);
const lineAt = (src, n) => src.split(NL)[n - 1] === undefined ? "" : src.split(NL)[n - 1];
const mutateLine = (src, n, replacer) => src.split(NL).map((l, i) => (i === n - 1 ? replacer(l) : l)).join(NL);
const countNeedle = (src, n, needle) => lineAt(src, n).indexOf(needle) >= 0 ? 1 : 0;

// 顶层函数体提取：从 function name( 起，扫到与之配平的右花括号。扫描器必须认识行注释、
// 块注释、单双引号串、模板串（含 ${} 插值内部再配平）与正则字面量：src/env.js:6 与 :26
// 的引号就落在正则面量里，不认识正则的扫描器会误入字符串态、把整个函数体截丢（实测红过）。
// async 前缀要一起截走，否则 new Function 因为缺 async 报「await is only valid in async」。
// 将来若出现更刁钻的语法，提取会失败或不可解析，而每个用提取的段都先断言「可提取」，
// 于是落成 FAIL 而不是静默少测。
function sliceFn(src, name) {
  const sig = "function " + name + "(";
  let at = src.indexOf(sig);
  if (at < 0) return "";
  if (src.slice(0, at).endsWith("async ")) at -= 6;
  let i = src.indexOf("(", at);
  if (i < 0) return "";
  // 正则字面量只可能出现在这些字符之后（除法语境），据此区分 / 的两种身份。
  const RX_OK = "(,=:!&|?{[" + BS + ";" + "+" + "-" + "*" + "%" + "<" + ">" + "~" + "^";
  let pd = 0, bd = 0, prev = "";
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (ch === "/" && nx === "/") { const e = src.indexOf(NL, i); i = e < 0 ? src.length : e; prev = "/"; continue; }
    if (ch === "/" && nx === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; prev = "*"; continue; }
    if (ch === "/" && (prev === "" || RX_OK.indexOf(prev) >= 0)) {
      i += 1;
      let cls = false;
      while (i < src.length) {
        const c2 = src[i];
        if (c2 === BS) { i += 2; continue; }
        if (c2 === NL) break;
        if (c2 === "[") cls = true;
        else if (c2 === "]") cls = false;
        else if (c2 === "/" && !cls) { i += 1; break; }
        i += 1;
      }
      prev = "/";
      continue;
    }
    if (ch === SQ || ch === DQ || ch === BT) {
      const q = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === BS) { i += 2; continue; }
        if (q === BT && src[i] === DOLLAR && src[i + 1] === "{") {
          let bal = 1;
          i += 2;
          while (i < src.length && bal > 0) { if (src[i] === "{") bal += 1; else if (src[i] === "}") bal -= 1; i += 1; }
          continue;
        }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      prev = q;
      continue;
    }
    if (ch === "(") pd += 1;
    else if (ch === ")") pd -= 1;
    else if (ch === "{") bd += 1;
    else if (ch === "}") { bd -= 1; if (bd === 0 && pd === 0) return src.slice(at, i + 1); }
    if (ch !== " " && ch !== NL && ch !== CR && ch !== String.fromCharCode(9)) prev = ch;
    i += 1;
  }
  return "";
}

// 从（可能已变异的）源码文本里取顶层字符串/数值常量，判据不写死源码里的值。
function constOf(src, name) {
  const mark = "const " + name + " =";
  for (const l of src.split(NL)) {
    const at = l.indexOf(mark);
    if (at < 0) continue;
    let v = l.slice(at + mark.length).trim();
    if (v[v.length - 1] === ";") v = v.slice(0, -1).trim();
    if (v[0] === DQ) v = v.slice(1);
    if (v[v.length - 1] === DQ) v = v.slice(0, -1);
    return v;
  }
  return "";
}

const ENV_SRC = readRepo("src/env.js");
const REG_SRC = readRepo("src/mcp-registry.js");
const LOB_SRC = readRepo("src/lobehub-market.js");
const IDX_SRC = readRepo("index.js");
const idxHas = (needle) => IDX_SRC.split(NL).some((l) => l.indexOf(needle) >= 0);
const ENV_LINE = 25, REG_KEY_LINE = 228, REG_FB_LINE = 318, LOB_REG_LINE = 29, LOB_VIEW_LINE = 249;
check("导出位置锁死（改签名/挪函数=重新登记行号，判据本身也要重新看）",
  lineAt(ENV_SRC, ENV_LINE).indexOf("export function setUserEnvironmentVariable(") === 0 &&
  lineAt(REG_SRC, REG_KEY_LINE).indexOf("export function registryCatalogueCacheKey(") === 0 &&
  lineAt(REG_SRC, REG_FB_LINE).indexOf("export function fallbackCards(") === 0 &&
  lineAt(LOB_SRC, LOB_REG_LINE).indexOf("export function lobehubRegistered(") === 0 &&
  lineAt(LOB_SRC, LOB_VIEW_LINE).indexOf("export async function viewLobeHubMcp(") === 0,
  [lineAt(ENV_SRC, ENV_LINE), lineAt(REG_SRC, REG_KEY_LINE), lineAt(REG_SRC, REG_FB_LINE), lineAt(LOB_SRC, LOB_REG_LINE), lineAt(LOB_SRC, LOB_VIEW_LINE)].join(" | "));

const ROOT = path.join(safeTempDir(), "dsh181-unjudged-" + process.pid);
fs.mkdirSync(ROOT, { recursive: true });
// 假 npx 必须放 ASCII 路径：cmd.exe 读 batch 用 OEM 代码页，safeTempDir 若落在非 ASCII 目录里
// 批处理路径会失效（实测），桩通路就会假红。仓库的 .tmp-cache/ 在 .gitignore 内。
const BINROOT = path.join(W, ".tmp-cache", "unjudged-181");
const SYS32 = path.join(process.env.SystemRoot || "C:" + BS + "Windows", "system32");
const cleanup = () => {
  for (const dir of [ROOT, BINROOT]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已清理 */ }
  }
};

let stubSeq = 0;
function makeFakeNpx(payload) {
  // 每个桩一个独立目录：PATH 里先进的那个必须就是本次要的桩，否则上一段的 argv 记录会串。
  const dir = path.join(BINROOT, "bin-" + String(stubSeq));
  stubSeq += 1;
  const outFile = path.join(dir, "argv.json");
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, "cli-stub.mjs");
  fs.writeFileSync(stub, [
    "import fs from " + DQ + "node:fs" + DQ + ";",
    "fs.writeFileSync(" + JSON.stringify(outFile) + ", JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(" + JSON.stringify(payload) + ");",
    "",
  ].join(NL), "utf8");
  fs.writeFileSync(path.join(dir, "npx.cmd"),
    "@echo off" + CR + NL + DQ + process.execPath + DQ + " " + DQ + stub + DQ + " %*" + CR + NL, "utf8");
  return { dir, stub, outFile };
}
const withPath = async (dirs, fn) => {
  const prev = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; }
};
function withFetch(impl, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", { value: impl, configurable: true, writable: true });
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      (v) => { Object.defineProperty(globalThis, "fetch", desc); return v; },
      (e) => { Object.defineProperty(globalThis, "fetch", desc); throw e; });
    Object.defineProperty(globalThis, "fetch", desc);
    return r;
  } catch (e) { Object.defineProperty(globalThis, "fetch", desc); throw e; }
}
function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, "platform", desc); }
}

// ---------------------------------------------------------------- 可注入副本
// 真函数体 + 注入的模块内依赖（deps 形参遮蔽同名顶层绑定，src 侧代码一行不改）。
function viewCore(mutate) {
  let src = stripExports(LOB_SRC);
  if (mutate) src = mutate(src);
  const body = sliceFn(src, "viewLobeHubMcp");
  if (!body) return null;
  const prelude = "let runCli = deps.runCli;" + NL + "let lobehubManifestDefinition = deps.lobehubManifestDefinition;";
  return (deps) => new Function("deps", prelude + NL + body + NL + "return viewLobeHubMcp;")(deps);
}
function envCore(mutate) {
  let src = stripExports(ENV_SRC);
  if (mutate) src = mutate(src);
  const parts = ["quotePowerShell", "buildPosixExportLine", "setUserEnvironmentVariable"].map((n) => sliceFn(src, n));
  if (parts.some((p) => !p)) return null;
  return (spawnImpl) => new Function("spawnSync", parts.join(NL + NL) + NL +
    "return { setUserEnvironmentVariable: setUserEnvironmentVariable, buildPosixExportLine: buildPosixExportLine };")(spawnImpl);
}
function regKeyCore(srcMut) {
  const body = sliceFn(stripExports(srcMut), "registryCatalogueCacheKey");
  if (!body) return null;
  return new Function("Math", "Number", "String", "CACHE_VERSION", "REGISTRY_PAGE_SIZE",
    body + NL + "return registryCatalogueCacheKey;")(
    Math, Number, String, constOf(srcMut, "CACHE_VERSION"), Number(constOf(srcMut, "REGISTRY_PAGE_SIZE")) || 24);
}
function fallbackRows(srcMut) {
  const lines = (srcMut || REG_SRC).split(NL);
  const a = lines.findIndex((l) => l.indexOf("const FALLBACK_SERVERS =") >= 0);
  if (a < 0) return null;
  let b = a;
  while (b < lines.length && lines[b].trim() !== "];") b += 1;
  if (b >= lines.length) return null;
  return new Function(lines.slice(a, b + 1).join(NL) + NL + "return FALLBACK_SERVERS;")();
}
function fallbackCore(srcMut) {
  const body = sliceFn(srcMut, "fallbackCards");
  if (!body) return null;
  return (rows) => new Function("FALLBACK_SERVERS", body + NL + "return fallbackCards;")(rows);
}
const MANIFEST_FIXTURE = {
  name: "12306 车票查询",
  description: "搜索中国铁路余票",
  homepage: "https://github.com/example/12306",
  category: "travel",
  deploymentOptions: [{
    isRecommended: true,
    connection: {
      command: "npx",
      args: ["-y", "12306-mcp"],
      env: { MCP_DEBUG: "0" },
      configSchema: {
        required: ["NOTION_TOKEN"],
        properties: { NOTION_TOKEN: { description: "Notion 集成令牌" }, MCP_PORT: { default: 8300 } },
      },
    },
  }],
};
// definitionFromManifest 也走真函数体：view 的 manifest 回退分支字段面才可证（注入版不参与）。
function manifestCore(mutate) {
  let src = stripExports(LOB_SRC);
  if (mutate) src = mutate(src);
  const body = sliceFn(src, "definitionFromManifest");
  if (!body) return null;
  return new Function(body + NL + "return definitionFromManifest;")();
}
// ================================================================ Test 1: registryCatalogueCacheKey
await block("Test 1: registryCatalogueCacheKey —— 目录缓存键（真模块直跑，index.js:225 用它判定 stale）", async () => {
  const { registryCatalogueCacheKey } = await import("../src/mcp-registry.js");
  const CV = constOf(REG_SRC, "CACHE_VERSION");
  const PS = Number(constOf(REG_SRC, "REGISTRY_PAGE_SIZE"));
  const key = registryCatalogueCacheKey("Chrome", 24, "Developer Tools");
  check("键形态 registry:<版本>:cat:<query>:<category>:<size>（版本变了必须换键，旧缓存不得续用）",
    CV === "v3" && key === "registry:v3:cat:chrome:developer tools:24", key);
  check("query 与 category 一同 trim + 小写归一（归一漏一半=同一页两个键，翻页各存一份）",
    registryCatalogueCacheKey("  ChRoMe ", 24, "  Developer Tools ") === key,
    registryCatalogueCacheKey("  ChRoMe ", 24, "  Developer Tools "));
  check("空 query 落 all 占位（分类页首屏无关键词，index.js:225 传的就是空串）",
    registryCatalogueCacheKey("", 24, "") === "registry:v3:cat:all::24", registryCatalogueCacheKey("", 24, ""));
  check("category 缺省是空段而不是 all（无分类与全部分类不同义，混起来会让筛选页读到全量缓存）",
    registryCatalogueCacheKey("chrome", 24) === "registry:v3:cat:chrome::24" &&
    registryCatalogueCacheKey("chrome", 24) !== registryCatalogueCacheKey("chrome", 24, "all"),
    registryCatalogueCacheKey("chrome", 24));
  check("pageSize 缺省/0/NaN 一律回落 REGISTRY_PAGE_SIZE=" + PS,
    registryCatalogueCacheKey("x") === "registry:v3:cat:x::" + PS &&
    registryCatalogueCacheKey("x", 0) === "registry:v3:cat:x::" + PS &&
    registryCatalogueCacheKey("x", "abc") === "registry:v3:cat:x::" + PS,
    registryCatalogueCacheKey("x", "abc"));
  check("size 夹在 1..100 再入键（越界值必须与钳位后的切片尺寸一致，否则读到的 state 切错页）",
    registryCatalogueCacheKey("x", -5) === "registry:v3:cat:x::1" &&
    registryCatalogueCacheKey("x", 5000) === "registry:v3:cat:x::100",
    registryCatalogueCacheKey("x", -5) + " | " + registryCatalogueCacheKey("x", 5000));
  check("不同分类 → 不同键（同 query 换分类必须重取，不得命中上一页的累积目录）",
    registryCatalogueCacheKey("a", 24, "b") !== registryCatalogueCacheKey("a", 24, "c"), "collision");
  check("不同 pageSize → 不同键（累积目录的切片基准变了，同键复用会把 10 条/页当成 24 条/页）",
    registryCatalogueCacheKey("a", 24, "b") !== registryCatalogueCacheKey("a", 10, "b"), "collision");
  check("index.js:225 确以 (query, REGISTRY_PAGE_SIZE, category) 三参调用它",
    idxHas("registryCatalogueCacheKey(query, REGISTRY_PAGE_SIZE, category)"), "调用行缺失");
  check("index.js:26 仍从 src/mcp-registry.js import 它（调用方在，判据才有意义）",
    idxHas("registryCatalogueCacheKey") && idxHas("from " + DQ + "./src/mcp-registry.js" + DQ), "import 行缺失");
});

// ================================================================ Test 2: fallbackCards
await block("Test 2: fallbackCards —— 上游不可用时的兜底卡片（真模块直跑，index.js:237 直接当 items）", async () => {
  const { fallbackCards } = await import("../src/mcp-registry.js");
  const rows = fallbackRows(REG_SRC);
  check("源码兜底清单可枚举（条目数取自源码，判据不写死 4）", Array.isArray(rows) && rows.length === 4, rows && rows.length);
  const all = fallbackCards();
  check("无 query 返回全部兜底条目", Array.isArray(all) && all.length === rows.length, all.length);
  check("每条字段自洽：id=registry:<slug>、name=slug 末段、可安装、标记 catalogFallback、来源 registry、stdio+npx",
    all.every((c) => c && c.id === "registry:" + c.slug && c.slug.indexOf("/") > 0 &&
      c.name === c.slug.split("/").pop() && c.installable === true && c.catalogFallback === true &&
      c.source === "registry" && c.command === "npx" && c.transport === "stdio"),
    JSON.stringify(all[0]));
  check("每条都带 description（卡片正文空=面板出现无描述的可安装项）",
    all.every((c) => typeof c.description === "string" && c.description.length > 8), JSON.stringify(all.map((c) => c.description)));
  check("query 归一后按 name+description 过滤命中",
    (() => { const h = fallbackCards("CHROME devtools"); return h.length === 1 && h[0].slug === "io.github.Async23/chrome-devtools-mcp"; })(),
    JSON.stringify(fallbackCards("CHROME devtools").map((c) => c.slug)));
  check("只命中描述也算命中（「结构检查」只在第三条 description 里出现，slug/name 都没有它）",
    (() => { const s = fallbackCards("结构检查"); return s.length === 1 && s[0].slug === "io.github.arifulislamat/database-mcp-sqlite"; })(),
    JSON.stringify(fallbackCards("结构检查").map((c) => c.slug)));
  check("筛不中就是空数组——把全量兜底当搜索结果发给用户是假陈述",
    (() => { const n = fallbackCards("绝对不存在的词条 xyzzy"); return Array.isArray(n) && n.length === 0; })(),
    JSON.stringify(fallbackCards("绝对不存在的词条 xyzzy").map((c) => c.slug)));
  check("空串 query 等价全量（index.js:237 传原始 query，空串不得被当成筛不中）",
    fallbackCards("").length === all.length, fallbackCards("").length);
  check("兜底卡片不编造上游没给过的数（category 空、无 installs/rating、homepage 空）",
    all.every((c) => c.category === "" && c.installs === undefined && c.rating === undefined && c.homepage === ""),
    JSON.stringify(all[0] && [all[0].category, all[0].installs, all[0].rating, all[0].homepage]));
  check("兜底卡片不谎称需要环境变量（清单未逐个核验 env，谎报会逼用户去填无关密钥）",
    all.every((c) => Array.isArray(c.envRequired) && c.envRequired.length === 0 && c.envHints && Object.keys(c.envHints).length === 0),
    JSON.stringify(all.map((c) => c.envRequired)));
  check("index.js:237 以 items: fallbackCards(query) 装配进面板载荷",
    idxHas("items: fallbackCards(query)"), "调用行缺失");
});

// ================================================================ Test 3: lobehubRegistered
await block("Test 3: lobehubRegistered —— 「是否已注册」谓词（真模块 + HOME 重定向，零网络）", async () => {
  const { lobehubRegistered } = await import("../src/lobehub-market.js");
  const homeNone = path.join(ROOT, "home-none");
  const homeReg = path.join(ROOT, "home-reg");
  fs.mkdirSync(homeNone, { recursive: true });
  fs.mkdirSync(path.join(homeReg, ".lobehub-market"), { recursive: true });
  const cred = path.join(homeReg, ".lobehub-market", "credentials.json");
  const prevU = process.env.USERPROFILE, prevH = process.env.HOME;
  try {
    process.env.USERPROFILE = homeNone;
    process.env.HOME = homeNone;
    check("无凭证文件 → false（首装用户不得被提示「已注册」）", lobehubRegistered() === false, lobehubRegistered());
    fs.writeFileSync(cred, "{" + "}", "utf8");
    process.env.USERPROFILE = homeReg;
    process.env.HOME = homeReg;
    check("有凭证文件 → true（index.js:156 registerHint 的唯一来源）", lobehubRegistered() === true, lobehubRegistered());
    fs.writeFileSync(cred, "", "utf8");
    check("空凭证文件仍算已注册（谓词只锁存在性，不去解析内容——解析失败不该翻成未注册）",
      lobehubRegistered() === true, lobehubRegistered());
    fs.rmSync(cred, { force: true });
    check("凭证文件删掉后回到 false（谓词不吃缓存，注册提示不会赖在面板上）",
      lobehubRegistered() === false, lobehubRegistered());
  } finally {
    if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
    if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
  }
  check("凭证路径常量锁死（目录名或文件名被改=谓词永远读到不存在的路径，提示恒假）",
    LOB_SRC.indexOf(DQ + ".lobehub-market" + DQ) >= 0 && LOB_SRC.indexOf(DQ + "credentials.json" + DQ) >= 0, "路径行缺失");
  check("谓词自带 try/catch（homedir 抛错时必须回落 false，不得把面板的 registerHint 拖崩）",
    countNeedle(LOB_SRC, LOB_REG_LINE + 1, "try {") === 1 &&
    lineAt(LOB_SRC, LOB_REG_LINE + 3).indexOf("catch") >= 0 &&
    lineAt(LOB_SRC, LOB_REG_LINE + 4).indexOf("return false") >= 0,
    lineAt(LOB_SRC, LOB_REG_LINE + 1) + " | " + lineAt(LOB_SRC, LOB_REG_LINE + 4));
  check("index.js:156 确以 const registerHint = lobehubRegistered() 调用",
    idxHas("const registerHint = lobehubRegistered()"), "调用行缺失");
});
// ================================================================ Test 4: setUserEnvironmentVariable 入参闸
await block("Test 4: setUserEnvironmentVariable —— 名称与空值闸（真函数体，注入 spawnSync 零副作用）", async () => {
  const build = envCore(null);
  check("src/env.js 三个函数体可提取（提取失败=签名被改，先红在这里）", !!build, "sliceFn 失败");
  const calls = [];
  const fakeSpawn = (file, args, opts) => { calls.push({ file, args, opts }); return { status: 0, stdout: "", stderr: "" }; };
  const m = build(fakeSpawn);
  const badNames = ["1BAD", "HAS SPACE", "", "-LEAD", PLACEHOLDER_VAR, "A" + BS + "B", "名字"];
  for (const n of badNames) {
    const why = whyNotThrow(() => m.setUserEnvironmentVariable(n, "v1"), "非法的环境变量名");
    check("非法变量名被拒：" + JSON.stringify(n) + " → 非法的环境变量名", why === "", why);
  }
  const badVals = ["", null, undefined, 5, true, {}, ["a"]];
  for (const v of badVals) {
    const label = Array.isArray(v) ? "array" : v === null ? "null" : v === undefined ? "undefined" : (typeof v === "object" ? "object" : JSON.stringify(v));
    const why = whyNotThrow(() => m.setUserEnvironmentVariable("LH_T181_GUARD", v), "值不能为空");
    check("值闸：typeof value !== string 或空串拒掉 " + label + " → 值不能为空", why === "", why);
  }
  check("闸在落盘之前：上面每次被拒都没有产生任何子进程调用", calls.length === 0, calls.length);
  let okNames = true;
  for (const n of ["_LH_OK", "LH_OK2", "LH"]) {
    try { m.setUserEnvironmentVariable(n, "v"); } catch (e) { okNames = false; }
  }
  for (const n of ["_LH_OK", "LH_OK2", "LH"]) delete process.env[n];
  check("合法名面放行（下划线开头/纯大写/数字尾位都是合法 POSIX 名）", okNames, "合法名被误拒");
  check("index.js:36 仍 import 它且 index.js:250 真调用（写环境变量这条用户通路没被改飞）",
    idxHas("setUserEnvironmentVariable") && idxHas("from " + DQ + "./src/env.js" + DQ) && idxHas("setUserEnvironmentVariable(name, value)"),
    "调用行缺失");
});

// ================================================================ Test 5: setUserEnvironmentVariable 两分支
await block("Test 5: setUserEnvironmentVariable —— win32 与 posix 两条写路径（注入 spawnSync，不碰真注册表/真 profile）", async () => {
  const build = envCore(null);
  const rec = () => { const calls = []; return { calls, spawn: (f, a, o) => { calls.push({ f, a, o }); return { status: 0, stdout: "", stderr: "" }; } }; };
  // ---- win32
  const w = rec();
  let retW = null, wErr = null;
  withPlatform("win32", () => {
    const m = build(w.spawn);
    try { retW = m.setUserEnvironmentVariable("LH_T181_WIN", "it" + SQ + "s"); } catch (e) { wErr = e; }
  });
  check("win32：powershell.exe + -NoProfile -NonInteractive -Command",
    !wErr && w.calls.length === 1 && w.calls[0].f === "powershell.exe" &&
    w.calls[0].a[0] === "-NoProfile" && w.calls[0].a[1] === "-NonInteractive" && w.calls[0].a[2] === "-Command",
    JSON.stringify(wErr ? String(wErr.message) : (w.calls[0] && [w.calls[0].f, w.calls[0].a.slice(0, 3)])));
  check("win32：单引号必须翻倍转义（漏转义=值里的引号能逃出字面量，注入 SetEnvironmentVariable 参数）",
    !wErr && w.calls.length === 1 &&
    w.calls[0].a[3] === "[Environment]::SetEnvironmentVariable(" + SQ + "LH_T181_WIN" + SQ + "," + SQ + "it" + SQ + SQ + "s" + SQ + "," + SQ + "User" + SQ + ")",
    JSON.stringify(wErr ? String(wErr.message) : (w.calls[0] && w.calls[0].a[3])));
  check("win32：spawn 选项面（windowsHide/encoding/timeout=20000，超时是 20s 不是无限等）",
    w.calls[0] && w.calls[0].o && w.calls[0].o.windowsHide === true && w.calls[0].o.encoding === "utf8" && w.calls[0].o.timeout === 20000,
    JSON.stringify(w.calls[0] && w.calls[0].o));
  check("win32：成功返回 {ok:true,name,scope:user,platform:win32}",
    !wErr && retW && retW.ok === true && retW.name === "LH_T181_WIN" && retW.scope === "user" && retW.platform === "win32",
    JSON.stringify(wErr ? String(wErr.message) : retW));
  check("win32：process.env 同步更新（面板写完立刻要能读到新值，否则提示是假的）",
    process.env.LH_T181_WIN === "it" + SQ + "s", JSON.stringify(process.env.LH_T181_WIN));
  delete process.env.LH_T181_WIN;
  const wFail = rec();
  wFail.spawn = (f, a, o) => { wFail.calls.push({ f, a, o }); return { status: 1, stdout: "", stderr: "boom" }; };
  let boomWhy = "";
  withPlatform("win32", () => { try { build(wFail.spawn).setUserEnvironmentVariable("LH_T181_WIN", "v"); } catch (e) { boomWhy = String(e.message); } });
  check("win32：非零退出必须抛「写入系统环境变量失败」并带上 stderr",
    boomWhy.indexOf("写入系统环境变量失败") >= 0 && boomWhy.indexOf("boom") >= 0, boomWhy);
  const wSilent = rec();
  wSilent.spawn = () => ({ status: 2, stdout: "", stderr: "" });
  let exitWhy = "";
  withPlatform("win32", () => { try { build(wSilent.spawn).setUserEnvironmentVariable("LH_T181_WIN", "v"); } catch (e) { exitWhy = String(e.message); } });
  check("win32：stderr/stdout 全空时退化成 exit <status>（不得抛一条没有原因的错误）",
    exitWhy.indexOf("exit 2") >= 0, exitWhy);
  check("win32：失败路径不得写 process.env（写失败却告诉用户成功=面板说谎）",
    process.env.LH_T181_WIN === undefined, JSON.stringify(process.env.LH_T181_WIN));
  // ---- posix
  const px = rec();
  let retP = null, pErr = null;
  withPlatform("linux", () => {
    try { retP = build(px.spawn).setUserEnvironmentVariable("LH_T181_POSIX", "it" + SQ + "s"); } catch (e) { pErr = e; }
  });
  check("posix：走 sh -c 追加 ~/.profile，不再调 powershell.exe",
    !pErr && px.calls.length === 1 && px.calls[0].f === "sh" && px.calls[0].a[0] === "-c" &&
    px.calls[0].a[1].indexOf("printf ") === 0 && px.calls[0].a[1].indexOf(" >> ~/.profile") >= 0,
    JSON.stringify(pErr ? String(pErr.message) : (px.calls[0] && [px.calls[0].f, px.calls[0].a])));
  check("posix：写入行是 buildPosixExportLine 的产物且带引号转义（值里的单引号翻成 '\\'' 逃不出去）",
    !pErr && px.calls.length === 1 &&
    px.calls[0].a[1].indexOf(JSON.stringify("export LH_T181_POSIX=" + SQ + "it" + SQ + BS + SQ + SQ + "s" + SQ)) >= 0,
    JSON.stringify(px.calls[0] && px.calls[0].a[1]));
  check("posix：spawn 选项面（encoding utf8 + timeout=10000）",
    px.calls[0] && px.calls[0].o && px.calls[0].o.encoding === "utf8" && px.calls[0].o.timeout === 10000,
    JSON.stringify(px.calls[0] && px.calls[0].o));
  check("posix：成功返回 platform 跟随真实平台", !pErr && retP && retP.ok === true && retP.platform === "linux", JSON.stringify(pErr ? String(pErr.message) : retP));
  check("posix：process.env 同步更新", process.env.LH_T181_POSIX === "it" + SQ + "s", JSON.stringify(process.env.LH_T181_POSIX));
  delete process.env.LH_T181_POSIX;
  const pxFail = rec();
  pxFail.spawn = () => ({ status: 1, stdout: "", stderr: "read-only fs" });
  let posixWhy = "";
  withPlatform("linux", () => { try { build(pxFail.spawn).setUserEnvironmentVariable("LH_T181_POSIX", "v"); } catch (e) { posixWhy = String(e.message); } });
  check("posix：非零退出抛「写入 shell 配置失败」并带 stderr",
    posixWhy.indexOf("写入 shell 配置失败") >= 0 && posixWhy.indexOf("read-only fs") >= 0, posixWhy);
});
// ================================================================ Test 6: viewLobeHubMcp（注入 runCli/manifest）
await block("Test 6: viewLobeHubMcp —— 字段映射与回退（注入桩跑真函数体，零网络零子进程）", async () => {
  const make = viewCore(null);
  check("src/lobehub-market.js viewLobeHubMcp 函数体可提取", !!make, "sliceFn 失败");
  const boomRunCli = async () => { throw new Error("runCli 不该被调用"); };
  const boomManifest = async () => { throw new Error("manifest 不该被调用"); };
  const hit = { identifier: "io.github/cached", detailSource: "cache" };
  const gets = [], puts = [];
  const cacheHit = { get: async (k, ttl) => { gets.push([k, ttl]); return hit; }, put: async (k, v) => { puts.push([k, v]); } };
  const r1 = await make({ runCli: boomRunCli, lobehubManifestDefinition: boomManifest })("IO.GitHub/Cached", { cache: cacheHit });
  check("缓存命中直接返回缓存对象（CLI 与 manifest 都没被碰：网络/子进程零发生）",
    r1 === hit && gets.length === 1 && puts.length === 0, JSON.stringify([gets.length, puts.length]));
  check("缓存键 = lobehub_mcp_view: + identifier 小写，TTL=30min",
    gets[0][0] === "lobehub_mcp_view:" + "io.github/cached" && gets[0][1] === 30 * 60 * 1000, JSON.stringify(gets[0]));
  const cliJson = JSON.stringify({ data: {
    name: "酷工具", description: "很酷", ratingAverage: 4.2, installCount: 1789,
    envRequired: ["API_KEY"], envHints: { API_KEY: "必填密钥" }, homepage: "https://x.example/", owner: "acme",
  } });
  const cliCalls = [];
  const puts2 = [];
  const cache2 = { get: async () => null, put: async (k, v) => { puts2.push([k, v]); } };
  const r2 = await make({
    runCli: async (args, timeoutMs) => { cliCalls.push([args, timeoutMs]); return cliJson; },
    lobehubManifestDefinition: boomManifest,
  })("io.github/cool", { cache: cache2 });
  check("CLI 调用面：mcp view <id> --output json，timeout 透传默认 90000",
    cliCalls.length === 1 && cliCalls[0][0].join(" ") === "mcp view io.github/cool --output json" && cliCalls[0][1] === 90000,
    JSON.stringify(cliCalls[0] && cliCalls[0][0]));
  check("CLI 成功字段映射（name/description/rating/installs/envRequired/envHints/homepage/owner/detailSource）",
    r2.name === "酷工具" && r2.description === "很酷" && r2.rating === 4.2 && r2.installs === 1789 &&
    r2.envRequired.join() === "API_KEY" && r2.envHints.API_KEY === "必填密钥" && r2.homepage === "https://x.example/" &&
    r2.owner === "acme" && r2.slug === "io.github/cool" && r2.identifier === "io.github/cool" &&
    r2.detailSource === "lobehub-cli" && r2.category === "", JSON.stringify(r2));
  check("CLI 成功后写缓存（同一 key，put 恰一次）",
    puts2.length === 1 && puts2[0][0] === "lobehub_mcp_view:io.github/cool" && puts2[0][1] === r2,
    JSON.stringify(puts2.map((x) => x[0])));
  const r3 = await make({ runCli: async () => JSON.stringify({ data: {} }), lobehubManifestDefinition: boomManifest })("io.github/empty", {});
  check("上游缺字段不编造：rating/installs 为 null、envRequired 空、homepage 回落市场页 URL（encodeURIComponent）",
    r3.rating === null && r3.installs === null && Array.isArray(r3.envRequired) && r3.envRequired.length === 0 &&
    r3.homepage === "https://market.lobehub.com/" + encodeURIComponent("io.github/empty") && r3.name === "io.github/empty",
    JSON.stringify(r3));
  const r3b = await make({ runCli: async () => JSON.stringify({ name: "顶层即数据", description: "d" }), lobehubManifestDefinition: boomManifest })("io.github/top", {});
  check("parsed.data 缺失时回落 parsed 本体（CLI 直接吐 data 外层的形状也能读）",
    r3b.name === "顶层即数据" && r3b.description === "d", JSON.stringify(r3b));
  const fbDef = { title: "兜底标题", description: "兜底描述", envRequired: ["TOKEN"], envHints: {}, owner: "ov", url: "" };
  const r4 = await make({
    runCli: async () => { throw new Error("LobeHub 市场命令失败：ENOENT npx"); },
    lobehubManifestDefinition: async (id) => { if (id !== "io.github/broken") throw new Error("id 透传错误"); return fbDef; },
  })("io.github/broken", {});
  check("CLI 抛错 → manifest 回退：detailSource=lobehub-manifest、name=fallback.title、envRequired 透传、id 透传",
    r4.detailSource === "lobehub-manifest" && r4.name === "兜底标题" && r4.description === "兜底描述" &&
    r4.envRequired.join() === "TOKEN" && r4.owner === "ov" && r4.rating === null && r4.installs === null &&
    r4.homepage === "https://market.lobehub.com/" + encodeURIComponent("io.github/broken"), JSON.stringify(r4));
  check("回退必须留 note 自证降级（含原因摘要 + 已回退到 manifest）",
    r4.note.indexOf("CLI view 不可用") === 0 && r4.note.indexOf("ENOENT npx") >= 0 && r4.note.indexOf("已回退到 manifest") > 0,
    r4.note);
  let dualErr = "";
  try {
    await make({
      runCli: async () => { throw new Error("cli down"); },
      lobehubManifestDefinition: async () => { throw new Error("manifest down"); },
    })("io.github/dead", {});
  } catch (e) { dualErr = String(e.message); }
  check("CLI 与 manifest 同时失败：错误原样上抛（不得静默吞成空对象）", dualErr === "manifest down", dualErr);
  check("index.js:1633 确以 await viewLobeHubMcp(body.serverName, { cache: marketCache }) 调用",
    idxHas("await viewLobeHubMcp(body.serverName, { cache: marketCache })"), "调用行缺失");
});

// ================================================================ Test 7: viewLobeHubMcp 真模块通路
await block("Test 7: viewLobeHubMcp —— 真模块 + 假 npx + fetch 桩（真 runCli/getJson，仍零外网）", async () => {
  const mod = await import("../src/lobehub-market.js");
  const puts = [];
  const cache = { get: async () => null, put: async (k, v) => { puts.push([k, v]); } };
  const cliPayload = JSON.stringify({ data: { name: "假CLI", description: "本地假程序产物", installCount: 7, ratingAverage: 4.5, envRequired: ["K"], owner: "stub" } });
  const fake = makeFakeNpx(cliPayload);
  const rA = await withPath([fake.dir, SYS32], () => mod.viewLobeHubMcp("io.github/fakecli", { cache, timeoutMs: 30000 }));
  const argv = fs.existsSync(fake.outFile) ? JSON.parse(fs.readFileSync(fake.outFile, "utf8")) : null;
  check("真 runCli 通路：CLI 包名与参数面没被改坏（假 npx 实收 argv）",
    Array.isArray(argv) && argv[0] === "-y" && argv[1] === "@lobehub/market-cli" &&
    argv.slice(2).join(" ") === "mcp view io.github/fakecli --output json", JSON.stringify(argv));
  check("真通路字段映射（CLI stdout 前导噪声容忍：从第一个 { 起截）",
    rA.name === "假CLI" && rA.installs === 7 && rA.rating === 4.5 && rA.detailSource === "lobehub-cli" &&
    rA.envRequired.join() === "K" && rA.owner === "stub", JSON.stringify(rA));
  check("真通路写缓存恰一次且键形正确",
    puts.length === 1 && puts[0][0] === "lobehub_mcp_view:io.github/fakecli", JSON.stringify(puts.map((x) => x[0])));
  const fakeFail = makeFakeNpx("");
  fs.writeFileSync(path.join(fakeFail.dir, "npx.cmd"), "@echo off" + CR + NL + "exit /b 1" + CR + NL, "utf8");
  const fetchCalls = [];
  const manifestBody = MANIFEST_FIXTURE;
  const rB = await withPath([fakeFail.dir, SYS32], () => withFetch(async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, json: async () => manifestBody, text: async () => JSON.stringify(manifestBody) };
  }, () => mod.viewLobeHubMcp("lobehub:io.github.viafetch", { timeoutMs: 30000 })));
  check("CLI 失败 → manifest 回退真跑：detailSource=lobehub-manifest 且 note 说明降级",
    rB.detailSource === "lobehub-manifest" && rB.note.indexOf("CLI view 不可用") === 0, JSON.stringify(rB.note));
  check("manifest 通路确实经 fetch 桩（URL 是 manifest 端点，lobehub: 前缀被剥掉）",
    fetchCalls.length === 1 && fetchCalls[0] === "https://market.lobehub.com/api/v1/plugins/io.github.viafetch/manifest",
    JSON.stringify(fetchCalls));
  check("manifest 字段经 definitionFromManifest 真映射（title→name、必需变量占位、描述）",
    rB.name === "12306 车票查询" && rB.description === "搜索中国铁路余票" && rB.envRequired.join() === "NOTION_TOKEN",
    JSON.stringify([rB.name, rB.description, rB.envRequired]));
  const emptyBin = path.join(ROOT, "emptybin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const hitKey = "lobehub_mcp_view:" + "io.github/cached-real";
  const cache3 = { get: async (k) => (k === hitKey ? { identifier: "io.github.cached-real", detailSource: "cache-hit" } : null), put: async () => {} };
  const rC = await withPath([emptyBin], () => mod.viewLobeHubMcp("IO.GitHub/Cached-Real", { cache: cache3 }));
  check("真模块缓存命中零 I/O（PATH 里没有 npx 也能返回；大小写 id 命中同一键）",
    rC.detailSource === "cache-hit", JSON.stringify(rC));
});

// ---------------------------------------------------------------- 反证执行器
// 每条反证同时跑两遍同一条判据：源码原文（必须为真，证明探针忠实镜像了 Test 1-7 里那条判据）
// 与内存变异后的源码（必须为假，证明改坏那一行确实会让对应判据红）。
// 变异只在字符串上做，绝不写回 src/。needleOk 证明变异针落对了行——落错行的变异会让
// 变异体等价于原文，那样 mutated=true，反证当场红，不会伪装成「已证明」。
const counterproof = async (label, judgment, cleanBuild, mutBuild, probe, needleOk) => {
  const landed = needleOk ? !!needleOk() : true;
  let c = null, m = null;
  try { c = cleanBuild(); } catch (e) { c = null; }
  try { m = mutBuild(); } catch (e) { m = null; }
  let cleanResult = null, mutResult = null;
  if (c) { try { cleanResult = await probe(c); } catch (e) { cleanResult = "throw:" + String((e && e.message) || e).slice(0, 60); } }
  if (m) { try { mutResult = await probe(m); } catch (e) { mutResult = "throw:" + String((e && e.message) || e).slice(0, 60); } }
  check("反证[" + label + "] " + judgment,
    landed && cleanResult === true && mutResult === false,
    "needle=" + landed + " clean=" + cleanResult + " mutated=" + mutResult);
};

// ================================================================ Test 8: 反证 registryCatalogueCacheKey
await block("Test 8: 反证 —— registryCatalogueCacheKey 的五个变异（对应 Test 1 的判据逐条会红）", async () => {
  const clean = () => regKeyCore(REG_SRC);
  await counterproof("src/mcp-registry.js:230", "键形态判据红（丢掉 cat: 段=目录缓存与全量缓存同键，筛选页读到上一页累积目录）",
    clean, () => regKeyCore(mutateLine(REG_SRC, 230, (l) => l.replace(":cat:", ":"))),
    (f) => f("Chrome", 24, "Developer Tools") === "registry:v3:cat:chrome:developer tools:24",
    () => lineAt(REG_SRC, 230).indexOf(":cat:") >= 0);
  await counterproof("src/mcp-registry.js:230", "query 归一判据红（漏掉 query 小写=同一页两个键，翻页各存一份）",
    clean, () => regKeyCore(mutateLine(REG_SRC, 230, (l) => l.replace(").trim().toLowerCase() || ", ").trim() || "))),
    (f) => f("  ChRoMe ", 24, "developer tools") === f("chrome", 24, "developer tools"),
    () => lineAt(REG_SRC, 230).indexOf(").trim().toLowerCase() || ") >= 0);
  await counterproof("src/mcp-registry.js:230", "空 query 落 all 判据红（空串与 all 同键后，搜索页首访会命中分类页缓存）",
    clean, () => regKeyCore(mutateLine(REG_SRC, 230, (l) => l.replace(" || " + DQ + "all" + DQ, ""))),
    (f) => f("", 24, "") === "registry:v3:cat:all::24",
    () => lineAt(REG_SRC, 230).indexOf(" || " + DQ + "all" + DQ) >= 0);
  await counterproof("src/mcp-registry.js:229", "size 钳位判据红（钳位整体去掉后 -5 / 5000 原样入键，切片基准与键不一致）",
    clean, () => regKeyCore(mutateLine(REG_SRC, 229, (l) => l.replace("Math.max(1, Math.min(100, Number(pageSize) || REGISTRY_PAGE_SIZE));", "Number(pageSize) || REGISTRY_PAGE_SIZE;"))),
    (f) => f("x", -5) === "registry:v3:cat:x::1" && f("x", 5000) === "registry:v3:cat:x::100",
    () => lineAt(REG_SRC, 229).indexOf("Math.max(1, Math.min(100,") >= 0);
  await counterproof("src/mcp-registry.js:229", "pageSize 回落判据红（去掉 || REGISTRY_PAGE_SIZE 后 0/NaN 直接进键，读缓存永远 miss）",
    clean, () => regKeyCore(mutateLine(REG_SRC, 229, (l) => l.replace(" || REGISTRY_PAGE_SIZE", ""))),
    (f) => f("x", 0) === "registry:v3:cat:x::24" && f("x", "abc") === "registry:v3:cat:x::24",
    () => lineAt(REG_SRC, 229).indexOf(" || REGISTRY_PAGE_SIZE") >= 0);
  await counterproof("src/mcp-registry.js:23", "键形态判据红（键里嵌的是源码 CACHE_VERSION：版本一抬必须换键，写死版本=旧结构的缓存被当成新结构续用）",
    clean, () => regKeyCore(REG_SRC.split(NL).map((l) => (l.indexOf("const CACHE_VERSION =") >= 0 ? "const CACHE_VERSION = " + DQ + "v9" + DQ + ";" : l)).join(NL)),
    (f) => f("chrome", 24, "") === "registry:v3:cat:chrome::24",
    () => REG_SRC.split(NL).some((l) => l.indexOf("const CACHE_VERSION = " + DQ + "v3" + DQ) >= 0));
});

// ================================================================ Test 9: 反证 fallbackCards
await block("Test 9: 反证 —— fallbackCards 的五个变异（对应 Test 2 的判据逐条会红）", async () => {
  const rows = fallbackRows(REG_SRC);
  const clean = () => { const f = fallbackCore(stripExports(REG_SRC)); return f && ((q) => f(rows)(q)); };
  const mut = (n, nd, rep) => () => {
    const f = fallbackCore(mutateLine(stripExports(REG_SRC), n, (l) => l.replace(nd, rep)));
    return f && ((q) => f(rows)(q));
  };
  await counterproof("src/mcp-registry.js:320", "空 query 全量判据红（漏掉 !q 的取反后 index.js:237 的分类首屏拿到空列表）",
    clean, mut(320, "!q ||", "q &&"),
    (g) => g("").length === rows.length && g().length === rows.length,
    () => lineAt(REG_SRC, 320).indexOf("!q ||") >= 0);
  await counterproof("src/mcp-registry.js:320", "只命中描述也算命中判据红（匹配面缩到只剩 name，搜「结构检查」的用户看不到那张卡）",
    clean, mut(320, DOLLAR + "{entry.description}", ""),
    (g) => { const s = g("结构检查"); return s.length === 1 && s[0].slug === "io.github.arifulislamat/database-mcp-sqlite"; },
    () => lineAt(REG_SRC, 320).indexOf(DOLLAR + "{entry.description}") >= 0);
  await counterproof("src/mcp-registry.js:320", "query 归一判据红（去掉 toLowerCase，面板大写查询直接筛空）",
    clean, mut(320, BT + ".toLowerCase().includes(q)", BT + ".includes(q)"),
    (g) => { const h = g("CHROME devtools"); return h.length === 1 && h[0].slug === "io.github.Async23/chrome-devtools-mcp"; },
    () => lineAt(REG_SRC, 320).indexOf(BT + ".toLowerCase().includes(q)") >= 0);
  await counterproof("src/mcp-registry.js:324", "字段自洽判据红（name 不再是 slug 末段，面板标题与安装命令对不上）",
    clean, mut(324, "entry.name.split(" + DQ + "/" + DQ + ").pop()", "entry.name"),
    (g) => g().every((c) => c.name === c.slug.split("/").pop()),
    () => lineAt(REG_SRC, 324).indexOf("entry.name.split(") >= 0);
  await counterproof("src/mcp-registry.js:333", "可安装判据红（installable 翻假，兜底卡从「可安装」退化成只能看的死条目）",
    clean, mut(333, "installable: true", "installable: false"),
    (g) => g().every((c) => c.installable === true),
    () => lineAt(REG_SRC, 333).indexOf("installable: true") >= 0);
  await counterproof("src/mcp-registry.js:326", "不编造上游数字判据红（兜底清单没有分类，硬塞 category 后面板会把它当真实分类筛选面）",
    clean, mut(326, "category: " + DQ + DQ, "category: " + DQ + "developer-tools" + DQ),
    (g) => g().every((c) => c.category === ""),
    () => lineAt(REG_SRC, 326).indexOf("category: " + DQ + DQ) >= 0);
});

// ================================================================ Test 10: 反证 lobehubRegistered
await block("Test 10: 反证 —— lobehubRegistered 的四个变异（对应 Test 3 的判据逐条会红）", async () => {
  const homeYes = path.join(ROOT, "cp-yes");
  const homeNo = path.join(ROOT, "cp-no");
  fs.mkdirSync(path.join(homeYes, ".lobehub-market"), { recursive: true });
  fs.mkdirSync(homeNo, { recursive: true });
  fs.writeFileSync(path.join(homeYes, ".lobehub-market", "credentials.json"), "{" + "}", "utf8");
  const regCore = (mutate) => {
    let src = stripExports(LOB_SRC);
    if (mutate) src = mutate(src);
    const parts = ["lobehubCredentialsPath", "lobehubRegistered"].map((n) => sliceFn(src, n));
    if (parts.some((x) => !x)) return null;
    return (homedirFn) => new Function("join", "homedir", "existsSync", parts.join(NL + NL) + NL + "return lobehubRegistered;")(
      path.join, homedirFn, fs.existsSync);
  };
  const clean = () => regCore(null);
  const mutAt = (n, nd, rep) => () => regCore((s) => mutateLine(s, n, (l) => l.replace(nd, rep)));
  await counterproof("src/lobehub-market.js:26", "有凭证 → true 判据红（目录名改一个字=谓词永远读到不存在的路径，已注册用户被反复提示注册）",
    clean, mutAt(26, DQ + ".lobehub-market" + DQ, DQ + ".lobehub-market-x" + DQ),
    (f) => f(() => homeYes)() === true,
    () => lineAt(LOB_SRC, 26).indexOf(DQ + ".lobehub-market" + DQ) >= 0);
  await counterproof("src/lobehub-market.js:26", "同上判据红（文件名 credential.json 少个 s，同一后果）",
    clean, mutAt(26, DQ + "credentials.json" + DQ, DQ + "credential.json" + DQ),
    (f) => f(() => homeYes)() === true,
    () => lineAt(LOB_SRC, 26).indexOf(DQ + "credentials.json" + DQ) >= 0);
  await counterproof("src/lobehub-market.js:31", "无凭证 → false 判据红（谓词硬编码 true，首装用户看到「已注册」，注册入口从此消失）",
    clean, mutAt(31, "return existsSync(lobehubCredentialsPath());", "return true;"),
    (f) => f(() => homeNo)() === false,
    () => lineAt(LOB_SRC, 31).indexOf("return existsSync(lobehubCredentialsPath());") >= 0);
  await counterproof("src/lobehub-market.js:30+32", "try/catch 结构判据红（homedir 抛错时必须回落 false；去掉 catch 会把 index.js:156 的 registerHint 拖崩）",
    clean, () => {
      const s = mutateLine(mutateLine(stripExports(LOB_SRC), 30, (l) => l.replace("try {", "if (true) {")),
        32, (l) => l.replace("} catch {", "} else {"));
      const parts = ["lobehubCredentialsPath", "lobehubRegistered"].map((n) => sliceFn(s, n));
      if (parts.some((x) => !x)) return null;
      return (homedirFn) => new Function("join", "homedir", "existsSync", parts.join(NL + NL) + NL + "return lobehubRegistered;")(
        path.join, homedirFn, fs.existsSync);
    },
    (f) => {
      try { return f(() => { throw new Error("homedir unavailable"); })() === false; } catch (e) { return false; }
    },
    () => lineAt(LOB_SRC, 30).indexOf("try {") >= 0 && lineAt(LOB_SRC, 32).indexOf("} catch {") >= 0);
});

// ================================================================ Test 11: 反证 setUserEnvironmentVariable
await block("Test 11: 反证 —— setUserEnvironmentVariable 的六个变异（对应 Test 4/5 的判据逐条会红）", async () => {
  const clean = () => envCore(null);
  const mutAt = (n, nd, rep) => () => envCore((s) => mutateLine(s, n, (l) => l.replace(nd, rep)));
  const winRun = (fac, value, name) => {
    const calls = [];
    const spawn = (f, a, o) => { calls.push({ f, a, o }); return { status: 0, stdout: "", stderr: "" }; };
    let err = null, ret = null;
    withPlatform("win32", () => { try { ret = fac(spawn).setUserEnvironmentVariable(name, value); } catch (e) { err = e; } });
    const env = process.env[name];
    delete process.env[name];
    return { err, ret, calls, env };
  };
  await counterproof("src/env.js:26", "非法变量名被拒判据红（正则去掉 ^ 锚点后 HAS SPACE/1BAD 都能进 spawnSync，空格名会拆坏 PowerShell 参数）",
    clean, mutAt(26, "/^[A-Za-z_]", "/[A-Za-z_]"),
    (fac) => {
      const r = winRun(fac, "v1", "1BAD");
      return !!r.err && String(r.err.message).indexOf("非法的环境变量名") >= 0 && r.calls.length === 0;
    },
    () => lineAt(ENV_SRC, 26).indexOf("/^[A-Za-z_]") >= 0);
  await counterproof("src/env.js:27", "值闸判据红（漏掉 value === 空串 检查后，空值会被写进用户环境变量再报「已写入」）",
    clean, mutAt(27, " || value === " + DQ + DQ, ""),
    (fac) => {
      const r = winRun(fac, "", "LH_T181_CP");
      return !!r.err && String(r.err.message).indexOf("值不能为空") >= 0 && r.calls.length === 0;
    },
    () => lineAt(ENV_SRC, 27).indexOf(" || value === " + DQ + DQ) >= 0);
  await counterproof("src/env.js:6", "单引号翻倍判据红（quotePowerShell 不转义后，值里的引号逃出字面量，可拼进第二个 SetEnvironmentVariable 参数）",
    clean, mutAt(6, DQ + SQ + SQ + DQ, DQ + DQ),
    (fac) => {
      const r = winRun(fac, "it" + SQ + "s", "LH_T181_CP");
      return !r.err && r.calls.length === 1 &&
        r.calls[0].a[3] === "[Environment]::SetEnvironmentVariable(" + SQ + "LH_T181_CP" + SQ + "," + SQ + "it" + SQ + SQ + "s" + SQ + "," + SQ + "User" + SQ + ")";
    },
    () => lineAt(ENV_SRC, 6).indexOf(DQ + SQ + SQ + DQ) >= 0);
  await counterproof("src/env.js:40", "非零退出必抛判据红（status 闸一失效，写失败也返回 ok:true，面板对用户说谎）",
    clean, mutAt(40, "if (result.status !== 0) {", "if (false) {"),
    (fac) => {
      const spawn = () => ({ status: 1, stdout: "", stderr: "boom" });
      let t = false;
      withPlatform("win32", () => {
        try { fac(spawn).setUserEnvironmentVariable("LH_T181_CP", "v"); } catch (e) { t = String(e.message).indexOf("写入系统环境变量失败") >= 0 && String(e.message).indexOf("boom") >= 0; }
      });
      delete process.env.LH_T181_CP;
      return t;
    },
    () => lineAt(ENV_SRC, 40).indexOf("if (result.status !== 0) {") >= 0);
  await counterproof("src/env.js:52", "process.env 同步更新判据红（漏掉这一行，面板写完立刻读回旧值，提示是假的）",
    clean, mutAt(52, "process.env[name] = value;", "/* mutated */"),
    (fac) => { const r = winRun(fac, "it" + SQ + "s", "LH_T181_CP"); return !r.err && r.env === "it" + SQ + "s" && r.ret && r.ret.ok === true; },
    () => lineAt(ENV_SRC, 52).indexOf("process.env[name] = value;") >= 0);
  await counterproof("src/env.js:44", "posix 写入行判据红（不经 buildPosixExportLine 追加的是未加引号的 export NAME=value，含空格/引号的值会改写 shell 配置）",
    clean, mutAt(44, "buildPosixExportLine(name, value)", "name + " + DQ + "=" + DQ + " + value"),
    (fac) => {
      const calls = [];
      const spawn = (f, a, o) => { calls.push({ f, a, o }); return { status: 0, stdout: "", stderr: "" }; };
      let err = null;
      withPlatform("linux", () => { try { fac(spawn).setUserEnvironmentVariable("LH_T181_CPX", "it" + SQ + "s"); } catch (e) { err = e; } });
      delete process.env.LH_T181_CPX;
      return !err && calls.length === 1 && calls[0].f === "sh" &&
        calls[0].a[1].indexOf(JSON.stringify("export LH_T181_CPX=" + SQ + "it" + SQ + BS + SQ + SQ + "s" + SQ)) >= 0;
    },
    () => lineAt(ENV_SRC, 44).indexOf("buildPosixExportLine(name, value)") >= 0);
  await counterproof("src/env.js:49", "posix 非零退出必抛判据红（.profile 只读时静默返回 ok，用户按提示重启 shell 后端不到变量）",
    clean, mutAt(49, "if (result.status !== 0) throw", "if (false) throw"),
    (fac) => {
      const spawn = () => ({ status: 1, stdout: "", stderr: "read-only fs" });
      let t = false;
      withPlatform("linux", () => {
        try { fac(spawn).setUserEnvironmentVariable("LH_T181_CPX", "v"); } catch (e) { t = String(e.message).indexOf("写入 shell 配置失败") >= 0 && String(e.message).indexOf("read-only fs") >= 0; }
      });
      delete process.env.LH_T181_CPX;
      return t;
    },
    () => lineAt(ENV_SRC, 49).indexOf("if (result.status !== 0) throw") >= 0);
});

// ================================================================ Test 12: 反证 viewLobeHubMcp
await block("Test 12: 反证 —— viewLobeHubMcp 的六个变异（对应 Test 6 的判据逐条会红）", async () => {
  const cliJson = JSON.stringify({ data: { name: "酷工具", description: "很酷", ratingAverage: 4.2, installCount: 1789, envRequired: ["API_KEY"], envHints: { K: "v" }, homepage: "https://x.example/", owner: "acme" } });
  const okCli = () => async () => cliJson;
  const boomManifest = async () => { throw new Error("manifest 不该被调用"); };
  // counterproof 拿到的 c/m 是「注入工厂」：探针自己决定给 viewLobeHubMcp 喂哪套 deps。
  const clean = () => viewCore(null);
  const mutAt = (n, nd, rep) => () => viewCore((x) => mutateLine(x, n, (l) => l.replace(nd, rep)));
  await counterproof("src/lobehub-market.js:250", "缓存键大小写判据红（去掉 toLowerCase 后 IO.GitHub/x 与 io.github/x 各存一份，命中不了的那次要去打 CLI）",
    clean, mutAt(250, ").toLowerCase()", ")"),
    async (core) => {
      const hit = { detailSource: "cache" };
      const keys = [];
      const cache = { get: async (k) => { keys.push(k); return k === "lobehub_mcp_view:io.github/cp" ? hit : null; }, put: async () => {} };
      const r = await core({ runCli: okCli(), lobehubManifestDefinition: boomManifest })("IO.GitHub/CP", { cache });
      return keys.length === 1 && keys[0] === "lobehub_mcp_view:io.github/cp" && r === hit;
    },
    () => lineAt(LOB_SRC, 250).indexOf(").toLowerCase()") >= 0);
  await counterproof("src/lobehub-market.js:258", "parsed.data 缺失回落判据红（只认 parsed.data 后，CLI 直吐外层形状时取不到任何字段）",
    clean, mutAt(258, "parsed.data || parsed", "parsed.data"),
    async (core) => {
      const f = core({ runCli: async () => JSON.stringify({ name: "顶层即数据", description: "d" }), lobehubManifestDefinition: boomManifest });
      try { const r = await f("io.github/top", {}); return r.name === "顶层即数据" && r.detailSource === "lobehub-cli"; } catch (e) { return false; }
    },
    () => lineAt(LOB_SRC, 258).indexOf("parsed.data || parsed") >= 0);
  await counterproof("src/lobehub-market.js:266", "installs 不编造判据红（?? null 改 0 后，上游没给安装量也显示「1789→0 次安装」，卡片数字失真）",
    clean, mutAt(266, "data.installCount ?? null", "data.installCount ?? 0"),
    async (core) => {
      const f = core({ runCli: async () => JSON.stringify({ data: { name: "n" } }), lobehubManifestDefinition: boomManifest });
      const r = await f("io.github/empty", {});
      return r.installs === null && r.rating === null;
    },
    () => lineAt(LOB_SRC, 266).indexOf("data.installCount ?? null") >= 0);
  await counterproof("src/lobehub-market.js:267", "envRequired 形状判据红（不做 Array.isArray 兜底，上游给字符串会被面板 when 成逐字符列表）",
    clean, mutAt(267, "Array.isArray(data.envRequired) ? data.envRequired : []", "data.envRequired || []"),
    async (core) => {
      const f = core({ runCli: async () => JSON.stringify({ data: { name: "n", envRequired: "API_KEY" } }), lobehubManifestDefinition: boomManifest });
      const r = await f("io.github/bad", {});
      return Array.isArray(r.envRequired) && r.envRequired.length === 0;
    },
    () => lineAt(LOB_SRC, 267).indexOf("Array.isArray(data.envRequired)") >= 0);
  await counterproof("src/lobehub-market.js:273", "成功后写缓存判据红（漏掉 put，detail 页每次都重新拉 CLI，翻页打爆子进程）",
    clean, mutAt(273, "if (cache) await cache.put(key, out);", "/* mutated */"),
    async (core) => {
      const puts = [];
      const f = core({ runCli: okCli(), lobehubManifestDefinition: boomManifest });
      await f("io.github/cool", { cache: { get: async () => null, put: async (k, v) => { puts.push([k, v]); } } });
      return puts.length === 1 && puts[0][0] === "lobehub_mcp_view:io.github/cool";
    },
    () => lineAt(LOB_SRC, 273).indexOf("if (cache) await cache.put(key, out);") >= 0);
  await counterproof("src/lobehub-market.js:289", "回退分支自证判据红（detailSource 写成 lobehub-cli，面板把降级结果当权威详情展示）",
    clean, mutAt(289, "detailSource: " + DQ + "lobehub-manifest" + DQ, "detailSource: " + DQ + "lobehub-cli" + DQ),
    async (core) => {
      const f = core({ runCli: async () => { throw new Error("cli down"); }, lobehubManifestDefinition: async () => ({ title: "兜底", description: "d", envRequired: [], envHints: {}, owner: "" }) });
      const r = await f("io.github/broken", {});
      return r.detailSource === "lobehub-manifest" && r.note.indexOf("CLI view 不可用") === 0;
    },
    () => lineAt(LOB_SRC, 289).indexOf("detailSource: " + DQ + "lobehub-manifest" + DQ) >= 0);
});


// ================================================================ Test 13: 挂链与登记
await block("Test 13: 挂链与登记（package.json test:chain + test-dead-exports.mjs 映射表 + modelscope 死 skip 清零）", async () => {
  const pkg = JSON.parse(readRepo("package.json"));
  const chain = String((pkg.scripts && pkg.scripts["test:chain"]) || "");
  const segs = chain.split(" && ");
  check("本套件已挂进 scripts[test:chain] 链尾（run-gate 只认这条链）",
    segs[segs.length - 1].indexOf("node test/test-unjudged-exports.mjs") >= 0, segs[segs.length - 1]);
  check("注册恰一次（重复挂链=同一段跑两遍，链长虚高）",
    segs.filter((s) => s.indexOf("test-unjudged-exports.mjs") >= 0).length === 1, segs.length);
  check("段名可被 run-gate 的正解出（/node test/([\w.-]+.mjs)/）",
    (function () { const re = new RegExp("node test/([A-Za-z0-9._-]+[.]mjs)", "g"); let m, hit = false; while ((m = re.exec(chain))) { if (m[1] === "test-unjudged-exports.mjs") hit = true; } return hit; })(),
    "run-gate 取不到段名");
  check("package.json version 仍是 0.5.180（本任务书严禁改版本）", pkg.version === "0.5.180", pkg.version);
  const dead = readRepo("test/test-dead-exports.mjs");
  const five = ["setUserEnvironmentVariable", "registryCatalogueCacheKey", "fallbackCards", "lobehubRegistered", "viewLobeHubMcp"];
  check("test-dead-exports.mjs 登记了这五个导出（两条都成立：有调用方 + 有判据）",
    five.every((n) => dead.indexOf(n) >= 0), five.filter((n) => dead.indexOf(n) < 0).join(","));
  check("test-dead-exports.mjs 的登记表指向本套件（判据在哪一段，写在表里）",
    dead.indexOf("test-unjudged-exports.mjs") >= 0, "未指向本套件");
  const ms = readRepo("test/test-modelscope-category-vocab.mjs");
  const deadGuards = ["词表本体判据", "归一函数判据", "chip 装配判据", "真过滤判据", "聚合层判据", "缓存键判据", "表外拒发判据"];
  check("modelscope 七条死 skip 已全部翻硬（skip( 里再出现这些名字=静音回归）",
    deadGuards.every((n) => ms.indexOf("skip(" + DQ + n) < 0), deadGuards.filter((n) => ms.indexOf("skip(" + DQ + n) >= 0).join(","));
  check("MISSING_EXPORTS 静音通道已删除（数组、push、待补输出、skip 实参四种代码形态都不在）",
    ms.indexOf("const MISSING_EXPORTS") < 0 && ms.indexOf("MISSING_EXPORTS.push") < 0 &&
    ms.indexOf("待补：") < 0 && !/skip\([^[)]*MISSING_EXPORTS/.test(ms),
    "代码里仍引用 MISSING_EXPORTS");
  check("两条合法 DSH_MS*_LIVE 门控 skip 原样保留（CI 门不联网，不得被翻成真跑）",
    ms.indexOf("DSH_MS164_LIVE") >= 0 && ms.indexOf("DSH_MS165_LIVE") >= 0, "门控丢失");
});

cleanup();
console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
