// Client half of dsh-market: a floating market panel registered into `shell.overlay`.
// No build step; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: '@local/dsh-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const RPC = '/api/dsh-market/rpc';

    async function call(op, payload) {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload || {}) }),
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
      wrap: {
        position: 'fixed',
        right: 20,
        bottom: 96,
        zIndex: 60,
        pointerEvents: 'auto',
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
        position: 'fixed',
        right: 20,
        bottom: 148,
        width: 720,
        maxWidth: 'calc(100vw - 40px)',
        height: 520,
        maxHeight: 'calc(100vh - 200px)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-surface, #ffffff)',
        boxShadow: '0 18px 48px rgba(0,0,0,.22)',
        overflow: 'hidden',
        pointerEvents: 'auto',
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
      row: { display: 'flex', gap: 8, alignItems: 'center' },
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
      const [open, setOpen] = useState(false);
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

      const searchSkills = useCallback(async (text) => {
        setBusy('skills.search');
        setError('');
        try {
          const d = await call('skills.search', { query: text, source: 'all', pageSize: 24 });
          setSkills(d.items || []);
          if ((d.degraded || []).length) setNotice(`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`);
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
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => {
        if (!open) return;
        setError('');
        loadSettings().catch((e) => setError(String(e.message || e)));
        loadInstalled().catch((e) => setError(String(e.message || e)));
        if (tab === 'skills') searchSkills('');
        else searchMcps('');
      }, [open, tab, loadSettings, loadInstalled, searchSkills, searchMcps]);

      const doInstallSkill = async (item) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('skills.install', {
            source: item.source === 'curated' ? 'github' : item.source === 'skillhub' ? 'skillhub' : 'github',
            reference: item.source === 'curated' ? item.upstreamUrl : item.upstreamUrl || item.id,
            skillDir: item.skillDir || '',
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

      if (!open) {
        return h('div', { style: S.wrap },
          h('button', { style: S.launcher, onClick: () => setOpen(true), title: '技能市场与 MCP 连接器市场' }, '市场'));
      }

      const skillCards = skills.map((item) =>
        h('div', { key: item.id, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.sourceLabel || item.source),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installable === false ? h('span', null, '· 无可用下载地址') : null),
          h('div', { style: S.row },
            installed.some((x) => x.slug === item.slug)
              ? h('span', { style: S.status }, '✓ 已安装')
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
          h('div', { style: S.row },
            h('button', {
              style: S.btn('primary'),
              disabled: busy === `install:${item.slug}`,
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
            h('button', { style: S.btn(), disabled: busy === `toggle:${item.serverName}`, onClick: () => toggleMcp(item.serverName, !item.enabled) }, item.enabled ? '停用' : '启用'))));

      return h('div', { style: S.wrap },
        h('button', { style: S.launcher, onClick: () => setOpen(false) }, '收起市场'),
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
            tab === 'skills' ? skillCards : null,
            tab === 'mcp' ? mcpCards : null,
            tab === 'installed' ? h('div', null,
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

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-market.panel', order: 40 }, Market));
      },
    };
  },
});
