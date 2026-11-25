// 子进程环境根因守卫（childEnv）套件。
// 根因：Windows 下嵌套 spawn/execFile 若不显式传 env（含 SystemDrive），孙进程里 %SystemDrive%
// 不展开，会在当前工作目录下造出字面量名为 %SystemDrive% 的整棵缓存树（0.5.161 / 0.5.163 两次回归同根因）。
// 本套件两用职责：
//   1) 真跑 src/home.js 导出的 childEnv（不复制实现），断言只补缺、绝不覆盖调用方显式给出的键；
//   2) 静态锁 findBareChildCalls（纯函数，可喂假源码自证）：扫 package.json files 白名单里的 js，
//      断言「不带 env 的子进程调用数 === 0」。「裸调用」这一类是 PR#1 Test 14 的盲区（它只锁显式写了
//      env:{...} 的调用），本套件补上这一类，且不得削弱 PR#1 判据。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const W = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BQ = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const DL = String.fromCharCode(36);
const LCB = String.fromCharCode(123);
const RCB = String.fromCharCode(125);
const NL = String.fromCharCode(10);

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok " + name); return; }
  failed++;
  console.log("  FAIL " + name + (detail ? " :: " + detail : ""));
}
function skip(name, why) {
  skipped++;
  console.log("  SKIP " + name + " :: " + why);
}
function readSrc(rel) {
  return readFileSync(join(W, rel), "utf8");
}

// ------------------------------------------------------------ 静态锁本体（纯函数）
// 抹掉注释与字面量文本（保留换行以对齐行号）。正则字面量按前一个有效字符判定是除号还是正则：
// 否则会像 src/env.js 的 replace(/x/g, ...) 那样把整段后文当字符串起点抹掉，导致漏报（假绿）。
// 模板字面量 ${...} 内的代码仍参与扫描：藏在字符串里的裸调用照样抓到，注释里的不误报。
const REGEX_OK_BEFORE = "(,=:[!&|?{};+-*%~^<>";
function prevMeaningful(chars, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = chars[j];
    if (c === " " || c === BS + "t" || c === BS + "n") continue;
    if (c === "\t" || c === "\n" || c === "\r" || c === " ") continue;
    return c;
  }
  return "";
}
function maskLiterals(source) {
  const src = String(source);
  const out = src.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(src.length, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] !== "*" && src[i + 1] !== "/") {
      const p = prevMeaningful(out, i);
      if (p === "" || REGEX_OK_BEFORE.indexOf(p) >= 0) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          const d = src[j];
          if (d === BS) { j += 2; continue; }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) { j++; break; }
          else if (d === "\n") break;
          j++;
        }
        blank(i, Math.min(src.length, j));
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (c === DQ || c === SQ) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === BS) j++; j++; }
      blank(i, Math.min(src.length, j + 1));
      i = j + 1;
      continue;
    }
    if (c === BQ) {
      let j = i + 1;
      const keep = [];
      while (j < src.length && src[j] !== BQ) {
        if (src[j] === BS) { j += 2; continue; }
        if (src[j] === DL && src[j + 1] === LCB) {
          let d = 1;
          let k = j + 2;
          while (k < src.length && d > 0) { if (src[k] === LCB) d++; else if (src[k] === RCB) d--; k++; }
          keep.push([j, k]);
          j = k;
          continue;
        }
        j++;
      }
      let cursor = i;
      for (const seg of keep) { blank(cursor, seg[0]); cursor = seg[1]; }
      blank(cursor, Math.min(src.length, j + 1));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}
