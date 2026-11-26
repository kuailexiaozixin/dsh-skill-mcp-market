#!/usr/bin/env node
// test-provider-frontmatter.mjs — 任务 0.5.177-B：src/provider.js 装配面 + src/frontmatter.js 四导出的 0 直测补平。
//
// 覆盖：parseFrontmatter / skillMetaFromText / kebab / setFrontmatterFlag（frontmatter.js），
// createMarketSkillProvider（list/get/startWatching/dispose）与 readSkillBody（provider.js）。
// 「锁现状」判据均注明依据（file:line）；若生产码行为日后改变，这些判据需同步更新。
// 纪律：纯 LF 源码；临时目录一律 safeTempDir()+mkdtempSync，退出前残留增量必须为 0；
// 不依赖真实 fs.watch 事件时序（watch 相关只锁确定性契约，「目录变化→invalidate」需时序，本套件不锁）。
import fs from 'node:fs';
import path from 'node:path';
import { safeTempDir } from '../src/home.js';
import { parseFrontmatter, skillMetaFromText, kebab, setFrontmatterFlag } from '../src/frontmatter.js';
import { createMarketSkillProvider, readSkillBody } from '../src/provider.js';

let passed = 0, failed = 0;
const check = (n, c, d = '') => { if (c) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 200) + ']' : '')); } };
const exactKeys = (obj, expected) => JSON.stringify(Object.keys(obj).sort()) === JSON.stringify(expected.slice().sort());

const litter = [];
const mk = (pfx) => { const d = fs.mkdtempSync(path.join(safeTempDir(), pfx)); litter.push(d); return d; };
const fm = (lines, body) => '---\n' + lines.join('\n') + '\n---\n' + (body === undefined ? '' : body);

