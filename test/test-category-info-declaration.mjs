// 聚合层必须听得进「本行有分类信息」的能力声明，而不是只看这一页凑没凑到条目。
// 缺陷（0.5.164，lead 侧）：src/sources.js:840 的 catSupported 用 items.some(i => i.category)
// 判定「这个源提不提供分类信息」。modelscope 的服务端分类过滤实测不成立（上游 PUT 加
// Category/L1/CatalogID 九键三姿势共 30 组探针，rows 与 baseline 逐位相同；lead 独立复跑
// 同结论），所以它只能走客户端归一 —— 而客户端归一在小分类的深页上合法地回 0 条。
// 于是分类态空页时 catSupported=false，聚合层回「所选来源不提供分类信息，已忽略分类筛选」,
// 同时 handler 的 hint 又说「本类实测 0 条」—— 两句互相打脸，而每行其实都带 L1.ChineseName。
// 离线复现留档 C:/Users/Public/dsh-scratch/ms164-empty-cat.txt。
import { searchSkills } from '../src/sources.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcTxt = fs.readFileSync(path.join(here, '..', 'src', 'sources.js'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.log('FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

// 假 handler：只用来喂聚合层，绝不打网络。categoryInfo 就是要被测的那条声明。
const mkHandler = (rows, extra) => async () => ({
  source: 'modelscope',
  items: rows,
  total: rows.length,
  hasMore: false,
  ...(extra || {}),
});
const row = (cat) => ({ id: 'i-' + cat, slug: 's-' + cat, name: 'n', description: '', category: cat, source: 'modelscope' });

console.log('Test 1: 声明了分类能力的源，分类态零命中不得被说成「不提供分类信息」');
{
  const r = await searchSkills({
    query: 'zzq-no-such-keyword', source: 'modelscope', page: 1, pageSize: 24, cache: null,
    category: '文档处理 (PDF/PPTX/DOCX)',
    handlers: { modelscope: mkHandler([], { categoryInfo: true, hint: 'ModelScope 上游不提供服务端分类过滤，本类实测 0 条；可达集合外的分类会漏' }) },
  });
  const note = String(r.categoryNote || '');
  check('不得谎称「不提供分类信息」（每行都带分类，本页恰好 0 条）', !/不提供分类信息/.test(note), JSON.stringify(note));
  check('零命中仍须给出可核对的说明（不许静默空页）', note.length > 0 || String(r.hints || '').length > 0, JSON.stringify({ note, hints: r.hints }));
}

console.log('');
console.log('Test 2: 真不提供分类的源，口径不得被放宽（反向锁）');
{
  const r = await searchSkills({
    query: 'q', source: 'browse.sh', page: 1, pageSize: 24, cache: null,
    category: 'security',
    handlers: { 'browse.sh': mkHandler([{ id: 'x1', slug: 'x1', name: 'n', description: '', source: 'browse.sh' }, { id: 'x2', slug: 'x2', name: 'n', description: '', source: 'browse.sh' }]) },
  });
  check('整页无分类且无声明 ⇒ 仍说「不提供分类信息」', /不提供分类信息/.test(String(r.categoryNote || '')), JSON.stringify(r.categoryNote));
}

console.log('');
console.log('Test 3: 页内凑到分类行的既有行为不变');
{
  const r = await searchSkills({
    query: 'q', source: 'modelscope', page: 1, pageSize: 24, cache: null,
    category: '市场推广',
    handlers: { modelscope: mkHandler([row('市场推广'), row('开发工具'), row('市场推广')]) },
  });
  check('有分类行 ⇒ 走本地过滤并说明仅当前页', /本地|当前页/.test(String(r.categoryNote || '')), JSON.stringify(r.categoryNote));
  check('本地过滤只留本类', r.items.length === 2, 'items=' + r.items.length);
}

console.log('');
console.log('Test 4: 真 handler 经真聚合层（modelscope 小分类深页空命中）');
{
  const es = await import('../src/extra-sources.js');
  if (typeof es.searchModelScope !== 'function') {
    check('searchModelScope 可导入', false, '未导出');
  } else {
    // 假 transport：40 行全开发工具，本类 0 条 —— 真实上游对 文档处理/监控/API 设计 这类
    // 6 条以下的小分类在深页上就是这个形状（可达集合外的分类会漏）。
    const mkRows = (n, cat, off) => Array.from({ length: n }, (_, k) => ({
      Name: 'skill-' + (off + k), Description: 'd', DownloadCount: 10 - k, SourceStar: k,
      CreatedAt: '2026-01-01T00:00:00Z', UpdatedAt: '2026-01-02T00:00:00Z',
      L1: { CatalogID: '39', Name: 'DevTools', ChineseName: cat },
      L2: null,
    }));
    const transport = async () => ({ ok: true, status: 200, json: async () => ({ Data: { SkillList: mkRows(40, '开发工具', 0), TotalCount: 40 } }) });
    const r = await searchSkills({
      query: 'zzq-no-such-keyword', source: 'modelscope', page: 1, pageSize: 24, cache: null,
      category: '文档处理 (PDF/PPTX/DOCX)',
      handlers: { modelscope: (a) => es.searchModelScope({ ...a, transport }) },
    });
    check('真 handler 分类态零命中不得说「不提供分类信息」', !/不提供分类信息/.test(String(r.categoryNote || '')), JSON.stringify({ note: r.categoryNote, items: r.items.length }));
  }
}