function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")") { d--; if (d === 0) return i; }
  }
  return -1;
}
function splitTop(args) {
  const parts = [];
  let d = 0;
  let cur = "";
  for (const c of args) {
    if (c === "(" || c === "[" || c === LCB) d++;
    else if (c === ")" || c === "]" || c === RCB) d--;
    if (c === "," && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
function hasEnvOption(objText) {
  return /(^|[{,\s])env\s*:/.test(objText) || /(^|,)\s*env\s*[,}]/.test(objText);
}
const CHILD_APIS = ["execFileSync", "execFile", "execSync", "spawnSync", "spawn", "fork", "exec"];
const API_RE = new RegExp("(?:^|[^\\w$.])(" + CHILD_APIS.join("|") + ")\\s*\\(", "g");
export function findBareChildCalls(source, file) {
  const masked = maskLiterals(source);
  const rawLines = String(source).split(/\r?\n/);
  const hits = [];
  let m;
  API_RE.lastIndex = 0;
  while ((m = API_RE.exec(masked))) {
    const idx = m.index + m[0].indexOf(m[1]);
    const open = masked.indexOf("(", idx);
    if (open < 0) continue;
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const args = splitTop(masked.slice(open + 1, close));
    const opt = args.map((a) => a.trim()).find((a) => a.charAt(0) === LCB);
    const line = masked.slice(0, idx).split(NL).length;
    if (opt === undefined || !hasEnvOption(opt)) {
      hits.push({ file: String(file), line: line, api: m[1], code: (rawLines[line - 1] || "").trim().slice(0, 110) });
    }
  }
  return hits;
}


// ------------------------------------------------------------ childEnv 契约（真跑实现）
const home = await import(pathToFileURL(join(W, "src", "home.js")).href + "?suite=child-env");
const childEnv = home.childEnv;
check("src/home.js 导出 childEnv 函数", typeof childEnv === "function", "typeof=" + typeof childEnv);

const ENV_DEFAULTS = ["SystemDrive", "SystemRoot", "ComSpec", "UserProfile", "ProgramData", "AppData", "LocalAppData"];
// 注入式假环境：childEnv(extra, baseEnv) 的第二参就是为可单测而留的输入缝（缺省仍取 process.env）。
function win(partial) {
  return Object.assign({
    SystemRoot: "C:" + BS + "Windows",
    ComSpec: "C:" + BS + "Windows" + BS + "system32" + BS + "cmd.exe",
    UserProfile: "C:" + BS + "Users" + BS + "tester",
    ProgramData: "C:" + BS + "ProgramData",
    TEMP: "C:" + BS + "Users" + BS + "tester" + BS + "AppData" + BS + "Local" + BS + "Temp",
  }, partial || {});
}
let platformGuard = false;
function withPlatform(value, fn) {
  const d = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: value, configurable: true, writable: false });
  try {
    return fn();
  } finally {
    delete process.platform;
    if (d) Object.defineProperty(process, "platform", d);
    platformGuard = process.platform === d.value;
  }
}
if (typeof childEnv === "function") {
  const HD = homedir();
  const HDDrive = /^[A-Za-z]:/.test(HD) ? HD.slice(0, 2) : "C:";

  // 1) 非 win32 直通
  const lin = withPlatform("linux", () => childEnv({ FOO: "bar" }, { PATH: "/usr/bin", SystemDrive: "D:" }));
  check("非 win32 返回 {...base, ...extra} 原样形状", lin.PATH === "/usr/bin" && lin.FOO === "bar" && lin.SystemDrive === "D:", JSON.stringify(lin));
  const linKeeps = Object.keys(lin).length === 3;
  check("非 win32 不补任何 Windows 键", linKeeps, "keys=" + Object.keys(lin).join(","));

  // 2) win32 只补缺：缺失的 SystemDrive 由 SystemRoot 取盘符。
  //    回落类断言（下面三条 UserProfile/AppData/LocalAppData）必须发生在「base 本就没有该键」的
  //    输入上——win() 默认带 UserProfile，若只删 SystemDrive 就等于要求 childEnv 覆盖调用方给出
  //    的键，与第 3 段 L235 的「绝不覆盖」直接矛盾。故这里同时删掉 UserProfile，让「补齐」与
  //    「回落」各自测各自的输入；「显式给出的键不被覆盖」由第 3 段专门守。
  const noDrive = win({});
  delete noDrive.SystemDrive;
  delete noDrive.UserProfile;
  const filled = withPlatform("win32", () => childEnv({}, noDrive));
  check("win32 缺 SystemDrive 时由 SystemRoot 派生盘符", filled.SystemDrive === "C:", "got=" + filled.SystemDrive);
  check("win32 补缺不改动 base 里已有的键", filled.SystemRoot === noDrive.SystemRoot && filled.ComSpec === noDrive.ComSpec && filled.TEMP === noDrive.TEMP, "");
  check("win32 补齐七项 Windows 键", ENV_DEFAULTS.every((k) => typeof filled[k] === "string" && filled[k] !== ""), ENV_DEFAULTS.filter((k) => !filled[k]).join(","));
  check("ComSpec 落在 SystemRoot 下", filled.ComSpec === filled.SystemRoot + BS + "system32" + BS + "cmd.exe", "got=" + filled.ComSpec);
  check("ProgramData 按盘符拼装", filled.ProgramData === filled.SystemDrive + BS + "ProgramData", "got=" + filled.ProgramData);
  check("UserProfile 回落 os.homedir()", filled.UserProfile === HD, "got=" + filled.UserProfile + " want=" + HD);
  check("AppData 由 UserProfile 派生", filled.AppData === HD + BS + "AppData" + BS + "Roaming", "got=" + filled.AppData);
  check("LocalAppData 由 UserProfile 派生", filled.LocalAppData === HD + BS + "AppData" + BS + "Local", "got=" + filled.LocalAppData);

  // 3) 只补缺、绝不覆盖调用方显式给出的键（extra 与 base 两个方向都要守住）
  const keepBase = withPlatform("win32", () => childEnv({}, win({ SystemDrive: "Q:", UserProfile: "Q:" + BS + "someone" })));
  check("base 显式给出的 SystemDrive 不被覆盖", keepBase.SystemDrive === "Q:", "got=" + keepBase.SystemDrive);
  check("base 显式给出的 UserProfile 不被覆盖", keepBase.UserProfile === "Q:" + BS + "someone", "got=" + keepBase.UserProfile);
  const viaExtra = withPlatform("win32", () => childEnv({ SystemDrive: "Z:", AppData: "Z:" + BS + "roaming-override" }, win({})));
  check("extra 显式给出的键原样保留", viaExtra.SystemDrive === "Z:" && viaExtra.AppData === "Z:" + BS + "roaming-override", JSON.stringify({ a: viaExtra.SystemDrive, b: viaExtra.AppData }));
  const dRoot = withPlatform("win32", () => childEnv({ SystemRoot: "D:" + BS + "Windows" }, (() => { const e = win({}); delete e.SystemDrive; return e; })()));
  check("extra 参与派生：extra 的 SystemRoot 决定补出的盘符", dRoot.SystemDrive === "D:", "got=" + dRoot.SystemDrive);
  check("extra 的键不会盖掉 base 里已存在的其它键", dRoot.ComSpec === win({}).ComSpec, "got=" + dRoot.ComSpec);
  const emptyMeans = withPlatform("win32", () => childEnv({}, win({ SystemDrive: "" })));
  check("空串视为缺失并被补齐", emptyMeans.SystemDrive === "C:", "got=" + JSON.stringify(emptyMeans.SystemDrive));
  const extraEmpty = withPlatform("win32", () => childEnv({ SystemDrive: "" }, win({})));
  check("extra 显式给空串也算调用方给出的值", extraEmpty.SystemDrive === "", "got=" + JSON.stringify(extraEmpty.SystemDrive));

  // 4) base 里 Windows 键全缺时的兜底（本进程 process.env 实测正是这种情况）
  const allMissing = withPlatform("win32", () => childEnv({}, { PATH: "x", TEMP: HD }));
  check("base 全缺时 SystemRoot 回落 homedir 盘符", typeof allMissing.SystemRoot === "string" && allMissing.SystemRoot.indexOf(HDDrive) === 0, "got=" + allMissing.SystemRoot);
  check("base 全缺时七项全部补齐", ENV_DEFAULTS.every((k) => typeof allMissing[k] === "string" && allMissing[k] !== ""), "");
  check("base 全缺时非 Windows 键照常透传", allMissing.PATH === "x" && allMissing.TEMP === HD, "");

  // 5) 纯度：返回新对象、不改 base、不写 process.env；缺省第二参取 process.env
  const baseCopy = win({});
  const beforeKeys = Object.keys(baseCopy).length;
  const returned = withPlatform("win32", () => childEnv({ EXTRA_ONLY: "1" }, baseCopy));
  check("childEnv 返回新对象而非 base 引用", returned !== baseCopy && Object.keys(returned).length > beforeKeys, "");
  check("childEnv 不修改传入 base", Object.keys(baseCopy).length === beforeKeys && baseCopy.SystemDrive === undefined, JSON.stringify(Object.keys(baseCopy)));
  const envBefore = Object.keys(process.env).length;
  withPlatform("win32", () => childEnv({ ONLY_EXTRA: "1" }));
  check("childEnv 不写 process.env", Object.keys(process.env).length === envBefore, envBefore + " -> " + Object.keys(process.env).length);
  check("childEnv 缺省第二参读 process.env", withPlatform("win32", () => childEnv({})) !== process.env, "");
  check("process.platform 已复原", platformGuard, "");

  // 6) 现场真跑：临时改写 process.env（删掉 SystemDrive）后走缺省入口，测后必须还原
  const savedSystemDrive = process.env.SystemDrive;
  const savedPlatformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  let live = null;
  try {
    delete process.env.SystemDrive;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: false });
    live = childEnv({});
  } finally {
    delete process.platform;
    if (savedPlatformDesc) Object.defineProperty(process, "platform", savedPlatformDesc);
    if (savedSystemDrive !== undefined) process.env.SystemDrive = savedSystemDrive;
  }
  check("真实 process.env 缺 SystemDrive 时被补出盘符", live !== null && /^[A-Za-z]:$/.test(String(live.SystemDrive)), "got=" + (live && live.SystemDrive));
  check("测后 process.env 已复原", (savedSystemDrive === undefined ? process.env.SystemDrive === undefined : process.env.SystemDrive === savedSystemDrive) && process.platform === (savedPlatformDesc && savedPlatformDesc.value), "platform=" + process.platform);
}

