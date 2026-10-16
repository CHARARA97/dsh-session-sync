/**
 * client.js 的单元测试（React 用测试替身，不是渲染验证）。
 *
 * 本环境没有浏览器控制，也没有可用的 react/react-dom（React 由宿主在浏览器中提供）。
 * 这里用一套最小 React 测试替身替代它：createElement + hooks 按组件实例隔离，
 * 渲染后执行 effect，再重放 effect 引发的状态更新，循环若干轮。
 *
 * 它【只能】证明组件逻辑：渲染期是否抛异常、状态更新是否生效、交互是否发出正确的请求、
 * 文案与 class 是否出现、以及源码层面的样式约束。
 * 它【不能】证明任何外观：布局、间距、配色、溢出、明暗主题下的可读性一律未经检验，
 * 这些必须在真实页面里确认。
 *
 * 运行：node tests/client-render.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client.js');
const SRC = fs.readFileSync(CLIENT, 'utf8');

/* ================= 最小 React 模拟器 ================= */
let currentInstance = null;
let hookCursor = 0;
const instances = new Map();
const effectQueue = [];

function getInstance(key) {
  let inst = instances.get(key);
  if (!inst) { inst = { hooks: [] }; instances.set(key, inst); }
  return inst;
}
function slot(i, init) {
  const h = currentInstance.hooks;
  if (h.length <= i) h.push(init);
  return h[i];
}
function depsChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  return a.some((x, i) => !Object.is(x, b[i]));
}

