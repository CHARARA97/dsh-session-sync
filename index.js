/**
 * dsh-chat-sync —— DSH 会话与工作区文件同步（宿主端）。
 *
 * 与旧插件（dsh-chatsync）的关系：
 *   - 存储布局一致：DSH HOME 本身是一个 git 仓库（分支默认 main），每个工作区一个
 *     影子仓库推送到同一个 GitHub 私有仓库的 ws/<workspaceId> 分支；
 *   - 操作模型不同：只有显式的 push / pull，范围可选单个会话或全部会话，
 *     工作区文件是同一个操作里的开关，全程写过程日志，冲突一律交给用户裁决。
 *
 * 界面入口：设置 → 同步（settings.section）+ 侧栏底部按钮（sidebar.footer.action）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, summarize, sessionIdOfPath, isSessionLogPath } from './lib/engine.js';
import { decodeSessionLog } from './lib/session.js';
import { clip } from './lib/util.js';

const name = 'dsh-chat-sync';
const inject = ['webServer'];
const PREFIX = '/chat-sync/api/';

function makeLogger(ctx) {
  return (level, msg) => {
    const line = `[dsh-chat-sync] ${msg}`;
    try {
      const l = ctx.logger;
      if (typeof l === 'function') { l(line); return; }
      if (l && typeof l[level] === 'function') { l[level](line); return; }
    } catch { /* 落到 console */ }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/** 从会话日志里抽出「最后几条消息」，用于冲突两侧的对比展示 */
function sessionPreview(buf, max = 12) {
  const decoded = decodeSessionLog(buf);
  if (!decoded) return { ok: false, reason: '无法解码这份会话日志' };
  const msgs = [];
  for (const row of decoded.parsed) {
    if (row.type === 'user/message' && Array.isArray(row.data?.content)) {
      const text = row.data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const images = row.data.content.filter((c) => c.type === 'image').length;
      msgs.push({ role: 'user', time: row.time, text: text || (images ? `（${images} 张图片）` : '(空)') });
    } else if (row.type === 'assistant/message' && Array.isArray(row.data?.message?.content)) {
      const text = row.data.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) msgs.push({ role: 'assistant', time: row.time, text });
    }
  }
  return {
    ok: true,
    id: decoded.header.id,
    cwd: decoded.header.cwd || '',
    events: decoded.rows.length - 1,
    messageCount: msgs.length,
    truncated: msgs.length > max,
    messages: msgs.slice(-max).map((m) => ({ ...m, text: m.text.length > 1200 ? m.text.slice(0, 1199) + '…' : m.text })),
  };
}

function textPreview(buf, maxBytes = 64 * 1024) {
  if (!buf || buf.includes(0)) return { binary: true, bytes: buf ? buf.length : 0 };
  const truncated = buf.length > maxBytes;
  const text = (truncated ? buf.subarray(0, maxBytes) : buf).toString('utf8');
  return { binary: false, bytes: buf.length, truncated, text: truncated ? text + '\n…（已截断）' : text };
}

