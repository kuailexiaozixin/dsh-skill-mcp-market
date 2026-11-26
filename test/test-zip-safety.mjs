// 任务 0.5.177-A：src/zip.js 行为级全覆盖（readZip / stripCommonPrefix / locateSkillRoot）。
// 逐条锁定 EOCD、method、六类 skipped、中央目录提前 break、反斜杠归一、目录/空名条目、extra 字段跨度，
// 以及 stripCommonPrefix / locateSkillRoot 的分支边界，最后按 src/skills.js:424-432 的用法串一条端到端。
// 全程内存态构造 ZIP 字节流：不写盘、不联网、不触碰用户技能目录，因此临时目录残留恒为 0。
import { deflateRawSync } from "node:zlib";
import { readZip, stripCommonPrefix, locateSkillRoot } from "../src/zip.js";

let pass = 0;
const failures = [];
let attempted = 0;
function check(name, ok, detail) {
  attempted += 1;
  if (ok) {
    pass += 1;
    console.log("OK   " + name + (detail ? " — " + detail : ""));
  } else {
    failures.push(name);
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}
const sectionStats = [];
function section(title, fn, expected) {
  console.log("\n# " + title);
  const before = attempted;
  try {
    fn();
  } catch (error) {
    failures.push(title + "：意外抛错");
    console.log("FAIL " + title + "：意外抛错 — " + String((error && error.stack) || error).split("\n")[0]);
  }
  const ran = attempted - before;
  sectionStats.push(title + "=" + ran + "/" + expected);
  if (expected !== undefined && ran !== expected) {
    failures.push(title + "：判据条数不符");
    console.log("FAIL " + title + "：判据条数不符 — 跑到 " + ran + " 条，声明 " + expected + " 条（中途抛错会静默吞掉后面的判据）");
  }
}
function noThrow(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
function reasonOf(parsed, name) {
  const hit = parsed.skipped.filter((s) => s.name === name)[0];
  return hit ? hit.reason : "(未记名)";
}
function keysOf(obj) {
  return Object.keys(obj).join(",");
}

// ---------------------------------------------------------------- ZIP 夹具（手搓，不复用 test-new-features）
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// entry: { name, data, method = 8, payload, localExtra, centralExtra, centralComment }
// payload 给定时直接作为条目数据（造截断/垃圾 deflate）；三个 extra/comment 字段用来锁指针跨度计算。
// opts: { total（EOCD 声明条目数）, entriesOnDisk（EOCD 的“本磁盘条目数”，默认同 total）,
//        centralOffset（EOCD 声明中央目录起点）, padding（中央目录与 EOCD 间垃圾字节）, trailing（EOCD 之后字节） }
function buildZip(entries, opts) {
  const o = opts || {};
  const recs = [];
  const locals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name === undefined ? "" : String(e.name), "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data === undefined ? "" : String(e.data), "utf8");
    const method = e.method === undefined ? 8 : e.method;
    const payload = e.payload === undefined ? (method === 8 ? deflateRawSync(raw) : raw) : e.payload;
    const le = Buffer.from(e.localExtra || "", "latin1");
    const ce = Buffer.from(e.centralExtra || "", "latin1");
    const cc = Buffer.from(e.centralComment || "", "latin1");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(le.length, 28);
    recs.push({ localStart: offset, nameBuf, payload, raw, method, crc: crc32(raw), ce, cc });
    locals.push(Buffer.concat([lh, nameBuf, le, payload]));
    offset += lh.length + nameBuf.length + le.length + payload.length;
  }
  const cdStart = offset;
  const centralStarts = [];
  const localStarts = recs.map((r) => r.localStart);
  const cdParts = [];
  let cdOffset = 0;
  for (const r of recs) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(r.method, 10);
    ch.writeUInt32LE(r.crc, 16);
    ch.writeUInt32LE(r.payload.length, 20);
    ch.writeUInt32LE(r.raw.length, 24);
    ch.writeUInt16LE(r.nameBuf.length, 28);
    ch.writeUInt16LE(r.ce.length, 30);
    ch.writeUInt16LE(r.cc.length, 32);
    ch.writeUInt32LE(r.localStart, 42);
    centralStarts.push(cdStart + cdOffset);
    cdParts.push(Buffer.concat([ch, r.nameBuf, r.ce, r.cc]));
    cdOffset += ch.length + r.nameBuf.length + r.ce.length + r.cc.length;
  }
  const cdLen = cdOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(o.entriesOnDisk === undefined ? (o.total === undefined ? entries.length : o.total) : o.entriesOnDisk, 8);
  eocd.writeUInt16LE(o.total === undefined ? entries.length : o.total, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(o.centralOffset === undefined ? cdStart : o.centralOffset, 16);
  const buf = Buffer.concat([
    Buffer.concat(locals),
    Buffer.concat(cdParts),
    Buffer.alloc(o.padding || 0),
    eocd,
    Buffer.alloc(o.trailing || 0),
  ]);
  buf.layout = { cdStart, centralStarts, localStarts, eocdStart: cdStart + cdLen + (o.padding || 0) };
  return buf;
}

const CENTRAL_FIELD = { sig: [0, 32], centralMethod: [10, 16], crc: [16, 32], compressedSize: [20, 32], uncompressedSize: [24, 32], nameLength: [28, 16], extraLength: [30, 16], commentLength: [32, 16], localOffset: [42, 32] };
const LOCAL_FIELD = { sig: [0, 32], localMethod: [8, 16], crc: [14, 32], compressedSize: [18, 32], uncompressedSize: [22, 32], nameLength: [26, 16], extraLength: [28, 16] };
const EOCD_FIELD = { total: [10, 16], centralOffset: [16, 32] };

function poke(map, view, field, value) {
  const spec = map[field];
  if (!spec) throw new Error("未知字段 " + field);
  if (spec[1] === 32) view.writeUInt32LE(value >>> 0, spec[0]);
  else view.writeUInt16LE(value & 0xFFFF, spec[0]);
  return view;
}
function pokeCentral(zip, index, field, value) {
  return poke(CENTRAL_FIELD, zip.subarray(zip.layout.centralStarts[index]), field, value);
}
function pokeLocal(zip, index, field, value) {
  return poke(LOCAL_FIELD, zip.subarray(zip.layout.localStarts[index]), field, value);
}
function pokeEocd(zip, field, value) {
  return poke(EOCD_FIELD, zip.subarray(zip.layout.eocdStart), field, value);
}

const HELLO = "---\nname: hello\ndescription: d\n---\nbody\n";
const EOCD_MSG = "不是有效的 ZIP 文件（找不到目录结尾记录）";

// ---------------------------------------------------------------- 1. EOCD 与基本解析
section("EOCD/基本解析", () => {
  const shapeRes = noThrow(() => readZip(buildZip([{ name: "ok.md", data: "a" }, { name: "bad.png", data: Buffer.from([1, 2, 3]) }, { name: "../x.md", data: "b" }])));
  const shapeVal = shapeRes.ok ? shapeRes.value : {};
  const shapeKeys = Object.keys(shapeVal).join(",");
  const shapeList = Array.isArray(shapeVal.skipped) ? shapeVal.skipped : null;
  const shapeItems = shapeList !== null && shapeList.every((s) => s && typeof s.name === "string" && typeof s.reason === "string");
  check("zip：返回形状为 {files, skipped[{name,reason}]}", shapeRes.ok === true && shapeKeys === "files,skipped" && shapeItems, shapeRes.ok ? shapeKeys + "|" + JSON.stringify(shapeList) : shapeRes.error);
  const r1 = noThrow(() => readZip(Buffer.from("this is not a zip archive at all")));
  check("zip：无 EOCD 必须抛错", r1.ok === false, r1.ok ? "未抛错" : r1.error);
  check("zip：EOCD 缺失文案逐字精确", r1.ok === false && r1.error === EOCD_MSG, r1.error);
  const r2 = noThrow(() => readZip(Buffer.alloc(0)));
  check("zip：空 Buffer 同样按无效 ZIP 抛错", r2.ok === false && r2.error === EOCD_MSG, r2.error);
  const good = buildZip([{ name: "a.md", data: HELLO }]);
  const far = Buffer.concat([good, Buffer.alloc(0x10000 + 100)]);
  const r3 = noThrow(() => readZip(far));
  check("zip：EOCD 落在 64KB 回溯窗口外时按无效 ZIP 抛错", r3.ok === false && r3.error === EOCD_MSG, r3.error);
  const commented = buildZip([{ name: "b.md", data: HELLO }], { trailing: 8 });
  const pcmt = noThrow(() => readZip(commented));
  check("zip：EOCD 之后的尾部字节被回溯扫描吃下", pcmt.ok === true && pcmt.value.files["b.md"] === HELLO, pcmt.ok ? keysOf(pcmt.value.files) : pcmt.error);

  const stored = buildZip([{ name: "stored.md", data: HELLO }, { name: "stored.txt", data: "plain text", method: 0 }]);
  const ps = readZip(stored);
  check("zip：method=0（stored）真解出文本", ps.files["stored.md"] === HELLO && ps.files["stored.txt"] === "plain text", keysOf(ps.files));
  check("zip：method=0 零误跳", ps.skipped.length === 0, JSON.stringify(ps.skipped));

  const defl = buildZip([{ name: "def.md", data: HELLO }, { name: "big.txt", data: "x".repeat(5000) }]);
  const pd = readZip(defl);
  check("zip：method=8（deflate）真解出文本", pd.files["def.md"] === HELLO, keysOf(pd.files));
  check("zip：deflate 长负载还原长度正确", pd.files["big.txt"] && pd.files["big.txt"].length === 5000, String((pd.files["big.txt"] || "").length));
  const both = buildZip([{ name: "s.md", data: "stored-body", method: 0 }, { name: "d.md", data: "deflate-body" }]);
  const pb = readZip(both);
  check("zip：同包 stored 与 deflate 混排各自解出", pb.files["s.md"] === "stored-body" && pb.files["d.md"] === "deflate-body", keysOf(pb.files));

  const upper = buildZip([{ name: "UPPER.MD", data: "u" }, { name: "nested/Doc.Json", data: "{}" }]);
  const pu = readZip(upper);
  check("zip：扩展名大小写不敏感（TEXT_EXT 的 i 修饰）", Object.keys(pu.files).length === 2 && pu.skipped.length === 0, keysOf(pu.files) + "|" + JSON.stringify(pu.skipped));

  const utf8 = buildZip([{ name: "中文/说明.md", data: "内容 ✓" }]);
  const p8 = readZip(utf8);
  check("zip：UTF-8 条目名与内容原样解出", p8.files["中文/说明.md"] === "内容 ✓", keysOf(p8.files));

  const localExtra = buildZip([{ name: "le.md", data: "le-body", method: 0, localExtra: "AAAAAAAA" }]);
  const ple = readZip(localExtra);
  check("zip：本地头 extra 字段长度被计入数据起点", ple.files["le.md"] === "le-body" && ple.skipped.length === 0, keysOf(ple.files) + "|" + JSON.stringify(ple.skipped));
  const centralExtra = buildZip([{ name: "ce.md", data: "c1", method: 0, centralExtra: "BBBB" }, { name: "cc.md", data: "c2", method: 0, centralComment: "CCCCC" }, { name: "last.md", data: "c3", method: 0 }]);
  const pce = readZip(centralExtra);
  check("zip：中央目录 extra 与 comment 长度被计入下一条指针", keysOf(pce.files) === "ce.md,cc.md,last.md" && pce.skipped.length === 0, keysOf(pce.files) + "|" + JSON.stringify(pce.skipped));
}, 15);

// ---------------------------------------------------------------- 2. skipped：路径越界
section("skipped：路径越界", () => {
  const dotdot = readZip(buildZip([{ name: "../escape/SKILL.md", data: "e" }]));
  check("zip：.. 相对越界跳过", Object.keys(dotdot.files).length === 0 && reasonOf(dotdot, "../escape/SKILL.md") === "路径越界", JSON.stringify(dotdot.skipped));
  const mid = readZip(buildZip([{ name: "a/../../b.md", data: "e" }]));
  check("zip：路径中间段 .. 越界跳过", reasonOf(mid, "a/../../b.md") === "路径越界" && mid.skipped.length === 1, JSON.stringify(mid.skipped));
  const abs = readZip(buildZip([{ name: "/etc/passwd.md", data: "e" }]));
  check("zip：绝对路径（POSIX 根）越界跳过", reasonOf(abs, "/etc/passwd.md") === "路径越界", JSON.stringify(abs.skipped));
  const unc = readZip(buildZip([{ name: "\\\\server\\share\\x.md", data: "e" }]));
  check("zip：反斜杠 UNC 归一后仍被绝对路径守卫拦下", reasonOf(unc, "//server/share/x.md") === "路径越界", JSON.stringify(unc.skipped));
  const drive = readZip(buildZip([{ name: "C:\\evil\\SKILL.md", data: "e" }]));
  check("zip：盘符绝对路径（C:/win）越界跳过", Object.keys(drive.files).length === 0 && reasonOf(drive, "C:/evil/SKILL.md") === "路径越界", JSON.stringify(drive.skipped));
  const drive2 = readZip(buildZip([{ name: "d:\\other\\y.txt", data: "e" }]));
  check("zip：小写盘符同样被拦", reasonOf(drive2, "d:/other/y.txt") === "路径越界", JSON.stringify(drive2.skipped));
  const driveFwd = readZip(buildZip([{ name: "D:/raw/skill.md", data: "e" }]));
  check("zip：正斜杠写法的盘符路径也被拦", reasonOf(driveFwd, "D:/raw/skill.md") === "路径越界", JSON.stringify(driveFwd.skipped));
  const trio = readZip(buildZip([{ name: "../a.md", data: "1" }, { name: "/b.md", data: "2" }, { name: "E:\\c.md", data: "3" }]));
  check("zip：三形态越界同包共 3 条 skipped 且 files 为空", trio.skipped.length === 3 && Object.keys(trio.files).length === 0 && trio.skipped.every((s) => s.reason === "路径越界"), JSON.stringify(trio.skipped));
  const prio = readZip(buildZip([{ name: "../evil.png", data: "1" }]));
  check("zip：越界守卫优先于非文本判定", reasonOf(prio, "../evil.png") === "路径越界", JSON.stringify(prio.skipped));
  const dots = readZip(buildZip([{ name: "a/..b.md", data: "v" }]));
  check("zip：守卫按子串 includes(\"..\") 判定，故 a/..b.md 也被拒（如实锁现有行为）", reasonOf(dots, "a/..b.md") === "路径越界" && Object.keys(dots.files).length === 0, JSON.stringify(dots.skipped));
  const singleDot = readZip(buildZip([{ name: "./solo.md", data: "v" }, { name: "x/./y.md", data: "w" }]));
  check("zip：单个点段不算越界（只有双点触发，键名原样保留 ./ 前缀）", keysOf(singleDot.files) === "./solo.md,x/./y.md" && singleDot.skipped.length === 0, keysOf(singleDot.files));
}, 11);

// ---------------------------------------------------------------- 3. skipped：非文本 / 2MB / 本地头 / method / 解压失败
section("skipped：非文本与体积上限", () => {
  const bin = readZip(buildZip([{ name: "img/logo.png", data: Buffer.from([137, 80, 78, 71]) }, { name: "keep.md", data: "k" }]));
  check("zip：白名单外扩展名按非文本资源跳过", reasonOf(bin, "img/logo.png") === "非文本资源" && bin.files["keep.md"] === "k", JSON.stringify(bin.skipped));
  const noext = readZip(buildZip([{ name: "LICENSE", data: "MIT" }]));
  check("zip：无扩展名条目按非文本资源跳过", reasonOf(noext, "LICENSE") === "非文本资源" && Object.keys(noext.files).length === 0, JSON.stringify(noext.skipped));
  const allowed = readZip(buildZip([{ name: "s.py", data: "print(1)" }, { name: "t.yaml", data: "a: 1" }, { name: "m.ps1", data: "x" }, { name: "i/index.html", data: "<i>" }]));
  check("zip：白名单内扩展名（py/yaml/ps1/html）都收", Object.keys(allowed.files).length === 4 && allowed.skipped.length === 0, keysOf(allowed.files));

  const LIMIT = 2 * 1024 * 1024;
  const overZip = buildZip([{ name: "big.md", data: "tiny", method: 0 }]);
  pokeCentral(overZip, 0, "uncompressedSize", LIMIT + 1);
  const over = readZip(overZip);
  check("zip：中央目录声明体积超过 2MB 时跳过", Object.keys(over.files).length === 0 && reasonOf(over, "big.md") === "单文件超过 2MB", JSON.stringify(over.skipped));
  const eqZip = buildZip([{ name: "edge.md", data: "tiny", method: 0 }]);
  pokeCentral(eqZip, 0, "uncompressedSize", LIMIT);
  const eq = readZip(eqZip);
  check("zip：声明体积恰为 2MB 不被跳过（守卫是严格大于）", eq.files["edge.md"] === "tiny" && eq.skipped.length === 0, JSON.stringify(eq.skipped));
  const overButBin = buildZip([{ name: "big.png", data: "tiny", method: 0 }]);
  pokeCentral(overButBin, 0, "uncompressedSize", LIMIT + 500);
  check("zip：体积判定排在扩展名白名单之后（超限 png 仍记非文本资源）", reasonOf(readZip(overButBin), "big.png") === "非文本资源", "");
  const overOne = buildZip([{ name: "huge.md", data: "tiny", method: 0 }, { name: "ok.md", data: "fine", method: 0 }]);
  pokeCentral(overOne, 0, "uncompressedSize", LIMIT + 1);
  const pover = readZip(overOne);
  check("zip：超限条目不牵连同包小文件", pover.files["ok.md"] === "fine" && reasonOf(pover, "huge.md") === "单文件超过 2MB", keysOf(pover.files) + "|" + JSON.stringify(pover.skipped));
}, 7);

section("skipped：本地头与压缩方式", () => {
  const oob = buildZip([{ name: "l.md", data: "hello", method: 0 }]);
  pokeCentral(oob, 0, "localOffset", oob.length - 10);
  const p1 = readZip(oob);
  check("zip：localOffset 越过文件尾按本地头损坏跳过", reasonOf(p1, "l.md") === "本地头损坏" && Object.keys(p1.files).length === 0, JSON.stringify(p1.skipped));
  const max = buildZip([{ name: "m.md", data: "hello", method: 0 }]);
  pokeCentral(max, 0, "localOffset", 0xFFFFFFFF);
  const p2 = readZip(max);
  check("zip：localOffset 为 0xFFFFFFFF 时不越界读、按本地头损坏跳过", reasonOf(p2, "m.md") === "本地头损坏", JSON.stringify(p2.skipped));
  const intoCd = buildZip([{ name: "n.md", data: "hello", method: 0 }]);
  pokeCentral(intoCd, 0, "localOffset", intoCd.layout.cdStart);
  const p3 = readZip(intoCd);
  check("zip：localOffset 指到中央目录（签名不匹配）按本地头损坏跳过", reasonOf(p3, "n.md") === "本地头损坏", JSON.stringify(p3.skipped));
  const badSig = buildZip([{ name: "o.md", data: "hello", method: 0 }]);
  pokeLocal(badSig, 0, "sig", 0x08074b50);
  const p4 = readZip(badSig);
  check("zip：本地文件头签名不是 LOCAL_SIG 时跳过", reasonOf(p4, "o.md") === "本地头损坏", JSON.stringify(p4.skipped));
  const okLocal = readZip(buildZip([{ name: "p.md", data: "hello", method: 0 }]));
  check("zip：本地头完好时同形态条目正常入库", okLocal.files["p.md"] === "hello" && okLocal.skipped.length === 0, keysOf(okLocal.files));

  const bzip = buildZip([{ name: "b.md", data: "hello" }]);
  pokeCentral(bzip, 0, "centralMethod", 12);
  const p5 = readZip(bzip);
  check("zip：method 非 0/8 记为不支持的压缩方式并带出方法号", reasonOf(p5, "b.md") === "不支持的压缩方式 12" && Object.keys(p5.files).length === 0, JSON.stringify(p5.skipped));
  const lzma = buildZip([{ name: "c.md", data: "hello" }, { name: "d.md", data: "ok", method: 0 }]);
  pokeCentral(lzma, 0, "centralMethod", 14);
  const p6 = readZip(lzma);
  check("zip：不支持的 method 不牵连同包其它条目", reasonOf(p6, "c.md") === "不支持的压缩方式 14" && p6.files["d.md"] === "ok", JSON.stringify(p6.skipped) + "|" + keysOf(p6.files));

  const full = deflateRawSync(Buffer.from("y".repeat(4000), "utf8"));
  const trunc = buildZip([{ name: "t.md", data: "y".repeat(4000), method: 8, payload: full.subarray(0, Math.floor(full.length / 2)) }]);
  const p7 = readZip(trunc);
  check("zip：deflate 流被截断记为解压失败且不入库", Object.keys(p7.files).length === 0 && /^解压失败：/.test(reasonOf(p7, "t.md")), reasonOf(p7, "t.md"));
  const junk = buildZip([{ name: "j.md", data: "z", method: 8, payload: Buffer.from([0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA, 0xF9, 0xF8]) }]);
  const p8b = readZip(junk);
  check("zip：deflate 负载为垃圾字节同样记为解压失败", /^解压失败：/.test(reasonOf(p8b, "j.md")) && Object.keys(p8b.files).length === 0, reasonOf(p8b, "j.md"));
  const mixed = buildZip([{ name: "good.md", data: "fine", method: 0 }, { name: "bad.md", data: "z", method: 8, payload: Buffer.from([0xFF, 0xFE, 0xFD, 0xFC]) }]);
  const p9 = readZip(mixed);
  check("zip：解压失败只影响该条目，同包好条目保留", p9.files["good.md"] === "fine" && p9.skipped.length === 1 && /^解压失败：/.test(p9.skipped[0].reason), keysOf(p9.files) + "|" + JSON.stringify(p9.skipped));
}, 10);

// ---------------------------------------------------------------- 4. 中央目录遍历的提前 break
section("中央目录提前 break", () => {
  const z1 = buildZip([{ name: "one.md", data: "1", method: 0 }, { name: "two.md", data: "2", method: 0 }], { total: 3 });
  const r1 = noThrow(() => readZip(z1));
  check("zip：声明条目数大于实际（缓冲区边界 break）不抛错", r1.ok === true, r1.ok ? "" : r1.error);
  check("zip：边界 break 后返回已读到的部分", r1.ok && keysOf(r1.value.files) === "one.md,two.md" && r1.value.skipped.length === 0, r1.ok ? keysOf(r1.value.files) : "");
  const z2 = buildZip([{ name: "one.md", data: "1", method: 0 }], { total: 2, padding: 46 });
  const r2 = noThrow(() => readZip(z2));
  check("zip：中央目录签名不符（第二条 break）不抛错", r2.ok === true, r2.ok ? "" : r2.error);
  check("zip：签名 break 后已读条目保留且不误记 skipped", r2.ok && keysOf(r2.value.files) === "one.md" && r2.value.skipped.length === 0, r2.ok ? keysOf(r2.value.files) + "|" + JSON.stringify(r2.value.skipped) : "");
  const z3 = buildZip([{ name: "one.md", data: "1", method: 0 }, { name: "two.md", data: "2", method: 0 }], { total: 9, padding: 46 });
  const r3 = noThrow(() => readZip(z3));
  check("zip：声明数远大于实际时两个 break 串联仍不抛错", r3.ok === true && Object.keys(r3.value.files).length === 2, r3.ok ? keysOf(r3.value.files) : r3.error);
  const z4 = buildZip([{ name: "one.md", data: "1", method: 0 }]);
  pokeEocd(z4, "centralOffset", z4.length + 64);
  const r4 = noThrow(() => readZip(z4));
  check("zip：中央目录起点声明在 EOF 之外时返回空结果而不抛错", r4.ok === true && Object.keys(r4.value.files).length === 0 && r4.value.skipped.length === 0, r4.ok ? JSON.stringify(r4.value) : r4.error);
  const z5 = buildZip([{ name: "one.md", data: "1", method: 0 }], { total: 0 });
  const r5 = noThrow(() => readZip(z5));
  check("zip：声明条目数为 0 时返回空结果而不抛错", r5.ok === true && Object.keys(r5.value.files).length === 0, r5.ok ? keysOf(r5.value.files) : r5.error);
  const z6 = buildZip([{ name: "one.md", data: "1", method: 0 }, { name: "two.md", data: "2", method: 0 }], { total: 2, entriesOnDisk: 1 });
  const r6 = noThrow(() => readZip(z6));
  check("zip：条目数取 EOCD 的总计数字段（:10），不是本磁盘计数字段（:8）", r6.ok === true && keysOf(r6.value.files) === "one.md,two.md", r6.ok ? keysOf(r6.value.files) : r6.error);
}, 8);

// ---------------------------------------------------------------- 5. 反斜杠归一与目录/空名条目
section("反斜杠归一与目录条目", () => {
  const bs = readZip(buildZip([{ name: "a\\b\\SKILL.md", data: "win", method: 0 }, { name: "c\\d.txt", data: "txt", method: 0 }]));
  check("zip：中央目录里的反斜杠归一为正斜杠", keysOf(bs.files) === "a/b/SKILL.md,c/d.txt", keysOf(bs.files));
  const bsDeep = readZip(buildZip([{ name: "x\\SKILL.md", data: "s", method: 0 }]));
  check("zip：归一后的键可被 locateSkillRoot 直接消费", locateSkillRoot(bsDeep.files) === "x", String(locateSkillRoot(bsDeep.files)));
  const bsTrap = readZip(buildZip([{ name: "a\\..\\..\\etc\\passwd.md", data: "p" }]));
  check("zip：反斜杠越界在归一之后才被守卫拦下", reasonOf(bsTrap, "a/../../etc/passwd.md") === "路径越界", JSON.stringify(bsTrap.skipped));
  const bsKeep = buildZip([{ name: "k\\e\\f.md", data: "vv", method: 0 }]);
  pokeCentral(bsKeep, 0, "nameLength", 0);
  check("zip：归一只影响键名，不影响后续条目解析", readZip(buildZip([{ name: "k\\e\\f.md", data: "vv", method: 0 }, { name: "g\\h.md", data: "ww", method: 0 }])).files["k/e/f.md"] === "vv", "");

  const dir = readZip(buildZip([{ name: "assets/", data: "" }, { name: "assets2/", data: "" }]));
  check("zip：目录条目既不进 files 也不进 skipped", Object.keys(dir.files).length === 0 && dir.skipped.length === 0, JSON.stringify(dir));
  const mixedDir = readZip(buildZip([{ name: "pkg/", data: "" }, { name: "pkg/SKILL.md", data: "s", method: 0 }, { name: "pkg/bin/", data: "" }]));
  check("zip：目录条目不牵连同包文件条目", keysOf(mixedDir.files) === "pkg/SKILL.md" && mixedDir.skipped.length === 0, keysOf(mixedDir.files) + "|" + JSON.stringify(mixedDir.skipped));
  const emptyName = readZip(buildZip([{ name: "", data: "ghost" }, { name: "real.md", data: "r", method: 0 }]));
  check("zip：空名条目静默跳过（不误判为非文本资源）", emptyName.skipped.length === 0 && keysOf(emptyName.files) === "real.md", JSON.stringify(emptyName.skipped) + "|" + keysOf(emptyName.files));
  const dirOver = buildZip([{ name: "big/", data: "x", method: 0 }]);
  pokeCentral(dirOver, 0, "uncompressedSize", 9 * 1024 * 1024);
  const pd = readZip(dirOver);
  check("zip：目录条目即使声明超限也不产生 skipped", pd.skipped.length === 0 && Object.keys(pd.files).length === 0, JSON.stringify(pd.skipped));
  const dirDot = readZip(buildZip([{ name: "../dir/", data: "" }]));
  check("zip：越界的目录条目也被目录判定先行跳过", dirDot.skipped.length === 0 && Object.keys(dirDot.files).length === 0, JSON.stringify(dirDot));
}, 9);

// ---------------------------------------------------------------- 6. stripCommonPrefix
section("stripCommonPrefix", () => {
  const emptyRes = noThrow(() => stripCommonPrefix({}));
  const emptyIsObj = emptyRes.ok === true && emptyRes.value !== null && typeof emptyRes.value === "object" && !Array.isArray(emptyRes.value);
  check("strip：空对象原样返回（不产出 undefined，也不抛错）", emptyIsObj && Object.keys(emptyIsObj ? emptyRes.value : {}).length === 0, emptyRes.ok ? JSON.stringify(emptyRes.value) : emptyRes.error);
  const one = stripCommonPrefix({ "repo-main/SKILL.md": "s", "repo-main/ref/a.md": "a" });
  check("strip：单一顶层目录被剥离", keysOf(one) === "SKILL.md,ref/a.md", keysOf(one));
  const oneSeg = stripCommonPrefix({ "pkg/SKILL.md": "only" });
  check("strip：单条目单顶层也剥离", keysOf(oneSeg) === "SKILL.md", keysOf(oneSeg));
  const deep = stripCommonPrefix({ "w/x/y/z.md": "v" });
  check("strip：只剥第一段，深层路径保留", keysOf(deep) === "x/y/z.md", keysOf(deep));
  const content = stripCommonPrefix({ "w/SKILL.md": "BODY" });
  check("strip：内容原样保留", content["SKILL.md"] === "BODY", JSON.stringify(content));
  const multi = stripCommonPrefix({ "a/SKILL.md": "1", "b/x.md": "2" });
  check("strip：多顶层目录原样返回", keysOf(multi) === "a/SKILL.md,b/x.md", keysOf(multi));
  const fileTop = stripCommonPrefix({ "SKILL.md": "r", "a/x.md": "n" });
  check("strip：根位文件与子目录并存时原样返回", keysOf(fileTop) === "SKILL.md,a/x.md", keysOf(fileTop));
  const mixedShape = stripCommonPrefix({ "a": "1", "a/b": "2" });
  check("strip：every 守卫拦住「名字恰等于首段」的混合形态", keysOf(mixedShape) === "a,a/b", keysOf(mixedShape));
  const mixedShape2 = stripCommonPrefix({ "a/b": "2", "a": "1" });
  check("strip：every 守卫与键序无关", keysOf(mixedShape2) === "a/b,a", keysOf(mixedShape2));
  const prefixOnly = stripCommonPrefix({ "a/": "x" });
  check("strip：名字恰等于前缀时产出空 key（如实锁现有行为，空 key 不是 null）", keysOf(prefixOnly) === "" && Object.keys(prefixOnly).length === 1 && prefixOnly[""] === "x", JSON.stringify(prefixOnly));
  const emptyAfter = locateSkillRoot(prefixOnly);
  check("strip：空 key 结果喂给 locateSkillRoot 返回 null 而不抛错", emptyAfter === null, String(emptyAfter));
  const noSlash = stripCommonPrefix({ "ab": "1", "ac": "2" });
  check("strip：无斜杠的多文件名按多顶层原样返回", keysOf(noSlash) === "ab,ac", keysOf(noSlash));
  const sameHead = stripCommonPrefix({ "abc/SKILL.md": "1", "abd/x.md": "2" });
  check("strip：首段共享前缀但不相等时不剥离", keysOf(sameHead) === "abc/SKILL.md,abd/x.md", keysOf(sameHead));
}, 13);

// ---------------------------------------------------------------- 7. locateSkillRoot
section("locateSkillRoot", () => {
  check("root：根位 SKILL.md 返回空串", locateSkillRoot({ "SKILL.md": "s", "ref/a.md": "a" }) === "", "");
  check("root：嵌套 a/SKILL.md 返回 a", locateSkillRoot({ "a/SKILL.md": "s", "a/x.md": "x" }) === "a", "");
  check("root：深层 a/b/SKILL.md 返回 a/b（剥掉的是整个 /SKILL.md 后缀）", locateSkillRoot({ "a/b/SKILL.md": "s" }) === "a/b", "");
  check("root：单层目录名长度边界 n/SKILL.md 返回 n", locateSkillRoot({ "n/SKILL.md": "s" }) === "n", "");
  check("root：多命中取 Object.keys 的首条", locateSkillRoot({ "z/SKILL.md": "1", "a/SKILL.md": "2" }) === "z", "");
  check("root：首条命中即决定结果（键序相反时取 a）", locateSkillRoot({ "a/SKILL.md": "2", "z/SKILL.md": "1" }) === "a", "");
  check("root：无 SKILL.md 返回 null", locateSkillRoot({ "a/readme.md": "x" }) === null, "");
  check("root：空对象返回 null", locateSkillRoot({}) === null, "");
  check("root：MY_SKILL.md 不算命中（后缀必须带斜杠）", locateSkillRoot({ "MY_SKILL.md": "x" }) === null, "");
  check("root：SKILL.md.bak 不算命中", locateSkillRoot({ "a/SKILL.md.bak": "x" }) === null, "");
  check("root：SKILL.md-x 不算命中", locateSkillRoot({ "dir/SKILL.md-x": "x" }) === null, "");
  check("root：只有非 SKILL.md 的根文件返回 null", locateSkillRoot({ "README.md": "x" }) === null, "");
  check("root：根位 SKILL.md 优先于其后的嵌套命中（find 短路）", locateSkillRoot({ "SKILL.md": "r", "z/SKILL.md": "n" }) === "", "");
}, 13);

// ---------------------------------------------------------------- 8. 端到端（对齐 src/skills.js:424-432 的用法，不调用 installSkill）
section("端到端与消费方对齐", () => {
  const zip = buildZip([
    { name: "zip-skill/SKILL.md", data: HELLO },
    { name: "zip-skill/ref/x.md", data: "reference\n" },
  ]);
  const raw = readZip(zip);
  check("e2e：readZip 解出两个条目且零跳过", keysOf(raw.files) === "zip-skill/SKILL.md,zip-skill/ref/x.md" && raw.skipped.length === 0, keysOf(raw.files) + "|" + JSON.stringify(raw.skipped));
  const flat = stripCommonPrefix(raw.files);
  const root = locateSkillRoot(flat);
  check("e2e：strip 后 SKILL.md 落在根位", keysOf(flat) === "SKILL.md,ref/x.md", keysOf(flat));
  check("e2e：locateSkillRoot 返回空串（根位）", root === "", String(root));
  const prefix = root ? root + "/" : "";
  const finalFiles = {};
  for (const [entry, content] of Object.entries(flat)) {
    if (prefix && !entry.startsWith(prefix)) continue;
    finalFiles[entry.slice(prefix.length)] = content;
  }
  check("e2e：skills.js 前缀过滤后的落盘键集为 SKILL.md 与 ref/x.md", keysOf(finalFiles) === "SKILL.md,ref/x.md", keysOf(finalFiles));
  check("e2e：SKILL.md 内容可被消费方直接读取", finalFiles["SKILL.md"] === HELLO, JSON.stringify(finalFiles["SKILL.md"] && finalFiles["SKILL.md"].slice(0, 12)));
  check("e2e：root 为空串时消费方的 slug 回退链不取 split 首段", (root || "zip-skill").split("/").pop() === "zip-skill", root);

  const nested = readZip(buildZip([
    { name: "wrapper/inner/SKILL.md", data: "n", method: 0 },
    { name: "wrapper/inner/ref.md", data: "r", method: 0 },
  ]));
  const nflat = stripCommonPrefix(nested.files);
  const nroot = locateSkillRoot(nflat);
  check("e2e：两层嵌套包 strip 后 root 落在内层目录", keysOf(nflat) === "inner/SKILL.md,inner/ref.md" && nroot === "inner", keysOf(nflat) + "|" + nroot);
  const nprefix = nroot ? nroot + "/" : "";
  const nfinal = {};
  for (const [entry, content] of Object.entries(nflat)) {
    if (nprefix && !entry.startsWith(nprefix)) continue;
    nfinal[entry.slice(nprefix.length)] = content;
  }
  check("e2e：内层 root 过滤后得到根位 SKILL.md", keysOf(nfinal) === "SKILL.md,ref.md", keysOf(nfinal));

  const noSkill = stripCommonPrefix(readZip(buildZip([{ name: "pack/README.md", data: "r", method: 0 }])).files);
  check("e2e：包里无 SKILL.md 时 root 为 null（消费方据此报「ZIP 里没有找到 SKILL.md」）", locateSkillRoot(noSkill) === null, keysOf(noSkill));

  const dirty = readZip(buildZip([
    { name: "pack/SKILL.md", data: "s", method: 0 },
    { name: "pack/logo.png", data: Buffer.from([1, 2, 3]) },
    { name: "../pack/evil.md", data: "e" },
  ]));
  const dirtyFlat = stripCommonPrefix(dirty.files);
  check("e2e：脏包只留下合法条目，strip 后 SKILL.md 落在根位", locateSkillRoot(dirtyFlat) === "" && keysOf(dirty.files) === "pack/SKILL.md" && dirty.skipped.length === 2, keysOf(dirty.files) + "|" + JSON.stringify(dirty.skipped.map((s) => s.reason)));
}, 10);

console.log("\n# 判据条数：" + sectionStats.join(" "));
console.log("\n" + pass + " 项通过，" + failures.length + " 项失败");
if (failures.length > 0) console.log("失败项：" + failures.join(" | "));
// run-gate 契约（test/gate-verdict.mjs:26）：最后一行必须是「N passed, M failed[, K skipped]」。
console.log(pass + " passed, " + failures.length + " failed");
process.exit(failures.length > 0 ? 1 : 0);