const React = {
  createElement(type, props, ...children) {
    const p = { ...(props || {}) };
    if (children.length === 1) p.children = children[0];
    else if (children.length > 1) p.children = children;
    return { $$el: true, type, props: p };
  },
  useState(init) {
    const i = hookCursor++;
    const inst = currentInstance;   // setter 可能在渲染之外被调用（异步 effect），必须捕获实例
    const initial = typeof init === 'function' ? init() : init;
    const cur = slot(i, { value: initial }).value;
    const set = (v) => {
      const s = inst.hooks[i];
      s.value = typeof v === 'function' ? v(s.value) : v;
      inst.dirty = true;
    };
    return [cur, set];
  },
  useRef(init) {
    const i = hookCursor++;
    return slot(i, { current: init });
  },
  useMemo(fn, deps) {
    const i = hookCursor++;
    const s = slot(i, { deps: null, value: undefined });
    if (depsChanged(s.deps, deps)) { s.deps = deps; s.value = fn(); }
    return s.value;
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
  useEffect(fn, deps) {
    const i = hookCursor++;
    const s = slot(i, { deps: null, cleanup: undefined });
    if (depsChanged(s.deps, deps)) {
      s.deps = deps;
      effectQueue.push({ inst: currentInstance, hook: s, fn });
    }
  },
};

/* ================= 假 fetch ================= */
const CWD = '/home/alice/project';
const STATUS = {
  ok: true,
  home: '/home/alice/.dsh',
  remote: 'https://github.com/alice/dsh-sync.git',
  branch: 'main',
  proxy: '',
  autoRepo: true,
  repoName: 'dsh-sync',
  workspaceBase: '',
  showSidebarButton: true,
  gitMissing: false,
  ghAvailable: true,
  running: false,
  repo: { exists: true, head: 'abc1234', remoteHead: 'abc1234', ahead: 0, behind: 0, dirty: 3 },
  localSessionCount: 2,
  remoteSessionCount: 1,
  sessions: [
    { id: 'session-aaaa1111-0000-4000-8000-000000000001', title: '会话一', cwd: CWD, workspaceId: 'ws-1', size: 12345, mtime: 1791000000000, relLog: 'sessions/x/session-aaaa1111-0000-4000-8000-000000000001/session.v4.jsonl.zstd', state: 'differs' },
    { id: 'session-bbbb2222-0000-4000-8000-000000000002', title: '会话二', cwd: CWD, workspaceId: null, size: 2048, mtime: 1791000001000, relLog: 'sessions/x/session-bbbb2222/session.v4.jsonl.zstd', state: 'local-only' },
  ],
  workspaces: [
    { id: 'ws-1', title: 'proj', path: '/home/alice/project', recordedPath: '/home/bob/project', pathSource: 'remapped', exists: true, sessionCount: 2 },
    { id: 'ws-2', title: '另一个', path: '/home/alice/other', recordedPath: '/home/alice/other', pathSource: 'recorded', exists: false, sessionCount: 0 },
  ],
  pending: [{
    id: 'pending-1',
    createdAt: Date.now(),
    conflicts: [
      { id: 'main:sessions/x/session-aaaa1111-0000-4000-8000-000000000001/session.v4.jsonl.zstd', repo: 'main', path: 'sessions/x/session-aaaa1111-0000-4000-8000-000000000001/session.v4.jsonl.zstd', kind: 'session-log', reason: 'divergent-session-history', sessionId: 'session-aaaa1111-0000-4000-8000-000000000001', title: '会话一', theirsCopy: 'files/1-theirs' },
      { id: 'ws:ws-1:README.md', repo: 'ws:ws-1', path: 'README.md', kind: 'file', reason: 'text-overlap', title: null, theirsCopy: 'files/2-theirs' },
      { id: 'main:sessions/x/session-cccc3333-0000-4000-8000-000000000003/session.v4.jsonl.zstd', repo: 'main', side: 'delivery', path: 'sessions/x/session-cccc3333-0000-4000-8000-000000000003/session.v4.jsonl.zstd', kind: 'session-log', reason: 'corrupt-session-log', sessionId: 'session-cccc3333-0000-4000-8000-000000000003', title: '会话三', theirsCopy: 'files/4-theirs' },
      { id: 'main:sessions/x/session-bbbb2222-0000-4000-8000-000000000002/session.v4.jsonl.zstd', repo: 'main', side: 'delivery', path: 'sessions/x/session-bbbb2222-0000-4000-8000-000000000002/session.v4.jsonl.zstd', kind: 'session-log', reason: 'delete-local', sessionId: 'session-bbbb2222-0000-4000-8000-000000000002', title: '会话二', theirsCopy: 'files/3-theirs' },
    ],
  }],
  lastRun: {
    runId: 'r1', direction: 'pull', scope: 'session', running: false, durationMs: 4200,
    error: null, result: { applied: [{ added: true }], merged: [{ path: 'a' }], pushed: [], conflicts: [] },
  },
  current: { runId: 'r2', direction: 'push', scope: 'all', running: true, startedAt: Date.now(), durationMs: 900 },
};

const routeState = { pingRunning: true, pingPending: 2 };
const ROUTES = {
  'status': (body) => { void body; return STATUS; },
  'ping': () => ({ ok: true, running: routeState.pingRunning, pendingCount: routeState.pingPending, remote: STATUS.remote, showSidebarButton: true }),
  'progress': () => ({
    ok: true,
    running: true,
    next: 4,
    entries: [
      { n: 1, t: Date.now(), level: 'step', stage: 'start', text: '开始推送' },
      { n: 2, t: Date.now(), level: 'info', stage: 'fetch', text: 'remote: Total 17' },
      { n: 3, t: Date.now(), level: 'warn', stage: 'conflict', text: '会话一：双方都改动过' },
    ],
    summary: { runId: 'r2', direction: 'push', scope: 'all', running: true, durationMs: 900, error: null, result: null },
  }),
  'pending/preview': () => ({
    ok: true, kind: 'session', sessionId: 'x',
    local: { ok: true, events: 12, messages: [{ role: 'user', text: '本机内容' }, { role: 'assistant', text: '本机回复' }] },
    remote: { ok: true, events: 10, messages: [{ role: 'user', text: '远端内容' }] },
  }),
  'config': () => ({ ok: true, configPath: '/home/alice/.dsh/chat-sync.json' }),
  'units': () => ({
    ok: true,
    ignore: { sessions: ['session-bbbb2222-0000-4000-8000-000000000002'], workspaces: [], workspaceFiles: {} },
    units: [
      { path: 'sessions/x/session-aaaa1111-0000-4000-8000-000000000001/session.v4.jsonl.zstd', state: 'A5', stateLabel: '两边都改了·需裁决', kind: 'session-log', sessionId: 'session-aaaa1111-0000-4000-8000-000000000001', title: '会话一', muted: false, pending: true, needsDecision: true },
      { path: 'sessions/x/session-bbbb2222-0000-4000-8000-000000000002/session.v4.jsonl.zstd', state: 'IGNORED', stateLabel: '已忽略', kind: 'session-log', sessionId: 'session-bbbb2222-0000-4000-8000-000000000002', title: '会话二', muted: true, pending: false, needsDecision: false },
      { path: 'settings.yaml', state: 'A2', stateLabel: '仅本机改了', kind: 'text', sessionId: null, title: '', muted: false, pending: false, needsDecision: false },
    ],
  }),
  'ignore': () => ({ ok: true, ignore: { sessions: [], workspaces: [], workspaceFiles: {} } }),
  'align': () => ({ ok: true, upToDate: true, ahead: 2, behind: 0 }),
  'force': () => ({ ok: true, mode: 'push', path: 'x' }),
  'session/repair': () => ({
    ok: true, rel: 'sessions/x/session-cccc3333-0000-4000-8000-000000000003/session.v4.jsonl.zstd',
    totalRows: 2974, keepRows: 2792, dropRows: 182,
    firstProblem: { line: 2793, reason: 'rewind', expected: 2792, got: 1789 },
    problemCount: 1, droppedTypes: ['agent/inbox/spliced', 'turn/start', 'turn/end'],
    droppedFrom: 1792110814778, droppedTo: 1792111162841, bytes: 3706496,
  }),
  'workspace/ignore': () => ({
    ok: true, workspaceId: 'ws-1', title: 'proj',
    path: '/home/alice/project/.dsh-chat-sync-ignore', exists: true,
    content: '# 我的规则\ndist/\n',
  }),
  'run': () => ({ ok: true, runId: 'r3' }),
  'workspace/path': () => ({ ok: true }),
  'pending/resolve': (body) => ({ ok: true, remaining: 1, detail: { resolved: (body?.decisions || []).map((d) => ({ id: d.id, choice: d.choice })), both: [] } }),
  'pending/discard': () => ({ ok: true }),
};

const fetchLog = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const key = Object.keys(ROUTES).find((k) => u.includes('/chat-sync/api/' + k));
  fetchLog.push({ url: u, method: (opts && opts.method) || 'GET' });
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (body) fetchLog[fetchLog.length - 1].body = body;
  const data = key ? ROUTES[key](body) : { ok: false, error: 'no route ' + u };
  return { ok: true, json: async () => data };
};