// ------------------------------------------------- 静态锁自证（喂假源码，不只读死仓库文件）
// 正向：假源码里的裸调用必须逐条命中；反向：同一份源码补上 env 后必须归零。
// 两向都跑，才能证明这条锁既不是假绿（漏报）也不是恒红（误报）。
const FAKE_LINES = [
  "// execFile(cmd, args); 注释里的调用不该被抓",
  "execFile(cmd, args, { timeout: 1 });",
  "execFile(cmd, args);",
  "spawn(child, args, { shell: false });",
  "spawnSync(SENTINEL, [1]);",
  "execFileSync(SENTINEL, [1], { timeout: 5 });",
  "const hidden = " + DQ + "execFile(a, b);" + DQ + ";",
  "execFile(file, argv, { timeout: 1, env: { A: 1 } }, cb);",
  "execFile(file, argv, { env: childEnv() }, cb);",
  "spawn(cmd, args, { env: process.env });",
  "execFile(",
  "  file,",
  "  args,",
  "  { timeout: 3 },",
  "  cb,",
  ");",
  "execFile(file, argv, { timeout: 3, env: childEnv(), }, cb);",
  "const t = " + BQ + DL + LCB + "spawn(x, y)" + RCB + BQ + ";",
  "fork(CHILD);",
];
const FAKE = FAKE_LINES.join(NL);
const fakeHits = findBareChildCalls(FAKE, "fake.js");
const fakeLines = fakeHits.map((h) => h.line);
const EXPECT_BARE = [2, 3, 4, 5, 6, 11, 18, 19];
check("假源码：裸调用逐条命中（含多行 options 与模板插值内的调用）", JSON.stringify(fakeLines) === JSON.stringify(EXPECT_BARE), "got=" + JSON.stringify(fakeLines) + " want=" + JSON.stringify(EXPECT_BARE));
check("假源码：注释里的调用不误报", fakeLines.indexOf(1) < 0, "lines=" + JSON.stringify(fakeLines));
check("假源码：字符串字面量里的调用不误报", fakeLines.indexOf(7) < 0, "lines=" + JSON.stringify(fakeLines));
check("假源码：已带 env 的调用不误报", [8, 9, 10, 17].every((n) => fakeLines.indexOf(n) < 0), "lines=" + JSON.stringify(fakeLines));
const FIXED_LINES = FAKE_LINES.map((l) => l
  .replace("execFile(cmd, args);", "execFile(cmd, args, " + LCB + " env: childEnv() " + RCB + ");")
  .replace("{ timeout: 1 }", "{ timeout: 1, env: childEnv() }")
  .replace("spawn(child, args, { shell: false })", "spawn(child, args, { shell: false, env: childEnv() })")
  .replace("spawnSync(SENTINEL, [1])", "spawnSync(SENTINEL, [1], { env: childEnv() })")
  .replace("execFileSync(SENTINEL, [1], { timeout: 5 })", "execFileSync(SENTINEL, [1], { timeout: 5, env: childEnv() })")
  .replace("  { timeout: 3 },", "  { timeout: 3, env: childEnv() },")
  .replace(DL + LCB + "spawn(x, y)" + RCB, DL + LCB + "spawn(x, y, { env: childEnv() })" + RCB)
  .replace("fork(CHILD)", "fork(CHILD, { env: childEnv() })"));
