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
import { sessionSlugFromCwd } from '../lib/session.js';
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

  await step('配置读写：remote/branch 落到 chat-sync.json', () => {
    const saved = engineA.writeConfig({ branch: 'main' });
    assert.equal(saved.branch, 'main');
    const onDisk = JSON.parse(fs.readFileSync(path.join(homeA, 'chat-sync.json'), 'utf8'));
    assert.equal(onDisk.branch, 'main');
    // 旧插件的配置文件不能被我们改写
    assert.ok(!fs.existsSync(path.join(homeA, 'dsh-sync.json')), '没有凭空创建 dsh-sync.json');
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
