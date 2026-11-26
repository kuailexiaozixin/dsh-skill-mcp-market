// test-repair-guard.mjs — 会话修复三连的行为锁（异常/边界分支）。
//
// 覆盖面：src/session-repair.js、src/auto-repair.js、src/toolcall-guard.js。
// 这三个模块会写用户的会话日志与宿主 patch 文件，是本仓 blast radius 最大的面；
// test-new-features.mjs 只有 happy-path，本套件补「不该发生的事」那一半：
// 截断帧、坏校验和、空 tool-call、dryRun 落盘、就地改写、重复打补丁。
//
// 纪律：全程只在 safeTempDir() 下的临时 dshHome 造假会话文件，绝不碰真实
// %USERPROFILE%/.dsh 或宿主 storage；不 spawn 宿主进程；不联网。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { safeTempDir } from "../src/home.js";
import {
  scanZstdFrames,
  decodeSessionLog,
  findCorruption,
  encodeEvents,
  inspectSessionLog,
  repairSessionLog,
} from "../src/session-repair.js";
import { autoRepairSessions } from "../src/auto-repair.js";
import { installToolCallGuard } from "../src/toolcall-guard.js";

const MARKER_NAME = "session-repairs.json"; // src/auto-repair.js:11 的常量未导出，这里用字面量
const LOGNAME = "session.v4.jsonl.zstd";
const GUARD_SYMBOL = Symbol.for("dsh-market.toolcall-guard"); // src/toolcall-guard.js:15

let passed = 0;
let failed = 0;
const check = function (name, ok, detail) {
  if (ok) {
    passed++;
    console.log("  OK " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "  [" + String(detail).slice(0, 160) + "]" : ""));
  }
};
const section = function (t) {
  console.log("");
  console.log(t);
};

const trash = [];
const mkRg = function (tag) {
  const dir = mkdtempOf(tag);
  trash.push(dir);
  return dir;
};
function mkdtempOf(tag) {
  return fs.mkdtempSync(path.join(safeTempDir(), "rg-" + tag + "-"));
}
const makeSession = function (root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const ev = function (obj) {
  return { raw: JSON.stringify(obj), json: obj };
};
const noop = function () {};

// 造帧一律走生产 encodeEvents，保证样本与真实写盘同构。
const oneEventFrame = encodeEvents([ev({ type: "session", version: 4 })]);
const twoEventFrame = encodeEvents([
  ev({ type: "session", version: 4 }),
  ev({ type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } }),
]);
const badToolCallFrame = encodeEvents([ev({ type: "tool/call", seq: 9, data: { callId: "", name: "" } })]);
// 本套件的脏样本 = 两个合法帧（好帧 + 空 tool-call 帧）。与 test-new-features.mjs 的
// 「好帧 + 裸半行」不同：这里帧结构完好，损坏由事件内容触发，能区分「帧坏了」与「事件坏了」。
const dirtyLog = Buffer.concat([twoEventFrame, badToolCallFrame]);

