// Four more live sources, each following the reference implementation's own endpoint:
//   clawhub   — clawhub.ai/api/v1  (browse honours limit; search answers 10 rows per page)
//   trusttools— ai.trusttools.cn/api/skills/search (POST, item carries repo_url/repo_path)
//   LobeHub   — @lobehub/market-cli skills search/install (official CLI, 33万+ skills)
//   skillsmp  — skillsmp.com/api/skills (paged search; Cloudflare-fronted, needs the curl
//               transport because this process's own TLS fingerprint is refused)
//   modelscope— modelscope.cn/api/v1/dolphin/skills (PUT, PageNumber/PageSize + TotalCount)
// Every source here answers a real `page`: either the upstream pages, or a whole catalogue
// is fetched once and sliced locally. That is what makes「加载更多」actually extend the list.
import { getJsonEscalating, postJsonEscalating, pythonText } from "./http.js";
import { execFile } from "node:child_process";
const isWinCli = process.platform === "win32";
function cliRun(pkg, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = isWinCli
      ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", "npx -y " + pkg + " " + args.map((a) => JSON.stringify(a)).join(" ")]
      : ["npx", "-y", pkg, ...args];
    execFile(cmd[0], cmd.slice(1), { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(pkg + " CLI 失败：" + String((stderr || err.message || "")).slice(0, 160)));
      else resolve(String(stdout || ""));
    });
  });
}
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillMetaFromText } from "./frontmatter.js";
import { safeTempDir, childEnv } from "./home.js";

const UA = { "User-Agent": "dsh-skill-mcp-market/0.9", accept: "application/json" };

async function getJson(url, timeoutMs = 15000) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function postJson(url, body, timeoutMs = 15000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...UA, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/** Local page slice for sources whose upstream hands over a whole catalogue at once. */
function slice(rows, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  const all = Array.isArray(rows) ? rows : [];
  return { rows: all.slice((p - 1) * size, p * size), start: (p - 1) * size, size, all };
}

// ---------------------------------------------------------------- clawhub
// clawhub 的 fetch 在本机偶发瞬时中断（fetch failed），做一次网络重试，
// 避免把一次抖动当成「不可达」误导用户。
async function getJsonClawHub(url, attempt = 0) {
  try {
    // clawhub 的前端 CDN 对 Node 的 TLS/连接指纹时好时坏，所以走 fetch→curl→python 逐级降级。
    return await getJsonEscalating(url, { headers: UA, timeoutMs: 25000 });
  } catch (error) {
    if (attempt < 1 && /fetch failed|ETIMEDOUT|ECONNRESET|socket|network|timeout/i.test(String((error && error.message) || error))) {
      return getJsonClawHub(url, attempt + 1);
    }
    throw error;
  }
}

// clawhub 规范分类词表（GET /api/v1/skills/-/categories）。实测 2026-11-23：14 条、含 other、
// 顺序即站点目录显示顺序；每条只有 slug/label/description/icon 四个键——**上游不报条数**
// （文档原文「This is the public taxonomy, not a count of available skills」），所以面板的
// clawhub chip 只能显示标签，显示条数就是编数据。
const CLAWHUB_CATEGORIES_URL = "https://clawhub.ai/api/v1/skills/-/categories";
const CLAWHUB_VOCAB_KEY = "clawhub_categories_v1";
const CLAWHUB_VOCAB_TTL = 7 * 24 * 3600 * 1000;

/** payload → [{slug,label,description,icon}]。0 列纯函数；脏数据只留合法条目并去重。 */
export function parseClawhubCategories(payload) {
  const rows = (payload && Array.isArray(payload.categories)) ? payload.categories : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const slug = String(row.slug || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      label: String(row.label || "").trim() || slug,
      description: String(row.description || ""),
      icon: String(row.icon || ""),
    });
  }
  return out;
}

/** 抓取 + 7 天 TTL。命中回同一引用；抓取失败或解析为空一律 null 且绝不落空快照。 */
export async function clawhubCategoryVocabulary({ cache, getJson = getJsonClawHub, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(CLAWHUB_VOCAB_KEY, CLAWHUB_VOCAB_TTL);
    if (hit && Array.isArray(hit.categories) && hit.categories.length && at - Number(hit.capturedAt) < CLAWHUB_VOCAB_TTL) return hit;
  } catch {
    /* 缓存读失败只意味着这次要重取 */
  }
  let payload = null;
  try {
    payload = await getJson(CLAWHUB_CATEGORIES_URL);
  } catch {
    return null;
  }
  const categories = parseClawhubCategories(payload);
  // 0 条 = 上游改版，不是「clawhub 没有分类」：落空快照会把面板已有的派生 chip 一起关掉。
  if (!categories.length) return null;
  const value = { capturedAt: at, source: CLAWHUB_CATEGORIES_URL, categories };
  try { await cache.put(CLAWHUB_VOCAB_KEY, value); } catch {}
  return value;
}

/** 只读缓存：settings.get 用它，绝不在此处等网络。没有/过期都回 null。 */
export async function readClawhubCategoryVocabulary({ cache, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(CLAWHUB_VOCAB_KEY, CLAWHUB_VOCAB_TTL);
    if (hit && Array.isArray(hit.categories) && hit.categories.length && at - Number(hit.capturedAt) < CLAWHUB_VOCAB_TTL) return hit;
  } catch {
    /* 读失败按「没有词表」处理 */
  }
  return null;
}

// clawhubCategoryOf —— 分类载体的实测顺序：raw.category → raw.categories[0] → raw.topics[0]。
// 2026-11-22 复测（getJsonEscalating 直打真实端点，各 50 行样本）：/api/v1/search 行上
// categories 非空 50/50（如 ["knowledge"]）、topics 键 0/50、category 键 0/50；
// /api/v1/skills（browse）行上 categories 非空 49/49、topics 非空 27/49、category 键 0。
// 0.5.138 当年只看三行样本得出「载体是 topics、上游无 category 键」，据此只读 topics，
// 于是两条路径都存在的 categories 被整个丢弃，面板分类 chip 对 clawhub 永不出现。
// 保留 raw.category 优先（上游今天不给，给了就是权威值，test-clawhub-quality Test 9 锁它）；
// topics 仍作兜底（browse 侧真有）。取首项是**近似**：面板的分类过滤只作用于当前页并用
// categoryNote 明说（sources.js 的本地过滤分支），所以近似不会伪装成服务端过滤。
export function clawhubCategoryOf(raw) {
  const direct = String((raw && raw.category) || "").trim();
  if (direct) return direct;
  const firstNonEmpty = (v) => {
    if (!Array.isArray(v)) return "";
    for (const t of v) {
      const s = String(t || "").trim().toLowerCase();
      if (s) return s;
    }
    return "";
  };
  return firstNonEmpty(raw && raw.categories) || firstNonEmpty(raw && raw.topics);
}

// clawhubIdOf —— clawhub 条目的**身份**是 ownerHandle/slug 对（2026-11-22 实测 219 行 =
// search 100 + browse 119：ownerHandle+slug 齐全 219/219，176 个 distinct 身份对、同键多形态 0）。
// 上游 raw.id 不是身份：57/100 是自带 "clawhub:" 前缀的不透明 id
//（clawhub:kd75kdbc9phg92p12av465mbf1820dqb），另 43/100 是跨源形态 skills-sh:google/skills/<slug>；
// browse 行 0/119 有 raw.id。旧 id 公式 `clawhub:${raw.id || reference || raw.slug}` 于是同时产出
// clawhub:clawhub:<opaque> 与 clawhub:skills-sh:… 两种形态，而 item.id 正是翻页去重键（client.js:822
// new Set(prev.map(x => x.id))）→ 同一技能跨 search/browse 被算成两条。
// install.reference 不参与身份判定：跨源行的 reference 是真安装路由（skills-sh:<owner>/<repo>/<path>，
// 必须原样留在 installRef），拿它的切段当身份会把卡片 owner 写成 "skills-sh:google" 这类错值
//（实测 43/100 行如此，且卡片直接显示它）。CLI 降级行只有字符串 owner（:226 造 {name,owner,…}
// 无 ownerHandle），回落 raw.owner；两段缺任一段就返回空串——宁可空也不造假 id。
// 身份 = owner/slug 对。owner 有两种上游形态：ownerHandle 字符串（219/219 行都有），
// 以及 owner 对象 {handle,displayName,image}（search 100 行里 57 行是对象）——
// 直接 String(对象) 会写出 "[object Object]"，必须先取 .handle。
function clawhubOwnerOf(raw) {
  if (!raw) return "";
  if (raw.ownerHandle) return String(raw.ownerHandle).trim();
  const o = raw.owner;
  if (typeof o === "string") return o.trim();
  return String((o && o.handle) || "").trim();
}
export function clawhubIdOf(raw) {
  const owner = clawhubOwnerOf(raw);
  const slug = String((raw && raw.slug) || "").trim();
  return owner && slug ? `${owner}/${slug}` : "";
}

function mapClawHubRows(rows, q, mode, limitOverride) {
  const limit = limitOverride ?? 24;
  const items = (Array.isArray(rows) ? rows : []).slice(0, limit).map((raw) => {
    const install = raw.install || {};
    const reference =
      String(install.reference || "").trim() ||
      (raw.ownerHandle && raw.slug ? `${raw.ownerHandle}/${raw.slug}` : "");
    return {
      // 身份缺段时回落安装路由，绝不产出空 id（旧写法在这里会写成 clawhub:undefined）。
      id: `clawhub:${clawhubIdOf(raw) || reference}`,
      slug: raw.slug || String(raw.displayName || "").toLowerCase(),
      name: raw.displayName || raw.name || raw.slug || reference,
      description: raw.summary || raw.description || "",
      source: "clawhub",
      sourceLabel: "clawhub",
      owner: clawhubOwnerOf(raw),
      homepage: `https://clawhub.ai${raw.canonicalUrl || `/${reference}`}`,
      upstreamUrl: "",
      installRef: reference,
      // 两个量各取各的上游字段，不再互相复制。实测同一行 stats 里 downloads=494,474、
      // installs=18,549 —— 相差 26 倍：旧写法把 installs 也写成 downloads，卡片上的
      // 「N 次安装」实际是下载数（与 skillhub 那处同类的数据错误）。
      // browse 端点的量在 stats.*，search 端点在顶层 raw.downloads；两处都要读。
      downloads: Number(raw.downloads ?? raw.stats?.downloads ?? raw.metrics?.rolling60DayInstalls ?? 0) || 0,
      // installs 只认真实 installs 字段；缺失或为 0 就保持 0 —— 面板对 0 不显示该段，
      // 宁可不显示也不显示错数（不回落到 downloads）。
      installs: Number(raw.installs ?? raw.stats?.installs ?? 0) || 0,
      category: clawhubCategoryOf(raw),
      // 排序键的展示字段必须与 getter **同源**，否则「排了但看起来没排」：
      // browse 行量在 stats.*；search 行（实测 21 键）stars/createdAt 只挂在 native.skill.* 里，
      // 顶层没有 stars/createdAt → 旧写法在 search 卡片上恒为 0，按 stars 排完看起来像没排。
      stars: Number(raw.stars ?? raw.stats?.stars ?? raw.native?.skill?.stats?.stars) || 0,
      createdAt: Number(raw.createdAt ?? raw.native?.skill?.createdAt) || 0,
      updatedAt: Number(raw.updatedAt ?? raw.metrics?.updatedAt) || 0,
      installable: Boolean(reference),
      // 搜索端点无分页；浏览端点支持 limit。让客户端据此决定「加载更多」是否可用
      paged: mode === "browse",
    };
  });
  return { source: "clawhub", items, total: items.length };
}

// clawhub search 端点的本地排序表（实测 q=react 首行 21 键：
//   canonicalUrl,displayName,downloads,featured,icon,install,links,metrics,native,official,
//   ownerHandle,publisher,score,slug,source,sourceIdentity,summary,trust,updatedAt,version,owner
// 支撑情况（同一批 10 行实测）：
//   downloadCount → 顶层 downloads（10/10，number）；search 行没有安装数字段，
//                   旧键名 installCount 属名实不符（同一数据在 browse 行才有 stats.installs）
//   updated      → 顶层 updatedAt（10/10，epoch ms）
//   newest       → native.skill.createdAt（仅 5/10 有 native；缺失行按 0 沉底）
//   stars        → native.skill.stats.stars（同上 5/10；顶层 stars/stats.stars 在 search 行上恒空，
//                  :99 那套 `raw.stars ?? raw.stats?.stars` 只对 browse 行有效）
//   trending     → 无字段支撑：score 是相关性分桶（除前两条外全等），metrics.rolling60DayInstalls
//                  稀疏近零 → 故意不提供 getter，保持上游序（矩阵与线路的这一格仍不一致，已上报 lead）。
export const CLAWHUB_SEARCH_SORT_GETTERS = {
  downloadCount: (r) => r.downloads ?? r.metrics?.rolling60DayInstalls,
  name: (r) => r.displayName || r.slug,
  updated: (r) => Number(r.updatedAt) || 0,
  newest: (r) => Number(r.native?.skill?.createdAt) || 0,
  stars: (r) => Number(r.native?.skill?.stats?.stars) || 0,
};

const CLAWHUB_CATALOG_KEY = "clawhub_catalog_v1";
const CLAWHUB_CATALOG_TTL = 6 * 3600 * 1000;

