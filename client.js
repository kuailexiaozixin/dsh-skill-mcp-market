// Client half of dsh-skill-mcp-market: a floating market panel registered into `shell.overlay`.
// No build step; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-skill-mcp-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const RPC = '/api/dsh-market/rpc';

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
      body: { flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10, alignContent: 'start' },
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
        border: '1px solid var(--dsh-border, #eaeef2)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      title: { fontWeight: 700, fontSize: 13 },
      desc: { opacity: 0.75, fontSize: 12, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      meta: { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, opacity: 0.7 },
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

    function Market() {
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
      const [size, setSize] = useState(24);
      const [sort, setSort] = useState('default');
      const [importPath, setImportPath] = useState('');
      const [category, setCategory] = useState('all');
      const [preview, setPreview] = useState(null);

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
      }, []);

      const searchSkills = useCallback(async (text, options) => {
        setBusy('skills.search');
        setError('');
        try {
          const d = await call('skills.search', {
            query: text,
            source: (options && options.source) || 'all',
            pageSize: (options && options.size) || 24,
          });
          setSkills(d.items || []);
          if (!(d.items || []).length) {
            // An empty market is either "no match" or "upstream refused us"; say which.
            const reasons = (d.sourceErrors || []).length
              ? d.sourceErrors
              : (d.degraded || []).length
                ? [`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`]
                : ['没有找到匹配的技能。'];
            setNotice(reasons.join('；'));
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

      const searchMcps = useCallback(async (text) => {
        setBusy('mcp.search');
        setError('');
        try {
          const d = await call('mcp.search', { query: text });
          setMcps(d.items || []);
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
          setPreview({ slug: item.slug, name: d.name || item.slug, content: d.content || '', files: d.files });
        } catch (e) {
          setError(`预览失败：${e.message || e}`);
        } finally {
          setBusy('');
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
            item.installable === false ? h('span', null, '· 无可用下载地址') : null),
          h('div', { style: S.row },
            item.installable === false ? null : h('button', {
              style: S.btn(),
              disabled: busy === `preview:${item.slug}`,
              onClick: () => openPreview(item),
            }, busy === `preview:${item.slug}` ? '下载中…' : '预览'),
            installed.some((x) => x.slug === item.slug)
              ? h('span', { style: S.status }, '✓ 已安装')
              : item.installable === false
                ? h('span', { style: S.status }, '该条目没有可用的下载源')
                : h('button', {
                  style: S.btn('primary'),
                  disabled: busy === `install:${item.slug}` || item.installable === false,
                  onClick: () => doInstallSkill(item),
                }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const mcpCards = mcps.map((item) =>
        h('div', { key: item.id || item.slug, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.transport || 'stdio'),
            item.source ? h('span', null, `· ${item.source}`) : null,
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

      const disabledSet = new Set(((settings && settings.settings && settings.settings.disabledSkills) || []).map((x) => String(x).toLowerCase()));
      const installedSkills = installed.map((item) => {
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
            h('button', { style: S.btn(), disabled: busy === `detail:${item.slug}`, onClick: () => openSkillDetail(item.slug) }, '详情/编辑'),
            h('button', { style: S.btn(), disabled: busy === `remove:${item.slug}`, onClick: () => removeSkill(item.slug) }, '卸载')));
      });

      const installedMcps = mounted.map((item) =>
        h('div', { key: `m-${item.serverName}`, style: S.card },
          h('div', { style: S.title }, item.title || item.serverName),
          h('div', { style: S.meta },
            h('span', null, item.transport),
            h('span', null, item.mounted ? '· 已连接' : '· 未连接'),
            h('span', null, item.tools && item.tools.length ? `· ${item.tools.length} 个工具` : '')),
          h('div', { style: S.row },
            h('button', { style: S.btn(), disabled: busy === `toggle:${item.serverName}`, onClick: () => toggleMcp(item.serverName, !item.enabled) }, item.enabled ? '停用' : '启用'),
            h('button', { style: S.btn(), disabled: busy === `detail:${item.serverName}`, onClick: () => openMcpDetail(item.serverName) }, '详情/编辑'),
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

      return h('div', { style: S.page },
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
                    : h('span', { style: S.status }, '来源：MCP 官方注册表（实时）'),
                  h('div', { style: { flex: 1 } }),
                  h('select', {
                    style: { ...S.input, flex: '0 0 120px', height: 30 },
                    value: sort,
                    onChange: (e) => setSort(e.target.value),
                  },
                    h('option', { value: 'default' }, '默认顺序'),
                    h('option', { value: 'name' }, '按名称')),
                  h('button', {
                    style: S.btn(),
                    disabled: busy === 'skills.search' || busy === 'mcp.search',
                    onClick: () => {
                      const next = size + 24;
                      setSize(next);
                      (tab === 'skills' ? searchSkills : searchMcps)(query, { source, size: next });
                    },
                  }, '加载更多'))
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
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `${detail.kind === 'skill' ? '技能' : 'MCP'}：${detail.slug}`),
                  detail.kind === 'skill'
                    ? h('div', null,
                        h('div', { style: S.row },
                          h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '描述'),
                          h('input', {
                            style: S.input,
                            placeholder: '留空则不修改',
                            value: draft.description || '',
                            onChange: (e) => setDraft({ ...draft, description: e.target.value }),
                          })),
                        h('textarea', {
                          style: { ...S.input, height: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                          value: draft.body || '',
                          onChange: (e) => setDraft({ ...draft, body: e.target.value }),
                        }))
                    : h('div', null,
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
                        h('pre', { style: { fontSize: 11, opacity: 0.8, whiteSpace: 'pre-wrap', margin: 0 } },
                          JSON.stringify({ transport: detail.data.transport, env: detail.data.env, headers: detail.data.headers }, null, 2))),
                  h('div', { style: S.meta }, h('span', null, detail.data.path || '')),
                  h('div', { style: S.row },
                    detail.kind === 'skill'
                      ? h('button', { style: S.btn('primary'), disabled: busy === 'save:skill', onClick: saveSkillEdit }, '保存')
                      : h('button', { style: S.btn('primary'), disabled: busy === 'save:mcp', onClick: saveMcpEdit }, '保存并重连'),
                    h('button', { style: S.btn(), onClick: () => setDetail(null) }, '关闭')))
              : null,
            preview
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `预览：${preview.name}（${preview.files} 个文件，未安装）`),
                  h('pre', { style: { fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', margin: 0 } }, preview.content || '(没有正文)'),
                  h('div', { style: S.row }, h('button', { style: S.btn(), onClick: () => setPreview(null) }, '关闭预览')))
              : null,
            tab === 'skills' ? h('div', { style: S.grid }, skillCards) : null,
            tab === 'mcp' ? h('div', { style: S.grid }, mcpCards) : null,
            tab === 'installed' ? h('div', null,
              h('div', { style: S.row },
                h('input', {
                  style: S.input,
                  placeholder: '本地技能目录或 .zip 路径（会走同一套安全扫描）',
                  value: importPath,
                  onChange: (e) => setImportPath(e.target.value),
                }),
                h('button', {
                  style: S.btn('primary'),
                  disabled: busy === 'import' || !importPath.trim(),
                  onClick: async () => {
                    setBusy('import');
                    setError('');
                    setNotice('');
                    try {
                      const result = await call('skills.import', { path: importPath.trim(), force: false });
                      setNotice(`已导入 ${result.slug}（${result.files} 个文件，安全扫描通过）`);
                      setImportPath('');
                      await loadInstalled();
                    } catch (e) {
                      setError(`导入失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '导入')),
              h('div', { style: { ...S.title, marginBottom: 6 } }, `已装技能（${installed.length}）`),
              installedSkills,
              h('div', { style: { ...S.title, margin: '14px 0 6px' } }, `已装 MCP（${mounted.length}）`),
              installedMcps,
            ) : null,
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
      inject: ['slots'],
      apply(ctx) {
        // Left sidebar entry: the sidebar renders the button and reads the label from here.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-market', order: 20, label: () => 'SKILL技能&MCP连接器' },
            MarketIcon,
          ));
        // Central panel addressed by that same sidebar id.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-market' }, Market));
      },
    };
  },
});
