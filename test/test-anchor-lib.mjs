#!/usr/bin/env node
// test-anchor-lib.mjs — 锚定位库的契约测试。
//
// 这个库存在的理由是一次真实的核验误报：0.5.129 那轮我用裸 indexOf 核验交付物，
// 锚串「退出选择」在 client.js 里命中 2 次，且第一次出现在窗口起点之前，slice 得到
// 空串，于是核验报 FALSE —— 而实现其实是完整的。「核验脚本自己出错」比实现出错更危险：
// 它给出的结论看起来是实测。所以这里用证伪用例锁死：非唯一锚必须 throw，绝不返回
// 一个可能是空窗口的结果。
import { countHits, once, lineOf, sliceBetween, absent } from './anchor-lib.mjs';

let passed = 0, failed = 0;
const check = (n, cond, d) => { if (cond) { passed++; console.log('  OK ' + n); } else { failed++; console.log('  FAIL ' + n + (d ? '  [' + String(d).slice(0, 150) + ']' : '')); } };

console.log('Test 1: countHits');
check('0 命中', countHits('abc', 'zzz') === 0);
check('1 命中', countHits('abc', 'bc') === 1);
check('3 命中', countHits('aaa', 'a') === 3, countHits('aaa', 'a'));
{
  // 死循环回归锁：空 needle 在 V8 会让 indexOf 钳位、循环永不退出。
  // 曾经真的把这一轮挂到超时，所以它必须是显式 throw 而不是静默返回某个数。
  let threw = '';
  try { countHits('ab', ''); } catch (err) { threw = String(err.message); }
  check('空 needle 必须 throw（防死循环）', threw.length > 0 && /空/.test(threw), threw.slice(0, 70));
}

console.log('Test 2: once 命中数判定（证伪核心）');
check('唯一锚返回位置', once('hello world', 'world') === 6);
{
  let threw = '';
  try { once('hello world hello', 'hello'); } catch (e) { threw = String(e.message); }
  check('多命中必须 throw（非唯一即歧义）', threw.length > 0, JSON.stringify(threw.slice(0, 60)));
  check('throw 信息含命中次数', /命中 2 次/.test(threw), threw.slice(0, 80));
}
{
  let threw = '';
  try { once('abc', 'zzz'); } catch (e) { threw = String(e.message); }
  check('0 命中必须 throw（锚已失效）', threw.length > 0 && /命中 0 次/.test(threw), threw.slice(0, 80));
}
check('throw 信息含 label', (() => { try { once('a b a', 'a', '我的锚'); return false; } catch (e) { return /我的锚/.test(e.message); } })());

console.log('Test 3: lineOf');
{
  const src = ['first line', '  second with needle', 'third'].join(String.fromCharCode(10));
  const i = once(src, 'needle');
  check('取到整行而非片段', lineOf(src, i).includes('second') && lineOf(src, i).includes('needle') && !lineOf(src, i).includes('third'), JSON.stringify(lineOf(src, i)));
  check('末行无换行也不炸', lineOf('abc' + String.fromCharCode(10) + 'xyz', 4).trim() === 'xyz');
}

console.log('Test 4: sliceBetween 区间（防 0.5.129 空窗口）');
{
  const src = 'AAAA target1 MMMMM target2 ZZZZ';
  // 区间语义 = [起锚起点, 尾锚起点)：含起锚文本、不含尾锚文本。
  // 这是 0.5.129 当年正确核验用的形态（slice(条起, 条尾)），在此锁死而不是靠记忆。
  check('区间含起锚、不含尾锚', sliceBetween(src, 'target1', 'target2') === 'target1 MMMMM ', JSON.stringify(sliceBetween(src, 'target1', 'target2')));
  check('区间非空且长度正常', sliceBetween(src, 'target1', 'target2').length > 0);
  let threw = '';
  try { sliceBetween(src, 'target2', 'target1'); } catch (e) { threw = String(e.message); }
  // 关键证伪：尾锚早于起锚时，裸 indexOf 会给负长度 → 空串 → 核验误报 FALSE
  check('锚顺序颠倒必须 throw（不得给空窗口）', threw.length > 0 && /顺序颠倒/.test(threw), threw.slice(0, 70));
  let threw2 = '';
  try { sliceBetween(src + ' target1', 'target1', 'target2'); } catch (e) { threw2 = String(e.message); }
  check('起锚不唯一也 throw', /命中 2 次/.test(threw2), threw2.slice(0, 70));
}