// 浏览端点每屏 50 条并带 nextCursor（JSON 字符串），顺着它累积成本地目录再按页切片：
// 这样第 2 页、第 20 页拿到的都是真正的新条目，而不是上游的第一屏。
async function extendClawHubCatalog(cache, need, sortBy = "", category = "", fetchJson = getJsonClawHub) {
  // 缓存键必须含 category：否则「按分类浏览」会读到上一次全库浏览攒下的目录，
  // 那份目录里混着别的分类的条目，筛过的说法就是假话。
  const catKey = `clawhub_catalog_v1${sortBy ? ":" + sortBy : ""}${category ? ":cat:" + category : ""}`;
  let state = cache ? await cache.get(catKey, CLAWHUB_CATALOG_TTL) : undefined;
  if (!state || !Array.isArray(state.rows)) state = { rows: [], cursor: null, done: false };
  const seen = new Set(state.rows.map((raw) => clawhubIdOf(raw)));
  let guard = 0;
  // 上界必须真的检查：guard 变量早就存在但从未被判断，于是「每页返回同一批条目 +
  // 每页换一个 nextCursor」这种病态上游会让 state.rows.length 永远追不上 need，
  // 循环不结束（2026-11-23 注入实测 201 次仍未收敛）。生产里表现为整源挂到 12s
  // 预算被切断，也就是「clawhub 不可达」的另一种成因。
  const MAX_ROUNDS = 40;
  while (!state.done && state.rows.length < need && guard < MAX_ROUNDS) {
    guard += 1;
    const cursor = state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : "";
    const data = await fetchJson(`https://clawhub.ai/api/v1/skills?limit=50${sortBy ? `&sort=${encodeURIComponent(sortBy)}` : ""}${category ? `&category=${encodeURIComponent(category)}` : ""}${cursor}`);
    const rows = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
    for (const raw of rows) {
      const key = clawhubIdOf(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      state.rows.push(raw);
    }
    const next = data.nextCursor || null;
    if (rows.length === 0 || !next || next === state.cursor) state.done = true;
    else state.cursor = next;
  }
  if (cache) await cache.put(catKey, state);
  return state;
}

export async function searchClawHub({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "", fetchJson = getJsonClawHub }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const q = String(query || "").trim();
  // 分类 facet：上游 list 与 search 两个端点都认 category（2026-11-23 实测），
  // 所以这里发的是**服务端过滤**，不是「取回当前页再本地筛」。
  const facet = String(category || "").trim().toLowerCase();
  // 同一 (query,page,size,sort,category) 5 分钟内复用：clawhub 单次搜索取整个上游窗口再本地翻页。
  const cKey = `clawhub:search:${q.toLowerCase()}:${p}:${size}:${sort || ""}:${facet}`;
  // 词表能校验时先校验：上游 list 端点对无效 slug 回 400（能兜），但 search 端点回
  // 200 + 空 results（实测）——只看状态码分不开「这个分类里没匹配」与「上游根本没这个
  // 分类」，后者会被说成前者。词表在手时直接拒在本地，一次上游都不发。
  let facetRefused = false;
  let facetUsed = facet;
  const vocab = facet ? await readClawhubCategoryVocabulary({ cache }) : null;
  if (facet && vocab && !vocab.categories.some((c) => c.slug === facet)) {
    facetRefused = true;
    facetUsed = "";
  }
  if (cache) {
    const hit = await cache.get(cKey, 5 * 60 * 1000);
    if (hit && Array.isArray(hit.items) && hit.items.length) return { ...hit, source: "clawhub" };
  }
  if (q) {
    // 上游 /api/v1/search 实测：顶层只有 results（无 total/count）；page 参数被忽略
    // （page=1 与 page=2 首两条是同一批）；limit 生效但 100 是硬上限（limit=150/200/
    // 300/500/1000 恒回 100 条），且 limit=10 的返回正好是 limit=100 的同序前缀。
    // 所以取数口径 = 单次请求整个 100 条窗口 + 本地翻页。旧实现按 page 并发打 1–6 个
    // 假分页请求再拼窗口，实测 total 在页码之间跳（page1=11、page2=10）、page≥2 全空。
    const WINDOW_CAP = 100;
    const wanted = Math.min(60, size * p);
    const searchUrl = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}&limit=${WINDOW_CAP}${facetUsed ? `&category=${encodeURIComponent(facetUsed)}` : ""}`;
    let searchSettled = null;
    let searchFailure = null;
    try {
      searchSettled = await fetchJson(searchUrl);
    } catch (err) {
      searchFailure = err;
    }
    const settled = searchFailure ? [{ status: "rejected", reason: searchFailure }] : [{ status: "fulfilled", value: searchSettled }];
    if (settled.every((item) => item.status === "rejected")) {
      // Web API 全挂 → 官方 CLI 备用（表格文本按列解析；仅 Web 故障时启用）
      let cliRows = [];
      try {
        const text = await cliRun("clawhub", ["search", q, "--limit", String(wanted)]);
        cliRows = text.split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("npm") && !l.startsWith("🦞") && !l.startsWith("Usage:"))
          .map((l) => {
            const m = l.match(/^([\w-]+)\s+@([\w.-]+)\s+(.+?)\s+\d+ installs/);
            if (!m) return null;
            return { name: m[1], owner: m[2], displayName: m[3], slug: m[1] };
          })
          .filter(Boolean);
      } catch (cliErr) {
        throw new Error("clawhub Web API 与官方 CLI 均不可用：" + String((cliErr && cliErr.message) || cliErr).slice(0, 120));
      }
      if (cliRows.length) {
        const out = mapClawHubRows(cliRows, q, "search-cli", cliRows.length);
        out.total = cliRows.length;
        out.hasMore = false;
        out.hint = "clawhub Web API 不可达，结果来自官方 CLI（较慢）";
        if (cache && out.items && out.items.length) await cache.put(cKey, out);
        return out;
      }
      throw new Error("clawhub 搜索不可达（网络中断，已重试一次）");
    }
    const seen = new Set();
    const merged = [];
    for (const item of settled) {
      if (item.status !== "fulfilled") continue;
      const rows = Array.isArray(item.value?.results) ? item.value.results : Array.isArray(item.value?.items) ? item.value.items : [];
      for (const raw of rows) {
        const key = clawhubIdOf(raw) || String(raw.displayName ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(raw);
      }
    }
    // 单源排序责任在 handler（dispatcher 只对多源聚合排序）：
  // search 端点的 URL 不接受 sort（实测只认 q/page/limit），所以只能在已取回的窗口内本地排。
  // getter 必须逐键有真实字段支撑，无支撑的键一律不给 getter → sortRawRows 原样返回上游序。
  sortRawRows(merged, sort, CLAWHUB_SEARCH_SORT_GETTERS);
  const slicedRows = merged.slice((p - 1) * size, p * size);
    const out = mapClawHubRows(slicedRows, q, "search", slicedRows.length);
    // wanted 现在只服务 CLI 降级（Web 端点不再分页）。
    const capped = merged.length >= WINDOW_CAP;
    out.total = capped ? undefined : merged.length;
    out.hasMore = capped ? p * size < WINDOW_CAP : p * size < merged.length;
    out.totalPages = capped ? undefined : Math.max(1, Math.ceil(merged.length / size));
    if (capped) out.hint = `clawhub 搜索上游单次最多回 ${WINDOW_CAP} 条且不报总数，再往后的结果需要换关键词继续找`;
    out.serverFacet = facetUsed !== "";
    if (facetRefused) out.hint = `clawhub 没有「${facet}」这个分类，已按全部分类显示这一页`;
    if (cache && out.items && out.items.length) await cache.put(cKey, out);
    // total/hasMore/totalPages/hint 全部在 cache.put 之前赋值（旧写法把
    // totalPages 排在 put 之后，缓存副本因此少一个字段）。
    return out;
  }
  // 浏览：上游 browse 端点支持服务端全盘排序（实测 sort=downloads 跨 cursor 全局单调，首条≈494k）。
  // 旧实现是「预载 N 条再本地排」——那是窗口近似，禁止；现在把 sort 透传给上游，
  // 沿 nextCursor 累积到当前页深度即可保证全局序正确。
  // 上游 sort 值实测：downloads/stars/newest/updated/trending/name 均服务端全盘排序；
  // installs 不单调（数据质量差）→ 该源只能用下载数排，因此键名如实叫 downloadCount，
  // 不再顶着「按安装数」的名字排下载数（名称必须与排序方法一致）。
  const browseSort = sort === "downloadCount" ? "downloads"
    : sort === "stars" ? "stars"
      : sort === "newest" ? "newest"
        : sort === "updated" ? "updated"
          : sort === "trending" ? "trending"
            : sort === "name" ? "name" : "";
  // 预取口径按「上游每页给多少」分开：无分类浏览每次回满 50 条，多攒几页便宜，
  // 保持 size*(p+2) 让翻页秒开；带分类时上游实测每次只回 13 条（limit=50/100/197
  // 一样，文档：Bounded category reads may return a short or empty page with a
  // continuation），同样的口径意味着首页 24 条要打 7 次串行 cursor（实测 11402ms，
  // 正好撞满 12s 预算 → degraded=[clawhub]）。分类页因此只攒到本页所需 + 一页余量。
  // 分类页只攒到「够这一页」的量（size*p）：多攒一页余量看着省翻页，实际把首页延迟
  // 翻倍（13 条/轮 × 4 轮 ≈ 6s vs 2 轮 ≈ 3s），而目录本来就在缓存里累积，翻页是从
  // 断点继续、不是重打。无分类浏览每次回满 50 条，预取便宜，保持 size*(p+2)。
  const need = facetUsed ? Math.min(2000, size * p) : Math.min(2000, size * (p + 2));
  let state;
  try {
    state = await extendClawHubCatalog(cache, need, browseSort, facetUsed, fetchJson);
  } catch (err) {
    // list 端点对无效 slug 回 400（实测）。词表没落缓存时无法预知，所以被拒后去掉
    // category 重发一次：宁可给全库首页并说明，也不许整源进 degraded。
    if (!facetUsed || !/400/.test(String((err && err.message) || err))) throw err;
    facetRefused = true;
    facetUsed = "";
    state = await extendClawHubCatalog(cache, need, browseSort, "", fetchJson);
  }
  const rows = state.rows;
  const matched = rows.slice((p - 1) * size, p * size);
  const out = mapClawHubRows(matched, q, "browse", matched.length);
  if (!rows.length) out.hint = "clawhub 当前没有返回条目（可达，但列表为空）";
    // 总页数：只有真正耗尽游标（done=true）才报精确值；无界流必须诚实说「未知」，
    // 谎报一个下界（共 2 页）会让用户以为目录就这么大。客户端把 undefined 当未知 → 窗口式分页。
    if (state.done) {
      out.total = rows.length;
      out.totalPages = Math.max(1, Math.ceil(rows.length / size));
    } else {
      out.total = undefined;
      out.totalPages = undefined;
    }
  out.hasMore = p * size < rows.length || (!state.done && rows.length >= p * size);
  out.serverFacet = facetUsed !== "";
  if (facetRefused) out.hint = `clawhub 不接受分类「${facet}」（上游回 400），已按全部分类返回这一页`;
  if (cache && out.items && out.items.length) await cache.put(cKey, out);
  return out;
}


/** Background-warm the clawhub cursor catalogue up to 3000 rows (~125 pages).
 *  Called from warmMarketCache so the first panel open is fast; later pages
 *  just slice from the already-accumulated rows. */

/**
 * 全局排序的分页契约：必须在**切页之前**排序，否则每页各自有序、页与页之间无序。
 * 之前 dispatcher 在 handler 切完页后才排序，导致「按安装数」跨页错乱（实测第2页 max > 第1页 max）。
 * 所有 handler 在自己 slice 之前调用本函数。
 */
/**
 * 就地排序原始上游行。getters 把排序键映射到该源的行字段——
 * 排序键与卡片展示字段一一对应（sortKeyOf 的 handler 侧同族），杜绝「排了但看起来没排」。
 * name 升序（localeCompare），其余降序；未提供 getter 的键不动（保持上游序）。
 */
export function sortRawRows(rows, sort, getters = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const key = String(sort || "");
  const g = getters[key];
  if (!g) return rows;
  if (key === "name") {
    return rows.sort((a, b) => String(g(a) || "").localeCompare(String(g(b) || "")));
  }
  return rows.sort((a, b) => (Number(g(b)) || 0) - (Number(g(a)) || 0));
}
export async function warmClawHubCatalog(cache, options = {}) {
  // clawhub 的 browse 目录是 28k+ 且游标不封顶的流：上游既不返回 total，也永远爬不完。
  // 所以这里只预热一个**有界预算**（默认 1200 行 ≈ 50 页），换来首页之后几十页秒开；
  // 总页数因此是「共约」下界而不是精确值——这是上游能力边界，不是本地缺陷。
  const budget = Math.max(50, Number(options.budget) || 1200);
  const state0 = cache ? await cache.get(CLAWHUB_CATALOG_KEY, CLAWHUB_CATALOG_TTL) : undefined;
  const seen = new Set((state0?.rows || []).map((raw) => clawhubIdOf(raw)));
  const rows = [...(state0?.rows || [])];
  let cursor = state0?.cursor || null;
  let done = state0?.done || false;

  let consecutiveErrors = 0;
  while (!done && rows.length < budget && consecutiveErrors < 3) {
    const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    try {
      const data = await getJsonClawHub(`https://clawhub.ai/api/v1/skills?limit=50${qs}`);
      const batch = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
      for (const raw of batch) {
        const key = clawhubIdOf(raw);
        if (key && !seen.has(key)) { seen.add(key); rows.push(raw); }
      }
      const next = data.nextCursor || null;
      if (!batch.length || !next || next === cursor) { done = true; break; }
      cursor = next;
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors++;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
  }
  // 预算用满但游标未尽：done 保持 false，让分页器显示「共约」。
  if (cache) await cache.put(CLAWHUB_CATALOG_KEY, { rows, cursor, done });
  return { rows, done, budget };
}


// ---------------------------------------------------------------- LobeHub 技能分类词表
// 上游有权威端点（2026-11-24 实测 GET → 200，296 行 [{category,count}]）：246 行是规范 slug、
// 50 行是作者自由标签（含空格/&/大写/下划线/前导数字，如 _meta、2d-assets、AI & Machine Learning）。
// 自由标签上游 search 不认，做成 chip 就是给一个点了没用的入口，所以与 clawhub 同口径只留规范形态；
// 但一条都不截——监测方点名的 smart-home-iot/calendar-scheduling 在条数降序里排 28/29 名，
// 任何「取前 26」的截断都会把它们再次挤出窗口，用户报障原样复现。
// 这份是技能侧 taxonomy，不是站点 MCP 导航那 15 类：面板这个 tab 走 skills search。
const LOBEHUB_CATEGORIES_URL = "https://market.lobehub.com/api/v1/skills/categories";
const LOBEHUB_VOCAB_KEY = "lobehub_categories_v1";
const LOBEHUB_VOCAB_TTL = 7 * 24 * 3600 * 1000;

/** 瞬时网络抖动重试一次（与 clawhub 同姿势）：一次抖动不等于「该源没有分类」。 */
async function getJsonLobeHubMarket(url, attempt = 0) {
  try {
    return await getJsonEscalating(url, { headers: UA, timeoutMs: 25000 });
  } catch (error) {
    if (attempt < 1 && /fetch failed|ETIMEDOUT|ECONNRESET|socket|network|timeout/i.test(String((error && error.message) || error))) {
      return getJsonLobeHubMarket(url, attempt + 1);
    }
    throw error;
  }
}

/**
 * payload → [{slug,label,count,totalAll}]，按上游条数降序。0 列纯函数。
 * 三种上游形状都要吃（实测都存在）：顶层数组 [{category,count}]、{categories:[{category,count}]}、
 * 以及 search 响应里那份 {categories:[string,…]}（不带条数）。无条数时 count 记 0——
 * 面板 categoryLabelLite 只有 totalAll>0 才拼条数，缺字段就不显示条数，硬显示才是编数据。
 */
