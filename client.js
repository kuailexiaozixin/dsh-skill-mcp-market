// Client half of dsh-skill-mcp-market: a floating market panel registered into `shell.overlay`.
// No build step; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-skill-mcp-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const RPC = '/api/dsh-market/rpc';
    const openExt = (url) => {
      if (!url) return;
      if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    };

    async function call(op, payload) {
      // A hung response must surface as an error instead of an endless spinner.
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload || {}) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(90000),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `HTTP ${response.status}`);
      }
      return data;
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: 'var(--dsh-text-primary, #1f2328)',
      },
      launcher: {
        height: 40,
        padding: '0 16px',
        borderRadius: 20,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-surface, #ffffff)',
        color: 'inherit',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(0,0,0,.16)',
        fontWeight: 600,
      },
      panel: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      pane: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      dim: {
        padding: 24,
        color: '#888',
        fontSize: 14,
        textAlign: 'center',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--dsh-border, #eaeef2)' },
      tab: (active) => ({
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: active ? 'var(--dsh-surface-raised, #f0f3f6)' : 'transparent',
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        color: 'inherit',
      }),
      body: { flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'stretch' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignContent: 'start', alignItems: 'start' },
      chip: (active) => ({
        padding: '4px 10px',
        borderRadius: 999,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: active ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: active ? '#fff' : 'inherit',
      }),
      input: {
        flex: 1,
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-input-bg, #fff)',
        color: 'inherit',
        font: 'inherit',
      },
      card: {
        minWidth: 220,
        border: '1px solid var(--dsh-border, #eaeef2)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      title: { fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      desc: { opacity: 0.75, fontSize: 12, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      meta: { display: 'flex', gap: 6, fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
      btn: (kind) => ({
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: kind === 'primary' ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: kind === 'primary' ? '#fff' : 'inherit',
      }),
      status: { fontSize: 12, opacity: 0.75 },
      err: { fontSize: 12, color: '#c62828' },
    };

    function setPathRow(label, value, onChange) {
      return h('div', { style: S.row },
        h('span', { style: { width: 64, opacity: 0.7, fontSize: 12 } }, label),
        h('input', { style: S.input, value, onChange: (e) => onChange(e.target.value) }));
    }

    function Market(props) {
      const [tab, setTab] = useState('skills');
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [skills, setSkills] = useState([]);
      const [mcps, setMcps] = useState([]);
      const [installed, setInstalled] = useState([]);
      const [mounted, setMounted] = useState([]);
      const [settings, setSettings] = useState(null);
      const [skillDraft, setSkillDraft] = useState('');
      const [mcpDraft, setMcpDraft] = useState('');
      // { slug, missing: string[] } — the connector needs values before it can start
      const [envPrompt, setEnvPrompt] = useState(null);
      const [envDraft, setEnvDraft] = useState({});
      // { kind: 'skill'|'mcp', slug, data } — detail drawer with the edit form
      const [detail, setDetail] = useState(null);
      const [draft, setDraft] = useState({});
      const [source, setSource] = useState('clawhub');
      const [mcpSource, setMcpSource] = useState('registry');
      const [mcpCategory, setMcpCategory] = useState('all');
      const [mcpSort, setMcpSort] = useState('default');
      const [mcpPage, setMcpPage] = useState(1);
      const [mcpTotalPages, setMcpTotalPages] = useState(0);
      const [mcpHasMore, setMcpHasMore] = useState(false);
      const [mcpTotal, setMcpTotal] = useState(0);
      const [mcpCategories, setMcpCategories] = useState([]);
      const [size, setSize] = useState(24);
      const [sort, setSort] = useState('default');
      const [category, setCategory] = useState('all');
      const [preview, setPreview] = useState(null);
      const [installedFilter, setInstalledFilter] = useState('');
      // 最近一次的查询结果缓存（按 tab+source+category+sort+query 作 key），
      // 切源/改查询时若命中就立即渲染缓存、后台再刷新，避免每次切源都白屏重查。
      const resultCacheRef = useRef({});
      const [nativeDirs, setNativeDirs] = useState([]);
      // 技能市场的分页：每个源都支持真正的翻页，页数/总数由后端这一页返回的元数据决定
      const [skillsPage, setSkillsPage] = useState(1);
      const [skillsTotalPages, setSkillsTotalPages] = useState(1);
      const [skillsTotal, setSkillsTotal] = useState(0);
      const [skillsHasMore, setSkillsHasMore] = useState(false);

/**
       * 分页导航：上一页/下一页 + 页码（中间省略号折叠）+ 每页条数选择器。
       * 页码序列 1…5,7,8,20 → [1,2,3,4,5,'…',7,8,20]：当前页前后各留 2 个、首尾常显、
       * 间隔大于 1 处折叠成一个「…」（点「…」向后跳 5 页，再点继续 +5，直到接近末页）。
       * 总页数未知（注册表按 cursor 翻页）时退化为「上一页 / 第 n 页 / 下一页」。
       */
      const pageItems = (current, totalPages) => {
        const n = Math.max(1, Math.trunc(totalPages) || 1);
        current = Math.min(Math.max(1, Math.trunc(current) || 1), n);
        if (n <= 9) {
          const all = [];
          for (let i = 1; i <= n; i += 1) all.push({ kind: 'num', at: i });
          return all;
        }
        const keep = new Set([1, 2, n - 1, n, current - 1, current, current + 1]);
        for (let i = Math.max(3, current - 2); i <= Math.min(n - 2, current + 2); i += 1) keep.add(i);
        const nums = [...keep].filter((p) => p >= 1 && p <= n).sort((a, b) => a - b);
        const out = [];
        let prev = 0;
        for (const p of nums) {
          if (p - prev > 1) out.push({ kind: 'gap', at: p });
          out.push({ kind: 'num', at: p });
          prev = p;
        }
        return out;
      };

      const gotoPage = (p) => {
        p = Math.max(1, Math.min(p, 1 << 30));
        if (tab === 'skills') searchSkills(query, { source, size, page: p });
        else searchMcps(query, { page: p });
      };

      const pager = (page, totalPages, hasMore, label) => {
        const unknown = !totalPages; // 注册表按 cursor 走，没有可数的总页数
        const n = unknown ? 0 : Math.max(1, Math.trunc(totalPages) || 1);
        const shown = Math.min(page, n || page);
        const items = pageItems(shown, n || 1);
        return h('div', { style: { ...S.row, justifyContent: 'space-between', padding: '4px 2px' } },
          h('div', { style: S.row },
            h('button', {
              style: S.btn(),
              disabled: page <= 1 || busy !== '',
              onClick: () => gotoPage(page - 1),
            }, '‹ 上一页'),
            items.map((it, i) => it.kind === 'gap'
              ? h('button', {
                  key: `g${i}`,
                  style: { ...S.btn(), minWidth: 44, opacity: 0.7 },
                  title: '向后跳 5 页',
                  onClick: () => gotoPage(unknown ? page + 5 : Math.min(it.at + 5, n)),
                }, '…')
              : h('button', {
                  key: it.at,
                  style: S.btn(it.at === page ? 'primary' : undefined),
                  disabled: busy !== '' || it.at === page,
                  onClick: () => gotoPage(it.at),
                }, String(it.at))),
            h('button', {
              style: S.btn(),
              disabled: (unknown ? !hasMore : page >= n) || busy !== '',
              onClick: () => gotoPage(page + 1),
            }, '下一页 ›')),
          h('div', { style: S.row },
            h('span', { style: S.status },
              unknown
                ? `${label} · 第 ${page} 页（${hasMore ? '可继续加载' : '已是最后一页'}）`
                : `${label} 第 ${page} / ${n} 页`)));
      };

      const loadInstalled = useCallback(async () => {
        const [s, m] = await Promise.all([call('skills.list'), call('mcp.list')]);
        setInstalled(s.items || []);
        setMounted(m.items || []);
        return { s, m };
      }, []);

      const loadSettings = useCallback(async () => {
        const d = await call('settings.get');
        setSettings(d);
        setSkillDraft((d.settings.skillDirs || []).join('\n'));
        setMcpDraft((d.settings.mcpDirs || []).join('\n'));
        setNativeDirs(d.settings.dshNativeSkillDirs || []);
      }, []);

      const searchSkills = useCallback(async (text, options) => {
        const src = (options && options.source) || 'all';
        const q = String(text || '');
        const pageNo = (options && options.page) || 1;
        const append = Boolean(options && options.append);
        // 只有「首页」进缓存；翻页是增量追加，缓存它没有意义还会撑爆内存
        const cacheKey = append ? '' : `sk|${src}|${q}|${pageNo}`;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        // 命中缓存：立即渲染旧结果，不白屏；后台再刷新
        if (cached) {
          setSkills(cached.items || []);
          setSkillsPage(1);
          setSkillsTotalPages(cached.pages || 1);
          setSkillsTotal(cached.total || (cached.items || []).length);
          setSkillsHasMore(Boolean(cached.hasMore));
          if ((cached.items || []).length) setNotice('（缓存，正在刷新…）');
        } else if (!append) {
          setBusy('skills.search');
        }
        setError('');
        try {
          const d = await call('skills.search', {
            query: text,
            source: src,
            page: pageNo,
            pageSize: (options && options.size) || size,
          });
          const rows = d.items || [];
          if (cacheKey) {
            resultCacheRef.current[cacheKey] = {
              items: rows,
              pages: d.pages,
              total: d.total,
              hasMore: d.hasMore,
              hints: d.hints || [],
              degraded: d.degraded || [],
            };
          }
          if (append) {
            // 追加去重：翻页边界上偶尔会重复返回同一条，去重后列表才不会原地重复
            setSkills((prev) => {
              const seen = new Set(prev.map((x) => x.id));
              return prev.concat(rows.filter((x) => !seen.has(x.id)));
            });
          } else {
            setSkills(rows);
          }
          setSkillsPage(d.page || pageNo);
          setSkillsTotalPages(d.pages || 1);
          setSkillsTotal(Number(d.total) || rows.length);
          setSkillsHasMore(Boolean(d.hasMore));
          const hints = (d.hints || []).filter(Boolean);
          if (!(d.items || []).length) {
            // An empty market is either "no match", "needs a keyword" or "upstream refused us".
            const reasons = (d.sourceErrors || []).length
              ? d.sourceErrors
              : hints.length
                ? hints
                : (d.degraded || []).length
                  ? [`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`]
                  : ['没有找到匹配的技能。'];
            setNotice(reasons.join('；'));
          } else if (hints.length) {
            setNotice(hints.join('；'));
          } else if ((d.degraded || []).length) {
            setNotice(`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`);
          } else {
            setNotice('');
          }
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      }, []);

      const searchMcps = useCallback(async (text, options) => {
        const opts = options || {};
        const nextSource = opts.source || mcpSource;
        const nextCategory = opts.category !== undefined ? opts.category : mcpCategory;
        const nextSort = opts.sort !== undefined ? opts.sort : mcpSort;
        const nextPage = opts.page || 1;
        // 首屏查询（非 append）命中缓存时立即渲染旧结果，后台再刷新，避免切源白屏
        const cacheKey = opts.append ? '' : `mc|${nextSource}|${nextCategory === 'all' ? '' : nextCategory}|${nextSort === 'default' ? '' : nextSort}|${String(text || '')}|${nextPage}`;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        if (cached) {
          setMcps(cached.items || []);
          setNotice('（缓存，正在刷新…）');
        } else {
          setBusy('mcp.search');
        }
        setError('');
        try {
          const d = await call('mcp.search', {
            query: text,
            source: nextSource,
            category: nextCategory === 'all' ? '' : nextCategory,
            sort: nextSort === 'default' ? '' : nextSort,
            page: nextPage,
          });
          const rows = d.items || [];
          if (cacheKey) resultCacheRef.current[cacheKey] = { items: rows, categories: d.categories || [] };
          // Append must not repeat a card: the registry pages by version rows, so a server
          // may legitimately return a slug that is already on screen.
          setMcps(opts.append
            ? (prev) => {
                const seen = new Set(prev.map((m) => m.id || m.slug));
                return prev.concat(rows.filter((m) => !seen.has(m.id || m.slug)));
              }
            : rows);
          setMcpPage(d.page || nextPage);
          // totalPages 0 means the source cannot count pages (the registry is cursor-based);
          // canLoadMore is then the only honest signal.
          setMcpTotalPages(d.totalPages || 0);
          setMcpHasMore(d.canLoadMore !== undefined
            ? Boolean(d.canLoadMore)
            : (d.page || nextPage) < (d.totalPages || 1));
          setMcpTotal(d.total || rows.length);
          setMcpCategories(d.categories || []);
          // The host reports catalogue degradation separately from "no match", so both the
          // reason and the still-usable path (install by registry name) reach the user.
          if (d.hint) setNotice(d.hint);
          else if (!(d.items || []).length) setNotice('没有找到匹配的连接器；可直接按注册表名称安装，例如 io.github.Async23/chrome-devtools-mcp。');
          else setNotice('');
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => {
        setError('');
        setNotice('');
        loadSettings().catch((e) => setError(String(e.message || e)));
        loadInstalled().catch((e) => setError(String(e.message || e)));
        if (tab === 'skills') searchSkills('', { source, size });
        else searchMcps('');
      }, [tab, loadSettings, loadInstalled, searchSkills, searchMcps]);

      const openSkillDetail = async (slug) => {
        setBusy(`detail:${slug}`);
        setError('');
        try {
          const data = await call('skills.detail', { slug });
          setDetail({ kind: 'skill', slug, data });
          setDraft({ name: slug, description: '', body: data.content });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const openMcpDetail = async (serverName) => {
        setBusy(`detail:${serverName}`);
        setError('');
        try {
          const data = await call('mcp.detail', { serverName });
          setDetail({ kind: 'mcp', slug: serverName, data });
          setDraft({ command: data.command, args: (data.args || []).join('\n'), url: data.url });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const saveSkillEdit = async () => {
        setBusy('save:skill');
        setError('');
        try {
          const saved = await call('skills.update', {
            slug: detail.slug,
            name: draft.name,
            description: draft.description || undefined,
            body: draft.body,
          });
          setNotice(`已保存 ${saved.slug}（${saved.path}），下一步技能目录即刷新`);
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const saveMcpEdit = async () => {
        setBusy('save:mcp');
        setError('');
        try {
          const result = await call('mcp.update', {
            serverName: detail.slug,
            patch: {
              command: draft.command,
              args: String(draft.args || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
              url: draft.url,
            },
          });
          setNotice(result.ok ? `已保存并重连 ${detail.slug}，${result.tools.length} 个工具` : `已保存，但未连上：${result.error || ''}`);
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const openPreview = async (item) => {
        setBusy(`preview:${item.slug}`);
        setError('');
        setPreview(null);
        try {
          const d = await call('skills.preview', {
            source: item.source,
            reference: item.source === 'skills.sh' ? item.homepage : item.source === 'clawhub' ? item.installRef : item.source === 'lobehub-agent' ? item.slug : item.upstreamUrl || item.id,
            skillDir: item.skillDir || '',
            ref: item.ref || '',
            name: item.slug,
          });
          setPreview({
            slug: item.slug,
            name: d.name || item.slug,
            content: d.content || '',
            files: d.files,
            openUrl: d.openUrl || '',
            previewError: d.previewError || '',
          });
        } catch (e) {
          setError(`预览失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const detailUrlFor = (item) => {
        // skills.sh / clawhub / browse.sh 不设「详情」按钮
        if (item.source === 'skills.sh' || item.source === 'clawhub' || item.source === 'browse.sh') {
          return '';
        }
        // lawhub.ai 不设「详情」按钮（通过 homepage 域名或 source 识别）
        if (item.source === 'lawhub' || (item.homepage && /lawhub\.ai$/i.test(item.homepage))) {
          return '';
        }
        if (item.homepage) return item.homepage;
        if (item.upstreamUrl) return item.upstreamUrl;
        return '';
      };

      // Open detail inside the DSH client (never in an external browser).
      // Strategy:
      //   1) sidebarRight.openTab('browser') — works when a session surface is mounted
      //   2) sidebarRight.openTab(plugin pane tab) — same gate
      //   3) inline iframe overlay in the market panel — works for CSP-permissive sites;
      //      for sites with frame-ancestors 'none' (e.g. clawhub.ai) show a notice with
      //      a copy-URL button instead of falling back to an external browser.
      const detailIframeRef = { current: null };

      const openDetail = async (item) => {
        const url = detailUrlFor(item);
        if (!url) return;
        const name = String((item && item.name) || url);

        // 1) Host browser tab (session surface required)
        try {
          const sr = props && props.sidebarRight;
          if (sr && typeof sr.openTab === 'function') {
            sr.openTab('browser', { params: { url } });
            console.info('[dsh-skill-mcp-market] openDetail → sidebarRight browser tab', url);
            return;
          }
        } catch (e) {
          console.warn('[dsh-skill-mcp-market] openDetail browser tab threw:', e && e.message);
        }

        // 2) Plugin pane tab (session surface required)
        try {
          const sr = props && props.sidebarRight;
          if (sr && typeof sr.openTab === 'function') {
            sr.openTab('dsh-skill-mcp-market-detail', {
              params: { detailUrl: url, detailTitle: name },
              title: name,
            });
            console.info('[dsh-skill-mcp-market] openDetail → plugin pane tab', url);
            return;
          }
        } catch { /* fall through */ }

        // 3) Inline overlay (no session surface needed).
        //    Known frame-ancestors 'none' sites get an inline detail panel
        //    immediately (the iframe would just show the browser's built-in
        //    CSP error page, which the user sees as a blank screen).
        const cspBlockedHosts = new Set([
          'clawhub.ai',
          'www.clawhub.ai',
          'browse.sh',
          'www.browse.sh',
        ]);
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch { /* keep '' */ }
        let cspBlocked = cspBlockedHosts.has(hostname);
        let blockReason = '';
        if (!cspBlocked) {
          // The static list is only a fast path for the well-known catalogues.
          // Ask the host what the site's own headers say, so a newly added
          // source (skills.sh was one) never ends up in a blank blocked frame.
          try {
            const verdict = await call('frame.check', { url });
            if (verdict && verdict.embeddable === false) {
              cspBlocked = true;
              blockReason = String(verdict.reason || '');
            }
          } catch (e) {
            console.warn('[dsh-skill-mcp-market] frame.check unavailable, using iframe:', e && e.message);
          }
        }

        if (cspBlocked) {
          console.info('[dsh-skill-mcp-market] openDetail → inline detail panel (not embeddable)', url, blockReason);
        } else {
          console.info('[dsh-skill-mcp-market] openDetail → inline iframe overlay', url);
        }
        const host = document.querySelector('[data-dsh-market-root]');
        if (host && typeof host === 'object' && 'appendChild' in host) {
          // Remove any existing overlay
          if (detailIframeRef.current) detailIframeRef.current.remove();

          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:absolute;inset:0;z-index:10;background:#fff;display:flex;flex-direction:column;';
          const bar = document.createElement('div');
          bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eaeef2;';
          const titleEl = document.createElement('span');
          titleEl.textContent = name;
          titleEl.style.cssText = 'flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          const closeBtn = document.createElement('button');
          closeBtn.textContent = '关闭';
          closeBtn.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:12px;';
          closeBtn.onclick = () => { overlay.remove(); detailIframeRef.current = null; };
          bar.append(titleEl, closeBtn);

          // Build the inline detail panel (used immediately for CSP-blocked
          // hosts, and as a fallback when an unknown host's iframe fails).
          const makeDetailPanel = (reason) => {
            const notice = document.createElement('div');
            notice.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center;overflow:auto;';
            const msg = document.createElement('div');
            msg.textContent = reason || `此页面禁止被嵌入（CSP frame-ancestors 限制），无法在客户端内直接显示。详情地址：${url}`;
            msg.style.cssText = 'font-size:14px;color:#555;max-width:440px;line-height:1.6;word-break:break-all;';
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '复制 URL';
            copyBtn.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;cursor:pointer;font-size:13px;';
            copyBtn.onclick = () => {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(
                  () => { copyBtn.textContent = '已复制 ✓'; copyBtn.style.background = '#e8f5e9'; },
                  () => {}
                );
              }
            };
            const openBtn = document.createElement('button');
            openBtn.textContent = '在浏览器中打开';
            openBtn.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;cursor:pointer;font-size:13px;';
            openBtn.onclick = () => window.open(url, '_blank', 'noopener,noreferrer');
            notice.append(msg, copyBtn, openBtn);
            return notice;
          };

          // Always-visible URL strip with copy/open actions. Some hosts frame
          // the page successfully, others (skills.sh, clawhub.ai, ...) reject
          // framing and render as an empty blocked frame; because a blocked
          // frame fires no cross-origin error event, the strip is what keeps
          // those cases usable instead of showing a blank panel.
          const makeUrlStrip = () => {
            const strip = document.createElement('div');
            strip.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #eaeef2;background:#fafbfc;flex:0 0 auto;';
            const urlText = document.createElement('span');
            urlText.textContent = url;
            urlText.title = url;
            urlText.style.cssText = 'flex:1;min-width:0;font-size:11px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const stripCopy = document.createElement('button');
            stripCopy.textContent = '复制 URL';
            stripCopy.style.cssText = 'flex:0 0 auto;padding:4px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:12px;';
            stripCopy.onclick = () => {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(
                  () => { stripCopy.textContent = '已复制 ✓'; },
                  () => {}
                );
              }
            };
            const stripOpen = document.createElement('button');
            stripOpen.textContent = '在浏览器中打开';
            stripOpen.style.cssText = 'flex:0 0 auto;padding:4px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:12px;';
            stripOpen.onclick = () => window.open(url, '_blank', 'noopener,noreferrer');
            strip.append(urlText, stripCopy, stripOpen);
            return strip;
          };

          if (cspBlocked) {
            // Not embeddable: show the detail panel with copy/open actions.
            overlay.append(bar, makeDetailPanel(blockReason
              ? `此页面禁止被嵌入（${blockReason}），无法在客户端内直接显示。详情地址：${url}`
              : undefined));
          } else {
            // Unknown host: try the iframe, but never leave the user without
            // an escape hatch when the site refuses to be framed.
            const frame = document.createElement('iframe');
            frame.src = url;
            frame.style.cssText = 'flex:1;width:100%;border:0;';
            frame.title = name;
            frame.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';
            let settled = false;
            frame.onerror = () => {
              if (settled) return;
              settled = true;
              frame.remove();
              overlay.appendChild(makeDetailPanel());
            };
            overlay.append(bar, makeUrlStrip(), frame);
          }
          host.style.position = host.style.position || 'relative';
          host.appendChild(overlay);
          detailIframeRef.current = overlay;
          console.info('[dsh-skill-mcp-market] inline iframe overlay attached');
          return;
        }

        // No host element found: show an inline notice in the panel body.
        const panel = document.querySelector('[data-dsh-market-panel]');
        if (panel) {
          const note = document.createElement('div');
          note.style.cssText = 'padding:24px;text-align:center;font-size:13px;color:#888;';
          note.textContent = `无法在客户端内打开详情面板。URL: ${url}`;
          panel.prepend(note);
          setTimeout(() => note.remove(), 6000);
        }
      };


      const doInstallSkill = async (item) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('skills.install', {
            source: item.source,
            reference:
              item.source === 'skills.sh'
                ? item.homepage
                : item.source === 'clawhub'
                  ? item.installRef
                  : item.source === 'lobehub-agent'
                    ? item.slug
                    : item.source === 'browse.sh'
                      ? item.reference
                      : item.upstreamUrl || item.id,
            skillDir: item.skillDir || '',
            ref: item.ref || '',
            name: item.slug,
          });
          setNotice(`已安装 ${d.slug} → ${d.dir}（${d.files} 个文件，已生效）`);
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const doInstallMcp = async (item, envValues) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('mcp.install', { slug: item.slug, envValues: envValues || {} });
          const r = (d.results || [])[0] || {};
          if (r.missing && r.missing.length) {
            setEnvPrompt({ slug: item.slug, missing: r.missing });
            setEnvDraft({});
            setNotice(`该连接器需要 ${r.missing.join(', ')}；填好后会写入系统环境变量并立即连接`);
          } else if (r.ok) {
            setEnvPrompt(null);
            setNotice(`已连接 ${r.serverName}，新增 ${r.toolCount} 个工具${(r.envWritten || []).length ? `（已写入环境变量 ${r.envWritten.join(', ')}）` : ''}`);
          } else {
            setNotice(`已保存 ${r.serverName}，但未连上：${r.error || ''}`);
          }
          await loadInstalled();
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const toggleSkill = async (slug, enabled) => {
        setBusy(`toggle:${slug}`);
        setError('');
        try {
          const d = await call('skills.toggle', { slug, enabled });
          setNotice(`${enabled ? '已启用' : '已停用'} ${slug}（写入 disabledSkills，即时生效）`);
          await loadSettings();
          setSettings((prev) => (prev ? { ...prev, settings: { ...prev.settings } } : prev));
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const toggleMcp = async (name, enabled) => {
        setBusy(`toggle:${name}`);
        setError('');
        try {
          await call('mcp.toggle', { serverName: name, enabled });
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const removeSkill = async (slug) => {
        setBusy(`remove:${slug}`);
        try {
          await call('skills.uninstall', { slug });
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const savePaths = async () => {
        setBusy('settings.set');
        setError('');
        try {
          const d = await call('settings.set', {
            skillDirs: skillDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
            mcpDirs: mcpDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          });
          setNotice(`路径已更新（技能 ${d.skillDirs.length} 个 / MCP ${d.mcpDirs.length} 个），已即时重挂`);
          await loadSettings();
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const orderedSkills = skills.slice().sort((a, b) => {
        if (sort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        if (b.installable !== a.installable) return (b.installable === false ? 0 : 1) - (a.installable === false ? 0 : 1);
        return (b.installs || 0) - (a.installs || 0);
      });
      const categories = [...new Set(skills.map((item) => item.category).filter(Boolean))].slice(0, 10);
      const visibleSkills = orderedSkills.filter((item) => category === 'all' || item.category === category);
      const skillCards = visibleSkills.map((item) =>
        h('div', { key: item.id, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.sourceLabel || item.source),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installs ? h('span', null, `· ${item.installs.toLocaleString()} 次安装`) : null,
            item.describedBy === 'page-meta' ? null : null,
            item.installable === false ? h('span', null, '· 仅可浏览') : null),
          h('div', { style: S.row },
            item.installable === false ? null : h('button', {
              style: S.btn(),
              disabled: busy === `preview:${item.slug}`,
              onClick: () => openPreview(item),
            }, busy === `preview:${item.slug}` ? '下载中…' : '预览'),
            detailUrlFor(item) ? h('button', {
              style: { ...S.btn(), padding: '0 6px' },
              title: '在 DSH 客户端内查看详情',
              onClick: () => openDetail(item),
            }, '详情') : null,
            installed.some((x) => x.slug === item.slug)
              ? h('span', { style: S.status }, '✓ 已安装')
              : item.installable === false
                ? h('span', { style: S.status }, item.note || '该条目没有可用的下载源')
                : h('button', {
                  style: S.btn('primary'),
                  disabled: busy === `install:${item.slug}` || item.installable === false,
                  onClick: () => doInstallSkill(item),
                }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const orderedMcps = mcps.slice().sort((a, b) => {
        if (mcpSort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        if (mcpSort === 'installCount') return (b.installs || 0) - (a.installs || 0);
        if (mcpSort === 'ratingAverage') return (b.rating || 0) - (a.rating || 0);
        return 0;
      });
      const mcpCards = orderedMcps.map((item) =>
        h('div', { key: item.id || item.slug, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.transport || 'stdio'),
            h('span', null, `· ${item.sourceLabel || (item.source === 'lobehub' ? 'LobeHub' : 'MCP 官方注册表')}`),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installs ? h('span', null, `· ${Number(item.installs).toLocaleString()} 次安装`) : null,
            (item.envRequired || []).length ? h('span', null, `· 需要 ${item.envRequired.join(', ')}`) : null),
          // "name" is the registry identifier users may need to copy into a manual install.
          h('div', { style: S.meta }, h('span', null, item.slug)),
          item.note ? h('div', { style: S.status }, item.note) : null,
          h('div', { style: S.row },
            h('button', {
              style: S.btn('primary'),
              disabled: item.installable === false || busy === `install:${item.slug}`,
              onClick: () => doInstallMcp(item),
            }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const CATEGORY_LABELS = {
        developer: '开发者',
        'developer-tools': '开发者工具',
        development: '开发',
        'data-analytics': '数据分析',
        database: '数据库',
        search: '搜索',
        'web-search': '网页搜索',
        'media-generate': '媒体生成',
        productivity: '效率办公',
        business: '商业服务',
        finance: '金融',
        tools: '实用工具',
        utility: '实用工具',
        'travel-transport': '出行交通',
        social: '社交',
        communication: '通信',
        cloud: '云服务',
        security: '安全',
        education: '教育',
        'education-science': '教育科研',
        'gaming-entertainment': '游戏娱乐',
        'health-wellness': '健康',
        healthcare: '医疗',
        news: '新闻',
        research: '研究',
        'real-estate': '房产',
        shopping: '购物',
        services: '服务',
        hardware: '硬件',
        networking: '网络',
        government: '政务',
        legal: '法律',
        industrial: '工业',
        robotics: '机器人',
        lifestyle: '生活',
        entertainment: '娱乐',
        blockchain: '区块链',
        'home-automation': '智能家居',
        'jobs-search': '招聘',
        science: '科学',
      };
      const categoryLabel = (code) => CATEGORY_LABELS[code] || code;
      const disabledSet = new Set(((settings && settings.settings && settings.settings.disabledSkills) || []).map((x) => String(x).toLowerCase()));
      const filterText = installedFilter.trim().toLowerCase();
      const filteredInstalled = filterText
        ? installed.filter((i) => (i.name || i.slug || '').toLowerCase().includes(filterText) || (i.description || '').toLowerCase().includes(filterText))
        : installed;
      const filteredMounted = filterText
        ? mounted.filter((i) => (i.title || i.serverName || '').toLowerCase().includes(filterText) || (i.description || '').toLowerCase().includes(filterText))
        : mounted;
      const installedSkills = filteredInstalled.map((item) => {
        const off = disabledSet.has(String(item.slug).toLowerCase());
        return h('div', { key: `i-${item.dir}-${item.slug}`, style: S.card },
          h('div', { style: S.title }, `${item.name || item.slug}${off ? '（已停用）' : ''}`),
          h('div', { style: S.meta }, h('span', null, item.dir)),
          h('div', { style: S.row },
            h('button', {
              style: S.btn(off ? 'primary' : undefined),
              disabled: busy === `toggle:${item.slug}`,
              onClick: () => toggleSkill(item.slug, off),
            }, off ? '启用' : '停用'),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:skill:${item.slug}`,
              onClick: async () => {
                setBusy(`openDir:skill:${item.slug}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'skill', slug: item.slug });
                  setNotice(`已在资源管理器中定位到技能文件夹：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('button', { style: S.btn(), disabled: busy === `remove:${item.slug}`, onClick: () => removeSkill(item.slug) }, '卸载')));
      });

      const installedMcps = filteredMounted.map((item) =>
        h('div', { key: `m-${item.serverName}`, style: S.card },
          h('div', { style: S.title }, item.title || item.serverName),
          h('div', { style: S.meta },
            h('span', null, item.transport),
            h('span', null, item.mounted ? '· 已连接' : '· 未连接'),
            h('span', null, item.tools && item.tools.length ? `· ${item.tools.length} 个工具` : '')),
          h('div', { style: S.row },
            h('button', { style: S.btn(), disabled: busy === `toggle:${item.serverName}`, onClick: () => toggleMcp(item.serverName, !item.enabled) }, item.enabled ? '停用' : '启用'),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:mcp:${item.serverName}`,
              onClick: async () => {
                setBusy(`openDir:mcp:${item.serverName}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'mcp-item', serverName: item.serverName });
                  setNotice(`已在资源管理器中定位到 MCP 定义：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('button', {
              style: S.btn(),
              disabled: busy === `remove:${item.serverName}`,
              onClick: async () => {
                setBusy(`remove:${item.serverName}`);
                setError('');
                try {
                  await call('mcp.uninstall', { serverName: item.serverName });
                  setNotice(`已卸载 ${item.serverName}`);
                  await loadInstalled();
                } catch (e) {
                  setError(String(e.message || e));
                } finally {
                  setBusy('');
                }
              },
            }, '卸载'))));

      return h('div', { style: S.page, 'data-dsh-market-root': '' },
        h('div', { style: S.panel },
          h('div', { style: S.head },
            h('button', { style: S.tab(tab === 'skills'), onClick: () => setTab('skills') }, 'SKILL 技能'),
            h('button', { style: S.tab(tab === 'mcp'), onClick: () => setTab('mcp') }, 'MCP 连接器'),
            h('button', { style: S.tab(false), onClick: () => setTab('installed') }, '已安装'),
            h('button', { style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '路径'),
            h('div', { style: { flex: 1 } }),
            h('span', { style: S.status }, busy ? `处理中：${busy}` : '')),
          h('div', { style: S.body },
            (tab === 'skills' || tab === 'mcp')
              ? h('div', { style: S.row },
                  h('input', {
                    style: S.input,
                    placeholder: tab === 'skills' ? '搜索技能，回车查询' : '搜索 MCP 连接器',
                    value: query,
                    onChange: (e) => setQuery(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') (tab === 'skills' ? searchSkills : searchMcps)(query);
                    },
                  }),
                  h('button', {
                    style: S.btn(),
                    onClick: () => (tab === 'skills' ? searchSkills : searchMcps)(query),
                  }, '搜索'))
              : null,
            (tab === 'skills' || tab === 'mcp')
              ? h('div', { style: S.row },
                  tab === 'skills'
                    ? ['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'browse.sh', 'lobehub-agent', 'skillhub'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(source === key),
                          onClick: () => {
                            setSource(key);
                            setCategory('all');
                            searchSkills(query, { source: key, size });
                          },
                        }, key === 'all' ? '全部来源' : key))
                    : ['registry', 'lobehub'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(mcpSource === key),
                          onClick: () => {
                            setMcpSource(key);
                            setMcpCategory('all');
                            setMcpSort('default');
                            setMcpPage(1);
                            searchMcps(query, { source: key, category: 'all', sort: 'default', page: 1 });
                          },
                        }, key === 'registry' ? 'MCP 官方注册表' : 'LobeHub')),
                  h('div', { style: { flex: 1 } }),
                  tab === 'mcp'
                    ? h('select', {
                        style: { ...S.input, flex: '0 0 132px', height: 30 },
                        value: mcpSort,
                        onChange: (e) => {
                          const next = e.target.value;
                          setMcpSort(next);
                          setMcpPage(1);
                          searchMcps(query, { sort: next, page: 1 });
                        },
                      },
                        h('option', { value: 'default' }, '默认顺序'),
                        mcpSource === 'lobehub'
                          ? h('option', { value: 'installCount' }, '安装最多')
                          : h('option', { value: 'name' }, '按名称'),
                        mcpSource === 'lobehub' ? h('option', { value: 'ratingAverage' }, '评分最高') : null)
                    : h('select', {
                        style: { ...S.input, flex: '0 0 120px', height: 30 },
                        value: sort,
                        onChange: (e) => setSort(e.target.value),
                      },
                        h('option', { value: 'default' }, '默认顺序'),
                        h('option', { value: 'name' }, '按名称')),
)
              : null,
            tab === 'mcp' && mcpSource === 'lobehub' && mcpCategories.length > 0
              ? h('div', { style: S.row },
                  ['all', ...mcpCategories.slice(0, 12)].map((cat) =>
                    h('button', {
                      key: cat,
                      style: S.chip(mcpCategory === cat),
                      onClick: () => {
                        setMcpCategory(cat);
                        setMcpPage(1);
                        searchMcps(query, { category: cat, page: 1 });
                      },
                    }, cat === 'all' ? '全部分类' : categoryLabel(cat))))
              : null,
            tab === 'skills' && categories.length > 0
              ? h('div', { style: S.row },
                  ['all', ...categories].map((cat) =>
                    h('button', {
                      key: cat,
                      style: S.chip(category === cat),
                      onClick: () => setCategory(cat),
                    }, cat === 'all' ? '全部分类' : cat)))
              : null,
            tab === 'mcp' && (mcpTotal > 0 || mcps.length > 0)
              ? h('div', { style: S.status },
                  mcpSource === 'lobehub'
                    ? `LobeHub · 共 ${mcpTotal.toLocaleString()} 个连接器 · 第 ${mcpPage}/${mcpTotalPages} 页`
                    : (mcpTotalPages > 0
                        ? `MCP 官方注册表 · 第 ${mcpPage}/${mcpTotalPages} 页`
                        : `MCP 官方注册表 · 已显示 ${mcps.length} 个${mcpHasMore ? '（可继续加载）' : ''}`))
              : null,
            error ? h('div', { style: S.err }, error) : null,
            notice ? h('div', { style: S.status }, notice) : null,
            envPrompt
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `${envPrompt.slug} 需要环境变量`),
                  envPrompt.missing.map((name) =>
                    h('div', { key: name, style: S.row },
                      h('span', { style: { width: 220, fontSize: 12, opacity: 0.8 } }, name),
                      h('input', {
                        style: S.input,
                        type: 'password',
                        placeholder: `填写 ${name}`,
                        value: envDraft[name] || '',
                        onChange: (e) => setEnvDraft({ ...envDraft, [name]: e.target.value }),
                      }))),
                  h('div', { style: S.status }, '保存后会写入 Windows 用户环境变量（对新进程持久生效），并立即连接。'),
                  h('div', { style: S.row },
                    h('button', {
                      style: S.btn('primary'),
                      disabled: busy === `install:${envPrompt.slug}`,
                      onClick: () => doInstallMcp({ slug: envPrompt.slug }, envDraft),
                    }, '写入并连接'),
                    h('button', { style: S.btn(), onClick: () => setEnvPrompt(null) }, '取消')))
              : null,
            detail
              ? h('div', {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(15, 23, 42, 0.45)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    padding: '40px 16px',
                    overflowY: 'auto',
                    zIndex: 1000,
                  },
                },
                  h('div', {
                    style: {
                      width: '100%',
                      maxWidth: 560,
                      background: 'var(--dsh-card, #fff)',
                      borderRadius: 12,
                      padding: 20,
                      boxShadow: '0 16px 48px rgba(15, 23, 42, 0.28)',
                    },
                  },
                    h('div', { style: { ...S.title, fontSize: 14 } }, `${detail.kind === 'skill' ? '技能' : 'MCP'}：${detail.slug}`),
                    detail.kind === 'skill'
                      ? h('div', { style: { marginTop: 12 } },
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '描述'),
                            h('input', {
                              style: S.input,
                              placeholder: '留空则不修改',
                              value: draft.description || '',
                              onChange: (e) => setDraft({ ...draft, description: e.target.value }),
                            })),
                          h('textarea', {
                            style: { ...S.input, height: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 10 },
                            value: draft.body || '',
                            onChange: (e) => setDraft({ ...draft, body: e.target.value }),
                          }))
                      : h('div', { style: { marginTop: 12 } },
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '命令'),
                            h('input', { style: S.input, value: draft.command || '', onChange: (e) => setDraft({ ...draft, command: e.target.value }) })),
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, 'URL'),
                            h('input', { style: S.input, value: draft.url || '', onChange: (e) => setDraft({ ...draft, url: e.target.value }) })),
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '参数'),
                            h('textarea', {
                              style: { ...S.input, height: 60, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                              value: draft.args || '',
                              onChange: (e) => setDraft({ ...draft, args: e.target.value }),
                            })),
                          h('pre', { style: { fontSize: 11, opacity: 0.8, whiteSpace: 'pre-wrap', margin: '10px 0 0', background: 'rgba(15, 23, 42, 0.04)', padding: 8, borderRadius: 6 } },
                            JSON.stringify({ transport: detail.data.transport, env: detail.data.env, headers: detail.data.headers }, null, 2))),
                    h('div', { style: { ...S.meta, marginTop: 10 } }, h('span', null, detail.data.path || '')),
                    h('div', { style: { ...S.row, marginTop: 14, justifyContent: 'flex-end', gap: 8 } },
                      h('button', { style: S.btn(), onClick: () => setDetail(null) }, '关闭'),
                      detail.kind === 'skill'
                        ? h('button', { style: S.btn('primary'), disabled: busy === 'save:skill', onClick: saveSkillEdit }, '保存')
                        : h('button', { style: S.btn('primary'), disabled: busy === 'save:mcp', onClick: saveMcpEdit }, '保存并重连'))))
              : null,
            preview
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `预览：${preview.name}（${preview.files} 个文件，未安装）`),
                  preview.previewError
                    ? h('div', { style: { ...S.status, color: '#b26a00' } }, `在线预览不可用：${preview.previewError}`)
                    : null,
                  h('pre', { style: { fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', margin: 0 } }, preview.content || (preview.previewError ? '' : '(没有正文)')),
                  h('div', { style: S.row },
                    h('button', { style: S.btn(), onClick: () => setPreview(null) }, '关闭预览'),
                    preview.openUrl ? h('button', {
                      style: { ...S.btn('primary'), padding: '0 8px' },
                      title: `在 DSH 客户端内查看详情 ${preview.openUrl}`,
                      onClick: () => { openDetail({ homepage: preview.openUrl }); setPreview(null); },
                    }, '在 DSH 客户端内查看详情') : null))
              : null,
            tab === 'skills' ? h('div', { style: S.grid }, skillCards) : null,
            tab === 'mcp' ? h('div', { style: S.grid }, mcpCards) : null,
            // 分页导航：上一页/下一页 + 页码（省略号折叠）+ 每页条数选择器，两个 Tab 统一。
            (tab === 'skills' || tab === 'mcp')
              ? h('div', { style: S.row },
                  h('div', { style: S.row },
                    h('select', {
                      style: { ...S.input, flex: '0 0 96px', height: 28 },
                      value: String(size),
                      onChange: (e) => {
                        const nextSize = Number(e.target.value) || 24;
                        setSize(nextSize);
                        if (tab === 'skills') searchSkills(query, { source, size: nextSize, page: 1 });
                        else searchMcps(query, { page: 1, size: nextSize });
                      },
                    }, [12, 24, 48].map((n) =>
                      h('option', { key: n, value: String(n) }, `每页 ${n}`))),
                  h('div', { style: S.row },
                    pager(
                      tab === 'skills' ? skillsPage : mcpPage,
                      tab === 'skills' ? skillsTotalPages : mcpTotalPages,
                      tab === 'skills' ? skillsHasMore : mcpHasMore,
                      tab === 'skills' ? '共约' : (mcpSource === 'lobehub' ? '共约' : '')))))
              : null,
            tab === 'installed' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, flex: 1, width: '100%', alignItems: 'stretch' } },
              // 上传技能：拖拽文件夹或点按钮选文件夹。宿主 @deepseek-ai 包没有 showOpenDialog
              // 暴露给插件，面板是 web 页面，用 <input type=file webkitdirectory>（Chromium
              // 弹原生文件夹对话框，效果与 workbuddy 相同）。拖拽事件里 dataTransfer.files
              // 是扁平文件列表，没有 webkitRelativePath，用首个文件的 name 前缀推断根目录。
              h('div', {
                style: {
                  ...S.row,
                  border: '1px dashed var(--dsh-border, #d0d7de)',
                  borderRadius: 8,
                  padding: '12px 16px',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                },
              },
                h('div', { style: { fontSize: 12, opacity: 0.7 } }, '把技能文件夹拖到这里，或'),
                h('button', {
                  style: S.btn('primary'),
                  disabled: busy === 'upload',
                  onClick: async () => {
                    setBusy('upload');
                    setError('');
                    setNotice('');
                    try {
                      const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.webkitdirectory = true;
                      input.multiple = true;
                      input.style.display = 'none';
                      document.body.appendChild(input);
                      const picked = await new Promise((resolve) => {
                        input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
                        input.click();
                      });
                      document.body.removeChild(input);
                      if (!picked.length) return;
                      const files = [];
                      for (const f of picked) {
                        const rel = (f.webkitRelativePath || f.name).split('/').join('/');
                        const parts = rel.split('/');
                        if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
                        const text = await f.text();
                        files.push({ path: rel, content: text });
                      }
                      const result = await call('skills.upload', { files, force: false });
                      const n = result.count || (result.items || []).length;
                      setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
                      await loadInstalled();
                    } catch (e) {
                      setError(`上传失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '浏览文件夹'),
                h('div', {
                  style: {
                    flex: 1,
                    minHeight: 40,
                    border: '2px dashed var(--dsh-border, #d0d7de)',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--dsh-text-secondary, #6a737d)',
                    fontSize: 12,
                    opacity: 0.7,
                  },
                  onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); },
                  onDrop: async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    setBusy('upload'); setError(''); setNotice('');
                    try {
                      const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
                      const items = e.dataTransfer ? Array.from(e.dataTransfer.items || []) : [];
                      const droppedFiles = [];
                      // 优先走 DataTransferItem.webkitGetAsEntry() 递归读取 FileEntry，
                      // 能拿到真实的目录层级；读不到的文件回退到 e.dataTransfer.files。
                      const readEntry = async (entry, prefix, out) => {
                        if (entry.isFile) {
                          const file = await new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
                          if (file) out.push({ file, path: prefix + file.name });
                        } else if (entry.isDirectory) {
                          const reader = entry.createReader();
                          const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
                          let batch = await readBatch();
                          while (batch.length) {
                            for (const child of batch) await readEntry(child, prefix + entry.name + '/', out);
                            batch = await readBatch();
                          }
                        }
                      };
                      const entryResults = [];
                      for (const item of items) {
                        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
                        if (entry) entryResults.push(entry);
                      }
                      if (entryResults.length) {
                        for (const entry of entryResults) await readEntry(entry, '', droppedFiles);
                      }
                      if (!droppedFiles.length) {
                        for (const f of Array.from(e.dataTransfer.files || [])) droppedFiles.push({ file: f, path: f.name });
                      }
                      if (!droppedFiles.length) return;
                      // 推断根目录前缀：所有 path 的公共第一段（拖入的是文件夹时形如 "agnes/SKILL.md"）。
                      const firstSeg = droppedFiles.map(({ path }) => path.split('/').filter(Boolean)[0] || '').filter(Boolean);
                      const rootPrefix = firstSeg.length && firstSeg.every((s) => s === firstSeg[0]) ? firstSeg[0] + '/' : '';
                      const files = [];
                      for (const { file, path } of droppedFiles) {
                        const rel = path.startsWith(rootPrefix) ? path : rootPrefix + path;
                        const parts = rel.split('/');
                        if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
                        const text = await file.text();
                        files.push({ path: rel, content: text });
                      }
                      const result = await call('skills.upload', { files, force: false });
                      const n = result.count || (result.items || []).length;
                      setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
                      await loadInstalled();
                    } catch (err) {
                      setError(`上传失败：${err.message || err}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '或拖拽技能文件夹到这里（根目录或一级子目录必须含 SKILL.md）'),
              filterText
                ? h('div', { style: S.row },
                    h('input', {
                      style: { ...S.input, flex: 1 },
                      placeholder: '搜索已安装的技能 / MCP（名称、描述）',
                      value: installedFilter,
                      onChange: (e) => setInstalledFilter(e.target.value),
                    }),
                    h('button', { style: S.btn(), onClick: () => setInstalledFilter('') }, '清除'))
                : null,
              h('div', { style: { ...S.title, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装技能（${filteredInstalled.length}）`,
                nativeDirs.length > 0
                  ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `含 DSH 内置 ${nativeDirs.length} 个目录`)
                  : null,
                h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  disabled: busy === 'openDir:skills',
                  onClick: async () => {
                    setBusy('openDir:skills');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'skills' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录'),
                h('span', { style: { ...S.status, fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `（可在资源管理器中直接查看 / 编辑技能文件）`)),
              h('div', { style: S.grid }, installedSkills),
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装 MCP（${filteredMounted.length}）`,
                h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  disabled: busy === 'openDir:mcp',
                  onClick: async () => {
                    setBusy('openDir:mcp');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'mcp' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录')),
              h('div', { style: S.grid }, installedMcps),
            )) : null,
            tab === 'settings' && settings
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  h('div', { style: S.status }, '每行一个目录；技能列表的第一个目录是安装目标。保存后立即重挂，无需重启。'),
                  setPathRow('技能目录', skillDraft, setSkillDraft),
                  setPathRow('MCP 目录', mcpDraft, setMcpDraft),
                  h('div', { style: S.row },
                    h('button', { style: S.btn('primary'), disabled: busy === 'settings.set', onClick: savePaths }, '保存路径'),
                    h('span', { style: S.status }, `配置文件：${settings.settings.settingsPath}`)),
                  h('div', { style: S.status },
                    `技能 provider：${settings.skillProvider && settings.skillProvider.mounted ? '已挂载' : '未挂载'}`),
                  h('div', { style: S.status }, `MCP 客户端：${settings.shipped && settings.shipped.mcpClient}`))
              : null)));
    }

    /**
     * Composer toolbar entry: two 28px buttons ("技能" / "MCP") on the left of the
     * composer input row. Each opens a popover listing installed items (via the host
     * RPC) with a "go to market" footer that activates the dsh-market panel.
     * Picking an item inserts a prompt snippet into the draft (does NOT submit).
     */
    function ComposerButtons(props) {
      const inputActions = props.inputActions;
      const draft = props.useInput ? props.useInput((state) => state.draft) : '';
      const [open, setOpen] = useState(null); // 'skill' | 'mcp' | null
      const [skills, setSkills] = useState(null);
      const [mcps, setMcps] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const rootRef = useRef(null);
      const timers = useRef([]);

      const later = (fn, ms) => { const id = setTimeout(() => { timers.current = timers.current.filter((pending) => pending !== id); fn(); }, ms); timers.current.push(id); return id; };
      useEffect(() => () => { for (const id of timers.current) clearTimeout(id); timers.current = []; }, []);

      // Popover dismissal: outside click or Escape (quick-resume pattern).
      useEffect(() => {
        if (!open) return undefined;
        if (rootRef.current) rootRef.current.scrollTop = 0;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
          setOpen(null);
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(null); };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('mousedown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown); };
      }, [open]);

      const load = async (kind) => {
        if (kind === 'skill') {
          if (skills !== null) { setOpen(open === 'skill' ? null : 'skill'); return; }
        } else {
          if (mcps !== null) { setOpen(open === 'mcp' ? null : 'mcp'); return; }
        }
        setOpen(kind);
        setLoading(true);
        setError('');
        try {
          if (kind === 'skill') {
            const data = await call('skills.list');
            setSkills((data.items || []).map((item) => ({
              slug: item.slug,
              name: item.name || item.slug,
              description: item.description || '',
            })));
          } else {
            const data = await call('mcp.list');
            setMcps((data.items || []).map((item) => ({
              serverName: item.serverName,
              title: item.title || item.serverName,
              transport: item.transport || 'stdio',
              mounted: item.mounted === true,
              tools: item.tools || [],
            })));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
          setOpen(null);
        } finally {
          setLoading(false);
        }
      };

      /** Insert a snippet into the draft (append a new line when draft is non-empty). Never submits. */
      const insertSnippet = (text) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return;
        const current = String(draft || '').trim();
        inputActions.setDraft(current === '' ? text : `${draft}\n${text}`);
        setOpen(null);
      };

      const skillItemText = (item) => {
        const desc = item.description ? `（${item.description.slice(0, 80)}）` : '';
        return `使用技能 /${item.slug}${desc}。请加载并按需使用它。`;
      };
      const mcpItemText = (item) => {
        const tools = item.tools && item.tools.length > 0 ? `，可用工具：${item.tools.slice(0, 8).join('、')}${item.tools.length > 8 ? ' 等' : ''}` : '';
        const state = item.mounted ? '已挂载' : '未挂载（可先调用 mcp_market_set_enabled 启用）';
        return `使用 MCP 连接器 ${item.serverName}（${item.transport}，${state}${tools}）。需要时直接调用它的工具。`;
      };

      const marketPanel = () => {
        try {
          if (typeof props.openMarketPanel === 'function') props.openMarketPanel();
        } catch { /* layout service unavailable; ignore */ }
        setOpen(null);
      };

      const btnStyle = (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 28,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid ' + (active ? 'var(--dsh-border-strong, #9aa4b2)' : 'var(--dsh-border, #d0d7de)'),
        background: active ? 'var(--dsh-surface-raised, #eef1f5)' : 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-secondary, #57606a)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        userSelect: 'none',
      });

      const popStyle = {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 60,
        width: 360,
        maxHeight: 420,
        overflow: 'auto',
        border: '1px solid var(--dsh-border, #d0d7de)',
        borderRadius: 10,
        background: 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-primary, #1f2328)',
        boxShadow: '0 10px 30px rgba(0,0,0,.18)',
        padding: 10,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      };
      const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' };
      const rowHover = { background: 'var(--dsh-surface-hover, #f0f3f6)' };

      const renderList = (kind, items, textOf, emptyText) => {
        if (loading) return h('div', { style: { ...S.status, padding: 8 } }, '加载中…');
        if (error && items === null) return h('div', { style: { ...S.status, padding: 8 } }, `加载失败：${error}`);
        if (!items || items.length === 0) return h('div', { style: { ...S.status, padding: 8 } }, emptyText);
        return items.map((item) => {
          const key = kind === 'skill' ? item.slug : item.serverName;
          const title = kind === 'skill' ? item.name : item.title;
          const sub = kind === 'skill' ? (item.description || '').slice(0, 60) : `${item.transport} · ${item.mounted ? '已挂载' : '未挂载'} · ${item.tools.length} 工具`;
          return h('div', {
            key,
            style: rowStyle,
            onMouseEnter: (e) => { e.currentTarget.style.background = rowHover.background; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
            onClick: () => insertSnippet(textOf(item)),
            title: textOf(item),
          },
            h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            h('div', { style: { ...S.status, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub));
        });
      };

      return h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, order: 1 } },
        h('button', {
          type: 'button',
          style: btnStyle(open === 'skill'),
          'aria-label': '技能',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('skill'),
        }, h('span', { style: { fontSize: 13 } }, '⚡'), '技能'),
        h('button', {
          type: 'button',
          style: btnStyle(open === 'mcp'),
          'aria-label': 'MCP',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('mcp'),
        }, h('span', { style: { fontSize: 13 } }, '⇄'), 'MCP'),
        open ? h('div', { ref: rootRef, style: popStyle, role: 'dialog' },
          h('div', { style: { ...S.status, fontSize: 11, padding: '0 8px 6px' } },
            open === 'skill' ? `已安装技能（${skills ? skills.length : '…'}）` : `已安装 MCP（${mcps ? mcps.length : '…'}）`),
          open === 'skill' ? renderList('skill', skills, skillItemText, '还没有已安装技能。点下方按钮去技能市场安装。')
            : renderList('mcp', mcps, mcpItemText, '还没有已安装 MCP 连接器。点下方按钮去 MCP 市场安装。'),
          h('div', { style: { borderTop: '1px solid var(--dsh-border, #eaeef2)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', style: { ...S.btn(), height: 26, fontSize: 12 }, onClick: marketPanel },
              open === 'skill' ? '去技能市场' : '去 MCP 市场'),
            h('span', { style: { ...S.status, fontSize: 11 } }, '点击条目把提示插入输入框（不会直接发送）'))) : null);
    }

    /** Icon shown by the left sidebar's panel list (the sidebar owns the button chrome). */
    function MarketIcon(props) {
      const size = props && props.size ? props.size : 18;
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.6 8.4h16.8l-1.3 10.1a2 2 0 0 1-2 1.7H6.9a2 2 0 0 1-2-1.7L3.6 8.4Z', ...stroke }),
        h('path', { d: 'M8.5 8.4V6.6a3.5 3.5 0 0 1 7 0v1.8', ...stroke }),
        h('path', { d: 'M12 12.2v3.4M10.3 13.9h3.4', ...stroke }));
    }

    return {
      inject: ['slots', 'layout', 'sidebarRight'],
      apply(ctx) {
        // Left sidebar entry: the sidebar renders the button and reads the label from here.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-market', order: 20, label: () => 'SKILL技能&MCP连接器' },
            MarketIcon,
          ));
        // Central panel addressed by that same sidebar id.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'dsh-market', inject: () => ({ sidebarRight: ctx.sidebarRight }) },
            Market,
          ));
        // Composer toolbar: 技能 / MCP quick buttons on the input row (left group).
        // inputActions + useInput are provided by the host to conversation.input.* entries;
        // openMarketPanel is our inject face, closing over ctx for the layout service.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-market-composer',
              order: 10,
              inject: () => ({
                openMarketPanel: () => {
                  try {
                    const layout = ctx.layout;
                    if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('dsh-market');
                  } catch { /* layout service unavailable; ignore */ }
                },
              }),
            },
            ComposerButtons,
          ));
      },
    };
  },
});