section("Test 1: scanZstdFrames 的 0 帧 / 多帧 / 尾帧截断 / 帧头非法");
{
  const empty = scanZstdFrames(Buffer.alloc(0));
  check("空缓冲=0帧", Array.isArray(empty.frames) && empty.frames.length === 0, JSON.stringify(empty));
  check("空缓冲不谎报tornStart", empty.tornStart === undefined, JSON.stringify(empty));

  let magicErr = null;
  try {
    scanZstdFrames(Buffer.from("hello world, not zstd at all", "utf8"));
  } catch (e) {
    magicErr = e.message;
  }
  check("非zstd字节抛魔数错", typeof magicErr === "string" && magicErr.includes("不是有效的会话日志") && magicErr.includes("帧魔数无效"), magicErr);

  const single = scanZstdFrames(oneEventFrame);
  check("单帧边界精确", single.frames.length === 1 && single.frames[0].start === 0 && single.frames[0].end === oneEventFrame.length, JSON.stringify(single));
  check("完整单帧无截断", single.tornStart === undefined, JSON.stringify(single));

  const two = Buffer.concat([oneEventFrame, badToolCallFrame]);
  const st = scanZstdFrames(two);
  check("多帧逐帧记账", st.frames.length === 2 && st.frames[0].end === oneEventFrame.length && st.frames[1].start === oneEventFrame.length && st.frames[1].end === two.length, JSON.stringify(st));

  const torn = Buffer.concat([oneEventFrame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
  const stTorn = scanZstdFrames(torn);
  check("尾帧截断保留前帧", stTorn.frames.length === 1 && stTorn.frames[0].end === oneEventFrame.length, JSON.stringify(stTorn));
  check("尾帧截断报tornStart", stTorn.tornStart === oneEventFrame.length, JSON.stringify(stTorn));

  const magicOnly = scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  check("仅魔数=0帧且tornStart0", magicOnly.frames.length === 0 && magicOnly.tornStart === 0, JSON.stringify(magicOnly));

  const reserved = Buffer.from(oneEventFrame);
  reserved[4] = reserved[4] | 0x08; // 帧头保留位
  let hdrErr = null;
  try {
    scanZstdFrames(reserved);
  } catch (e) {
    hdrErr = e.message;
  }
  check("帧头保留位被拒", typeof hdrErr === "string" && hdrErr.includes("帧头保留位被置位"), hdrErr);

  const rawType = Buffer.from(oneEventFrame);
  const bh = rawType.readUIntLE(6, 3); // 单小帧：块头在 magic+FDESC+FCS 之后（位移 6）
  rawType.writeUIntLE((bh & ~0x06) | 0x06, 6, 3); // blockType = 0b11 = 保留
  let blkErr = null;
  try {
    scanZstdFrames(rawType);
  } catch (e) {
    blkErr = e.message;
  }
  check("保留块类型被拒", typeof blkErr === "string" && blkErr.includes("保留块类型"), blkErr);
}

section("Test 2: decodeSessionLog 对损坏帧的部分可读性");
{
  // 坏帧（校验和不符）不得吃掉好帧：好帧事件仍要读得出来，且 decodeErrors 要记账。
  const checksumFrame = (function () {
    const txt = Buffer.from('{"type":"session","version":4}\n', "utf8");
    const f = Buffer.alloc(4 + 1 + 1 + 3 + txt.length + 4);
    f.writeUInt32LE(0xfd2fb528, 0);
    f.writeUInt8(0x24, 4); // singleSegment | checksum
    f.writeUInt8(txt.length, 5);
    f.writeUIntLE((txt.length << 3) | 1, 6, 3);
    txt.copy(f, 9);
    f.writeUInt32LE(0xdeadbeef, 9 + txt.length); // 假校验和
    return f;
  })();
  const combo = Buffer.concat([oneEventFrame, checksumFrame]);
  check("坏校验和帧仍被计入帧数", scanZstdFrames(combo).frames.length === 2, JSON.stringify(scanZstdFrames(combo)));
  const cd = decodeSessionLog(combo);
  check("坏帧不吞好帧事件", cd.events.length === 1 && !!cd.events[0].json && cd.events[0].json.type === "session", JSON.stringify({ n: cd.events.length, e: cd.decodeErrors }));
  check("坏帧计入decodeErrors", cd.decodeErrors === 1, String(cd.decodeErrors));

  const torn = Buffer.concat([twoEventFrame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
  const td = decodeSessionLog(torn);
  check("截断尾=好帧全可读", td.events.length === 2 && td.decodeErrors === 0, JSON.stringify({ n: td.events.length, e: td.decodeErrors }));
  check("截断尾标记tornStart", td.tornStart === twoEventFrame.length, String(td.tornStart));

  // 合成 RAW 块帧（真实 zstd 压缩器不会产出 raw 块）：刻意造「能解开但内容不是 JSON」的样本，
  // 锁的是垃圾行必须留在 events 里且 json===undefined，而不是抛穿。
  const junk = Buffer.from("not json at all\n", "utf8");
  const rawFrame = Buffer.alloc(4 + 1 + 1 + 3 + junk.length);
  rawFrame.writeUInt32LE(0xfd2fb528, 0);
  rawFrame.writeUInt8(0x20, 4);
  rawFrame.writeUInt8(junk.length, 5);
  rawFrame.writeUIntLE((junk.length << 3) | 1, 6, 3); // blockType 0 = raw
  junk.copy(rawFrame, 9);
  const rd = decodeSessionLog(Buffer.concat([oneEventFrame, rawFrame]));
  check("raw块帧不算硬错误", rd.decodeErrors === 0, String(rd.decodeErrors));
  check("垃圾行保留raw", rd.events.length === 2 && rd.events[1].raw === "not json at all", JSON.stringify(rd.events.map(function (e) { return e.raw; })));
  check("垃圾行json为undefined", rd.events[0].json !== undefined && rd.events[1].json === undefined, JSON.stringify(rd.events.map(function (e) { return e.json === undefined; })));
  const junkCorrupt = findCorruption(rd.events);
  check("垃圾行被认成损坏", !!junkCorrupt && junkCorrupt.index === 1 && junkCorrupt.reason.includes("不是合法 JSON"), JSON.stringify(junkCorrupt));

  const blank = decodeSessionLog(Buffer.alloc(0));
  check("空缓冲解码为空不抛", blank.events.length === 0 && blank.decodeErrors === 0, JSON.stringify(blank));
}

section("Test 3: findCorruption 认出的那一类损坏（逐键）");
{
  const cleanAssistant = ev({ type: "assistant/message", seq: 7, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "run_code" }] } } });
  check("干净日志=undefined", findCorruption([ev({ type: "session", version: 4 }), cleanAssistant]) === undefined, String(findCorruption([cleanAssistant])));

  const both = { type: "assistant/message", seq: 7, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "", name: "" }] } } };
  const c1 = findCorruption([ev({ type: "session", version: 4 }), ev(both)]);
  check("双空命中第二行", !!c1 && c1.index === 1, JSON.stringify(c1));
  check("命中带seq", !!c1 && c1.seq === 7, JSON.stringify(c1));
  check("命中带type", !!c1 && c1.type === "assistant/message", JSON.stringify(c1));
  check("双空文案", !!c1 && c1.reason === "tool-call 的 id 与 name 为空", c1 && c1.reason);

  const idOnly = findCorruption([ev({ type: "assistant/message", seq: 7, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "", name: "run_code" }] } } })]);
  check("仅id空文案", !!idOnly && idOnly.reason === "tool-call 的 id 为空", idOnly && idOnly.reason);

  const nameBlank = findCorruption([ev({ type: "assistant/message", seq: 7, data: { message: { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "   " }] } } })]);
  check("name空白也算损坏", !!nameBlank && nameBlank.reason === "tool-call 的 name 为空", nameBlank && nameBlank.reason);

  const tc = findCorruption([ev({ type: "tool/call", seq: 3, data: { callId: "", name: "" } })]);
  check("tool/call通道也认", !!tc && tc.type === "tool/call" && tc.seq === 3 && tc.index === 0, JSON.stringify(tc));

  const badLine = findCorruption([{ raw: "半写入的一行", json: undefined }]);
  check("非法JSON行只有index+reason", !!badLine && JSON.stringify(Object.keys(badLine).sort()) === JSON.stringify(["index", "reason"]), JSON.stringify(badLine));

  const firstWins = findCorruption([{ raw: "{bad", json: undefined }, ev(both)]);
  check("首个损坏优先", !!firstWins && firstWins.index === 0 && firstWins.reason.includes("不是合法 JSON"), JSON.stringify(firstWins));
}