/* ================= 加载 client.js ================= */
function loadClient() {
  const captured = { def: null };
  const window = {
    __ModuleLoader__: { load(def) { captured.def = def; } },
    prompt: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const code = fs.readFileSync(CLIENT, 'utf8');
  const fn = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'console', code);
  fn(window, { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, style: {} }) }, globalThis.fetch,
    () => 0, () => {}, console);
  assert.ok(captured.def, 'client.js 没有调用 window.__ModuleLoader__.load');
  assert.equal(captured.def.id, '@charara97/dsh-session-sync');
  const mod = captured.def.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  return mod;
}

/* ================= 渲染器 ================= */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.$$el) return textOf(node.props.children);
  return '';
}

function renderTree(node, keyPath, out, labelCtx = '') {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { node.forEach((n, i) => renderTree(n, keyPath + '.' + i, out, labelCtx)); return; }
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return; }
  if (!node.$$el) return;
  const { type, props } = node;
  if (typeof type === 'function') {
    const inst = getInstance(keyPath + ':' + (type.name || 'Anon'));
    const prev = currentInstance;
    const prevCursor = hookCursor;
    currentInstance = inst;
    hookCursor = 0;
    let rendered;
    try {
      rendered = type(props);
    } finally {
      currentInstance = prev;
      hookCursor = prevCursor;
    }
    renderTree(rendered, keyPath + '/' + (type.name || 'Anon'), out, labelCtx);
    return;
  }
  out.tags.push(String(type));
  if (props.className) out.classes.push(String(props.className));
  // <label> 包住的控件用 label 的文本作为可定位标签（复选框就是这样）
  const inner = type === 'label' ? textOf(props.children) : labelCtx;
  if (typeof props.onClick === 'function') {
    out.handlers.push({ className: String(props.className || ''), label: textOf(props.children) || labelCtx, onClick: props.onClick });
  }
  if (typeof props.onChange === 'function') {
    out.handlers.push({ className: String(props.className || ''), label: inner, onChange: props.onChange });
  }
  renderTree(props.children, keyPath + '>' + type, out, inner);
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function renderComponent(Component, props, { rounds = 8, clickSidebar = false, fresh = false } = {}) {
  if (fresh) instances.clear();
  const seen = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const inst of instances.values()) inst.dirty = false;
    effectQueue.length = 0;
    const out = { tags: [], classes: [], text: [], handlers: [] };
    currentInstance = null;
    hookCursor = 0;
    const tree = React.createElement(Component, props);
    renderTree(tree, 'root', out);
    seen.push(out);

    if (clickSidebar && round === 0) {
      const btn = out.handlers.find((h) => h.className.includes('dcs-side'));
      if (btn) btn.onClick();
    }

    // 执行本次收集到的 effects（它们会触发异步 fetch）
    if (effectQueue.length) {
      for (const e of effectQueue) {
        if (e.hook.cleanup) { try { e.hook.cleanup(); } catch { /* ignore */ } }
        try {
          const c = e.fn();
          if (typeof c === 'function') e.hook.cleanup = c;
        } catch (err) {
          throw new Error(`effect 抛异常：${err && err.message}`);
        }
      }
      // 等 fetch 的 promise 链落地
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    }

    const anyDirty = [...instances.values()].some((i) => i.dirty);
    if (!anyDirty) break;
  }
  return seen;
}