const fixedHits = findBareChildCalls(FIXED_LINES.join(NL), "fixed.js");
check("反向对照：同一份源码补齐 env 后归零（锁不恒红）", fixedHits.length === 0, fixedHits.map((h) => h.file + ":" + h.line).join(", "));
const bareOne = findBareChildCalls("execFile(file, args, { windowsHide: false }, done);", "single.js");
check("最小反证：单行裸 execFile 判红且报出行号与 API", bareOne.length === 1 && bareOne[0].line === 1 && bareOne[0].api === "execFile", JSON.stringify(bareOne));
check("空源码不炸（判 0 条）", findBareChildCalls("", "empty.js").length === 0, "");

// ------------------------------------------------- 真仓库扫描：不带 env 的子进程调用必须为 0
const pkg = JSON.parse(readSrc("package.json"));
// 展开 package.json 的 files 白名单：*.js 直接进，目录递归收 js，带通配符的按同目录名匹配。
const listed = [];
function walkJs(dir, rel) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) walkJs(join(dir, ent.name), r);
    else if (ent.name.endsWith(".js")) listed.push(r);
  }
}
for (const entry of pkg.files || []) {
  if (entry.includes("*")) continue;
  const abs = join(W, entry);
  if (!existsSync(abs)) continue;
  if (entry.endsWith(".js")) listed.push(entry);
  else if (statSync(abs).isDirectory()) walkJs(abs, entry);
}
check("package.json files 白名单里确有 js 可扫", listed.length > 0, "listed=" + listed.length);
// Boundary 外的既有裸调用：本任务只准改指定文件，这三处不可接线，显式登记为豁免；
// 条数一旦漂移同样判红，防止悄悄新增。
const GUARD_EXEMPT = {
  "src/env.js": 2,
  "src/github.js": 1,
};
const repoBare = [];
for (const rel of listed) for (const hit of findBareChildCalls(readSrc(rel), rel)) repoBare.push(hit);
const byFile = {};
for (const hit of repoBare) byFile[hit.file] = (byFile[hit.file] || 0) + 1;
check("真仓库：豁免清单之外的不带 env 子进程调用数 === 0", repoBare.filter((h) => GUARD_EXEMPT[h.file] === undefined).length === 0, Object.entries(byFile).map(([k, v]) => k + ":" + v).join(", "));
check("真仓库：豁免条数与实际逐条相符（新增/消失都要重新登记）", Object.keys(GUARD_EXEMPT).every((f) => byFile[f] === GUARD_EXEMPT[f]), Object.entries(byFile).map(([k, v]) => k + ":" + v).join(", "));