section("Test 4: encodeEvents 往返一致性 decode(encode(x)) === x");
{
  const src = [
    ev({ type: "session", version: 4 }),
    ev({ type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "含中文与\"引号\"和 换行" }] } } }),
    ev({ type: "tool/call", seq: 2, data: { callId: "call_2", name: "pwsh", args: { p: "a b" } } }),
  ];
  const rt = decodeSessionLog(encodeEvents(src));
  check("往返事件数相等", rt.events.length === src.length, String(rt.events.length));
  check("往返raw逐条相等", rt.events.every(function (e, i) { return e.raw === src[i].raw; }), JSON.stringify(rt.events.map(function (e) { return e.raw; })));
  check("往返json深相等", JSON.stringify(rt.events.map(function (e) { return e.json; })) === JSON.stringify(src.map(function (e) { return JSON.parse(e.raw); })), "");
  check("往返无损坏无截断", rt.decodeErrors === 0 && rt.tornStart === undefined && findCorruption(rt.events) === undefined, JSON.stringify({ e: rt.decodeErrors, t: rt.tornStart }));
  const empty = decodeSessionLog(encodeEvents([]));
  check("空事件集往返仍为空", empty.events.length === 0, String(empty.events.length));
  const twice = decodeSessionLog(encodeEvents(rt.events));
  check("二次往返仍等幂", twice.events.length === src.length && twice.events.every(function (e, i) { return e.raw === src[i].raw; }), JSON.stringify(twice.events.map(function (e) { return e.raw; })));
}