console.log('Test 5: 对真实 client.js 复现当年误报（回归锁）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const W = path.resolve(import.meta.dirname, '..');
  const c = fs.readFileSync(path.join(W, 'client.js'), 'utf8');
  // 「退出选择」正是当年那个多命中锚：它命中 2 次，所以 once 必须拒绝它。
  const bare = '退出选择';
  const hits = countHits(c, bare);
  check('已知多命中锚仍 >1（场景成立）', hits > 1, '命中 ' + hits + ' 次');
  let threw = '';
  try { once(c, bare, '裸退出选择'); } catch (e) { threw = String(e.message); }
  check('裸锚被 once 拒绝', /命中/.test(threw), threw.slice(0, 70));
  // 唯一闭锚必须可用（这就是核验脚本该用的形态）
  const SQ = String.fromCharCode(39);
  const uniq = 'onClick: exitBatch }, ' + SQ + bare + SQ + '))';
  check('唯一闭锚命中 1 次', countHits(c, uniq) === 1, countHits(c, uniq));
  check('唯一闭锚可定位', once(c, uniq, '批量条尾') > 0);
}

console.log('');

console.log('');
console.log('Test 6: absent() —— 否定断言的非冲突判定（子串冒充面回归锁）');
{
  // 本仓库连犯两次同类假阳性：!includes('windowed') 被 windowedIn 触发、
  // !includes('pageWin') 被 pageWindow 触发。absent() 只把「独立标识符」算出现，
  // 被更长合法标识符包住的一律不算。
  check('独立出现算存在', absent('const windowed = 1', 'windowed') === false, '');
  check('作为更长标识符的子串不算存在（证伪核心）', absent('const windowedIn = 1', 'windowed'), '');
  check('作为前缀的更长标识符也不算', absent('pageWindow(page, n, 5)', 'pageWin'), '');
  check('完全没有则 absent', absent('const size = 1', 'windowed'), '');
  // 边界：下划线/字母算标识符延续，空白/标点/括号算分隔
  check('前接下划线视为更长标识符', absent('x_windowed = 1', 'windowed'), '');
  check('后接数字视为更长标识符', absent('windowed2 = 1', 'windowed'), '');
  check('括号包裹仍视为独立', absent('f(windowed);', 'windowed') === false, '');
  check('模板插值紧跟 ${ 仍视为独立', absent('标签（${x}', '标签（') === false, '');
  // 多次独立出现
  check('多次独立仍算存在', absent('a=windowed; b=windowed;', 'windowed') === false, '');
  // 空 needle 必须拒绝（与 countHits 同规则）
  let threw = '';
  try { absent('abc', ''); } catch (e) { threw = String(e.message); }
  check('空 needle 被拒绝', /不得为空/.test(threw), threw.slice(0, 60));
  // 真实源码验证：client.js 现在有 pageWindow，用旧断言 'pageWin' 会被误红，
  // 而 absent('pageWin') 必须为真（旧死代码确实不在）
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const c0 = fs2.readFileSync(path2.resolve(import.meta.dirname, '..', 'client.js'), 'utf8');
  // 判定范围必须是代码而非散文：注释里提一句被删掉的参数名是正常的历史说明，
  // 把它算成「标识符仍存在」就是断言越界。剥整行注释后再判。
  const c = c0.split(String.fromCharCode(10)).filter(function (l) {
    const s = l.trimStart();
    return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
  }).join(String.fromCharCode(10));
  check('真实 client.js 含 pageWindow（冒充面存在）', c.includes('pageWindow'), '');
  check('但 absent(pageWin) 仍为真（旧助手确实不在）', absent(c, 'pageWin'), '');
  // 断言范围必须是 pageWindow 的函数体，不能是整个 client.js：0.5.177 的 tail 说明行
  // （client.js tailMemo.windowed）是一个真存在的同名属性，整文件判定会把一次合法
  // 的新增读成「死参数复活」。pageWindow 的参数表 (page, n, span) 里没有 windowed，
  // 这才是本判据要锁的东西。
  const pwStart = c.indexOf('const pageWindow = (');
  check('client.js 里 pageWindow 定义可定位', pwStart >= 0, String(pwStart));
  const pwEndRaw = c.indexOf('    };', pwStart);
  const pwBody = pwStart >= 0 && pwEndRaw > pwStart ? c.slice(pwStart, pwEndRaw) : '';
  check('pageWindow 函数体可取到（非退化空串）', pwBody.length > 80, String(pwBody.length));
  check('absent(windowed) 为真（pageWindow 签名死参数已删）', absent(pwBody, 'windowed'), '');
  // 反向自证：把死参数塞回签名必须让上面那条转红，否则是 vacuous 断言。
  check('注入 windowed 后正证门仍会红（自证非 vacuous）', absent(pwBody.replace('(page, n, span)', '(page, n, span, windowed)'), 'windowed') === false, '');
  // client.js:1144 仍有一句过时注释描述 windowed 参数语义（散文，不算命中）——
  // 那句字样与本批 tail 文案里合法的 tailMemo.windowed 相同，随本批一并删除。
}


