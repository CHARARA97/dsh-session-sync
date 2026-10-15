/**
 * dsh-chat-sync 浏览器端 bundle。
 *
 * 两个入口，同一套控件：
 *   - 设置 → 会话同步（settings.section）：完整页面形态；
 *   - 侧栏底部按钮（sidebar.footer.action）：打开 shell.overlay 里的浮层（可在设置里关掉）。
 *
 * 样式刻意对齐宿主自己的控件实现（dsh-client-ui-primitives 的
 * Button / SegmentedControl / Checkbox / Input / settings-form fields）：
 * 同一套 radius / elevation / focus-ring 令牌与尺寸，明暗主题都跟着宿主走。
 *
 * 特别注意：`--dsw-alias-brand-primary` 是**填充色**（暗色主题下接近白色 #f9fafb），
 * 它上面的文字必须用 `--dsw-alias-label-primary-foreground`，用 #fff 就是白底白字。
 */
window.__ModuleLoader__.load({
  id: '@charara97/dsh-session-sync',
  factory: (require) => {
    const React = require('react');
    const e = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const NS = 'dsh-chat-sync';
    const API = '/chat-sync/api/';

    async function jget(p) {
      const r = await fetch(API + p, { headers: { Accept: 'application/json' } });
      return r.json();
    }
    async function jpost(p, body) {
      const r = await fetch(API + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return r.json();
    }

    /* ================= 跨槽位共享状态 ================= */
    function makeStore(initial) {
      const s = {
        value: initial,
        listeners: new Set(),
        set(v) { s.value = v; for (const fn of s.listeners) { try { fn(v); } catch { /* ignore */ } } },
        subscribe(fn) { s.listeners.add(fn); return () => s.listeners.delete(fn); },
      };
      return s;
    }
    const overlay = makeStore(false);
    const sidebarPref = makeStore(true);

    function useStore(store) {
      const [v, setV] = useState(store.value);
      useEffect(() => store.subscribe(setV), [store]);
      return v;
    }

    /* ================= 样式（对齐宿主 primitives） ================= */
    const CSS = `
.dcs-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;
  color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dcs-root *{box-sizing:border-box}

.dcs-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dcs-h{font-size:15px;font-weight:600;line-height:1.4}

.dcs-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);padding:12px 14px}

.dcs-sec{display:flex;flex-direction:column;gap:6px}
.dcs-lab{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dcs-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dcs-warn{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dcs-err{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary)}
.dcs-ok{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-success-primary)}

/* Button：尺寸与变体照抄 primitives/Button.module.css，只换了类名前缀 */
.dcs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dcs-btn:disabled{cursor:not-allowed;opacity:.4}
.dcs-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dcs-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcs-btn-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dcs-btn-outline{border:0.5px solid var(--dsw-alias-border-l3)}
.dcs-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcs-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dcs-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
/* 宿主 Button 的 md 尺寸，用于页面里的主操作 */
.dcs-btn-md{height:36px;padding:0 14px;font-size:14px;line-height:22px;border-radius:var(--dsw-radius-md)}
.dcs-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dcs-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.dcs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcs-spread{flex:1;min-width:0}

/* SegmentedControl：轨道 + 指示块，照抄 primitives/SegmentedControl.module.css */
.dcs-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);width:fit-content;max-width:100%}
.dcs-seg-ind{position:absolute;top:4px;left:4px;height:calc(100% - 8px);
  width:calc((100% - 8px - 2px * (var(--dcs-n) - 1)) / var(--dcs-n));
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);
  box-shadow:var(--dsw-elevation-soft);pointer-events:none;
  transform:translateX(calc(var(--dcs-i) * (100% + 2px)));transition:transform 160ms ease}
.dcs-seg>button{position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;
  font-weight:500;white-space:nowrap;cursor:pointer;transition:color 120ms ease}
.dcs-seg>button:hover:not(:disabled),.dcs-seg>button[data-on="1"]{color:var(--dsw-alias-label-primary)}
.dcs-seg>button:disabled{cursor:default;opacity:.4}
.dcs-seg>button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
@media (prefers-reduced-motion: reduce){.dcs-seg-ind,.dcs-seg>button{transition:none}}

/* Checkbox：照抄 primitives/Checkbox.module.css */
.dcs-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-primary);cursor:pointer}
.dcs-check input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dcs-check input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dcs-check:has(input:disabled){cursor:default;opacity:.5}

/* Input：照抄 settings-form/fields.module.css 的 .input */
.dcs-in{width:100%;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;
  line-height:1.5;color:var(--dsw-alias-label-primary)}
.dcs-in::placeholder{color:var(--dsw-alias-label-dimmed)}
.dcs-in:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}

.dcs-list{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3);max-height:220px;overflow:auto}
.dcs-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;cursor:pointer;
  border-top:0.5px solid var(--dsw-alias-border-l1)}
.dcs-item:first-child{border-top:0}
.dcs-item[data-static="1"]{cursor:default}
.dcs-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcs-item[data-on="1"]{background:var(--dsw-alias-interactive-bg-active)}
.dcs-item input[type=radio],.dcs-item input[type=checkbox]{margin-top:2px;flex:0 0 auto;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dcs-txt{flex:1;min-width:0}
.dcs-t1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dcs-t2{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;margin-top:1px}

/* Pill：照抄 primitives/Pill.module.css */
.dcs-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;
  line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dcs-pill.is-same{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.dcs-pill.is-differs{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));background:var(--dsw-alias-state-warn-tertiary)}
.dcs-pill.is-remote-only{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.dcs-pill.is-local-only{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}

.dcs-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:12.5px}
.dcs-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcs-kv dd{margin:0;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}

.dcs-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.65;
  background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-md);padding:10px 12px;
  max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dcs-log .l-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dcs-log .l-error{color:var(--dsw-alias-state-error-primary)}
.dcs-log .l-done{color:var(--dsw-alias-state-success-primary)}
.dcs-log .l-step{color:var(--dsw-alias-state-business-primary);font-weight:600}
.dcs-log .t{color:var(--dsw-alias-label-tertiary);margin-right:6px}

.dcs-cf{border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:10px}
.dcs-cf:first-of-type{border-top:0;padding-top:0;margin-top:0}
.dcs-cf-h{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcs-pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:150px;overflow-y:auto;
  overflow-x:hidden;background:var(--dsw-alias-markdown-code-block);
  border-radius:var(--dsw-radius-sm);padding:8px;margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
/* 必须写 minmax(0,1fr)：裸 1fr 的最小尺寸是 auto，内容一长（长路径、连排英文、
   无空格的 JSON）轨道就会被撑破容器，而且两列宽度还会不一致。
   再让子项 min-width:0，否则它同样拒绝收缩。 */
.dcs-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.dcs-grid>*{min-width:0}
@media (max-width:600px){.dcs-grid{grid-template-columns:minmax(0,1fr)}}

.dcs-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l3);
  border-top-color:var(--dsw-alias-label-primary);border-radius:50%;animation:dcs-rot .8s linear infinite}
@keyframes dcs-rot{to{transform:rotate(360deg)}}

/* 浮层用 bg-layer-1（宿主定义的「主要抬升表面」），配软投影。
   shell.overlay 这一层本身是 pointer-events:none 的穿透层，条目必须自己开回来，
   否则面板点不动、点击会落到下面的应用上。 */
.dcs-overlay{position:fixed;left:12px;bottom:60px;width:460px;max-width:calc(100vw - 24px);min-width:0;max-height:78vh;
  overflow:auto;z-index:60;pointer-events:auto;padding:16px;background:var(--dsw-alias-bg-layer-1);
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  box-shadow:var(--dsw-elevation-soft),0 12px 32px #00000040}

/* 侧栏底部按钮：这个槽位是「与设置并排的一行」，所以只能是一个内联胶囊，
   不能用 width:100%（会挤压「设置」）。 */
.dcs-side{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:28px;
  padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}
.dcs-side:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcs-side:active{background:var(--dsw-alias-interactive-bg-active)}
.dcs-side:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dcs-side-icon{display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;flex:0 0 auto}
.dcs-side.compact{justify-content:center;padding:0;width:28px}
`;

    /* ================= 小部件 ================= */
    function Segmented({ value, onChange, options, disabled }) {
      const found = options.findIndex((o) => o.value === value);
      const index = Math.max(0, found);
      return e('div', {
        className: 'dcs-seg',
        role: 'tablist',
        style: { '--dcs-n': options.length, '--dcs-i': index },
      },
      // 没选中任何一项时（例如冲突刚出现、还没裁决）不画指示块，
      // 否则看起来像默认已经选了第一项。
      found >= 0 ? e('div', { className: 'dcs-seg-ind', 'aria-hidden': true }) : null,
      options.map((o) => e('button', {
        key: o.value,
        type: 'button',
        role: 'tab',
        'aria-selected': value === o.value ? 'true' : 'false',
        'data-on': value === o.value ? '1' : '0',
        disabled: Boolean(disabled),
        onClick: () => onChange(o.value),
      }, o.label)));
    }

    function Checkbox({ checked, onChange, disabled, children }) {
      return e('label', { className: 'dcs-check' },
        e('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled), onChange: (ev) => onChange(ev.target.checked) }),
        e('span', null, children));
    }

    function SyncIcon() {
      return e('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      e('path', { d: 'M4.5 2.5v11M2 5l2.5-2.5L7 5' }),
      e('path', { d: 'M11.5 13.5v-11M9 11l2.5 2.5L14 11' }));
    }

    const STATE_LABEL = { same: '一致', differs: '与远端不同', 'remote-only': '仅远端', 'local-only': '仅本机' };

    // 待裁决原因的文案（与宿主端 holdReasonText 保持一致的说法）
    const REASON_LABEL = {
      'divergent-session-history': '会话双方均有新增内容，无法拼接',
      'header-mismatch': '会话表头不一致',
      unreadable: '会话日志无法解析',
      'text-overlap': '文件双方修改同一位置',
      'binary-both-changed': '二进制文件双方均已修改',
      'no-common-base': '无共同历史，无法判定改动来源',
      'delete-local': '本机已删除，远端未修改',
      'remote-deleted': '远端已删除，本机未修改',
      'delete-modify': '本机已删除，远端已修改',
      'modify-delete': '远端已删除，本机已修改',
    };
    const DELETE_REASONS = ['delete-local', 'remote-deleted', 'delete-modify', 'modify-delete'];
    const isDeleteReason = (r) => DELETE_REASONS.includes(r);
    // 删除类的两种选择在不同状态下含义完全不同，所以每个原因给一组自己的说法，
    // 免得「删除 / 保留」在不同场景里被理解成不同的事。
    const DELETE_OPTIONS = {
      'delete-local': [{ value: 'delete', label: '同步删除到远端' }, { value: 'keep', label: '仅本机删除' }],
      'delete-modify': [{ value: 'delete', label: '保留删除' }, { value: 'keep', label: '采用远端版本' }],
      'modify-delete': [{ value: 'delete', label: '接受删除' }, { value: 'keep', label: '保留本机版本' }],
      'remote-deleted': [{ value: 'delete', label: '本机同时删除' }, { value: 'keep', label: '本机保留' }],
    };

    function fmtTime(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function fmtSize(n) {
      if (!n) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB'];
      let i = 0; let v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
      return (i ? v.toFixed(1) : String(Math.round(v))) + ' ' + u[i];
    }

    /* ================= 过程日志 ================= */
    function LogView({ entries }) {
      const ref = useRef(null);
      useEffect(() => {
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [entries.length]);
      if (!entries.length) return e('div', { className: 'dcs-log' }, '暂无记录');
      return e('div', { className: 'dcs-log', ref },
        entries.map((en) => e('div', { key: en.n, className: 'l-' + en.level },
          e('span', { className: 't' }, new Date(en.t).toLocaleTimeString()),
          en.text)));
    }

    /* ================= 冲突裁决 ================= */
    function ConflictCard({ conflict, decisions, onDecide, onPreview, preview }) {
      const choice = decisions[conflict.id];
      const p = preview && preview.id === conflict.id ? preview.data : null;
      const reason = REASON_LABEL[conflict.reason] || conflict.reason;
      const options = isDeleteReason(conflict.reason)
        ? DELETE_OPTIONS[conflict.reason] || [{ value: 'delete', label: '删除' }, { value: 'keep', label: '保留' }]
        : [{ value: 'local', label: '保留本机' }, { value: 'remote', label: '采用远端' }, { value: 'both', label: '两边都留' }];
      return e('div', { className: 'dcs-cf' },
        e('div', { className: 'dcs-cf-h', title: conflict.path }, conflict.title || conflict.path),
        e('div', { className: 'dcs-t2' },
          `${conflict.repo === 'main' ? '主数据' : '工作区'} · ${reason} · ${conflict.path}`),
        isDeleteReason(conflict.reason) ? e('div', { className: 'dcs-note' }, '删除类裁决的两种选择分别对应「删除」与「保持现状」，建议先查看两侧内容。') : null,
        e('div', { className: 'dcs-row', style: { marginTop: 8 } },
          e(Segmented, {
            value: choice || '',
            onChange: (v) => onDecide(conflict.id, v),
            options,
          }),
          e('button', { className: 'dcs-btn dcs-btn-outline', type: 'button', onClick: () => onPreview(conflict) },
            p ? '刷新对比' : '查看两侧内容'),
          choice ? e('span', { className: 'dcs-ok' }, '已选') : e('span', { className: 'dcs-note' }, '未选')),
        p && p.ok !== false && p.kind === 'session' ? e('div', { className: 'dcs-grid', style: { marginTop: 8 } },
          e('div', null,
            e('div', { className: 'dcs-lab' }, `本机（${p.local?.events ?? 0} 条事件）`),
            e('div', { className: 'dcs-pre' }, (p.local?.messages || []).slice(-4).map((m) => `${m.role === 'user' ? '你' : '助手'}：${m.text}`).join('\n\n') || p.local?.reason || '(空)')),
          e('div', null,
            e('div', { className: 'dcs-lab' }, `远端（${p.remote?.events ?? 0} 条事件）`),
            e('div', { className: 'dcs-pre' }, (p.remote?.messages || []).slice(-4).map((m) => `${m.role === 'user' ? '你' : '助手'}：${m.text}`).join('\n\n') || p.remote?.reason || '(空)'))) : null,
        p && p.ok !== false && p.kind === 'text' ? e('div', { className: 'dcs-grid', style: { marginTop: 8 } },
          e('div', null,
            e('div', { className: 'dcs-lab' }, '本机'),
            e('div', { className: 'dcs-pre' }, p.local ? (p.local.binary ? `(二进制 ${fmtSize(p.local.bytes)})` : p.local.text) : '（本机无此文件）')),
          e('div', null,
            e('div', { className: 'dcs-lab' }, '远端'),
            e('div', { className: 'dcs-pre' }, p.remote ? (p.remote.binary ? `(二进制 ${fmtSize(p.remote.bytes)})` : p.remote.text) : '（未留存远端版本）'))) : null,
        p && p.ok === false ? e('div', { className: 'dcs-err', style: { marginTop: 6 } }, String(p.error)) : null);
    }

    /* ================= 主面板 ================= */
    function SyncPanel({ variant, t }) {
      const [status, setStatus] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [workspaces, setWorkspaces] = useState([]);
      const [direction, setDirection] = useState('push');
      const [scope, setScope] = useState('all');
      const [selected, setSelected] = useState([]);
      const [includeWorkspace, setIncludeWorkspace] = useState(false);
      const [showSidebar, setShowSidebar] = useState(sidebarPref.value);
      const [query, setQuery] = useState('');
      const [entries, setEntries] = useState([]);
      const [running, setRunning] = useState(false);
      const [runSummary, setRunSummary] = useState(null);
      const [pending, setPending] = useState([]);
      const [decisions, setDecisions] = useState({});
      const [preview, setPreview] = useState(null);
      const [cfMsg, setCfMsg] = useState('');       // 冲突区的就地反馈：必须出现在用户正在看的地方
      const [busyMsg, setBusyMsg] = useState('');
      const [units, setUnits] = useState([]);
      const [unitFilter, setUnitFilter] = useState('todo');
      const [ignore, setIgnore] = useState({ sessions: [], workspaces: [], workspaceFiles: {} });
      const [wsIgnore, setWsIgnore] = useState(null);   // { workspaceId, title, path, exists, content, msg }
      const [cfgForm, setCfgForm] = useState(null);
      const [cfgMsg, setCfgMsg] = useState('');
      const [showCfg, setShowCfg] = useState(false);
      const sinceRef = useRef(0);
      const pendingSeenRef = useRef(-1);

      const refreshStatus = useCallback(async () => {
        try {
          const s = await jget('status');
          setStatus(s);
          if (s && Array.isArray(s.sessions)) setSessions(s.sessions);
          if (s && Array.isArray(s.workspaces)) setWorkspaces(s.workspaces);
          const pend = Array.isArray(s.pending) ? s.pending : [];
          setPending(pend);
          pendingSeenRef.current = pend.reduce((a, x) => a + (x.conflicts ? x.conflicts.length : 0), 0);
          if (s && typeof s.showSidebarButton === 'boolean') { setShowSidebar(s.showSidebarButton); sidebarPref.set(s.showSidebarButton); }
          if (s && s.current && typeof s.current.running === 'boolean') setRunning(s.current.running);
          if (s && s.lastRun && !s.lastRun.running) setRunSummary(s.lastRun);
          return s;
        } catch (err) {
          setStatus({ ok: false, error: String((err && err.message) || err) });
          return null;
        }
      }, []);

      const refreshUnits = useCallback(async () => {
        try {
          const r = await jget('units');
          if (!r || r.ok === false) return;
          setUnits(Array.isArray(r.units) ? r.units : []);
          if (r.ignore) setIgnore(r.ignore);
        } catch { /* 下一轮再试 */ }
      }, []);

      const saveIgnore = useCallback(async (patch) => {
        const r = await jpost('ignore', patch);
        if (r && r.ok) { setIgnore(r.ignore); refreshUnits(); }
        else setBusyMsg('忽略设置保存失败：' + ((r && r.error) || '未知错误'));
        return r;
      }, [refreshUnits]);

      const toggleIgnoreSession = useCallback(async (id) => {
        const cur = Array.isArray(ignore.sessions) ? ignore.sessions : [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]);
        await saveIgnore({ sessions: next });
      }, [ignore, saveIgnore]);

      const toggleIgnoreWorkspace = useCallback(async (id) => {
        const cur = Array.isArray(ignore.workspaces) ? ignore.workspaces : [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]);
        await saveIgnore({ workspaces: next });
      }, [ignore, saveIgnore]);

      const forceUnit = useCallback(async (u, mode) => {
        setBusyMsg('');
        const r = await jpost('force', { path: u.path, mode });
        if (r && r.ok) {
          setBusyMsg(mode === 'pull'
            ? `已以远端版本覆盖本机：${u.title || u.path}`
            : `已将本机版本交付至远端：${u.title || u.path}`);
        } else {
          setBusyMsg('强制覆盖失败：' + ((r && r.error) || '未知错误'));
        }
        refreshStatus();
        refreshUnits();
      }, [refreshStatus, refreshUnits]);

      const openWsIgnore = useCallback(async (ws) => {
        const r = await jget('workspace/ignore?workspaceId=' + encodeURIComponent(ws.id));
        if (!r || r.ok === false) { setBusyMsg('读取忽略文件失败：' + ((r && r.error) || '未知错误')); return; }
        setWsIgnore({ workspaceId: ws.id, title: r.title || ws.title, path: r.path, exists: r.exists, content: r.content || '', msg: '' });
      }, []);

      const createWsIgnore = useCallback(async (ws) => {
        const r = await jpost('workspace/ignore', { workspaceId: ws.id, create: true });
        if (!r || r.ok === false) { setBusyMsg('创建忽略文件失败：' + ((r && r.error) || '未知错误')); return; }
        setWsIgnore({ workspaceId: ws.id, title: ws.title || ws.id, path: r.path, exists: true, content: r.content || '', msg: '已创建，编辑后保存即可。' });
      }, []);

      const saveWsIgnore = useCallback(async () => {
        if (!wsIgnore) return;
        const r = await jpost('workspace/ignore', { workspaceId: wsIgnore.workspaceId, content: wsIgnore.content });
        if (!r || r.ok === false) { setWsIgnore({ ...wsIgnore, msg: '保存失败：' + ((r && r.error) || '未知错误') }); return; }
        setWsIgnore({ ...wsIgnore, path: r.path, exists: true, msg: '已保存，下次同步该工作区时生效。' });
      }, [wsIgnore]);

      const alignNow = useCallback(async () => {
        setBusyMsg('');
        const r = await jpost('align', {});
        if (r && r.ok) {
          setBusyMsg(r.upToDate
            ? (r.ahead ? `本机已包含远端全部内容（领先 ${r.ahead} 个提交，均为本机此前交付的记录）。` : '本机与远端一致。')
            : '已快进至远端。');
        } else {
          setBusyMsg('重新对齐失败：' + ((r && r.error) || '未知错误'));
        }
        refreshStatus();
        refreshUnits();
      }, [refreshStatus, refreshUnits]);

      const refreshLight = useCallback(async () => {
        try {
          const s = await jget('ping');
          if (!s || s.ok === false) return;
          setRunning(Boolean(s.running));
          if (s.lastRun && !s.lastRun.running) setRunSummary(s.lastRun);
          if (typeof s.showSidebarButton === 'boolean') { setShowSidebar(s.showSidebarButton); sidebarPref.set(s.showSidebarButton); }
          if (typeof s.pendingCount === 'number') {
            if (s.pendingCount !== pendingSeenRef.current) {
              pendingSeenRef.current = s.pendingCount;
              if (s.pendingCount > 0) refreshStatus();
            }
          }
        } catch { /* 下一轮再试 */ }
      }, [refreshStatus]);

      // 打开时拉一次全量；空闲只走轻量心跳（运行中由 progress 轮询驱动）
      useEffect(() => {
        refreshStatus();
        refreshUnits();
        const id = setInterval(() => { if (!running) refreshLight(); }, 5000);
        return () => clearInterval(id);
      }, [refreshStatus, refreshLight, refreshUnits, running]);

      // 每次同步结束、以及初次挂载后，重算逐单元状态
      useEffect(() => { if (!running) { refreshUnits(); refreshStatus(); } }, [running, refreshUnits, refreshStatus]);

      const pullProgress = useCallback(async () => {
        try {
          const r = await jget('progress?since=' + sinceRef.current);
          if (!r || r.ok === false) return;
          if (r.entries && r.entries.length) {
            sinceRef.current = r.next;
            setEntries((prev) => prev.concat(r.entries));
          }
          if (typeof r.running === 'boolean') setRunning(r.running);
          if (r.summary) setRunSummary(r.summary);
        } catch { /* 轮询失败下一轮再试 */ }
      }, []);

      useEffect(() => {
        if (!running) return undefined;
        pullProgress();
        const id = setInterval(pullProgress, 500);
        return () => clearInterval(id);
      }, [running, pullProgress]);

      const startRun = useCallback(async (dir) => {
        setBusyMsg('');
        setRunSummary(null);
        setEntries([]);
        sinceRef.current = 0;
        if (scope === 'session' && !selected.length) { setBusyMsg('请先选择会话，或将范围改为「全部会话」。'); return; }
        const r = await jpost('run', {
          direction: dir,
          scope,
          sessionIds: scope === 'session' ? selected : [],
          includeWorkspace,
          reason: 'web',
        });
        if (!r || r.ok === false) { setBusyMsg((r && r.error) || '无法开始同步。'); return; }
        setRunning(true);
        setEntries([{ n: 0, t: Date.now(), level: 'step', text: `开始：${dir === 'push' ? '推送' : '取回'}（${scope === 'all' ? '全部会话' : '所选会话'}）` }]);
      }, [scope, selected, includeWorkspace]);

      const saveConfig = useCallback(async () => {
        setCfgMsg('');
        const r = await jpost('config', {
          remote: cfgForm.remote,
          branch: cfgForm.branch,
          proxy: cfgForm.proxy,
          autoRepo: cfgForm.autoRepo,
          repoName: cfgForm.repoName,
          workspaceBase: cfgForm.workspaceBase || '',
          showSidebarButton: showSidebar,
        });
        if (r && r.ok) { setCfgMsg('已保存到 ' + r.configPath); sidebarPref.set(showSidebar); refreshStatus(); }
        else setCfgMsg('保存失败：' + ((r && r.error) || '未知错误'));
      }, [cfgForm, showSidebar, refreshStatus]);

      const toggleSidebar = useCallback(async (next) => {
        setShowSidebar(next);
        sidebarPref.set(next);
        const r = await jpost('config', { showSidebarButton: next });
        if (!r || r.ok === false) {
          setBusyMsg('侧栏按钮设置保存失败：' + ((r && r.error) || '未知错误'));
          sidebarPref.set(!next);
          setShowSidebar(!next);
        }
      }, []);

      useEffect(() => {
        if (cfgForm || !status) return;
        setCfgForm({
          remote: status.remote || '',
          branch: status.branch || 'main',
          proxy: status.proxy || '',
          autoRepo: status.autoRepo !== false,
          repoName: status.repoName || 'dsh-sync',
          workspaceBase: status.workspaceBase || '',
        });
      }, [status, cfgForm]);

      const openPreview = useCallback(async (conflict) => {
        const owner = pending.find((p) => p.conflicts.some((c) => c.id === conflict.id));
        if (!owner) return;
        const r = await jpost('pending/preview', { pendingId: owner.id, conflictId: conflict.id });
        setPreview({ id: conflict.id, data: r });
      }, [pending]);

      const applyDecisions = useCallback(async () => {
        setCfMsg('');
        const chosen = pending.flatMap((p) => p.conflicts.filter((c) => decisions[c.id]));
        if (!chosen.length) {
          setCfMsg('请先选择处理方式，或点击「其余全部保留本机」。');
          return;
        }
        let applied = 0;
        let remaining = 0;
        for (const p of pending) {
          const ds = p.conflicts.filter((c) => decisions[c.id]).map((c) => ({ id: c.id, choice: decisions[c.id] }));
          if (!ds.length) continue;
          const r = await jpost('pending/resolve', { pendingId: p.id, decisions: ds });
          if (!r || r.ok === false) {
            setCfMsg('裁决失败：' + ((r && r.error) || '未知错误'));
            refreshStatus();
            refreshUnits();
            return;
          }
          applied += ds.length;
          remaining += Number(r.remaining) || 0;
        }
        setDecisions({});
        setPreview(null);
        setCfMsg(remaining
          ? `已应用 ${applied} 项，剩余 ${remaining} 项待裁决。`
          : `已应用 ${applied} 项，全部处理完毕。`);
        refreshStatus();
        refreshUnits();
      }, [pending, decisions, refreshStatus]);

      const discardPending = useCallback(async () => {
        for (const p of pending) await jpost('pending/discard', { pendingId: p.id });
        setDecisions({});
        setPreview(null);
        setCfMsg('已放弃本次待裁决记录（本机文件未改动）。');
        refreshStatus();
        refreshUnits();
      }, [pending, refreshStatus]);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return sessions;
        return sessions.filter((s) => (s.title || '').toLowerCase().includes(q)
          || (s.cwd || '').toLowerCase().includes(q)
          || (s.id || '').toLowerCase().includes(q));
      }, [sessions, query]);

      const wsName = useCallback((id) => {
        const w = workspaces.find((x) => x.id === id);
        return w ? w.title : (id ? id.slice(0, 8) : '未分组');
      }, [workspaces]);

      const targetWorkspaces = useMemo(() => {
        if (scope === 'all') return workspaces;
        const owner = new Map(sessions.map((s) => [s.id, s.workspaceId]));
        const wanted = new Set(selected.map((id) => owner.get(id)).filter(Boolean));
        return workspaces.filter((w) => wanted.has(w.id));
      }, [scope, selected, sessions, workspaces]);

      const filteredUnits = useMemo(
        () => (unitFilter === 'all' ? units : units.filter((u) => u.state !== 'A1')),
        [units, unitFilter],
      );
      const decisionCount = units.filter((u) => u.needsDecision).length;
      const diffCount = units.filter((u) => u.state !== 'A1' && u.state !== 'IGNORED').length;

      const conflictCount = pending.reduce((a, p) => a + p.conflicts.length, 0);
      const chosenCount = pending.reduce((a, p) => a + p.conflicts.filter((c) => decisions[c.id]).length, 0);
      const repo = status && status.repo;
      const res = (runSummary && runSummary.result) || null;

      return e('div', { className: variant === 'overlay' ? 'dcs-root dcs-overlay' : 'dcs-root' },
        e('style', null, CSS),

        // —— 页头 ——
        e('div', { className: 'dcs-head' },
          e('div', { className: 'dcs-h' }, t('title')),
          variant === 'overlay'
            ? e('button', { className: 'dcs-btn dcs-btn-ghost', type: 'button', onClick: () => overlay.set(false) }, '关闭')
            : null),

        // —— 状态卡 ——
        e('div', { className: 'dcs-card' },
          e('dl', { className: 'dcs-kv' },
            e('dt', null, '远端'), e('dd', { title: (status && status.remote) || '' }, (status && status.remote) || '（未配置，首次推送时自动创建私有仓库）'),
            e('dt', null, '分支'), e('dd', null, (status && status.branch) || 'main'),
            e('dt', null, '本地'), e('dd', null, repo && repo.exists
              ? `${repo.head || '（无提交）'}${repo.remoteHead ? ` · 领先 ${repo.ahead} / 落后 ${repo.behind}` : ''} · 未提交 ${repo.dirty} 项`
              : '本地仓库尚未初始化'),
            e('dt', null, '数据'), e('dd', null, `本机会话 ${(status && status.localSessionCount) || 0} · 远端会话 ${(status && status.remoteSessionCount) || 0} · 工作区 ${workspaces.length}`),
            e('dt', null, '环境'), e('dd', null, `${status && status.gitMissing ? '找不到 git' : 'git 正常'} · ${status && status.ghAvailable ? 'gh 已登录' : 'gh 不可用（跳过自动建仓与私有性校验）'}`),
            e('dt', null, '与远端'), e('dd', null, `领先 ${(repo && repo.ahead) || 0} / 落后 ${(repo && repo.behind) || 0}；本机只会落后、不会分叉，落后项包含本机此前交付的提交`),
            e('dt', null, '单元'), e('dd', null, diffCount ? `${diffCount} 个条目与远端不同，其中 ${decisionCount} 个待裁决` : '所有条目均与远端一致')),
          e('div', { className: 'dcs-row', style: { marginTop: 10 } },
            e('button', { className: 'dcs-btn dcs-btn-outline', type: 'button', onClick: () => setShowCfg((v) => !v) }, showCfg ? '收起' : '连接设置'),
            e('button', { className: 'dcs-btn dcs-btn-outline', type: 'button', onClick: refreshStatus }, '刷新状态'),
            e('button', { className: 'dcs-btn dcs-btn-outline', type: 'button', disabled: running, title: '仅执行快进，不产生合并提交', onClick: alignNow }, '重新对齐（快进）')),
          showCfg && cfgForm ? e('div', { style: { marginTop: 12 } },
            e('div', { className: 'dcs-sec' },
              e('div', { className: 'dcs-lab' }, '仓库地址'),
              e('input', { className: 'dcs-in', value: cfgForm.remote, placeholder: 'https://github.com/你的账号/dsh-sync', onChange: (ev) => setCfgForm({ ...cfgForm, remote: ev.target.value }) })),
            e('div', { className: 'dcs-grid', style: { marginTop: 8 } },
              e('div', { className: 'dcs-sec' },
                e('div', { className: 'dcs-lab' }, '分支'),
                e('input', { className: 'dcs-in', value: cfgForm.branch, onChange: (ev) => setCfgForm({ ...cfgForm, branch: ev.target.value }) })),
              e('div', { className: 'dcs-sec' },
                e('div', { className: 'dcs-lab' }, '自动建仓的仓库名'),
                e('input', { className: 'dcs-in', value: cfgForm.repoName, onChange: (ev) => setCfgForm({ ...cfgForm, repoName: ev.target.value }) }))),
            e('div', { className: 'dcs-sec', style: { marginTop: 8 } },
              e('div', { className: 'dcs-lab' }, 'Git 代理（可选）'),
              e('input', { className: 'dcs-in', value: cfgForm.proxy, placeholder: 'http://127.0.0.1:7890', onChange: (ev) => setCfgForm({ ...cfgForm, proxy: ev.target.value }) })),
            e('div', { className: 'dcs-sec', style: { marginTop: 8 } },
              e('div', { className: 'dcs-lab' }, '工作区统一目录（可选）'),
              e('input', { className: 'dcs-in', value: cfgForm.workspaceBase || '', placeholder: '留空则按登记表路径；必要时按本机主目录改写', onChange: (ev) => setCfgForm({ ...cfgForm, workspaceBase: ev.target.value }) })),
            e('div', { style: { marginTop: 10 } },
              e(Checkbox, { checked: cfgForm.autoRepo, onChange: (v) => setCfgForm({ ...cfgForm, autoRepo: v }) }, '远端为空时允许 gh 自动创建或复用私有仓库')),
            e('div', { className: 'dcs-row', style: { marginTop: 12 } },
              e('button', { className: 'dcs-btn dcs-btn-primary', type: 'button', onClick: saveConfig }, '保存连接设置')),
            cfgMsg ? e('div', { className: cfgMsg.startsWith('已保存') ? 'dcs-ok' : 'dcs-err', style: { marginTop: 8 } }, cfgMsg) : null) : null),

        // —— 操作 ——
        e('div', { className: 'dcs-sec' },
          e('div', { className: 'dcs-lab' }, '操作'),
          e(Segmented, {
            value: direction,
            disabled: running,
            onChange: setDirection,
            options: [
              { value: 'push', label: '推送（本机 → 远端）' },
              { value: 'pull', label: '取回（远端 → 本机）' },
            ],
          }),
          e('div', { className: 'dcs-note' },
            direction === 'push'
              ? '将本机改动提交并上传至 GitHub 私有仓库。'
              : '将远端内容取回本机；双方均已修改且无法自动合并的条目需人工裁决。')),

        // —— 范围 ——
        e('div', { className: 'dcs-sec' },
          e('div', { className: 'dcs-lab' }, '范围'),
          e(Segmented, {
            value: scope,
            disabled: running,
            onChange: (v) => { setScope(v); if (v === 'all') setSelected([]); },
            options: [
              { value: 'all', label: '全部会话' },
              { value: 'session', label: '单个会话' },
            ],
          }),
          scope === 'session' ? e('div', { className: 'dcs-sec', style: { marginTop: 4 } },
            e('input', {
              className: 'dcs-in',
              placeholder: '搜索标题 / 目录 / ID',
              value: query,
              onChange: (ev) => setQuery(ev.target.value),
            }),
            e('div', { className: 'dcs-list' },
              filtered.length === 0
                ? e('div', { className: 'dcs-item', 'data-static': '1' }, e('span', { className: 'dcs-note' }, '无匹配会话'))
                : filtered.map((s) => {
                  const on = selected.includes(s.id);
                  return e('label', { key: s.id, className: 'dcs-item', 'data-on': on ? '1' : '0' },
                    e('input', { type: 'radio', name: 'dcs-session', checked: on, onChange: () => setSelected([s.id]) }),
                    e('div', { className: 'dcs-txt' },
                      e('div', { className: 'dcs-t1' }, s.title || '(无标题会话)'),
                      e('div', { className: 'dcs-t2' }, `${wsName(s.workspaceId)} · ${fmtTime(s.mtime)} · ${fmtSize(s.size)}`)),
                    e('span', { className: 'dcs-pill is-' + s.state }, STATE_LABEL[s.state] || s.state));
                }))) : null),

        // —— 逐单元状态 ——
        e('div', { className: 'dcs-sec' },
          e('div', { className: 'dcs-row' },
            e('div', { className: 'dcs-lab' }, '条目状态'),
            e('div', { className: 'dcs-spread' }),
            e(Segmented, {
              value: unitFilter,
              onChange: setUnitFilter,
              options: [
                { value: 'todo', label: '未同步' },
                { value: 'all', label: '全部' },
              ],
            })),
          filteredUnits.length === 0
            ? e('div', { className: 'dcs-note' }, units.length ? '所有条目均与远端一致。' : '暂无可比较数据，请先执行一次推送以建立基线。')
            : e('div', { className: 'dcs-list', style: { maxHeight: 220 } },
              filteredUnits.map((u) => e('div', { key: u.path, className: 'dcs-item', 'data-static': '1' },
                e('div', { className: 'dcs-txt' },
                  e('div', { className: 'dcs-t1' }, u.title || u.path.split('/').pop()),
                  e('div', { className: 'dcs-t2', title: u.path }, `${u.stateLabel} · ${u.path}`)),
                u.sessionId ? e('button', {
                  className: 'dcs-btn dcs-btn-outline',
                  type: 'button',
                  disabled: running,
                  title: u.muted ? '取消忽略，重新纳入同步' : '忽略：不同步，远端保持不变',
                  onClick: () => toggleIgnoreSession(u.sessionId),
                }, u.muted ? '取消忽略' : '忽略') : null,
                e('button', {
                  className: 'dcs-btn dcs-btn-outline',
                  type: 'button',
                  disabled: running || u.state === 'A1',
                  title: '无条件以远端版本覆盖本机',
                  onClick: () => forceUnit(u, 'pull'),
                }, '用远端覆盖'),
                e('button', {
                  className: 'dcs-btn dcs-btn-outline',
                  type: 'button',
                  disabled: running || u.state === 'A1',
                  title: '无条件以本机版本覆盖远端',
                  onClick: () => forceUnit(u, 'push'),
                }, '用本机覆盖'),
                e('span', { className: 'dcs-pill' + (u.needsDecision ? ' is-differs' : '') }, u.stateLabel)))),
          e('div', { className: 'dcs-note' },
            '被忽略的会话不参与同步，其落后状态不影响其他条目交付。'
            + '「用远端覆盖 / 用本机覆盖」跳过合并判断，无条件采用所选一侧。')),

        // —— 工作区 ——
        e('div', { className: 'dcs-sec' },
          e(Checkbox, { checked: includeWorkspace, disabled: running, onChange: setIncludeWorkspace }, '同时同步工作区里的项目文件'),
          e('div', { className: 'dcs-note' },
            includeWorkspace
              ? `涉及 ${targetWorkspaces.length} 个工作区（node_modules、.git 等已排除）`
              : '仅同步会话与设置。'),
          includeWorkspace && targetWorkspaces.length ? e('div', { className: 'dcs-list', style: { maxHeight: 180 } },
            targetWorkspaces.map((w) => e('div', { key: w.id, className: 'dcs-item', 'data-static': '1' },
              e('div', { className: 'dcs-txt' },
                e('div', { className: 'dcs-t1' }, w.title || w.id),
                e('div', { className: 'dcs-t2', title: w.path || '' },
                  (w.path || '(无路径)')
                  + (w.pathSource === 'override' ? ' · 本机指定' : w.pathSource === 'remapped' ? ' · 按本机主目录改写' : w.pathSource === 'base' ? ' · 统一目录' : '')
                  + (w.exists ? '' : ' · 本机不存在，取回时创建'))),
              e('button', {
                className: 'dcs-btn dcs-btn-outline',
                type: 'button',
                disabled: running,
                title: '编辑工作区根目录下的 .dsh-chat-sync-ignore（本机专属，不参与同步）',
                onClick: () => openWsIgnore(w),
              }, '忽略规则'),
              e('button', {
                className: 'dcs-btn dcs-btn-outline',
                type: 'button',
                disabled: running,
                title: (ignore.workspaces || []).includes(w.id) ? '取消忽略此工作区' : '忽略此工作区（不参与同步）',
                onClick: () => toggleIgnoreWorkspace(w.id),
              }, (ignore.workspaces || []).includes(w.id) ? '取消忽略' : '忽略'),
              e('button', {
                className: 'dcs-btn dcs-btn-outline',
                type: 'button',
                disabled: running,
                onClick: () => {
                  const next = window.prompt(`把工作区「${w.title || w.id}」在本机的目录改成：\n（留空表示恢复默认）`, w.path || '');
                  if (next === null) return;
                  jpost('workspace/path', { workspaceId: w.id, path: next }).then((r) => {
                    setBusyMsg(r && r.ok ? '' : '更新路径失败：' + ((r && r.error) || '未知错误'));
                    refreshStatus();
                  });
                },
              }, '更改路径')))) : null),

        // —— 工作区忽略规则编辑器 ——
        wsIgnore ? e('div', { className: 'dcs-card' },
          e('div', { className: 'dcs-row' },
            e('div', { className: 'dcs-lab' }, `「${wsIgnore.title}」的忽略规则`),
            e('div', { className: 'dcs-spread' }),
            e('button', { className: 'dcs-btn dcs-btn-ghost', type: 'button', onClick: () => setWsIgnore(null) }, '关闭')),
          e('div', { className: 'dcs-note', style: { marginTop: 4 } },
            wsIgnore.exists ? `文件：${wsIgnore.path}（每行一条，gitignore 语法；本机专属，不参与同步）` : `文件不存在：${wsIgnore.path}`),
          wsIgnore.exists
            ? e('textarea', {
              className: 'dcs-in',
              style: { height: 150, padding: 8, marginTop: 8, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 11.5, lineHeight: 1.6, resize: 'vertical' },
              value: wsIgnore.content,
              spellCheck: false,
              onChange: (ev) => setWsIgnore({ ...wsIgnore, content: ev.target.value }),
            })
            : e('div', { className: 'dcs-note', style: { marginTop: 8 } }, '点击「创建忽略文件」将在工作区根目录生成带说明的模板，之后可自行编辑。'),
          e('div', { className: 'dcs-row', style: { marginTop: 8 } },
            wsIgnore.exists
              ? e('button', { className: 'dcs-btn dcs-btn-primary', type: 'button', disabled: running, onClick: saveWsIgnore }, '保存忽略规则')
              : e('button', { className: 'dcs-btn dcs-btn-primary', type: 'button', disabled: running, onClick: () => createWsIgnore({ id: wsIgnore.workspaceId, title: wsIgnore.title }) }, '创建忽略文件'),
            e('button', { className: 'dcs-btn dcs-btn-outline', type: 'button', disabled: running, onClick: () => openWsIgnore({ id: wsIgnore.workspaceId, title: wsIgnore.title }) }, '重新读取')),
          wsIgnore.msg ? e('div', { className: wsIgnore.msg.startsWith('已') ? 'dcs-ok' : 'dcs-err', style: { marginTop: 6 } }, wsIgnore.msg) : null) : null,

        // —— 侧栏按钮 ——
        e('div', { className: 'dcs-sec' },
          e(Checkbox, { checked: showSidebar, disabled: running, onChange: toggleSidebar }, '在侧栏左下角显示同步按钮'),
          e('div', { className: 'dcs-note' }, '关闭后仅保留「设置 → 会话同步」入口。')),

        // —— 开始 ——
        e('div', { className: 'dcs-row' },
          e('button', {
            className: 'dcs-btn dcs-btn-primary dcs-btn-md',
            type: 'button',
            disabled: running,
            onClick: () => startRun(direction),
          }, running ? '同步中…' : (direction === 'push' ? '开始推送' : '开始取回')),
          running ? e('span', { className: 'dcs-spin' }) : null,
          runSummary && !running
            ? e('span', { className: runSummary.error ? 'dcs-err' : 'dcs-ok' }, runSummary.error ? ('未完成：' + runSummary.error) : '完成')
            : null),
        busyMsg ? e('div', { className: 'dcs-err' }, busyMsg) : null,

        // —— 过程 ——
        e('div', { className: 'dcs-sec' },
          e('div', { className: 'dcs-lab' }, `过程${running ? '（进行中）' : entries.length ? '' : '（未执行）'}`),
          e(LogView, { entries })),

        // —— 上次结果 ——
        runSummary && !running ? e('div', { className: 'dcs-card' },
          e('div', { className: 'dcs-lab' },
            `上次操作：${runSummary.direction === 'push' ? '推送' : runSummary.direction === 'pull' ? '取回' : runSummary.direction} · ${runSummary.scope === 'all' ? '全部会话' : runSummary.scope === 'session' ? '单个会话' : runSummary.scope} · ${Math.round((runSummary.durationMs || 0) / 1000)}s`),
          e('div', { className: runSummary.error ? 'dcs-err' : 'dcs-ok', style: { marginTop: 4 } }, runSummary.error || '成功'),
          res && res.applied && res.applied.length
            ? e('div', { className: 'dcs-note', style: { marginTop: 4 } }, `写入 ${res.applied.length} 个文件；自动合并 ${(res.merged || []).length} 个`)
            : null,
          res && res.pushed && res.pushed.length
            ? e('div', { className: 'dcs-note', style: { marginTop: 4 } }, '已推送至远端。')
            : null,
          res && (res.applied || []).some((x) => x.added)
            ? e('div', { className: 'dcs-warn', style: { marginTop: 4 } }, '本次取回包含新会话，需刷新 DSH 后才会出现在侧栏（必要时重启）。')
            : null) : null,

        // —— 冲突裁决 ——
        conflictCount ? e('div', { className: 'dcs-card' },
          e('div', { className: 'dcs-row' },
            e('div', { className: 'dcs-lab' }, `待裁决冲突（${conflictCount} 项）`),
            e('div', { className: 'dcs-spread' }),
            e('span', { className: chosenCount ? 'dcs-pill is-differs' : 'dcs-pill' }, `已选 ${chosenCount} / ${conflictCount}`)),
          e('div', { className: 'dcs-note', style: { marginBottom: 10 } },
            '以下条目双方均已修改，自动合并会丢失内容，故暂停于此。本机文件未改动。可分批裁决。'),
          pending.flatMap((p) => p.conflicts.map((c) => e(ConflictCard, {
            key: c.id,
            conflict: c,
            decisions,
            onDecide: (id, v) => setDecisions((prev) => ({ ...prev, [id]: v })),
            onPreview: openPreview,
            preview,
          }))),
          e('div', { className: 'dcs-row', style: { marginTop: 12 } },
            e('button', {
              className: 'dcs-btn dcs-btn-primary',
              type: 'button',
              disabled: running || !chosenCount,
              onClick: applyDecisions,
            }, chosenCount ? `应用所选 ${chosenCount} 项` : '应用所选项目'),
            e('button', {
              className: 'dcs-btn dcs-btn-outline',
              type: 'button',
              disabled: running,
              onClick: () => {
                const all = {};
                for (const p of pending) for (const c of p.conflicts) all[c.id] = 'local';
                setDecisions(all);
                setCfMsg('已将全部冲突标记为「保留本机」，请点击「应用所选项目」。');
              },
            }, '其余全部保留本机'),
            e('button', { className: 'dcs-btn dcs-btn-danger', type: 'button', disabled: running, onClick: discardPending }, '放弃本次裁决记录')),
          cfMsg ? e('div', { className: cfMsg.startsWith('已应用') || cfMsg.startsWith('已把') ? 'dcs-ok' : 'dcs-err', style: { marginTop: 8 } }, cfMsg) : null,
          e('div', { className: 'dcs-note', style: { marginTop: 8 } },
            '「两边都留」：会话将把远端版本导入为新会话（不覆盖本机原会话）；其他文件另存为 <文件名>.remote-<时间>。')) : null,

        status && !status.remote && !(repo && repo.remoteHead)
          ? e('div', { className: 'dcs-note' }, '尚未配置远端仓库。点击「开始推送」将通过 gh 自动创建或复用私有仓库。')
          : null);
    }

    /* ================= 侧栏按钮 ================= */
    function SidebarButton(props) {
      const { t } = props;
      const open = useStore(overlay);
      const visible = useStore(sidebarPref);
      const [running, setRunning] = useState(false);
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const s = await jget('ping');
            if (!alive) return;
            setRunning(Boolean(s && s.running));
            if (s && typeof s.showSidebarButton === 'boolean') sidebarPref.set(s.showSidebarButton);
          } catch { /* ignore */ }
        };
        tick();
        const id = setInterval(tick, running ? 1500 : 6000);
        return () => { alive = false; clearInterval(id); };
      }, [running]);
      if (!visible) return null;
      const wide = props.wide !== false;
      return e('button', {
        className: wide ? 'dcs-side' : 'dcs-side compact',
        type: 'button',
        title: t('openPanel'),
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => overlay.set(!open),
      },
      e('span', { className: 'dcs-side-icon' }, running ? e('span', { className: 'dcs-spin' }) : e(SyncIcon, null)),
      wide ? e('span', null, running ? t('running') : t('title')) : null);
    }

    function OverlayHost(props) {
      const open = useStore(overlay);
      if (!open) return null;
      return e(SyncPanel, { variant: 'overlay', t: props.t });
    }

    function SettingsSection(props) {
      return e(SyncPanel, { variant: 'page', t: props.t });
    }

    /* ================= locale ================= */
    const DICT = {
      zh: { title: '会话同步', openPanel: '打开会话同步面板', running: '同步中…' },
      en: { title: 'Chat Sync', openPanel: 'Open the chat sync panel', running: 'Syncing…' },
    };

    return {
      name: 'dsh-chat-sync',
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = (k) => k;
        try {
          const off1 = ctx.locale.register(NS, 'zh', DICT.zh);
          const off2 = ctx.locale.register(NS, 'en', DICT.en);
          t = ctx.locale.bind(NS);
          ctx.effect(() => () => { try { off1(); } catch { /* ignore */ } try { off2(); } catch { /* ignore */ } });
        } catch { /* 词典注册失败就退回 key 本身 */ }

        // 先问一次宿主：侧栏按钮要不要显示（默认显示）
        jget('ping').then((s) => {
          if (s && typeof s.showSidebarButton === 'boolean') sidebarPref.set(s.showSidebarButton);
        }).catch(() => {});

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-chat-sync-button',
          order: 30,
          label: () => t('title'),
        }, (props) => e(SidebarButton, { ...props, t })));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-chat-sync-overlay',
          order: 200,
        }, (props) => e(OverlayHost, { ...props, t })));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-chat-sync-section',
          order: 410,
          label: () => t('title'),
        }, (props) => e(SettingsSection, { ...props, t })));
      },
    };
  },
});