function apply(ctx, config = {}) {
  const home = config.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const overrides = { ...config };
  delete overrides.home;
  const log = makeLogger(ctx);
  const engine = new SyncEngine(home, overrides, log);
  const disposers = [];

  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const json = (res, code, payload) => {
    try {
      res.writeHead(code, jsonHeaders);
      res.end(JSON.stringify(payload));
    } catch { /* 连接可能已断开 */ }
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
  const readJsonBody = async (req) => {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('请求体必须是 JSON 对象');
    return j;
  };
  const route = (p, handler) => disposers.push(ctx.webServer.register({ kind: 'exact', path: PREFIX + p, handler }));

  /* ================= 状态 ================= */

  route('status', async (req, res) => {
    try {
      const s = await engine.status();
      s.ok = true;
      json(res, 200, s);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /**
   * 轻量心跳：只回答「有没有在跑 / 上次结果 / 有几个待裁决」。
   * 不碰 git、不扫会话 —— 侧栏按钮和面板的空闲轮询用它，避免每几秒起一堆 git 子进程。
   */
  route('ping', (req, res) => {
    try {
      const run = engine.currentRun && engine.currentRun.running ? engine.currentRun : engine.lastRun;
      json(res, 200, {
        ok: true,
        running: engine.busy,
        lastRun: engine.lastRun ? engine.lastRun.summary() : null,
        current: engine.currentRun && engine.currentRun.running ? engine.currentRun.summary() : null,
        pendingCount: engine.listPending().reduce((a, p) => a + p.conflicts.length, 0),
        remote: engine.loadConfig().remote || '',
        showSidebarButton: engine.loadConfig().showSidebarButton !== false,
      });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 配置 ================= */

  route('config', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const c = engine.loadConfig();
        json(res, 200, {
          ok: true,
          config: {
            remote: c.remote || '',
            branch: c.branch,
            proxy: c.proxy || '',
            autoRepo: c.autoRepo !== false,
            repoName: c.repoName,
            repoOwner: c.repoOwner || '',
            commitMessage: c.commitMessage,
            workspaceBranchPrefix: c.workspaceBranchPrefix,
            workspaceBase: c.workspaceBase || '',
            showSidebarButton: c.showSidebarButton !== false,
            workspaceExtraIgnore: c.workspaceExtraIgnore || [],
          },
          configPath: engine.configPath(),
        });
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.remote !== undefined) {
        const v = String(body.remote || '').trim();
        if (v && !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+\/?$/.test(v)) {
          throw new Error('请填写 GitHub 仓库地址（HTTPS 或 SSH），且不要包含访问令牌。');
        }
        patch.remote = v.replace(/\.git$/, '');
      }
      if (body.branch !== undefined) {
        const v = String(body.branch || '').trim();
        if (!v) throw new Error('分支名不能为空。');
        const check = await engine.git(['check-ref-format', '--branch', v], { timeoutMs: 20000 });
        if (!engine.ok(check)) throw new Error('分支名不合法，例如 main。');
        patch.branch = v;
      }
      if (body.proxy !== undefined) patch.proxy = String(body.proxy || '').trim();
      if (body.autoRepo !== undefined) patch.autoRepo = body.autoRepo !== false;
      if (body.repoName !== undefined) {
        const v = String(body.repoName || '').trim();
        if (!/^[\w.-]+$/.test(v)) throw new Error('仓库名仅可包含字母、数字、点、下划线、连字符。');
        patch.repoName = v;
      }
      if (body.repoOwner !== undefined) patch.repoOwner = String(body.repoOwner || '').trim();
      if (body.commitMessage !== undefined) patch.commitMessage = String(body.commitMessage || 'dsh-chat-sync').trim() || 'dsh-chat-sync';
      if (body.showSidebarButton !== undefined) {
        if (typeof body.showSidebarButton !== 'boolean') throw new Error('侧栏按钮开关须为布尔值。');
        patch.showSidebarButton = body.showSidebarButton;
      }
      if (body.workspaceBase !== undefined) {
        const v = String(body.workspaceBase || '').trim();
        if (v && !path.isAbsolute(v)) throw new Error('工作区统一目录须为绝对路径，或留空。');
        patch.workspaceBase = v;
      }
      const saved = engine.writeConfig(patch);
      json(res, 200, { ok: true, config: saved, configPath: engine.configPath() });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 列表 ================= */

  route('sessions', async (req, res) => {
    try {
      const s = await engine.status();
      json(res, 200, { ok: true, sessions: s.sessions || [], workspaces: s.workspaces || [], repo: s.repo });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 工作区本机路径（「换位置」是本机专属设置，不随仓库同步） ================= */

  route('workspace/path', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      const id = String(body.workspaceId || '').trim();
      if (!id) throw new Error('缺少 workspaceId。');
      const raw = String(body.path || '').trim();
      if (raw) {
        const abs = path.resolve(raw);
        if (!path.isAbsolute(raw)) throw new Error('请填写绝对路径。');
        fs.mkdirSync(abs, { recursive: true });
        engine.setWorkspacePathOverride(id, abs);
        json(res, 200, { ok: true, workspaceId: id, path: abs });
      } else {
        engine.setWorkspacePathOverride(id, null);
        const ws = engine.workspaceRecords().find((w) => w.id === id);
        json(res, 200, { ok: true, workspaceId: id, path: ws ? engine.resolveWorkspacePath(ws, engine.loadConfig()).path : null, cleared: true });
      }
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 本机同步偏好：忽略清单 ================= */

  route('ignore', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const c = engine.ignoreConfig();
        json(res, 200, { ok: true, ignore: c, path: engine.ignoreConfigPath() });
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      const patch = {};
      const listOf = (v, what) => {
        if (!Array.isArray(v)) throw new Error(`${what} 须为数组。`);
        return v.map(String);
      };
      if (body.sessions !== undefined) patch.sessions = listOf(body.sessions, '忽略的会话');
      if (body.workspaces !== undefined) patch.workspaces = listOf(body.workspaces, '忽略的工作区');
      if (body.workspaceFiles !== undefined) {
        if (!body.workspaceFiles || typeof body.workspaceFiles !== 'object') throw new Error('workspaceFiles 须为对象。');
        const out = {};
        for (const [k, v] of Object.entries(body.workspaceFiles)) out[String(k)] = listOf(v, '工作区忽略规则');
        patch.workspaceFiles = out;
      }
      if (body.clearDecisions === true) patch.decisions = {};
      const saved = engine.writeIgnoreConfig(patch);
      json(res, 200, { ok: true, ignore: saved, path: engine.ignoreConfigPath() });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 逐单元状态（界面用） ================= */

  route('units', async (req, res) => {
    try {
      const units = await engine.unitStates();
      json(res, 200, { ok: true, units, ignore: engine.ignoreConfig() });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 重新对齐（纯快进，永远安全） ================= */

  route('align', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const r = await engine.alignToRemote();
      json(res, 200, r);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 工作区的忽略规则文件（用户自己编辑的 gitignore 风格文件） ================= */

  const workspaceByRequest = (id) => engine.workspaceRecords().find((w) => w.id === String(id));

  route('workspace/ignore', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost');
        const ws = workspaceByRequest(url.searchParams.get('workspaceId'));
        if (!ws) throw new Error('未找到该工作区。');
        const realPath = engine.resolveWorkspacePath(ws, engine.loadConfig()).path;
        if (!realPath) throw new Error('该工作区在本机无可用路径。');
        const p = engine.workspaceIgnoreFilePath(realPath);
        json(res, 200, {
          ok: true,
          workspaceId: ws.id,
          title: ws.title,
          path: p,
          exists: fs.existsSync(p),
          content: engine.readWorkspaceIgnoreFile(realPath),
        });
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      const ws = workspaceByRequest(body.workspaceId);
      if (!ws) throw new Error('未找到该工作区。');
      const realPath = engine.resolveWorkspacePath(ws, engine.loadConfig()).path;
      if (!realPath) throw new Error('该工作区在本机无可用路径。');
      if (body.create === true) {
        const p = engine.ensureWorkspaceIgnoreFile(realPath, engine.loadConfig());
        json(res, 200, { ok: true, path: p, content: engine.readWorkspaceIgnoreFile(realPath) });
        return;
      }
      if (typeof body.content !== 'string') throw new Error('需要 content（文件全文）。');
      const p = engine.writeWorkspaceIgnoreFile(realPath, body.content);
      json(res, 200, { ok: true, path: p, content: engine.readWorkspaceIgnoreFile(realPath) });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 显式强制覆盖单个单元 ================= */

  route('force', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      const p = String(body.path || '').trim();
      const mode = String(body.mode || '').trim();
      if (!p) throw new Error('缺少 path。');
      if (mode !== 'pull' && mode !== 'push') throw new Error('mode 仅可为 pull（以远端覆盖本机）或 push（以本机覆盖远端）。');
      const r = await engine.forceUnit(p, mode);
      json(res, 200, r);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 执行 push / pull ================= */

  route('run', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      const body = await readJsonBody(req);
      const direction = body.direction === 'pull' ? 'pull' : 'push';
      const scope = body.scope === 'all' ? 'all' : 'session';
      const started = engine.start({
        direction,
        scope,
        sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : [],
        includeWorkspace: body.includeWorkspace === true,
        workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds.map(String) : [],
        reason: typeof body.reason === 'string' ? body.reason : 'web',
      });
      json(res, 200, started);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  route('progress', async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const wantAll = url.searchParams.get('all') === '1';
      const run = engine.currentRun || engine.lastRun;
      if (!run) { json(res, 200, { ok: true, entries: [], running: false, summary: null }); return; }
      const entries = wantAll ? run.progress.all() : run.progress.since(since);
      json(res, 200, {
        ok: true,
        entries,
        next: run.progress.next - 1,
        running: run.running,
        summary: run.summary(),
      });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= 冲突裁决 ================= */

  route('pending', async (req, res) => {
    try {
      const list = engine.listPending();
      json(res, 200, { ok: true, pending: list.map((p) => ({ id: p.id, createdAt: p.createdAt, conflicts: p.conflicts })) });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  route('pending/preview', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      const body = await readJsonBody(req);
      const pending = engine.listPending().find((p) => p.id === body.pendingId);
      if (!pending) throw new Error('未找到该待裁决记录。');
      const c = pending.conflicts.find((x) => x.id === body.conflictId);
      if (!c) throw new Error('未找到该冲突项。');
      const localAbs = c.repo === 'main'
        ? path.join(home, c.path)
        : path.join(engine.workspaceRecords().find((w) => `ws:${w.id}` === c.repo)?.path || '', c.path);
      const theirsAbs = c.theirsCopy ? path.join(pending.dir, c.theirsCopy) : null;
      const localBuf = fs.existsSync(localAbs) ? fs.readFileSync(localAbs) : null;
      const theirsBuf = theirsAbs && fs.existsSync(theirsAbs) ? fs.readFileSync(theirsAbs) : null;
      if (isSessionLogPath(c.path)) {
        json(res, 200, {
          ok: true,
          kind: 'session',
          sessionId: c.sessionId || sessionIdOfPath(c.path),
          local: localBuf ? sessionPreview(localBuf) : { ok: false, reason: '本机没有这个文件' },
          remote: c.theirsDeleted ? { ok: false, reason: '远端删除了这个会话' } : (theirsBuf ? sessionPreview(theirsBuf) : { ok: false, reason: '没有留下远端版本' }),
        });
        return;
      }
      json(res, 200, {
        ok: true,
        kind: 'text',
        local: localBuf ? textPreview(localBuf) : null,
        remote: theirsBuf ? textPreview(theirsBuf) : null,
      });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  route('pending/resolve', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      if (!body.pendingId) throw new Error('缺少 pendingId。');
      const decisions = Array.isArray(body.decisions) ? body.decisions : [];
      for (const d of decisions) {
        if (!d || typeof d.id !== 'string') throw new Error('裁决项须包含 id。');
        if (!['local', 'remote', 'both', 'delete', 'keep'].includes(d.choice)) throw new Error(`未知的裁决：${d.choice}`);
      }
      const r = await engine.resolveConflicts({ pendingId: String(body.pendingId), decisions });
      json(res, 200, r);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  route('pending/discard', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      if (engine.busy) throw new Error('已有同步任务进行中，请稍后重试。');
      const body = await readJsonBody(req);
      if (!body.pendingId) throw new Error('缺少 pendingId。');
      engine.clearPending(String(body.pendingId));
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
  });

  /* ================= Agent 工具 ================= */

  try {
    disposers.push(ctx.tools.register({
      name: 'chat_sync',
      description: [
        '在 GitHub 私有仓库与 DSH 会话 / 工作区文件之间手动同步。',
        'action=push 为推送（本机 → 远端），action=pull 为取回（远端 → 本机）。',
        'scope=all 处理全部会话，scope=session 仅处理 sessionIds 中的会话；',
        'includeWorkspace=true 时同时同步工作区项目文件。',
        '双方均已修改且无法自动合并的条目不会自动选边：操作暂停并返回待裁决冲突；',
        '用 action=conflicts 查看，用 action=resolve 逐项选择 local / remote / both（删除类为 delete / keep）。',
      ].join(''),
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'units', 'push', 'pull', 'conflicts', 'resolve', 'preview', 'ignore', 'align', 'force'],
          description: 'status 查看状态；units 列出各条目相对远端的差异；push/pull 执行同步；'
            + 'conflicts 列出待裁决冲突；resolve 提交裁决；preview 查看某项冲突的两侧内容；'
            + 'ignore 在本机忽略或取消忽略；align 重新对齐（快进）；force 以指定一侧强制覆盖。',
        },
        scope: { type: 'string', enum: ['all', 'session'], description: 'push/pull 的范围，默认 all。' },
        sessionIds: { type: 'array', items: { type: 'string' }, description: 'scope=session 时处理的会话 ID。' },
        includeWorkspace: { type: 'boolean', description: '是否同时同步工作区项目文件。' },
        pendingId: { type: 'string', description: 'action=resolve / preview 的待裁决记录 ID。' },
        conflictId: { type: 'string', description: 'action=preview 的冲突项 ID。' },
        ignore: {
          type: 'object',
          description: 'action=ignore 的本机忽略设置：{ sessions?: string[], workspaces?: string[], workspaceFiles?: { [工作区ID]: string[] } }。省略的字段保持不变。',
        },
        force: {
          type: 'object',
          description: 'action=force 时：{ path: string, mode: "pull" | "push" }。pull 以远端覆盖本机，push 以本机覆盖远端。',
        },
        decisions: {
          type: 'array',
          description: 'action=resolve 的裁决列表。choice=local（保留本机）/ remote（采用远端）/ both（两边都留）；'
            + '删除类冲突用 delete / keep，具体含义随原因而异。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              choice: { type: 'string', enum: ['local', 'remote', 'both', 'delete', 'keep'] },
            },
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args = {}) {
        const action = args.action || 'status';
        if (action === 'status') {
          const s = await engine.status();
          const lines = [
            `本地仓库：${s.repo?.exists ? '已初始化' : '未初始化'}；HEAD ${s.repo?.head || '（无）'}；未提交 ${s.repo?.dirty ?? 0} 项`,
            `远端：${s.remote || '（未配置）'}（分支 ${s.branch}）`,
            s.repo?.remoteHead ? `相对远端：领先 ${s.repo.ahead} 个提交，落后 ${s.repo.behind} 个提交` : '尚未取到远端分支（请先执行一次推送）',
            `会话：本机 ${s.localSessionCount ?? 0}，远端 ${s.remoteSessionCount ?? 0}；工作区 ${s.workspaces?.length ?? 0}`,
            `待裁决冲突：${s.pending?.length ? s.pending.reduce((a, p) => a + p.conflicts.length, 0) + ' 项' : '无'}`,
            s.lastRun ? `上次操作：${s.lastRun.direction}${s.lastRun.running ? '（进行中）' : ''} ${s.lastRun.error || summarize(s.lastRun.result)}` : '尚未执行过同步',
          ];
          return lines.join('\n');
        }
        if (action === 'units') {
          const r = await engine.unitStates();
          if (!r.ok) return r.reason === 'no-remote' ? '远端尚无基线，请先执行一次推送。' : '本机无提交。';
          if (!r.units.length) return '所有条目均与远端一致。';
          return r.units.slice(0, 80).map((u) => `${u.stateLabel}\t${u.title || u.path}${u.sessionId ? '\t' + u.sessionId : ''}`).join('\n')
            + (r.total > 80 ? `\n…共 ${r.total} 项` : '');
        }
        if (action === 'align') {
          const r = await engine.alignToRemote();
          if (!r.ok) return `重新对齐失败：${r.error}`;
          if (r.upToDate) return r.ahead ? `本机已包含远端全部内容（领先 ${r.ahead} 个提交，均为本机此前交付的记录）。` : '本机与远端一致。';
          return '已快进至远端。';
        }
        if (action === 'ignore') {
          const patch = {};
          if (args.ignore && Array.isArray(args.ignore.sessions)) patch.sessions = args.ignore.sessions.map(String);
          if (args.ignore && Array.isArray(args.ignore.workspaces)) patch.workspaces = args.ignore.workspaces.map(String);
          if (args.ignore && args.ignore.workspaceFiles && typeof args.ignore.workspaceFiles === 'object') {
            const wf = {};
            for (const [k, v] of Object.entries(args.ignore.workspaceFiles)) wf[String(k)] = Array.isArray(v) ? v.map(String) : [];
            patch.workspaceFiles = wf;
          }
          if (!Object.keys(patch).length) return `当前本机忽略设置：${JSON.stringify(engine.ignoreConfig())}`;
          const saved = engine.writeIgnoreConfig(patch);
          return `已更新本机忽略设置：${JSON.stringify({ sessions: saved.sessions, workspaces: saved.workspaces, workspaceFiles: saved.workspaceFiles })}`;
        }
        if (action === 'force') {
          if (!args.force || !args.force.path || !args.force.mode) return '需要 force: { path, mode }。';
          const r = await engine.forceUnit(String(args.force.path), String(args.force.mode));
          return r.ok
            ? `${args.force.mode === 'pull' ? '已用远端版本覆盖本机' : '已用本机版本覆盖远端'}：${args.force.path}`
            : `强制覆盖失败：${r.error}`;
        }
        if (action === 'conflicts') {
          const list = engine.listPending();
          if (!list.length) return '当前无待裁决冲突。';
          return list.map((p) => [
            `待裁决记录 ${p.id}（${p.conflicts.length} 项）`,
            ...p.conflicts.map((c) => `  - [${c.id}] ${c.repo === 'main' ? '主数据' : c.repo} ${c.path}${c.title ? `（${c.title}）` : ''} 原因：${c.reason}`),
          ].join('\n')).join('\n');
        }
        if (action === 'preview') {
          if (!args.pendingId || !args.conflictId) return '需要 pendingId 与 conflictId。';
          const pending = engine.listPending().find((p) => p.id === args.pendingId);
          const c = pending?.conflicts.find((x) => x.id === args.conflictId);
          if (!c) return '未找到该冲突项。';
          return [
            `冲突：${c.path}（${c.reason}）`,
            `本机版本：${c.repo === 'main' ? path.join(home, c.path) : c.path}`,
            `远端版本：${c.theirsCopy ? path.join(pending.dir, c.theirsCopy) : '（未留存）'}`,
            '用 action=resolve 选择 local（保留本机）/ remote（采用远端）/ both（两边都留）。',
          ].join('\n');
        }
        if (action === 'resolve') {
          if (!args.pendingId) return '需要 pendingId。';
          const decisions = Array.isArray(args.decisions) ? args.decisions : [];
          if (!decisions.length) return '需要 decisions：[{id, choice}]。';
          const r = await engine.resolveConflicts({ pendingId: args.pendingId, decisions });
          return r.ok ? `裁决已应用（剩余 ${r.remaining ?? 0} 项待裁决）：${JSON.stringify(r.detail)}` : `裁决失败：${r.error}`;
        }
        // push / pull
        const r = await engine.execute({
          direction: action === 'pull' ? 'pull' : 'push',
          scope: args.scope === 'session' ? 'session' : 'all',
          sessionIds: Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : [],
          includeWorkspace: args.includeWorkspace === true,
          reason: 'agent-tool',
        });
        const run = engine.lastRun;
        const lines = (run?.progress.all() || []).map((e) => `${e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·'} ${e.text}`);
        const tail = lines.slice(-60).join('\n');
        return `结果：${r.ok ? '成功' : '未完成'}\n${summarize(r.result)}\n\n过程（最后 60 行）：\n${tail}`;
      },
    }));
  } catch (err) {
    log('warn', '工具注册失败：' + String(err?.message || err));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    disposers.length = 0;
  });

  const cfg = engine.loadConfig();
  log('info', `dsh-chat-sync 已启动（home=${home}，分支=${cfg.branch}，远端=${cfg.remote || '(未配置，首次 push 时可自动创建私有仓库)'}）。`);
  log('info', `界面：设置 → 会话同步；侧栏底部按钮。API 前缀 ${PREFIX}。`);
}

export { name, inject, apply };