console.log('');
console.log('Test 7: 常驻守卫 —— 否定断言不得存在子串冒充面');
{
  // 同类假阳性连犯两次（Test 11 的 skillsTotalPages 冒充 skillsTotal、profile-sync 的
  // pageWindow 冒充 pageWin），说明是共性风险而非孤例。规则：断言「某标识符不该出现」
  // 且被检串完全由标识符字符组成时，必须用 absent()；裸 !x.includes('plainId') 是子串
  // 匹配，未来一个更长的合法标识符（appendFileSyncSafe 之类）就会把它误红。
  // 含点/横杠/空格的 needle（'frame.check'、'const shown = Math.min'）没有冒充面，
  // 允许保持 includes。扫描只取代码：注释里的历史说明不算违规，也不算命中。
  const fs7 = await import('node:fs');
  const path7 = await import('node:path');
  const dir = path7.resolve(import.meta.dirname);
  const strip = function (t) {
    const out = [];
    for (const l of t.split(/\r?\n/)) {
      const s = l.trimStart();
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) { out.push(''); continue; }
      const c = l.indexOf('//');
      out.push(c >= 0 ? l.slice(0, c) : l);
    }
    return out.join('\n');
  };
  const QUOTE_A = String.fromCharCode(39);
  const QUOTE_B = String.fromCharCode(34);
  const IDCH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';
  function plainIdent(s) {
    if (!s) return false;
    if (!'_$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(s[0])) return false;
    for (const ch of s) if (!IDCH.includes(ch)) return false;
    return true;
  }
  // 逐字符找 !<接收者>.includes('<needle>') 形态（不用正则，避开字符类引号转义）。
  // 两条收窄规则都有实例支撑，目的是「不逼正确代码为闸门让路」：
  // ① ! 与 .includes( 之间若出现 .test( / || / &&，那个 ! 否定的是别的子表达式
  //    （误报实例：!/sameCommand|commandChanged/.test(mj) || mj.includes('rawSetAcceptsCommand')）。
  // ② 接收者必须是源文本：裸标识符，或 codeOnly(...)/strip(...) 这类剥注释助手。
  //    其它函数调用的结果（如 sortKeysFor(...) 返回数组）走的是**成员判定**、精确等值，
  //    没有子串冒充面（误报实例：!sortKeysFor('clawhub').includes('trending')）。
  const TEXT_FN = ['codeOnly(', 'strip('];
  function receiverIsText(recv) {
    const t = recv.trim();
    if (!t) return false;
    for (const fn of TEXT_FN) if (t.startsWith(fn)) return true;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t);
  }
  function negations(code) {
    const found = [];
    let i = 0;
    while (i < code.length) {
      if (code[i] !== '!') { i += 1; continue; }
      const inc = code.indexOf('.includes(', i);
      if (inc < 0 || inc - i > 120) { i += 1; continue; }
      const between = code.slice(i + 1, inc);
      if (between.includes('.test(') || between.includes('||') || between.includes('&&')) { i = inc; continue; }
      // 接收者就是 ! 与 .includes( 之间的整段（前面已排除含 .test/||/&& 的情形）。
      // 别再剥尾部标识符 —— 裸 `i` 会被整个剥成空串而漏检（证伪样例抓到了这个）。
      const recv = between.trim();
      if (!receiverIsText(recv)) { i = inc; continue; }
      const q = code[inc + 10];
      if (q !== QUOTE_A && q !== QUOTE_B) { i = inc; continue; }
      const close = code.indexOf(q, inc + 11);
      if (close < 0) { i = inc; continue; }
      found.push(code.slice(inc + 11, close));
      i = close + 1;
    }
    return found;
  }
  const hits = [];
  const files = fs7.readdirSync(dir).filter(function (x) { return x.endsWith('.mjs') && x !== 'test-anchor-lib.mjs' && x !== 'gate-verdict.mjs'; });
  for (const f of files) {
    const code = strip(fs7.readFileSync(path7.join(dir, f), 'utf8'));
    for (const needle of negations(code)) {
      if (plainIdent(needle)) hits.push(f + ' → !…includes(' + needle + ')');
    }
  }
  check('无纯标识符的裸子串否定断言', hits.length === 0, hits.join(' | '));
  // 自证：检测器必须真抓得到这类写法，否则守卫是空转的
  const Q = String.fromCharCode(39);
  // 反向：接收者是别的函数调用（数组成员判定）不得算违规
  const arrSample = strip("check(" + Q + "z" + Q + ", !sortKeysFor(" + Q + "clawhub" + Q + ").includes(" + Q + "trending" + Q + "));");
  check("数组成员判定不误报", negations(arrSample).filter(plainIdent).length === 0, negations(arrSample).join(","));
  // 反向：! 否定的是别的子表达式时，不得配对到后面的 includes
  const pairSample = strip("check(" + Q + "z" + Q + ", !/sameCommand|commandChanged/.test(mj) || mj.includes(" + Q + "rawSetAcceptsCommand" + Q + "));");
  check("! 配对错误不误报", negations(pairSample).filter(plainIdent).length === 0, negations(pairSample).join(","));
  // 正向：剥注释助手接收者仍必须被抓（防止规则收窄过头变成空转）
  const textFnSample = strip("check(" + Q + "z" + Q + ", !codeOnly(g).includes(" + Q + "windowed" + Q + "));");
  check("剥注释助手接收者仍被抓", negations(textFnSample).filter(plainIdent).join(",") === "windowed", negations(textFnSample).join(","));
  // 正向：裸标识符接收者（最典型的违规形态）必须被抓
  const bareSample = strip("const i = 1;" + String.fromCharCode(10) + "check(" + Q + "x" + Q + ", !i.includes(" + Q + "windowed" + Q + "));");
  check("裸标识符接收者仍被抓", negations(bareSample).filter(plainIdent).join(",") === "windowed", negations(bareSample).join(","));
  const sample = strip('const i = 1;' + '\n' + 'check(\'' + 'x' + '\', !i.includes(\'' + 'windowed' + '\'));');
  const caught = negations(sample).filter(plainIdent);
  check('检测器能抓到注入的违规写法', caught.join(',') === 'windowed', caught.join(','));
  // 反向：含空格的 needle 不该被抓（否则守卫变成一刀切，会逼人写更坏的断言）
  const okSample = strip('check(\'' + 'y' + '\', !r.includes(\'' + 'const shown = Math.min' + '\'));');
  const falsePos = negations(okSample).filter(plainIdent);
  check('含空格的 needle 不误报', falsePos.length === 0, falsePos.join(','));
}