/* ================= 用例 ================= */
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    results.push(['fail', name, err]);
    process.stdout.write(`  ✗ ${name}\n    ${err && err.message}\n`);
  }
}

async function main() {
  const mod = loadClient();
  const registrations = [];
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (k) => ({ title: '会话同步', openPanel: '打开面板', running: '同步中…' }[k] || k),
    },
    slots: {
      // 与真实 Cordis 一致：inject 先登记槽位，再执行回调，回调里调 register。
      inject: (key, cb) => {
        const rec = { key };
        registrations.push(rec);
        rec.effect = cb();
        return () => {};
      },
      register: (opts, Component) => {
        const rec = registrations[registrations.length - 1];
        rec.opts = opts;
        rec.Component = Component;
        return () => {};
      },
    },
    effect: (fn) => { fn(); return () => {}; },
  };
  mod.apply(ctx);

  const byId = new Map(registrations.filter((r) => r.opts).map((r) => [r.opts.id, r]));

  await step('三个槽位都注册了，且 id / order / label 合法', () => {
    const ids = [...byId.keys()].sort();
    assert.deepEqual(ids, ['dsh-chat-sync-button', 'dsh-chat-sync-overlay', 'dsh-chat-sync-section']);
    for (const r of byId.values()) {
      assert.equal(typeof r.opts.id, 'string');
      assert.ok(!Number.isNaN(Number(r.opts.order)), 'order 要是数字');
      assert.ok(['sidebar.footer.action', 'shell.overlay', 'settings.section'].includes(r.opts.name));
    }
  });

  await step('设置页渲染：状态卡 / 两组分段控件 / 复选框 / 开始按钮都在', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, {});
    const last = rounds[rounds.length - 1];
    assert.ok(last.text.join(' ').includes('会话同步'), '页头没渲染出来');
    assert.ok(last.text.join(' ').includes('推送（本机 → 远端）'), '方向分段控件缺标签');
    assert.ok(last.text.join(' ').includes('全部会话'), '范围分段控件缺标签');
    assert.ok(last.text.join(' ').includes('同时同步工作区里的项目文件'), '工作区复选框缺标签');
    assert.ok(last.text.join(' ').includes('在侧栏左下角显示同步按钮'), '侧栏按钮开关缺标签');
    assert.ok(last.text.join(' ').includes('开始推送'), '开始按钮缺标签');
    assert.ok(last.classes.some((c) => c.includes('dcs-seg-ind')), '分段控件没有指示块');
    assert.ok(last.classes.some((c) => c.includes('dcs-btn-primary')), '没有主按钮');
  });

  await step('渲染过程没有抛异常，并且真的读了后端状态', async () => {
    assert.ok(fetchLog.some((f) => f.url.includes('/status')), '没有请求 status');
    assert.ok(fetchLog.filter((f) => f.url.includes('/status')).length <= 3, 'status 被反复请求（轮询失控？）');
  });

  await step('拉到状态后：会话列表 / 工作区 / 冲突卡均可渲染', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, {});
    const all = rounds.map((r) => r.text.join(' ')).join('\n');
    assert.ok(all.includes('https://github.com/alice/dsh-sync.git'), '远端地址没显示');
    assert.ok(all.includes('领先 0 / 落后 0'), '仓库状态没显示');
    assert.ok(all.includes('待裁决冲突'), '冲突卡没显示');
    assert.ok(all.includes('保留本机') && all.includes('采用远端') && all.includes('两边都留'), '裁决选项缺项');
  });

  await step('勾上工作区后：工作区列表带本机路径与来源说明', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const before = await renderComponent(section, {});
    const box = before.flatMap((r) => r.handlers).find((h) => h.onChange && h.label.includes('同时同步工作区里的项目文件'));
    assert.ok(box, '没有找到工作区复选框');
    box.onChange({ target: { checked: true } });
    const after = await renderComponent(section, {});
    const text = after.map((r) => r.text.join(' ')).join('\n');
    assert.ok(text.includes('按本机主目录改写'), '工作区路径来源说明没显示');
    assert.ok(text.includes('/home/alice/project'), '工作区本机路径没显示');
    assert.ok(text.includes('本机不存在，取回时创建'), '缺失目录提示没显示');
    assert.ok(text.includes('改路径'), '缺少「改路径」按钮');
  });

  await step('切到「单个会话」后：会话列表、状态标记、工作区行都渲染', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const first = await renderComponent(section, {});
    const tab = first.flatMap((r) => r.handlers).find((h) => h.label === '单个会话');
    assert.ok(tab, '没有找到「单个会话」分段项');
    tab.onClick();
    const after = await renderComponent(section, {});
    const text = after.map((r) => r.text.join(' ')).join('\n');
    assert.ok(text.includes('会话一'), '会话标题没显示');
    assert.ok(text.includes('与远端不同'), '会话状态标记没显示');
    assert.ok(text.includes('仅本机'), '未分组会话的状态标记没显示');
    assert.ok(text.includes('未分组'), '未归属会话应显示「未分组」');
    const classes = after.flatMap((r) => r.classes);
    assert.ok(classes.some((c) => c.includes('dcs-pill')), '状态胶囊的类名不对');
  });

  await step('运行中：过程日志逐行渲染，级别类名正确', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, {});
    const last = rounds[rounds.length - 1];
    const text = last.text.join('\n');
    assert.ok(text.includes('开始推送'), '过程日志第一条没渲染');
    assert.ok(text.includes('双方都改动过'), '过程日志的警告行没渲染');
    assert.ok(last.classes.some((c) => c === 'l-warn'), '警告级别类名不对');
    assert.ok(last.classes.some((c) => c === 'l-step'), '阶段级别类名不对');
    assert.ok(last.classes.some((c) => c.includes('dcs-spin')), '进行中应该有转圈');
  });

  await step('逐单元状态表：显示每个会话/文件相对远端的差异，并且能忽略', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const text = rounds.map((r) => r.text.join(' ')).join('\n');
    assert.ok(fetchLog.some((f) => f.url.includes('/units')), '没有请求 units');
    assert.ok(text.includes('条目状态'), '缺少逐单元区块标题');
    assert.ok(text.includes('两边都改了·需裁决'), '缺少单元状态文案');
    assert.ok(text.includes('已忽略'), '缺少已忽略标记');
    assert.ok(text.includes('未同步'), '缺少过滤分段控件');
    assert.ok(text.includes('取消忽略'), '被忽略的单元应当提供「取消忽略」');
    assert.ok(text.includes('本机只会落后、不会分叉'), '缺少「不会分叉」的说明');
    assert.ok(text.includes('重新对齐（快进）'), '缺少重新对齐按钮');
    assert.ok(text.includes('用远端覆盖') && text.includes('用本机覆盖'), '缺少强制覆盖按钮');
    // 有一个单元被忽略 → 应当有忽略开关
    const btns = rounds.flatMap((r) => r.handlers).filter((h) => h.onClick);
    assert.ok(btns.length > 0, '没有可点击的按钮');
  });

  await step('工作区忽略规则：能打开编辑器、能保存', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const first = await renderComponent(section, { fresh: true });
    // 范围切回「全部会话」：这样工作区列表才会列出全部工作区
    const allTab = first.flatMap((r) => r.handlers).find((h) => h.onClick && h.label === '全部会话');
    if (allTab) allTab.onClick();
    const box = first.flatMap((r) => r.handlers).find((h) => h.onChange && h.label.includes('同时同步工作区里的项目文件'));
    assert.ok(box, '没有找到工作区复选框');
    box.onChange({ target: { checked: true } });
    const withWs = await renderComponent(section, {});
    const labels = withWs.flatMap((r) => r.handlers).map((h) => h.label).filter(Boolean);
    const wt = withWs.map((r) => r.text.join(' ')).join('\n');
    const igBtn = withWs.flatMap((r) => r.handlers).find((h) => h.onClick && h.label === '忽略规则');
    assert.ok(igBtn, '缺少「忽略规则」按钮');
    igBtn.onClick();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const after = await renderComponent(section, {});
    const text = after.map((r) => r.text.join(' ')).join('\n');
    assert.ok(fetchLog.some((f) => f.url.includes('workspace/ignore')), '没有请求忽略文件');
    assert.ok(text.includes('的忽略规则'), '没有打开忽略规则编辑器');
    assert.ok(text.includes('.dsh-chat-sync-ignore'), '没有显示忽略文件路径');
    assert.ok(text.includes('保存忽略规则'), '缺少保存按钮');
    assert.ok(after.flatMap((r) => r.tags).includes('textarea'), '缺少可编辑的文本域');
  });

  await step('内容类冲突给出三选一', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const text = rounds.map((r) => r.text.join(' ')).join('\n');
    // 现有 fixtures 里的冲突原因是 divergent-session-history / text-overlap → 三选一
    assert.ok(text.includes('保留本机') && text.includes('采用远端') && text.includes('两边都留'), '内容冲突应给三选一');
    assert.ok(text.includes('会话双方均有新增内容，无法拼接'), '冲突原因应显示为正式说法');
  });

  await step('冲突裁决：选中后立刻有计数反馈，且支持部分应用', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const before = rounds[rounds.length - 1];
    const beforeText = before.text.join(' ');
    assert.ok(beforeText.includes('已选 0 / 4'), `未选时应显示「已选 0 / 3」，实际：${beforeText.slice(-200)}`);
    assert.ok(beforeText.includes('应用所选项目'), '未选时按钮应提示先选');

    // 选第一项的「保留本机」
    const localBtns = rounds.flatMap((r) => r.handlers).filter((h) => h.onClick && h.label === '保留本机');
    assert.ok(localBtns.length >= 1, '没有找到「保留本机」选项');
    localBtns[0].onClick();
    const after = await renderComponent(section, {});
    const afterText = after[after.length - 1].text.join(' ');
    assert.ok(afterText.includes('已选 1 / 4'), '选中后计数应当立刻更新');
    assert.ok(afterText.includes('应用所选 1 项'), '按钮文案应当反映已选数量');
    assert.ok(after.flatMap((r) => r.classes).some((c) => c.includes('dcs-seg-ind')), '选中后分段控件应当显示指示块');

    // 点应用 → 只提交已选的那一项
    fetchLog.length = 0;
    const applyBtn = after.flatMap((r) => r.handlers).find((h) => h.onClick && /应用所选/.test(h.label));
    assert.ok(applyBtn, '缺少应用按钮');
    applyBtn.onClick();
    await flush();
    const calls = fetchLog.filter((f) => f.url.includes('pending/resolve'));
    assert.equal(calls.length, 1, `只应向一个待裁决记录提交，实际 ${calls.length} 次`);
    assert.equal(calls[0].body.decisions.length, 1, '只应提交已选的那一项');

    // 反馈必须出现在冲突区里（而不是面板顶部）
    const done = await renderComponent(section, {});
    const doneText = done[done.length - 1].text.join(' ');
    assert.ok(/已应用 \d+ 项/.test(doneText), `冲突区应当就地显示应用结果，实际：${doneText.slice(-260)}`);
    assert.ok(doneText.includes('剩余 1 项待裁决'), '应当显示还剩多少项');
  });

  await step('一键全部设为：每个选项一个按钮，数字只统计支持它的冲突', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const text = rounds.map((r) => r.text.join(' ')).join('\n');
    assert.ok(text.includes('一键全部设为'), '缺少一键全选那一行');
    // 夹具里 4 条：2 条内容类（local/remote/both）+ 1 条 delete-local + 1 条 corrupt-session-log（内容类）
    // → local/remote/both 各 3 项，delete/keep 各 1 项
    assert.ok(text.includes('保留本机（3）'), `内容类计数不对：${text.slice(-420)}`);
    assert.ok(text.includes('采用远端（3）'), '内容类计数不对');
    assert.ok(text.includes('两边都留（3）'), '内容类计数不对');
    assert.ok(text.includes('删除（1）'), '删除类计数不对（应当只有 1 条支持）');
    assert.ok(text.includes('保留（1）'), '删除类计数不对');

    // 点「删除（1）」→ 只应影响那一条，其余保持未选
    const delBtn = rounds.flatMap((r) => r.handlers).find((h) => h.onClick && h.label === '删除（1）');
    assert.ok(delBtn, '缺少「删除（1）」按钮');
    delBtn.onClick();
    const after = await renderComponent(section, {});
    const t2 = after[after.length - 1].text.join(' ');
    assert.ok(t2.includes('已选 1 / 4'), `只应选中 1 项，实际：${t2.slice(-300)}`);
    assert.ok(t2.includes('已把 1 项设为「删除」'), '应当就地说明影响了几项');
    assert.ok(t2.includes('应用所选 1 项'), '主按钮应当反映已选数量');

    // 再点「采用远端（3）」：只覆盖支持它的那 3 项。之前选的那条是删除类、不支持
    // remote，所以保留原选择 —— 总数 1+3=4，而且必须明确告诉用户「另有 1 项保持不变」。
    const rmBtn = after.flatMap((r) => r.handlers).find((h) => h.onClick && h.label === '采用远端（3）');
    assert.ok(rmBtn, '缺少「采用远端（3）」按钮');
    rmBtn.onClick();
    const after2 = await renderComponent(section, {});
    const t3 = after2[after2.length - 1].text.join(' ');
    assert.ok(t3.includes('已把 3 项设为「采用远端」'), `应当说明影响了几项：${t3.slice(-300)}`);
    assert.ok(t3.includes('另有 1 项不支持这个选项'), '必须说明有一项不受影响，否则总数对不上会让人困惑');
    assert.ok(t3.includes('已选 4 / 4'), `删除类那一项应当保留原选择：${t3.slice(-300)}`);
  });

  await step('日志损坏：不是给「保留本机 / 采用远端」，而是给「截断到合法前缀」并显示预览', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const text = rounds.map((r) => r.text.join(' ')).join('\n');
    assert.ok(text.includes('会话日志已损坏'), '应当显示损坏原因');
    assert.ok(text.includes('DSH 会拒绝加载整个会话'), '应当说明后果');
    assert.ok(text.includes('截断到最后一个合法的前缀'), '应当说明修法');

    const pvBtn = rounds.flatMap((r) => r.handlers).find((h) => h.onClick && h.label === '预览修复');
    assert.ok(pvBtn, '缺少「预览修复」按钮');
    pvBtn.onClick();
    await flush();

    const after = await renderComponent(section, {});
    const t2 = after.map((r) => r.text.join(' ')).join('\n');
    assert.ok(fetchLog.some((f) => f.url.includes('session/repair')), '没有请求修复预览');
    assert.ok(t2.includes('共 2974 行：保留 2792 行，丢弃 182 行'), `预览数字没显示：${t2.slice(-400)}`);
    assert.ok(t2.includes('期望 seq 2792，实际 1789'), '预览里应当写明具体问题');
    assert.ok(t2.includes('session-backup'), '应当说明会先备份');
    const doBtn = after.flatMap((r) => r.handlers).find((h) => h.onClick && /确认截断/.test(h.label));
    assert.ok(doBtn, '缺少确认按钮');
    assert.ok(doBtn.label.includes('182'), '确认按钮应当写明要丢弃多少行');

    // 点确认 → 提交 confirm:true
    fetchLog.length = 0;
    doBtn.onClick();
    await flush();
    const call = fetchLog.find((f) => f.url.includes('session/repair'));
    assert.ok(call, '没有提交修复请求');
    assert.equal(call.body.confirm, true, '必须带 confirm=true 才真的截断');
  });

  await step('删除类冲突给出与状态对应的专用说法', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    const rounds = await renderComponent(section, { fresh: true });
    const text = rounds.map((r) => r.text.join(' ')).join('\n');
    assert.ok(text.includes('本机已删除，远端未修改'), '应当显示删除类的原因');
    assert.ok(text.includes('同步删除到远端'), 'delete-local 的第一个选项文案不对');
    assert.ok(text.includes('仅本机删除'), 'delete-local 的第二个选项文案不对');
    assert.ok(text.includes('删除类裁决'), '应当提示这是删除类决定');
  });

  await step('侧栏按钮：运行中显示转圈 +「同步中…」', async () => {
    routeState.pingRunning = true;
    const btn = byId.get('dsh-chat-sync-button').Component;
    const rounds = await renderComponent(btn, { wide: true });
    const last = rounds[rounds.length - 1];
    assert.ok(last.classes.some((c) => c.includes('dcs-side')), '侧栏按钮类名不对');
    assert.ok(last.text.join(' ').includes('同步中…'), '运行中应显示「同步中…」');
    assert.ok(last.classes.some((c) => c.includes('dcs-spin')), '运行中应有转圈');
  });

  await step('侧栏按钮：空闲时显示图标 + 标题', async () => {
    routeState.pingRunning = false;
    const btn = byId.get('dsh-chat-sync-button').Component;
    const rounds = await renderComponent(btn, { wide: true }, { fresh: true });
    const last = rounds[rounds.length - 1];
    assert.ok(last.tags.includes('svg'), '空闲时缺少图标');
    assert.ok(last.text.join(' ').includes('会话同步'), '空闲时缺少标题');
    routeState.pingRunning = true;
  });

  await step('侧栏按钮可以收起成纯图标（wide=false）', async () => {
    const btn = byId.get('dsh-chat-sync-button').Component;
    const rounds = await renderComponent(btn, { wide: false });
    const last = rounds[rounds.length - 1];
    assert.ok(last.classes.some((c) => c.includes('compact')), '收起态应加 compact');
  });

  await step('点侧栏按钮打开浮层，浮层内面板能渲染', async () => {
    const btn = byId.get('dsh-chat-sync-button').Component;
    await renderComponent(btn, { wide: true }, { clickSidebar: true });
    const overlay = byId.get('dsh-chat-sync-overlay').Component;
    const rounds = await renderComponent(overlay, {});
    const last = rounds[rounds.length - 1];
    assert.ok(last.classes.some((c) => c.includes('dcs-overlay')), '浮层没有渲染');
    assert.ok(last.text.join(' ').includes('关闭'), '浮层缺关闭按钮');
  });

  await step('冲突卡点「查看两侧内容」后渲染出两侧对比', async () => {
    const section = byId.get('dsh-chat-sync-section').Component;
    // 先渲染到稳定态，拿到冲突卡里的按钮
    const rounds = await renderComponent(section, {});
    const previewBtn = rounds.flatMap((r) => r.handlers).find((h) => h.label === '查看两侧内容');
    assert.ok(previewBtn, '没有找到「查看两侧内容」按钮');
    previewBtn.onClick();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const after = await renderComponent(section, {});
    const text = after.map((r) => r.text.join(' ')).join('\n');
    assert.ok(fetchLog.some((f) => f.url.includes('pending/preview')), '没有请求冲突预览');
    assert.ok(text.includes('本机内容'), '没有渲染本机一侧的内容');
    assert.ok(text.includes('远端内容'), '没有渲染远端一侧的内容');
  });

  await step('样式约束：两列预览必须可收缩，长串不得撑破容器', () => {
    // 源码断言，不是布局验证。「1fr 的最小尺寸是 auto」是个反复踩到的坑：
    // 内容一长轨道就被撑破，而且两列宽度还会不一致。
    assert.ok(/\.dcs-grid\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(SRC),
      '.dcs-grid 必须用 minmax(0,1fr)：裸 1fr 会被长内容撑破');
    assert.ok(/\.dcs-grid>\*\{min-width:0\}/.test(SRC), '.dcs-grid 的子项必须 min-width:0');
    assert.ok(/\.dcs-pre\{[^}]*overflow-wrap:anywhere/.test(SRC), '.dcs-pre 必须允许长词断行');
    assert.ok(/\.dcs-root\{[^}]*overflow-wrap:anywhere/.test(SRC), '.dcs-root 必须兜底断行');
    assert.ok(!/grid-template-columns:1fr 1fr/.test(SRC), '不应再出现不可收缩的 1fr 1fr');
  });

  const failed = results.filter((r) => r[0] === 'fail');
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) {
    for (const [, name, err] of failed) process.stdout.write(`失败：${name}\n${err && err.stack}\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