export function parseLobeHubSkillCategories(payload) {
  const raw = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.categories) ? payload.categories : []);
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const slug = String(typeof row === "string" ? row : ((row && row.category) || "")).trim();
    // 形态校验打在原值上、不是小写化之后：上游那 7 条首字母大写的自由标签（Analytics/Backend/DevOps…）
    // 小写后看着像规范 slug，但 CLI 的 --category 不认它们——放行就是给一个点了没用的入口。
    if (!/^[a-z][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const count = Number(row && typeof row === "object" ? row.count : 0) || 0;
    out.push({ slug, label: slug, count, totalAll: count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** 抓取 + 7 天 TTL。命中回同一引用；抓取失败或解析为空一律 null 且绝不落空快照。 */
export async function lobeHubSkillCategoryVocabulary({ cache, getJson = getJsonLobeHubMarket, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(LOBEHUB_VOCAB_KEY, LOBEHUB_VOCAB_TTL);
    if (hit && Array.isArray(hit.categories) && hit.categories.length && at - Number(hit.capturedAt) < LOBEHUB_VOCAB_TTL) return hit;
  } catch {
    /* 缓存读失败只意味着这次要重取 */
  }
  let payload = null;
  try {
    payload = await getJson(LOBEHUB_CATEGORIES_URL);
  } catch {
    return null;
  }
  const categories = parseLobeHubSkillCategories(payload);
  // 0 条 = 上游改版，不是「lobehub 没有分类」：落空快照会把面板已有的派生 chip 一起关掉。
  if (!categories.length) return null;
  const value = { capturedAt: at, source: LOBEHUB_CATEGORIES_URL, categories };
  try { await cache.put(LOBEHUB_VOCAB_KEY, value); } catch {}
  return value;
}

/** 只读缓存：settings.get 用它，绝不在此处等网络。没有/过期都回 null。 */
export async function readLobeHubSkillCategoryVocabulary({ cache, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(LOBEHUB_VOCAB_KEY, LOBEHUB_VOCAB_TTL);
    if (hit && Array.isArray(hit.categories) && hit.categories.length && at - Number(hit.capturedAt) < LOBEHUB_VOCAB_TTL) return hit;
  } catch {
    /* 读失败按「没有词表」处理 */
  }
  return null;
}
// ---------------------------------------------------------------- trusttools 分类词表
// 上游没有可用的分类词表端点：实测 https://ai.trusttools.cn/api/skills/categories 与站点本身
// 一样超时（2026-11-24 连测 7 次全 timeout），所以这份表不能像 clawhub/skillsmp 那样抓取缓存，
// 只能作为随包发布的静态事实表。表体是 2026-11-23 从上游站点 bundle 抽出的 category→tags 映射，
// 当时实测的过滤参数是 tags=（OR 语义：命中任一 tag 即属于该类），category= 参数被上游忽略。
// 不带条数：tag 级总数（ai=9782 等）是 2026-11-23 的快照且不是 category 级，写进 chip 就是假数。
// label 回落 slug：词表端点不可达，没有任何真显示名的实测依据，编中文标签等于造数据。
const TRUSTTOOLS_ORIGIN = "https://ai.trusttools.cn/";
const TRUSTTOOLS_CATEGORY_TAGS = {
  "ai-automation": ["ai", "automation", "ml"],
  "development": ["backend", "frontend", "api"],
  "data": ["data", "analytics"],
  "devops": ["devops", "cli", "scripting"],
  "security": ["security", "testing", "debugging"],
  "productivity": ["productivity"],
  "docs": ["docs", "code-review"],
  "cloud": ["cloud", "performance"],
  "design": ["design", "frontend"],
};

/** 静态词表快照（形状与 skillsmp/clawhub 一致，面板按 source 前缀核验归属）。 */
export function trusttoolsCategoryVocabulary() {
  return {
    capturedAt: Date.parse("2026-11-23T00:00:00Z"),
    source: TRUSTTOOLS_ORIGIN,
    categories: Object.keys(TRUSTTOOLS_CATEGORY_TAGS).map((slug) => ({
      slug,
      label: slug,
      tags: TRUSTTOOLS_CATEGORY_TAGS[slug].slice(),
    })),
  };
}

/** 一个分类 slug → 上游 tags（OR 语义）。表外一律回 null（调用方据此拒发，不猜 tag）。 */
export function trusttoolsTagsForCategory(category) {
  const key = String(category || "").trim().toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(TRUSTTOOLS_CATEGORY_TAGS, key)) return null;
  return TRUSTTOOLS_CATEGORY_TAGS[key].slice();
}

// 行内 tags → 规范分类 slug（tag→category 逆映射）。旧实现取 tags[0]：那是作者自由填写的
// 第一个标签（与 clawhub topics[0] 同族泄漏），既不是可比维度，也让聚合层的本地分类过滤
// 拿 tags[0] 去比 slug——多 tag 分类（security=security/testing/debugging）永远筛不全。
// 只在命中词表 tag 时回规范 slug，都不命中回空串：空串在聚合层的口径是「该源未标注分类」，
// 按「无分类不过滤」保留，不会把未知伪装成某个分类。
const TRUSTTOOLS_TAG_TO_CATEGORY = (() => {
  const map = new Map();
  for (const slug of Object.keys(TRUSTTOOLS_CATEGORY_TAGS)) {
    for (const tag of TRUSTTOOLS_CATEGORY_TAGS[slug]) {
      if (!map.has(tag)) map.set(tag, slug);
    }
  }
  return map;
})();

/** 行内 tags → 规范分类 slug（第一个命中的表内 tag 决定；都不命中回空串）。 */
export function trusttoolsCategoryOfTags(tags) {
  if (!Array.isArray(tags)) return "";
  for (const raw of tags) {
    const hit = TRUSTTOOLS_TAG_TO_CATEGORY.get(String(raw || "").trim().toLowerCase());
    if (hit) return hit;
  }
  return "";
}

// 单页请求的唯一出口：分类请求与「不带 tags 的参照请求」必须除 tags 之外逐字段相同，
// 否则比较两个 pagination.total 就是拿两次不同的查询比大小。
async function fetchTrustToolsPage({ getJson, postJson, serverSort, query, upstreamPage, perPage, tags }) {
  if (serverSort) {
    // GET 端点固定 10 条/页（实测 pageSize 参数被忽略），排序由服务端对全量做
    const qs = new URLSearchParams({ sort_by: "install_count", direction: "desc", page: String(upstreamPage), pageSize: String(perPage) });
    // 多 tag 的线路编码 2026-11-24 实测：重复同名 tags=a&tags=b 只有最后一个生效
    // （security&testing → 3712 = testing 单独的值），逗号单键 tags=a,b 才是并集
    // （security,testing → 7270，两单值和 8084，确有重叠）。旧写法对多 tag 分类是错筛。
    if (tags.length) qs.set("tags", tags.join(","));
    if (String(query || "").trim()) qs.set("search", String(query).trim());
    return getJson(`https://ai.trusttools.cn/api/skills?${qs.toString()}`, { timeoutMs: 25000 });
  }
  return postJson(
    "https://ai.trusttools.cn/api/skills/search",
    // 上游参数名是 search（不是 q）：传 q 会被忽略，永远返回默认列表。实测 search 才生效。
    // POST 的 tags 为 JSON 数组且实测真并集：search=pdf 下 docs,code-review=117，单值 116/5。
    { search: query, page: upstreamPage, pageSize: perPage, ...(tags.length ? { tags } : {}) },
    { timeoutMs: 25000 },
  );
}

export async function searchTrustTools({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "",
  getJson = getJsonEscalating, postJson = postJsonEscalating } = {}) {
  // trusttools ignores `pageSize` and always answers with 10 rows per page, so a page of 24
  // needs three upstream pages stitched together (pages are disjoint, verified).
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(60, Number(pageSize) || 24));
  const perPage = 10;
  // 分类 facet：上游认的是 tags=（OR 语义），category= 参数实测被忽略（2026-11-23：
  // 8 个 category 值返回同一批）。表外 slug 直接拒在本地，一次上游都不发——把别处的
  // 值当本市场分类发出去，拿回来的就是未过滤集合冒充该分类。
  const facet = String(category || "").trim().toLowerCase();
  const facetTags = facet ? (trusttoolsTagsForCategory(facet) || []) : [];
  const facetUsed = facet && facetTags.length ? facet : "";
  const facetRefused = Boolean(facet) && !facetUsed;
  const facetTagSet = new Set(facetTags);
  // 上游有隐藏的服务端全盘排序端点 GET /api/skills?sort_by=install_count&direction=desc
  // （实测首条 ui-ux-pro-max≈446,924，跨页全局单调；POST /search 的 sort 参数全部被忽略）。
  // 旧实现是「取 60 页窗口本地排」——对 579,074 条全量属于近似，禁止。
  // name 排序上游返回空数组（坏），故 name 仍走窗口 + 本地排。
  const serverSort = sort === "installCount";
  const sortMode = sort === "name";
  // serverSort：上游 GET 端点固定 10 条/页且全局有序。面板第 p 页需要第 [(p-1)*size, p*size)
  // 条，对应上游页 floor((p-1)*size/10)+1 .. ceil(p*size/10)，取回后按偏移量本地切。
  const first = serverSort
    ? Math.floor(((p - 1) * size) / perPage) + 1
    : sortMode ? 1 : (p - 1) * Math.ceil(size / perPage) + 1;
  const lastUpstream = serverSort
    ? Math.ceil((p * size) / perPage)
    : first + (sortMode ? 60 : Math.ceil(size / perPage)) - 1;
  const perBatch = Math.max(1, lastUpstream - first + 1);
  const sliceOffset = serverSort ? (p - 1) * size - (first - 1) * perPage : 0;
  const rows = [];
  const seen = new Set();
  let total = 0;
  // facetTotal：带 tags 请求的 pagination.total；refTotal：同一 query 不带 tags 的参照值。
  // 两者的差就是「上游真按 tags 过滤」的证据（实测 579,074 → security 4,372）。
  let facetTotal = 0;
  let refTotal = 0;
  for (let index = 0; index < perBatch; index += 1) {
    const upstreamPage = first + index;
    const key = `trusttools:${String(query).trim().toLowerCase()}:${upstreamPage}:${sort || ""}:${facetUsed}`;
    let data = cache ? await cache.get(key, 10 * 60 * 1000) : undefined;
    if (!data) {
      data = await fetchTrustToolsPage({ getJson, postJson, serverSort, query, upstreamPage, perPage, tags: facetTags });
      if (cache) await cache.put(key, data);
    }
    const batch = Array.isArray(data.data) ? data.data : [];
    if (data.pagination && Number(data.pagination.total) > 0) {
      total = Number(data.pagination.total);
      if (facetUsed) facetTotal = total; else refTotal = total;
    }
    let added = 0;
    for (const raw of batch) {
      const id = String(raw.id ?? raw.slug ?? raw.name ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(raw);
      added += 1;
    }
    if (batch.length === 0 || added === 0) break; // catalogue exhausted or the page repeats
  }
  // 切页前排序：否则每页各自有序、跨页错乱
  // installCount 由服务端全盘排序，不再本地重排（本地重排会打乱服务端的全量序）
  sortRawRows(rows, sortMode ? sort : "", { name: (r) => r.name || r.slug });
  // 排序模式下窗口从第 1 页起，本地切出第 p 页；否则上游已给对页
  const pageRows = serverSort
    ? rows.slice(sliceOffset, sliceOffset + size)
    : sortMode
      ? rows.slice((p - 1) * size, p * size)
      : rows.slice(0, size);
  // facet 自证（0.5.159 换口径）：2026-11-24 实测上游列表端点返回的行内 tags 恒为 []，
  // 「每行命中所请求 tag」在真上游永假——旧口径把真在过滤的请求误判成被忽略，面板随之
  // 显示「所选来源不提供分类信息，已忽略分类筛选」，chip 等于白点。
  // 新口径用上游自己的计数：带 tags 的 pagination.total 必须小于同一 query 不带 tags 的参照
  // total 才算真过滤；行级命中保留为正向附加信号（上游哪天回填 tags 也算证明）。
  let facetAnswered = false;
  if (facetUsed && rows.length) {
    // 参照请求：端点、页号、query 与分类请求逐字段相同，唯一区别是不带 tags。
    const refKey = `trusttools:facetref:${String(query).trim().toLowerCase()}:${first}:${sort || ""}`;
    let ref = cache ? await cache.get(refKey, 10 * 60 * 1000) : undefined;
    if (!ref) {
      ref = await fetchTrustToolsPage({ getJson, postJson, serverSort, query, upstreamPage: first, perPage, tags: [] });
      if (cache && ref) await cache.put(refKey, ref);
    }
    if (ref && ref.pagination && Number(ref.pagination.total) > 0) refTotal = Number(ref.pagination.total);
    // 上游自己的计数变小才算真过滤；facetTotal 为 0（该分类没有条目）时不比对。
    facetAnswered = facetTotal > 0 && refTotal > 0 && facetTotal < refTotal;
    if (!facetAnswered) {
      facetAnswered = rows.every((raw) => (Array.isArray(raw.tags) ? raw.tags : [])
        .some((tag) => facetTagSet.has(String(tag || "").trim().toLowerCase())));
    }
  }
  const items = pageRows.map((raw) => {
    const repo = String(raw.repo_url || "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const path = String(raw.repo_path || "").replace(/\/SKILL\.md$/i, "");
    return {
      id: `trusttools:${raw.id}`,
      slug: raw.slug || raw.name,
      name: raw.name || raw.slug,
      description: raw.description_zh || raw.description || raw.short_description || "",
      source: "trusttools",
      sourceLabel: "TrustTools",
      owner: repo,
      homepage: repo ? `https://github.com/${repo}` : "",
      upstreamUrl: repo,
      ref: raw.branch || "main",
      skillDir: path,
      stars: Number(raw.stars || 0),
      // 上游 sort_by=install_count 与 install_count 字段都是真实安装量 → 名称与字段一致；
      // 去掉 || raw.download_count 回落，避免用下载数冒充安装数。
      installs: Number(raw.install_count || 0),
      downloads: Number(raw.download_count || 0),
      security: raw.security_level || "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      category: trusttoolsCategoryOfTags(raw.tags),
      installable: Boolean(repo && path),
    };
  });
  // 分类页的 total 必须是该分类的集合大小（facetTotal），不是无分类参照值。
  const known = facetTotal || refTotal || total || 0;
  return {
    source: "trusttools",
    items,
    total: known,
    // serverFacet 只有在「数据自证过滤成立」时才真：上游忽略参数或编码猜错都不谎报。
    serverFacet: facetAnswered,
    ...(facetRefused ? { hint: `trusttools 没有「${facet}」这个分类，已按全部分类显示这一页` } : {}),
    // 只在「真取回了行且自证失败」时说这句话：空页里没有任何行，任何归因都是假陈述。
    ...(facetUsed && rows.length > 0 && !facetAnswered ? { hint: `trusttools 这个分类没有筛出不同的结果（总数与全部分类相同），已退回按普通列表显示这一页` } : {}),
    hasMore: known ? p * size < known : items.length >= size,
  };
}

// ---------------------------------------------------------------- LobeHub Skills Marketplace
// LobeHub's Skills Marketplace (33万+ skills) is accessed via the official CLI:
//   search:  npx -y @lobehub/market-cli skills search --q "<query>" --page <n> --page-size <n> --output json
//   install: npx -y @lobehub/market-cli skills install <identifier> --dir <path>
// The CLI auto-downloads via npx; no pre-install or authentication required.
// `view` requires a token and is not used.
// 矩阵键 → skills 子命令 --sort 词表（实测词表见上，2026-11-19 用 4 次 CLI 探测确认）。
// installCount/stars/name 两侧同名且实测 exit0；newest/updated 必须改名；
// 其余（trending/relevance…）不在词表 → 返回空串表示「不传 --sort」。
const LOBEHUB_SKILLS_SORT_MAP = {
  installCount: "installCount",
  stars: "stars",
  name: "name",
  newest: "createdAt",
  updated: "updatedAt",
};

/** 该源请求的排序键映射成上游 CLI 认识的键；词表外返回 ""（保持上游默认序）。 */
export function lobehubSkillSortArg(sort) {
  return LOBEHUB_SKILLS_SORT_MAP[String(sort || "").trim()] || "";
}

// skills 行的实测字段（24/24 齐全）：
//   author,category,commentCount,createdAt,description,github,homepage,icon,identifier,
//   installCount,isFeatured,isOfficial,isValidated,license,name,ratingAvg,ratingCount,
//   resourcesCount,updatedAt,version
// 键名取映射后的上游 --sort 值，createdAt/updatedAt 实测是 "MM/DD/YYYY HH:mm:ss" 本地串，
// Number() 会读成 NaN → 必须 Date.parse（该格式在 V8 下可解析）。
export const LOBEHUB_SKILL_SORT_GETTERS = {
  installCount: (r) => r.installCount ?? r.downloads ?? r.installs,
  name: (r) => r.name || r.identifier,
  createdAt: (r) => Date.parse(r.createdAt) || 0,
  updatedAt: (r) => Date.parse(r.updatedAt) || 0,
  // 上游按 stars 排，但**行内没有 stars 字段**（实测），旧的 (r) => r.stars 恒 undefined
  // → 本地兜底排不动。用同向的 ratingCount（缺失再退 ratingAvg）代替，不假装 r.stars 存在。
  stars: (r) => Number(r.ratingCount ?? r.ratingAvg) || 0,
};

/** 是否有本地兜底（决定 sortRawRows 是否执行）。矩阵键与映射后的上游键都接受。 */
export function lobehubSkillLocalSortApplies(sort) {
  const raw = String(sort || "").trim();
  const key = LOBEHUB_SKILLS_SORT_MAP[raw] || raw;
  return typeof LOBEHUB_SKILL_SORT_GETTERS[key] === "function";
}

export async function searchLobeHubSkills({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "" }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  const sortKey = String(sort || "").trim();
  // 实测（勿凭旧注释）：CLI --sort installCount --order desc 是服务端全盘排序，
  // p1 min(2295) ≥ p2 max(2235)，跨页全局单调。旧注释「跨页仍无序」是错的，
  // 旧实现 sortMode 下反而不传 --sort、退化成 50 条窗口近似——已纠正：始终透传 --sort。
  //
  // 但透传前必须映射：skills 子命令的 --sort 只认
  //   createdAt|stars|installCount|name|relevance|ratingAverage|commentCount|updatedAt
  // 旧实现把矩阵键原样塞进 CLI，newest/updated 不在词表 → CLI exit 1
  // "Search failed: Bad Request" → sources.js 的 catch 把整个 lobehub 记进 degraded，
  // 用户看到的不是「排序没生效」而是 lobehub 贡献 0 条（整源消失）。
  const sortArg = lobehubSkillSortArg(sortKey);
  const fetchPage = p;
  const fetchSize = size;
  // category 进 cacheKey：面板换分类时必须重新打上游，拿上一个分类的缓存页答它属于假数据。
  const cat = String(category || "").trim();
  const cacheKey = `lobehub_skills_search:${query.trim()}:${sortKey}:${cat}:${fetchPage}:${fetchSize}`;
  const cached = cache ? await cache.get(cacheKey, 30 * 60 * 1000) : undefined;
  if (cached) return { source: "lobehub", ...cached };

  const { npxRun } = await import("./cli-install.js");
  // Empty query: omit --q entirely (the CLI treats an empty-string arg as a
  // positional and rejects it: "too many arguments for 'search'").
  const q = String(query || "").trim();
  const args = ["skills", "search"];
  if (q) args.push("--q", q);
  // 分类透传给官方 CLI（--category <slug> 服务端过滤，实测 6/6 行 category 等于所请求值）。
  // 空分类不推这个参数：CLI 会把空串当 positional 拒掉，与 --q 同一个坑。
  if (cat) args.push("--category", cat);
  // installCount/stars/name 原样透传（实测 exit0）；newest/updated 见上映射；
  // 词表外的键（如 trending）→ sortArg 为空 → 不传 --sort，保持上游默认序，绝不冒整源消失的风险。
  if (sortArg) args.push("--sort", sortArg);
  if (sortArg) args.push("--order", "desc");
  args.push("--page", String(fetchPage), "--page-size", String(fetchSize), "--output", "json");
  // First npx run auto-downloads the CLI (~30 s); subsequent runs are cached.
  // 180 s covers the worst-case cold start without hanging the UI.
  const stdout = await npxRun("@lobehub/market-cli", args, { timeoutMs: 180000 });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("lobehub search: CLI returned non-JSON output");
  }
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  // 服务端已按请求排序（实测全局单调）；这里只做防御性校验排序，不改变服务端序——
  // 若 CLI 未按请求排序（版本差异），本地兜底仍保证单调。
  // 实测兜底是必要的：单页 installCount 序列出现 …,1982,1901,1905,1873,…（上游排序偏软）。
  // getter 的键名必须与**映射后**的上游键一致，否则 newest/updated 那两行永远是死代码。
  const sortMode = lobehubSkillLocalSortApplies(sortArg);
  if (sortMode) sortRawRows(rawItems, sortArg, LOBEHUB_SKILL_SORT_GETTERS);
  const pageItems = rawItems;
  const items = pageItems.map((raw) => ({
    id: `lobehub:${raw.identifier || ""}`,
    slug: raw.name || raw.identifier || "",
    name: raw.name || raw.identifier || "",
    description: raw.description || "",
    source: "lobehub",
    sourceLabel: "LobeHub 技能市场",
    owner: raw.author || "",
    homepage: raw.homepage || "",
    upstreamUrl: "",
    reference: raw.identifier || "",
    category: raw.category || "",
    tags: [],
    installCount: Number(raw.installCount || 0),
    // 面板读 item.installs；LobeHub 上游字段叫 installCount，补映射让卡片与「按安装数」排序有数。
    installs: Number(raw.installCount || 0),
    rating: Number(raw.ratingAverage || 0),
    installable: Boolean(raw.identifier),
    note: "通过官方 CLI 安装 LobeHub 技能",
  }));
  const total = Number(parsed.totalCount || 0);
  // 上游直接报总页数（实测 facet 页 615）：面板分页不再靠 total/size 反推。
  const totalPages = Number(parsed.totalPages || 0);
  const result = {
    source: "lobehub",
    items,
    total,
    // serverFacet 只在「真的发了 --category」时声明（与 clawhub/skillsmp 同一契约）：聚合层据此
    // 走服务端已筛路径，不再本地滤当前页；没发分类就不许声称筛过。
    serverFacet: cat !== "",
    totalPages: totalPages > 0 ? totalPages : undefined,
    hasMore: total ? p * size < total : items.length >= size,
  };
  if (cache) await cache.put(cacheKey, result);
  return result;
}

/**
 * Install a LobeHub skill via the official CLI.
 * `npx -y @lobehub/market-cli skills install <identifier> --dir <tmpDir>`
 * The CLI extracts the skill into <tmpDir>/<identifier>/ (SKILL.md + references/).
 * Returns { name, description, files } in the same shape the old agent-JSON path produced,
 * so callers in skills.js can use it unchanged.
 */
export async function lobehubAgentSkill(identifier) {
  if (!identifier) throw new Error("lobehub skill install requires an identifier");
  const { npxRun } = await import("./cli-install.js");
  const tmpRoot = await mkdtemp(join(safeTempDir(), "dsh-lobehub-"));
  const targetDir = join(tmpRoot, identifier);
  try {
    await npxRun("@lobehub/market-cli", ["skills", "install", identifier, "--dir", tmpRoot], {
      timeoutMs: 120000,
    });
    if (!existsSync(targetDir)) {
      throw new Error(`lobehub CLI did not produce a skill directory at ${targetDir}`);
    }
    // Walk the installed directory and collect all files.
    const files = {};
    const walk = async (current, prefix) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full, relative);
        else files[relative] = await readFile(full, "utf8");
      }
    };
    await walk(targetDir, "");
    const skillText = files["SKILL.md"] || "";
    const meta = skillMetaFromText(skillText, identifier);
    if (!meta.name || !meta.description) {
      throw new Error("lobehub skill SKILL.md 缺少 name 或 description frontmatter");
    }
    return { name: meta.name, description: meta.description, files };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- skillsmp
// skillsmp.com answers 403 "Just a moment…" to this process's fetch/https but 200 to the
// curl transport (see src/http.js): the edge fingerprints the TLS client, not the headers.
// The payload is `{ skills: [...], pagination: {...}, filters: {...} }`; every row carries the exact
// GitHub location, so an install is a plain repo+skillDir download. The numbers in pagination are
// a moving target — measured live 2026-11-22: a browse page answers total 1200 (the site's own hero
// counts 4,248,026 SKILL.md files) with totalIsExact:false plus isCapped/maxResults; a search page
// answers page*limit+1 with totalIsExact:false; only an exhausted search answers totalIsExact:true.
// 分类 facet 另有两个口径（全部 2026-11-22 走 getJsonEscalating/python 实测，回归见 test-skillsmp-search.mjs）：
//   · 带 facet 时 pagination.total 恒 480 —— limit=8/24/48 下 totalPages 60/20/10，乘积都是 480，
//     10 个不同分类与 2 个 occupation 全报同一个 480。那是窗口深度，不是该分类的条数。
//   · 同一响应里上游另自报 pagination.totalAll = 该面真实条数：category=debugging → 532411、
//     category=cli-tools → 21484、occupation=software-developers → 1124877。language=zh 与纯浏览态不给该字段，
//     此时总数照旧不报。所以判据是先看窗口再看精确，total 取 totalAll，页数只能取窗口页深。
//   · facet 与 search 不能同时用：search=pdf total=7，加 category=ide-plugins 仍报 7，但首 6 条与不带 facet
//     的结果重叠 0/6 —— 上游忽略 facet 且静默换成另一个集合。带关键词时一律不发 facet。
//   · /zh/categories 页面 75 个分类锚：63 个带条数徽标（可浏览面，词表就是这 63 个），12 个只有板块
//     标题（浏览工具/业务开发/…）没有徽标——它们发给 legacy 一律 HTTP 400
//     body {"success":false,"error":{"code":"INVALID_CATEGORY",...}}（tools、business、data-ai、databases 在内）。
//     63 个里 62 个逐个 GET 实测被接受（test/fixtures/skillsmp-category-vocab.json 记全部 slug+中文标签+条数），
//     documents 那一轮探针超时（可浏览性未知，不是被拒）。没有公开的编目端点可查，所以运行时必须保留 400 兜底。
// 其余判据（search= 键、limit 上界）同样以那组实测为准，注释只写复核过的事实。
const SKILLSMP_TTL = 10 * 60 * 1000;
// limit 上界不是推测值：上游自己把边界写在错误体里。交错重放 4 轮（48/49/40/50 交替，排除
// 「请求次数触发 Cloudflare 挑战」这一混淆项）原文：limit=48 → HTTP 200 n=48（4/4 轮），
// limit=49 与 limit=50 → HTTP 400 Bad Request，body =
//   {"error":"Invalid limit; expected one integer between 1 and 48",...}（4/4 轮同形）；
// 44/45/46/47 另经 getJsonEscalating（插件真实取数路径）逐个实测 n=limit。
// 注意：裸 fetch 对这些请求拿到的是 403「Just a moment...」挑战页，那不是上游对 limit 的答复，
// 所以取证必须走 getJsonEscalating/python 传输。旧实现钳到 50 = 每页宽 48~50 的请求都会被拒。
const SKILLSMP_MAX_LIMIT = 48;
const SKILLSMP_UNBOUNDED_NOTE = "skillsmp 没有给出总数，先显示这一页；继续翻页或换个关键词都能看到更多";
// 0.5.188 顺序游标目录（用户 m40394 点名「480 取不全必须解决」）。取证见 test-skillsmp-search Test 16–21
// 与探针日志 sk20/22/23/24/25b/26/27.log：
//   · /api/skills?category=<slug>&limit=48&cursor=start 回 pagination{cursorPagination:true, nextCursor,
//     isCapped:false, total==totalAll}；页码态那个 480（facet）/1200（browse）只是 maxResults 自报的
//     浏览窗口，游标态没有这个窗口 —— 链走 30 步 720 行零重复，第 21 步起就取到旧通路永远拿不到的行。
//   · 游标解出来是 keyset（after:{id,rank}+snapshot），尾带 32 字节完整性签名：改一个字节（rank 改写 /
//     去尾 / 翻字节三种）一律被拒 ⇒ 只能原样重放、顺序往后走，不能跳页、不能按区间并行切片。
//   · page 与 cursor 不可同带（实测同带 Traceback）；游标态 limit 上限仍是 48（60/96/100 被拒）；
//     同一个 nextCursor 可重复使用（30 分钟 exp 内稳定），实测隔 42s 复用旧游标仍能续。
//   · 成本：limit=48 每轮平均 1.95s（10 轮 19496ms）⇒ debugging 一面 545886 条串行约 6.2 小时，
//     所以只能「随翻随取」：按 need=size*p 链到够用为止，绝不首屏取全。
const SKILLSMP_CATALOG_KEY = "{{SECRET_b94gck2c}}";
// 进度装载 TTL（0.5.190 从 6 小时提到 7 天，用户 m41100「必须确保所有技能被完整取回」）：
// 545,886 条/类串行要 ≈6.2 小时，6 小时 TTL 意味着「一个晚上没人翻页 ⇒ 半截进度整体作废、
// 第二天从零重来」——渐进取全就永远取不全。makeCache.put 每轮落盘都刷 at，活动链内永不过期，
// 真正的代价只是「连续 7 天没碰过的面」才重置；对照词表 VOCAB_TTL 同为一周，量级一致。
const SKILLSMP_PROGRESS_TTL = 7 * 24 * 3600 * 1000;
// 单次调用的补链轮数上界：必须真的判断（clawhub 侧 2026-11-23 的教训——guard 存在却从不判断，
// 注入不收敛的上游能连打 201 次，把整个源拖到 12s 预算被切）。
const SKILLSMP_CHAIN_ROUNDS = 12;
// 0.5.190 后台补链泵（用户 m41100：「技能的完整性是核心、关键问题，必须确保所有技能被完整取回」）。
// 0.5.188/189 的目录链只被用户翻页驱动（need = size × page）：没人翻页就永远停在已取的那一截，
// 一面 545,886 条 ≈6.2 小时串行，靠会话内翻页取满是做不到的。泵把「取满」变成进程活着就持续
// 推进的后台行为：每个 tick 推一面的一轮链（单轮轮数与翻页共用预算上界），facet 之间轮转不饿死。
// 间隔取 30s：实测一跳 48 行 1.4–2.0s，一轮 12 跳 ≈18–24s，加间隔让同链严格串行（游标链不可并行、
// 连打还会触发上游限流——sk 系列探针实证），也让别的请求有机会插进来。
const SKILLSMP_PUMP_ROUNDS = 12;
const SKILLSMP_PUMP_GAP_MS = 30000;
// 分类词表：面板的「按分类浏览」入口只能来自 /zh/categories 这份 HTML（编目端点 10 个候选实测全部
// ENDPOINT_NOT_FOUND），所以这里解析页面锚点，抓取走 pythonText（同一 Cloudflare 指纹门槛）。
// 词表 TTL 取 7 天：判据不是「上游多久改版」，而是「面板宁可退回页内派生 chip，也不长期贴一份旧词表」。
const SKILLSMP_CATEGORIES_URL = "https://skillsmp.com/zh/categories";
const SKILLSMP_VOCAB_KEY = "skillsmp_categories_v1";
const SKILLSMP_VOCAB_TTL = 7 * 24 * 3600 * 1000;

/**
 * /zh/categories → [{slug,name,totalAll}]。只认「带条数徽标的分类卡锚」：板块标题锚形如
 * <span>浏览工具</span> 且无 <bdi>，不是可浏览面（发上游必回 400）。锚体很长（实测 806~1139 字符），
 * 所以窗口取 1400——取 600 时首轮只回来 12 条板块头，那是判据没跑起来而不是页面没有分类。
 */
export function parseSkillsMpCategories(html) {
  const text = String(html || "");
  const out = [];
  const seen = new Set();
  const re = /<a\s[\s\S]{0,1400}?href="(?:\/[^"\/]+)?\/categories\/([a-z0-9][a-z0-9-]*)"[\s\S]{0,1400}?<\/a>/g;
  let m;
  while ((m = re.exec(text))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const body = text.slice(m.index, text.indexOf("</a>", m.index) + 4);
    const strip = (s) => String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, "\"")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim();
    const name = strip((body.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const countRaw = strip((body.match(/<bdi>([\s\S]*?)<\/bdi>/) || [])[1]);
    const totalAll = Number(countRaw.replace(/[^0-9]/g, "")) || 0;
    if (!name || /^浏览/.test(name) || totalAll <= 0) continue;
    out.push({ slug, name, totalAll });
  }
  return out;
}

/** 抓词表并落缓存。抓不到/解析不出 → null（空词表与没有词表是两回事，见回归套件）。 */
export async function skillsmpCategoryVocabulary({ cache, getText = pythonText, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(SKILLSMP_VOCAB_KEY, SKILLSMP_VOCAB_TTL);
    // 新旧由 capturedAt 判，而不是 makeCache 的内部时钟：注入 now 才能确定性地测出「过期重取」。
    if (hit && Array.isArray(hit.categories) && hit.categories.length
      && at - Number(hit.capturedAt) < SKILLSMP_VOCAB_TTL) return hit;
  } catch {
    // 缓存读失败只意味着这次要重取
  }
  let html = "";
  try {
    const r = await getText(SKILLSMP_CATEGORIES_URL, {
      headers: { referer: "https://skillsmp.com/" },
      timeoutMs: 20000,
    });
    html = typeof r === "string" ? r : String((r && r.text) || "");
  } catch {
    return null;
  }
  const categories = parseSkillsMpCategories(html);
  // 0 条 = 页面改版，不是「这站没有分类」：不许落成空快照（那会把面板已有的派生 chip 一起关掉）。
  if (!categories.length) return null;
  const value = { capturedAt: at, source: SKILLSMP_CATEGORIES_URL, categories };
  await cache.put(SKILLSMP_VOCAB_KEY, value);
  return value;
}

/** 只读缓存：settings.get 用它，绝不在此处等网络。没有/过期都回 null。 */
export async function readSkillsMpCategoryVocabulary({ cache, now = Date.now } = {}) {
  if (!cache) return null;
  const at = Number(typeof now === "function" ? now() : now) || Date.now();
  try {
    const hit = await cache.get(SKILLSMP_VOCAB_KEY, SKILLSMP_VOCAB_TTL);
    if (!hit || !Array.isArray(hit.categories) || !hit.categories.length) return null;
    if (at - Number(hit.capturedAt) >= SKILLSMP_VOCAB_TTL) return null;
    return hit;
  } catch {
    return null;
  }
}

function skillsmpTarget(raw) {
  const route = raw.route || {};
  const url = String(raw.githubUrl || "");
  const tree = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i);
  const branch = String(raw.branch || (tree ? tree[3] : "") || "main");
  let skillDir = String(route.sourceSkillPath || "").replace(/\/?SKILL\.md$/i, "");
  if (!skillDir && tree) skillDir = tree[4];
  const repo = tree ? `${tree[1]}/${tree[2]}` : "";
  return { repo, branch, skillDir };
}

  // 搜索参数与总数口径的回归测试：test/test-skillsmp-search.mjs。
  // 抓取方法与 searchClawHub 同构：把 json 抓取注入成参数，确定性测试才不用真打 skillsmp。
  // 默认值保持线上行为：Cloudflare 按 TLS 指纹拦抢，只有 CPython urllib 能过。