console.log('');
console.log('Test 9: 守卫不得自指（扫自身源码的判据，字面量不得同时出现在自己体内）');
{
  // 真实事故（本轮 Test 8 第一版）：想锁「白名单只有两项」，判据写成对 self 的
  // split/indexOf 计数，而字面量本体也写在断言里 → self 必然命中 2 次，守卫把
  // 自己判红（假红）；随手改成 >=2 就又变成永真假绿。
  // 范围必须精准（第一版我扫了整个文件的所有 indexOf 字面量，结果把 patchFile 的
  // 夹具字符串 inserted 1 / const A = 1; 也算进来 —— 那是测试数据，不是扫自身的判据，
  // 属于误伤）。正确范围：只统计「以 self 读取变量为接收者」的那些字面量。
  const fs9 = await import('node:fs');
  const path9 = await import('node:path');
  const dir9 = path9.resolve(import.meta.dirname);
  const names9 = fs9.readdirSync(dir9).filter((x) => x.slice(0, 5) === 'test-' && x.slice(-4) === '.mjs');
  const Q = String.fromCharCode(39);
  const offenders = [];
  let selfReaders = 0;
  for (const n of names9) {
    const t = fs9.readFileSync(path9.join(dir9, n), 'utf8');
    // 找 const VAR = fs.readFileSync(new URL('./本文件.mjs', ...)) —— 变量名从该行取
    const readAt = t.indexOf('new URL(' + Q + './' + n + Q + ',');
    if (readAt < 0) continue;
    selfReaders += 1;
    const lineStart = t.lastIndexOf(String.fromCharCode(10), readAt) + 1;
    const decl = t.slice(lineStart, readAt);
    const vm = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(decl);
    if (!vm) continue;
    const V = vm[1];
    // 只看该变量的接收者用法：V.indexOf('LIT') / V.split('LIT')
    for (const op of ['.indexOf(', '.split(']) {
      let cur = 0;
      for (;;) {
        const p = t.indexOf(V + op, cur);
        if (p < 0) break;
        cur = p + 1;
        const q1 = t.indexOf(Q, p);
        if (q1 < 0 || q1 - p > 24) continue;
        const q2 = t.indexOf(Q, q1 + 1);
        if (q2 < 0 || q2 - q1 > 90) continue;
        const lit = t.slice(q1 + 1, q2);
        if (lit.length < 8 || lit.indexOf(Q) >= 0) continue;
        const c = t.split(lit).length - 1;
        if (c >= 2) offenders.push(n + ' 用 ' + V + ' 扫自身，判据 ' + JSON.stringify(lit.slice(0, 30)) + ' 在本文件出现 ' + c + ' 次');
      }
    }
  }
  console.log('   自读型套件数=' + selfReaders);
  check('扫自身源码的判据不自指（字面量必须字符码拼装）', offenders.length === 0, offenders.slice(0, 3).join(' | '));
  // 证伪：本守卫自身也不得自指 —— 上面用于定位的字面量都是拼接出来的，
  // 因此「扫描面」这条断言不会因自己而红。这里断言拼接确实生效（无完整字面量落盘）。
  const me = fs9.readFileSync(path9.join(dir9, 'test-anchor-lib.mjs'), 'utf8');
  check('守卫自身用拼接定位自读语句', me.indexOf('new URL(') >= 0 && me.split(Q + './' + 'test-anchor-lib.mjs' + Q).length - 1 === 0, '');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