// ------------------------------------------------- 接线点：七处 ENV-MISS 必须走 childEnv
function anchorWindow(rel, anchor, span) {
  const ls = readSrc(rel).split(/\r?\n/);
  const at = ls.findIndex((l) => l.includes(anchor));
  if (at < 0) return null;
  return { line: at + 1, text: ls.slice(at, at + (span || 9)).join(" ") };
}
for (const [rel, anchor] of [
  ["index.js", "execFile(command, args,"],
  ["src/cli-install.js", "execFile(" + DQ + "curl" + DQ + ", curlArgs,"],
  ["src/extra-sources.js", "execFile(cmd[0], cmd.slice(1),"],
  ["src/http.js", "execFile(binary, [" + DQ + "-c" + DQ + ", probe],"],
  ["src/http.js", "const child = execFile(" + DQ + "curl.exe" + DQ + ", args,"],
  ["src/cli-install.js", "env: {"],
  ["src/sources.js", "execFile(cmd[0], cmd.slice(1),"],
]) {
  const w = anchorWindow(rel, anchor, 9);
  if (!w) { check("接线锚点存在：" + rel + " " + anchor.slice(0, 26), false, "锚点未找到（行号漂移需重新核对）"); continue; }
  const needle = rel === "src/cli-install.js" && anchor === "env: {" ? "childEnv(" : "childEnv()";
  check("接线点 " + rel + ":" + w.line + " 已传 " + needle, w.text.includes(needle), w.text.slice(0, 170));
}
const npxEnvLine = readSrc("src/cli-install.js").split(/\r?\n/).find((l) => /env:\s*\{/.test(l) && l.includes("npm_config_yes"));
check("npxRun 复用 childEnv（不存在第二套 env 口径）", !!npxEnvLine && npxEnvLine.includes("childEnv("), "line=" + (npxEnvLine || "<none>"));
check("npxRun 的 env 行仍保留 ...process.env（不削弱 PR#1 Test 14 的显式 env 判据）", !!npxEnvLine && npxEnvLine.includes("..." + "process.env"), "line=" + (npxEnvLine || "<none>"));
for (const rel of ["src/http.js", "src/extra-sources.js", "src/sources.js", "src/cli-install.js", "index.js"]) {
  const s = readSrc(rel);
  check(rel + " 已从 home.js import childEnv", /import\s*\{[^}]*childEnv[^}]*\}\s*from\s*"[^"]*home\.js"/.test(s), "missing import");
}