/** 上游一行 → 面板一张卡。facet 不在行上（实测行对象 13 键里没有分类字段），只能由请求侧回填。 */
function skillsMpItemOf(raw, catSlug) {
  const { repo, branch, skillDir } = skillsmpTarget(raw);
  return {
    id: `skillsmp:${raw.id || raw.name}`,
    slug: raw.name || String(raw.id || ""),
    name: raw.name || String(raw.id || ""),
    description: raw.description || "",
    source: "skillsmp",
    sourceLabel: "skillsmp",
    owner: raw.author || "",
    homepage: raw.githubUrl || "",
    // parseRepoRef understands `owner/repo@ref`, so the branch rides along here.
    upstreamUrl: repo ? `${repo}@${branch}` : "",
    skillDir,
    ref: branch,
    // 实测 stars/forks 是仓库真实值（plain 首行 stars=469982、sortBy=recent 首行 1602，forks 同理）；
    // 同一仓库的多个技能共用该仓库 star 数是上游口径，不是占位符，照实透出。
    stars: Number(raw.stars) || 0,
    category: catSlug,
    installable: Boolean(repo),
  };
}

/**
 * 顺着上游 nextCursor 把「一面分类目录」往本地攒。返回 probed（是否真取到过一包响应）、legacy
 * （上游这一包不带游标 ⇒ 整条通路退回页码口径）、lastData（legacy 时那包响应，供调用方就地复用，
 * 不许为同一页再打第二次）。state.rows 按 id 去重：实测同一游标重复取回的是同一批行，而链上零重复。
 */