section("Test 5: inspectSessionLog 返回值形状（逐键）与只读性");
{
  const root = mkRg("insp");
  const sess = makeSession(root, "sessA");
  const fp = path.join(sess, LOGNAME);
  fs.writeFileSync(fp, twoEventFrame);
  const before = fs.readdirSync(sess).sort().join("|");
  const info = await inspectSessionLog(fp);
  const expectKeys = ["bytes", "corrupt", "corruption", "decodeErrors", "events", "file", "frames", "keepEvents", "sessionId", "torn"];
  check("inspect键集合精确", JSON.stringify(Object.keys(info).sort()) === JSON.stringify(expectKeys.slice().sort()), JSON.stringify(Object.keys(info).sort()));
  check("inspect.file原样", info.file === fp, String(info.file));
  check("inspect.sessionId=父目录名", info.sessionId === "sessA", String(info.sessionId));
  check("inspect.bytes=文件字节", info.bytes === twoEventFrame.length, String(info.bytes));
  check("inspect.frames=帧数", info.frames === 1, String(info.frames));
  check("inspect.events=事件数", info.events === 2, String(info.events));
  check("inspect.decodeErrors=0", info.decodeErrors === 0, String(info.decodeErrors));
  check("inspect.torn为布尔false", info.torn === false, String(info.torn));
  check("inspect.corrupt为布尔false", info.corrupt === false, String(info.corrupt));
  check("inspect.corruption干净时null", info.corruption === null, JSON.stringify(info.corruption));
  check("inspect.keepEvents=全事件", info.keepEvents === 2, String(info.keepEvents));
  check("inspect只读不改字节与目录", fs.readFileSync(fp).equals(twoEventFrame) && fs.readdirSync(sess).sort().join("|") === before, "");

  const dpath = path.join(makeSession(root, "sessB"), LOGNAME);
  fs.writeFileSync(dpath, dirtyLog);
  const d = await inspectSessionLog(dpath);
  check("脏日志corrupt=true", d.corrupt === true, String(d.corrupt));
  check("脏日志torn=false（帧没坏，事件坏了）", d.torn === false && d.decodeErrors === 0, JSON.stringify({ t: d.torn, e: d.decodeErrors }));
  check("脏日志frames=2", d.frames === 2, String(d.frames));
  check("脏日志events=3", d.events === 3, String(d.events));
  check("脏日志corruption非null且index=2", !!d.corruption && d.corruption.index === 2, JSON.stringify(d.corruption));
  check("脏日志keepEvents=损坏点", d.keepEvents === 2, String(d.keepEvents));
}

