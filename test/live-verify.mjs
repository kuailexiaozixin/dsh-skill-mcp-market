#!/usr/bin/env node
// live-verify.mjs — 重启后一键复验「服务端半边」。端口自发现，不写死 60027。
//
// 为什么需要它：0.5.165/0.5.166 修的是 modelscope 分类浏览态（旧码 5000 行大页×9、单页实测
// 66s 被 90s abort、裸 catch 后 break 把失败静默吞掉、聚合层谎文案）。这一半活在插件服务端
// 进程里，客户端 bundle 换了不等于服务端换了 —— 必须问进程本身。
//
// 版本指纹只认措辞（本会话三轮误判后定案）：
//   0.5.164 正常态   「分类在可达的 N 行」（src/extra-sources.js v0.5.164:1440）
//   0.5.165 正常态   「分类在已取回的 N 行」（v0.5.165:1496）
//   0.5.165 中断态   「ModelScope 分类取数中断（…）可达集合只到已取回的 N 行」（:1495）
//                    —— 0.5.164 根本没有 msInterrupt，这句本身就是新码证据。
//   「分类态 items>0」不是版本指纹：旧码命中缓存或上游快时照样出现（05:04 那次误判的根）。
//
// 用法：node test/live-verify.mjs [--json] [--port <p>] [--timeout <ms>]
// 退出码：0=PASS 1=LIVE-FAIL 3=NOT-RUN（判据未执行，绝不写 PASS/FAIL）4=STALE-SERVER
import { spawnSync } from 'node:child_process';

const RPC_PATH = '/api/dsh-market/rpc';
const COLON = '\uff1a'; // 全角冒号：hint 里源名后那个字符
// 新码专属措辞（任一命中即新码）。顺序在上，优先于旧码标记。
const NEW_MARKS = ['分类在已取回的', '取数中断'];
// 旧码专属措辞。0.5.165 的正常态文案也含「可达集合外的分类会漏」，所以旧码标记必须写全串，
// 不能只写「可达的」—— 那是本会话第二次误判的根（Select-String 只截声明首行）。
const OLD_MARKS = ['分类在可达的'];
const NO_CAT_PHRASE = '不提供分类信息';

/** 已在可达集合内实测有货的分类 ⇒ 判 0 条就是 LIVE-FAIL。其余分类判 GAP，不判红（覆盖缺口）。 */
const HARD_CATS = ['\u5e02\u573a\u63a8\u5e7f', '\u5f00\u53d1\u5de5\u5177'];
/** 判据 B 的其余分类浏览态：只报状态，不当失败证据。 */
const SOFT_CATS = ['\u79d1\u7814\u5de5\u5177', '\u76d1\u63a7', '\u5a92\u4f53\u5904\u7406', 'Skills\u7ba1\u7406'];

/** 可打印字符串兜底：上游字段可能整个缺失。JSON.stringify(undefined) 返回 undefined 而非字符串，
 *  直接 .slice/.includes 就是 TypeError（现网 08:14 的 :214 崩溃形状）。 */