async function extendSkillsMpCatalog(cache, need, facet, sort, fetchJson, options, rounds = SKILLSMP_CHAIN_ROUNDS) {
  const chain = async (f) => {
    const catKey = `${SKILLSMP_CATALOG_KEY}${f || "any"}${sort ? ":" + sort : ""}`;
    let state = await cache.get(catKey, SKILLSMP_PROGRESS_TTL);
    if (!state || !Array.isArray(state.rows)) state = { rows: [], cursor: null, done: false, totalAll: 0 };
    // 中毒终态自愈（sk31/sk32 真机实证）：0.5.188 的局部 replaying bug 把「追赶页整页重复」
    // 误判成到底，落盘 done=true 而 rows<totalAll ⇒ 分类永久停在半截、对外还谎称取完。
    // done 只有「取满 totalAll」或「上游明说没有下一页（零行/无后继/游标原地）」才作数；
    // 旧码没记成因，装载时 rows<totalAll 且成因不是 upstream 的一律复位续取。代价：真·停滞
    // 的目录每次装载多花一跳确认，换「绝不谎称取完」（用户 m41100 令）。
    if (state.done && state.doneReason !== "upstream" && Number(state.totalAll) > 0 && state.rows.length < Number(state.totalAll)) state.done = false;
    const seen = new Set(state.rows.map((r) => String(r.id || r.name || "")));
    let legacy = false;
    let lastData = null;
    let probed = false;
    let guard = 0;
    // catchingUp 落在 state 上（跨调用）：死游标重启后的追赶页整页重复，只算「还没追平」，
    // 不算到底。sk30 真机实证：576 行目录重启追赶要 13 跳、链预算 12 跳 ⇒ 预算切断时落盘的
    // 是追赶链中途游标；若追赶态只活在本次调用里，下一次调用第一跳取回重复页就会被判 done，
    // 目录永久截断在 576/545886 还对外报 hasMore=false＝谎称取完（Test 25 锁死）。
    const resumed = Boolean(state.cursor);
    while (!state.done && state.rows.length < need && guard < rounds) {
      guard += 1;
      let data;
      try {
        // 起链发 cursor=start 且不带 page（实测 page+cursor 同带被上游拒）。
        const sp = new URLSearchParams({ limit: String(SKILLSMP_MAX_LIMIT), cursor: String(state.cursor || "start") });
        if (f) sp.set("category", f);
        if (sort === "stars") sp.set("sortBy", "stars");
        else if (sort === "updated") sp.set("sortBy", "recent");
        data = await fetchJson(`https://skillsmp.com/api/skills?${sp.toString()}`, options);
      } catch (err) {
        const em = String((err && err.message) || err);
        // 死游标只在「本次调用续起的第一跳」自愈重启：同一轮调用里第 2 跳之后的瞬时失败
        // 是限流抖动，链就地攒着、原样抛出让下一页再接（Test 22 锁死）。确定性 4xx 先让
        // 外层 facet 兜底，不冒充死游标。
        if (!(guard === 1 && resumed && !/HTTP Error 400|INVALID_CATEGORY/.test(em))) throw err;
        // 游标带 30 分钟 exp（sk29 实测停 10 分钟重放即 Traceback）：清掉死游标从 start 重启。
        state.catchingUp = true;
        state.cursor = "";
        // 死游标不留在盘上：重启后预算到点被切，下一次也从 start 接，不再撞第二次死游标。
        await cache.put(catKey, state);
        continue;
      }
      probed = true;
      lastData = data;
      const pg = (data && data.pagination) || {};
      const rows = Array.isArray(data && data.skills) ? data.skills : [];
      const all = Number(pg.totalAll);
      if (Number.isFinite(all) && all > 0) state.totalAll = all;
      const next = typeof pg.nextCursor === "string" ? pg.nextCursor : "";
      if (!(pg.cursorPagination === true || next)) { legacy = true; break; }
      let added = 0;
      for (const r of rows) {
        const id = String(r.id || r.name || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        state.rows.push(r);
        added += 1;
      }
      // 停滞判定分两类成因（doneReason）：上游明说（零行/无后继/游标原地）与本地推断（整页重复）。
      // 本地推断的 done 会被上面的中毒复位腿重开（每装载一跳确认）；上游明说的不复位。
      if (added) state.catchingUp = false;
      if (!rows.length || !next || next === state.cursor) { state.done = true; state.doneReason = "upstream"; }
      else if (!state.catchingUp && !added) { state.done = true; state.doneReason = "stalled"; }
      else state.cursor = next;
      if (state.totalAll > 0 && state.rows.length >= state.totalAll) state.done = true;
      // 每轮都落盘：外层聚合预算（12s）到点只是没人再等这个 promise，链本身还会跑完；
      // 攒到一半被下一次调用接上，比整条链白打强（真机 p21 一跳 11 轮 = 25s，超预算）。
      await cache.put(catKey, state);
    }
    return { state, legacy, lastData, probed };
  };
  try {
    const r = await chain(facet);
    return { state: r.state, legacy: r.legacy, lastData: r.lastData, probed: r.probed, facetUsed: facet, facetRefused: false };
  } catch (err) {
    if (!facet) throw err;
    // 只有上游明说 400/INVALID_CATEGORY 才是「词表外分类」（实测页面 62 个 slug 被 legacy 接受、
    // 板块标题类回 400）。真机 28b 实证：链中途的 Traceback（限流抖动）若也去 facet，会悄悄换成
    // 全库目录再攒十轮 —— 类目串味、耗时翻倍、hint 说谎。其余错误原样抛出，让下一页调用续链。
    const msg = String((err && err.message) || err);
    if (!/HTTP Error 400|INVALID_CATEGORY/.test(msg)) throw err;
    // 词表外的 slug：去掉 facet 重走一次，宁可给全库首页也不整源进 degraded。
    const r = await chain("");
    return { state: r.state, legacy: r.legacy, lastData: r.lastData, probed: r.probed, facetUsed: "", facetRefused: true };
  }
}

// ── 0.5.190 后台补链泵 ─────────────────────────────────────────────────────
// 单飞表：keyset 游标链不可并行（同一面同时开两条链，各自从各自游标往前走，行会交错重复、
// 上游还容易被连打限流）。同一 catKey 同时只允许一条链，第二个调用等同一条并标 joined。
const SKILLSMP_PUMP_FLIGHTS = new Map();
const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/**
 * 需求队列：用户翻过哪面、词表里有哪面，哪面就排队等补。note 去重（同一面不双份）；
 * next 取队首并放回队尾（轮转，一面卡住不会饿死其余面）；done 退场（取满/上游明说到底）。
 * 空串 facet ＝ 全库面，同样占一个席位。
 */
export function createSkillsMpDemand() {
  const order = [];
  const norm = (f) => String(f == null ? "" : f).trim().toLowerCase();
  return {
    note(f) { const facet = norm(f); if (!order.includes(facet)) order.push(facet); },
    next() { if (!order.length) return null; const facet = order.shift(); order.push(facet); return { facet }; },
    done(f) { const i = order.indexOf(norm(f)); if (i >= 0) order.splice(i, 1); },
    peek() { return order.slice(); },
    size() { return order.length; },
  };
}

const skillsMpDemandQueue = createSkillsMpDemand();

/** searchSkillsMp 翻到哪面就把哪面记进需求队列（后台泵因此知道用户在意什么）。 */
export function noteSkillsMpDemand(facet) { skillsMpDemandQueue.note(facet); }

/**
 * 推一面的一轮链：need=Infinity，预算只由 rounds 定；链实现复用 extendSkillsMpCatalog
 * （三条腿——死游标自愈、catchingUp 跨调用、中毒终态复位——在泵路径同样生效，绝不另写一份）。
 * 返回 {rows,done,joined}；rows 是目录累计行数（数字）。
 */
export async function warmSkillsMpCatalog(store, options = {}) {
  const facet = String(options.facet || "").trim().toLowerCase();
  const sort = String(options.sort || "").trim().toLowerCase();
  const fetchJson = options.fetchJson || getJsonEscalating;
  const rounds = Math.max(1, Number(options.rounds) || SKILLSMP_PUMP_ROUNDS);
  const key = `${SKILLSMP_CATALOG_KEY}${facet || "any"}${sort ? ":" + sort : ""}`;
  const running = SKILLSMP_PUMP_FLIGHTS.get(key);
  if (running) {
    const st = await running;
    return { rows: st.rows.length, done: st.done, joined: true };
  }
  const flight = (async () => {
    const r = await extendSkillsMpCatalog(store, Infinity, facet, sort, fetchJson, {
      headers: { referer: "https://skillsmp.com/" },
      timeoutMs: 20000,
      pythonFirst: true,
    }, rounds);
    return r.state;
  })();
  SKILLSMP_PUMP_FLIGHTS.set(key, flight);
  try {
    const st = await flight;
    return { rows: st.rows.length, done: st.done, joined: false };
  } finally {
    if (SKILLSMP_PUMP_FLIGHTS.get(key) === flight) SKILLSMP_PUMP_FLIGHTS.delete(key);
  }
}

/**
 * 按队列轮转推进：每轮取一面推一轮链，取完（done）退场；链抛错（限流抖动）不外抛、
 * 该面留在队列里下一轮再接——这正是三条腿之外泵自己的容错口径。maxRounds 到点自退，
 * 不吊调用方。返回 {rounds}（实际推进的轮数）。
 */
export async function skillsMpPumpLoop(store, options = {}) {
  const queue = options.queue || skillsMpDemandQueue;
  const rounds = Math.max(1, Number(options.rounds) || SKILLSMP_PUMP_ROUNDS);
  const maxRounds = Math.max(1, Number(options.maxRounds) || 1);
  const sleep = options.sleep || defaultSleep;
  let ran = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const item = queue.next();
    if (!item) break;
    try {
      const r = await warmSkillsMpCatalog(store, { facet: item.facet, fetchJson: options.fetchJson, rounds });
      if (r && r.done) queue.done(item.facet);
    } catch {
      // 瞬时失败：不标 done，队列轮转稍后再接；死游标/中毒态由链内三条腿自愈。
    }
    ran += 1;
    if (options.onRound) options.onRound(item.facet);
    await sleep(SKILLSMP_PUMP_GAP_MS);
  }
  return { rounds: ran };
}