console.log('');

console.log('');
console.log('Test 6: 面板的本地过滤必须兑现聚合层的「无分类不过滤」承诺');
{
  // 聚合层 :848 用 !item.category || item.category === catNeedle（无分类保留，且有
  // 「另有 N 项…一并保留」的明说文案）；面板 client.js 的 visibleSkills 却写的是
  // serverFacet || category === 'all' || item.category === category —— 无分类行被静默删掉，
  // 用户看到的条数比聚合层承诺的少。探针三次自伤后坐实（留档 s164-sortform-red.txt）。
  const clines = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8').split(/\r?\n/);
  const vline = clines.find((l) => /const visibleSkills = orderedSkills\.filter/.test(l)) || '';
  check('面板存在 visibleSkills 本地过滤行', vline.length > 0, '未找到');
  check('面板保留无分类行（与聚合层 !item.category 同口径）', /!item\.category/.test(vline), vline.trim());
  check('面板仍尊重 serverFacet 跳过（既有锁不动）', /serverFacet/.test(vline) && /category === 'all'/.test(vline), vline.trim());
  // 真函数自证：谓词对「无分类行」在非 facet 分类态必须放行
  if (vline.length > 0) {
    const ARROW = String.fromCharCode(61, 62);
    const inner = vline.slice(vline.indexOf('.filter(') + 8, vline.lastIndexOf(')'));
    const body = inner.slice(inner.indexOf(ARROW) + 2).trim();
    const clTxt = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
    const CAT_OTHER = (clTxt.match(/const CAT_OTHER = '([^']+)';/) || [])[1] || '';
    // 0.5.165 起谓词还读 chipFold.other.covers（「其他」合并入口），所以绑定必须补齐这两个量，
    // 否则测的是 ReferenceError 而不是过滤口径。fixture：covers 里只有 市场推广。
    const chipFold = { other: { value: CAT_OTHER, label: '其他', covers: ['市场推广'] } };
    check('面板谓词依赖的「其他」slug 在 client.js 里存在', CAT_OTHER !== '', 'CAT_OTHER=' + CAT_OTHER);
    const f = new Function('item', 'serverFacet', 'category', 'CAT_OTHER', 'chipFold', 'return (' + body + ');');
    check('真函数：无分类行在分类态被放行', f({ slug: 'x' }, false, '市场推广', CAT_OTHER, chipFold) === true, 'got=' + f({ slug: 'x' }, false, '市场推广', CAT_OTHER, chipFold));
    check('真函数：异类仍被筛掉（自证探针有效）', f({ category: '开发工具' }, false, '市场推广', CAT_OTHER, chipFold) === false, '');
    check('真函数：facet 态全放行', f({ category: '开发工具' }, true, '市场推广', CAT_OTHER, chipFold) === true, '');
  // 0.5.174（用户 m20058「只要一个其他按钮，呈现 214 类的全部结果，不要每个类别单独显示」）：
  // CAT_OTHER 升级为真筛选态——谓词首分支就是 covers 并集。旧 0.5.165 口径锁（谓词不得引用
  // CAT_OTHER）随「降级为披露 span」一起退役；两道防线改由新锁接住：首分支必须是 covers 并集
  // （不许 return 短路把整页说成合并集合的全部），且 CAT_OTHER 永不作为 value 直接下发 searchSkills。
  const tailAt = vline.indexOf('category === CAT_OTHER ?');
  const tailBranch = tailAt >= 0 ? vline.slice(tailAt, vline.indexOf(' : ', tailAt)) : '';
  check('CAT_OTHER 是真筛选态：谓词首分支是 covers 并集，分支内无 return 短路（防线不许退）',
    tailAt >= 0 && tailBranch.indexOf('covers.indexOf') >= 0 && tailBranch.indexOf('return') < 0,
    tailBranch.trim().slice(0, 200));
  check('CAT_OTHER 不作为 value 直接下发 searchSkills（下发只走 upstreamCat 映射）',
    clines.filter((l) => l.indexOf('searchSkills(') >= 0 && /category:\s*(CAT_OTHER|'__cat_other')/.test(l)).length === 0,
    JSON.stringify(clines.filter((l) => /category:\s*(CAT_OTHER|'__cat_other')/.test(l)).map((l) => l.trim().slice(0, 90))));
  check('真函数：CAT_OTHER 态下异类行筛掉（covers 之外的分类不是合并集合成员）',
    f({ category: '开发工具' }, false, CAT_OTHER, CAT_OTHER, chipFold) === false, '');
  // 用户 m20058 口径：合并入口=「这些类的全部结果」，无分类字段不等于杂项桶，宁缺毋滥。
  check('真函数：CAT_OTHER 态下无分类行不算合并集合成员（!item.category 不许混进并集放行）',
    f({ slug: 'x' }, false, CAT_OTHER, CAT_OTHER, chipFold) === false,
    'got=' + f({ slug: 'x' }, false, CAT_OTHER, CAT_OTHER, chipFold));
  check('真函数：CAT_OTHER 态下 covers 内的分类行保留（并集真跑，不是恒空集合）',
    f({ category: '市场推广' }, false, CAT_OTHER, CAT_OTHER, chipFold) === true,
    'got=' + f({ category: '市场推广' }, false, CAT_OTHER, CAT_OTHER, chipFold));
  const reqLine = clines.find((l) => /category: upstreamCat === 'all' \? '' : upstreamCat,/.test(l)) || '';
  const mapLine = clines.find((l) => /const upstreamCat = cat === CAT_OTHER \? 'all' : cat;/.test(l)) || '';
  check('下发上游的 category 读的是映射后的值，不是原始 cat', reqLine.length > 0, '未找到 upstreamCat 下发行');
  check('CAT_OTHER 在下发前被映射回浏览态（不把面板自造 slug 发给上游）', mapLine.length > 0, '未找到映射行');
  }
}
console.log('Test 5: 源码锁——catSupported 必须同时认能力声明');
{
  const line = srcTxt.split(/\r?\n/).find((l) => /const catSupported =/.test(l)) || '';
  const acc = srcTxt.split(/\r?\n/).find((l) => /result\.categoryInfo === true/.test(l)) || '';
  check('逐源听声明：计票循环累加 handler 的 categoryInfo', /declaredCategoryInfo = true/.test(acc), acc.trim());
  check('catSupported 读的是声明，不只是页内样本', /declaredCategoryInfo/.test(line), line.trim());
}