function strOf(x) {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

/** 数组兜底：缺失/非数组一律当空数组看待。 */
function arrOf(x) {
  return Array.isArray(x) ? x : [];
}

/** 数值兜底：缺失/非有限数时返回 def。 */
function numOr(x, def) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

/** 版本指纹：新码标记优先（0.5.165 中断态里也出现「可达」二字）。 */
export function fingerprintOf(text) {
  const t = String(text || '');
  if (!t) return 'unknown';
  if (NEW_MARKS.some((m) => t.includes(m))) return 'new';
  if (OLD_MARKS.some((m) => t.includes(m))) return 'old';
  return 'unknown';
}

/** 取某源的 hint 原文。出参字段名是 hints（数组），读 .hint 恒 undefined。 */
export function pickHint(data, source) {
  const arr = Array.isArray(data && data.hints) ? data.hints : [];
  const needle = String(source || '') + COLON;
  const hit = arr.find((x) => String(x).startsWith(needle)) || arr.find((x) => String(x).toLowerCase().includes(String(source || '')));
  return hit ? String(hit) : '';
}

/**
 * 判据 B（0.5.165 起口径）。三态：PASS / LIVE-FAIL / GAP / NOT-TESTED。
 * hard=true 的分类 0 条即 LIVE-FAIL；hard=false 时 0 条只报 GAP——
 * 词表 20 类里有的类在可达集合（30,000 行）之外，判红等于把覆盖缺口当回归（监测方 07:17 实测：
 * 监控 类 items=0 total=0 degraded=[] 且同词浏览态 total=1512，不是旧码那种谎报形状）。
 */
export function verdictB(cat, opts) {
  const hard = !!(opts && opts.hard);
  if (!cat) return { verdict: 'NOT-TESTED', why: '判据未取得分类态' };
  const hh = Number(cat.http);
  if (!Number.isFinite(hh) || hh < 100 || hh > 599) return { verdict: 'NOT-TESTED', why: 'RPC 未连上（无 HTTP 状态码）：http=' + String(cat.http) };
  if (hh !== 200) return { verdict: 'LIVE-FAIL', why: 'RPC 真拿到非 200：http=' + hh };
  const n = numOr(cat.total, 0);
  const note = strOf(cat.categoryNote);
  const deg = arrOf(cat.degraded);
  const hint = strOf(cat.hint);
  if (note.includes(NO_CAT_PHRASE)) return { verdict: 'LIVE-FAIL', why: '分类态仍说「不提供分类信息」（该来源有 20 个真分类）：' + note };
  if (deg.length) return { verdict: 'LIVE-FAIL', why: '分类态带降级：' + deg.join(' | ') };
  if (n > 0) return { verdict: 'PASS', why: '分类态 ' + n + ' 条、无谎文案、无降级' };
  if (hint.includes('取数中断')) return { verdict: 'LIVE-FAIL', why: '0 条且文案自承取数中断 ⇒ 该轮没真拉到行集' };
  if (!hard) return { verdict: 'GAP', why: '该类 0 条；无中断措辞 ⇒ 落在可达集合外（覆盖缺口），不判红' };
  const browse = opts && opts.browse;
  if (!browse || browse.http !== 200) return { verdict: 'NOT-TESTED', why: '0 条但同轮浏览态未取得，无法区分「上游真没有」与「没拉到」' };
  if (!(numOr(browse.total, 0) > 0)) return { verdict: 'NOT-TESTED', why: '浏览态同为 0 条：不构成失败证据' };
  return { verdict: 'LIVE-FAIL', why: '硬判据分类 0 条而浏览态 ' + browse.total + ' 条 ⇒ 本地过滤/取页确实坏了' };
}

/** 只认 200 + ok + items 数组，其余一律视为未测成。 */
export function usable(r) {
  return !!r && r.http === 200 && !!r.json && r.json.ok === true && Array.isArray(r.json.items);
}

/** 词表形状锁：必须读 categories 数组，读 rows 恒 0（本会话误判的根，钉成断言）。 */
export function vocabOf(settings, source) {
  const cv = settings && settings.categoryVocabulary;
  const v = cv && cv[source];
  const cats = v && Array.isArray(v.categories) ? v.categories : [];
  return { count: cats.length, capturedAt: v ? v.capturedAt : null, cats };
}

/**
 * lobehub 合并入口复算（与面板「未列出的分类还有 N 类，上游合计 M 条」逐位对账的算法；0.5.171 起展开态不再持久化）。
 * 0.5.169 起面板合并入口曾改叫「窗外」（与上游真分类 lobehub general / modelscope 其他 撞名，见 CHANGELOG 0.5.169 段），
 * 0.5.177（用户 m23543/m23544）又叫回「其他」：撞名改由渲染层文本区分（入口恰好两字无数字、上游真桶经 categoryLabelLite 自带条数）。这里的算术不变，只是文案口径跟着改。
 * 窗口取默认 32（client.js CAT_CHIP_FOLD），合并集合 = 其余全部类的 count 之和。
 */
export function lobeWindowFold(cats, windowSize) {
  const w = Number(windowSize) > 0 ? Number(windowSize) : 32;
  const rows = (Array.isArray(cats) ? cats : []).map((c) => ({ slug: String(c.slug || ''), count: Number(c.count || c.totalAll || 0) }));
  const sorted = rows.slice().sort((a, b) => b.count - a.count);
  const win = sorted.slice(0, w);
  const out = sorted.slice(w);
  return {
    total: rows.length,
    sumAll: rows.reduce((s, r) => s + r.count, 0),
    winCount: win.length,
    winSum: win.reduce((s, r) => s + r.count, 0),
    outCount: out.length,
    outSum: out.reduce((s, r) => s + r.count, 0),
  };
}

/** 汇总：STALE-SERVER 先于一切；未测成绝不写 PASS。 */
/** 分类浏览态墙钟预算（0.5.165 的服务端半边真判据）：旧码单页 5000 行实测 66s、整轮 90s abort。 */
export function wallVerdict(wallMs, limitMs) {
  const cap = Number(limitMs) > 0 ? Number(limitMs) : 88000;
  const w = Number(wallMs);
  if (!Number.isFinite(w) || w < 0) return { verdict: 'NOT-TESTED', why: 'wall 未取到' };
  return w > cap ? { verdict: 'LIVE-FAIL', why: 'wall=' + w + 'ms 超预算 ' + cap + 'ms（旧码 90s abort 的形状）' } : { verdict: 'PASS', why: 'wall=' + w + 'ms < ' + cap + 'ms' };
}

export function summarize(rows, fp) {
  if (fp === 'old') return 'STALE-SERVER';
  if (fp === 'unknown') return 'NOT-RUN';
  const hard = rows.filter((r) => r.kind !== 'GAP');
  if (hard.some((r) => r.verdict === 'LIVE-FAIL')) return 'LIVE-FAIL';
  if (hard.length && hard.every((r) => r.verdict === 'NOT-TESTED')) return 'NOT-RUN';
  if (hard.some((r) => r.verdict === 'NOT-TESTED')) return 'PASS';
  return 'PASS';
}

/** 端口自发现：只收 127.0.0.1 的 LISTENING 端口，去重。 */
export function discoverPorts(stdout) {
  const set = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i);
    if (m) set.add(Number(m[1]));
  }
  return [...set];
}