let SKILLSMP_PUMP_TIMER = null;

/**
 * 宿主启动时挂一次：每 SKILLSMP_PUMP_GAP_MS 推进队列里的一面。定时器 unref——
 * 后台泵永远不许阻止宿主退出。队列先用词表缓存播种（只读缓存，不等网络），
 * 之后由用户翻页持续补充。
 */
export function startSkillsMpPump(store, options = {}) {
  if (!store || SKILLSMP_PUMP_TIMER) return { armed: Boolean(SKILLSMP_PUMP_TIMER) };
  const queue = options.queue || skillsMpDemandQueue;
  const arm = () => {
    SKILLSMP_PUMP_TIMER = setTimeout(() => {
      SKILLSMP_PUMP_TIMER = null;
      void (async () => {
        try {
          if (!queue.size()) {
            const vocab = await readSkillsMpCategoryVocabulary({ cache: store });
            if (vocab) for (const c of vocab.categories) queue.note(c.slug);
          }
          await skillsMpPumpLoop(store, { queue, maxRounds: 1, fetchJson: options.fetchJson });
        } catch {
          // 一个 tick 失败不影响下一个：泵是尽力而为的后台进度。
        }
        if (!SKILLSMP_PUMP_TIMER) arm();
      })();
    }, SKILLSMP_PUMP_GAP_MS);
    if (typeof SKILLSMP_PUMP_TIMER.unref === "function") SKILLSMP_PUMP_TIMER.unref();
  };
  arm();
  return { armed: true };
}

export async function searchSkillsMp({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "", fetchJson = getJsonEscalating }) {
  const q = String(query || "").trim();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(SKILLSMP_MAX_LIMIT, Number(pageSize) || 24));
  // facet 是服务端过滤，缓存键必须带上它；带关键词时上游会忽略 facet 并静默换集合（见上），
  // 所以 facet 只在纯浏览态生效。
  const facet = q ? "" : String(category || "").trim().toLowerCase();
  const key = `skillsmp:${q || "all"}:${facet || "any"}:${p}:${size}:${sort || ""}`;
  const cached = cache ? await cache.get(key, SKILLSMP_TTL) : undefined;
  if (cached && Array.isArray(cached.items) && cached.items.length) return { ...cached, source: "skillsmp" };
  // 实测：/api/skills 只认 search。q、keyword、query 一律被忽略（data.filters 只在真键生效时
  // 回显 {"search":...}），所以别不要再把别名当「兜底」一起发——那样面板会以为搜过了，实际拿的是全库首页。
  const params = new URLSearchParams({ page: String(p), limit: String(size) });
  if (q) params.set("search", q);
  // sortBy 实测服务端全盘生效且跨页单调（p1 最小 updatedAt 等于 p2 最大 = 1795140060），
  // 所以这两个键交给上游，绝不再在本页重排——本页重排会把服务端的全盘序打乱。
  if (sort === "stars") params.set("sortBy", "stars");
  else if (sort === "updated") params.set("sortBy", "recent");
  if (facet) params.set("category", facet);
  const options = {
    headers: { referer: "https://skillsmp.com/" },
    timeoutMs: 20000,
    // 唯一需要 python 的站点：Cloudflare 按 TLS 指纹拦截，fetch/curl 均 403，只有 CPython urllib 能过。
    pythonFirst: true,
  };
  const refusedNote = `skillsmp 没有「${facet}」这个分类，已按全部分类显示这一页`;
  // 有缓存且没有关键词 ⇒ 先试顺序游标目录（分类/浏览态取全，见上方取证）。没缓存（旧调用方、
  // 单测直接注入 fetchJson 的页码形状）照旧走下面那条页码通路，一字不改。
  let seedData = null;
  let seedUsed = facet;
  let seedRefused = false;
  if (cache && !q) {
    // 翻到哪面就把哪面记进后台补链队列（0.5.190，m41100 令：目录进度不能只靠翻页驱动，
    // 但用户翻过的面优先补——泵按这个队列轮转推进）。
    noteSkillsMpDemand(facet);
    const cat = await extendSkillsMpCatalog(cache, size * p, facet, sort, fetchJson, options);
    // 只要上游没退回页码形状就用目录切片——包括「本地目录已攒够、这一轮根本不需要再链」的深页
    // （真机 0.5.188 首测第 22 页就撞在这里：链没跑 ⇒ probed=false ⇒ 误落页码通路，
    // 上游把 page=22 钳回第 20 页，把已经破掉的「只剩 480 窗口」旧 hint 又报了一遍）。
    if (!cat.legacy) {
      const crows = cat.state.rows;
      const citems = crows.slice((p - 1) * size, (p - 1) * size + size).map((raw) => skillsMpItemOf(raw, cat.facetUsed));
      const all = cat.state.totalAll;
      const done = cat.state.done;
      const payload = {
        source: "skillsmp",
        items: citems,
        // total 报上游自报的整面目录数（chip 与 hint 同源）；上游没给 totalAll 才退回已取到的条数。
        total: all > 0 ? all : crows.length,
        // 取全链没有「窗口」这个概念：没到底就一直有下一页。
        hasMore: done ? p * size < crows.length : true,
        totalPages: undefined,
        serverFacet: facet !== "" && !cat.facetRefused,
        facetUsed: cat.facetUsed,
        windowed: false,
        catalogProgressive: true,
        hint: cat.facetRefused ? refusedNote : (all > 0
          ? `skillsmp 这个分类共有 ${all} 条，正按顺序取回，已取到前 ${crows.length} 条；接着翻页会继续往后取，直到 ${all} 条取完`
          : `skillsmp 已顺游标取到 ${crows.length} 条，接着翻页会继续往后取`),
      };
      // 空页不落页缓存：一次上游抖动不该把这页钉死十分钟（与下面 legacy 通路同一口径）。
      if (citems.length) await cache.put(key, payload);
      return payload;
    }
    if (cat.probed && cat.legacy && p === 1) {
      // 上游这一包没有游标（旧形状）：就地用已经取回的这包算，绝不为同一页再打第二次请求。
      seedData = cat.lastData;
      seedUsed = cat.facetUsed;
      seedRefused = cat.facetRefused;
    }
  }
  let data;
  let facetUsed = seedUsed;
  let facetRefused = seedRefused;
  if (seedData) {
    data = seedData;
  } else {
    try {
      data = await fetchJson(`https://skillsmp.com/api/skills?${params.toString()}`, options);
    } catch (err) {
      // 页面 63 个可浏览 slug 里 62 个实测被 legacy 接受，板块标题与 documents（探针超时、可浏览性未知）不保证。词表只能从页面解析，
      // 无法运行时预知，所以被拒时去掉 facet 重发一次：宁可给全库首页并说明，也不许整源进 degraded。
      if (!facet) throw err;
      params.delete("category");
      data = await fetchJson(`https://skillsmp.com/api/skills?${params.toString()}`, options);
      facetRefused = true;
      facetUsed = "";
    }
  }
  const rows = Array.isArray(data.skills) ? data.skills : [];
  // name 没有对应的服务端 sort 键，只能本页升序（本页不是全盘，口径由聚合层给 note）；stars/updated 已交上游。
  sortRawRows(rows, sort, { name: (r) => r.name ?? r.skillName });
  // 行上没有分类字段（实测 13 键里没有 category/topics/tags），只能由请求侧回填；
  // facet 被上游拒绝时回填空串，绝不给卡片安一个上游没承认的分类。
  const items = rows.slice(0, size).map((raw) => skillsMpItemOf(raw, facetUsed));
  // Upstream decides what counts as a total, not this function. Measured shapes:
  //   browse             total 1200 + totalIsExact:false + isCapped:true + maxResults:1200 -> window cap
  //   facet browse       total 480 + isCapped:true + maxResults:480 + totalAll -> 窗口深度与真实条数是两个数
  //   search, unfinished total = page*limit+1 + totalIsExact:false -> a lower bound that moves per page
  //   search, exhausted  totalIsExact:true -> that number IS the full match set
  const pg = data.pagination || {};
  const upstreamTotal = Number(pg.total);
  const upstreamAll = Number(pg.totalAll);
  // 先窗口后精确：capped 态里那个 total 是窗口深度（facet 态恒 480），拿它当总数就是谎报目录条数。
  const windowed = pg.isCapped === true || pg.maxResults !== undefined || pg.totalIsExact === false;
  const exactTotal = !windowed && pg.totalIsExact === true && Number.isFinite(upstreamTotal);
  let total;
  let hasMore;
  let totalPages;
  let hint;
  if (exactTotal) {
    total = upstreamTotal;
    hasMore = Boolean(pg.hasNext);
    totalPages = Number(pg.totalPages) || (total ? Math.max(1, Math.ceil(total / size)) : 1);
  } else if (windowed) {
    // Leave the count unknown instead of presenting a window as the catalogue, and say why on the
    // hint channel (sources.js:598 collects hints, client.js renders them as one notice line).
    hasMore = typeof pg.hasNext === "boolean" ? pg.hasNext : undefined;
    // A number is nameable only when upstream states the window size itself (maxResults) or the real
    // size of that facet (totalAll). A bare totalIsExact:false ships a value that moves every page,
    // so quoting it would be this function inventing a figure upstream never stated.
    const window = Number(pg.maxResults) || 0;
    if (Number.isFinite(upstreamAll)) {
      total = upstreamAll;
      const depth = window > 0 ? Math.max(1, Math.ceil(window / size)) : Number(pg.totalPages) || 1;
      totalPages = depth;
      if (pg.hasNext === false) hasMore = false;
      hint = `skillsmp 这个分类共有 ${upstreamAll} 条，上游只让浏览前 ${window} 条（约 ${depth} 页），剩下的没有翻页入口；换关键词能搜到别的结果，但那样就不按这个分类筛了`;
    } else if (window === 0) {
      // 只有「连窗口多大都不知道」才需要那句话。窗口自报过 maxResults 时不再对用户念
      // 科普（用户 2026-11-23 点名那条说明已失效）：总数与页数照旧留未知（上面不赋
      // total/totalPages 就是这个意思），只是不解释——面板的分类 chip 各自带上游 totalAll，
      // 「继续往里走」早就不止「换关键词」一条路，那句出路本身已经不成立。
      hint = SKILLSMP_UNBOUNDED_NOTE;
    }
    if (facetRefused) hint = refusedNote;
  } else {
    // No pagination block at all: still unknown, and no fabricated lower bound.
    hasMore = items.length === size;
    hint = facetRefused ? refusedNote : SKILLSMP_UNBOUNDED_NOTE;
  }
  // serverFacet 是给聚合层的声明：facet 确实作为服务端参数发了出去、且没有被 400 拒回，
  // 这一页才是「上游已按分类筛过的集合」。聚合层只有收到 true 才敢关掉本地过滤——谎报等于
  // 把首屏那一页说成整目录已筛过（带关键词时 facet 根本不发，所以必为 false）。
  const serverFacet = facet !== "" && !facetRefused;
  // windowed：把「上游窗口硬封顶」这个事实随包声明出去（实测 skillsmp isCapped/maxResults/totalIsExact:false
  // 三种形态都成立）。聚合侧（harvest tail）据此报 tail.windowed，不必再猜第二次。
  const payload = { source: "skillsmp", items, total, hasMore, totalPages, serverFacet, facetUsed, windowed };
  if (hint) payload.hint = hint;
  // An empty page is never cached: one upstream hiccup must not blank the market for ten
  // minutes, and the next request should retry immediately.
  if (cache && items.length) await cache.put(key, payload);
  return payload;
}


// ---------------------------------------------------------------- ModelScope
// PUT https://modelscope.cn/api/v1/dolphin/skills {PageNumber,PageSize,Query?} → Data.SkillList,
// Data.TotalCount（实测 88k+ 条、页与页不重复）。技能正文挂在 SourceURL 的 GitHub 地址上。
const MODELSCOPE_SKILLS_URL = "https://modelscope.cn/api/v1/dolphin/skills";
// ── ModelScope 分类词表（随包静态表）─────────────────────────────────────────
// 为什么不是动态词表：该上游根本没有分类 facet 端点。12 个候选参数名（Category/L1/
// CatalogID/Catalog/Categories/Tags/Tag/FirstCategory/Classification/labels/L1List/
// CatalogIDs）× 三姿势共 30 组探针，rows、total、distinctL1 逐位相同 = 全部 IGNORED
//（取证 C:/Users/Public/dsh-scratch/vocab164/FINAL.md、APPENDIX.txt、t2_report.md）。
// 服务端既不过滤也不下发计数，唯一诚实的做法就是随包静态词表 + 可达集合内本地过滤，
// 因此返回值里绝不出现 serverFacet。
// 表底稿：ModelScope 官方分类接口的 20 个非空 CatalogID（Parent=0 的 10 个根 + 10 个子项）。
// slug 与 label 都取 ChineseName 原文，不是 CatalogID：面板（client.js:1863）与聚合层
//（sources.js:847）都拿行内分类原文做等值比较，行内原文来自 raw.L1.ChineseName（本文件 items
// map 的 category 字段）；chip 若用 CatalogID，卡片显示退回英文而过滤永远筛不中。
// 不带条数：上游没有分类级计数字段，写进 chip 就是假数（同 trusttools 口径）。
// sdk 类不入表：83 个采样 0 命中，未证实（不猜）。英文 Name 只留在注释里，不进 categories。
const MODELSCOPE_ORIGIN = "https://modelscope.cn/";
// [CatalogID, ChineseName, 条数(仅注释留档), 是否子项] —— 顺序即 FINAL.md 表序，chip 稳定。
// developer-tools 开发工具 4070 / ai-media 媒体处理 2526 / code-quality-testing 代码质检 2074
// cloud-devops 云效工具 1393 / marketing-seo 市场推广 1087 / frontend-development 前端开发 1060
// other 其他 565 / skill-management Skills管理 279 / scientific-tool 科研工具 216 / mobile-development 移动开发 207
// ai-automation AI 自动化 168 / content-strategy 内容策略 21 / doc-processing 文档处理 (PDF/PPTX/DOCX) 6
// analytics 分析追踪 6 / ui-ux-design UI/UX 设计 5 / cost-optimization 成本优化 5 / monitoring 监控 2
// skill-creation 技能创建 2 / api-design API 设计 2 / general-tools 通用工具 1
const MODELSCOPE_CATEGORY_ROWS = [
    ["developer-tools", "开发工具", 4070, 0],
    ["ai-media", "媒体处理", 2526, 0],
    ["code-quality-testing", "代码质检", 2074, 0],
    ["cloud-devops", "云效工具", 1393, 0],
    ["marketing-seo", "市场推广", 1087, 0],
    ["frontend-development", "前端开发", 1060, 0],
    ["other", "其他", 565, 0],
    ["skill-management", "Skills管理", 279, 0],
    ["scientific-tool", "科研工具", 216, 0],
    ["mobile-development", "移动开发", 207, 0],
    ["ai-automation", "AI 自动化", 168, 1],
    ["content-strategy", "内容策略", 21, 1],
    ["doc-processing", "文档处理 (PDF/PPTX/DOCX)", 6, 1],
    ["analytics", "分析追踪", 6, 1],
    ["ui-ux-design", "UI/UX 设计", 5, 1],
    ["cost-optimization", "成本优化", 5, 1],
    ["monitoring", "监控", 2, 1],
    ["skill-creation", "技能创建", 2, 1],
    ["api-design", "API 设计", 2, 1],
    ["general-tools", "通用工具", 1, 1],
];
const MODELSCOPE_CATEGORY_CN = MODELSCOPE_CATEGORY_ROWS.map((row) => row[1]);
// cacheKey 的分类段必须是 ASCII：makeCache 落盘文件名走 key.replace(/[^A-Za-z0-9_.-]/g, "_")
//（src/sources.js:41 与 :56）。中文分类名会塌进同一个 json 文件，第二个分类在 5 分钟 TTL 内
// 直接读到第一个分类的结果（实测 市场推广 与 移动开发 共用 modelscope_search__1_24______.json）。
// 表内分类复用现成的 CatalogID 做 ASCII 段；表外分类把原文逐字符转码点序列，仍然互不相同，
// 这样拒发态也不会复用无分类态的缓存（hint 会点名错误的分类）。
const MODELSCOPE_CATEGORY_ID = {};
for (const msCatRow of MODELSCOPE_CATEGORY_ROWS) MODELSCOPE_CATEGORY_ID[msCatRow[1]] = msCatRow[0];