// ------------------------------------------------- 套件登记：test:chain 只增这一段
const chain = (pkg.scripts && pkg.scripts["test:chain"]) || "";
const segs = chain.split(" && ");
check("test:chain 已登记 test-child-env.mjs", segs.some((s) => s.includes("test/test-child-env.mjs")), "segs=" + segs.length);
check("test:chain 无重复登记", segs.filter((s) => s.includes("test/test-child-env.mjs")).length === 1, "");

console.log("");

// ------------------------------------------------- 端到端：孙进程里 %SystemDrive% 必须展开
// 0.5.161 / 0.5.163 的现场症状是孙进程把 %SystemDrive% 当字面量，在 cwd 造出同名缓存树。
// 这里用 childEnv 真起一层 cmd.exe 子进程再嵌套一层，直接断言展开结果，而不是只看源码。
if (typeof childEnv === "function" && process.platform === "win32") {
  const probe = spawnSync("cmd.exe", ["/d", "/s", "/c", "echo %SystemDrive%"], { env: childEnv({}), encoding: "utf8", timeout: 20000, windowsHide: true });
  const out = String(probe.stdout || "").trim();
  check("孙进程里 %SystemDrive% 正常展开为盘符", probe.status === 0 && /^[A-Za-z]:$/.test(out), "status=" + probe.status + " stdout=" + JSON.stringify(out));
} else {
  skip("孙进程 %SystemDrive% 展开探针", typeof childEnv !== "function" ? "childEnv 尚未实现" : "仅 win32 有意义（当前 " + process.platform + "）");
}

console.log(passed + " passed, " + failed + " failed, " + skipped + " skipped");
process.exit(failed ? 1 : 0);