section("Test 6: repairSessionLog 四条硬约束（dryRun不落盘 / 原子写 / 备份 / 幂等）");
{
  const root = mkRg("repair");
  const drySess = makeSession(root, "dry");
  const dryPath = path.join(drySess, LOGNAME);
  fs.writeFileSync(dryPath, dirtyLog);
  const dryBefore = fs.readdirSync(drySess).sort().join("|");
  const dr = await repairSessionLog(dryPath, { dryRun: true });
  const dryAfter = fs.readdirSync(drySess).sort().join("|");
  check("dryRun.repaired=false", dr.repaired === false, String(dr.repaired));
  check("dryRun.dryRun=true", dr.dryRun === true, String(dr.dryRun));
  check("dryRun绝不写backup键", !("backup" in dr) && dr.backup === undefined, JSON.stringify(Object.keys(dr).sort()));
  check("dryRun绝不新增文件", dryBefore === dryAfter && dryAfter === LOGNAME, dryAfter);
  check("dryRun绝不改目标字节", fs.readFileSync(dryPath).equals(dirtyLog), "目标被改动");
  check("dryRun报告可读（keep/drop/corruption）", dr.eventsBefore === 3 && dr.keepEvents === 2 && dr.dropped === 1 && !!dr.corruption && dr.corruption.index === 2, JSON.stringify(dr));
  check("dryRun键集合精确", JSON.stringify(Object.keys(dr).sort()) === JSON.stringify(["corruption", "dropped", "dryRun", "eventsBefore", "file", "keepEvents", "repaired", "sessionId"]), JSON.stringify(Object.keys(dr).sort()));

  const sess = makeSession(root, "real");
  const fp = path.join(sess, LOGNAME);
  fs.writeFileSync(fp, dirtyLog);
  const original = fs.readFileSync(fp);
  const linkPath = path.join(root, "link.bin");
  fs.linkSync(fp, linkPath); // 与目标同一 inode：就地改写会让它看到新字节
  const rep = await repairSessionLog(fp, {});
  check("真修repaired=true", rep.repaired === true, JSON.stringify(rep));
  check("真修返回backup路径", typeof rep.backup === "string" && rep.backup.length > 0, String(rep.backup));
  const backupExists = typeof rep.backup === "string" && fs.existsSync(rep.backup);
  check("备份文件真实存在", backupExists, String(rep.backup));
  check("备份在同会话目录且命名可辨", path.dirname(rep.backup) === sess && path.basename(rep.backup).startsWith(LOGNAME + ".repair-"), path.basename(String(rep.backup)));
  check("备份字节===修复前原文", backupExists && fs.readFileSync(rep.backup).equals(original), "备份与原文不一致");
  check("修复后长度=report.bytesAfter", fs.readFileSync(fp).length === rep.bytesAfter, String(rep.bytesAfter));
  check("硬链仍持修复前原文（rename替换而非就地改写）", fs.readFileSync(linkPath).equals(original), "就地改写：链接看到了新字节");
  check("修复后目标inode已换", fs.statSync(fp).ino !== fs.statSync(linkPath).ino, JSON.stringify([fs.statSync(fp).ino, fs.statSync(linkPath).ino]));
  check("目录无.repair-tmp中途残留", fs.readdirSync(sess).filter(function (f) { return f.startsWith(".repair-tmp"); }).length === 0, fs.readdirSync(sess).join("|"));
  const post = await inspectSessionLog(fp);
  check("修复后已无损坏", post.corrupt === false && post.corruption === null, JSON.stringify(post.corruption));
  check("修复后保留前缀事件", post.events === 2 && post.events === rep.keepEvents, String(post.events));
  check("修复后内容=encode(kept)", fs.readFileSync(fp).equals(encodeEvents(decodeSessionLog(original).events.slice(0, 2))), "重编码不一致");

  const afterFirst = fs.readFileSync(fp);
  const backups1 = fs.readdirSync(sess).filter(function (f) { return f.includes(".repair-"); }).length;
  const rep2 = await repairSessionLog(fp, {});
  check("二次repaired=false", rep2.repaired === false, JSON.stringify(rep2));
  check("二次dropped=0且eventsBefore=2", rep2.dropped === 0 && rep2.eventsBefore === 2, JSON.stringify({ d: rep2.dropped, b: rep2.eventsBefore }));
  check("二次不再产备份", fs.readdirSync(sess).filter(function (f) { return f.includes(".repair-"); }).length === backups1, String(backups1));
  check("二次不改一字节", fs.readFileSync(fp).equals(afterFirst), "二次修复改动了字节");
  check("二次不产backup键", rep2.backup === undefined, JSON.stringify(Object.keys(rep2).sort()));

  const zeroSess = makeSession(root, "zero");
  const zeroPath = path.join(zeroSess, LOGNAME);
  const zeroBuf = encodeEvents([ev({ type: "tool/call", seq: 1, data: { callId: "", name: "" } })]);
  fs.writeFileSync(zeroPath, zeroBuf);
  let zeroErr = null;
  try {
    await repairSessionLog(zeroPath, {});
  } catch (e) {
    zeroErr = e.message;
  }
  check("无可用前缀时拒绝修复", typeof zeroErr === "string" && zeroErr.includes("无法修复"), zeroErr);
  check("拒绝时目标字节不变", fs.readFileSync(zeroPath).equals(zeroBuf), "目标被清空");
}

