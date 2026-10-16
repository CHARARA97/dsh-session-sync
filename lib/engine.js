/**
 * 同步引擎。
 *
 * 设计取舍（相对旧的 dsh-chatsync）：
 *  1) 只有显式的 push / pull，没有后台自动同步，没有启动/退出钩子 —— 用户按一下才动。
 *  2) 范围可选「单个会话」或「全部会话」；工作区文件是同一个操作里的一个开关。
 *  3) 过程全程写进 ProgressLog，浏览器增量拉取，绝不只有一句结果。
 *  4) 冲突不自动裁决、不静默丢弃：
 *     - 会话日志只有在「严格追加」时才自动合并（本质无冲突）；
 *     - 其他文本文件先让 git 做三路合并（非重叠改动自动合上）；
 *     - 真冲突一律记录下来、把远端版本单独存一份、停在原地等用户选，
 *       pull 会 `git merge --abort` 保证工作树停在操作前的状态。
 *
 * 存储布局与旧插件保持一致，以便复用同一个 GitHub 仓库与已有的同步数据：
 *   - 主数据 = DSH HOME 本身作为一个 git 仓库，分支默认 main；
 *   - 每个工作区一个影子仓库 <HOME>/workspace-repos/<workspaceId>.git，
 *     core.worktree 指向真实项目目录，推送到同一个远端的 ws/<workspaceId> 分支。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  run, humanSize, ts, normRel, zstdDecode, zstdEncode, ZSTD_MAGIC, clip, firstLine, writeFileAtomic,
} from './util.js';
import {
  listLocalSessions, readSessionTitle, decodeSessionLog, mergeSessionLog,
  duplicateSessionLog, newSessionId, projCachePath, SESSION_LOG_RE, inspectSessionLog,
  validateSessionLog,
} from './session.js';
import { RunState, ProgressLog } from './progress.js';

export const DEFAULT_CONFIG = {
  remote: '',
  branch: 'main',
  proxy: '',
  autoRepo: true,
  repoName: 'dsh-sync',
  repoOwner: '',
  repoDescription: '',
  gitUserName: 'dsh-chat-sync',
  gitUserEmail: 'dsh-chat-sync@localhost',
  commitMessage: 'dsh-chat-sync',
  workspaceBranchPrefix: 'ws',
  workspaceExtraIgnore: ['node_modules', '.pnpm-store', '.npm-cache', '.venv', 'dist', 'build'],
  /** 是否在侧栏左下角显示「会话同步」按钮（纯界面偏好，存在 chat-sync.json 里） */
  showSidebarButton: true,
  /** 是否在工作区根目录自动创建 .dsh-chat-sync-ignore（不存在时才创建） */
  createWorkspaceIgnoreFile: true,
  extraIgnore: [],
  /** 从旧插件的 dsh-sync.json 继承的连接类字段（只读，不会写回那个文件） */
  inheritLegacyConfig: true,
};

/** 主仓库 .gitignore：只排除「每台机器各自的状态 / 可再生依赖 / 密钥」 */
export const BUILTIN_IGNORE = [
  '# ===== dsh-chat-sync 自动生成（可手工修改；删除后将于下次操作时重建）=====',
  '',
  '# 机器本地状态 —— 各机器不同，无需同步',
  '.anonymous-user-id',
  '.dshw-size.json',
  '.dshw-usage.json',
  '',
  '# 可再生状态 —— 每次运行均会重写，同步只会产生冲突',
  'cache/',
  'logs/',
  'profiles/web/.dsh-market/',
  'profiles/desktop/.dsh-market/',
  'profiles/desktop/.plugin-manager/',
  '**/*.log',
  '',
  '# 密钥 —— 不上传（跨机器密钥请使用环境变量）',
  '.credentials.yaml',
  '',
  '# 会话投影缓存目录参与同步（标题 / cwd 用于还原「工作区 ↔ 会话」归属）；',
  '# 仅排除同级聚合文件，目录本身保留',
  'storages/session_projcache.json',
  '',
  '# 依赖目录 / pnpm 存储 —— 新机器需各自安装',
  '**/node_modules/',
  '.pnpm-store/',
  '',
  '# profile 清单 / 锁文件 / 组合结果 —— 含本机绝对路径（link: /home/xxx/...），',
  '# 同步过去会让对方的插件依赖指向不存在的目录，反而装不上插件',
  'profiles/*/package.json',
  'profiles/*/pnpm-lock.yaml',
  'profiles/*/pnpm-workspace.yaml',
  '# 启动时按各层补丁重新组合生成，同步没有意义',
  'profiles/*/cordis.yml',
  '',
  '# 同步引擎自身状态',
  '.chat-sync/',
  '.dsh-sync.state.json',
  '.dsh-sync.process.lock',
  '',
  '# 工作区路径覆盖（「换位置」为本机专属设置）',
  'storages/workspace-local-paths.json',
  '',
  '# 工作区影子仓库（独立仓库，不与主仓库混同）',
  'workspace-repos/',
  '**/session.lock',
  'storages/*.bak-*',
  'sessions-archive-*/',
].join('\n');

/** 工作区里用户自己编辑的忽略规则文件名（第一个是新建时用的） */
export const WORKSPACE_IGNORE_NAMES = ['.dsh-chat-sync-ignore', '.dsh-sync-ignore'];

/** 新建忽略文件时写进去的说明（用户随时可以改） */
export const WORKSPACE_IGNORE_TEMPLATE = [
  '# dsh-chat-sync：此工作区在本机的同步忽略规则（每行一条，gitignore 语法）',
  '#',
  '# 本文件不参与同步，属于本机专属设置，各机器可不同。',
  '# 规则同时作用于推送与取回两个方向。',
  '#',
  '# 示例：',
  '#   dist/            整个目录不同步',
  '#   *.log            所有 .log 文件不同步',
  '#   notes/secret.md  单个文件不同步',
  '#   !keep.log        例外：仍参与同步（须置于忽略规则之后）',
  '#',
  '# 说明：项目自身的 .gitignore 已直接生效（git 会读取工作树中的 .gitignore）；',
  '#       本文件用于声明「本机不同步、但项目仍需保留」的内容。',
  '',
].join('\n');

/** 迁移过来的 .gitignore 里必须存在的排除项：同步引擎自己的状态目录 */
const REQUIRED_IGNORE = [
  '.chat-sync/',
  'workspace-repos/',
  // profile 清单含本机绝对路径：同步过去会让对方的插件解析指向不存在的目录
  'profiles/*/package.json',
  'profiles/*/pnpm-lock.yaml',
  'profiles/*/pnpm-workspace.yaml',
  'profiles/*/cordis.yml',
];

const MACHINE_LOCAL_TRACKED = [
  '.credentials.yaml', '.dshw-usage.json', '.dshw-size.json', '.anonymous-user-id',
  '.pnpm-store', 'storages/workspace-local-paths.json', 'cache', 'logs',
  'profiles/*/.dsh-market', 'profiles/*/.plugin-manager',
  // profile 清单 / 锁文件 / 组合结果含本机绝对路径（link:），不能跨机器同步。
  // 用通配符而不是写死 web/desktop —— profile 名是任意的。
  'profiles/*/package.json', 'profiles/*/pnpm-lock.yaml',
  'profiles/*/pnpm-workspace.yaml', 'profiles/*/cordis.yml',
  '.chat-sync', 'workspace-repos',
];

const SESSION_LOG_PATH_RE = /^sessions\/[^/]+\/([^/]+)\/(session(?:\.v\d+)?\.jsonl(?:\.zstd)?)$/i;

function nowStamp() {
  return ts();
}

export class SyncEngine {
  constructor(home, overrides = {}, log = () => {}) {
    this.home = home;
    this.overrides = overrides;
    this.log = log;
    this.gitMissing = false;
    this._ghChecked = undefined;
    this._headerCache = new Map();
    this._sessionCache = null;
    this._cfg = null;
    this.currentRun = null;
    this.inFlight = null;
    this.lastRun = null;
    this._bootstrapAt = 0;
    this._bootstrapError = null;
  }

  /* ================= 配置 ================= */

  configPath() { return path.join(this.home, 'chat-sync.json'); }
  legacyConfigPath() { return path.join(this.home, 'dsh-sync.json'); }

  /**
   * 配置优先级：默认值 < 旧插件 dsh-sync.json 的连接字段 < 本插件 chat-sync.json < 插件加载参数。
   * 读旧文件只是为了让已有的 remote/代理等设置能平滑延续，绝不写回旧文件。
   */
  loadConfig() {
    const cfg = { ...DEFAULT_CONFIG };
    if (DEFAULT_CONFIG.inheritLegacyConfig) {
      const legacy = readJson(this.legacyConfigPath());
      if (legacy && typeof legacy === 'object') {
        for (const k of ['remote', 'branch', 'proxy', 'gitUserName', 'gitUserEmail', 'repoName', 'repoOwner', 'repoDescription', 'workspaceBranchPrefix', 'autoRepo', 'extraIgnore', 'workspaceExtraIgnore']) {
          if (legacy[k] !== undefined) cfg[k] = legacy[k];
        }
      }
    }
    const own = readJson(this.configPath());
    if (own && typeof own === 'object') Object.assign(cfg, own);
    Object.assign(cfg, this.overrides || {});
    return cfg;
  }