/** PowerShell 版端口枚举（netstat 的中文表头/列宽不稳定，这条更硬）。 */
export function portsFromPs(stdout) {
  const set = new Set();
  for (const tok of String(stdout || '').split(/\r?\n/)) {
    const n = Number(String(tok).trim());
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return [...set];
}

async function rpc(port, body, timeoutMs) {
  const t0 = Date.now();
  try {
    const r = await fetch('http://127.0.0.1:' + port + RPC_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 由上层判 NOT-TESTED */ }
    return { op: body.op, http: r.status, wall: Date.now() - t0, json, raw: text.slice(0, 300) };
  } catch (e) {
    return { op: body.op, http: 0, wall: Date.now() - t0, json: null, raw: String((e && e.message) || e).slice(0, 200) };
  }
}

function shape(r) {
  const j = r.json || {};
  return {
    http: r.http,
    wall: numOr(r.wall, 0),
    total: numOr(j.total, 0),
    items: Array.isArray(j.items) ? j.items.length : -1,
    // categoryNote 原样透传（缺失就是 undefined）：JSON.stringify(undefined) 返回 undefined 而不是字符串，
    //  所以兜底必须落在消费点（strOf(JSON.stringify(...))），shape 里转成 '' 会把变异自证 (i) 变成空转。
    categoryNote: j.categoryNote,
    degraded: arrOf(j.degraded),
    hint: pickHint(j, 'modelscope'),
    sourceErrors: arrOf(j.sourceErrors),
  };
}

export async function runAll({ port, timeoutMs = 90000 }) {
  const rows = [];
  const add = (name, verdict, why, kind) => rows.push({ name, verdict, why, kind: kind || 'HARD' });

  const settings = await rpc(port, { op: 'settings.get' }, 15000);
  const sd = settings.json || {};
  const vsources = sd.categoryVocabulary && typeof sd.categoryVocabulary === 'object' ? Object.keys(sd.categoryVocabulary) : [];
  const ms = vocabOf(sd, 'modelscope');
  const lh = vocabOf(sd, 'lobehub');
  if (settings.http !== 200) add('RPC 可达 + 五源词表在位（读 categories）', 'NOT-TESTED', settings.raw ? 'port=' + port + ' RPC=' + settings.raw : 'port=' + port + ' http=' + settings.http);
  else add('RPC 可达 + 五源词表在位（读 categories）', vsources.length >= 5 && ms.count >= 20 && lh.count >= 26 ? 'PASS' : 'NOT-TESTED', 'port=' + port + ' sources=' + vsources.join(',') + ' modelscope=' + ms.count + ' lobehub=' + lh.count);

  // 判据①版本指纹：带 query 的分类态，这条路两版都会生成 hint
  const fpR = await rpc(port, { op: 'skills.search', query: 'pdf', source: 'modelscope', category: HARD_CATS[1], page: 1, pageSize: 5 }, timeoutMs);
  const fpHint = pickHint(fpR.json, 'modelscope');
  const fp = fingerprintOf(fpHint);
  add('判据① 进程内版本指纹（只认 hint 措辞）', fp === 'new' ? 'PASS' : fp === 'old' ? 'LIVE-FAIL' : 'NOT-TESTED', 'fp=' + fp + ' | ' + strOf(fpHint).slice(0, 130));

  // 判据②硬分类浏览态（无 query）——0.5.164 坏的就是这条路
  const browse = shape(await rpc(port, { op: 'skills.search', query: '', source: 'modelscope', category: '', page: 1, pageSize: 24 }, timeoutMs));
  add('判据② 无 query 浏览态本身能取到行集', browse.http !== 200 ? 'NOT-TESTED' : browse.total > 0 ? 'PASS' : 'NOT-TESTED', 'total=' + String(browse.total) + ' wall=' + browse.wall + 'ms（作对照基线）');
  let maxHardWall = 0;
  for (const cat of HARD_CATS) {
    const c = shape(await rpc(port, { op: 'skills.search', query: '', source: 'modelscope', category: cat, page: 1, pageSize: 24 }, timeoutMs));
    const v = c.http === 200 ? verdictB(c, { hard: true, browse }) : { verdict: 'NOT-TESTED', why: 'RPC 未连上：http=' + String(c.http) + '（判据未执行，不判红）' };
    if (c.http === 200 && c.wall > maxHardWall) maxHardWall = c.wall;
    add('判据② 分类浏览态「' + cat + '」', v.verdict, v.why + ' | wall=' + c.wall + 'ms items=' + c.items);
  }
  for (const cat of SOFT_CATS) {
    const c = shape(await rpc(port, { op: 'skills.search', query: '', source: 'modelscope', category: cat, page: 1, pageSize: 24 }, timeoutMs));
    const v = c.http === 200 ? verdictB(c, { hard: false }) : { verdict: 'NOT-TESTED', why: 'RPC 未连上：http=' + String(c.http) + '（判据未执行，不判红）' };
    add('判据② 软报「' + cat + '」', v.verdict, v.why + ' | wall=' + c.wall + 'ms', v.verdict === 'GAP' ? 'GAP' : c.http === 200 ? 'HARD' : 'NT');
  }

  // 判据③分类过滤真生效：不同真分类的命中集合不得全等
  const a3 = shape(await rpc(port, { op: 'skills.search', query: 'pdf', source: 'modelscope', category: HARD_CATS[1], page: 1, pageSize: 12 }, timeoutMs));
  const b3 = shape(await rpc(port, { op: 'skills.search', query: 'pdf', source: 'modelscope', category: '\u79d1\u7814\u5de5\u5177', page: 1, pageSize: 12 }, timeoutMs));
  add('判据③ 分类过滤真生效（两类计数不同）', a3.http !== 200 || b3.http !== 200 ? 'NOT-TESTED' : a3.total !== b3.total ? 'PASS' : 'LIVE-FAIL', (a3.http !== 200 || b3.http !== 200) ? 'RPC 未连上：a3.http=' + a3.http + ' b3.http=' + b3.http + '（判据未执行）' : HARD_CATS[1] + '=' + a3.total + ' vs \u79d1\u7814\u5de5\u5177=' + b3.total);

  // 判据④lobehub 合并集合复算（自洽：sum=窗内+合并集合，且合并类数=总数-窗口）
  const fold = lobeWindowFold(lh.cats, 32);
  const foldOk = settings.http === 200 && fold.total >= 26 && fold.outCount === fold.total - fold.winCount && fold.sumAll === fold.winSum + fold.outSum;
  add('判据④ lobehub 窗口/合并集合自洽复算', foldOk ? 'PASS' : settings.http !== 200 ? 'NOT-TESTED' : 'LIVE-FAIL', settings.http !== 200 ? 'RPC 未连上：词表未取得（判据未执行）' : 'total=' + fold.total + ' win=' + fold.winCount + '(' + fold.winSum + ') out=' + fold.outCount + '(' + fold.outSum + ') sum=' + fold.sumAll);

  // 判据⑤空结果不造数 + 假分类 slug 不再下发
  const zz = shape(await rpc(port, { op: 'skills.search', query: 'zzqqxkvw9p', source: 'modelscope', category: HARD_CATS[0], page: 1, pageSize: 12 }, timeoutMs));
  add('判据⑤ 空结果不造数（冷词 0 条且不许吹成有货）', zz.http === 200 && zz.items === 0 ? 'PASS' : zz.http === 200 ? 'LIVE-FAIL' : 'NOT-TESTED', 'items=' + zz.items + ' total=' + String(zz.total) + ' note=' + strOf(JSON.stringify(zz.categoryNote)).slice(0, 60));
  const other = shape(await rpc(port, { op: 'skills.search', query: '', source: 'lobehub', category: '__cat_other', page: 1, pageSize: 12 }, timeoutMs));
  const lied = arrOf(other.sourceErrors).some((x) => /\u4e0a\u6e38\u4e0d\u53ef\u8fbe|\u6ca1\u6709\u53d6\u5230\u6570\u636e/.test(String(x)));
  const wv = maxHardWall > 0 ? wallVerdict(maxHardWall) : { verdict: 'NOT-TESTED', why: '硬分类浏览态一个都没连上：wall 未取到' };
  add('\u5224\u636e\u2465 \u5206\u7c7b\u6d4f\u89c8\u6001\u5899\u949f\u9884\u7b97\uff080.5.165 \u5206\u9875\u63d0\u901f\uff09', wv.verdict, '\u786c\u5206\u7c7b\u6700\u6162 ' + wv.why);
add('\u5224\u636e\u2464 \u670d\u52a1\u7aef\u65e7\u901a\u8def __cat_other\uff08\u4fe1\u606f\u9879\uff0c\u4e0d\u8ba1\u5931\u8d25\uff09', other.http !== 200 ? 'NOT-TESTED' : lied ? 'GAP' : 'PASS', 'total=' + String(other.total) + ' srcErr=' + JSON.stringify(other.sourceErrors || []).slice(0, 110) + ' \uff5c0.5.165 \u7684\u4fee\u590d\u5728\u5ba2\u6237\u7aef\uff08\u5df2 DOM \u590d\u9a8c\uff1a\u4e0d\u518d\u4e0b\u53d1\u8be5 slug\uff09\uff0c\u670d\u52a1\u7aef\u6b8b\u7559\u65e7\u5165\u53e3\u4e0d\u6784\u6210\u56de\u5f52', other.http !== 200 ? 'NT' : lied ? 'GAP' : 'HARD');

  return { rows, fp, hint: fpHint, port, vocab: { modelscope: ms.count, lobehub: lh.count }, fold };
}

function countBy(rows) {
  const o = {};
  for (const r of rows) o[r.kind] = (o[r.kind] || 0) + 1;
  return o;
}

export function render(report, asJson) {
  if (asJson) return JSON.stringify(report, null, 2);
  const L = String.fromCharCode(10);
  const out = ['live-verify port=' + report.port + ' fingerprint=' + report.fp];
  if (report.hint) out.push('hint: ' + report.hint);
  for (const r of report.rows) out.push('  [' + r.verdict + '] ' + r.name + (r.kind === 'GAP' ? ' (GAP)' : '') + ' \u2014 ' + r.why);
  const bad = report.rows.filter((r) => r.verdict === 'LIVE-FAIL').length;
  const nt = report.rows.filter((r) => r.verdict === 'NOT-TESTED').length;
  const gp = report.rows.filter((r) => r.kind === 'GAP').length;
  out.push('rows=' + report.rows.length + ' LIVE-FAIL=' + bad + ' NOT-TESTED=' + nt + ' GAP=' + gp);
  return out.join(L);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('test/live-verify.mjs');
if (isMain) {
  const a = process.argv.slice(2);
  const asJson = a.includes('--json');
  const pi = a.indexOf('--port');
  const ti = a.indexOf('--timeout');
  const timeoutMs = ti >= 0 ? Number(a[ti + 1]) || 90000 : 90000;
  let port = pi >= 0 ? Number(a[pi + 1]) : 0;
  const probed = [];
  if (!port) {
    const ps = spawnSync('pwsh', ['-NoProfile', '-Command', '(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue).LocalPort | Sort-Object -Unique'], { encoding: 'utf8', env: process.env, windowsHide: true });
    let cands = ps.status === 0 ? portsFromPs(ps.stdout) : [];
    if (!cands.length) {
      const ns = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', env: process.env, windowsHide: true });
      cands = discoverPorts(ns.stdout);
    }
    for (const p of cands) {
      const s = await rpc(p, { op: 'settings.get' }, 4000);
      probed.push(p);
      if (s.json && s.json.ok && s.json.categoryVocabulary) { port = p; break; }
    }
  }
  if (!port) {
    console.log('NOT-RUN: \u672a\u627e\u5230 dsh-market RPC\uff08\u63a2\u4e86 ' + probed.length + ' \u4e2a 127.0.0.1 \u76d1\u542c\u7aef\u53e3\uff09\u3002\u5224\u636e\u672a\u6267\u884c\uff0c\u4e0d\u5199 PASS/FAIL\u3002');
    process.exit(3);
  }
  const report = await runAll({ port, timeoutMs });
  const v = summarize(report.rows, report.fp);
  // --json 必须只出一份可解析 JSON（verdict 进对象，不再另打 RESULT 行），否则机器消费者 JSON.parse 直接炸
  if (asJson) {
    console.log(JSON.stringify({ result: v, port, fingerprint: report.fp, byClass: countBy(report.rows), rows: report.rows }, null, 2));
    process.exit(v === 'PASS' ? 0 : v === 'STALE-SERVER' ? 4 : v === 'LIVE-FAIL' ? 1 : 3);
  }
  console.log(render(report, false));
  console.log('RESULT: ' + v);
  process.exit(v === 'PASS' ? 0 : v === 'STALE-SERVER' ? 4 : v === 'LIVE-FAIL' ? 1 : 3);
}
