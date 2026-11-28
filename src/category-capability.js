// 分类能力矩阵：哪个源的 handler 真能按 category 过滤，服务端逐类取数只认这张表。
// 形状与纪律照 src/sort-capability.js —— 唯一事实源，每一格都来自实测，不是设计稿。
// 改任何一格之前先重新实测：0.5.179 之前的名单（TAIL_CATEGORY_SOURCES）只说「能不能发」，
// 说不清「发了之后拿回来的是服务端筛的还是本地筛的」，而那才是 hint 口径与 tail 成员谓词的依据。

// 实测依据（2026-11-27 复核，探针 C:/Users/Public/dsh-scratch/probe180.mjs 可复跑）：
//   clawhub      上游 category 参数生效，行内 category 回显（src/clawhub.js 出参 facetUsed）→ declared
//   skillsmp     服务端按标签筛，出参 serverFacet:true + facetUsed → declared
//   trusttools   同 skillsmp 形状 → declared
//   lobehub      只有 serverFacet:true（无 facetUsed），仍是正证 → declared
//   skillhub     现网证实服务端真筛：cat="" total=241196；office-efficiency=14070、
//                dev-programming=23695；表外 slug 回 HTTP 400（上游自己校验词表，
//                所以「带类且行集自证」的声明不会为谎话背书）→ declared
//   modelscope   分类由本地词表过滤得出（可达集合内实测），服务端不参与 → local-filter
//   skills.sh    handler 签名里没有 category 入参：逐类调用等于把同一份全目录重取 N 次，
//                白烧上游 → false
//   browse.sh    同上 → false
// 缺表键一律按 false 处理（保守）：宁可计失败，也不把全目录当某一类塞进「其他」分类。

const CATEGORY_CAPABILITY = {
  // chipWindow：面板分类 chip 一次呈现多少个，0 = 完整呈现全部且不再合并「其他」。
  // tailExhaustive：逐类补取时是否把该类翻到尽头（取全），false = 每类只取一页（0.5.186）。
  // 两格依据 0.5.186 实测：skillsmp 词表 63 类（横拖条放得下）且窗外单类最大 155,772 条
  // （≈5.0 万页，永远取不全）；lobehub 词表 246 类（铺开读不动）但窗外合计仅 743 条
  // （217 次分页请求，实测单页 3.7~5.6s）⇒ 取全可行，取全后才配谈「其他」。
  "skills.sh": { supportsCategory: false, facetProof: "none", chipWindow: 32, tailExhaustive: false },
  "clawhub": { supportsCategory: true, facetProof: "declared", chipWindow: 32, tailExhaustive: true },
  "skillsmp": { supportsCategory: true, facetProof: "declared", chipWindow: 0, tailExhaustive: false },
  "trusttools": { supportsCategory: true, facetProof: "declared", chipWindow: 32, tailExhaustive: true },
  "browse.sh": { supportsCategory: false, facetProof: "none", chipWindow: 32, tailExhaustive: false },
  "lobehub": { supportsCategory: true, facetProof: "declared", chipWindow: 32, tailExhaustive: true },
  "skillhub": { supportsCategory: true, facetProof: "declared", chipWindow: 32, tailExhaustive: true },
  "modelscope": { supportsCategory: true, facetProof: "local-filter", chipWindow: 32, tailExhaustive: true },
};

const norm = (source) => String(source == null ? "" : source).trim();

/** 该源能否按分类取数。表外源保守返回 false（unknown 不是 capability）。 */
export function categoryCapability(source) {
  const key = norm(source);
  const hit = Object.prototype.hasOwnProperty.call(CATEGORY_CAPABILITY, key)
    ? CATEGORY_CAPABILITY[key]
    : { supportsCategory: false, facetProof: "none" };
  return {
    source: key,
    supportsCategory: hit.supportsCategory === true,
    facetProof: hit.facetProof,
    known: Object.prototype.hasOwnProperty.call(CATEGORY_CAPABILITY, key),
  };
}

/** 有分类能力的源名单（按给定顺序）。tail 选源的唯一入口，禁止再抄第二份名单。 */
export function categoryCapableSources(names) {
  const list = Array.isArray(names) ? names : Object.keys(CATEGORY_CAPABILITY);
  return list.filter((name) => categoryCapability(name).supportsCategory);
}

/** 本地过滤源：合计口径与窗口封顶源不同，只能写在 hint 里（0.5.177 I6）。 */
export function isLocalFilterSource(source) {
  return categoryCapability(source).facetProof === "local-filter";
}

/** chip 窗口与逐类是否取全。表外源保守：窗口 32、不翻尽（unknown 不是 capability）。 */
export function categoryChipPolicy(source) {
  const key = norm(source);
  const hit = Object.prototype.hasOwnProperty.call(CATEGORY_CAPABILITY, key)
    ? CATEGORY_CAPABILITY[key]
    : {};
  return {
    source: key,
    chipWindow: Number.isFinite(Number(hit.chipWindow)) && Number(hit.chipWindow) >= 0 ? Number(hit.chipWindow) : 32,
    tailExhaustive: hit.tailExhaustive === true,
  };
}

/** 该源逐类补取是否翻到尽头（取全）。表外源按 false（保守）。 */
export function isTailExhaustiveSource(source) {
  return categoryChipPolicy(source).tailExhaustive === true;
}
