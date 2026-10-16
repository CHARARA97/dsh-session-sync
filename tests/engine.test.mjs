/**
 * 端到端冒烟测试：在临时目录里造两台「机器」和一个裸仓库当远端，
 * 验证 push / pull / 单会话范围 / 会话分叉冲突 / 冲突裁决 / 工作区同步 这些真实路径。
 *
 * 运行：node tests/engine.test.mjs
 * 它只碰自己创建的临时目录，不会读写真实的 ~/.dsh，也不会改 ~/.gitconfig。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncEngine } from '../lib/engine.js';
import { ProgressLog } from '../lib/progress.js';
import { sessionSlugFromCwd, inspectSessionLog } from '../lib/session.js';
import { zstdEncode, zstdDecode, run } from '../lib/util.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-test-'));
const remoteDir = path.join(root, 'remote.git');
const results = [];

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(['ok', name]); process.stdout.write(`  ✓ ${name}\n`); })
    .catch((err) => { results.push(['fail', name, err]); process.stdout.write(`  ✗ ${name}\n    ${err?.message || err}\n`); });
}

function userMsg(text, seq, time) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], role: 'user', id: randomUUID() }, surfaceOp: 'append' };
}
function assistantMsg(text, seq, time) {
  return { type: 'assistant/message', seq, time, data: { turn: 1, step: seq, message: { role: 'assistant', content: [{ type: 'text', text }] } }, surfaceOp: 'append' };
}

function sessionBuffer(id, cwd, events = []) {
  const header = { type: 'session', version: 4, id, createdAt: 1791000000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  return zstdEncode([header, ...events].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** 全新机器：只有一个空的 DSH HOME */
function makeEmptyHome(name) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** 已经有本地数据的机器 */
function makeHome(name, { sessions = [], workspaces = [] } = {}) {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  for (const s of sessions) {
    const dir = path.join(home, 'sessions', sessionSlugFromCwd(s.cwd), s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), sessionBuffer(s.id, s.cwd, s.events || []));
    fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', s.id + '.json'),
      JSON.stringify({ version: 7, record: { identity: { cwd: s.cwd }, rows: { title: { ver: 1, seq: 1, val: s.title || s.id } } } }));
  }
  const tables = {};
  for (const w of workspaces) {
    tables[w.id] = { path: w.path, title: w.title, sessionIds: w.sessionIds || [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  }
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: workspaces.map((w) => w.id), archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: tables },
  }, null, 2));
  return home;
}