let residueBefore = -1;
try {
  residueBefore = fs.readdirSync(safeTempDir()).filter((d) => d.startsWith('dsh-pfm-')).length;

  // 共享样本文本（Test 6/9 用同一份，保证 skillMetaFromText 与 provider summaryFrom 可比）
  const FM_A = '---\nname: Alpha\ndescription: alpha desc\nwhenToUse: camel use\ndisable-model-invocation: true\nuser-invocable: false\n---\nBODY-ALPHA\n';
  const FM_B = '---\ndescription: beta desc\nwhen_to_use: snake use\n---\nBODY-BETA';
  const FM_DUP_N = '---\nname: Dup Nested\ndescription: dn\n---\nNESTED-BODY';
  const FM_DUP_F = '---\nname: Dup Flat\ndescription: df\n---\nFLAT-BODY';
  const FM_G = '---\nname: Gamma\ndescription: g desc\n---\nBODY-GAMMA';

  console.log('');
  console.log('Test 1: parseFrontmatter 合法块（标量/引号/列表/块标量）');
  {
    const r = parseFrontmatter(fm(['name: my-skill', 'description: "A: colon value"', 'whenToUse: use it'], 'BODY here'));
    check('标量与引号冒号值', r.data.name === 'my-skill' && r.data.description === 'A: colon value' && r.data.whenToUse === 'use it', JSON.stringify(r.data));
    check('body 去掉首个换行', r.body === 'BODY here', JSON.stringify(r.body));
    const crlf = parseFrontmatter('---\r\nname: crlf\r\ndescription: d\r\n---\r\nBODY');
    check('CRLF 块可解析', crlf.data.name === 'crlf' && crlf.data.description === 'd' && crlf.body === 'BODY', JSON.stringify(crlf));
    const il = parseFrontmatter(fm(['tags: [a, "b c"]'], 'b'));
    check('行内列表含引号元素', JSON.stringify(il.data.tags) === '["a","b c"]', JSON.stringify(il.data));
    check('空行内列表', JSON.stringify(parseFrontmatter(fm(['empty: []'], 'b')).data.empty) === '[]');
    check('块式列表 - 项', JSON.stringify(parseFrontmatter(fm(['list:', '  - a', '  - b'], 'b')).data.list) === '["a","b"]');
    check('字面块 | 拼行', parseFrontmatter(fm(['description: |', '  a', '  b', 'name: n'], 'b')).data.description === 'a\nb');
    check('折叠块 > 拼行', parseFrontmatter(fm(['description: >', '  a', '  b', 'name: n'], 'b')).data.description === 'a\nb');
    check('|- 丢弃结尾空行（现状）', parseFrontmatter(fm(['description: |-', '  a', '  '], 'b')).data.description === 'a');
    check('块标量收尾于块尾仍解析', parseFrontmatter(fm(['name: n', 'description: |', '  a', '  b'], 'b')).data.description === 'a\nb');
    const cm = parseFrontmatter(fm(['# comment: c', 'name: n'], 'b'));
    check('注释行跳过', cm.data.name === 'n' && exactKeys(cm.data, ['name']), JSON.stringify(cm.data));
    const odd = parseFrontmatter(fm(['snake_key: s', '1234: num'], 'b'));
    check('snake_case 与纯数字键可解析', odd.data.snake_key === 's' && odd.data['1234'] === 'num', JSON.stringify(odd.data));
    check('空值退化为空数组（现状）', JSON.stringify(parseFrontmatter(fm(['empty:'], 'b')).data.empty) === '[]');
    check('布尔值保持字符串不转型（现状）', parseFrontmatter(fm(['disable-model-invocation: true', 'user-invocable: false'], 'b')).data['disable-model-invocation'] === 'true');
  }

  console.log('');
  console.log('Test 2: parseFrontmatter 降级行为（无块/未闭合/坏行）');
  {
    const nb = parseFrontmatter('# hello\nworld');
    check('无块：data 空且 body 原样', exactKeys(nb.data, []) && nb.body === '# hello\nworld', JSON.stringify(nb));
    const un = parseFrontmatter('---\nname: x\ndescription: y\nBODY');
    check('块未闭合：data 空且 body 原样', exactKeys(un.data, []) && un.body === '---\nname: x\ndescription: y\nBODY', JSON.stringify(un));
    const eb = parseFrontmatter(fm([], 'body'));
    check('空块：data 空 body 正常', exactKeys(eb.data, []) && eb.body === 'body', JSON.stringify(eb));
    const junk = parseFrontmatter(fm(['not a pair', 'Ke y: v', 'name: ok'], 'b'));
    check('坏行静默跳过', junk.data.name === 'ok' && exactKeys(junk.data, ['name']), JSON.stringify(junk.data));
    check('---- 开头仍按块解析（现状）', parseFrontmatter('----\nname: a\n---\nb').data.name === 'a');
    check('重复键后者覆盖', parseFrontmatter(fm(['dup: one', 'dup: two'], 'b')).data.dup === 'two');
  }

  console.log('');
  console.log('Test 3: skillMetaFromText');
  {
    const camel = skillMetaFromText(fm(['name: n', 'description: d', 'whenToUse: w'], 'b'), 'fb');
    check('camel whenToUse', camel.whenToUse === 'w', JSON.stringify(camel));
    const snake = skillMetaFromText(fm(['name: n', 'description: d', 'when_to_use: ws'], 'b'), 'fb');
    check('snake when_to_use 兼容键', snake.whenToUse === 'ws', JSON.stringify(snake));
    const both = skillMetaFromText(fm(['name: n', 'description: d', 'whenToUse: camel', 'when_to_use: snake'], 'b'), 'fb');
    check('两键并存 camel 优先', both.whenToUse === 'camel', JSON.stringify(both));
    const fb = skillMetaFromText(fm(['description: d'], 'b'), 'FB');
    check('缺 name 用 fallback', fb.name === 'FB' && fb.description === 'd', JSON.stringify(fb));
    // 现状：`name:`（空值）在 parseFrontmatter 退化为空数组（frontmatter.js:70-72），空数组是 JS 真值，
    // 故 `data.name || fallbackName` 不会回落到 fallback —— String([]) === ''。
    const emptyName = skillMetaFromText(fm(['name: ', 'description: '], 'b'), 'FB');
    check('空 name 不触发 fallback（现状：空值退化为 [] 是真值）', emptyName.name === '' && emptyName.description === '' && emptyName.whenToUse === '', JSON.stringify(emptyName));
    check('空值键在 parseFrontmatter 里确为空数组（现状依据）', Array.isArray(parseFrontmatter(fm(['name: '], 'b')).data.name) && parseFrontmatter(fm(['name: '], 'b')).data.name.length === 0);
    const noFm = skillMetaFromText('plain body', 'FB');
    check('无块 + fallback', noFm.name === 'FB' && noFm.description === '' && noFm.whenToUse === '' && noFm.disableModelInvocation === undefined, JSON.stringify(noFm));
    check('disable-model-invocation: true → true', skillMetaFromText(fm(['disable-model-invocation: true'], 'b'), 'x').disableModelInvocation === true);
    check('camel disableModelInvocation: yes → true', skillMetaFromText(fm(['disableModelInvocation: yes'], 'b'), 'x').disableModelInvocation === true);
    const ui = skillMetaFromText(fm(['user-invocable: false'], 'b'), 'x');
    check('user-invocable: false → false', ui.userInvocable === false);
    check('userInvocable: off → false', skillMetaFromText(fm(['userInvocable: off'], 'b'), 'x').userInvocable === false);
    check('非法布尔 → undefined（现状不猜）', skillMetaFromText(fm(['disable-model-invocation: maybe'], 'b'), 'fb').disableModelInvocation === undefined);
    const raw = fm(['name: n', 'description: d', 'whenToUse: w'], 'b');
    const meta = skillMetaFromText(raw, 'fb');
    const data = parseFrontmatter(raw).data;
    check('与 parseFrontmatter 字段一致', meta.name === String(data.name).trim() && meta.description === String(data.description).trim() && meta.whenToUse === String(data.whenToUse).trim());
  }

  console.log('');
  console.log('Test 4: kebab 归一化');
  {
    check('空格与 trim', kebab('  Hello World  ') === 'hello-world', JSON.stringify(kebab('  Hello World  ')));
    check('CamelCase 小写化', kebab('CamelCase') === 'camelcase');
    check('连续下划线折叠', kebab('a__b') === 'a-b');
    check('连续连字符折叠', kebab('a--b') === 'a-b');
    check('点/下划线混合折叠', kebab('A.B_C') === 'a-b-c');
    check('路径分隔符折叠', kebab('a/b\\c') === 'a-b-c', JSON.stringify(kebab('a/b\\c')));
    check('首尾空白', kebab(' x1 ') === 'x1');
    check('数字输入', kebab(123) === '123');
    check('空串与全空白 → 空串', kebab('') === '' && kebab('  ') === '');
    check('纯符号 → 空串（守卫）', kebab('!!!') === '', JSON.stringify(kebab('!!!')));
    check('纯连字符 → 空串（守卫）', kebab('---') === '');
    check('纯非 ASCII → 空串（守卫）', kebab('你好世界') === '', JSON.stringify(kebab('你好世界')));
    check('null/undefined → 空串', kebab(null) === '' && kebab(undefined) === '');
  }

  console.log('');
  console.log('Test 5: setFrontmatterFlag 基本语义');
  {
    const base = fm(['name: n', 'description: d'], 'BODY\n');
    const added = setFrontmatterFlag(base, 'disable-model-invocation', true);
    check('新增键为 frontmatter 末行', added === fm(['name: n', 'description: d', 'disable-model-invocation: true'], 'BODY\n'), JSON.stringify(added));
    check('正文逐字节保留', added.endsWith('---\nBODY\n'));
    const again = setFrontmatterFlag(added, 'disable-model-invocation', true);
    check('幂等：第二次调用字节相同', again === added, JSON.stringify(again));
    check('幂等：键行只出现一次', again.split('\n').filter((l) => l.startsWith('disable-model-invocation:')).length === 1);
    const flipped = setFrontmatterFlag(added, 'disable-model-invocation', false);
    check('翻转：原位改值不新增行', flipped === fm(['name: n', 'description: d', 'disable-model-invocation: false'], 'BODY\n') && flipped.split('disable-model-invocation:').length === 2, JSON.stringify(flipped));
    const removed = setFrontmatterFlag(flipped, 'disable-model-invocation', undefined);
    check('删除键回到原文（字节级）', removed === base, JSON.stringify(removed));
    const absent = setFrontmatterFlag(base, 'zzz', undefined);
    check('删除不存在的键原样返回', absent === base);
    check('删除键不动其他行', setFrontmatterFlag(fm(['k: 1', 'name: n'], 'b'), 'k', undefined) === fm(['name: n'], 'b'));
    const noFm = setFrontmatterFlag('# just body', 'k', true);
    check('无块时补一个块', noFm === '---\nk: true\n---\n\n# just body', JSON.stringify(noFm));
    check('无块 + undefined 原样返回', setFrontmatterFlag('# just body', 'k', undefined) === '# just body');
    const unterm = setFrontmatterFlag('---\nname: n\nbody', 'k', true);
    check('未闭合块按无块处理补块（现状）', unterm === '---\nk: true\n---\n\n---\nname: n\nbody', JSON.stringify(unterm));
    check('未闭合块 + undefined 原样返回', setFrontmatterFlag('---\nname: n\nbody', 'k', undefined) === '---\nname: n\nbody');
    check('非布尔值折叠为 false（现状）', setFrontmatterFlag(base, 'k', 'anything').includes('\nk: false\n---'), JSON.stringify(setFrontmatterFlag(base, 'k', 'anything')));
    check('空文本补块', setFrontmatterFlag('', 'k', true) === '---\nk: true\n---\n\n');
    check('null 文本按空串补块（现状）', setFrontmatterFlag(null, 'k', true) === '---\nk: true\n---\n\n');
    const crlfDoc = '---\r\nname: n\r\ndescription: d\r\n---\r\nBODY\r\n';
    const crlfAdd = setFrontmatterFlag(crlfDoc, 'k', true);
    check('CRLF：正文尾部逐字节保留', crlfAdd.endsWith('\r\nBODY\r\n'), JSON.stringify(crlfAdd));
    check('CRLF：新键行以 LF 插入且无 \r\r（现状混行尾）', crlfAdd.includes('\r\nk: true\n') && !crlfAdd.includes('\r\r'), JSON.stringify(crlfAdd));
    const crlfTwice = setFrontmatterFlag(crlfAdd, 'k', true);
    check('CRLF：第二次不重复插键（现状头部被规整为 LF）', crlfTwice.split('k: true').length === 2, JSON.stringify(crlfTwice));
    const lfOverwrite = setFrontmatterFlag(fm(['flag: old', 'description: d'], 'b'), 'flag', false);
    check('LF：覆盖已有键原位替换且行数不变', lfOverwrite === fm(['flag: false', 'description: d'], 'b') && lfOverwrite.split('\n').length === fm(['flag: old', 'description: d'], 'b').split('\n').length, JSON.stringify(lfOverwrite));
    check('LF：覆盖后幂等', setFrontmatterFlag(lfOverwrite, 'flag', false) === lfOverwrite);
    check('LF：幂等纯 LF 文档', setFrontmatterFlag(setFrontmatterFlag(base, 'k', true), 'k', true) === setFrontmatterFlag(base, 'k', true));
  }

  console.log('');
  console.log('Test 6: provider 装配 — list/get 的 summary 形状与目录语义');
  const byName = {};
  {
    const root = mk('dsh-pfm-list-');
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    fs.mkdirSync(dirA); fs.mkdirSync(dirB);
    fs.mkdirSync(path.join(dirA, 'alpha-skill'));
    fs.writeFileSync(path.join(dirA, 'alpha-skill', 'SKILL.md'), FM_A, 'utf8');
    fs.writeFileSync(path.join(dirA, 'beta.md'), FM_B, 'utf8');
    fs.writeFileSync(path.join(dirA, 'nodesc.md'), '---\nname: nodesc\n---\nb', 'utf8');
    fs.mkdirSync(path.join(dirA, '.hidden'));
    fs.writeFileSync(path.join(dirA, '.hidden', 'SKILL.md'), '---\nname: hidden\ndescription: h\n---\nb', 'utf8');
    fs.mkdirSync(path.join(dirA, 'emptydir'));
    fs.mkdirSync(path.join(dirB, 'dup'));
    fs.writeFileSync(path.join(dirB, 'dup', 'SKILL.md'), FM_DUP_N, 'utf8');
    fs.writeFileSync(path.join(dirB, 'dup.md'), FM_DUP_F, 'utf8');
    fs.mkdirSync(path.join(dirB, '@own', 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(dirB, '@own', 'gamma', 'SKILL.md'), FM_G, 'utf8');
    const logs = [];
    const holder = createMarketSkillProvider({ getDirs: () => [dirA, dirB], getDisabled: () => [], log: (l, m) => logs.push([l, m]) });
    check('provider 名固定 market-filesystem', holder.provider.name === 'market-filesystem', holder.provider.name);
    const r = await holder.provider.list({});
    check('list 返回 complete:true + candidates 数组', r.complete === true && Array.isArray(r.candidates));
    for (const c of r.candidates) byName[c.name] = c;
    const names = r.candidates.map((c) => c.name).sort();
    check('目录语义：嵌套+扁平可见，nodesc/.hidden/emptydir/@own 被滤（现状一层扫描）',
      JSON.stringify(names) === JSON.stringify(['Alpha', 'Dup Flat', 'Dup Nested', 'beta']), JSON.stringify(names));
    const alpha = byName['Alpha'];
    check('summary 形状恰为 7 summary 键 + rank + locator（逐键不多不少）',
      exactKeys(alpha, ['name', 'description', 'whenToUse', 'invocation', 'path', 'source', 'provider', 'rank', 'locator']),
      JSON.stringify(Object.keys(alpha)));
    check('逐键：name/description/whenToUse', alpha.name === 'Alpha' && alpha.description === 'alpha desc' && alpha.whenToUse === 'camel use');
    check('逐键：invocation 两键（现状字符串比较恒 true）',
      exactKeys(alpha.invocation, ['modelInvocable', 'userInvocable']) && alpha.invocation.modelInvocable === true && alpha.invocation.userInvocable === true,
      JSON.stringify(alpha.invocation));
    check('逐键：path/source/provider', alpha.path.endsWith(path.join('a', 'alpha-skill', 'SKILL.md')) && alpha.source === 'custom' && alpha.provider === 'market-filesystem');
    check('rank 随目录序递增（首目录 100，+10）', alpha.rank === 100 && byName['Dup Flat'].rank === 110, alpha.rank + '/' + byName['Dup Flat'].rank);
    check('扁平 .md 的 name 回退目录名', byName['beta'].name === 'beta' && byName['beta'].description === 'beta desc');
    check('扁平 .md 的 when_to_use 兼容键生效', byName['beta'].whenToUse === 'snake use', byName['beta'].whenToUse);
    const hDis1 = createMarketSkillProvider({ getDirs: () => [dirA, dirB], getDisabled: () => ['ALPHA'] });
    const d1 = (await hDis1.provider.list({})).candidates.map((c) => c.name);
    check('disabled 大小写不敏感按候选名过滤', d1.indexOf('Alpha') < 0 && d1.indexOf('beta') >= 0, JSON.stringify(d1));
    const hDis2 = createMarketSkillProvider({ getDirs: () => [dirA, dirB], getDisabled: () => ['beta'] });
    const d2 = (await hDis2.provider.list({})).candidates.map((c) => c.name);
    check('disabled 按名过滤扁平技能', d2.indexOf('beta') < 0 && d2.indexOf('Alpha') >= 0, JSON.stringify(d2));
    const g = await holder.provider.get(alpha);
    check('get 返回候选键 + content（恰 10 键）', exactKeys(g, ['name', 'description', 'whenToUse', 'invocation', 'path', 'source', 'provider', 'rank', 'locator', 'content']), JSON.stringify(Object.keys(g)));
    check('get.content 为去 frontmatter 正文', g.content === 'BODY-ALPHA\n', JSON.stringify(g.content));
    check('get(null) → undefined', (await holder.provider.get(null)) === undefined);
    check('get({}) → undefined', (await holder.provider.get({})) === undefined);
    check('list 期间不打 log', logs.length === 0, JSON.stringify(logs));
    const hMiss = createMarketSkillProvider({ getDirs: () => [path.join(root, 'ghost')], getDisabled: () => [] });
    const rm = await hMiss.provider.list({});
    check('目录不存在不抛且返回空', rm.complete === true && rm.candidates.length === 0);
    const afile = path.join(root, 'afile'); fs.writeFileSync(afile, 'x', 'utf8');
    const hFile = createMarketSkillProvider({ getDirs: () => [afile], getDisabled: () => [] });
    const rf = await hFile.provider.list({});
    check('目录实为文件时 readdir 失败降级为空（现状）', rf.complete === true && rf.candidates.length === 0);
    const hEmpty = createMarketSkillProvider({ getDirs: () => [], getDisabled: () => [] });
    check('空目录清单 → 空', (await hEmpty.provider.list({})).candidates.length === 0);
  }

  console.log('');
  console.log('Test 7: startWatching/dispose 确定性契约（不依赖 fs 事件时序）');
  {
    const root = mk('dsh-pfm-watch-');
    const sub = path.join(root, 'w'); fs.mkdirSync(sub);
    const logs = [];
    let calls = 0;
    const h = createMarketSkillProvider({ getDirs: () => [sub], getDisabled: () => [], log: (l, m) => logs.push([l, m]) });
    let threw = false;
    try { h.startWatching(() => { calls++; }); } catch (e) { threw = true; }
    check('对存在目录 startWatching 不抛', !threw);
    check('不依赖事件：同步阶段 onChange 不被调用', calls === 0, String(calls));
    const hGhost = createMarketSkillProvider({ getDirs: () => [path.join(root, 'ghost')], getDisabled: () => [], log: (l, m) => logs.push([l, m]) });
    let threw2 = false;
    try { hGhost.startWatching(() => {}); } catch (e) { threw2 = true; }
    check('对不存在目录 startWatching 不抛不打 log', !threw2 && logs.length === 0, JSON.stringify(logs));
    let threw3 = false;
    try { h.dispose(); h.dispose(); } catch (e) { threw3 = true; }
    check('dispose 幂等（连调两次不抛）', !threw3);
    let threw4 = false;
    try { hGhost.dispose(); } catch (e) { threw4 = true; }
    check('未 watch 直接 dispose 不抛', !threw4);
    let threw5 = false;
    try { h.startWatching(() => {}); h.dispose(); } catch (e) { threw5 = true; }
    check('dispose 后可重新 startWatching 再 dispose', !threw5);
    const hNone = createMarketSkillProvider({ getDirs: () => [], getDisabled: () => [] });
    let threw6 = false;
    try { hNone.startWatching(() => {}); hNone.dispose(); } catch (e) { threw6 = true; }
    check('空目录清单 watch/dispose 不抛', !threw6);
  }

  console.log('');
  console.log('Test 8: readSkillBody 两条布局 + slug 守卫（锁现状）');
  {
    const root = mk('dsh-pfm-rsb-');
    const dirN = path.join(root, 'n'); fs.mkdirSync(dirN);
    const FM_A2 = '---\nname: Alpha\ndescription: ad\n---\nBODY-ALPHA';
    fs.mkdirSync(path.join(dirN, 'alpha-skill'));
    fs.writeFileSync(path.join(dirN, 'alpha-skill', 'SKILL.md'), FM_A2, 'utf8');
    const dirF = path.join(root, 'f'); fs.mkdirSync(dirF);
    fs.writeFileSync(path.join(dirF, 'beta.md'), '---\ndescription: bd\n---\nBODY-BETA', 'utf8');
    const dirD = path.join(root, 'd'); fs.mkdirSync(dirD);
    fs.mkdirSync(path.join(dirD, 'dup'));
    fs.writeFileSync(path.join(dirD, 'dup', 'SKILL.md'), FM_DUP_N, 'utf8');
    fs.writeFileSync(path.join(dirD, 'dup.md'), FM_DUP_F, 'utf8');
    const dirO = path.join(root, 'o'); fs.mkdirSync(dirO);
    fs.mkdirSync(path.join(dirO, '@own', 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(dirO, '@own', 'gamma', 'SKILL.md'), FM_G, 'utf8');
    const r2 = path.join(root, 'r2'); fs.mkdirSync(r2);
    fs.writeFileSync(path.join(r2, 'flat.md'), '---\nname: f\ndescription: d\n---\nFROM-R2', 'utf8');
    const r3 = path.join(root, 'r3'); fs.mkdirSync(r3);
    fs.writeFileSync(path.join(r3, 'flat.md'), '---\nname: f\ndescription: d\n---\nFROM-R3', 'utf8');
    const out = mk('dsh-pfm-rsbout-');
    fs.writeFileSync(path.join(out, 'escape.md'), '---\nname: esc\ndescription: d\n---\nESCAPED', 'utf8');
    const dirE = path.join(root, 'esc-root'); fs.mkdirSync(dirE);

    const nested = await readSkillBody([dirN], 'alpha-skill');
    check('嵌套布局命中且恰 4 键', !!nested && exactKeys(nested, ['path', 'size', 'content', 'raw']), JSON.stringify(nested && Object.keys(nested)));
    check('content 为去 frontmatter 正文，raw 为全文，size 为字节长',
      nested.content === 'BODY-ALPHA' && nested.raw === FM_A2 && nested.size === Buffer.byteLength(FM_A2),
      JSON.stringify(nested && { c: nested.content, s: nested.size }));
    const flat = await readSkillBody([dirF], 'beta');
    check('扁平布局命中', !!flat && flat.path.endsWith('beta.md') && flat.content === 'BODY-BETA', JSON.stringify(flat && flat.path));
    const dup = await readSkillBody([dirD], 'dup');
    check('两布局并存时嵌套 SKILL.md 优先（候选顺序现状）', !!dup && dup.content === 'NESTED-BODY', JSON.stringify(dup && dup.content));
    const gamma = await readSkillBody([dirO], 'gamma');
    check('@owner 两层布局可达', !!gamma && gamma.content === 'BODY-GAMMA', JSON.stringify(gamma && gamma.path));
    check('根目录顺序决定优先级（先根先胜）', (await readSkillBody([r2, r3], 'flat')).content === 'FROM-R2' && (await readSkillBody([r3, r2], 'flat')).content === 'FROM-R3');
    check('不可读/缺失根被跳过，后根仍可命中', (await readSkillBody([path.join(root, 'ghost'), r2], 'flat')).content === 'FROM-R2');
    check('全部未命中 → null', (await readSkillBody([dirN], 'nope')) === null);
    check('空根清单 → null', (await readSkillBody([], 'alpha-skill')) === null);
    const afile = path.join(root, 'afile'); fs.writeFileSync(afile, 'not a dir', 'utf8');
    check('根实为文件 → null（readdir ENOTDIR 被吞，候选均不存在）', (await readSkillBody([afile], 'escape')) === null);
    const escapeSlug = path.relative(dirE, path.join(out, 'escape'));
    const esc = await readSkillBody([dirE], escapeSlug);
    check('穿越 slug：../ 解析到存在文件时会被读出（现状无守卫，依赖上层；已上报）',
      !!esc && !esc.path.startsWith(dirE) && esc.content === 'ESCAPED',
      JSON.stringify(esc && esc.path));
    const abs = await readSkillBody([dirE], path.join(out, 'escape.md'));
    check('绝对路径 slug：join 成垃圾路径 → null（现状偶合安全）', abs === null, JSON.stringify(abs && abs.path));
    check('slug 为 .. → null', (await readSkillBody([root], '..')) === null);
  }

  console.log('');
  console.log('Test 9: skillMetaFromText 与 provider summaryFrom 字段一致性');
  {
    const root = mk('dsh-pfm-meta-');
    const dir = path.join(root, 'm'); fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'alpha-skill'));
    fs.writeFileSync(path.join(dir, 'alpha-skill', 'SKILL.md'), FM_A, 'utf8');
    fs.writeFileSync(path.join(dir, 'beta.md'), FM_B, 'utf8');
    const holder = createMarketSkillProvider({ getDirs: () => [dir], getDisabled: () => [] });
    const cands = (await holder.provider.list({})).candidates;
    const candA = cands.find((c) => c.name === 'Alpha');
    const candB = cands.find((c) => c.name === 'beta');
    const metaA = skillMetaFromText(FM_A, 'ignored');
    check('alpha：name/description/whenToUse 三字段一致',
      metaA.name === candA.name && metaA.description === candA.description && metaA.whenToUse === candA.whenToUse,
      JSON.stringify({ meta: metaA, cand: { n: candA.name, d: candA.description, w: candA.whenToUse } }));
    const metaB = skillMetaFromText(FM_B, 'ignored');
    check('beta（无 name）：description/whenToUse 一致', metaB.description === candB.description && metaB.whenToUse === candB.whenToUse);
    check('现状差异：meta 走 coerceBool，provider 的 invocation 不转型（已上报）',
      metaA.disableModelInvocation === true && candA.invocation.modelInvocable === true,
      JSON.stringify({ meta: metaA.disableModelInvocation, inv: candA.invocation }));
  }

} finally {
  for (const d of litter) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const residueAfter = fs.readdirSync(safeTempDir()).filter((d) => d.startsWith('dsh-pfm-')).length;
check('temp 残留增量为 0', residueBefore >= 0 && residueAfter === residueBefore, 'before=' + residueBefore + ' after=' + residueAfter);
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);