section("Test 7: auto-repair 静默窗口 / MARKER 记账 / 缺目录不抛 / 返回结构");
{
  const home = mkRg("auto");
  const sess = makeSession(path.join(home, "sessions"), "s1");
  const fp = path.join(sess, LOGNAME);
  fs.writeFileSync(fp, dirtyLog); // 刚写过：mtime = now
  const markerPath = path.join(home, "dsh-market", MARKER_NAME);

  const keysWant = ["corrupt", "markerPath", "repaired", "scanned", "skipped"].sort();
  const quiet = await autoRepairSessions({ dshHome: home, quietMs: 120000, log: noop });
  check("auto返回键集合精确", JSON.stringify(Object.keys(quiet).sort()) === JSON.stringify(keysWant), JSON.stringify(Object.keys(quiet).sort()));
  check("auto.scanned计文件数", quiet.scanned === 1, String(quiet.scanned));
  check("auto.corrupt计数为1", quiet.corrupt === 1, String(quiet.corrupt));
  check("静默窗口内不修", Array.isArray(quiet.repaired) && quiet.repaired.length === 0, JSON.stringify(quiet.repaired));
  check("静默窗口给出原因", quiet.skipped.length === 1 && String(quiet.skipped[0].reason).includes("仍在写入"), JSON.stringify(quiet.skipped));
  check("刚写过的会话文件零改动", fs.readFileSync(fp).equals(dirtyLog), "静默窗口内文件被改");
  check("静默窗口不建MARKER", !fs.existsSync(markerPath), "marker 提前出现");

  const dry = await autoRepairSessions({ dshHome: home, quietMs: 0, dryRun: true, log: noop });
  check("auto.dryRun只报不改", dry.corrupt === 1 && dry.repaired.length === 1 && dry.repaired[0].dryRun === true && fs.readFileSync(fp).equals(dirtyLog), JSON.stringify(dry.repaired));
  check("auto.dryRun不写MARKER", !fs.existsSync(markerPath), "dryRun 写了 marker");

  fs.utimesSync(fp, new Date(Date.now() - 600000), new Date(Date.now() - 600000)); // 老化出静默窗口
  const logs = [];
  const real = await autoRepairSessions({ dshHome: home, quietMs: 120000, log: function (lv, m) { logs.push([lv, String(m)]); } });
  check("离开静默窗口才修", real.corrupt === 1 && real.repaired.length === 1 && real.skipped.length === 0, JSON.stringify(real));
  check("修复记录键精确", JSON.stringify(Object.keys(real.repaired[0]).sort()) === JSON.stringify(["at", "backup", "by", "dropped", "file", "keepEvents", "reason", "seq"]), JSON.stringify(Object.keys(real.repaired[0]).sort()));
  check("修复记录归因与计数", real.repaired[0].by === "dsh-market/auto" && real.repaired[0].seq === 9 && real.repaired[0].dropped === 1 && real.repaired[0].keepEvents === 2, JSON.stringify(real.repaired[0]));
  check("MARKER落在dsh-market下", real.markerPath === markerPath, String(real.markerPath));
  check("MARKER已生成且记账1条", fs.existsSync(markerPath) && JSON.parse(fs.readFileSync(markerPath, "utf8")).length === 1, "");
  const marker0 = JSON.parse(fs.readFileSync(markerPath, "utf8"))[0];
  check("MARKER记录含真实备份指针", typeof marker0.backup === "string" && fs.existsSync(marker0.backup), String(marker0.backup));
  check("MARKER是数组文本而非对象", Array.isArray(JSON.parse(fs.readFileSync(markerPath, "utf8"))), "");
  check("修复日志提到seq与丢弃数", logs.some(function (l) { return l[0] === "info" && l[1].includes("自动修复会话") && l[1].includes("seq 9") && l[1].includes("丢弃 1 条"); }), JSON.stringify(logs));
  check("修复后会话已干净", (await inspectSessionLog(fp)).corrupt === false, "");

  const again = await autoRepairSessions({ dshHome: home, quietMs: 0, log: noop });
  check("同一路径二次不再修", again.corrupt === 0 && again.repaired.length === 0 && again.skipped.length === 0, JSON.stringify(again));
  check("MARKER不被重复记账", JSON.parse(fs.readFileSync(markerPath, "utf8")).length === 1, "重复记账");

  let g1 = null;
  let gErr = null;
  try {
    g1 = await autoRepairSessions({ dshHome: path.join(home, "no-such-home"), log: noop });
  } catch (e) {
    gErr = e.message;
  }
  check("dshHome不存在不抛穿", gErr === null && g1 !== null, gErr);
  check("dshHome不存在时四项皆空", !!g1 && g1.scanned === 0 && g1.corrupt === 0 && g1.repaired.length === 0 && g1.skipped.length === 0, JSON.stringify(g1));
  check("dshHome不存在时不建marker", !!g1 && !fs.existsSync(g1.markerPath), String(g1 && g1.markerPath));

  const bare = await autoRepairSessions({ dshHome: mkRg("bare"), log: noop });
  check("无sessions目录不抛", bare.scanned === 0 && bare.corrupt === 0, JSON.stringify(bare));

  const notZstd = makeSession(path.join(home, "sessions"), "s2");
  fs.writeFileSync(path.join(notZstd, LOGNAME), Buffer.from("plain text, not a zstd frame", "utf8"));
  fs.writeFileSync(path.join(notZstd, "other.v4.jsonl.zstd"), dirtyLog); // 非 collectSessionLogs 认的名字
  const batch = await autoRepairSessions({ dshHome: home, quietMs: 0, log: noop });
  check("坏文件不中断批次", batch.scanned === 2 && batch.skipped.length === 1 && String(batch.skipped[0].reason).includes("无法解码"), JSON.stringify(batch));
  check("非会话文件名被忽略", batch.scanned === 2, String(batch.scanned));
}