function findSessionFile(home, id) {
  const root2 = path.join(home, 'sessions');
  if (!fs.existsSync(root2)) return null;
  for (const slug of fs.readdirSync(root2)) {
    const p = path.join(root2, slug, id, 'session.v4.jsonl.zstd');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function appendToSession(home, id, events) {
  const file = findSessionFile(home, id);
  assert.ok(file, `找不到会话文件 ${id}`);
  const rows = zstdDecode(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
  const next = rows.length - 1;
  fs.writeFileSync(file, zstdEncode(rows.concat(events.map((ev, i) => JSON.stringify({ ...ev, seq: next + i }))).join('\n') + '\n'));
}

function readSessionRows(home, id) {
  const p = findSessionFile(home, id);
  if (!p) return null;
  return zstdDecode(fs.readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function textsOf(rows) {
  return rows.map((x) => x.data?.content?.[0]?.text).filter(Boolean);
}

const silent = () => {};
const S1 = 'session-1111aaaa-0000-4000-8000-000000000001';
const S2 = 'session-2222bbbb-0000-4000-8000-000000000002';
const WS_A = 'ws-aaaa-1111-2222-333333333333';
const CWD_A = '/home/alice/project';
const PROJ_A = path.join(root, 'machine-a', 'proj');
const PROJ_B = path.join(root, 'machine-b', 'proj');

async function main() {
  process.stdout.write(`临时目录：${root}\n`);

  fs.mkdirSync(remoteDir, { recursive: true });
  assert.equal((await run('git', ['init', '--bare', '-b', 'main', remoteDir])).code, 0);
  // `file://` 传输需要显式允许；只影响本测试进程，不碰用户真实的 ~/.gitconfig。
  const fakeGlobal = path.join(root, 'gitconfig');
  fs.writeFileSync(fakeGlobal, '[protocol "file"]\n\tallow = always\n');
  process.env.GIT_CONFIG_GLOBAL = fakeGlobal;

  const REMOTE = 'file://' + remoteDir;
  const cfgOverride = { remote: REMOTE, branch: 'main', gitUserName: 'test', gitUserEmail: 'test@localhost', autoRepo: false };

  const homeA = makeHome('home-a', {
    sessions: [
      { id: S1, cwd: CWD_A, title: '会话一', events: [userMsg('你好', 0, 1791000001000), assistantMsg('你好呀', 1, 1791000002000)] },
      { id: S2, cwd: CWD_A, title: '会话二', events: [userMsg('第二个会话', 0, 1791000003000)] },
    ],
    workspaces: [{ id: WS_A, path: PROJ_A, title: 'proj', sessionIds: [S1] }],
  });
  fs.mkdirSync(path.join(PROJ_A, 'src'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_A, 'README.md'), 'hello from A\n');
  fs.writeFileSync(path.join(PROJ_A, 'src', 'index.js'), 'console.log(1)\n');
  fs.mkdirSync(path.join(PROJ_A, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_A, 'node_modules', 'x', 'index.js'), 'should not sync\n');

  const engineA = new SyncEngine(homeA, cfgOverride, silent);

  await step('A：push 全部会话（含工作区）', async () => {
    const r = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: true, reason: 'test' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    assert.ok(r.result.pushed.length >= 1, '主数据已推送');
    assert.equal(r.result.conflicts.length, 0, '没有冲突');
  });

  await step('远端确实收到了主分支与工作区分支', async () => {
    const b = await run('git', ['--git-dir', remoteDir, 'branch', '--list', '--format=%(refname:short)']);
    assert.ok(b.out.includes('main'), 'main 分支存在');
    assert.ok(b.out.includes(`ws/${WS_A}`), 'ws 分支存在');
  });

  await step('A：远端已被推上去的提交里不含 node_modules', async () => {
    const ls = await run('git', ['--git-dir', remoteDir, 'ls-tree', '-r', '--name-only', `ws/${WS_A}`]);
    assert.ok(!ls.out.includes('node_modules'), 'node_modules 未上传');
    assert.ok(ls.out.includes('README.md'), 'README.md 已上传');
  });

  /* ============ 第二台机器：全新 HOME ============ */
  const homeB = makeEmptyHome('home-b');
  const engineB = new SyncEngine(homeB, { ...cfgOverride, workspaceBase: path.join(root, 'machine-b', 'ws') }, silent);

  await step('B（全新机器）：pull 全部会话并取回工作区文件', async () => {
    const r = await engineB.execute({ direction: 'pull', scope: 'all', includeWorkspace: true, reason: 'test' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    const rows = readSessionRows(homeB, S1);
    assert.ok(rows && rows.length === 3, '会话一取回（表头 + 2 事件）');
    const target = path.join(root, 'machine-b', 'ws', 'proj');
    assert.ok(fs.existsSync(path.join(target, 'README.md')), '工作区文件取回');
    assert.ok(fs.existsSync(path.join(target, 'src', 'index.js')), '子目录文件取回');
    assert.ok(!fs.existsSync(path.join(target, 'node_modules')), 'node_modules 未取回');
  });

  await step('B：全新机器上第一次取回没有产生任何假冲突', async () => {
    const st = await engineB.status();
    assert.equal(st.pending.length, 0, '没有待裁决记录');
  });

  await step('会话归属：取回的会话被登记在对应工作区', async () => {
    const owner = engineB.sessionToWorkspace();
    assert.equal(owner.get(S1), WS_A, '会话一属于工作区 A');
  });

  await step('B：单会话 push 只提交该会话', async () => {
    appendToSession(homeB, S2, [assistantMsg('B 追加的内容', 1, 1791000010000)]);
    const r = await engineB.execute({ direction: 'push', scope: 'session', sessionIds: [S2], includeWorkspace: false, reason: 'test' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    assert.equal(r.result.commits.length, 1, '只产生一个提交');
  });

  await step('A：pull 单会话取回 B 的追加内容', async () => {
    const before = readSessionRows(homeA, S2).length;
    const r = await engineA.execute({ direction: 'pull', scope: 'session', sessionIds: [S2], includeWorkspace: false, reason: 'test' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    assert.equal(readSessionRows(homeA, S2).length, before + 1, '纯追加的事件被自动合并进来');
  });

  await step('分叉：两边各自改了同一个会话 → pull 停下报告冲突且不动本机文件', async () => {
    appendToSession(homeA, S1, [userMsg('A 的分支内容', 2, 1791000020000)]);
    const pushA = await engineA.execute({ direction: 'push', scope: 'session', sessionIds: [S1], includeWorkspace: false, reason: 'test' });
    assert.equal(pushA.ok, true, JSON.stringify(pushA.result?.error || pushA.error));
    appendToSession(homeB, S1, [userMsg('B 的分支内容', 2, 1791000021000)]);
    const beforeB = fs.readFileSync(findSessionFile(homeB, S1));
    const pullB = await engineB.execute({ direction: 'pull', scope: 'session', sessionIds: [S1], includeWorkspace: false, reason: 'test' });
    assert.equal(pullB.ok, false, '应当报告未完成');
    assert.equal(pullB.result.conflicts.length, 1, '恰好一项冲突');
    assert.equal(pullB.result.conflicts[0].kind, 'session-log');
    // 会话投影缓存是可再生的派生数据，不该升级成需要用户裁决的冲突
    assert.ok(!pullB.result.conflicts.some((c) => c.path.includes('session_projcache')), '可再生缓存不进冲突清单');
    assert.ok(beforeB.equals(fs.readFileSync(findSessionFile(homeB, S1))), '冲突时本机会话文件一个字节都不能变');
    globalThis.__pendingB = pullB.result.pendingId;
  });

  await step('裁决「两边都留」：远端版本导入成新会话并登记进工作区', async () => {
    const pendingId = globalThis.__pendingB;
    assert.ok(pendingId, '有待裁决记录');
    const pending = engineB.listPending().find((p) => p.id === pendingId);
    assert.equal(pending.conflicts.length, 1);
    const c = pending.conflicts[0];
    const r = await engineB.resolveConflicts({ pendingId, decisions: [{ id: c.id, choice: 'both' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const newId = r.detail.both[0].newSessionId;
    assert.ok(newId && newId !== c.sessionId, '生成了新会话 id');
    const rows = readSessionRows(homeB, newId);
    assert.ok(rows && rows[0].id === newId, '新会话表头 id 已改写');
    assert.ok(textsOf(rows).includes('A 的分支内容'), '新会话里是远端那一支的内容');
    assert.ok(textsOf(readSessionRows(homeB, c.sessionId)).includes('B 的分支内容'), '本机原会话保留自己的版本');
    const ws = JSON.parse(fs.readFileSync(path.join(homeB, 'storages', 'workspace.json'), 'utf8'));
    assert.ok(Object.values(ws.tables.workspaces).some((w) => w.sessionIds.includes(newId)), '新会话已登记到工作区');
    assert.equal(engineB.listPending().length, 0, '待裁决记录已清空');
  });

  await step('全量 pull 的分叉：裁决「采用远端」后本机变成远端版本', async () => {
    const decideAll = async (engine, pullResult, pick) => {
      const pending = engine.listPending().find((p) => p.id === pullResult.result.pendingId);
      assert.ok(pending, '有待裁决记录');
      const decisions = pending.conflicts.map((x) => ({ id: x.id, choice: pick(x) }));
      const r = await engine.resolveConflicts({ pendingId: pending.id, decisions });
      assert.equal(r.ok, true, JSON.stringify(r.error));
      return pending;
    };

    // 上一轮对 S1 选了「两边都留」并产生了真正的合并提交 → 这个裁决被记录了下来，
    // 所以这次全量取回不该再为它报一次冲突（旧模型会因为分叉没被收束而反复报）。
    const pull0 = await engineB.execute({ direction: 'pull', scope: 'all', includeWorkspace: false, reason: 'test' });
    assert.equal(pull0.ok, true, `已裁决过的会话不该重复报冲突：${pull0.result?.error || ''}`);
    assert.equal(engineB.listPending().length, 0, '没有待裁决记录');

    // 分支一致后，B 追加 S2 可以正常推送（推的是整条分支，也就带上了 B 对 S1 的裁决）
    appendToSession(homeB, S2, [userMsg('B 第二轮', 3, 1791000030000)]);
    const pushB = await engineB.execute({ direction: 'push', scope: 'session', sessionIds: [S2], includeWorkspace: false, reason: 'test' });
    assert.equal(pushB.ok, true, JSON.stringify(pushB.result?.error || pushB.error));

    // A 取回：远端把 S1 收敛成了 B 那一支，A 本机仍是自己那一支 —— 这是真正的分叉，必须裁决
    const pullA = await engineA.execute({ direction: 'pull', scope: 'all', includeWorkspace: false, reason: 'test' });
    if (!pullA.ok) {
      const pa = engineA.listPending().find((p) => p.id === pullA.result.pendingId);
      assert.ok(pa.conflicts.some((x) => x.sessionId === S1), 'A 侧应看到 S1 分叉');
      // A 那边选「两边都留」：远端（B 的决定）成为当前版本，A 自己那一支导入成新会话
      await decideAll(engineA, pullA, (x) => (x.sessionId === S1 ? 'both' : 'remote'));
    }
    assert.equal(engineA.listPending().length, 0, 'A 的待裁决记录已清空');
    const pullA2 = await engineA.execute({ direction: 'pull', scope: 'all', includeWorkspace: false, reason: 'test' });
    assert.equal(pullA2.ok, true, JSON.stringify(pullA2.result?.error || pullA2.error));
    assert.ok(textsOf(readSessionRows(homeA, S2)).includes('B 第二轮'), 'S2 的纯追加被自动合并');

    // A 再改一轮并推送；B 在没拉到的情况下也改一轮 → 真分叉
    appendToSession(homeA, S2, [userMsg('A 第三轮', 4, 1791000032000)]);
    const pushA = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: false, reason: 'test' });
    assert.equal(pushA.ok, true, JSON.stringify(pushA.result?.error || pushA.error));
    appendToSession(homeB, S2, [userMsg('B 第三轮', 4, 1791000033000)]);

    const pullB = await engineB.execute({ direction: 'pull', scope: 'all', includeWorkspace: false, reason: 'test' });
    assert.equal(pullB.ok, false, '全量 pull 应报告冲突');
    const pending = engineB.listPending().find((p) => p.id === pullB.result.pendingId);
    const c = pending.conflicts.find((x) => x.sessionId === S2);
    assert.ok(c, '分叉会话在冲突清单里');
    const r = await engineB.resolveConflicts({
      pendingId: pending.id,
      decisions: pending.conflicts.map((x) => ({ id: x.id, choice: x.sessionId === S2 ? 'remote' : 'local' })),
    });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(textsOf(readSessionRows(homeB, S2)).includes('A 第三轮'), '本机已是远端版本');
    assert.equal(engineB.listPending().length, 0, '待裁决记录已清空');
  });

  await step('工作区分叉：冲突被记录、本机项目文件不被覆盖，裁决后可两边都留', async () => {
    fs.writeFileSync(path.join(PROJ_A, 'README.md'), 'A 改过的内容\n');
    const pushA = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: true, reason: 'test' });
    assert.equal(pushA.ok, true, JSON.stringify(pushA.result?.error || pushA.error));
    const bReadme = path.join(root, 'machine-b', 'ws', 'proj', 'README.md');
    fs.writeFileSync(bReadme, 'B 改过的内容\n');
    const pullB = await engineB.execute({ direction: 'pull', scope: 'all', includeWorkspace: true, reason: 'test' });
    assert.ok(fs.readFileSync(bReadme, 'utf8').includes('B 改过'), '有冲突时本机项目文件保持原样');
    assert.equal(pullB.ok, false, '工作区冲突应报告');
    const pending = engineB.listPending().find((p) => p.id === pullB.result.pendingId);
    const c = pending.conflicts.find((x) => x.path === 'README.md' && x.repo.startsWith('ws:'));
    assert.ok(c, 'README.md 在冲突清单里');
    const r = await engineB.resolveConflicts({ pendingId: pending.id, decisions: [{ id: c.id, choice: 'both' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const copy = r.detail.both.find((x) => x.newPath && x.newPath.includes('README.md'));
    assert.ok(copy, '远端版本另存成了副本');
    assert.ok(fs.existsSync(path.join(root, 'machine-b', 'ws', 'proj', copy.newPath)), '副本文件确实存在');
    assert.ok(fs.readFileSync(bReadme, 'utf8').includes('B 改过'), '本机版本仍然是当前文件');
  });

  await step('工作区忽略文件：自动创建、规则生效、文件本身不被同步', async () => {
    const ig = path.join(PROJ_A, '.dsh-chat-sync-ignore');
    assert.ok(fs.existsSync(ig), '同步工作区时应当自动创建 .dsh-chat-sync-ignore');
    assert.ok(fs.readFileSync(ig, 'utf8').includes('gitignore'), '新建的模板应当说明写法');

    // 用户自己编辑：排除一个目录、一类文件，并留一个 ! 例外
    fs.writeFileSync(ig, '# 我自己的规则\ndist/\n*.secret\n!keep.secret\n');
    fs.mkdirSync(path.join(PROJ_A, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(PROJ_A, 'dist', 'bundle.js'), 'x\n');
    fs.writeFileSync(path.join(PROJ_A, 'a.secret'), 'x\n');
    fs.writeFileSync(path.join(PROJ_A, 'keep.secret'), 'x\n');

    const r = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: true });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    const ls = await run('git', ['--git-dir', remoteDir, 'ls-tree', '-r', '--name-only', `ws/${WS_A}`]);
    const files = ls.out.split('\n').map((x) => x.trim()).filter(Boolean);
    assert.ok(!files.some((f) => f.startsWith('dist/')), `dist/ 不该被上传，实际：${files.join(',')}`);
    assert.ok(!files.includes('a.secret'), '*.secret 不该被上传');
    assert.ok(files.includes('keep.secret'), '! 例外应当仍然上传');
    assert.ok(!files.includes('.dsh-chat-sync-ignore'), '忽略文件本身不该被同步（它是本机专属设置）');
  });

  await step('嵌套 git 仓库（含两层深与空仓库）不阻塞工作区提交，也不被同步', async () => {
    const mk = async (dir, commit) => {
      fs.mkdirSync(dir, { recursive: true });
      await run('git', ['init', '-q', '-b', 'main', dir]);
      await run('git', ['config', 'user.email', 't@t'], { cwd: dir });
      await run('git', ['config', 'user.name', 't'], { cwd: dir });
      if (commit) {
        fs.writeFileSync(path.join(dir, 'inner.txt'), 'inner\n');
        await run('git', ['add', '-A'], { cwd: dir });
        await run('git', ['commit', '-qm', 'inner'], { cwd: dir });
        // 未跟踪内容正是父仓库提交失败的经典原因
        fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
      }
    };
    await mk(path.join(PROJ_A, 'vendor', 'inner'), true);   // 两层深、有提交
    await mk(path.join(PROJ_A, 'emptyrepo'), false);       // 顶层、空仓库（连 gitlink 都记不上）

    const r = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: true });
    assert.equal(r.ok, true, `嵌套仓库不该让工作区失败：${r.result?.error || ''}`);
    const wsRes = (r.result.workspaces || []).find((w) => w.title === 'proj');
    assert.ok(!wsRes?.error, `工作区不该报错：${wsRes?.error}`);

    const ls = await run('git', ['--git-dir', remoteDir, 'ls-tree', '-r', '--name-only', `ws/${WS_A}`]);
    const files = ls.out.split('\n').map((x) => x.trim()).filter(Boolean);
    assert.ok(!files.some((f) => f.startsWith('vendor/')), `嵌套仓库内容不该被上传：${files.filter((f) => f.startsWith('vendor/')).join(',')}`);
    assert.ok(!files.includes('emptyrepo'), '空嵌套仓库不该被记成 gitlink');
    assert.ok(!files.includes('vendor/inner'), '嵌套仓库不该被记成 gitlink');

    // 不能沉默地排除：必须明确说出「这里有独立仓库、内容没被同步」并给出办法
    const lines = engineA.lastRun.progress.all().map((e) => e.text).join('\n');
    assert.ok(/独立的 git 仓库/.test(lines), `应当报告被排除的独立仓库，实际日志：${lines.slice(-300)}`);
    assert.ok(/作为工作区打开/.test(lines), '应当告诉用户怎么把它们也纳入同步');
    assert.ok(lines.includes('vendor/inner'), '报告里应当列出具体路径');
  });

  await step('路径重映射：记录里别的用户名的主目录会换成本机主目录', () => {
    const r = engineB.resolveWorkspacePath({ id: 'nope', path: '/home/someone-else/reports' }, { workspaceBase: '' });
    assert.equal(r.source, 'remapped');
    assert.equal(r.path, path.join(os.homedir(), 'reports'));
  });

  await step('已有本地数据 + 无共同历史：pull 停下报告冲突，本机文件不动', async () => {
    const homeC = makeHome('home-c', {
      sessions: [{ id: 'session-cccc3333-0000-4000-8000-000000000003', cwd: '/home/carol/x', title: 'C 自己的会话', events: [userMsg('C 本机内容', 0, 1791000040000)] }],
      workspaces: [{ id: 'ws-cccc-3333', path: path.join(root, 'machine-c', 'proj'), title: 'proj-c', sessionIds: [] }],
    });
    const wsFile = path.join(homeC, 'storages', 'workspace.json');
    const before = fs.readFileSync(wsFile);
    const engineC = new SyncEngine(homeC, cfgOverride, silent);
    const r = await engineC.execute({ direction: 'pull', scope: 'all', includeWorkspace: false, reason: 'test' });
    assert.equal(r.ok, false, '无共同历史且两边都登记了工作区，应报告冲突');
    assert.ok(r.result.conflicts.length >= 1, '至少一项冲突');
    assert.ok(before.equals(fs.readFileSync(wsFile)), '本机 workspace.json 在裁决前不能被改动');
    // 全部保留本机 → 合并完成且本机登记表仍是自己那份
    const pending = engineC.listPending().find((p) => p.id === r.result.pendingId);
    const decisions = pending.conflicts.map((c) => ({ id: c.id, choice: 'local' }));
    const rr = await engineC.resolveConflicts({ pendingId: pending.id, decisions });
    assert.equal(rr.ok, true, JSON.stringify(rr.error));
    assert.ok(before.equals(fs.readFileSync(wsFile)), '选择「保留本机」后登记表仍是本机那份');
    // 远端独有的会话文件必须已经进来（不是被丢弃）
    assert.ok(readSessionRows(homeC, S1), '远端独有的会话仍然被取回');
  });

  await step('工作区失败必须算失败、说清原因、且不能用成功色显示', async () => {
    // 把工作区路径指到一个「文件」上 → mkdir 必然失败，稳定复现工作区失败
    const badFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(badFile, 'x\n');
    engineA.setWorkspacePathOverride(WS_A, badFile);
    try {
      const r = await engineA.execute({ direction: 'push', scope: 'all', includeWorkspace: true });
      assert.equal(r.ok, false, `有工作区失败时整次操作必须算失败；实际 r.error=${r.error}`);
      assert.ok(r.result, `execute 不该抛异常；实际 r.error=${r.error}`);
      assert.ok(String(r.result.error).includes('工作区'), `result.error 应当说明是工作区的问题，实际：${r.result.error}`);
      assert.ok((r.result.workspaces || []).some((w) => w.error), '工作区结果里应当带错误');
      const end = engineA.lastRun.progress.all().filter((e) => e.stage === 'end');
      assert.ok(end.length > 0, '应当有一条结束行');
      assert.ok(end.some((e) => e.level !== 'done'), `有失败时结束行不能是成功色，实际：${JSON.stringify(end)}`);
      assert.ok(end.some((e) => /工作区.*失败/.test(e.text)), `摘要应当写明工作区失败，实际：${end.map((e) => e.text).join(' | ')}`);
      assert.ok(end.some((e) => e.text.includes('mkdir') || e.text.includes('失败')), '摘要应当带上失败原因');
      assert.ok(end.some((e) => e.text.includes('proj')), '摘要应当带上失败的工作区名字');
    } finally {
      engineA.setWorkspacePathOverride(WS_A, null);
    }
  });

  await step('会话日志只增不减：绝不用旧版本整文件覆盖（seq 断点的成因）', async () => {
    const mk = (id, n, cwd) => Buffer.from(
      [JSON.stringify({ type: 'session', version: 4, id, cwd })]
        .concat(Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user/message', seq: i, time: i, data: { content: [] } })))
        .join('\n') + '\n', 'utf8');
    const rel = 'sessions/x/session-deadbeef-0000-4000-8000-000000000001/session.v4.jsonl';
    const abs = path.join(homeA, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    // 磁盘上是 10 行（DSH 刚追加过），要写的是 5 行（判定时读到的旧内容）→ 必须不写
    fs.writeFileSync(abs, mk('session-deadbeef-0000-4000-8000-000000000001', 10, '/home/alice/x'));
    let r = engineA.sessionLogSafeBuf(rel, mk('session-deadbeef-0000-4000-8000-000000000001', 5, '/home/alice/x'));
    assert.equal(r.mode, 'keep-disk', '要写旧版本时必须拒绝写入');
    assert.equal(r.buf.toString('utf8').split('\n').filter(Boolean).length, 11, '应当保留磁盘上更长的那一份');

    // 反向：要写的包含磁盘内容 → 正常写
    r = engineA.sessionLogSafeBuf(rel, mk('session-deadbeef-0000-4000-8000-000000000001', 20, '/home/alice/x'));
    assert.equal(r.mode, 'write');

    // 完全相同 → 不写
    r = engineA.sessionLogSafeBuf(rel, mk('session-deadbeef-0000-4000-8000-000000000001', 10, '/home/alice/x'));
    assert.equal(r.mode, 'same');

    // 分叉（两边各自往后写）→ 保留磁盘内容，交裁决，绝不硬拼
    const divergent = Buffer.from(
      [JSON.stringify({ type: 'session', version: 4, id: 'session-deadbeef-0000-4000-8000-000000000001', cwd: '/home/alice/x' })]
        .concat(Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: 'user/message', seq: i, time: i, data: { content: [] } })))
        .concat([JSON.stringify({ type: 'user/message', seq: 100, time: 100, data: { content: [] } })])
        .join('\n') + '\n', 'utf8');
    r = engineA.sessionLogSafeBuf(rel, divergent);
    assert.equal(r.mode, 'conflict', '无法拼接时必须保留磁盘内容');
    assert.equal(r.buf.toString('utf8').split('\n').filter(Boolean).length, 11, '冲突时应当保住磁盘上的那一份');
  });

  await step('会话日志格式校验：seq 断点 / 回退 / 无法解析都判为不合法', () => {
    const hdr = { type: 'session', version: 4, id: 'session-x', cwd: '/home/alice/x' };
    const row = (q) => JSON.stringify({ type: 'user/message', seq: q, time: q, data: { content: [] } });
    const buf = (q) => Buffer.from([JSON.stringify(hdr), ...q.map(row)].join('\n') + '\n', 'utf8');

    const ok = inspectSessionLog(buf([0, 1, 2, 3]));
    assert.equal(ok.ok, true, `合法的日志应当通过：${JSON.stringify(ok.problems)}`);
    assert.equal(ok.rowCount, 5);

    const gap = inspectSessionLog(buf([0, 1, 2, 5]));
    assert.equal(gap.ok, false, 'seq 跳号必须判为不合法');
    assert.equal(gap.problems[0].reason, 'gap');
    assert.equal(gap.problems[0].expected, 3);
    assert.equal(gap.problems[0].got, 5);

    // 真实事故的形状：0..2791 后面又接了 1789
    const rewind = inspectSessionLog(buf([0, 1, 2, 3, 1, 2]));
    assert.equal(rewind.ok, false, 'seq 回退必须判为不合法');
    assert.equal(rewind.problems[0].reason, 'rewind');

    assert.equal(inspectSessionLog(Buffer.from('not json\n')).ok, false, '解析不了也必须判为不合法');
    assert.equal(inspectSessionLog(Buffer.from('')).ok, false);
  });

  await step('损坏的会话日志被识别出来 —— 交付侧据此拒绝上传（不让损坏扩散）', async () => {
    const g = (args, o) => engineA.git(args, o);
    const hdr = { type: 'session', version: 4, id: 'session-deadbeef-0000-4000-8000-000000000002', cwd: '/home/alice/x' };
    const row = (q) => JSON.stringify({ type: 'user/message', seq: q, time: q, data: { content: [] } });
    const blob = async (text) => {
      const r = await engineA.git(['hash-object', '-w', '--stdin'], { stdin: Buffer.from(text, 'utf8') });
      assert.equal(r.code, 0, r.err);
      return r.out.trim();
    };
    const good = await blob([JSON.stringify(hdr), row(0), row(1), row(2)].join('\n') + '\n');
    const bad = await blob([JSON.stringify(hdr), row(0), row(1), row(2), row(1)].join('\n') + '\n');

    assert.equal(await engineA.corruptSessionLogOf(g, good), null, '合法日志不该被判定为损坏');
    const why = await engineA.corruptSessionLogOf(g, bad);
    assert.ok(why, 'seq 回退的日志必须被判定为损坏');
    assert.ok(why.includes('rewind'), `原因里应当说明是 seq 回退，实际：${why}`);

    // mergeUnitContent 也必须拒绝：任何一侧坏了都不拼
    const unit = {
      path: 'sessions/x/session-deadbeef-0000-4000-8000-000000000002/session.v4.jsonl.zstd',
      kind: 'session-log',
      ours: { sha: bad, mode: '100644' },
      theirs: { sha: good, mode: '100644' },
    };
    const m = await engineA.mergeUnitContent(g, unit, 'session-log');
    assert.equal(m.ok, false, '本机侧损坏时不得合并');
    assert.equal(m.reason, 'corrupt-session-log');
    unit.ours = { sha: good, mode: '100644' };
    unit.theirs = { sha: bad, mode: '100644' };
    const m2 = await engineA.mergeUnitContent(g, unit, 'session-log');
    assert.equal(m2.ok, false, '远端侧损坏时不得合并');
    assert.equal(m2.reason, 'corrupt-session-log');
  });

  await step('中断恢复：仓库停在合并中时先恢复，且不丢中断期间追加的内容', async () => {
    // 造出一个「合并进行到一半」的仓库状态：MERGE_HEAD + ORIG_HEAD
    const gitdir = path.join(homeA, '.git');
    const head = (await run('git', ['-C', homeA, 'rev-parse', 'HEAD'])).out.trim();
    fs.writeFileSync(path.join(gitdir, 'MERGE_HEAD'), head + '\n');
    fs.writeFileSync(path.join(gitdir, 'ORIG_HEAD'), head + '\n');
    assert.ok(fs.existsSync(path.join(gitdir, 'MERGE_HEAD')), '前置条件：MERGE_HEAD 存在');

    // 中断期间 DSH 又往一个会话日志里追加了内容
    const slug = sessionSlugFromCwd('/home/alice/project');
    const log = path.join(homeA, 'sessions', slug, S1, 'session.v4.jsonl.zstd');
    const before = fs.readFileSync(log);
    const decoded = zstdDecode(before).toString('utf8').split('\n').filter(Boolean);
    const extra = JSON.stringify({ type: 'user/message', seq: 900, time: 900, data: { content: [] } });
    fs.writeFileSync(log, zstdEncode([...decoded, extra].join('\n') + '\n'));
    const grew = fs.readFileSync(log);
    assert.notEqual(grew.length, before.length, '前置条件：日志被追加过');

    const run2 = new SyncEngine(homeA, {}, () => {});
    const r = await run2.execute({ direction: 'push', scope: 'all' });
    void r;
    assert.ok(!fs.existsSync(path.join(gitdir, 'MERGE_HEAD')), '恢复后 MERGE_HEAD 必须消失');
    const after = fs.readFileSync(log);
    const afterText = zstdDecode(after)?.toString('utf8') || '';
    assert.ok(afterText.includes('"seq":900'), `中断期间追加的内容必须保留，实际末尾：${afterText.slice(-160)}`);
  });

  await step('修复：截断到最后一个合法前缀（先备份、可复核、不触碰 seq 编号）', async () => {
    const id = 'session-repair00-0000-4000-8000-000000000009';
    const rel = `sessions/xx/${id}/session.v4.jsonl.zstd`;
    const abs = path.join(homeA, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const hdr = { type: 'session', version: 4, id, cwd: '/home/alice/x' };
    const row = (q) => JSON.stringify({ type: 'user/message', seq: q, time: 1000 + q, data: { content: [] } });
    // 合法前缀 seq 0..4，然后回退到 2 —— 和真实事故同形（0..2791 后面接 1789）
    fs.writeFileSync(abs, zstdEncode([JSON.stringify(hdr), row(0), row(1), row(2), row(3), row(4), row(2), row(3)].join('\n') + '\n'));
    const original = fs.readFileSync(abs);

    // 预览只看不改
    const pv = await engineA.previewSessionRepair(rel);
    assert.equal(pv.ok, true, JSON.stringify(pv.error));
    assert.equal(pv.totalRows, 8, '表头 + 7 行');
    assert.equal(pv.keepRows, 6, '应当保留表头 + seq 0..4');
    assert.equal(pv.dropRows, 2);
    assert.equal(pv.firstProblem.reason, 'rewind');
    assert.equal(pv.firstProblem.line, 7);
    assert.equal(pv.firstProblem.expected, 5);
    assert.equal(pv.firstProblem.got, 2);
    assert.equal(fs.readFileSync(abs).equals(original), true, '预览绝不能改动文件');

    // 执行修复
    const r = await engineA.repairSessionLog(rel);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.keptRows, 6);
    assert.equal(r.droppedRows, 2);
    const after = inspectSessionLog(fs.readFileSync(abs));
    assert.equal(after.ok, true, `修复后必须通过校验：${JSON.stringify(after.problems)}`);
    assert.equal(after.rowCount, 6);
    // 保留的每一行 seq 都必须是原来的值 —— 修复不许重编号
    assert.deepEqual(after.decoded.parsed.slice(1).map((x) => x.seq), [0, 1, 2, 3, 4], 'seq 必须原样保留，不得重新编号');

    // 原件逐字节留在备份里
    assert.ok(fs.existsSync(r.backup), '备份文件应当存在');
    assert.equal(fs.readFileSync(r.backup).equals(original), true, '备份必须与原文件逐字节一致');
    assert.ok(r.backup.includes('.chat-sync'), '备份应当放在本机专属目录里（不参与同步）');

    // 已经合法 → 不再当作需要修复
    const pv2 = await engineA.previewSessionRepair(rel);
    assert.equal(pv2.alreadyValid, true);
    const r2 = await engineA.repairSessionLog(rel);
    assert.equal(r2.alreadyValid, true);

    // 非会话路径 / 不存在的文件：明确报错，不瞎改
    assert.equal((await engineA.previewSessionRepair('storages/workspace.json')).ok, false);
    assert.equal((await engineA.previewSessionRepair('sessions/xx/nope/session.v4.jsonl.zstd')).ok, false);
  });

  await step('删除类裁决不再掉进「两边都留」（曾经抛 path null 并报错两次）', async () => {
    // 复盘真实事故：一条 delete-local 的**工作区**冲突，没有 side 字段、没有留存远端副本。
    // 旧代码里它既不走 local 也不走 remote，于是掉进「两边都留」的 else，
    // 去 path.join(pending.dir, null) —— 直接抛 TypeError，报文里出现两次。
    const store = engineA.newPendingStore({ progress: new ProgressLog() });
    await engineA.recordConflict(store, {
      repo: `ws:${WS_A}`, relPath: 'vendor/inner', kind: 'file', reason: 'delete-local',
    });
    const saved = engineA.savePending(store);
    const cid = store.conflicts[0].id;
    assert.equal(store.conflicts[0].side, 'pull', '记录时应当带上 side 默认值');

    const r = await engineA.resolveConflicts({ pendingId: saved.id, decisions: [{ id: cid, choice: 'delete' }] });
    const msg = String(r.error || '');
    assert.ok(!/must be of type string/.test(msg), `不该再抛 path 类型错误：${msg}`);
    assert.ok(!/Received null/.test(msg), `不该再出现 null 路径：${msg}`);

    // 「两边都留」在缺少远端副本时也必须明确报错，而不是抛异常
    const store2 = engineA.newPendingStore({ progress: new ProgressLog() });
    await engineA.recordConflict(store2, {
      repo: `ws:${WS_A}`, relPath: 'vendor/other', kind: 'file', reason: 'text-overlap', side: 'pull',
    });
    const saved2 = engineA.savePending(store2);
    const r2 = await engineA.resolveConflicts({ pendingId: saved2.id, decisions: [{ id: store2.conflicts[0].id, choice: 'both' }] });
    const msg2 = String(r2.error || '');
    assert.ok(!/must be of type string/.test(msg2), `「两边都留」缺副本时不该抛类型错误：${msg2}`);
    assert.ok(/没有留存远端版本/.test(msg2), `应当明确说明缺少远端副本，实际：${msg2}`);
  });

  await step('配置读写：remote/branch 落到 chat-sync.json', () => {
    const saved = engineA.writeConfig({ branch: 'main' });
    assert.equal(saved.branch, 'main');
    const onDisk = JSON.parse(fs.readFileSync(path.join(homeA, 'chat-sync.json'), 'utf8'));
    assert.equal(onDisk.branch, 'main');
    // 旧插件的配置文件不能被我们改写
    assert.ok(!fs.existsSync(path.join(homeA, 'dsh-sync.json')), '没有凭空创建 dsh-sync.json');
  });

  await step('profile 清单/锁文件/组合结果是本机专属：从索引移出、文件保留', async () => {
    // 复现真实场景：旧插件（以及我改名时跑的 pnpm）把这些文件提交进了 ~/.dsh 仓库
    const files = {
      'profiles/web/package.json': '{"name":"p","dependencies":{"x":"link:/home/alice/x"}}',
      'profiles/web/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'profiles/web/pnpm-workspace.yaml': 'packages:\n  - .\n',
      'profiles/web/cordis.yml': '# composed\n',
      'profiles/web/cordis.patch.yml': '- id: keep-me\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(homeA, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    await run('git', ['-C', homeA, 'add', '-f', '--', ...Object.keys(files)]);
    await run('git', ['-C', homeA, 'commit', '-q', '-m', 'pretend the old layout tracked these']);

    // 跑一次同步，让引擎执行「机器本地文件移出跟踪」
    await engineA.execute({ direction: 'push', scope: 'all' });

    const tracked = (await run('git', ['-C', homeA, 'ls-files', '--', 'profiles/'])).out
      .split('\n').map((x) => x.trim()).filter(Boolean);

    for (const rel of ['profiles/web/package.json', 'profiles/web/pnpm-lock.yaml', 'profiles/web/pnpm-workspace.yaml', 'profiles/web/cordis.yml']) {
      assert.ok(!tracked.includes(rel), `${rel} 不应再被跟踪`);
      assert.ok(fs.existsSync(path.join(homeA, rel)), `${rel} 的本地文件必须保留`);
    }
    // 用户自己编辑的 patch 层仍然同步
    assert.ok(tracked.includes('profiles/web/cordis.patch.yml'), 'cordis.patch.yml 仍应被跟踪');

    // gitignore 补齐了这几条，否则下次 git add -A 又会把它们加回来
    const ig = fs.readFileSync(path.join(homeA, '.gitignore'), 'utf8');
    for (const pat of ['profiles/*/package.json', 'profiles/*/pnpm-lock.yaml', 'profiles/*/pnpm-workspace.yaml', 'profiles/*/cordis.yml']) {
      assert.ok(ig.split('\n').some((l) => l.trim() === pat), `.gitignore 应含 ${pat}`);
    }
    // 移出跟踪之后再跑一次，索引保持干净
    const st = await run('git', ['-C', homeA, 'status', '--porcelain', '--', 'profiles/']);
    assert.ok(!/^\s*[AM]\s+profiles\/web\/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.yml)/m.test(st.out),
      `profile 清单不该再出现在 status 里，实际：${st.out}`);
  });

  const failed = results.filter((x) => x[0] === 'fail');
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) {
    for (const [, name, err] of failed) process.stdout.write(`失败：${name}\n${err?.stack || err}\n`);
    process.stdout.write(`（保留现场：${root}）\n`);
    process.exitCode = 1;
  } else {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    process.stdout.write(`已清理 ${root}\n`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