  writeConfig(patch) {
    const cur = readJson(this.configPath()) || {};
    const next = { ...cur, ...patch };
    fs.mkdirSync(path.dirname(this.configPath()), { recursive: true });
    fs.writeFileSync(this.configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    this._cfg = null;
    return next;
  }

  /* ================= 子进程 ================= */

  gitEnv(cfg = this._cfg || this.loadConfig()) {
    const env = { ...process.env };
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
    const proxy = String(cfg.proxy || '').trim();
    if (proxy) {
      for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[k] = proxy;
      env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost';
    }
    // 远端要凭据而本机没有/过期时，立刻失败并给出明确报错，而不是弹凭据窗口卡住
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_CREDENTIAL_NONINTERACTIVE = '1';
    env.GCM_INTERACTIVE = 'never';
    return env;
  }

  async git(args, { cwd = null, timeoutMs = 180000, binary = false, onStderr = null, stdin = null, env = null } = {}) {
    const r = await run('git', args, {
      cwd: cwd || this.home,
      env: env ? { ...this.gitEnv(), ...env } : this.gitEnv(),
      timeoutMs,
      binary,
      onStderr,
      stdin,
    });
    if (r.missing) this.gitMissing = true;
    return r;
  }

  /**
   * 工作区影子仓库上的 git（--git-dir + --work-tree）。
   * cwd 必须设成工作树本身：否则相对 pathspec（`add -- <文件>`、`checkout --ours -- <文件>`）
   * 会以 DSH HOME 为基准解析，落到仓库外面而静默失败。
   */
  gitW(gitdir, worktree, args, opts = {}) {
    return this.git(['--git-dir', gitdir, '--work-tree', worktree, ...args], { ...opts, cwd: worktree });
  }

  async gh(args, timeoutMs = 90000) {
    return run('gh', args, { cwd: this.home, timeoutMs });
  }

  async ghAvailable() {
    if (this._ghChecked === undefined) this._ghChecked = (await this.gh(['--version'])).code === 0;
    return this._ghChecked;
  }

  ok(r) { return r && r.code === 0; }

  /* ================= 仓库准备 ================= */

  async ensureRepo(cfg) {
    const gitDir = path.join(this.home, '.git');
    if (!fs.existsSync(gitDir)) {
      const r = await this.git(['init', '-b', cfg.branch || 'main']);
      if (!this.ok(r)) return { ok: false, error: `git init 失败：${clip(r.err || r.code)}` };
    }
    if (cfg.remote) {
      const cur = await this.git(['remote', 'get-url', 'origin']);
      if (!this.ok(cur)) await this.git(['remote', 'add', 'origin', cfg.remote]);
      else if (cur.out.trim().replace(/\/+$/, '') !== String(cfg.remote).replace(/\/+$/, '')) {
        await this.git(['remote', 'set-url', 'origin', cfg.remote]);
      }
      // 只跟随主分支：默认 refspec 会把 ws/* 工作区分支也拉进主仓库
      await this.git(['config', 'remote.origin.fetch', `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`]);
      if (await this.ghAvailable()) await this.git(['config', 'credential.helper', '!gh auth git-credential']);
    }
    await this.git(['config', 'user.name', cfg.gitUserName]);
    await this.git(['config', 'user.email', cfg.gitUserEmail]);
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'core.safecrlf', 'false']);
    await this.git(['config', 'commit.gpgsign', 'false']);
    // 会话日志绝不能交给 git 的行级合并：seq/turn/step 是格式自身的关系，混排会毁掉日志。
    // 这里写进 .git/info/attributes（本机文件，不随仓库同步）。
    try {
      const attrs = await this.git(['rev-parse', '--git-path', 'info/attributes']);
      if (this.ok(attrs)) {
        const p = path.resolve(this.home, attrs.out.trim());
        const rule = 'sessions/**/session*.jsonl* -merge';
        const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        if (!cur.split('\n').some((l) => l.trim() === rule)) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, cur.replace(/\s*$/, '') + '\n' + rule + '\n', 'utf8');
        }
      }
    } catch { /* 属性写失败不阻断同步 */ }
    // .gitignore：不存在就生成；已存在（例如从旧插件迁移过来）只补上本插件必须排除的条目，
    // 绝不整份重写 —— 用户手工加过的规则必须留着。
    const ignorePath = path.join(this.home, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
      fs.writeFileSync(ignorePath, BUILTIN_IGNORE + '\n' + (cfg.extraIgnore || []).join('\n') + '\n', 'utf8');
    } else {
      try {
        const cur = fs.readFileSync(ignorePath, 'utf8');
        const missing = REQUIRED_IGNORE.filter((t) => !cur.split('\n').some((l) => l.trim() === t));
        if (missing.length) {
          fs.writeFileSync(ignorePath, cur.replace(/\s*$/, '\n') + '\n# 由 dsh-chat-sync 补上（同步引擎自身状态）\n' + missing.join('\n') + '\n', 'utf8');
        }
      } catch { /* ignore 写不进去不阻断 */ }
    }
    // 把混进索引的机器本地文件移出跟踪（不删文件）
    try {
      const ls = await this.git(['ls-files', '--', ...MACHINE_LOCAL_TRACKED]);
      if (this.ok(ls) && ls.out.trim()) {
        await this.git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...MACHINE_LOCAL_TRACKED]);
      }
    } catch { /* ignore */ }
    return { ok: true };
  }

  /**
   * remote 为空时用 gh 查找/创建私有仓库。
   * 只复用**已确认私有**的仓库；确认不了就放弃（退化为本地快照），绝不上传。
   */
  async bootstrapRemote(cfg) {
    if (cfg.autoRepo === false) return { remote: null, error: '已关闭自动建仓（autoRepo=false），请先填写远端仓库地址。' };
    if (this._bootstrapAt && Date.now() - this._bootstrapAt < 60000) return { remote: null, error: this._bootstrapError || '刚刚已尝试自动建仓，请稍后重试。' };
    this._bootstrapAt = Date.now();
    this._bootstrapError = null;
    if (!(await this.ghAvailable())) {
      this._bootstrapError = '本机没有可用的 gh（GitHub CLI）。请安装并执行 gh auth login，或在设置里手工填写私有仓库地址。';
      return { remote: null, error: this._bootstrapError };
    }
    const login = await this.gh(['api', 'user', '--jq', '.login']);
    const owner = cfg.repoOwner || (this.ok(login) ? login.out.trim() : '');
    if (!owner) {
      this._bootstrapError = '无法通过 gh 取到 GitHub 账号，请先 gh auth login。';
      return { remote: null, error: this._bootstrapError };
    }
    const repo = cfg.repoName || 'dsh-sync';
    const remote = `https://github.com/${owner}/${repo}.git`;
    const view = await this.gh(['repo', 'view', `${owner}/${repo}`, '--json', 'visibility']);
    if (this.ok(view)) {
      try {
        if (JSON.parse(view.out).visibility !== 'PRIVATE') {
          this._bootstrapError = `${owner}/${repo} 不是私有仓库，本次不会上传。请改用私有仓库。`;
          return { remote: null, error: this._bootstrapError };
        }
      } catch {
        this._bootstrapError = `无法确认 ${owner}/${repo} 的可见性，本次不会上传。`;
        return { remote: null, error: this._bootstrapError };
      }
      this.writeConfig({ remote });
      return { remote, reused: true };
    }
    const args = ['repo', 'create', `${owner}/${repo}`, '--private'];
    if (cfg.repoDescription) args.push('--description', cfg.repoDescription);
    const created = await this.gh(args);
    if (!this.ok(created)) {
      this._bootstrapError = `自动创建私有仓库失败：${clip(created.err || created.code)}。可在 GitHub 手工建仓后填写地址。`;
      return { remote: null, error: this._bootstrapError };
    }
    this.writeConfig({ remote });
    return { remote, created: true };
  }

  /** 上传前确认远端是私有仓库；gh 不可用时只告警（用户是显式配置的地址）。 */
  async guardPrivate(run, remote) {
    const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(remote || '').trim());
    if (!m) {
      run.progress.warn('guard', '远端非 github.com 地址，跳过私有性校验（仅支持 GitHub 托管）。');
      return true;
    }
    if (!(await this.ghAvailable())) {
      run.progress.warn('guard', '本机无 gh，已跳过私有性校验；请自行确认仓库为私有。');
      return true;
    }
    const r = await this.gh(['repo', 'view', `${m[1]}/${m[2]}`, '--json', 'visibility']);
    if (!this.ok(r)) {
      run.progress.warn('guard', `无法确认 ${m[1]}/${m[2]} 的可见性，继续执行（gh: ${clip(r.err || r.code)}）。`);
      return true;
    }
    let vis = '';
    try { vis = JSON.parse(r.out).visibility; } catch { /* fallthrough */ }
    if (vis !== 'PRIVATE') {
      run.progress.error('guard', `${m[1]}/${m[2]} 不是私有仓库，已取消上传。`);
      return false;
    }
    run.progress.info('guard', `已确认远端 ${m[1]}/${m[2]} 为私有仓库。`);
    return true;
  }

  /* ================= 扫描 ================= */

  /** 工作区登记表（storages/workspace.json） */
  workspaceRecords() {
    const j = readJson(path.join(this.home, 'storages', 'workspace.json'));
    const tables = j?.tables?.workspaces ?? {};
    const homeNorm = path.resolve(this.home);
    const out = [];
    for (const [id, w] of Object.entries(tables)) {
      if (!w || typeof w.path !== 'string' || !w.path) continue;
      if (path.resolve(w.path) === homeNorm) continue; // .dsh 自己不做工作区同步
      out.push({
        id,
        path: w.path,
        title: typeof w.title === 'string' && w.title ? w.title : path.basename(w.path) || id,
        sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.slice() : [],
      });
    }
    out.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    return out;
  }

  sessionToWorkspace() {
    const map = new Map();
    for (const w of this.workspaceRecords()) for (const sid of w.sessionIds) map.set(sid, w.id);
    return map;
  }

  /** 本机会话（带标题、归属工作区、文件路径） */
  localSessions() {
    const list = listLocalSessions(this.home, this._headerCache);
    const owner = this.sessionToWorkspace();
    for (const s of list) {
      s.title = readSessionTitle(this.home, s.id);
      s.workspaceId = owner.get(s.id) || null;
    }
    list.sort((a, b) => b.mtime - a.mtime);
    return list;
  }

  /** 远端分支上的文件树：relPath → blob sha */
  async remoteTree(branch) {
    const ref = `refs/remotes/origin/${branch}`;
    const head = await this.git(['rev-parse', '--verify', ref]);
    if (!this.ok(head)) return { exists: false, head: null, files: new Map() };
    const r = await this.git(['ls-tree', '-r', '-z', ref]);
    const files = new Map();
    if (this.ok(r)) {
      for (const rec of r.out.split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const meta = rec.slice(0, tab).split(' ');
        files.set(normRel(rec.slice(tab + 1)), meta[2]);
      }
    }
    return { exists: true, head: head.out.trim(), files };
  }

  /** 本地文件的内容 sha（与 remoteTree 的 sha 可直接比较） */
  async localBlobShas(relPaths) {
    const out = new Map();
    const list = relPaths.filter((p) => p && fs.existsSync(path.join(this.home, p)));
    if (!list.length) return out;
    // git hash-object 支持一次传多个文件，输出与输入同序
    const CHUNK = 200;
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      const r = await this.git(['hash-object', '--', ...slice], { timeoutMs: 60000 });
      if (!this.ok(r)) continue;
      const shas = r.out.trim().split('\n');
      slice.forEach((p, idx) => { if (shas[idx]) out.set(p, shas[idx].trim()); });
    }
    return out;
  }

  /* ================= 工作区影子仓库 ================= */

  workspaceGitDir(id) { return path.join(this.home, 'workspace-repos', id + '.git'); }
  workspaceBranch(cfg, id) { return `${cfg.workspaceBranchPrefix || 'ws'}/${id}`; }

  /** 一个仓库对应的远端分支名：主仓库用 cfg.branch，工作区用 ws/<id> */
  branchOfRepo(repo, cfg) {
    const r = String(repo || 'main');
    if (r.startsWith('ws:')) return this.workspaceBranch(cfg, r.slice(3));
    return cfg.branch;
  }

  /** 本机的工作区路径覆盖（「换位置」是本机专属设置，不随仓库同步） */
  workspacePathOverrides() {
    const j = readJson(path.join(this.home, 'storages', 'workspace-local-paths.json'));
    const o = j && typeof j.overrides === 'object' && j.overrides ? j.overrides : {};
    return o;
  }

  setWorkspacePathOverride(id, p) {
    const file = path.join(this.home, 'storages', 'workspace-local-paths.json');
    const j = readJson(file) || {};
    if (!j.overrides || typeof j.overrides !== 'object') j.overrides = {};
    if (p) j.overrides[id] = String(p);
    else delete j.overrides[id];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
    return p || null;
  }

  /**
   * 解析一个工作区在【本机】应该使用的真实目录。
   * 顺序：本机覆盖 → workspaceBase 配置 → 记录路径（本机存在）→ 主目录前缀重映射。
   * 换台电脑时用户名往往不同（/home/alice/x → /home/bob/x），不重映射就会往
   * 一个本机并不存在的绝对路径里写东西。
   */
  resolveWorkspacePath(ws, cfg) {
    const override = this.workspacePathOverrides()[ws.id];
    if (typeof override === 'string' && override.trim()) return { path: override.trim(), source: 'override' };
    const base = String(cfg.workspaceBase || '').trim();
    if (base) return { path: path.join(base, path.basename(ws.path)), source: 'base' };
    const recorded = String(ws.path || '');
    if (!recorded) return { path: null, source: 'none' };
    if (fs.existsSync(recorded)) return { path: recorded, source: 'recorded' };
    const remapped = remapHomePrefix(recorded);
    if (remapped && remapped !== recorded) return { path: remapped, source: 'remapped', recorded };
    return { path: recorded, source: 'recorded' };
  }

  async ensureWorkspaceMirror(id, realPath, cfg) {
    const gitdir = this.workspaceGitDir(id);
    const branch = this.workspaceBranch(cfg, id);
    if (!fs.existsSync(gitdir)) {
      fs.mkdirSync(path.dirname(gitdir), { recursive: true });
      const init = await this.git(['init', '--bare', gitdir]);
      if (!this.ok(init)) return { ok: false, error: `工作区影子仓库初始化失败：${clip(init.err || init.code)}` };
      await this.gitW(gitdir, realPath, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
      await this.gitW(gitdir, realPath, ['config', 'commit.gpgsign', 'false']);
    }
    await this.gitW(gitdir, realPath, ['config', 'core.bare', 'false']);
    await this.gitW(gitdir, realPath, ['config', 'core.worktree', realPath]);
    await this.gitW(gitdir, realPath, ['config', 'core.autocrlf', 'false']);
    await this.gitW(gitdir, realPath, ['config', 'core.safecrlf', 'false']);
    await this.gitW(gitdir, realPath, ['config', 'user.name', cfg.gitUserName]);
    await this.gitW(gitdir, realPath, ['config', 'user.email', cfg.gitUserEmail]);
    if (cfg.remote) {
      const cur = await this.gitW(gitdir, realPath, ['remote', 'get-url', 'origin']);
      if (!this.ok(cur)) await this.gitW(gitdir, realPath, ['remote', 'add', 'origin', cfg.remote]);
      else if (cur.out.trim().replace(/\/+$/, '') !== String(cfg.remote).replace(/\/+$/, '')) {
        await this.gitW(gitdir, realPath, ['remote', 'set-url', 'origin', cfg.remote]);
      }
      await this.gitW(gitdir, realPath, ['config', 'remote.origin.fetch', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    }
    const nested = this.findNestedRepos(realPath);
    // 忽略规则写进影子仓库的 info/exclude —— 不往用户的真实项目文件夹里塞东西。
    // 两类条目写法不同，绝不能一律加尾斜杠（`*.log/` 是无效规则）：
    //   目录名            → 带尾斜杠
    //   用户的 gitignore 规则 → 原样透传（含 ! 例外）
    try {
      const exclPath = path.join(gitdir, 'info', 'exclude');
      const dirs = new Set(['.git']);
      for (const x of ['node_modules', '.pnpm-store', '.npm-cache', ...(cfg.workspaceExtraIgnore || [])]) {
        const t = String(x || '').trim().replace(/^\/+|\/+$/g, '');
        if (t) dirs.add(t);
      }
      // 嵌套 git 仓库（任意层级，含空仓库）：父仓库会记成 gitlink → 提交必失败。
      // git 只会给它们记一个 gitlink，不会带上内容，所以只能排除；
      // 它们想被同步就必须各自作为独立工作区（在 DSH 里打开那个目录）。
      for (const np of nested) dirs.add(np);
      // 已发现的嵌套 git 仓库（任意层级）—— 上次同步时由 git 自己报出来的
      for (const gp of this.knownGitlinks(id)) {
        const t = String(gp || '').trim().replace(/^\/+|\/+$/g, '');
        if (t) dirs.add(t);
      }
      const userRules = this.workspaceIgnoreRules(id, realPath);
      const lines = [
        '# 由 dsh-chat-sync 生成 —— 手工改动会在下次同步时被覆盖',
        `# 要加自己的规则，请编辑 ${this.workspaceIgnoreFilePath(realPath)}`,
        '',
        '# 依赖目录 / 嵌套 git 仓库（自动排除）',
        ...[...dirs].map((d) => d + '/'),
        '',
      ];
      if (userRules.length) lines.push('# 本机忽略规则（来自忽略文件与配置）', ...userRules, '');
      lines.push('# 忽略规则文件本身不参与同步（它是本机专属设置）', ...WORKSPACE_IGNORE_NAMES, '');
      fs.mkdirSync(path.dirname(exclPath), { recursive: true });
      fs.writeFileSync(exclPath, lines.join('\n'), 'utf8');
    } catch { /* ignore */ }
    return { ok: true, gitdir, branch, nested };
  }

  /* ================= 三路文本合并 ================= */

  tmpDir() {
    const d = path.join(this.home, '.chat-sync', 'tmp');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  pendingRoot() { return path.join(this.home, '.chat-sync', 'pending'); }

  /**
   * 用 git 自己的三路合并处理普通文本文件：非重叠改动能自动合上。
   * 这正是旧插件「非本质冲突也不合并」的反面。
   * @returns {{ok:true,text:string}|{ok:false,reason:string,marked?:string}}
   */
  async threeWayMerge(relPath, baseText, oursText, theirsText) {
    const dir = this.tmpDir();
    const tag = randomUUID().slice(0, 8);
    const fBase = path.join(dir, `${tag}.base`);
    const fOurs = path.join(dir, `${tag}.ours`);
    const fTheirs = path.join(dir, `${tag}.theirs`);
    try {
      fs.writeFileSync(fBase, baseText ?? '');
      fs.writeFileSync(fOurs, oursText ?? '');
      fs.writeFileSync(fTheirs, theirsText ?? '');
      // --diff3 让冲突块同时给出三方内容；-p 输出到 stdout
      const r = await this.git(['merge-file', '-p', '--diff3', fOurs, fBase, fTheirs], { timeoutMs: 60000 });
      const text = r.out;
      if (r.code === 0) {
        if (/\.json$/i.test(relPath)) {
          try { JSON.parse(text); } catch { return { ok: false, reason: 'json-invalid-after-merge' }; }
        }
        return { ok: true, text };
      }
      if (r.code > 0) return { ok: false, reason: 'text-overlap', marked: text };
      return { ok: false, reason: 'merge-file-failed' };
    } finally {
      for (const f of [fBase, fOurs, fTheirs]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }
  }

  /* ================= 冲突暂存 ================= */

  newPendingStore(run) {
    const id = `${ts()}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.pendingRoot(), id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    return { id, dir, conflicts: [], _n: 0 };
  }

  savePending(store) {
    const manifest = { ...store, id: store.id, dir: undefined, createdAt: Date.now() };
    delete manifest.dir;
    fs.writeFileSync(path.join(store.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  /** 记录一个冲突：远端版本单独落盘，本机文件一个字节都不动 */
  async recordConflict(store, { repo, relPath, kind, reason, baseRef, theirsRef, localRef, side = 'pull', ...extra }) {
    // 同一个路径在同一轮里可能被两条路径先后发现（会话预合并 + git 合并）。
    // 它们描述的是同一件事，按 id 去重，避免界面上出现两条一模一样的冲突。
    const id = `${repo}:${relPath}`;
    const already = store.conflicts.find((x) => x.id === id);
    if (already) return already;
    const n = ++store._n;
    const theirsFile = path.join(store.dir, 'files', `${n}-theirs`);
    let theirsOk = false;
    try {
      if (theirsRef === null) {
        // 远端删除了这个文件：没有内容可留档
      } else if (Buffer.isBuffer(theirsRef) || typeof theirsRef === 'string') {
        fs.writeFileSync(theirsFile, theirsRef);
        theirsOk = true;
      } else {
        const r = await this.git(['show', theirsRef], { binary: true, timeoutMs: 120000 });
        if (this.ok(r)) { fs.writeFileSync(theirsFile, r.out); theirsOk = true; }
      }
    } catch { /* 取不到就只记录路径，稍后预览会说明 */ }
    const conflict = {
      id,
      repo,
      side,
      path: relPath,
      kind,
      reason,
      baseRef: baseRef || null,
      theirsRef: theirsRef === null ? null : (Buffer.isBuffer(theirsRef) || typeof theirsRef === 'string' ? '(inline)' : theirsRef),
      localRef: localRef || null,
      theirsCopy: theirsOk ? path.relative(store.dir, theirsFile).replace(/\\/g, '/') : null,
      theirsDeleted: theirsRef === null,
      ...extra,
    };
    store.conflicts.push(conflict);
    return conflict;
  }

  /** 列出所有待裁决的冲突 */
  listPending() {
    const root = this.pendingRoot();
    const out = [];
    let ids = [];
    try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const id of ids) {
      const manifestPath = path.join(root, id, 'manifest.json');
      const j = readJson(manifestPath);
      if (!j) continue;
      out.push({ ...j, id, dir: path.join(root, id) });
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  /** 把某个路径从待裁决记录里摘掉（用于「强制覆盖」这种显式决定）；记录空了就整条删除 */
  clearPendingForPath(repo, relPath) {
    let changed = false;
    for (const p of this.listPending()) {
      const before = p.conflicts.length;
      const rest = p.conflicts.filter((c) => !(c.repo === repo && c.path === relPath));
      if (rest.length === before) continue;
      changed = true;
      if (!rest.length) { this.clearPending(p.id); continue; }
      const manifest = { ...p, conflicts: rest, id: p.id };
      delete manifest.dir;
      fs.writeFileSync(path.join(p.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    }
    return changed;
  }

  clearPending(id) {
    const dir = path.join(this.pendingRoot(), id);
    if (!dir.startsWith(this.pendingRoot())) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ================= 归属 / 范围解析 ================= */

  /**
   * 把「范围」翻译成一串主仓库相对路径。
   * all → 整个仓库；session → 选中会话的目录 + 投影缓存 + 工作区登记表。
   */
  resolveMainPaths(opts) {
    if (opts.scope === 'all') return { mode: 'all', paths: [], sessionIds: [] };
    const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds.filter(Boolean) : [];
    if (!ids.length) throw new Error('请选择至少一个会话，或改为「全部会话」。');
    const sessions = this.localSessions().filter((s) => ids.includes(s.id));
    const paths = new Set();
    const found = new Set();
    for (const s of sessions) {
      found.add(s.id);
      paths.add(s.relDir);
      const pc = projCachePath(this.home, s.id);
      if (fs.existsSync(pc)) paths.add(normRel(path.relative(this.home, pc)));
    }
    paths.add('storages/workspace.json');
    const missing = ids.filter((id) => !found.has(id));
    return { mode: 'session', paths: [...paths], sessionIds: [...found], missing };
  }

  /* ================= fetch ================= */

  /**
   * fetch 主仓库。
   * 关键细节：远端还是空仓库时 `git fetch origin --prune` 会以
   * 「无法找到远程引用 refs/heads/<branch>」失败 —— 那不是错误，
   * 而是「第一次上传」的正常起点。这里用 ls-remote 区分这两者。
   * @returns {{ok:true, remoteMissing?:boolean}|{ok:false, error:string}}
   */
  async fetchMain(run, cfg) {
    const fetch = await this.git(['fetch', 'origin', '--prune', '--progress'], {
      timeoutMs: 600000,
      onStderr: (d) => logTransfer(run.progress, 'fetch', d),
    });
    if (this.ok(fetch)) return { ok: true };
    const probe = await this.git(['ls-remote', '--heads', 'origin', `refs/heads/${cfg.branch}`], { timeoutMs: 120000 });
    if (this.ok(probe) && !probe.out.trim()) {
      run.progress.info('fetch', `远端尚无 ${cfg.branch} 分支，执行首次上传。`);
      return { ok: true, remoteMissing: true };
    }
    return { ok: false, error: authOrFetchError(fetch) };
  }

  /* ================= 运行入口 ================= */

  /** 当前是否已有一次操作在跑 */
  get busy() { return Boolean(this.inFlight); }

  /**
   * 执行一次 push 或 pull。同一时刻只允许一个操作。
   * @param {{direction:'push'|'pull', scope:'session'|'all', sessionIds?:string[],
   *          includeWorkspace?:boolean, workspaceIds?:string[], reason?:string}} opts
   */
  execute(opts) {
    if (this.inFlight) {
      return Promise.resolve({ ok: false, error: '已有同步任务进行中，请稍后重试。', runId: this.currentRun?.runId || null });
    }
    const run = new RunState({
      runId: randomUUID(),
      direction: opts.direction,
      scope: opts.scope,
      reason: opts.reason || '',
    });
    this.currentRun = run;
    const p = (async () => {
      try {
        this._cfg = this.loadConfig();
        if (this.gitMissing) throw new Error('本机没有找到 git，请先安装 Git 后重试。');
        const probe = await this.git(['--version'], { timeoutMs: 20000 });
        if (this.gitMissing || !this.ok(probe)) throw new Error('本机没有找到 git，请先安装 Git 后重试。');
        // 上一次可能被中断（合并停在半路）—— 先恢复干净再开始
        await this.recoverInterruptedMerge(run);
        run.progress.step('start', `${opts.direction === 'push' ? '推送（本机 → 远端）' : '取回（远端 → 本机）'}开始：范围 ${opts.scope === 'all' ? '全部会话' : '选中的会话'}`);
        const result = opts.direction === 'push'
          ? await this.push(run, opts)
          : await this.pull(run, opts);
        run.result = result;
        // 把结果里的错误提到 run 上：界面读的是 run.error，
        // 不提上来就会出现「工作区失败了但卡片写着成功」。
        if (result.error) run.error = result.error;
        // 结束那一行的颜色必须跟结果一致：原来无论成败都走 done（绿色），
        // 于是「2 个工作区失败」被显示成成功色。
        const endText = summarize(result);
        if (result.hardError || (result.error && !(result.conflicts || []).length)) run.progress.error('end', endText);
        else if (result.error || (result.conflicts || []).length) run.progress.warn('end', endText);
        else run.progress.done('end', endText);
        return { ok: !result.error, runId: run.runId, result };
      } catch (e) {
        const msg = String(e?.message || e);
        run.error = msg;
        run.progress.error('end', msg);
        return { ok: false, runId: run.runId, error: msg };
      } finally {
        run.running = false;
        run.finishedAt = Date.now();
        this.lastRun = run;
        this.inFlight = null;
      }
    })();
    this.inFlight = p;
    return p;
  }

  /** 供 /api/run 用：立即返回 runId，操作在后台继续 */
  start(opts) {
    if (this.inFlight) return { ok: false, error: '已有同步任务进行中，请稍后重试。', runId: this.currentRun?.runId || null };
    const started = this.execute(opts); // 故意不 await
    // execute 是同步进入 async 主体的，这里马上能拿到 runId
    const runId = this.currentRun?.runId || null;
    started.catch(() => { /* 错误已经写进 run */ });
    return { ok: true, runId };
  }

  /* ================= 本机同步偏好（忽略清单 / 已记住的裁决） ================= */

  /**
   * 本机专属的同步偏好。**故意放在 .chat-sync/ 下**（已被 gitignore）而不是
   * chat-sync.json —— 后者会随仓库同步，那样 A 机器的忽略会静默改变 B 机器的行为。
   */
  ignoreConfigPath() { return path.join(this.home, '.chat-sync', 'ignore.json'); }

  ignoreConfig() {
    const j = readJson(this.ignoreConfigPath());
    return {
      sessions: Array.isArray(j?.sessions) ? j.sessions.slice() : [],
      workspaces: Array.isArray(j?.workspaces) ? j.workspaces.slice() : [],
      workspaceFiles: (j && typeof j.workspaceFiles === 'object' && j.workspaceFiles) ? j.workspaceFiles : {},
      decisions: (j && typeof j.decisions === 'object' && j.decisions) ? j.decisions : {},
    };
  }

  writeIgnoreConfig(patch) {
    const next = { ...this.ignoreConfig(), ...patch };
    fs.mkdirSync(path.dirname(this.ignoreConfigPath()), { recursive: true });
    fs.writeFileSync(this.ignoreConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  isSessionIgnored(id) { return this.ignoreConfig().sessions.includes(String(id)); }
  isWorkspaceIgnored(id) { return this.ignoreConfig().workspaces.includes(String(id)); }

  /** 工作区忽略规则文件的绝对路径（用户在项目根目录下自己编辑的那个文件） */
  workspaceIgnoreFilePath(realPath) {
    return path.join(realPath, WORKSPACE_IGNORE_NAMES[0]);
  }

  /** 读工作区忽略规则文件的内容（不存在返回 ''） */
  readWorkspaceIgnoreFile(realPath) {
    try {
      const p = this.workspaceIgnoreFilePath(realPath);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch { return ''; }
  }

  /** 写工作区忽略规则文件 */
  writeWorkspaceIgnoreFile(realPath, content) {
    const p = this.workspaceIgnoreFilePath(realPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(content ?? ''), 'utf8');
    return p;
  }

  /** 没有就创建一个带说明的忽略文件（用户可以随时自己编辑；只读他自己的文件） */
  ensureWorkspaceIgnoreFile(realPath, cfg) {
    if (cfg.createWorkspaceIgnoreFile === false) return null;
    const p = this.workspaceIgnoreFilePath(realPath);
    try {
      if (fs.existsSync(p)) return p;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, WORKSPACE_IGNORE_TEMPLATE, 'utf8');
      this.log('info', `已创建 ${p}（写入不想同步的文件，gitignore 语法；该文件不参与同步）`);
      return p;
    } catch { return null; }
  }

  /**
   * 工作区里被忽略的规则（gitignore 语法）。
   * 两个来源：配置文件里的 workspaceFiles，以及工作目录下用户自己编辑的忽略文件。
   * 用户的注释行保留 —— git 的 exclude 本身就把 `#` 当注释。
   */
  workspaceIgnoreRules(wsId, realPath) {
    const cfg = this.ignoreConfig();
    const rules = [];
    for (const r of (Array.isArray(cfg.workspaceFiles?.[wsId]) ? cfg.workspaceFiles[wsId] : [])) {
      const t = String(r ?? '').trim();
      if (t) rules.push(t);
    }
    for (const name of WORKSPACE_IGNORE_NAMES) {
      try {
        const p = path.join(realPath, name);
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          const t = line.replace(/\s+$/, '');
          if (t.trim()) rules.push(t);
        }
      } catch { /* 读不到就算了 */ }
    }
    return rules;
  }

  /* ================= 会话日志修复：截断到最后一个合法前缀 ================= */

  /**
   * 备份目录（本机专属，不参与同步）。
   * 每次修复都在自己的时间戳子目录里留一份原件，随时可以手工换回去。
   */
  sessionBackupDir(stamp = ts()) {
    return path.join(this.home, '.chat-sync', 'session-backup', stamp);
  }

  /**
   * 预览「截断到最后一个合法前缀」会保留什么、丢掉什么。只看不改。
   *
   * 这是唯一安全的修复方式：它不触碰任何 seq 编号，因此不会让
   * sourceEventSeqs / throughSeq 这类引用指向错误的事件。
   * 代价是明确可见的 —— 对话会在某处提前结束。
   */
  async previewSessionRepair(rel) {
    const p = normRel(rel);
    if (!p || !isSessionLogPath(p)) return { ok: false, error: '这不是会话日志的路径。' };
    const abs = path.join(this.home, p);
    if (!fs.existsSync(abs)) return { ok: false, error: '本机没有这个文件。' };
    const buf = fs.readFileSync(abs);
    const decoded = decodeSessionLog(buf);
    if (!decoded) {
      return { ok: false, error: '这份日志无法解析（不是有效的会话日志），截断修复不适用 —— 请从备份或远端恢复。' };
    }
    const v = validateSessionLog(decoded);
    if (v.ok) return { ok: true, alreadyValid: true, rel: p, totalRows: v.rowCount };

    const first = v.problems[0];
    const keep = Math.max(1, first.line - 1);          // 表头 + 第一个问题之前的所有行
    const dropped = decoded.parsed.slice(keep);
    const times = dropped.map((r) => (typeof r?.time === 'number' ? r.time : null)).filter((x) => x !== null);
    return {
      ok: true,
      rel: p,
      totalRows: decoded.parsed.length,
      keepRows: keep,
      dropRows: dropped.length,
      firstProblem: first,
      problemCount: v.problems.length,
      droppedTypes: [...new Set(dropped.map((r) => r?.type).filter(Boolean))].slice(0, 8),
      droppedFrom: times.length ? Math.min(...times) : null,
      droppedTo: times.length ? Math.max(...times) : null,
      bytes: buf.length,
    };
  }

  /**
   * 截断到最后一个合法前缀。**先备份原件**，再用原子写落盘，最后复核一遍。
   * 只改本机文件；上传交给下一次推送按普通内容变更处理。
   */
  async repairSessionLog(rel) {
    const preview = await this.previewSessionRepair(rel);
    if (!preview.ok) return preview;
    if (preview.alreadyValid) return { ok: true, rel: preview.rel, alreadyValid: true };

    const abs = path.join(this.home, preview.rel);
    const original = fs.readFileSync(abs);
    const decoded = decodeSessionLog(original);
    const keep = preview.keepRows;

    const backup = path.join(this.sessionBackupDir(), preview.rel);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, original);

    const text = decoded.rows.slice(0, keep).join('\n') + '\n';
    const payload = original.subarray(0, 4).equals(ZSTD_MAGIC) ? zstdEncode(text) : Buffer.from(text, 'utf8');
    if (!payload) return { ok: false, error: '重新编码失败，未改动文件。', backup };
    writeFileAtomic(abs, payload);

    const after = inspectSessionLog(fs.readFileSync(abs));
    if (!after.ok) {
      return { ok: false, error: `修复后仍未通过校验（${after.problems[0]?.reason || 'unknown'}）；原件在 ${backup}`, backup };
    }
    return {
      ok: true,
      rel: preview.rel,
      keptRows: keep,
      droppedRows: preview.dropRows,
      rowCount: after.rowCount,
      backup,
    };
  }

  /**
   * 上一次操作中途被打断（git 停在合并中）时，把仓库恢复到操作前的状态。
   *
   * 不能直接 `git merge --abort` 了事：它会把工作树硬重置回 HEAD，而 HEAD 是中断前
   * 那次快照，之后 DSH 又往会话日志里追加过行 —— 那些行会一起丢掉。
   * 所以先把「比 HEAD 新的会话日志」抄进内存，回退之后再原样放回去（留作未提交改动，
   * 下一次快照自然会收走）。
   *
   * @returns {Promise<boolean>} 是否真的做了一次恢复
   */
  async recoverInterruptedMerge(run) {
    const log = run.progress;
    const gitdir = path.join(this.home, '.git');
    if (!fs.existsSync(path.join(gitdir, 'MERGE_HEAD'))) return false;
    log.warn('start', '检测到上一次操作被中断（仓库停在合并中），正在恢复到操作前的状态…');
    const g = (args, o) => this.git(args, o);

    const newer = new Map();
    const diff = await g(['diff', '--name-only', 'HEAD', '--', 'sessions'], { timeoutMs: 300000 });
    const paths = this.ok(diff) ? diff.out.split('\n').map((x) => x.trim()).filter(Boolean) : [];
    for (const rel of paths) {
      if (!isSessionLogPath(rel)) continue;
      try { newer.set(rel, fs.readFileSync(path.join(this.home, rel))); } catch { /* ignore */ }
    }

    const abort = await g(['merge', '--abort'], { timeoutMs: 600000 });
    if (!this.ok(abort)) {
      log.error('start', `回退失败：${clip(abort.err || abort.code)}；请手动检查 ${gitdir} 的状态。`);
      return false;
    }

    for (const [rel, buf] of newer) {
      const safe = this.sessionLogSafeBuf(rel, buf);
      if (safe.mode === 'keep-disk' || safe.mode === 'same') continue;
      writeFileAtomic(path.join(this.home, rel), safe.buf);
    }
    if (newer.size) log.warn('start', `已保留 ${newer.size} 个在中断期间追加过内容的会话日志。`);
    log.warn('start', '已恢复到操作前的状态。');
    return true;
  }

  /**
   * 会话日志只允许「只增不减」：任何写入都必须包含磁盘上现有的内容。
   *
   * DSH 一直在往日志里追加。同步操作（合并 / 覆盖 / 写回）如果拿着较早读到的内容
   * 整文件覆盖，就会把刚追加的行抹掉；而持有该会话的宿主随后按自己内存里的 seq
   * 继续写 —— 日志于是出现 seq 断点，再也解不开。
   * （真实事故：seq 2791 后面直接接了 1789。）
   *
   * @returns {{buf: Buffer, mode: 'same'|'write'|'keep-disk'|'conflict'}}
   *   write    要写的内容包含磁盘上的内容，可以写
   *   keep-disk 磁盘上的更新（要写的是它的前缀），不要动
   *   conflict  两边无法安全拼接，保留磁盘内容，交给裁决
   */
  sessionLogSafeBuf(rel, intended) {
    let cur = null;
    try { cur = fs.readFileSync(path.join(this.home, rel)); } catch { cur = null; }
    if (!cur) return { buf: intended, mode: 'write' };
    if (cur.equals(intended)) return { buf: cur, mode: 'same' };
    const m = mergeSessionLog(cur, intended);
    if (!m.ok) return { buf: cur, mode: 'conflict' };
    // m.mode === 'theirs' 表示 intended 是超集 → 可以写；
    // m.mode === 'ours'   表示磁盘上是超集 → 说明要写的是旧版本，绝不能写。
    return m.mode === 'theirs' ? { buf: intended, mode: 'write' } : { buf: cur, mode: 'keep-disk' };
  }

  /* ---------- 嵌套 git 仓库（gitlink） ---------- */

  /**
   * 把「这个工作区里有几个独立的 git 仓库被排除掉了」说出来。
   *
   * 嵌套仓库不能跟着父目录一起同步（git 只记 gitlink，不带内容），所以只能排除。
   * 但沉默地排除会让人以为源码在同步 —— 实际没有。所以每次同步都明确报一句，
   * 并告诉对方：想同步它，就把那个目录作为独立工作区打开。
   */
  reportNestedRepos(log, label, nested, cfg) {
    if (!nested?.length) return;
    // 已经明确决定不同步的（写进 workspaceExtraIgnore 或工作区忽略文件）就不再念叨
    const silenced = new Set((cfg?.workspaceExtraIgnore || [])
      .map((x) => String(x || '').trim().replace(/^\/+|\/+$/g, '')).filter(Boolean));
    const todo = nested.filter((n) => !silenced.has(n));
    if (!todo.length) return;
    const shown = todo.slice(0, 3).join('、');
    log.info('ws', `工作区「${label}」里有 ${todo.length} 个独立的 git 仓库（${shown}${todo.length > 3 ? '…' : ''}）：`
      + '它们的内容不随本工作区同步。想让源码也同步就把那个目录在 DSH 里作为工作区打开；'
      + '确定不需要同步的话，把路径写进 chat-sync.json 的 workspaceExtraIgnore，这里就不再提示。');
  }

  gitlinkStatePath() { return path.join(this.home, '.chat-sync', 'workspace-gitlinks.json'); }

  knownGitlinks(wsId) {
    const j = readJson(this.gitlinkStatePath());
    return j && Array.isArray(j[wsId]) ? j[wsId] : [];
  }

  rememberGitlinks(wsId, list) {
    if (!list?.length) return;
    const file = this.gitlinkStatePath();
    const j = readJson(file) || {};
    j[wsId] = [...new Set([...(Array.isArray(j[wsId]) ? j[wsId] : []), ...list])].sort();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
  }

  /** 索引里 mode=160000 的条目就是嵌套 git 仓库（gitlink），父仓库提交必失败 */
  async discoverGitlinks(gitdir, realPath) {
    const r = await this.gitW(gitdir, realPath, ['ls-files', '-s', '-z'], { timeoutMs: 300000 });
    if (!this.ok(r)) return [];
    const out = [];
    for (const rec of String(r.out).split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      if (rec.slice(0, tab).split(' ')[0] === '160000') out.push(normRel(rec.slice(tab + 1)));
    }
    return out;
  }

  /**
   * 找出工作区里嵌套的 git 仓库（有界深度）。
   * 这些必须排除：父仓库会把它们记成 gitlink，工作树一有改动父仓库提交必失败；
   * 而自己还没提交过的空嵌套仓库连 gitlink 都记不上，只能靠扫描发现。
   * 跳过依赖/构建目录，并设上限，避免在大项目上耗时。
   */
  findNestedRepos(root, maxDepth = 4, limit = 200) {
    const SKIP = new Set(['node_modules', '.git', '.pnpm-store', '.npm-cache', '.venv', 'venv',
      'dist', 'build', 'out', 'target', '.next', '.cache', '.tox', '__pycache__']);
    const out = [];
    const walk = (dir, rel, depth) => {
      if (depth > maxDepth || out.length >= limit) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (out.length >= limit) return;
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        if (SKIP.has(ent.name)) continue;
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        const childAbs = path.join(dir, ent.name);
        if (fs.existsSync(path.join(childAbs, '.git'))) { out.push(childRel); continue; }
        walk(childAbs, childRel, depth + 1);
      }
    };
    walk(root, '', 1);
    return out;
  }

  /** 本仓库里所有「还没裁决」的路径（未决的冲突必须先保护住，不能被自动覆盖） */
  pendingPathSet(repo) {
    const set = new Set();
    for (const p of this.listPending()) {
      for (const c of p.conflicts || []) if (c.repo === repo) set.add(c.path);
    }
    return set;
  }

  /**
   * 本机决定「这个路径不参与本次操作」的统一判定：
   *  - 会话在忽略清单里（含它的投影缓存）
   *  - 该路径上有尚未裁决的冲突（两边都改过的，不能自动选边）
   */
  pathIsMuted(rel, repo, pendingSet = null) {
    const p = normRel(rel);
    const pend = pendingSet || this.pendingPathSet(repo);
    if (pend.has(p)) return true;
    const id = isSessionLogPath(p) ? sessionIdOfPath(p) : sessionCacheIdOf(p);
    if (id && this.isSessionIgnored(id)) return true;
    return false;
  }

  /** 记住一个单元的裁决（例如"这个删除要/不要同步"），避免每次推送反复问同一件事 */
  unitDecision(key) {
    const d = this.ignoreConfig().decisions[key];
    return d && typeof d.choice === 'string' ? d : null;
  }

  setUnitDecision(key, choice) {
    const cfg = this.ignoreConfig();
    const decisions = { ...cfg.decisions };
    if (choice) decisions[key] = { choice, at: Date.now() };
    else delete decisions[key];
    this.writeIgnoreConfig({ decisions });
    return choice || null;
  }

  /* ================= 单元分类（规格表 A） ================= */

  /** 一次 ls-tree 拿到整个 ref 的 path → {sha, mode}，避免逐文件起 git 进程 */
  async treeIndex(g, ref) {
    const map = new Map();
    const r = await g(['ls-tree', '-r', '-z', ref], { timeoutMs: 300000 });
    if (!this.ok(r)) return map;
    for (const rec of String(r.out).split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(' ');
      map.set(normRel(rec.slice(tab + 1)), { sha: meta[2], mode: meta[0] });
    }
    return map;
  }

  /** from 与 to 之间改动的路径 → 状态字母（A/M/D/T） */
  async changedPaths(g, from, to) {
    const out = new Map();
    const r = await g(['diff', '--name-status', '--no-renames', '-z', from, to], { timeoutMs: 300000 });
    if (!this.ok(r)) return out;
    const parts = String(r.out).split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const st = parts[i];
      const p = parts[i + 1];
      if (!st || !p) continue;
      out.set(normRel(p), st[0]);
    }
    return out;
  }

  /**
   * 把"本机相对 main 的全部差异"逐个单元分类。
   * @param ctx {{ repo, g, ref, kindLabel, ignore?: (path)=>boolean }}
   */
  async classifyUnits(run, cfg, ctx) {
    const { g, ref } = ctx;
    const remoteHead = await g(['rev-parse', '--verify', ref]);
    if (!this.ok(remoteHead)) return { ok: true, noRemote: true, units: [], remoteHead: null, localHead: null, base: null };
    const remote = remoteHead.out.trim();
    const localHead = await g(['rev-parse', '--verify', 'HEAD']);
    if (!this.ok(localHead)) return { ok: true, noLocal: true, units: [], remoteHead: remote, localHead: null, base: null };
    const local = localHead.out.trim();

    // 没有共同祖先时**不能假装知道谁改了什么**：三方比较不成立。
    // 这里把 base 置空，于是"两边都有且内容不同"会落到 A8（双方独立新增），
    // 由内容层尝试合并，合不了就交给用户裁决 —— 而不是武断地选一边。
    const mb = await g(['merge-base', local, remote]);
    const unrelated = !this.ok(mb);
    if (unrelated) run.progress.info('unit', '本机与远端无共同历史，按「双方各自新增」逐条处理。');
    const base = unrelated ? null : mb.out.trim();

    const [tB, tL, tR] = await Promise.all([
      unrelated ? Promise.resolve(new Map()) : this.treeIndex(g, base),
      this.treeIndex(g, local),
      this.treeIndex(g, remote),
    ]);
    const mine = await this.changedPaths(g, base, local);
    const theirs = await this.changedPaths(g, base, remote);

    const paths = [...new Set([...mine.keys(), ...theirs.keys()])].sort();
    const units = [];
    for (const p of paths) {
      if (ctx.ignore && ctx.ignore(p)) { units.push({ path: p, state: 'IGNORED' }); continue; }
      const b = tB.get(p) || null;
      const l = tL.get(p) || null;
      const r = tR.get(p) || null;
      units.push({ path: p, state: classifyState(b, l, r), base: b, ours: l, theirs: r, kind: unitKindOf(p) });
    }
    return { ok: true, base, unrelated, localHead: local, remoteHead: remote, units };
  }

  /** 取一个 blob 的内容（二进制安全） */
  async readBlob(g, sha) {
    const r = await g(['cat-file', 'blob', sha], { binary: true, timeoutMs: 120000 });
    return this.ok(r) ? r.out : null;
  }

  /**
   * 单个单元在「推送」方向怎么处理。
   * @returns {{overlay?:{content:Buffer|null,mode:string}, hold?:{reason:string}}}
   *   overlay  = 要叠加进交付树的内容（content=null 表示删除）
   *   hold     = 需要人裁决，交付树保留 main 的版本
   */
  async resolveUnitForDelivery(run, cfg, ctx, unit, g) {
    const key = `${ctx.repo}:${unit.path}`;
    const decision = this.unitDecision(key);

    const forced = ctx.forceOurs && ctx.forceOurs.has(unit.path) ? ctx.forceOurs.get(unit.path) : null;

    // 本机这份会话日志如果已经损坏（seq 断点/重复/解析不了），绝不能上传 ——
    // **连「强制用本机覆盖」也不行**：上传等于把损坏扩散到另一台机器，那边同样打不开。
    // 唯一放行的是「删除」（它只交付一个删除，不传内容）。
    if (forced !== 'delete' && unit.kind === 'session-log' && unit.ours) {
      const bad = await this.corruptSessionLogOf(g, unit.ours.sha);
      if (bad) {
        run.progress.error('deliver', `${unit.path}：本机会话日志已损坏（${bad}），不能上传；请先用「预览修复」截断，或改用「采用远端」。`);
        return { hold: { reason: 'corrupt-session-log', detail: bad } };
      }
    }

    // 用户在待裁决里显式选了「保留本机 / 同步删除」→ 无条件采用本端，跳过一切合并判断
    if (forced) {
      if (forced === 'delete') return { overlay: { content: null, mode: '100644' } };
      return { overlay: { content: await this.readBlob(g, unit.ours.sha), mode: unit.ours.mode } };
    }
    const theirsContent = () => (unit.theirs ? this.readBlob(g, unit.theirs.sha) : null);

    switch (unit.state) {
      case 'A2': // 仅本端改
      case 'A6': // 本端新增
        return { overlay: { content: await this.readBlob(g, unit.ours.sha), mode: unit.ours.mode } };

      case 'A4':   // 两边都改、纯追加
      case 'A8': { // 双方独立新增同一路径（含无共同历史的情况）
        if (unit.kind === 'cache') return { overlay: { content: await this.readBlob(g, unit.ours.sha), mode: unit.ours.mode } };
        const merged = await this.mergeUnitContent(g, unit, unit.kind);
        if (merged.ok) return { overlay: { content: merged.content, mode: unit.ours.mode } };
        return { hold: { reason: merged.reason || 'no-common-base' } };
      }

      case 'A5': { // 两边都改
        if (unit.kind === 'cache') {
          // 唯一自动裁决的例外：派生数据，两个方向都会重建（见规格 §7.1）
          run.progress.info('unit', `${unit.path}：会话投影缓存为派生数据，采用本机版本（DSH 会重建）。`);
          return { overlay: { content: await this.readBlob(g, unit.ours.sha), mode: unit.ours.mode } };
        }
        const merged = await this.mergeUnitContent(g, unit, unit.kind);
        if (merged.ok) return { overlay: { content: merged.content, mode: unit.ours.mode } };
        return { hold: { reason: merged.reason } };
      }

      case 'A9': { // 本端删除、远端未改 —— 删除绝不自动传播
        if (decision?.choice === 'delete') return { overlay: { content: null, mode: '100644' } };
        if (decision?.choice === 'keep') return {};   // 已经决定「只在本机删除」→ main 保持原样，不再打扰
        return { hold: { reason: 'delete-local' } };
      }

      case 'A12': { // 本端删除 + 远端修改
        if (decision?.choice === 'delete') return { overlay: { content: null, mode: '100644' } };
        if (decision?.choice === 'keep') return {};   // 已经决定改用 main 的版本（本机那份也已恢复）→ 无改动
        return { hold: { reason: 'delete-modify' } };
      }

      case 'A13': { // 远端删除 + 本端修改
        if (decision?.choice === 'keep') return { overlay: { content: await this.readBlob(g, unit.ours.sha), mode: unit.ours.mode } };
        if (decision?.choice === 'delete') return {};  // 本机也删了、main 也没有 → 无操作
        return { hold: { reason: 'modify-delete' } };
      }

      // A1 已同步 / A3 仅远端改 / A7 远端新增 / A10 双方删除 / A11 远端删除 → 交付树天然保持 main 的样子
      default:
        return {};
    }
  }

  /** 按单元类型做内容层面的合并（会话日志走纯追加规则，文本走三路合并） */
  async mergeUnitContent(g, unit, kind) {
    const oursBuf = await this.readBlob(g, unit.ours.sha);
    const theirsBuf = this.theirs ? null : null; // 占位，下面统一取
    const theirs = unit.theirs ? await this.readBlob(g, unit.theirs.sha) : null;
    if (!oursBuf || !theirs) return { ok: false, reason: 'unreadable' };
    void theirsBuf;

    if (kind === 'session-log') {
      // 任何一侧已经损坏就不要再拼 —— 拼出来的东西同样打不开，而且会把损坏带走
      for (const [side, buf] of [['本机', oursBuf], ['远端', theirs]]) {
        const v = inspectSessionLog(buf);
        if (!v.ok) {
          const p = v.problems[0] || {};
          return { ok: false, reason: 'corrupt-session-log', detail: `${side} ${p.reason || 'unreadable'}${p.line ? '@第 ' + p.line + ' 行' : ''}` };
        }
      }
      const m = mergeSessionLog(oursBuf, theirs);
      if (m.ok) return { ok: true, content: m.buf };
      return { ok: false, reason: m.reason === 'divergent' ? 'divergent-session-history' : m.reason };
    }
    if (kind === 'text' && !looksBinary(oursBuf) && !looksBinary(theirs)) {
      const baseText = unit.base ? (await this.readBlob(g, unit.base.sha))?.toString('utf8') ?? '' : '';
      const m = await this.threeWayMerge(unit.path, baseText, oursBuf.toString('utf8'), theirs.toString('utf8'));
      if (m.ok) return { ok: true, content: Buffer.from(m.text, 'utf8') };
      return { ok: false, reason: m.reason };
    }
    return { ok: false, reason: 'binary-both-changed' };
  }

  /** 这个 blob 是会话日志且格式非法时返回问题简述；合法或不是日志则返回 null */
  async corruptSessionLogOf(g, sha) {
    if (!sha) return null;
    const buf = await this.readBlob(g, sha);
    if (!buf) return null;
    const v = inspectSessionLog(buf);
    if (v.ok) return null;
    const p = v.problems[0] || {};
    return `${p.reason || 'unreadable'}${p.line ? '@第 ' + p.line + ' 行' : ''}`;
  }

  /** 把交付过程中"留下来的"单元登记成待裁决项（含远端版本留档，供界面展示两侧内容） */
  async recordHeldUnits(run, store, build, ctx) {
    if (!build.held?.length) return [];
    const out = [];
    for (const h of build.held) {
      const meta = this.describeConflictPath(h.path);
      const theirs = h.theirs ? await this.readBlob(ctx.g, h.theirs.sha) : null;
      out.push(await this.recordConflict(store, {
        repo: ctx.repo,
        side: 'delivery',
        relPath: h.path,
        kind: h.kind === 'session-log' ? 'session-log' : 'file',
        reason: h.reason,
        theirsRef: theirs,
        sessionId: meta.sessionId,
        title: meta.title,
        state: h.state,
        workspaceLabel: ctx.label || null,
      }));
    }
    return out;
  }

  /**
   * 构造「交付提交」：起点是 main 的树，叠加本端能交付的单元，
   * 父提交是 (main, 本机 HEAD)，然后原样推给 main。
   *
   * 全程不碰本机工作树、不碰本机 HEAD、不碰真实 index。
   */
  async buildDeliveryCommit(run, cfg, store, ctx) {
    const log = run.progress;
    const { g, ref, kindLabel = '主数据' } = ctx;
    const cls = await this.classifyUnits(run, cfg, ctx);
    if (!cls.ok || cls.noRemote) return { ok: false, reason: 'no-remote' };
    if (cls.noLocal) return { ok: true, commit: null, delivered: [], held: [], reason: 'no-local-commit' };

    const held = [];
    const overlays = [];
    for (const unit of cls.units) {
      const res = await this.resolveUnitForDelivery(run, cfg, ctx, unit, g);
      if (res.hold) {
        held.push({ ...unit, reason: res.hold.reason });
        log.warn('unit', `${kindLabel} ${unit.path}：${holdReasonText(res.hold.reason)}；交付树保留远端版本。`);
        continue;
      }
      if (res.overlay) overlays.push({ path: unit.path, ...res.overlay, unit });
    }
    if (!overlays.length) return { ok: true, commit: null, delivered: [], held, base: cls.base, nothingNew: true };

    const idx = path.join(this.tmpDir(), 'deliver-index-' + randomUUID().slice(0, 8));
    const gi = (args, opts = {}) => g(args, { ...opts, env: { GIT_INDEX_FILE: idx } });
    try {
      const rt = await gi(['read-tree', cls.remoteHead]);
      if (!this.ok(rt)) return { ok: false, reason: 'error', error: `read-tree 失败：${clip(rt.err || rt.code)}` };
      for (const ov of overlays) {
        if (ov.content === null) {
          await gi(['update-index', '--force-remove', '--', ov.path]);
          continue;
        }
        const h = await g(['hash-object', '-w', '--stdin'], { stdin: ov.content, timeoutMs: 120000 });
        if (!this.ok(h)) return { ok: false, reason: 'error', error: `hash-object 失败：${clip(h.err || h.code)}` };
        const up = await gi(['update-index', '--add', '--cacheinfo', `${ov.mode || '100644'},${h.out.trim()},${ov.path}`]);
        if (!this.ok(up)) return { ok: false, reason: 'error', error: `update-index 失败：${clip(up.err || up.code)}` };
      }
      const wt = await gi(['write-tree']);
      if (!this.ok(wt)) return { ok: false, reason: 'error', error: `write-tree 失败：${clip(wt.err || wt.code)}` };
      const tree = wt.out.trim();
      const remoteTree = await g(['rev-parse', `${cls.remoteHead}^{tree}`]);
      if (this.ok(remoteTree) && remoteTree.out.trim() === tree) {
        return { ok: true, commit: null, delivered: [], held, base: cls.base, nothingNew: true };
      }
      const msg = `${cfg.commitMessage}: 交付 ${overlays.length} 项改动到 ${kindLabel} (${nowStamp()})`;
      const ct = await g(['commit-tree', tree, '-p', cls.remoteHead, '-p', cls.localHead, '-m', msg], { timeoutMs: 120000 });
      if (!this.ok(ct)) return { ok: false, reason: 'error', error: `commit-tree 失败：${clip(ct.err || ct.code)}` };
      return {
        ok: true,
        commit: ct.out.trim(),
        tree,
        message: msg,
        base: cls.base,
        remoteHead: cls.remoteHead,
        localHead: cls.localHead,
        delivered: overlays.map((o) => o.path),
        held,
      };
    } finally {
      try { fs.unlinkSync(idx); } catch { /* ignore */ }
    }
  }

  /** 把交付提交推给远端分支；被拒（远端又动了）时重建一次 */
  async pushDelivery(run, cfg, store, ctx, attempt = 2) {
    const log = run.progress;
    for (let i = 0; i < attempt; i += 1) {
      const build = await this.buildDeliveryCommit(run, cfg, store, ctx);
      if (!build.ok) return build;
      if (!build.commit) return build;
      log.info('deliver', `已构造交付提交 ${build.commit.slice(0, 7)}（${build.delivered.length} 项改动）。`);
      // 必须用 ctx.g：工作区的交付提交只存在于那个影子仓库里，用主仓库的 git 会推错地方。
      const p = await ctx.g(['push', 'origin', `${build.commit}:refs/heads/${ctx.branch}`, '--progress'], {
        timeoutMs: 1800000,
        onStderr: (d) => logTransfer(log, 'push', d),
      });
      if (this.ok(p)) return build;
      const reject = /non-fast-forward|fetch first|\[rejected\]|stale info|cannot lock ref/i.test(p.err || '');
      if (!reject) return { ok: false, reason: 'error', error: `push 失败：${clip(p.err || p.code)}` };
      log.warn('deliver', `推送被拒（远端已更新），重新读取并重建交付提交（第 ${i + 1} 次）`);
      const refetch = await this.fetchMain(run, cfg);
      if (!refetch.ok) return { ok: false, reason: 'error', error: refetch.error };
    }
    return { ok: false, reason: 'error', error: '推送持续被拒，请稍后重试。' };
  }

  /* ================= push ================= */

  async push(run, opts) {
    const log = run.progress;
    const cfg = this._cfg;
    const result = { direction: 'push', scope: opts.scope, commits: [], pushed: [], conflicts: [], workspaces: [], pendingId: null };
    const store = this.newPendingStore(run);

    log.step('repo', '检查本地仓库与远端配置');
    const repo = await this.ensureRepo(cfg);
    if (!repo.ok) { result.error = repo.error; return result; }

    let remote = cfg.remote;
    if (!remote) {
      log.step('repo', '未配置远端，尝试通过 gh 创建或复用私有仓库');
      const boot = await this.bootstrapRemote(cfg);
      if (!boot.remote) { result.error = boot.error; return result; }
      remote = boot.remote;
      log.info('repo', `远端就绪：${remote}${boot.created ? '（已新建私有仓库）' : '（已复用现有私有仓库）'}`);
      cfg.remote = remote;
    } else {
      log.info('repo', `远端：${remote}（分支 ${cfg.branch}）`);
    }
    if (!(await this.guardPrivate(run, remote))) { result.error = '远端未确认为私有仓库，已取消上传。'; return result; }

    const scope = this.resolveMainPaths(opts);
    if (scope.missing?.length) log.warn('scope', `${scope.missing.length} 个会话在本机不存在，已跳过：${scope.missing.join(', ')}`);
    if (scope.mode === 'all') log.info('scope', '范围：全部会话与主数据（整个 DSH 数据目录）');
    else log.info('scope', `范围：${scope.sessionIds.length} 个会话及工作区登记表`, { sessions: scope.sessionIds });

    // —— 1) 只暂存范围内的路径 ——
    log.step('stage', '暂存范围内的本地改动');
    let stagedPaths = [];
    if (scope.mode === 'all') {
      await this.git(['add', '-A'], { timeoutMs: 300000 });
    } else {
      stagedPaths = this.existingPaths(scope.paths);
      if (stagedPaths.length) {
        const r = await this.git(['add', '-A', '--', ...stagedPaths], { timeoutMs: 300000 });
        if (!this.ok(r)) log.warn('stage', `暂存部分路径失败：${clip(r.err || r.code)}`);
      }
    }
    // 只看（也只提交）本次范围内的路径：否则日志会把你没选的会话也列出来，看着像要一起上传。
    const st = await this.git(scope.mode === 'all' ? ['status', '--porcelain'] : ['status', '--porcelain', '--', ...stagedPaths]);
    const changed = this.ok(st) ? st.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if (!changed.length) {
      log.info('stage', '范围内无需提交的改动。');
    } else {
      log.info('stage', `将提交 ${changed.length} 项改动：`, { files: changed.slice(0, 40) });
      for (const line of changed.slice(0, 40)) log.info('stage', '  ' + line);
      if (changed.length > 40) log.info('stage', `  …另有 ${changed.length - 40} 项`);
      const msg = `${cfg.commitMessage}: ${describeScope(opts, scope)} (${nowStamp()})`;
      // 带 pathspec 提交：即使索引里还留着别处暂存的内容，也不会被这个提交带走。
      const cm = scope.mode === 'all'
        ? await this.git(['commit', '-m', msg])
        : await this.git(['commit', '-m', msg, '--', ...stagedPaths]);
      if (!this.ok(cm)) {
        result.error = `git commit 失败：${clip(cm.err || cm.out)}`;
        log.error('stage', result.error);
        return result;
      }
      const head = await this.git(['rev-parse', '--short', 'HEAD']);
      result.commits.push({ repo: 'main', sha: this.ok(head) ? head.out.trim() : null, message: msg });
      log.done('stage', `已提交本地快照 ${this.ok(head) ? head.out.trim() : ''}`);
    }

    // —— 2) 读取远端，构造「交付提交」并推送 ——
    // 交付提交 = main 的树 + 本端能交付的单元，父提交是 (main, 本机 HEAD)。
    // 本机 HEAD / 工作树 / index 全程不动，所以本端永远不会被强迫拉取，也永远不会分叉。
    log.step('fetch', `读取远端 ${cfg.branch} 分支状态`);
    const fetched = await this.fetchMain(run, cfg);
    if (!fetched.ok) {
      result.error = fetched.error;
      log.error('fetch', result.error);
      return result;
    }

    // 远端还没有这个分支 → 首次上传：没有远端树可作起点，直接推本机历史
    const remoteRef = await this.git(['rev-parse', '--verify', `refs/remotes/origin/${cfg.branch}`]);
    const localRef = await this.git(['rev-parse', '--verify', 'HEAD']);
    if (!this.ok(remoteRef)) {
      if (!this.ok(localRef)) {
        log.info('deliver', '本机无提交，远端亦无历史，无需推送。');
        return result;
      }
      log.step('deliver', `远端尚无 ${cfg.branch} 分支，执行首次上传`);
      const first = await this.git(['push', '-u', 'origin', `HEAD:refs/heads/${cfg.branch}`, '--progress'], {
        timeoutMs: 1800000,
        onStderr: (d) => logTransfer(log, 'push', d),
      });
      if (!this.ok(first)) {
        result.error = `首次上传失败：${clip(first.err || first.code)}`;
        result.hardError = true;
        log.error('deliver', result.error);
        return result;
      }
      result.pushed.push({ repo: 'main', sha: localRef.out.trim().slice(0, 7) });
      log.done('deliver', `主数据已首次上传至 ${remote}（${cfg.branch}）。`);
    } else {
    log.step('deliver', '逐条判定，构造交付提交');
    const ctxMain = {
      repo: 'main',
      g: (args, opts) => this.git(args, opts),
      ref: `refs/remotes/origin/${cfg.branch}`,
      branch: cfg.branch,
      kindLabel: '主数据',
      label: '主数据',
      ignore: (p) => this.pathIsMuted(p, 'main'),
    };
    const build = await this.pushDelivery(run, cfg, store, ctxMain);
    if (!build.ok) {
      result.error = build.error || '构造交付提交失败。';
      result.hardError = true;
      log.error('deliver', result.error);
      return result;
    }
    if (build.delivered?.length) {
      result.delivered = build.delivered;
      result.pushed.push({ repo: 'main', sha: build.commit ? build.commit.slice(0, 7) : null });
      log.done('deliver', `远端已接受 ${build.delivered.length} 项本机改动；本机文件未改动。`);
    } else {
      log.info('deliver', '无可交付给远端的改动。');
    }
    await this.recordHeldUnits(run, store, build, ctxMain);
    }

    // —— 3) 工作区文件 ——
    if (opts.includeWorkspace && !result.hardError) {
      const targets = this.workspaceTargets(opts);
      if (!targets.length) log.info('ws', '无匹配工作区。');
      else {
        log.step('ws', `开始同步 ${targets.length} 个工作区`);
        for (const ws of targets) {
          const r = await this.pushWorkspace(run, cfg, ws, result, store);
          result.workspaces.push(r);
        }
      }
    } else {
      log.info('ws', '本次不含工作区文件。');
    }
    // 工作区失败也算这次推送失败，否则 result.error 为空 → 界面显示「成功」的绿色
    const wsFailed = result.workspaces.filter((w) => w.error);
    if (wsFailed.length) {
      const brief = wsFailed.slice(0, 2).map((w) => `${w.title}（${firstLine(String(w.error))}）`).join('；')
        + (wsFailed.length > 2 ? `；…还有 ${wsFailed.length - 2} 个` : '');
      log.error('ws', `${wsFailed.length} 个工作区同步失败：${brief}`);
      if (!result.error) result.error = `${wsFailed.length} 个工作区同步失败：${brief}`;
    }
    if (store.conflicts.length) {
      result.pendingId = this.savePending(store).id;
      result.conflicts = store.conflicts;
      if (!result.error) result.error = `${store.conflicts.length} 项无法自动合并，已暂停并等待裁决（相关内容未上传）。`;
    }
    return result;
  }

  existingPaths(paths) {
    return (paths || []).filter((p) => {
      try { return fs.existsSync(path.join(this.home, p)); } catch { return false; }
    });
  }

  /** 选中会话 → 需要同步的工作区；未选会话则全部工作区 */
  workspaceTargets(opts) {
    const all = this.workspaceRecords();
    if (opts.includeWorkspaceAll || opts.scope === 'all') return all;
    if (Array.isArray(opts.workspaceIds) && opts.workspaceIds.length) {
      return all.filter((w) => opts.workspaceIds.includes(w.id));
    }
    const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds : [];
    const owner = this.sessionToWorkspace();
    const wanted = new Set(ids.map((s) => owner.get(s)).filter(Boolean));
    if (!wanted.size) return [];
    return all.filter((w) => wanted.has(w.id));
  }

  async pushWorkspace(run, cfg, ws, result, store) {
    const log = run.progress;
    const label = ws.title || path.basename(ws.path) || ws.id;
    if (this.isWorkspaceIgnored(ws.id)) {
      log.info('ws', `工作区「${label}」在本机被忽略，跳过。`);
      return { id: ws.id, title: label, path: ws.path, ignored: true };
    }
    const resolved = this.resolveWorkspacePath(ws, cfg);
    const realPath = resolved.path;
    if (!realPath) { log.error('ws', `工作区「${label}」没有可用路径。`); return { id: ws.id, title: label, path: null, error: 'no-path' }; }
    if (resolved.source === 'remapped') log.info('ws', `工作区「${label}」记录路径 ${resolved.recorded} 不存在，已按本机主目录调整为 ${realPath}`);
    try { fs.mkdirSync(realPath, { recursive: true }); }
    catch (e) { log.error('ws', `工作区「${label}」目录不可用：${e?.message || e}`); return { id: ws.id, title: label, path: realPath, error: 'mkdir' }; }
    const mirror = await this.ensureWorkspaceMirror(ws.id, realPath, cfg);
    if (!mirror.ok) { log.error('ws', `工作区「${label}」：${mirror.error}`); return { id: ws.id, title: label, path: realPath, error: mirror.error }; }
    const { gitdir, branch } = mirror;
    this.reportNestedRepos(log, label, mirror.nested, cfg);
    this.ensureWorkspaceIgnoreFile(realPath, cfg);
    this.ensureWorkspaceIgnoreFile(realPath, cfg);
    log.step('ws', `工作区「${label}」：暂存项目文件`);
    await this.gitW(gitdir, realPath, ['add', '-A'], { timeoutMs: 600000 });
    // 嵌套 git 仓库（任意层级）会被记成 gitlink，父仓库提交必然失败
    // （尤其那些自己还没提交过的嵌套仓库）。让 git 自己报出哪些是 gitlink，
    // 从索引里摘掉并永久排除 —— 嵌套仓库由它自己的仓库管理，不参与同步。
    const links = await this.discoverGitlinks(gitdir, realPath);
    if (links.length) {
      await this.gitW(gitdir, realPath, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...links], { timeoutMs: 300000 });
      this.rememberGitlinks(ws.id, links);
      const shown = links.slice(0, 3).join('、');
      log.warn('ws', `工作区「${label}」里有 ${links.length} 个嵌套 git 仓库（${shown}${links.length > 3 ? '…' : ''}），已排除，不参与同步。`);
    }
    const st = await this.gitW(gitdir, realPath, ['status', '--porcelain']);
    const changed = this.ok(st) ? st.out.split('\n').filter(Boolean) : [];
    let committed = false;
    if (changed.length) {
      const msg = `${cfg.commitMessage}: workspace ${label} (${nowStamp()})`;
      const cm = await this.gitW(gitdir, realPath, ['commit', '-m', msg]);
      if (!this.ok(cm)) {
        const err = `提交失败：${clip(cm.err || cm.out)}`;
        log.error('ws', `工作区「${label}」${err}`);
        return { id: ws.id, title: label, path: realPath, error: err, changed: changed.length };
      }
      committed = true;
      log.info('ws', `工作区「${label}」已提交 ${changed.length} 项改动。`);
      result.commits.push({ repo: `ws:${ws.id}`, message: msg });
    } else {
      log.info('ws', `工作区「${label}」无未提交的改动。`);
    }
    const fetch = await this.gitW(gitdir, realPath, ['fetch', 'origin', '--prune', '--progress'], {
      timeoutMs: 900000,
      onStderr: (d) => logTransfer(log, 'ws-fetch', d),
    });
    if (!this.ok(fetch)) {
      const probe = await this.gitW(gitdir, realPath, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeoutMs: 120000 });
      const remoteExists = this.ok(probe) && Boolean(probe.out.trim());
      if (remoteExists || !this.ok(probe)) {
        log.error('ws', `工作区「${label}」读取远端失败：${clip(fetch.err || fetch.code)}`);
        return { id: ws.id, title: label, path: realPath, error: 'fetch', committed };
      }
      log.info('ws', `工作区「${label}」远端尚无该分支，执行首次上传。`);
    }
    const localHead = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', 'HEAD']);
    if (!this.ok(localHead)) {
      log.info('ws', `工作区「${label}」无可提交内容，跳过（目标机器会自动创建该目录）。`);
      return { id: ws.id, title: label, path: realPath, empty: true, committed };
    }
    const ref = `refs/remotes/origin/${branch}`;
    const remoteHead = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', ref]);

    // 远端还没有这个分支 → 首次上传，直接推本地历史
    if (!this.ok(remoteHead)) {
      const first = await this.gitW(gitdir, realPath, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`, '--progress'], {
        timeoutMs: 1800000,
        onStderr: (d) => logTransfer(log, 'ws-push', d),
      });
      if (!this.ok(first)) {
        const err = `首次上传失败：${clip(first.err || first.code)}`;
        log.error('ws', `工作区「${label}」${err}`);
        return { id: ws.id, title: label, path: realPath, error: err, committed };
      }
      log.done('ws', `工作区「${label}」已首次推送至 ws/${ws.id}。`);
      return { id: ws.id, title: label, path: realPath, pushed: true, committed, branch };
    }

    // 已有远端 → 走和主数据一样的「交付提交」：本机项目文件不被改动
    const ctxWs = {
      repo: `ws:${ws.id}`,
      g: (args, opts) => this.gitW(gitdir, realPath, args, opts),
      ref,
      branch,
      kindLabel: `工作区「${label}」`,
      label,
      ignore: null,
    };
    const build = await this.pushDelivery(run, cfg, store, ctxWs);
    if (!build.ok) {
      log.error('ws', `工作区「${label}」${build.error || '构造交付提交失败'}`);
      return { id: ws.id, title: label, path: realPath, error: build.error || 'deliver', committed };
    }
    await this.recordHeldUnits(run, store, build, ctxWs);
    if (!build.delivered?.length) {
      log.info('ws', `工作区「${label}」无可交付的新改动。`);
      return { id: ws.id, title: label, path: realPath, upToDate: true, committed };
    }
    log.done('ws', `工作区「${label}」已交付 ${build.delivered.length} 项改动到 ws/${ws.id}（本机文件未改动）。`);
    return {
      id: ws.id, title: label, path: realPath, pushed: true, committed, branch,
      delivered: build.delivered.length,
      held: build.held.length,
    };
  }

  /* ================= pull ================= */

  async pull(run, opts) {
    const log = run.progress;
    const cfg = this._cfg;
    const result = { direction: 'pull', scope: opts.scope, applied: [], merged: [], conflicts: [], skipped: [], workspaces: [], pendingId: null };
    const store = this.newPendingStore(run);

    log.step('repo', '检查本地仓库与远端配置');
    const repo = await this.ensureRepo(cfg);
    if (!repo.ok) { result.error = repo.error; return result; }
    if (!cfg.remote) { result.error = '尚未配置远端仓库，无法取回。请先执行一次推送或填写仓库地址。'; log.error('repo', result.error); return result; }

    log.step('fetch', `读取远端 ${cfg.branch} 分支`);
    const fetched = await this.fetchMain(run, cfg);
    if (!fetched.ok) {
      result.error = fetched.error;
      log.error('fetch', result.error);
      return result;
    }
    const tree = await this.remoteTree(cfg.branch);
    if (!tree.exists) { result.error = `远端尚无 ${cfg.branch} 分支数据，请先在本机执行一次推送。`; log.error('fetch', result.error); return result; }
    log.info('fetch', `远端 ${cfg.branch} = ${tree.head.slice(0, 7)}，共 ${tree.files.size} 个文件。`);

    const localHead = await this.git(['rev-parse', '--verify', 'HEAD']);
    const localHeadSha = this.ok(localHead) ? localHead.out.trim() : null;
    result.remoteHead = tree.head;
    result.localHeadBefore = localHeadSha;

    // 取回永远是「把远端并入本机」：git 的分支是整份快照，没法只前进一个文件。
    // scope 在这里只影响报告口径与工作区目标，主数据的处理是同一条路。
    await this.pullAll(run, cfg, tree, result, store, opts);

    if (opts.includeWorkspace && !result.hardError) {
      const targets = this.workspaceTargets(opts);
      if (!targets.length) log.info('ws', '无匹配工作区。');
      else {
        log.step('ws', `开始取回 ${targets.length} 个工作区`);
        for (const ws of targets) {
          const r = await this.pullWorkspace(run, cfg, ws, store);
          result.workspaces.push(r);
        }
      }
    } else {
      log.info('ws', '本次不含工作区文件。');
    }

    if (store.conflicts.length) {
      result.pendingId = this.savePending(store).id;
      result.conflicts = store.conflicts;
      result.error = `${store.conflicts.length} 项冲突待裁决，本机文件未改动。`;
      log.error('end', result.error);
    } else if (result.aligned && !result.hardError) {
      log.done('end', '本机已与远端对齐。');
    }
    return result;
  }


  /**
   * 取回：逐个单元决定，然后做一次真实的合并，但**保护住不能自动覆盖的单元**。
   *
   * 不能动的单元（保护 = 合并后恢复本机版本并登记待裁决）：
   *   - 本机忽略的会话（含它的投影缓存）
   *   - 已经有未裁决冲突的路径
   *   - A11 远端删除 / A12 删除+修改 / A13 修改+删除 —— 删除类一律不自动生效
   *   - A5 真冲突（会话日志分叉、文本重叠、二进制两边都改）
   * 例外：投影缓存是派生数据，两边都改时直接取本机。
   */
  async pullAll(run, cfg, tree, result, store, opts = {}) {
    const log = run.progress;
    const ref = `refs/remotes/origin/${cfg.branch}`;
    const g = (args, o) => this.git(args, o);

    await this.snapshotLocalState(run, cfg, { repo: 'main', cwd: this.home, kindLabel: '主数据' });

    const pendingSet = this.pendingPathSet('main');
    const ctx = {
      repo: 'main', g, ref, branch: cfg.branch, kindLabel: '主数据', label: '主数据',
      ignore: (p) => this.pathIsMuted(p, 'main', pendingSet),
    };
    const cls = await this.classifyUnits(run, cfg, ctx);
    if (!cls.ok || cls.noRemote) { result.error = '远端尚无可用分支。'; return; }
    if (cls.noLocal) { result.error = '本地仓库尚未初始化，请先执行一次推送。'; return; }

    const protect = new Set();   // 合并后要恢复本机版本的路径
    const holds = [];            // 要登记成待裁决的单元
    const contentMerges = [];    // 需要写回内容合并结果的单元（A4）
    const cacheOurs = [];        // 派生缓存：直接取本机

    for (const u of cls.units) {
      if (u.state === 'IGNORED') { protect.add(u.path); continue; }
      if (u.state === 'A11' || u.state === 'A12' || u.state === 'A13') {
        const reason = u.state === 'A11' ? 'remote-deleted' : u.state === 'A12' ? 'delete-modify' : 'modify-delete';
        const remembered = this.unitDecision(`main:${u.path}`);
        if (remembered) {
          // 已经为这个路径做过决定，不再重复问
          protect.add(u.path);
          if (remembered.choice === 'delete') {
            protect.delete(u.path);
            log.info('pull', `${u.path}：按已有决定，本机同时删除。`);
          } else {
            log.info('pull', `${u.path}：按已有决定，本机保留。`);
          }
          continue;
        }
        protect.add(u.path);
        holds.push({ unit: u, reason });
        continue;
      }
      if (u.state === 'A5') {
        if (u.kind === 'cache') { cacheOurs.push(u); continue; }
        protect.add(u.path);
        holds.push({ unit: u, reason: u.kind === 'binary' ? 'binary-both-changed' : 'text-overlap' });
        continue;
      }
      if (u.state === 'A4' || u.state === 'A8') {
        const m = u.kind === 'cache' ? { ok: true, content: null } : await this.mergeUnitContent(g, u, u.kind);
        if (m.ok && m.content) { contentMerges.push({ unit: u, content: m.content }); continue; }
        if (u.kind === 'cache') { cacheOurs.push(u); continue; }
        protect.add(u.path);
        holds.push({ unit: u, reason: m.reason || 'divergent-session-history' });
        continue;
      }
      // A1 / A2 / A3 / A6 / A7 / A9 / A10：交给 git（A2/A6/A9 本机侧本来就不该被改）
    }
    if (!holds.length && !protect.size) result.aligned = true;

    // 合并会改写工作树，而会话日志正被 DSH 持续追加 —— 先记下来，合并完再核对。
    // 只记这次判定涉及的会话日志（不是全部），避免把整个 sessions 目录读进内存。
    const beforeLogs = new Map();
    for (const u of cls.units) {
      if (!isSessionLogPath(u.path)) continue;
      try { beforeLogs.set(u.path, fs.readFileSync(path.join(this.home, u.path))); } catch { /* 不存在就算了 */ }
    }

    // 能纯快进就快进（干净、不留合并提交）
    const localHead = await g(['rev-parse', '--verify', 'HEAD']);
    const anc = await g(['merge-base', '--is-ancestor', localHead.out.trim(), cls.remoteHead]);
    if (this.ok(anc) && !protect.size && !contentMerges.length) {
      if (localHead.out.trim() === cls.remoteHead) { log.info('pull', '本机与远端一致。'); return; }
      log.step('pull', '快进至远端');
      const ff = await g(['merge', '--ff-only', ref], { timeoutMs: 900000 });
      if (this.ok(ff)) { log.done('pull', '已快进至远端。'); return; }
      log.warn('pull', `快进失败，改用逐条合并：${clip(ff.err || ff.code)}`);
    }

    log.step('pull', '并入远端改动（逐条保护）');
    const mergeHeadPath = path.join(this.home, '.git', 'MERGE_HEAD');
    let mg = await g(['merge', '--no-commit', '--no-ff', ref], { timeoutMs: 1800000 });
    let merging = fs.existsSync(mergeHeadPath);
    if (!merging && !this.ok(mg)) {
      await g(['merge', '--no-commit', '--no-ff', '--allow-unrelated-histories', ref], { timeoutMs: 1800000 });
      merging = fs.existsSync(mergeHeadPath);
    }
    if (!merging && !this.ok(mg)) {
      result.hardError = true;
      result.error = `合并远端失败：${clip(mg.err || mg.code)}`;
      log.error('pull', result.error);
      return;
    }

    // 内容合并（A4：纯追加的会话日志）
    for (const cm of contentMerges) {
      const abs = path.join(this.home, cm.unit.path);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // 从判定到写回之间 DSH 很可能又追加了行，所以写之前重新读一次磁盘
        const safe = this.sessionLogSafeBuf(cm.unit.path, cm.content);
        if (safe.mode === 'keep-disk') {
          log.warn('pull', `${cm.unit.path}：磁盘上又追加了新内容，保留较新的那一份，不覆盖。`);
        } else if (safe.mode === 'conflict') {
          protect.add(cm.unit.path);
          holds.push({ unit: cm.unit, reason: 'divergent-session-history' });
          log.warn('pull', `${cm.unit.path}：无法与磁盘上的内容安全拼接，保留本机并登记待裁决。`);
          continue;
        }
        writeFileAtomic(abs, safe.buf);
        await g(['add', '--', cm.unit.path]);
        result.merged.push({ path: cm.unit.path, mode: 'append' });
        log.info('pull', `${cm.unit.path}：双方均为纯追加，已自动合并。`);
      } catch (e) {
        log.error('pull', `${cm.unit.path}：写回合并结果失败 ${e?.message || e}`);
      }
    }
    // 派生缓存：取本机
    for (const u of cacheOurs) {
      await g(['checkout', 'HEAD', '--', u.path]);
      await g(['add', '--', u.path]);
    }
    // 保护：恢复本机版本并登记待裁决
    for (const path_ of protect) {
      const exists = await g(['cat-file', '-e', `HEAD:${path_}`]);
      if (this.ok(exists)) { await g(['checkout', 'HEAD', '--', path_]); await g(['add', '--', path_]); }
      else { await g(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path_]); }
    }
    // 核对：合并（以及上面的 checkout 恢复）有没有把会话日志改回旧版本。
    // before 是合并前磁盘上的内容，也就是最「新」的那一份。
    for (const [rel, buf] of beforeLogs) {
      const abs = path.join(this.home, rel);
      let after = null;
      try { after = fs.readFileSync(abs); } catch { after = null; }
      if (after && after.equals(buf)) continue;
      // before 是 after 的前缀 → after 包含本机全部内容，说明 git 正确前进了
      const m = after ? mergeSessionLog(buf, after) : null;
      if (m && m.ok && m.mode === 'theirs') continue;
      // 其余情况：合并结果反而更旧，或与磁盘内容无法拼接 → 保住较新的那一份
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileAtomic(abs, buf);
      await g(['add', '--', rel]);
      log.warn('pull', `${rel}：合并结果不含本机已有的新增行，已保留较新的那一份（避免日志被截断后出现 seq 断点）。`);
    }

    // 兜底：git 自己产生的、我们没预判到的冲突（例如无共同历史下的 add/add）。
    // 一律恢复本机版本并登记待裁决 —— 绝不能把冲突标记提交进去。
    const leftU = await g(['diff', '--name-only', '--diff-filter=U']);
    const unmerged = this.ok(leftU) ? leftU.out.split('\n').map((x) => x.trim()).filter(Boolean) : [];
    for (const path_ of unmerged) {
      const exists = await g(['cat-file', '-e', `HEAD:${path_}`]);
      if (this.ok(exists)) { await g(['checkout', 'HEAD', '--', path_]); await g(['add', '--', path_]); }
      else { await g(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path_]); }
      if (protect.has(path_)) continue;
      protect.add(path_);
      const unit = cls.units.find((u) => u.path === path_) || { path: path_, kind: unitKindOf(path_), theirs: null, state: 'A8' };
      holds.push({ unit, reason: 'text-overlap' });
      log.warn('conflict', `${path_}：git 报告双方均已修改，已恢复本机版本并登记待裁决。`);
    }

    // 格式校验：不管前面怎么合并、怎么恢复，只要有任何会话日志变成非法
    // （seq 断点 / seq 重复 / 解析不了），就用合并前的那一份把它换回来。
    // 宁可这次少同步一个会话，也不能让一个坏掉的日志被提交、被推到另一台机器。
    let repaired = 0;
    for (const [rel, buf] of beforeLogs) {
      const abs = path.join(this.home, rel);
      let after = null;
      try { after = fs.readFileSync(abs); } catch { after = null; }
      if (!after) continue;
      const v = inspectSessionLog(after);
      if (v.ok) continue;
      const p = v.problems[0] || {};
      writeFileAtomic(abs, buf);
      await g(['add', '--', rel]);
      repaired += 1;
      log.error('pull', `${rel}：合并结果不是合法的会话日志（${p.reason}${p.line ? '@第 ' + p.line + ' 行' : ''}），已恢复为合并前的内容。`);
    }
    if (repaired) log.warn('pull', `${repaired} 个会话日志的合并结果不合法，已恢复合并前的内容（这几个会话本次未同步）。`);

    for (const h of holds) {
      const meta = this.describeConflictPath(h.unit.path);
      const theirs = h.unit.theirs ? await this.readBlob(g, h.unit.theirs.sha) : null;
      await this.recordConflict(store, {
        repo: 'main', relPath: h.unit.path,
        kind: h.unit.kind === 'session-log' ? 'session-log' : 'file',
        reason: h.reason,
        theirsRef: theirs,
        sessionId: meta.sessionId, title: meta.title, state: h.unit.state,
      });
      log.warn('conflict', `${h.unit.path}：${holdReasonText(h.reason)}；本机文件未改动，等待裁决。`);
    }

    const cm = await g(['commit', '-m', `${cfg.commitMessage}: 取回远端改动 (${nowStamp()})`], { timeoutMs: 600000 });
    if (!this.ok(cm)) {
      log.warn('pull', `合并收尾提交失败：${clip(cm.err || cm.out)}`);
    } else {
      result.localHeadAfter = cm.out.trim();
      log.done('pull', '远端改动已并入本机。');
    }
    if (!holds.length) result.aligned = true;
  }


  async pullWorkspace(run, cfg, ws, store) {
    const log = run.progress;
    const label = ws.title || path.basename(ws.path) || ws.id;
    const resolved = this.resolveWorkspacePath(ws, cfg);
    const realPath = resolved.path;
    if (!realPath) { log.error('ws', `工作区「${label}」没有可用路径。`); return { id: ws.id, title: label, path: null, error: 'no-path' }; }
    if (resolved.source === 'remapped') log.info('ws', `工作区「${label}」记录路径 ${resolved.recorded} 不存在，已按本机主目录调整为 ${realPath}`);
    try { fs.mkdirSync(realPath, { recursive: true }); }
    catch (e) { return { id: ws.id, title: label, path: realPath, error: 'mkdir' }; }
    const mirror = await this.ensureWorkspaceMirror(ws.id, realPath, cfg);
    if (!mirror.ok) { log.error('ws', `工作区「${label}」：${mirror.error}`); return { id: ws.id, title: label, path: realPath, error: mirror.error }; }
    const { gitdir, branch } = mirror;
    this.reportNestedRepos(log, label, mirror.nested, cfg);
    const fetch = await this.gitW(gitdir, realPath, ['fetch', 'origin', '--prune', '--progress'], {
      timeoutMs: 1800000,
      onStderr: (d) => logTransfer(log, 'ws-fetch', d),
    });
    if (!this.ok(fetch)) {
      const probe = await this.gitW(gitdir, realPath, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeoutMs: 120000 });
      if (!this.ok(probe) || probe.out.trim()) {
        log.error('ws', `工作区「${label}」读取远端失败：${clip(fetch.err || fetch.code)}`);
        return { id: ws.id, title: label, path: realPath, error: 'fetch' };
      }
      log.info('ws', `工作区「${label}」远端尚无该分支，无需取回。`);
      return { id: ws.id, title: label, path: realPath, skipped: 'no-remote' };
    }
    const remoteHead = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
    if (!this.ok(remoteHead)) { log.info('ws', `工作区「${label}」远端无内容。`); return { id: ws.id, title: label, path: realPath, skipped: 'no-remote' }; }
    let localHead = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', 'HEAD']);
    if (!this.ok(localHead)) {
      log.step('ws', `工作区「${label}」本机无内容，从远端整体取回`);
      const rs = await this.gitW(gitdir, realPath, ['reset', '--hard', `origin/${branch}`], { timeoutMs: 600000 });
      if (this.ok(rs)) { log.done('ws', `工作区「${label}」已取回至 ${realPath}`); return { id: ws.id, title: label, path: realPath, pulled: 'reset' }; }
      log.error('ws', `工作区「${label}」取回失败：${clip(rs.err || rs.code)}`);
      return { id: ws.id, title: label, path: realPath, error: 'reset' };
    }
    if (localHead.out.trim() === remoteHead.out.trim()) {
      log.info('ws', `工作区「${label}」已是最新。`);
      return { id: ws.id, title: label, path: realPath, upToDate: true };
    }
    // 本机项目文件有未提交改动时，ff/merge 都会被 git 拒绝；先落一个本地快照。
    // 快照会产生一个新提交，所以之后必须重新读取 localHead，否则后面的
    // 「是否可快进」判断会基于过期的 HEAD 做出错误决定。
    await this.snapshotLocalState(run, cfg, { repo: `ws:${ws.id}`, gitdir, worktree: realPath, kindLabel: `工作区「${label}」` });
    localHead = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', 'HEAD']);
    const anc = await this.gitW(gitdir, realPath, ['merge-base', '--is-ancestor', localHead.out.trim(), remoteHead.out.trim()]);
    if (this.ok(anc)) {
      log.step('ws', `工作区「${label}」快进至远端`);
      const mg = await this.gitW(gitdir, realPath, ['merge', '--ff-only', `origin/${branch}`], { timeoutMs: 600000 });
      if (this.ok(mg)) { log.done('ws', `工作区「${label}」已快进至远端。`); return { id: ws.id, title: label, path: realPath, pulled: 'ff' }; }
      log.error('ws', `工作区「${label}」快进失败：${clip(mg.err || mg.code)}`);
      return { id: ws.id, title: label, path: realPath, error: 'ff' };
    }
    log.step('ws', `工作区「${label}」合并远端改动`);
    const merged = await this.mergeWithRemote(run, cfg, store, {
      repo: `ws:${ws.id}`, cwd: realPath, gitdir, worktree: realPath, label, kindLabel: `工作区「${label}」`,
    });
    if (merged === 'conflict') {
      log.error('ws', `工作区「${label}」存在冲突，已中止合并，本机文件未改动。`);
      return { id: ws.id, title: label, path: realPath, error: 'conflict' };
    }
    if (merged === 'error') return { id: ws.id, title: label, path: realPath, error: 'merge' };
    if (merged === 'uptodate') return { id: ws.id, title: label, path: realPath, upToDate: true };
    log.done('ws', `工作区「${label}」已与远端合并。`);
    return { id: ws.id, title: label, path: realPath, pulled: 'merge' };
  }

  /* ================= 合并原语 ================= */

  /**
   * 把本机工作树落成一个本地快照提交（只提交，不推送）。
   * git 在「合并会改到的文件有未提交改动」时会拒绝合并；而 DSH 几乎一直
   * 在写会话日志，所以取回前必须先固定本机状态。这一步本身不丢任何东西。
   * @returns {boolean} 是否产生了新提交
   */
  async snapshotLocalState(run, cfg, ctx) {
    const { repo, gitdir = null, worktree = null, kindLabel = '主数据' } = ctx;
    const g = (args, opts = {}) => (gitdir ? this.gitW(gitdir, worktree, args, opts) : this.git(args, opts));
    const st = await g(['status', '--porcelain']);
    if (!this.ok(st) || !st.out.trim()) return false;
    const count = st.out.split('\n').filter(Boolean).length;
    await g(['add', '-A'], { timeoutMs: 900000 });
    const cm = await g(['commit', '-m', `${cfg.commitMessage}: 取回前的本机快照 (${nowStamp()})`]);
    if (!this.ok(cm)) {
      run.progress.warn('snapshot', `${kindLabel} 本机改动无法提交为快照：${clip(cm.err || cm.out)}`);
      return false;
    }
    run.progress.info('snapshot', `${kindLabel} 已将本机 ${count} 项改动提交为本地快照（仅本地提交，不上传）。`);
    return true;
  }

  /**
   * 把远端分支合并进当前仓库。
   *
   * 与旧插件的关键差别：**冲突不自动取本机**。
   * 这里先把远端版本抄一份留档，然后 `git merge --abort`，让工作树停在与操作前
   * 完全一致的状态，由用户逐项裁决。
   *
   * @returns {'ok'|'uptodate'|'conflict'|'error'}
   */
  async mergeWithRemote(run, cfg, store, ctx) {
    const log = run.progress;
    const { repo, gitdir = null, worktree = null, kindLabel = '主数据' } = ctx;
    const g = (args, opts = {}) => (gitdir ? this.gitW(gitdir, worktree, args, opts) : this.git(args, opts));
    const workdir = worktree || this.home;
    const ref = `origin/${this.branchOfRepo(repo, cfg)}`;
    let localHead = await g(['rev-parse', '--verify', 'HEAD']);
    const remoteHead = await g(['rev-parse', '--verify', ref]);
    if (!this.ok(remoteHead)) return 'uptodate';
    if (this.ok(localHead) && localHead.out.trim() === remoteHead.out.trim()) return 'uptodate';

    if (!this.ok(localHead)) {
      // 本机还没有任何提交（换台电脑第一次取回）：先把本机现状落成一个初始快照，
      // 这样本机已有的会话/项目文件不会在随后的合并里被当成「多余文件」抹掉。
      if (repo === 'main') await this.handOverGeneratedIgnore(g, ref, cfg, workdir, log);
      await g(['add', '-A'], { timeoutMs: 900000 });
      const cm = await g(['commit', '-m', `${cfg.commitMessage}: 加入同步前的本机快照 (${nowStamp()})`]);
      if (!this.ok(cm)) {
        // 连一个可提交的文件都没有（空目录）→ 直接采用远端内容
        log.info('merge', `${kindLabel} 本机为空，直接采用远端内容。`);
        const rs = await g(['reset', '--hard', ref], { timeoutMs: 1800000 });
        if (this.ok(rs)) return 'ok';
        log.error('merge', `${kindLabel} 采用远端内容失败：${clip(rs.err || rs.code)}`);
        return 'error';
      }
      log.info('merge', `${kindLabel} 本机现状已先提交为初始快照，再进行合并。`);
      localHead = await g(['rev-parse', '--verify', 'HEAD']);
    }

    const base = await g(['merge-base', localHead.out.trim(), remoteHead.out.trim()]);
    const unrelated = !this.ok(base);
    if (unrelated) log.info('merge', `${kindLabel} 与本机没有共同历史，按「合并两段独立历史」处理（双方同路径不同内容会列为冲突）。`);

    const mg = await g(['merge', '--no-edit', ...(unrelated ? ['--allow-unrelated-histories'] : []), ref], { timeoutMs: 1800000 });
    const mergeHeadExists = fs.existsSync(path.join(gitdir || path.join(this.home, '.git'), 'MERGE_HEAD'));
    if (this.ok(mg)) return 'ok';
    if (!mergeHeadExists) {
      log.error('merge', `${kindLabel} 合并失败：${clip(mg.err || mg.out || mg.code)}`);
      return 'error';
    }
    // —— 有冲突：留档远端版本，然后原样回退 ——
    const cf = await g(['diff', '--name-only', '--diff-filter=U']);
    const conflicted = this.ok(cf) ? cf.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    log.warn('merge', `${kindLabel} 有 ${conflicted.length} 项冲突，正在逐项处理…`);
    // 会话投影缓存是 DSH 自己会重建的派生数据，冲突时保留本机即可 —— 让它上升到
    // 「需要你裁决」只会制造噪音（旧的 dsh-chatsync 也是这么处理的）。
    const remaining = [];
    for (const rel of conflicted) {
      if (!rel || rel.includes('\0')) continue;
      if (isRegenerableCache(rel)) {
        await g(['checkout', '--ours', '--', rel]);
        await g(['add', '--', rel]);
        log.info('merge', `  ${kindLabel} ${rel}：派生缓存，采用本机版本（DSH 会重建）。`);
        continue;
      }
      remaining.push(rel);
    }
    if (!remaining.length) {
      const left = await g(['diff', '--name-only', '--diff-filter=U']);
      if (this.ok(left) && !left.out.trim()) {
        const cm = await g(['commit', '-m', `${cfg.commitMessage}: 合并远端（派生缓存采用本机版本） (${nowStamp()})`], { timeoutMs: 600000 });
        if (this.ok(cm)) { log.done('merge', `${kindLabel} 已合并远端改动（只有可再生缓存冲突，已自动取本机）。`); return 'ok'; }
      }
    }
    for (const rel of remaining) {
      const meta = this.describeConflictPath(rel);
      const theirs = await g(['show', `MERGE_HEAD:${rel}`], { binary: true, timeoutMs: 300000 });
      await this.recordConflict(store, {
        repo,
        relPath: rel,
        kind: meta.kind,
        reason: meta.kind === 'session-log' ? 'divergent-session-history' : 'text-overlap',
        baseRef: null,
        theirsRef: this.ok(theirs) ? theirs.out : null,
        localRef: null,
        sessionId: meta.sessionId,
        title: meta.title,
        workspaceLabel: ctx.label || null,
      });
      log.warn('conflict', `  ${kindLabel} ${rel}${meta.title ? `（${meta.title}）` : ''}：双方均已修改，需裁决。`);
    }
    const abort = await g(['merge', '--abort'], { timeoutMs: 300000 });
    if (!this.ok(abort)) log.error('merge', `回退合并失败：${clip(abort.err || abort.code)}；工作树可能仍处于合并中状态。`);
    else log.info('merge', `${kindLabel} 已回退到合并前状态，本机文件未改动。`);
    return 'conflict';
  }

  /**
   * 空仓库第一次取回时，本机 `.gitignore` 是插件刚生成的那一份，而远端往往已有一份。
   * 两份不同就会在无共同历史的合并里变成一个纯粹的假冲突。
   * 只有当本机这份「确实是我们自己生成的、用户没改过」时，才让远端版本接管。
   */
  async handOverGeneratedIgnore(g, ref, cfg, workdir, log) {
    try {
      const has = await g(['cat-file', '-e', `${ref}:.gitignore`]);
      if (!this.ok(has)) return;
      const p = path.join(workdir, '.gitignore');
      if (!fs.existsSync(p)) return;
      const generated = BUILTIN_IGNORE + '\n' + (cfg.extraIgnore || []).join('\n') + '\n';
      if (fs.readFileSync(p, 'utf8') !== generated) return; // 用户手工改过 → 保留，让真实差异走冲突流程
      fs.unlinkSync(p);
      log.info('merge', '本机 .gitignore 由插件生成且远端已存在，已让远端版本接管（避免首次取回产生假冲突）。');
    } catch { /* 失败就按普通文件处理 */ }
  }

  describeConflictPath(rel) {
    const m = SESSION_LOG_PATH_RE.exec(rel);
    if (m) {
      const id = sessionIdOfPath(rel);
      return { kind: 'session-log', sessionId: id, title: readSessionTitle(this.home, id) || '' };
    }
    return { kind: 'file', sessionId: null, title: null };
  }


  /** 某个路径在本机是否相对 HEAD 有改动（含未跟踪） */
  async pathIsLocallyChanged(rel) {
    const r = await this.git(['status', '--porcelain', '--', rel]);
    return this.ok(r) && Boolean(r.out.trim());
  }

  /* ================= 冲突裁决 ================= */

  /**
   * 应用用户对冲突的裁决。
   * @param {{pendingId:string, decisions:Array<{id:string, choice:'local'|'remote'|'both'}>}} input
   */
  async resolveConflicts(input) {
    const pending = this.listPending().find((p) => p.id === input.pendingId);
    if (!pending) return { ok: false, error: '未找到该待裁决记录（可能已处理或清理）。' };
    const decisions = new Map((input.decisions || []).map((d) => [d.id, d.choice]));
    // 允许部分裁决：只处理这次选了处理方式的那几项，其余原样留在待裁决记录里。
    const decided = pending.conflicts.filter((c) => decisions.has(c.id));
    const remaining = pending.conflicts.filter((c) => !decisions.has(c.id));
    if (!decided.length) {
      return { ok: false, needsChoice: true, error: '还没有选择任何一项的处理方式。' };
    }
    const run = new RunState({ runId: randomUUID(), direction: 'pull', scope: 'resolve', reason: 'resolve-conflicts' });
    this.currentRun = run;
    this._cfg = this.loadConfig();
    const log = run.progress;
    const cfg = this._cfg;
    const result = { resolved: [], both: [], errors: [] };
    try {
      // 按仓库分组处理
      // 更早版本记录的待裁决没有 side 字段。delete-local 只可能在推送侧产生，
      // 据此补上 —— 否则它会被当成取回侧冲突，送进不支持删除裁决的代码里。
      const sideOf = (c) => c.side || (c.reason === 'delete-local' ? 'delivery' : 'pull');
      const deliveryConflicts = decided.filter((c) => c.repo === 'main' && sideOf(c) === 'delivery');
      const mainConflicts = decided.filter((c) => c.repo === 'main' && sideOf(c) !== 'delivery');
      if (deliveryConflicts.length) {
        const sub = { ...pending, conflicts: deliveryConflicts };
        await this.resolveDeliveryUnits(run, cfg, sub, decisions, result, this.newPendingStore(run));
      }
      if (mainConflicts.length) {
        await this.resolveInRepo(run, cfg, pending, mainConflicts, decisions, result, { repo: 'main', cwd: this.home, kindLabel: '主数据' });
      }
      const wsGroups = new Map();
      for (const c of decided.filter((x) => x.repo !== 'main')) {
        if (!wsGroups.has(c.repo)) wsGroups.set(c.repo, []);
        wsGroups.get(c.repo).push(c);
      }
      for (const [repo, list] of wsGroups) {
        const wsId = repo.slice(3);
        const ws = this.workspaceRecords().find((w) => w.id === wsId);
        if (!ws) { result.errors.push(`${repo}: 工作区已不在登记表中，无法处理。`); continue; }
        // 必须走和同步时同一套路径解析：登记表里的路径可能是另一台电脑的绝对路径。
        const realPath = this.resolveWorkspacePath(ws, cfg).path;
        if (!realPath) { result.errors.push(`${repo}: 工作区无可用路径。`); continue; }
        const mirror = await this.ensureWorkspaceMirror(wsId, realPath, cfg);
        if (!mirror.ok) { result.errors.push(`${repo}: ${mirror.error}`); continue; }
        await this.resolveInRepo(run, cfg, pending, list, decisions, result, {
          repo, cwd: realPath, gitdir: mirror.gitdir, worktree: realPath,
          kindLabel: `工作区「${ws.title || path.basename(realPath)}」`,
        });
      }
      if (result.errors.length) return { ok: false, error: result.errors.join('；'), detail: result, log: log.all() };
      if (remaining.length) {
        const manifest = { ...pending, conflicts: remaining, id: pending.id };
        delete manifest.dir;
        fs.writeFileSync(path.join(pending.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
        log.done('end', `已按裁决处理 ${decided.length} 项，剩余 ${remaining.length} 项待裁决。`);
      } else {
        this.clearPending(pending.id);
        log.done('end', `已按裁决处理 ${decided.length} 项冲突，全部完成。`);
      }
      return { ok: true, detail: result, remaining: remaining.length, log: log.all() };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), log: run.progress.all() };
    } finally {
      run.running = false;
      run.finishedAt = Date.now();
      this.lastRun = run;
    }
  }

  async resolveInRepo(run, cfg, pending, conflicts, decisions, result, ctx) {
    const log = run.progress;
    const { repo, gitdir = null, worktree = null, kindLabel } = ctx;
    const g = (args, opts = {}) => (gitdir ? this.gitW(gitdir, worktree, args, opts) : this.git(args, opts));
    const ref = `origin/${this.branchOfRepo(repo, cfg)}`;

    // 重新走一次合并，让 git 重新产生这些冲突，然后按裁决逐个物化。
    // merge 要求工作树对「它要改的文件」没有未提交改动，所以先把本机现状落成快照；
    // 这一步也保证裁决完成后分支是真的和远端对齐了（提交会成为 merge 提交）。
    await this.snapshotLocalState(run, cfg, ctx);
    const localHead = await g(['rev-parse', '--verify', 'HEAD']);
    const remoteHead = await g(['rev-parse', '--verify', ref]);
    const mergeHeadPath = path.join(gitdir || path.join(this.home, '.git'), 'MERGE_HEAD');
    // 「合并进行中」的唯一判据是 MERGE_HEAD 存在。
    // `git merge` 返回 0 也可能是 "Already up to date."（本机已经包含远端），
    // 那种情况下并没有待提交的合并，不能按合并收尾去 commit，否则会撞上
    // 「无文件要提交，工作区干净」。
    let mergeStarted = false;
    if (this.ok(remoteHead) && (!this.ok(localHead) || localHead.out.trim() !== remoteHead.out.trim())) {
      const mg = await g(['merge', '--no-commit', '--no-ff', ref], { timeoutMs: 900000 });
      mergeStarted = fs.existsSync(mergeHeadPath);
      if (!mergeStarted && !this.ok(mg)) {
        await g(['merge', '--no-commit', '--no-ff', '--allow-unrelated-histories', ref], { timeoutMs: 900000 });
        mergeStarted = fs.existsSync(mergeHeadPath);
      }
    }
    if (!mergeStarted) {
      log.info('resolve', `${kindLabel} 本机历史已包含远端改动，无需额外的合并提交。`);
    }
    try {
      for (const c of conflicts) {
        const choice = decisions.get(c.id);
        const rel = c.path;
        const label = c.title ? `「${c.title}」` : rel;
        if (choice === 'local') {
          if (mergeStarted) { await g(['checkout', '--ours', '--', rel]); await g(['add', '--', rel]); }
          log.info('resolve', `${kindLabel} ${rel}${c.title ? ` ${label}` : ''}：保留本机版本。`);
          result.resolved.push({ id: c.id, choice });
          continue;
        }
        if (choice === 'remote') {
          if (mergeStarted) { await g(['checkout', '--theirs', '--', rel]); await g(['add', '--', rel]); }
          else if (c.theirsCopy) {
            const src = path.join(pending.dir, c.theirsCopy);
            const dest = path.join(this.home, ...(repo === 'main' ? [rel] : []));
            if (repo === 'main') { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); await g(['add', '--', rel]); }
            else { const d2 = path.join(worktree, rel); fs.mkdirSync(path.dirname(d2), { recursive: true }); fs.copyFileSync(src, d2); await g(['add', '--', rel]); }
          }
          log.info('resolve', `${kindLabel} ${rel}${c.title ? ` ${label}` : ''}：采用远端版本。`);
          result.resolved.push({ id: c.id, choice });
          continue;
        }
        // 删除类裁决。原来这里没有分支，任何非 local/remote 的选择都会掉进下面的
        // 「两边都留」，而去读一个并不存在的远端副本 —— 直接抛
        // `The "path" argument must be of type string. Received null`。
        if (choice === 'delete' || choice === 'keep') {
          if (!['delete-local', 'delete-modify', 'modify-delete', 'remote-deleted'].includes(c.reason)) {
            result.errors.push(`${rel}: 这个冲突不支持「${choice === 'delete' ? '删除' : '保留'}」这种裁决。`);
            log.error('resolve', `${rel}：${c.reason} 不支持删除类裁决。`);
            continue;
          }
          // 关键：必须把决定记下来。删除只会在**推送侧**被真正交付 ——
          // resolveUnitForDelivery / resolveDeliveryUnits 读的就是这个键。
          // 不记的话，这里只是把路径从本机索引里摘掉、再提交一个本地快照，
          // 而远端始终没收到删除；下次推送会把同一批路径重新问一遍。
          // 这正是「选了全部删除到远端、应用后却毫无变化」的成因。
          this.setUnitDecision(`${repo}:${rel}`, choice);
          if (choice === 'delete') {
            // 不再跟踪它（本机文件与嵌套仓库的内容都留在磁盘上，只是不进版本库）
            await g(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', rel]);
            log.info('resolve', `${kindLabel} ${rel}：已按裁决不再跟踪它，删除将在下次推送时交付给远端。`);
          } else {
            // 撤销本机的删除：把远端那一份放回来
            await g(['checkout', ref, '--', rel]);
            await g(['add', '--', rel]);
            log.info('resolve', `${kindLabel} ${rel}：按裁决保留它，本机的删除已撤销。`);
          }
          result.resolved.push({ id: c.id, choice });
          continue;
        }

        // both：两边都留
        if (c.kind === 'session-log' && c.sessionId) {
          const newId = newSessionId();
          if (mergeStarted) { await g(['checkout', '--ours', '--', rel]); await g(['add', '--', rel]); }
          let newPath = null;
          try {
            const theirsBuf = c.theirsCopy ? fs.readFileSync(path.join(pending.dir, c.theirsCopy)) : null;
            if (theirsBuf) newPath = duplicateSessionLog(this.home, theirsBuf, newId, path.basename(rel));
          } catch { newPath = null; }
          if (newPath) {
            const newRel = normRel(path.relative(this.home, newPath));
            await this.git(['add', '-f', '--', newRel]);
            await this.registerSessionInWorkspace(c.sessionId, newId);
            log.info('resolve', `${kindLabel} 会话 ${label}：本机版本保留，远端版本已导入为新会话 ${shortId(newId)}。`);
            result.both.push({ id: c.id, newSessionId: newId, newPath: newRel });
          } else {
            result.errors.push(`${rel}: 无法将远端会话导入为新会话（日志无法解析）。`);
            log.error('resolve', `${rel}: 无法导入远端会话，「两边都留」失败。`);
          }
        } else {
          if (mergeStarted) { await g(['checkout', '--ours', '--', rel]); await g(['add', '--', rel]); }
          // 没有留档远端版本就没法「另存一份」—— 明确报错，绝不让 path.join(null) 抛出来
          if (!c.theirsCopy) {
            result.errors.push(`${rel}: 这条冲突没有留存远端版本，无法「两边都留」，请改用其他裁决。`);
            log.error('resolve', `${rel}：没有留存远端版本，「两边都留」不可用。`);
            continue;
          }
          const suffix = `.remote-${ts()}`;
          const copyRel = rel + suffix;
          const src = path.join(pending.dir, c.theirsCopy);
          const dest = repo === 'main' ? path.join(this.home, copyRel) : path.join(worktree, copyRel);
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            await g(['add', '-f', '--', copyRel]);
            log.info('resolve', `${kindLabel} ${rel}：本机版本保留，远端版本另存为 ${copyRel}。`);
            result.both.push({ id: c.id, newPath: copyRel });
          } catch (e) {
            result.errors.push(`${rel}: 保存远端副本失败 ${e?.message || e}`);
          }
        }
        result.resolved.push({ id: c.id, choice });
      }
      // 兜底：这次没裁决、以及 git 报出的我没预判到的冲突，一律恢复本机版本。
      // 这样合并不但能收尾，这些单元也仍然「待裁决」—— 下次点「应用」继续处理。
      const leftU = await g(['diff', '--name-only', '--diff-filter=U']);
      const unmerged = this.ok(leftU) ? leftU.out.split('\n').map((x) => x.trim()).filter(Boolean) : [];
      for (const path_ of unmerged) {
        const exists = await g(['cat-file', '-e', `HEAD:${path_}`]);
        if (this.ok(exists)) { await g(['checkout', 'HEAD', '--', path_]); await g(['add', '--', path_]); }
        else { await g(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path_]); }
      }

      if (mergeStarted) {
        // 合并不是由 git 自己收尾的（我们用了 --no-commit 才能逐项应用裁决），
        // 所以必须显式给提交信息，否则 git 会以「提交说明为空」中止。
        const cm = await g(['commit', '-m', `${cfg.commitMessage}: 合并远端改动并按裁决处理冲突 (${nowStamp()})`], { timeoutMs: 600000 });
        if (!this.ok(cm)) {
          const err = `提交合并结果失败：${clip(cm.err || cm.out)}`;
          result.errors.push(err);
          log.error('resolve', err);
          return;
        }
        log.done('resolve', `${kindLabel} 合并结果已提交。`);
      } else {
        await g(['add', '-A']);
        const st = await g(['status', '--porcelain']);
        if (this.ok(st) && st.out.trim()) {
          const cm = await g(['commit', '-m', `${cfg.commitMessage}: 按裁决应用取回结果 (${nowStamp()})`]);
          if (!this.ok(cm)) result.errors.push(`提交失败：${clip(cm.err || cm.out)}`);
          else log.done('resolve', `${kindLabel} 已提交裁决结果。`);
        }
      }
    } catch (e) {
      result.errors.push(String(e?.message || e));
      try {
        if (fs.existsSync(path.join(gitdir || path.join(this.home, '.git'), 'MERGE_HEAD'))) await g(['merge', '--abort']);
      } catch { /* ignore */ }
    }
  }

  /** 把「两边都留」新建的会话登记到原会话所属工作区，避免它显示成未分组 */
  async registerSessionInWorkspace(oldSessionId, newSessionId) {
    const file = path.join(this.home, 'storages', 'workspace.json');
    const j = readJson(file);
    if (!j?.tables?.workspaces) return false;
    for (const w of Object.values(j.tables.workspaces)) {
      if (!w || !Array.isArray(w.sessionIds)) continue;
      if (!w.sessionIds.includes(oldSessionId)) continue;
      if (w.sessionIds.includes(newSessionId)) return true;
      const idx = w.sessionIds.indexOf(oldSessionId);
      w.sessionIds.splice(idx + 1, 0, newSessionId);
      try { fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8'); } catch { return false; }
      return true;
    }
    return false;
  }

  /**
   * 交付侧（推送）待裁决的收尾。
   * 用户的选择在这里被翻译成两种动作：
   *   - 本端优先（local / delete）→ 记进 forceOurs，重新构造交付提交并推送
   *   - 采用远端（remote / both）→ 把 main 的版本落到本机（both 时另存为新会话/副本）
   */
  async resolveDeliveryUnits(run, cfg, pending, decisions, result, store) {
    const log = run.progress;
    const g = (args, opts) => this.git(args, opts);
    const ref = `refs/remotes/origin/${cfg.branch}`;
    await this.fetchMain(run, cfg);

    const forceOurs = new Map();
    const takeRemote = [];
    const remember = {};

    for (const c of pending.conflicts) {
      const choice = decisions.get(c.id);
      const isDelete = ['delete-local', 'delete-modify', 'modify-delete', 'remote-deleted'].includes(c.reason);
      const key = `${c.repo}:${c.path}`;

      if (isDelete) {
        // 删除类冲突：两种选择在不同状态下的含义不同，必须按 reason 精确执行
        remember[key] = choice;
        // 远端可能早就没有这个文件了（别的机器先删过，或这条记录已经过期）。
        // 那时再「交付删除」无事可做，会让整次裁决以「无可交付内容」失败。
        const goneFromRemote = async () => !this.ok(await g(['cat-file', '-e', `${ref}:${c.path}`]));

        if (c.reason === 'delete-local') {          // 本机删了、main 没动
          if (choice === 'delete') {
            if (await goneFromRemote()) log.info('resolve', `${c.path}：远端已经没有它了，无需再交付删除。`);
            else { forceOurs.set(c.path, 'delete'); log.info('resolve', `${c.path}：将删除同步至远端。`); }
          } else log.info('resolve', `${c.path}：远端保持原样，本机继续不含该文件。`);
        } else if (c.reason === 'delete-modify') {  // 本机删了、main 又改了
          if (choice === 'delete') {
            if (await goneFromRemote()) log.info('resolve', `${c.path}：远端已经没有它了，无需再交付删除。`);
            else { forceOurs.set(c.path, 'delete'); log.info('resolve', `${c.path}：保留删除，并同步至远端。`); }
          } else { takeRemote.push({ c, both: false }); log.info('resolve', `${c.path}：采用远端版本。`); }
        } else if (c.reason === 'modify-delete') {  // main 删了、本机又改了
          if (choice === 'keep') { forceOurs.set(c.path, 'ours'); log.info('resolve', `${c.path}：保留本机版本并推送至远端。`); }
          else { takeRemote.push({ c, both: false }); log.info('resolve', `${c.path}：接受删除，本机同时删除。`); }
        } else {                                   // remote-deleted：main 删了、本机没动
          if (choice === 'delete') { takeRemote.push({ c, both: false }); log.info('resolve', `${c.path}：本机同时删除。`); }
          else log.info('resolve', `${c.path}：本机保留，远端保持已删除。`);
        }
        continue;
      }

      if (choice === 'local') {
        // 「保留本机」= 把本机这一版交付给 main，**不是删除**
        forceOurs.set(c.path, 'ours');
        log.info('resolve', `${c.path}：按裁决将本机版本交付至远端。`);
        continue;
      }
      if (choice === 'remote') {
        takeRemote.push({ c, both: false });
        log.info('resolve', `${c.path}：采用远端版本覆盖本机。`);
        continue;
      }
      if (choice === 'both') {
        forceOurs.set(c.path, 'ours');
        takeRemote.push({ c, both: true });
        log.info('resolve', `${c.path}：本机版本交付至远端，同时将远端版本保留到本机。`);
        continue;
      }
      // keep：什么都不做（main 保持原样，本机保持原样）
      if (isDelete) remember[`${c.repo}:${c.path}`] = 'keep';
    }

    // 采用远端：落到本机
    for (const { c, both } of takeRemote) {
      const theirs = await g(['cat-file', '-e', `${ref}:${c.path}`]);
      const exists = this.ok(theirs);
      if (both && c.kind === 'session-log' && c.sessionId && exists) {
        const blob = await this.readBlob(g, (await g(['rev-parse', `${ref}:${c.path}`])).out.trim());
        const newId = newSessionId();
        const newPath = blob ? duplicateSessionLog(this.home, blob, newId, path.basename(c.path)) : null;
        if (newPath) {
          const rel = normRel(path.relative(this.home, newPath));
          await g(['add', '-f', '--', rel]);
          await this.registerSessionInWorkspace(c.sessionId, newId);
          result.both.push({ id: c.id, newSessionId: newId, newPath: rel });
          log.info('resolve', `远端那一支已导入为新会话 ${newId}。`);
        }
        continue;
      }
      if (exists) {
        await g(['checkout', ref, '--', c.path]);
        log.info('resolve', `已把远端的 ${c.path} 写入本机。`);
      } else {
        try { fs.rmSync(path.join(this.home, c.path), { force: true }); } catch { /* ignore */ }
        await g(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', c.path]);
        log.info('resolve', `远端已删除 ${c.path}，本机也删除。`);
      }
      result.resolved.push({ id: c.id, choice: decisions.get(c.id) });
    }

    const st = await g(['status', '--porcelain']);
    if (this.ok(st) && st.out.trim()) {
      const cm = await g(['commit', '-m', `${cfg.commitMessage}: 按裁决应用取回结果 (${nowStamp()})`], { timeoutMs: 600000 });
      if (this.ok(cm)) log.done('resolve', '本机侧的裁决结果已提交。');
      else log.warn('resolve', `提交失败：${clip(cm.err || cm.out)}`);
    }

    for (const [k, v] of Object.entries(remember)) this.setUnitDecision(k, v);

    // 本端优先的那些：重新构造交付提交并推送
    if (forceOurs.size) {
      log.step('resolve', '将「本机优先」的条目重新交付至远端');
      const ctx = {
        repo: 'main', g, ref, branch: cfg.branch, kindLabel: '主数据', label: '主数据',
        forceOurs,
        ignore: (p) => this.pathIsMuted(p, 'main') && !forceOurs.has(p),
      };
      const build = await this.pushDelivery(run, cfg, store, ctx);
      if (!build.ok) { result.errors.push(build.error || '重新交付失败'); return; }
      if (build.delivered?.length) result.resolved.push({ delivered: build.delivered });
      const stillHeld = (build.held || []).length;
      if (stillHeld) result.errors.push(`还有 ${stillHeld} 项在重新交付时仍无法自动处理`);
    }
  }

  /* ================= 逐单元状态与重新对齐 ================= */

  /** 逐单元状态表（界面用）：哪些会话仅本机改了 / 仅远端改了 / 两边都改 / 已忽略 */
  async unitStates(limit = 600) {
    const cfg = this.loadConfig();
    const ref = `refs/remotes/origin/${cfg.branch}`;
    const g = (args, opts) => this.git(args, opts);
    const noop = { info() {}, warn() {}, step() {}, error() {}, done() {} };
    const fakeRun = { progress: noop };
    const pendingSet = this.pendingPathSet('main');
    const cls = await this.classifyUnits(fakeRun, cfg, {
      repo: 'main', g, ref, kindLabel: '主数据',
      ignore: (p) => this.pathIsMuted(p, 'main', pendingSet),
    });
    if (!cls.ok || cls.noRemote || cls.noLocal) {
      return { ok: false, unrelated: false, units: [], total: 0, reason: cls.noRemote ? 'no-remote' : 'no-local' };
    }
    const out = [];
    for (const u of cls.units) {
      const sid = isSessionLogPath(u.path) ? sessionIdOfPath(u.path) : sessionCacheIdOf(u.path);
      out.push({
        path: u.path,
        state: u.state,
        stateLabel: STATE_LABEL[u.state] || u.state,
        kind: u.kind,
        sessionId: sid || null,
        title: sid ? (readSessionTitle(this.home, sid) || '') : '',
        muted: u.state === 'IGNORED',
        pending: pendingSet.has(u.path),
        needsDecision: ['A5', 'A8', 'A9', 'A11', 'A12', 'A13'].includes(u.state),
      });
    }
    const rank = { A5: 0, A8: 0, A9: 0, A11: 0, A12: 0, A13: 0, A4: 1, A2: 2, A6: 2, A3: 3, A7: 3, A1: 4, IGNORED: 5 };
    out.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.path.localeCompare(b.path));
    return { ok: true, unrelated: cls.unrelated === true, base: cls.base, units: out.slice(0, limit), total: out.length };
  }

  /**
   * 显式强制覆盖单个单元。
   *   mode='pull' → 无条件用 main 的版本覆盖本机这一份（不看本机改动）
   *   mode='push' → 无条件把本机这一份交付给 main（不看 main 的改动）
   * 该路径如果还有未裁决的冲突，先要求去裁决 —— 免得两种决定打架。
   */
  async forceUnit(relPath, mode) {
    const p = normRel(relPath);
    if (!p) return { ok: false, error: '缺少路径。' };
    if (mode !== 'pull' && mode !== 'push') return { ok: false, error: 'mode 只能是 pull 或 push。' };
    // 「强制覆盖」本身就是一种显式裁决：先把这个路径从待裁决记录里摘掉，它不再需要另行决定。
    const cleared = this.clearPendingForPath('main', p);
    const cfg = this.loadConfig();
    const ref = `refs/remotes/origin/${cfg.branch}`;
    const g = (args, opts) => this.git(args, opts);
    const log = new ProgressLog();
    const run = { progress: log };
    const fetched = await this.fetchMain(run, cfg);
    if (!fetched.ok) return { ok: false, error: fetched.error, log: log.all() };

    if (mode === 'pull') {
      const exists = await g(['cat-file', '-e', `${ref}:${p}`]);
      if (this.ok(exists)) {
        const co = await g(['checkout', ref, '--', p]);
        if (!this.ok(co)) return { ok: false, error: `采用远端失败：${clip(co.err || co.code)}`, log: log.all() };
      } else {
        try { fs.rmSync(path.join(this.home, p), { force: true }); } catch { /* ignore */ }
        await g(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', p]);
      }
      await g(['add', '-A', '--', p]);
      const st = await g(['status', '--porcelain', '--', p]);
      if (this.ok(st) && st.out.trim()) {
        await g(['commit', '-m', `${cfg.commitMessage}: 强制采用远端版本 ${p} (${nowStamp()})`, '--', p], { timeoutMs: 300000 });
      }
      log.done('force', `${p}：已用远端版本覆盖本机。`);
      return { ok: true, mode, path: p, clearedPending: cleared, log: log.all() };
    }

    // 强制交付前先把这一份的本机改动提交进本端历史 —— 否则它不会出现在
    // 「本机相对 base 的改动」里，交付树也就无从叠加。
    await g(['add', '-A', '--', p]);
    const st0 = await g(['status', '--porcelain', '--', p]);
    if (this.ok(st0) && st0.out.trim()) {
      await g(['commit', '-m', `${cfg.commitMessage}: 强制交付前的本机快照 ${p} (${nowStamp()})`, '--', p], { timeoutMs: 300000 });
    }

    const store = this.newPendingStore(run);
    const forceOurs = new Map([[p, 'ours']]);
    const build = await this.pushDelivery(run, cfg, store, {
      repo: 'main', g, ref, branch: cfg.branch, kindLabel: '主数据', label: '主数据',
      forceOurs,
      ignore: (x) => this.pathIsMuted(x, 'main') && !forceOurs.has(x),
    });
    if (!build.ok) return { ok: false, error: build.error || '交付失败', log: log.all() };
    await this.recordHeldUnits(run, store, build, { repo: 'main', g, label: '主数据' });
    if (!build.delivered?.length) return { ok: false, error: '无可交付内容（本机可能与远端一致）。', log: log.all() };
    log.done('force', `${p}：已用本机版本覆盖远端。`);
    return { ok: true, mode, path: p, delivered: build.delivered, clearedPending: cleared, log: log.all() };
  }

  /**
   * 重新对齐：把本机拉到与远端一致。
   * 只做纯快进 —— 永远安全，不产生合并提交，也不会丢东西。
   */
  async alignToRemote() {
    const cfg = this.loadConfig();
    const g = (args, opts) => this.git(args, opts);
    const ref = `refs/remotes/origin/${cfg.branch}`;
    const p = new ProgressLog();
    const fakeRun = { progress: p };
    const fetched = await this.fetchMain(fakeRun, cfg);
    if (!fetched.ok) return { ok: false, error: fetched.error, log: p.all() };
    const local = await g(['rev-parse', '--verify', 'HEAD']);
    const remote = await g(['rev-parse', '--verify', ref]);
    if (!this.ok(remote)) return { ok: false, error: '远端还没有可对齐的分支。', log: p.all() };
    if (!this.ok(local)) return { ok: false, error: '本机还没有任何提交。', log: p.all() };
    if (local.out.trim() === remote.out.trim()) return { ok: true, upToDate: true, log: p.all() };

    const remoteInLocal = await g(['merge-base', '--is-ancestor', remote.out.trim(), local.out.trim()]);
    if (this.ok(remoteInLocal)) {
      const counts = await g(['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
      const [behind, ahead] = this.ok(counts) ? counts.out.trim().split(/\s+/).map(Number) : [0, 0];
      return { ok: true, upToDate: true, ahead: ahead || 0, behind: behind || 0, log: p.all() };
    }
    const clean = await g(['status', '--porcelain']);
    if (this.ok(clean) && clean.out.trim()) {
      await this.snapshotLocalState(fakeRun, cfg, { repo: 'main', cwd: this.home, kindLabel: '主数据' });
    }
    const ff = await g(['merge', '--ff-only', ref], { timeoutMs: 900000 });
    if (!this.ok(ff)) return { ok: false, error: `纯快进失败（本机有远端没有的提交）：${clip(ff.err || ff.code)}`, log: p.all() };
    return { ok: true, aligned: true, log: p.all() };
  }

  /* ================= 状态 ================= */

  async status() {
    const cfg = this.loadConfig();
    const out = {
      home: this.home,
      configPath: this.configPath(),
      remote: cfg.remote || '',
      branch: cfg.branch,
      proxy: cfg.proxy || '',
      autoRepo: cfg.autoRepo !== false,
      repoName: cfg.repoName,
      workspaceBase: cfg.workspaceBase || '',
      showSidebarButton: cfg.showSidebarButton !== false,
      gitMissing: this.gitMissing,
      ghAvailable: await this.ghAvailable(),
      running: this.busy,
      lastRun: this.lastRun ? this.lastRun.summary() : null,
      current: this.currentRun && this.currentRun.running ? this.currentRun.summary() : null,
      pending: this.listPending().map((p) => ({ id: p.id, createdAt: p.createdAt, count: p.conflicts.length, conflicts: p.conflicts })),
      repo: null,
      sessions: null,
      workspaces: [],
    };
    try {
      const repoExists = fs.existsSync(path.join(this.home, '.git'));
      out.repo = { exists: repoExists, head: null, remoteHead: null, ahead: 0, behind: 0, dirty: 0, initialized: repoExists };
      if (repoExists) {
        const head = await this.git(['rev-parse', '--short', 'HEAD']);
        out.repo.head = this.ok(head) ? head.out.trim() : null;
        const st = await this.git(['status', '--porcelain']);
        out.repo.dirty = this.ok(st) ? st.out.split('\n').filter(Boolean).length : 0;
        const remoteHead = await this.git(['rev-parse', '--short', `refs/remotes/origin/${cfg.branch}`]);
        out.repo.remoteHead = this.ok(remoteHead) ? remoteHead.out.trim() : null;
        if (out.repo.head && out.repo.remoteHead) {
          const counts = await this.git(['rev-list', '--left-right', '--count', `refs/remotes/origin/${cfg.branch}...HEAD`]);
          if (this.ok(counts)) {
            const [behind, ahead] = counts.out.trim().split(/\s+/).map((x) => Number(x) || 0);
            out.repo.behind = behind;
            out.repo.ahead = ahead;
          }
        }
      }
      const local = this.localSessions();
      const owner = this.sessionToWorkspace();
      const shas = await this.localBlobShas(local.map((s) => s.relLog));
      const remoteFiles = out.repo.remoteHead ? (await this.remoteTree(cfg.branch)).files : new Map();
      out.sessions = local.map((s) => {
        const sha = shas.get(s.relLog) || null;
        const remoteSha = remoteFiles.get(s.relLog) || null;
        let state = 'local-only';
        if (remoteSha && sha && remoteSha === sha) state = 'same';
        else if (remoteSha && sha) state = 'differs';
        else if (remoteSha) state = 'remote-only';
        return {
          id: s.id, title: s.title || '', cwd: s.cwd, slug: s.slug,
          workspaceId: s.workspaceId || owner.get(s.id) || null,
          size: s.size, mtime: s.mtime, relLog: s.relLog, state,
        };
      });
      out.localSessionCount = local.length;
      out.remoteSessionCount = [...remoteFiles.keys()].filter((p) => isSessionLogPath(p)).length;
      out.workspaces = this.workspaceRecords().map((w) => {
        const resolved = this.resolveWorkspacePath(w, cfg);
        return {
          id: w.id, title: w.title,
          path: resolved.path,
          recordedPath: w.path,
          pathSource: resolved.source,
          exists: Boolean(resolved.path) && fs.existsSync(resolved.path),
          sessionCount: w.sessionIds.length,
        };
      });
    } catch (e) {
      out.scanError = String(e?.message || e);
    }
    return out;
  }
}

/* ================= 小工具 ================= */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 把记录里的绝对路径换成本机主目录下的同名相对路径。
 * /home/alice/work → /home/bob/work；C:\\Users\\alice\\work → 本机主目录\\work。
 * 认不出来就返回 null（调用方回退到原路径）。
 */
function remapHomePrefix(recorded) {
  const home = os.homedir();
  const posix = String(recorded).replace(/\\/g, '/');
  let m = /^(\/(?:home|Users)\/[^/]+)(\/.*)?$/.exec(posix);
  if (m) return home + (m[2] || '');
  if (/^\/root(\/.*)?$/.test(posix)) return home + (posix.slice(5) || '');
  m = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+([\\/].*)?$/i.exec(String(recorded));
  if (m) return home + (m[1] || '');
  return null;
}

/** 把 git 的 fetch/push 报错翻成一句能指导操作的话 */
function authOrFetchError(r) {
  const err = String(r?.err || '');
  if (/could not read Username|terminal prompts disabled|Authentication failed|not logged in|failed to execute prompt/i.test(err)) {
    return 'GitHub 认证失败，请执行 gh auth login 并让 git 使用 gh 凭据助手。';
  }
  if (/Could not resolve host|unable to access|Connection (timed out|refused)|Failed to connect/i.test(err)) {
    return `无法连接远端：${clip(err)}；如 GitHub 访问不稳定，可在「连接设置」中配置 Git 代理。`;
  }
  return `读取远端失败：${clip(err || r?.code)}`;
}

/**
 * 规格表 A 的判定：只看三个版本「存不存在」与「是否相等」。
 * b/l/r 为 { sha, mode } 或 null。
 */
export function classifyState(b, l, r) {
  const same = (x, y) => Boolean(x && y && x.sha === y.sha) || (!x && !y);
  if (same(l, r)) return 'A1';                       // 已同步
  if (!b && l && !r) return 'A6';                    // 本端新增
  if (!b && !l && r) return 'A7';                    // 远端新增
  if (!b && l && r) return 'A8';                     // 双方独立新增同一 id
  if (b && !l && r) return same(r, b) ? 'A9' : 'A12'; // 本端删除（远端未改 / 远端也改了）
  if (b && l && !r) return same(l, b) ? 'A11' : 'A13';// 远端删除（本端未改 / 本端也改了）
  if (b && !l && !r) return 'A10';                   // 双方都删除
  if (same(l, b)) return 'A3';                       // 仅远端改
  if (same(r, b)) return 'A2';                       // 仅本端改
  return 'A4';                                       // 两边都改 —— 是否可拼接交给内容层判断
}

/** 单元类型：会话日志 / 派生缓存 / 文本 / 二进制 */
export function unitKindOf(rel) {
  if (isSessionLogPath(rel)) return 'session-log';
  if (isRegenerableCache(rel)) return 'cache';
  const p = normRel(rel);
  if (/(^|\/)(node_modules|workspace-repos)\//.test(p)) return 'binary';
  return 'text';
}

function looksBinary(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function holdReasonText(reason) {
  switch (reason) {
    case 'divergent-session-history': return '会话双方均有新增内容，序列号冲突，无法安全拼接';
    case 'header-mismatch': return '会话表头不一致';
    case 'unreadable': return '会话日志无法解析';
    case 'corrupt-session-log': return '会话日志已损坏（seq 不连续或重复），不会上传，以免把损坏同步到别的机器';
    case 'text-overlap': return '文件双方修改同一位置';
    case 'binary-both-changed': return '二进制文件双方均已修改';
    case 'no-common-base': return '无共同历史，无法判定改动来源';
    case 'remote-deleted': return '远端已删除、本机未修改；删除不会自动生效';
    case 'delete-local': return '本机已删除、远端未修改；删除不会自动传播';
    case 'delete-modify': return '本机已删除、远端已修改';
    case 'modify-delete': return '远端已删除、本机已修改';
    default: return reason;
  }
}

/** 表 A 的状态 → 给人看的说法 */
export const STATE_LABEL = {
  A1: '已同步',
  A2: '仅本机已修改',
  A3: '仅远端已修改',
  A4: '双方已修改·可自动合并',
  A5: '双方已修改·待裁决',
  A6: '本机新增',
  A7: '远端新增',
  A8: '双方各自新增',
  A9: '本机已删除',
  A10: '双方均已删除',
  A11: '远端已删除',
  A12: '本机已删除·远端已修改',
  A13: '远端已删除·本机已修改',
  IGNORED: '已忽略',
};

export function isRegenerableCache(rel) {
  const p = normRel(rel);
  return p.startsWith('storages/session_projcache/');
}

export function isSessionLogPath(rel) {
  return SESSION_LOG_RE.test(String(rel || '').split('/').pop() || '') && /^sessions\//.test(normRel(rel));
}

/** storages/session_projcache/sessions/<id>.json → <id>（会话投影缓存跟着会话走） */
export function sessionCacheIdOf(rel) {
  const m = /^storages\/session_projcache\/sessions\/(.+)\.json$/i.exec(normRel(rel));
  return m ? m[1] : null;
}

export function sessionIdOfPath(rel) {
  const m = /^sessions\/[^/]+\/([^/]+)\//.exec(normRel(rel));
  return m ? m[1] : null;
}

export function shortId(id) {
  const s = String(id || '');
  const m = /([0-9a-f]{8})-[0-9a-f]{4}/i.exec(s);
  return m ? m[1] : s.slice(0, 12);
}

function describeScope(opts, scope) {
  if (opts.scope === 'all') return '全部会话';
  const n = scope?.sessionIds?.length ?? (opts.sessionIds || []).length;
  return `${n} 个会话`;
}

function logTransfer(log, prefix, chunk) {
  const text = String(chunk || '');
  for (const line of text.split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t) continue;
    if (!/^(remote:|Receiving objects|Resolving deltas|Writing objects|Compressing objects|Enumerating objects|Counting objects|Total |POST |Pushing|From |To )/i.test(t)) continue;
    // 进度条每 1% 就写一行会把过程日志淹掉；只留完成态与汇总行。
    const pct = /(\d+)%/.exec(t);
    if (pct && Number(pct[1]) < 100) continue;
    if (/\bdone\.?$/i.test(t) && pct && Number(pct[1]) < 100) continue;
    if (log.last()?.text === `${prefix}: ${t}`) continue;
    log.info(prefix, t);
  }
}

export function summarize(r) {
  if (!r) return '无结果';
  if (r.error) return `未完成：${r.error}`;
  const parts = [];
  if (r.direction === 'push') {
    if (r.commits?.length) parts.push(`提交 ${r.commits.length} 项快照`);
    if (r.pushed?.length) parts.push('已推送至远端');
    else if (!r.commits?.length) parts.push('无需上传的改动');
    const ws = (r.workspaces || []).filter((w) => w.pushed);
    if (ws.length) parts.push(`已推送 ${ws.length} 个工作区`);
  } else {
    if (r.applied?.length) parts.push(`写入 ${r.applied.length} 个文件`);
    if (r.merged?.length) parts.push(`自动合并 ${r.merged.length} 个文件`);
  }
  if (r.conflicts?.length) parts.push(`${r.conflicts.length} 项冲突待裁决`);
  const wserr = (r.workspaces || []).filter((w) => w.error);
  if (wserr.length) {
    parts.push(`${wserr.length} 个工作区失败：`
      + wserr.slice(0, 2).map((w) => `${w.title}（${firstLine(String(w.error))}）`).join('；')
      + (wserr.length > 2 ? `；…还有 ${wserr.length - 2} 个` : ''));
  }
  if (!parts.length) parts.push('已是最新');
  return parts.join('；');
}

export { humanSize };
