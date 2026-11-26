// SkillHub community source adapter (public, unauthenticated JSON API).
const BASE = "https://api.skillhub.cn/api/skills";
const UA = { "User-Agent": "dsh-skill-mcp-market/0.1 (+skill market)", accept: "application/json" };

async function getJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error(`SkillHub HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error(`SkillHub error code ${payload?.code}`);
    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}


// v1 端点的响应是裸对象（实测顶层键 createdAt,dimensions,skillId,summary,updatedAt,
// userSummary,versionId），没有列表接口那层 code/message/data 封装。因此必须另走一条
// 不校验 code 的取数路径 —— 套用上面的 getJson 会把 200 的成功响应判成错误（当年
// categories 就是撞在这个差异上，端点还写错了，详见下方注释）。
async function getJsonV1(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) throw new Error('SkillHub v1 HTTP ' + response.status);
    // v1 端点族里混着会回 200 + SPA HTML 的形态（实测 www 域与缺 /api 前缀的路径都
    // 这样）。旧写法在 response.json() 里炸成 Unexpected token <，面板只能显示一句
    // 笼统的失败，用户分不清「端点错了」还是「上游挂了」。这里先验形态：
    // 200 + 非 JSON 必须显式报「响应形态不符」。
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('SkillHub v1 响应形态不符（非 JSON，疑似落在 SPA 页面上）: ' + text.slice(0, 60));
    }
  } finally {
    clearTimeout(timer);
  }
}

const DIMENSION_LABELS = {
  trust: '可信度',
  reliability: '可靠性',
  adaptability: '适配性',
  convention: '规范性',
  effectiveness: '有效性',
};

/**
 * 读取某个 Skill 的官方质量评测（SkillHub Open API 的 evaluation 端点）。
 * 只做上游字段的如实摊平：每个维度给出维度级说明与该维度子项分数。
 * 绝不合成一个上游没有给的总分，也不用 downloads/stars 之类字段凑数；
 * 上游不可达时直接抛错，由面板显式降级告知（返回空对象会被当成「有数据」）。
 */
export async function evaluation(slug) {
  const raw = String(slug || '').trim();
  if (!raw) throw new Error('缺少 skill 标识');
  // 评测归属（本轮实测钉死）：上游只认「路径=纯 slug」，作者必须靠 ?namespace= 区分。
  // 250 条样本里 6 个 slug 被多作者共用（global-biblio-base 同属 @user_814dbe54 与
  // @user_164f4c1f）：不带作者的纯 slug 请求上游解析到的是其中一位（实测 skillId=70996
  // 属 @user_164f4c1f），于是把别人的评测挂在这张卡上 —— 比取数失败更糟。拆不出作者
  // 就显式拒绝，绝不退化成用纯 slug 赌归属。
  const slash = raw.lastIndexOf('/');
  if (slash <= 0) throw new Error('评测需要作者归属（namespace 形态 author/slug），否则同一 slug 的多作者评测无法区分');
  const owner = raw.slice(0, slash);
  const id = raw.slice(slash + 1);
  const data = await getJsonV1('https://api.skillhub.cn/api/v1/skills/' + encodeURIComponent(id) + '/evaluation?namespace=' + encodeURIComponent(owner));
  const dims = data && data.dimensions && typeof data.dimensions === 'object' ? data.dimensions : {};
  const rows = [];
  for (const key of Object.keys(dims)) {
    const dim = dims[key] || {};
    const items = dim.items && typeof dim.items === 'object' ? dim.items : {};
    const scores = Object.keys(items)
      .map((k) => Number(items[k] && items[k].score))
      .filter((n) => Number.isFinite(n));
    rows.push({
      key,
      label: DIMENSION_LABELS[key] || key,
      reason: String(dim.userReason || dim.reason || ''),
      // 维度分取该维度子项的均值，并在文案里说明它是子项均值而非上游给的维度分；
      // 子项全缺时保持 null（不显示），不猜。
      score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      scored: scores.length,
    });
  }
  return {
    slug: id,
    summary: String((data && (data.userSummary || data.summary)) || ''),
    dimensions: rows,
    updatedAt: Number(data && data.updatedAt) || 0,
  };
}
function toItem(raw) {
  const namespace = raw.namespace || {};
  const canonical = namespace.canonicalName || raw.slug || "";
  const downloads = Number(raw.downloads ?? 0) || 0;
  // installs 与 downloads 是两个不同的上游字段，各取各的。实测 self-improving-agent
  // installs=86140 / downloads=1736606 —— 旧代码写 installs = downloads，于是卡片上的
  // 「· N 次安装」显示的是下载数（差 20 倍），「按安装数」也在按下载数排。
  // 上游 installs 缺失或为 0 时保持 0：面板 item.installs ? … : null 会不显示这一项，
  // 宁可不显示也不显示错数（60 条样本里仅 18 条有真实 installs，回落会造成大面积错值）。
  const installs = Number(raw.installs ?? 0) || 0;
  const stars = Number(raw.stars ?? 0) || 0;
  return {
    id: `skillhub:${canonical || raw.slug}`,
    slug: raw.slug || namespace.publicSlug || canonical,
    name: raw.name || namespace.publicSlug || raw.slug,
    description: raw.description_zh || raw.description || "",
    category: raw.category || "",
    source: "skillhub",
    sourceLabel: "SkillHub（社区）",
    owner: raw.ownerName || namespace.displayName || "",
    iconUrl: raw.iconUrl || "",
    homepage: raw.homepage || "",
    upstreamUrl: raw.upstream_url || "",
    downloads,
    stars,
    installs,
    verified: Boolean(raw.verified),
    version: raw.version || "",
    installable: Boolean(canonical || raw.slug),
    namespace: canonical,
    reference: canonical || raw.slug || "",
  };
}

export async function searchSkills({ query = "", page = 1, pageSize = 20, category = "", cache, sort = "" } = {}) {
  const p = Math.max(1, page);
  const size = Math.min(50, Math.max(1, pageSize));
  // 排序一律交给服务端全盘排（实测 sortBy=installs 跨页单调：30 条 86140…8444）。
  // 三个曾经写错的键：
  //   installCount → installs（旧代码映射到 downloads，于是「按安装数」拿到的是下载榜：
  //     实测两榜首条不同，installs→self-improving-agent、downloads→dev-god）；
  //   updated → updated_at（文档字段名带 _at；sortBy=updated 会被上游当成未知名）；
  //   name → 上游实测返回 code:400 空列表，只能本地排（不发 sortBy=name）。
  // downloadCount 是独立键（用户 2026-11-21 拍板）：installs 覆盖率仅 18/60，
  // 只给「按安装数」时多数卡片没有依据可核验，而 sortBy=downloads 实测同样服务端
  // 全盘单调（榜首 dev-god），两榜首条不同 → 两个键都给、各排各的字段。
  const serverSort = sort === "installCount" ? "installs" : sort === "downloadCount" ? "downloads" : sort === "stars" ? "stars" : sort === "updated" ? "updated_at" : "";
  const params = new URLSearchParams();
  // 关键词参数名必须是 keyword：实测 q=pdf 返回 total=233498（≈全量 233,498，等于没搜），
  // keyword=pdf 返回 5614。旧代码传 q，所以 SkillHub 的搜索一直无效，只因仍返回条目而看着像成功。
  if (query) params.set("keyword", query);
  const catSent = category; // 这次真的发给上游的分类（行集自证的对照基准）
  if (category) params.set("category", category);
  params.set("page", String(p));
  params.set("pageSize", String(size));
  if (serverSort) {
    params.set("sortBy", serverSort);
    params.set("order", "desc"); // 上游默认虽为 desc，显式写出以免依赖默认值
  }
  // 同一查询 5 分钟内复用，避免重复打上游。
  const searchKey = `skillhub:search:${query.toLowerCase()}:${category}:${p}:${size}:${sort || ""}`;
  let data = cache ? await cache.get(searchKey, 5 * 60 * 1000) : undefined;
  if (!data) {
    data = await getJson(`${BASE}?${params.toString()}`);
    if (cache && (Array.isArray(data.skills) || Array.isArray(data.items))) await cache.put(searchKey, data);
  }
  const rows = Array.isArray(data.skills) ? data.skills : Array.isArray(data.items) ? data.items : [];
  // 仅 name 本地排（上游 sortBy=name 返回空）；installCount/stars/updated 由服务端全盘排序
  if (sort === "name") {
    rows.sort((a, b) => String(a.name || a.slug || "").localeCompare(String(b.name || b.slug || "")));
  }
  const pageRows = rows;
  const items = pageRows.map(toItem);
  // 0.5.180 源侧自描述：带分类时，只有取回的行集自己全等于该分类才算正证（facetUsed），
  // 并据此声明 serverFacet。上游对表外 slug 直接回 400（getJson 抛错），所以这条声明
  // 不会为谎话背书；混进别类时闭嘴（空串）—— tail 判定按 unproven 拒收，不洗行集。
  const facetUsed = catSent && rows.length && rows.every((r) => String(r.category || "") === catSent) ? catSent : "";
  return {
    source: "skillhub",
    items,
    // 0.5.144（D4）：上游没报总数时不给数字（与 clawhub / skills.sh / lobehub 同规）。
    total: Number.isFinite(Number(data.total)) && Number(data.total) > 0 ? Number(data.total) : items.length ? undefined : 0,
    page: Number(data.page ?? page) || page,
    pageSize: size,
    // 0.5.144（D4）：请求页宽钳到 50，判据却拿未钳制的入参比 —— pageSize=60 时上游回 60 行也谎称最后一页。
    hasMore: items.length >= size,
    // 0.5.180：facet 声明位（tail 只认正证，见 src/sources.js 的 fetchTailCategory）
    facetUsed,
    serverFacet: facetUsed !== "",
  };
}
// 曾有的 categories() 已删除：它请求 /api/skills/categories（实测 405 Method Not Allowed），
// 且全仓无任何调用方 —— 面板的分类 chip 来自当前页条目的 category 字段（client.js:1563）。
// 真正的端点是 /api/v1/categories（13 个一级分类），但它的响应是 {count,items}、**没有 code 字段**，
// 不能走上面的 getJson（它要求 code===0）。将来若要把上游分类接进面板，必须另开一条不校验
// code 的取数路径；在那之前不做半吊子接入，也不用别的字段凑分类。