section("Test 8: installToolCallGuard 幂等闩 / 降级 / 可核对性");
{
  // 假宿主 fixture：按 src/toolcall-guard.js:3-6 注释描述的 push/assembled 接口复刻；assembled()
  // 必须能被无参调用（包装器 src/toolcall-guard.js:57 是 originalAssembled.call(this)）。
  // 真实宿主 BlockAssembler 在 app.asar 内不可读，本套件不锁宿主实现（见末尾说明）。
  const buildFixture = function (root) {
    const dshDir = path.join(root, "app.asar", "dsh");
    const pkgDir = path.join(dshDir, "node_modules", "@deepseek-ai", "dsh-llm");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(dshDir, "package.json"), JSON.stringify({ name: "dsh", version: "0.0.0" }));
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-llm", version: "0.0.0-fake", main: "index.js" }));
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      [
        "class BlockAssembler {",
        "  constructor() { this.partials = new Map(); }",
        "  push(chunk) {",
        "    if (!chunk || chunk.type !== \"tool-call-delta\") return;",
        "    const i = chunk.index;",
        "    let p = this.partials.get(i);",
        "    if (!p) { p = {}; this.partials.set(i, p); }",
        "    if (\"id\" in chunk) p.toolCallId = chunk.id;",
        "    if (\"name\" in chunk) p.toolCallName = chunk.name;",
        "    if (chunk.argsFragment) p.args = (p.args || \"\") + chunk.argsFragment;",
        "  }",
        "  assembled(result) {",
        "    const blocks = [];",
        "    for (const p of this.partials.values()) {",
        "      blocks.push({ type: \"tool-call\", id: p.toolCallId, name: p.toolCallName, args: p.args || \"\" });",
        "    }",
        "    return Object.assign({}, result, { blocks: blocks });",
        "  }",
        "}",
        "module.exports = { BlockAssembler };",
        "",
      ].join("\n")
    );
    return createRequire(path.join(dshDir, "package.json"))("@deepseek-ai/dsh-llm").BlockAssembler;
  };

  const root = mkRg("guard");
  const Assembler = buildFixture(root);
  const proto = Assembler.prototype;
  const glogs = [];
  const g1 = installToolCallGuard({ resourcesPath: root, log: function (lv, m) { glogs.push([lv, String(m)]); } });
  check("首次安装ok", g1.ok === true && g1.dropped === 0, JSON.stringify(g1));
  check("原型挂上幂等闩Symbol", proto[GUARD_SYMBOL] === true, String(proto[GUARD_SYMBOL]));
  check("闩不可枚举（不污染原型）", Object.prototype.propertyIsEnumerable.call(proto, GUARD_SYMBOL) === false, "");
  check("push/assembled已被替换", proto.push.name === "guardedPush" && proto.assembled.name === "guardedAssembled", JSON.stringify([proto.push.name, proto.assembled.name]));
  const pushRef = proto.push;
  const asmRef = proto.assembled;

  const g2 = installToolCallGuard({ resourcesPath: root, log: noop });
  check("二次调用不再打补丁", g2.ok === true && String(g2.reason).includes("已安装") && String(g2.reason).includes("重复调用被忽略"), JSON.stringify(g2));
  check("二次调用原型同一性不变", proto.push === pushRef && proto.assembled === asmRef, "二次安装重新包裹了方法");

  const fresh = await import(new URL("../src/toolcall-guard.js", import.meta.url).href + "?cb=1");
  const g3 = fresh.installToolCallGuard({ resourcesPath: root, log: noop });
  check("换模块实例仍认定已安装", String(g3.reason).includes("已安装"), JSON.stringify(g3));

  const bad = new Assembler();
  bad.push({ type: "tool-call-delta", index: 0, argsFragment: "{\"x\":1}" }); // 全程无 id/name
  const badRes = bad.assembled({ index: 0 });
  check("空id/name的tool-call被拦下", Array.isArray(badRes.blocks) && badRes.blocks.length === 0, JSON.stringify(badRes.blocks));
  check("dropped计数可核对", !!Assembler.__dshMarketGuardState && Assembler.__dshMarketGuardState.dropped === 1, JSON.stringify(Assembler.__dshMarketGuardState));
  check("拦下时有warn日志", glogs.some(function (l) { return l[0] === "warn" && l[1].includes("拦下") && l[1].includes("未写入会话日志"); }), JSON.stringify(glogs));

  const good = new Assembler();
  good.push({ type: "tool-call-delta", index: 1, id: "call_1", name: "run_code" });
  good.push({ type: "tool-call-delta", index: 1, argsFragment: "{\"p\":\"a\"}" });
  const goodRes = good.assembled({ index: 1 });
  check("正常块不被误伤", goodRes.blocks.length === 1 && goodRes.blocks[0].id === "call_1" && goodRes.blocks[0].name === "run_code" && goodRes.blocks[0].args === "{\"p\":\"a\"}", JSON.stringify(goodRes.blocks));
  check("未误伤则计数不增", Assembler.__dshMarketGuardState.dropped === 1, JSON.stringify(Assembler.__dshMarketGuardState));

  // push 前哨的抢救面（src/toolcall-guard.js:43-52）：provider 后续发一条 id/name 皆空的
  // tool-call-delta，未打补丁时会把已记录的 id 抹成空串，块只能等 assembled 兜底丢弃。
  const wipe = new Assembler();
  wipe.push({ type: "tool-call-delta", index: 2, id: "call_2", name: "pwsh" });
  const droppedBeforeWipe = Assembler.__dshMarketGuardState.dropped;
  wipe.push({ type: "tool-call-delta", index: 2, id: "", name: "" });
  const wipeRes = wipe.assembled({ index: 2 });
  check("空delta不抹掉已有id（push前哨抢救）", wipeRes.blocks.length === 1 && wipeRes.blocks[0].id === "call_2" && wipeRes.blocks[0].name === "pwsh", JSON.stringify(wipeRes.blocks));
  check("抢救成功不增dropped计数", Assembler.__dshMarketGuardState.dropped === droppedBeforeWipe, JSON.stringify(Assembler.__dshMarketGuardState));
  check("首次安装返回不含reason（与新装可区分）", !("reason" in g1) && "reason" in g2, JSON.stringify([Object.keys(g1).sort(), Object.keys(g2).sort()]));

  const root2 = mkRg("guard2");
  const A2 = buildFixture(root2);
  const i2 = installToolCallGuard({ resourcesPath: root2, log: noop });
  check("未打补丁的另一宿主会被装上", i2.ok === true && A2.prototype[GUARD_SYMBOL] === true && A2.prototype.push.name === "guardedPush", JSON.stringify(i2));
  check("两个宿主计数互相独立", A2.__dshMarketGuardState !== Assembler.__dshMarketGuardState, "");

  let d1 = null;
  let d2 = null;
  let d3 = null;
  let dErr = null;
  try {
    d1 = installToolCallGuard({ resourcesPath: "", log: noop });
    d2 = installToolCallGuard({ log: noop }); // 无参：纯 node 下 process.resourcesPath 不存在
    d3 = installToolCallGuard({ resourcesPath: path.join(root, "no-such-dir"), log: noop });
  } catch (e) {
    dErr = e.message;
  }
  check("resourcesPath缺失不抛穿", dErr === null, dErr);
  check("resourcesPath缺失=ok:false+原因", !!d1 && d1.ok === false && d1.dropped === 0 && String(d1.reason).includes("找不到 resourcesPath"), JSON.stringify(d1));
  check("无参调用同样降级", !!d2 && d2.ok === false && String(d2.reason).includes("找不到 resourcesPath"), JSON.stringify(d2));
  check("目标文件缺失=解析失败不抛", !!d3 && d3.ok === false && d3.dropped === 0 && String(d3.reason).includes("无法解析 @deepseek-ai/dsh-llm"), JSON.stringify(d3));
  check("降级返回键集合精确", !!d1 && JSON.stringify(Object.keys(d1).sort()) === JSON.stringify(["dropped", "ok", "reason"]), JSON.stringify(Object.keys(d1 || {}).sort()));
}

for (const dir of trash) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log("");
console.log("本套件不锁（照实说明，不用 stub 造假绿）：");
console.log("  - 宿主真实 zstd 帧与宿主 BlockAssembler 实现：不锁。原因：app.asar 内的 dsh 目录在纯 node");
console.log("    下不是可读路径，真实宿主代码不可核；guard 只按 src/toolcall-guard.js:3-6 的接口注释造");
console.log("    fixture，锁的是插件侧行为（打补丁/幂等/拦截/降级），不是宿主真实实现。");
console.log("  - writeFile 与 rename 之间被杀的崩溃窗口：不锁。原因：无法在不 spawn 宿主、不注入故障的");
console.log("    前提下确定性复现；改以等价不变量锁住——硬链仍持原文 + 目录无 .repair-tmp 残留，即");
console.log("    「外部观察不到中途态」。");
console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed > 0 ? 1 : 0;
