// paging-verdict.mjs — 分页判据（纯函数，零网络，只给测试用）。
//
// 背景（本轮实测）：test-nocache 直打真实上游，出现两类外部状态——
//   skillhub 默认榜（不带 sortBy）自身在重排：同一请求首条在 icon-design 与
//   govwriter-pro 之间漂移，跨页重叠一次 2、一次 7；显式排序路径实测 overlap=0
//   且跨页单调（p1min=24636 ≥ p2max=23940；1785771 ≥ 1753414）。
//   trusttools 出现过一次 p1=12 / p2=0，复测三次都是 12/12（上游瞬时故障）。
// 外部状态不该伪装成代码回归，但放宽必须有边界与自证，所以判定抽成纯函数：
//   整页重复 = page 参数被忽略 → 永远 fail（这是我们的回归）；
//   空第 2 页而 total/hasMore 说还有 → 先重试一次，重试后仍空 → fail；
//   skillhub 部分重叠且显式排序路径干净 → skip（并写明实测依据）。
// 判据写在这里而不是内联在套件里：内联一份就等于测「测试自己的假设」，
// 上游恰好不坏时那条 SKIP 分支根本没人验证过。

export function overlapVerdict(o) {
  const pageCount = Number(o.pageCount) || 0;
  const overlap = Number(o.overlap) || 0;
  if (overlap === 0) return { verdict: 'ok', reason: '' };
  if (pageCount > 0 && overlap >= pageCount) return { verdict: 'fail', reason: '第 2 页与第 1 页整页相同：page 参数被忽略' };
  if (o.source === 'skillhub' && o.sortedOverlap !== undefined && o.sortedOverlap !== null) {
    // sortedOverlap 必须由调用方真测出来；缺失（undefined）不能当 0 放行。
    if (Number(o.sortedOverlap) === 0) return { verdict: 'skip', reason: 'skillhub 上游默认榜自身在重排；显式排序路径 overlap=0，本仓库分页参数无回归' };
    return { verdict: 'fail', reason: 'skillhub 显式排序路径也跨页重复 sortedOverlap=' + o.sortedOverlap };
  }
  // 通用出口：部分重叠的两种成因必须靠「同一页重复请求是否自稳」的实测证据分开，
  // 而不是给某个源发永久通行证。firstPageStable 未测（undefined）一律 fail ——
  // 与 sortedOverlap 同一条原则：没测过不等于没问题。
  // 理由必须带源名：门内那次 `跨页重叠 overlap=5` 单跑全绿却定不了性，就是因为日志里没有源。
  if (o.firstPageStable === undefined || o.firstPageStable === null) {
    return { verdict: 'fail', reason: o.source + ' 跨页重叠 overlap=' + overlap + '，且未实测同页重复请求的自稳性（不得凭未测放行）' };
  }
  if (o.firstPageStable === false) {
    return { verdict: 'skip', reason: o.source + ' 上游默认序自身在重排（同页重复请求实测不自稳）：跨页重叠 overlap=' + overlap + '，本仓库分页参数无回归' };
  }
  return { verdict: 'fail', reason: o.source + ' 跨页重叠 overlap=' + overlap + '（同页重复请求实测自稳 ⇒ 本侧 offset 算术回归）' };
}

/**
 * countOverlap —— 相邻两页里共现的条目数，全仓唯一一份集合比较。
 *
 * 为什么抽出来：test-nocache 与 test-paging 此前各写一遍 `new Set` + `filter(has)`，
 * 两套相近判据互相打架是本仓踩过的坑（同一形状在 emptyWithoutEvidence 那条上已统一过一次）。
 * 语义按集合算，不按配对算：同一条目在两页里重复出现只算一次共现；
 * 整页重复（page 参数被忽略）读作 next.length，正是 overlapVerdict 要 fail 的那个形状。
 * 缺 id 的条目保守计入：两边都取不到 id 时判成重叠，因为「判成不重叠」等于静默放行——
 * 整页重复会被读成 ok，那比一次 flake 坏得多。
 *
 * @param {Array|{items:Array}|null|undefined} prev 前一页
 * @param {Array|{items:Array}|null|undefined} next 后一页
 * @returns {number} 共现条目数（distinct）
 */
export function countOverlap(prev, next) {
  const list = (side) => (Array.isArray(side) ? side : side && Array.isArray(side.items) ? side.items : []);
  const key = (item) => (item && typeof item === 'object' && 'id' in item ? item.id : item);
  const a = list(prev);
  const b = list(next);
  if (a.length === 0 || b.length === 0) return 0;
  const seen = new Set(a.map(key));
  const keys = b.map(key);
  return keys.filter((k, i) => keys.indexOf(k) === i && seen.has(k)).length;
}

export function emptyPageAction(o) {
  const p1 = Number(o.p1) || 0;
  const p2 = Number(o.p2) || 0;
  const total = Number(o.total) || 0;
  const hasMore = o.hasMore === true;
  const attempt = Number(o.attempt) || 1;
  if (p2 > 0) return { verdict: 'ok', reason: '' };
  if (p1 === 0) return { verdict: 'fail', reason: '第 1 页就没有条目：无 cache 路径不可用' };
  // 上游诚实说没有第 2 页（total 已排完且 hasMore=false）→ 正常，不重试也不报错
  if (!hasMore && total <= p1) return { verdict: 'ok', reason: '' };
  if (attempt < 2) return { verdict: 'retry', reason: '宣称还有更多但第 2 页为空，重试一次以区分上游瞬时故障与分页回归' };
  return { verdict: 'fail', reason: '重试后第 2 页仍空而 total=' + total + ' hasMore=' + hasMore + '：page/offset 计算回归' };
}

// emptyWithoutEvidence —— 某一页取到 0 条时，响应里到底有没有可据以定性的证据。
// degraded>0（明确不可达）、total>0（上游说有货）、hasMore===true（宣称还有下一页）
// 都算有证据；三者皆无 = 上游静默空响应：既不能证明分页契约被违反，也不能宣称
// 目录到底 —— 只能记 SKIP。本轮门内实测 trusttools 一次 p1=0/p2=12（degraded=0、
// total=0），单跑三次全绿；把这种上游状态判成本仓库回归，得到的就是随心情 flake 的门。
// pagePairVerdict —— 相邻两页里出现空页时，先问「这一页自己有没有声明失败」。
// 空页只有在它**没有**自报失败时才可能是我们的分页算术错了；上游自己说超时/不可达
// 的页不能用来判本侧契约（实测 trusttools 6/6 次 degraded=来源响应超时，本轮门内
// 两条红都是这个形态：一次 p1=0/p2=12，一次 p1=12/p2=0 且重试后仍 0）。
// skip = 无从判定（外部状态）；judge = 交给既有判据继续定性。
export function pagePairVerdict(o) {
  const p1 = Number(o.p1) || 0;
  const p2 = Number(o.p2) || 0;
  const d1 = Number(o.p1Degraded) || 0;
  const d2 = Number(o.p2Degraded) || 0;
  if (p1 > 0 && p2 > 0) return { verdict: 'ok', reason: '' };
  const selfFailed = (p1 === 0 && d1 > 0) || (p2 === 0 && d2 > 0);
  if (selfFailed) return { verdict: 'skip', reason: '空的那一页自报失败（degraded 有记录）：上游状态，不用于判本侧分页契约' };
  return { verdict: 'judge', reason: '' };
}

export function emptyWithoutEvidence(o) {
  if (Number(o.degraded) > 0) return false;
  if ((Number(o.total) || 0) > 0) return false;
  if (o.hasMore === true) return false;
  return true;
}