/** 分类入参 → cacheKey 用的 ASCII 片段；空/all 回空串（与无分类同键）。模块私有。 */
function modelscopeCategoryCacheToken(value) {
  const key = String(value === null || value === undefined ? "" : value).trim();
  if (!key || key === "all") return "";
  if (MODELSCOPE_CATEGORY_ID[key]) return MODELSCOPE_CATEGORY_ID[key];
  return "ref-" + Array.from(key).map((ch) => ch.codePointAt(0).toString(36)).join("-");
}

/** 静态 L1 词表快照：形状与 trusttools/skillsmp/clawhub/lobehub 一致，面板按 source 前缀核验归属。 */
export function modelscopeCategoryVocabulary() {
  return {
  capturedAt: Date.parse("2026-11-24T00:00:00Z"),
  source: MODELSCOPE_ORIGIN,
  categories: MODELSCOPE_CATEGORY_CN.map((label) => ({ slug: label, label })),
  };
}

/**
 * 分类入参归一：命中表内 ChineseName 才回该原文；空/all/表外一律回空串（=不按分类过滤）。
 * 表外回空串不等于「该分类下没有匹配」——调用方须据此拒发并如实提示，绝不静默清空结果。
 */
export function modelscopeCategoryOf(value) {
  const key = String(value === null || value === undefined ? "" : value).trim();
  if (!key || key === "all") return "";
  return MODELSCOPE_CATEGORY_CN.indexOf(key) >= 0 ? key : "";
}

/** 入参非空但归一后为空 = 表外分类（需要拒发提示），回原始入参供 hint 点名。 */
function modelscopeCategoryRefused(value) {
  const key = String(value === null || value === undefined ? "" : value).trim();
  if (!key || key === "all") return "";
  return MODELSCOPE_CATEGORY_CN.indexOf(key) >= 0 ? "" : key;
}


// 矩阵（sort-capability.js:31）对 modelscope 声称 installCount/stars/newest/updated/name。
// 上游没有任何服务端 sort，所以「支持」= 全量拉取后本地排。少一个键进全量分支，
// 就是那一键只在单页内有序（跨页错乱），即「声称支持、线路不生效」。
// 与 MODELSCOPE_SORT_GETTERS 同步：ModelScope 上游只有 DownloadCount（下载数），没有安装量列。
// 全量排分派表必须认这个键，否则 downloadCount 退回单页分支 —— 正是本套件头部写的
// 「缺陷2」形态（只对一页排序、跨页错乱）。
export const MODELSCOPE_FULL_SORT_KEYS = ["downloadCount", "stars", "newest", "updated", "name"];

/** 该排序键是否需要全量拉取 + 本地排 + 切页；false = 保持上游分页（快，一次调用）。 */
export function modelScopeSortMode(sort) {
  return MODELSCOPE_FULL_SORT_KEYS.includes(String(sort || "").trim());
}

// 排序键 → 上游行字段（实测列名）：DownloadCount / SourceStar|Likes / GmtCreate / GmtModify|LastSyncTime / DisplayName|Name
// 注意 DownloadCount 是下载数不是安装数（该源上游没有安装量列），所以键名叫 downloadCount ——
// 旧名 installCount 会让卡片显示「N 次安装」而数字其实是下载数。
export const MODELSCOPE_SORT_GETTERS = {
  downloadCount: (r) => r.DownloadCount,
  stars: (r) => r.SourceStar ?? r.Likes,
  newest: (r) => Date.parse(r.GmtCreate) || Number(r.GmtCreate) || 0,
  updated: (r) => Date.parse(r.GmtModify || r.LastSyncTime) || 0,
  name: (r) => r.DisplayName || r.Name,
};