console.log('');
console.log('');
console.log('Test 7: 取数失败/超时不得被翻译成「该源不提供分类信息」（0.5.164 live 复验抓到的谎）');
{
  // live 原样复现（C:/Users/Public/dsh-scratch/after164-chips.txt）：modelscope 分类态单次
  // 5000 行请求撞满 90s ⇒ handler 抛 abort，items=0、degraded=[modelscope]。旧口径此时
  // catSupported=false，于是把网络故障讲成「所选来源不提供分类信息」——而每行都带分类。
  const boom = async () => { const e = new Error("The operation was aborted due to timeout"); throw e; };
  const r = await searchSkills({
    query: "", source: "modelscope", page: 1, pageSize: 24, cache: null,
    category: "市场推广", handlers: { modelscope: boom },
  });
  const note = String(r.categoryNote || "");
  check("失败态不得说「不提供分类信息」", !/不提供分类信息/.test(note), JSON.stringify(note));
  check("失败态要说清是取数失败/超时", /取数失败|超时|未能确认/.test(note), JSON.stringify(note));
  check("失败态仍逐源点名失败原因（sourceErrors 未被吞）",
    Array.isArray(r.sourceErrors) && r.sourceErrors.length > 0 && /timeout|abort/i.test(r.sourceErrors.join(" ")),
    JSON.stringify(r.sourceErrors));
  check("失败态绝不谎称已按分类过滤", !/已按|已过滤掉/.test(note), JSON.stringify(note));
}
console.log('');
console.log('Test 8: 反向锁——取数成功且真不提供分类的源，旧文案不得被放宽掉');
{
  const r = await searchSkills({
    query: "q", source: "browse.sh", page: 1, pageSize: 24, cache: null,
    category: "security", handlers: { "browse.sh": mkHandler([{ id: "x1", slug: "x1", name: "n", description: "", source: "browse.sh" }]) },
  });
  check("取数成功 + 无声明 + 无分类行 ⇒ 仍说「不提供分类信息」",
    /不提供分类信息/.test(String(r.categoryNote || "")), JSON.stringify(r.categoryNote));
  check("取数成功时不得冒出「取数失败」文案（fetchFailedOnly 只在真失败时成立）",
    !/取数失败/.test(String(r.categoryNote || "")), JSON.stringify(r.categoryNote));
}
console.log('');
console.log('Test 9: 源码锁——失败分支与 catSupported 各管各的');
{
  const lines = srcTxt.split(/\r?\n/);
  const failLine = lines.find((l) => /const fetchFailedOnly =/.test(l)) || "";
  check("fetchFailedOnly 同时要求「有失败源」与「本页无条目」",
    /degraded\.length\s*>\s*0/.test(failLine) && /items\.length\s*===\s*0/.test(failLine), failLine.trim());
  const branch = lines.find((l) => /if \(fetchFailedOnly\) \{/.test(l)) || "";
  const elseIf = lines.find((l) => /} else if \(!catSupported\) \{/.test(l)) || "";
  check("失败分支在前、不提供分类分支仍是 else-if（两个口径互不吞）",
    branch !== "" && elseIf !== "", JSON.stringify({ branch: branch !== "", elseIf: elseIf !== "" }));
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