export async function searchModelScope({ query = "", page = 1, pageSize = 24, cache, sort = "", category = "", transport = null, msOnPartial = null, harvestBypass = false } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const q = String(query || "").trim();
  // 上游无 sort（实测 9 种参数名全部被忽略），但 PageSize 可到 20000（实测）。
  // 排序模式 = 全量拉取（88,993 条 ÷ 20000 = 5 次调用，缓存 6h）后在完整集合上本地排 + 切页。
  // 旧实现取 500 条窗口本地排——对全量属于近似，禁止。
  //
  // 旧 sortMode 只认 installCount/name，于是矩阵 :31 声称支持的 stars/newest/updated
  // 落到「单页分支」：只取一页 → 只对这一页排 → 用户看到「按星级」却跨页错乱。
  // 现在 5 个键一律走全量分支。代价（明确记账）：这 3 个键从「单页快但错」变成
  // 「首次慢（5000×9 全量拉取，实测约 30–90 s）后正确」；fullKey 缓存 6h，翻页只是切片。
  const sortMode = modelScopeSortMode(sort);
  // 分类入参归一（该上游无服务端 facet，见上方词表小节）：表内才过滤，表外拒发。
  const catActive = modelscopeCategoryOf(category);
  const catRefused = modelscopeCategoryRefused(category);
  // 分类与排序共用全量分支：只滤当前页时 doc-processing(6)/monitoring(2)/general-tools(1)
  // 这类小条数子类在首页可达行里几乎必为 0 行，会把「该分类存在」错报成「该分类为空」。
  const useFull = sortMode || Boolean(catActive);
  // 非排序模式：保持上游分页（快，一次调用）。
  // 排序模式：上游无服务端 sort，必须拉全量（88,993 ÷ 20000 ≈ 5 次）在完整集合上排。
  const cacheKey = `modelscope:search:${q.toLowerCase()}:${p}:${size}:${sort || ''}:${modelscopeCategoryCacheToken(category)}`;
  const hit = cache ? await cache.get(cacheKey, 5 * 60 * 1000) : undefined;
  if (hit) return { ...hit, source: "modelscope" };
  const fetchOne = async (pageNumber, pageSize, timeoutMs = 25000) => {
    const response = await (transport || fetch)(MODELSCOPE_SKILLS_URL, {
      method: "PUT",
      headers: { ...UA, "content-type": "application/json" },
      body: JSON.stringify({ PageNumber: pageNumber, PageSize: pageSize, ...(q ? { Query: q } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`ModelScope HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload.Data || {};
    return { rows: Array.isArray(data.SkillList) ? data.SkillList : [], total: Number(data.TotalCount) || 0 };
  };
  let rows = [];
  let total = 0;
  // 渐进式加载（harvest 通路）：分类谓词全仓只有一份 —— msRowInCategory（最终 categoryRows 与
  // 逐页增量共用同一谓词）；行归一 msMapItems 在下方 items 处收口（同样只有一份），msPushPartial
  // 是函数声明、可在定义前被取数循环调用。禁止第二份口径。
  const msRowUsable = (raw) => Boolean(raw && raw.Name);
  const msRowInCategory = (raw) => Boolean(raw && raw.L1 && typeof raw.L1 === "object" && raw.L1.ChineseName === catActive);
  const msPagePasses = (raws) => {
    const usable = raws.filter(msRowUsable);
    return catActive ? usable.filter(msRowInCategory) : usable;
  };
  function msPushPartial(raws) {
    if (!msOnPartial || !useFull) return;
    const pushed = msMapItems(msPagePasses(raws));
    if (!pushed.length) return;
    try { msOnPartial(pushed, {}); } catch { /* 面板推送失败绝不影响取数循环 */ }
  }
  // 0.5.165 Fix B —— 分页形状（本机同姿势实测：PageSize=5000 → HTTP 200 但 wall=66s；
  // PageSize=1000 → 24.1s；PageSize=200 → 7.3s）。旧写法 fetchOne(1, 5000, 90 秒) 让一次大页
  // 请求决定整源生死：live 撞 90.3 秒 abort（监测方留档 after164-chips.txt：cat=市场推广/开发工具
  // /监控 三条一律 items=0 wall=90.3 秒），紧随的 裸 catch 后 break 又把失败静默吞掉 ⇒ 可达集合
  // =空 ⇒ 分类永远筛不出行。改成小页多拉 + 每页超时 + 单次调用硬预算 + 断点游标续暖：
  //   MS_PAGE 1000 —— 1000 行档实测 24.1s，可被 30s 单页超时兜住（旧 5000 行 66s 兜不住）
  //   MS_MAX_PAGES 30 —— 上界取实测可达上界 30×1000=30,000 行：第 31 页起上游一律 HTTP 500 +
  //     list_skill_failed（p31/n1000、p16/n2000、p151/n200 同红；p30/n1000、p15/n2000、p150/n200 同绿）。
  //   MS_PAGE_TIMEOUT_MS 30000 —— 24.1s 之上留一档；不再沿用 90 秒
  //   MS_FETCH_BUDGET_MS 45000 —— 单次调用在拉取循环上的硬时间预算，只在实际超时时截断，
  //     且首个未缓存页不受预算截断（否则慢机器会退化成整源归零）
  // 预算算术：MS_FETCH_BUDGET_MS(45s) + MS_PAGE_TIMEOUT_MS(30s) = 75s 最坏等待 < 旧 abort 上限，
  // 有界；聚合路径每源 12s（src/sources.js:550 DEFAULT_BUDGET_MS）在更外层截断，口径互不遮蔽。
  const MS_PAGE = 1000;
  const MS_MAX_PAGES = 30;
  const MS_PAGE_TIMEOUT_MS = 30000;
  const MS_FETCH_BUDGET_MS = 45000;
  // 取数失败/预算截断必须可见（B2）：页码与原因记账进返回值，绝不裸 break 当没事。
  const msFetchFailures = [];
  let msBudgetStop = false;
  let msDone = false;
  let msNextPage = 0;
  if (useFull) {
    // 全量目录缓存 6 小时：排序与分类都是对已取回集合做的，翻页只是切片，不再重复拉取。
    const fullKey = `modelscope:full:${q.toLowerCase()}`;
    const fullHit = cache ? await cache.get(fullKey, 6 * 3600 * 1000) : undefined;
    const startedAt = Date.now();
    // 缓存里的行集只是「已取回的前 N 页」，不是全量：done=false 时从第 next 页续暖，
    // 绝不回头重取已成功的页（换分类/翻页因此都不重拉，断点续取实测生效）。
    rows = fullHit && Array.isArray(fullHit.rows) ? fullHit.rows : [];
    total = Number(fullHit && fullHit.total) || 0;
    const cachedPages = rows.length ? Math.ceil(rows.length / MS_PAGE) : 0;
    let next = fullHit && fullHit.done ? 0 : cachedPages + 1;
    msDone = next === 0;
    if (next > 0) {
      // 断点续暖：缓存里已有的前 N 页立刻推给会话（冷启动时这里是空集，逐页推在循环里）。
      msPushPartial(rows);
      // 注意边界：pagesNeeded 是**需要的页数**，循环必须含它（旧写法 pg < pagesNeeded 少拉
      // 最后一页，实测差一整页 ≈ 可达集合的 3%（1000/30,000），与注释声称的覆盖自相矛盾）。空页仍由 break 兜住。
      const msPagesNeeded = (n) => Math.min(MS_MAX_PAGES, Math.ceil(Math.min(n || 1, MS_PAGE * MS_MAX_PAGES) / MS_PAGE));
      // 页数上界必须在拿到第一页的 TotalCount 之后再定：缓存未命中时 total 还是 0，先算会把
      // 上界误判成 1 页（只取 1000 行就收工，正是小分类筛不出行的老毛病）。total 未知时按硬上界
      // 一直试到空页为止（上游实测硬上限 offset≈30,000 行，再深直接 500）。
      let pagesNeeded = total > 0 ? msPagesNeeded(total) : MS_MAX_PAGES;
      while (next <= pagesNeeded) {
        // 预算截断只在已经取到行时生效：一页都没取回时至少把下一页试完。
        // harvest 旁路：渐进式会话「有多少显示多少」是用户明确要求，45s 预算只属于一次性调用。
        if (!harvestBypass && next > cachedPages + 1 && rows.length && Date.now() - startedAt > MS_FETCH_BUDGET_MS) {
          msBudgetStop = true;
          break;
        }
        try {
          // harvestBypass 只豁免「超预算就停」：30s 单页超时（MS_PAGE_TIMEOUT_MS）保留作挂死兜底，
          // MS_MAX_PAGES=30 是上游硬上限（第 31 页起 HTTP 500），保留。
          const nx = await fetchOne(next, MS_PAGE, MS_PAGE_TIMEOUT_MS);
          if (!nx.rows.length) {
            msDone = true; // 上游到尽头（实测 5000×9 时 page10 起为空）
            break;
          }
          rows = rows.concat(nx.rows);
          // 逐页推：这一页新取回的行当场过滤+归一推给会话（不排序、不切页——排序后的整表在收口包），
          // 绝不憋到收口（面板要的是「不断增加新结果」）。
          msPushPartial(nx.rows);
          if (!total && nx.total) {
            total = nx.total;
            pagesNeeded = msPagesNeeded(total);
          }
          next += 1;
        } catch (error) {
          // 失败绝不静默：记页码与原因，保住已取到的行（部分成功 > 整源归零），断点留在缓存里
          // 让下一次调用从这一页重试。不再 break 之后当没事发生。
          msFetchFailures.push({ page: next, error: String((error && error.message) || error) });
          break;
        }
      }
      if (!msFetchFailures.length && !msBudgetStop && next > pagesNeeded) msDone = true;
      msNextPage = next;
      if (cache && rows.length) await cache.put(fullKey, { rows, total, next, done: msDone });
    } else {
      msNextPage = next;
    }
  } else {
    const one = await fetchOne(p, size);
    rows = one.rows;
    total = one.total;
  }
  const usableRows = rows.filter((raw) => raw && raw.Name);
  // 分类过滤在已取回的行集内做；换分类不重拉行集（fullKey 仍只按 query，整份行集只拉一次）。
  let categoryRows = usableRows;
  let catFiltered = false;
  if (catActive) {
    categoryRows = usableRows.filter(msRowInCategory);
    catFiltered = true;
  }
  const catTotal = catFiltered ? categoryRows.length : 0;
  // 取数中断的可区分文案（B2）：失败页/预算截断必须写成「取数失败」，绝不与「本类实测 0 条」
  // 混为一谈；hint 里的行数一律是实际取回的行数（rows.length），中断时绝不写成没取满的 30,000。
  const msFailPages = msFetchFailures.map((f) => f.page).join('/');
  const msInterrupt = msFailPages
    ? '第 ' + msFailPages + ' 页取数失败/超时'
    : (msBudgetStop ? '本轮取数已用完 ' + Math.round(MS_FETCH_BUDGET_MS / 1000) + 's 时间预算（中断于第 ' + msNextPage + ' 页）' : '');
  const msResumeNote = '下次搜索会从第 ' + msNextPage + ' 页继续补拉';
  // 上游分页深度上限（实测 offset≈30k）导致可达集合 < 全量时，如实告知用户排序覆盖范围。
  // 中断态绝不再声称「排序覆盖上游可返回的全部行」——那是假话。
  let msDepthHint = "";
  if (sortMode && total > rows.length) {
    msDepthHint = msInterrupt
      ? 'ModelScope 排序取数中断（' + msInterrupt + '），本次只在已取回的 ' + rows.length.toLocaleString() + ' 行内排序（目录共 ' + total.toLocaleString() + ' 条），不是全量覆盖；' + msResumeNote
      : `ModelScope 排序已覆盖能取回的 ${rows.length.toLocaleString()} 条（该源目录共 ${total.toLocaleString()} 条，其余暂时取不到）`;
  }
  // 分类态/表外拒发的如实提示：过滤在本地做，行数与 total 都是已取回行内的实测值，跨页
  // 有效；同时说明可达集合外的分类会漏（残余风险），不假装覆盖了全目录。
  // facetUsed（0.5.177 I4）：词表内分类回该分类原文 = 「这一批行已按该分类过滤（词表内
  // 表外/空/all 回空串 = 没筛过。它与「服务端已筛」是两种语义，这里绝不声明后者——
  // 把本地过滤谎报成服务端筛过会连带打破聚合层的 facetConfirmed 计票与
  // test-category-info-declaration 的 declaredCategoryInfo 口径（0.5.165 的诚实声明继续有效）。
  let msCatHint = "";
  if (catActive) {
    msCatHint = msInterrupt
      ? 'ModelScope 分类取数中断（' + msInterrupt + '）：这次只取回 ' + rows.length.toLocaleString() + ' 行（该源目录共 ' + total.toLocaleString() + ' 条），本类在这些行里命中 ' + catTotal.toLocaleString() + ' 条；这不是「该分类没有匹配」，是取数失败，' + msResumeNote
      : 'ModelScope 分类在已取回的 ' + rows.length.toLocaleString() + ' 行里筛出（该源目录共 ' + total.toLocaleString() + ' 条，其余暂时取不到）；本类实测 ' + catTotal.toLocaleString() + ' 条';
  } else if (catRefused) {
    msCatHint = 'ModelScope 没有「' + catRefused + '」这个分类（不是「这个分类下没有东西」），已按全部分类显示这一页';
  }
  const msHint = msCatHint || msDepthHint;
  sortRawRows(categoryRows, sort, MODELSCOPE_SORT_GETTERS);
  const pageRows = useFull ? categoryRows.slice((p - 1) * size, p * size) : usableRows;
  // categoryInfo = 该源的分类能力声明：ModelScope 每条行都带 L1.ChineseName（见下方 items 归一），
  // 与本页取到几条无关。聚合层 src/sources.js:840 的 catSupported 目前只看 items.some(...)，
  // 分类态本页 0 条时便误判成「该源不提供分类信息」——那句对 modelscope 是假的（本页 0 条是
  // 可达窗口内该类无行，不是源没有分类）。字段在此声明，消费方由 lead 在聚合层接。
  const categoryInfo = true;
  function msMapItems(rawRows) {
    return rawRows.map((raw) => {
    const owner = raw.Path || raw.Owner || "";
    const name = raw.Name || "";
    const ident = owner ? `${owner}/${name}` : name;
    const source = String(raw.SourceURL || "");
    const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/i.exec(source);
    const repo = gh ? `${gh[1]}/${gh[2]}` : "";
    const branch = gh ? gh[3] : "main";
    const skillDir = gh ? gh[4].replace(/\/?SKILL\.md$/i, "") : "";
    return {
      id: `modelscope:${ident}`,
      slug: name,
      name: raw.DisplayName || name,
      description: raw.Description || raw.DescriptionEn || "",
      category: raw.L1 && typeof raw.L1 === "object" ? raw.L1.ChineseName || "" : "",
      source: "modelscope",
      sourceLabel: "ModelScope",
      owner,
      homepage: source || `https://modelscope.cn/skills/${ident}`,
      upstreamUrl: repo ? `${repo}@${branch}` : "",
      ref: branch,
      skillDir,
      downloads: Number(raw.DownloadCount || 0),
      // 该源上游无安装量列：installs 保持 0（面板不显示），不把下载数冒充安装数。
      // 注：此前行被多缩进两个空格（771 行），一并修正。
      installs: 0,
      // 展示字段与 MODELSCOPE_SORT_GETTERS 同源（stars=SourceStar|Likes，时间戳同 :665-668 的读法）：
      // 此前 modelscope 卡片不带这几个字段，「按星级/按最新」排完在界面上无从核验。
      // 字段名沿用 clawhub 的既有约定（:100-101 的 createdAt/updatedAt），不另造新名。
      stars: Number(raw.SourceStar ?? raw.Likes) || 0,
      // 兼容两种上游格式（epoch ms 或日期串，实测未定）：先 Date.parse 再退 Number，
      // 与 MODELSCOPE_SORT_GETTERS 同一读法，避免「卡片显示 0 但确实按时间排了」。
      createdAt: Number(Date.parse(raw.GmtCreate) || raw.GmtCreate) || 0,
      updatedAt: Number(Date.parse(raw.GmtModify || raw.LastSyncTime) || raw.GmtModify) || 0,
      tags: Array.isArray(raw.Tags) ? raw.Tags : [],
      installable: true,
      modelScopeIdent: ident,
    };
    });
  }
  const items = msMapItems(pageRows);
  // total 口径：分类态用可达集合内过滤后的真实条数；普通态上游 TotalCount 缺失/0 且本页
  // 无行时绝不反推页码（旧写法 p*size+1 让空深页凭空造出 2400、14400）——只在确实有行时
  // 兜底反推，与 sources.js:833 的守卫同一口径。
  const resultTotal = catFiltered ? catTotal : (total || (items.length > 0 ? p * size + (rows.length >= size ? 1 : 0) : 0));
  const resultHasMore = catFiltered ? p * size < catTotal : (resultTotal ? p * size < resultTotal : rows.length >= size && items.length > 0);
  const result = { source: "modelscope", items, categoryInfo, facetUsed: catActive, total: resultTotal, hasMore: resultHasMore, ...(msHint ? { hint: msHint } : {}), ...(msFailPages ? { msFetchFailures: msFetchFailures.length, msFetchFailedPages: msFailPages } : {}) };
  // facetUsed 必须待在被缓存的那份 result 里（:1584 put 的就是这个对象，:1375 命中路径
  // 原样回吐）：缓存键 :1373 已含分类 token，A 类的声明不会串到 B 类。
  // 行集不完整（取数失败或预算截断）时绝不把这一轮结果写进 5 分钟结果缓存：那会把「取数失败」
  // 的文案冻住 5 分钟，并让下一次搜索直接命中截断结果、把续暖通道堵死。
  const msPartial = useFull && (!msDone || msFetchFailures.length > 0 || msBudgetStop);
  if (cache && !msPartial) await cache.put(cacheKey, result);
  return result;
}

/**
 * Download a ModelScope skill via the official ZIP endpoint:
 *   https://modelscope.cn/skills/<owner>/<name>/archive/zip/master
 * The ZIP contains a single top-level directory (e.g. `skills-owner.name-master-<sha>/`)
 * with SKILL.md inside. Returns { name, description, files } in the same shape as
 * lobehubAgentSkill, so callers in skills.js can use it unchanged.
 */
export async function modelScopeSkill(ident) {
  if (!ident) throw new Error("modelscope skill install requires an ident (owner/name)");
  const { readZip, stripCommonPrefix, locateSkillRoot } = await import("./zip.js");
  const { pythonDownload } = await import("./http.js");
  const url = `https://modelscope.cn/skills/${encodeURIComponent(ident)}/archive/zip/master`;
  let buffer;
  try {
    const response = await fetch(url, {
      headers: { ...UA, accept: "application/zip, application/octet-stream" },
      signal: AbortSignal.timeout(60000),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    // Fall back to the Python transport (honours the system proxy):
    const { mkdtemp } = await import("node:fs/promises");
    const { join: jp } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmp = await mkdtemp(jp(safeTempDir(), "dsh-ms-zip-"));
    const target = jp(tmp, "skill.zip");
    try {
      await pythonDownload(url, target, { timeoutMs: 60000 });
      const { readFile: rf } = await import("node:fs/promises");
      buffer = await rf(target);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const { files: raw } = readZip(buffer);
  const flat = stripCommonPrefix(raw);
  const root = locateSkillRoot(flat);
  if (root === null) throw new Error("ModelScope ZIP 里没有找到 SKILL.md");
  const prefix = root ? `${root}/` : "";
  const files = {};
  for (const [entry, content] of Object.entries(flat)) {
    if (prefix && !entry.startsWith(prefix)) continue;
    files[entry.slice(prefix.length)] = content;
  }
  const skillText = files["SKILL.md"] || "";
  const meta = skillMetaFromText(skillText, ident);
  if (!meta.name || !meta.description) {
    throw new Error("ModelScope skill SKILL.md 缺少 name 或 description frontmatter");
  }
  return { name: meta.name, description: meta.description, files };
}

/**
 * Download a ModelScope skill via its GitHub upstream (when the search API
 * returned an `upstreamUrl` such as `owner/repo@branch` + `skillDir`).
 * Uses the shared `downloadSkillDir` from github.js — the same fast path
 * skills.sh and skillsmp use. Returns { name, description, files } in
 * the same shape as modelScopeSkill, so callers in skills.js are unchanged.
 *
 * Throws when the GitHub download fails so the caller can fall back to
 * the official ZIP endpoint (modelScopeSkill).
 */
export async function modelScopeGitHubSkill(upstreamUrl, skillDir, ident) {
  if (!upstreamUrl) throw new Error("modelscope GitHub fast path requires an upstreamUrl (owner/repo@branch)");
  const { downloadSkillDir, parseRepoRef } = await import("./github.js");
  const { mkdir, rm, mkdtemp, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: jp } = await import("node:path");

  const parsed = parseRepoRef(upstreamUrl);
  const repo = parsed.repo;
  const ref = parsed.ref || "main";

  const tmp = await mkdtemp(jp(safeTempDir(), "dsh-ms-gh-"));
  try {
    await mkdir(jp(tmp, "skill"), { recursive: true });
    const { files: written, skillText, skipped } = await downloadSkillDir({
      repo,
      ref,
      skillDir: skillDir || "",
      destDir: jp(tmp, "skill"),
    });
    if (!written.length || !skillText) {
      throw new Error(`ModelScope GitHub download produced no files for ${repo}@${ref}${skillDir ? "/" + skillDir : ""}`);
    }
    // Collect the in-memory file map so skills.js can use the same writeSkill path.
    const files = {};
    for (const rel of written) {
      const { readFile: rf } = await import("node:fs/promises");
      files[rel] = await rf(jp(tmp, "skill", rel), "utf8");
    }
    const meta = skillMetaFromText(files["SKILL.md"] || "", ident);
    if (!meta.name || !meta.description) {
      throw new Error("ModelScope skill SKILL.md 缺少 name 或 description frontmatter");
    }
    return { name: meta.name, description: meta.description, files };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve a clawhub reference (`owner/slug`) to its GitHub-backed skill directory.
 *
 * Two strategies, tried in order:
 *   1. HTML scrape — fetch the clawhub.ai detail page and regex-extract the GitHub
 *      repo URL. Fast when the page structure still carries a bare github.com link.
 *   2. Search API — fall back to `clawhub.ai/api/v1/search?q=<slug>` and read the
 *      structured `links.source` field from the matching result.  Works even when
 *      the HTML page no longer embeds a raw GitHub URL (the 2026-11 failure mode).
 *
 * Returns `{ repo, skillDir, apiFallback }` — `apiFallback` is true when the
 * structured API supplied the repo instead of the HTML scrape.
 * If neither strategy finds a GitHub source, throws an Error whose message
 * includes the detail-page URL so the client can offer a "open in browser" fallback.
 */
export async function clawhubResolve(reference) {
  const [owner, slug] = String(reference || "").split("/");
  if (!owner || !slug) throw new Error("clawhub 引用格式应为 owner/slug");

  // Strategy 1: HTML scrape (original path, may fail if page structure changed).
  let htmlMatch = null;
  try {
    const page = await (await fetch(`https://clawhub.ai/${owner}/skills/${slug}`, {
      headers: UA,
      signal: AbortSignal.timeout(15000),
    })).text();
    htmlMatch = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/[\w.-]+\/([\w./-]+))?/.exec(page);
  } catch {
    // Network hiccup — fall through to API.
  }
  if (htmlMatch) return { repo: htmlMatch[1], skillDir: htmlMatch[2] || "", apiFallback: false };

  // Strategy 2: Search API (structured, resilient to HTML changes).
  try {
    const results = await getJsonClawHub(
      `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(slug)}&page=1&limit=20`,
    );
    const rows = Array.isArray(results) ? results : results?.results || [];
    const hit = rows.find(
      (r) => r?.ownerHandle === owner && r?.slug === slug,
    ) || rows.find((r) => {
      const ref = r?.install?.reference || "";
      return ref === `${owner}/${slug}`;
    });
    if (hit) {
      // links.source carries the GitHub repo URL when the skill has one.
      const sourceUrl =
        hit.links?.source ||
        hit.install?.sourceUrl ||
        hit.upstreamUrl ||
        "";
      if (sourceUrl) {
        const m = /github\.com\/([\w.-]+\/[\w.-]+)(?:\/tree\/[\w.-]+\/([\w./-]+))?/.exec(sourceUrl);
        if (m) return { repo: m[1], skillDir: m[2] || "", apiFallback: true };
      }
      // Some entries carry the repo under native.skill or sourceIdentity.
      const repoField =
        hit.native?.skill?.repoUrl ||
        hit.sourceIdentity?.repo ||
        hit.native?.repo ||
        "";
      if (repoField) {
        return { repo: String(repoField).replace(/^github\.com\//, "").replace(/^https?:\/\/github\.com\//, ""), skillDir: "", apiFallback: true };
      }
    }
  } catch {
    // API also unreachable — fall through to the error below.
  }

  const detailUrl = `https://clawhub.ai/${owner}/skills/${slug}`;
  throw new Error(
    `clawhub 页面与 API 里都没有找到 GitHub 源仓库（${detailUrl}）——可直接在浏览器中打开该页查看详情`,
  );
}

