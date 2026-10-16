/**
 * 新交付模型的专项测试（规格 docs/design-sync-model.md）。
 *
 * 重点验证的是「推送不再强迫本端拉取」这条核心性质，以及忽略、部分交付：
 *   1. 本端落后 main 时仍能推送自己的改动
 *   2. 推送后 main 同时拥有双方内容，而本端工作树一个字节都没变
 *   3. 本端永不分叉（ahead 恒为 0），想拉时是纯快进
 *   4. 被忽略的会话既不推也不拉，而且不阻塞其他会话交付
 *   5. 一次推送里既有可交付单元又有真冲突时：能交付的先交付
 *
 * 运行：node tests/delivery.test.mjs
 * 只用自己创建的临时目录，不碰真实 ~/.dsh，也不改 ~/.gitconfig。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncEngine } from '../lib/engine.js';
import { sessionSlugFromCwd } from '../lib/session.js';
import { zstdEncode, zstdDecode, run } from '../lib/util.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-deliver-'));
const remoteDir = path.join(root, 'remote.git');
const results = [];

function step(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { results.push(['ok', name]); process.stdout.write(`  ✓ ${name}\n`); })
    .catch((e) => { results.push(['fail', name, e]); process.stdout.write(`  ✗ ${name}\n    ${e?.message || e}\n`); });
}

const CWD = '/home/alice/project';
const SX = 'session-xxxx1111-0000-4000-8000-000000000001';
const SY = 'session-yyyy2222-0000-4000-8000-000000000002';
const SZ = 'session-zzzz3333-0000-4000-8000-000000000003';
const SW = 'session-wwww4444-0000-4000-8000-000000000004';

function userMsg(text, seq) {
  return { type: 'user/message', seq, time: 1791000000000 + seq, data: { content: [{ type: 'text', text }], role: 'user', id: randomUUID() }, surfaceOp: 'append' };
}

function sessionBuffer(id, events) {
  const header = { type: 'session', version: 4, id, createdAt: 1791000000000, cwd: CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  return zstdEncode([header, ...events].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function makeHome(name, sessions = []) {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  for (const s of sessions) {
    const dir = path.join(home, 'sessions', sessionSlugFromCwd(CWD), s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), sessionBuffer(s.id, s.events || []));
    fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', s.id + '.json'),
      JSON.stringify({ version: 7, record: { identity: { cwd: CWD }, rows: { title: { ver: 1, seq: 1, val: s.title || s.id } } } }));
  }
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }, null, 2));
  return home;
}

function sessionFile(home, id) {
  const p = path.join(home, 'sessions', sessionSlugFromCwd(CWD), id, 'session.v4.jsonl.zstd');
  return fs.existsSync(p) ? p : null;
}
function sessionTexts(home, id) {
  const p = sessionFile(home, id);
  if (!p) return null;
  return zstdDecode(fs.readFileSync(p)).toString('utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => r.data?.content?.[0]?.text).filter(Boolean);
}
function appendEvents(home, id, texts) {
  const p = sessionFile(home, id);
  assert.ok(p, `找不到会话文件 ${id}`);
  const rows = zstdDecode(fs.readFileSync(p)).toString('utf8').split('\n').filter(Boolean);
  const next = rows.length - 1;
  const more = texts.map((t, i) => JSON.stringify(userMsg(t, next + i)));
  fs.writeFileSync(p, zstdEncode(rows.concat(more).join('\n') + '\n'));
}
async function counts(engine) {
  const s = await engine.status();
  return { ahead: s.repo.ahead, behind: s.repo.behind };
}
function mainSessionTexts(home, id) {
  // 直接读远端 main 上那个会话的内容（用本机仓库的 origin/main 引用）
  const rel = `sessions/${sessionSlugFromCwd(CWD)}/${id}/session.v4.jsonl.zstd`;
  return run('git', ['-C', home, 'show', `origin/main:${rel}`], { binary: true }).then((r) => {
    if (r.code !== 0) return null;
    return zstdDecode(r.out).toString('utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).map((x) => x.data?.content?.[0]?.text).filter(Boolean);
  });
}

async function main() {
  process.stdout.write(`临时目录：${root}\n`);
  fs.mkdirSync(remoteDir, { recursive: true });
  assert.equal((await run('git', ['init', '--bare', '-b', 'main', remoteDir])).code, 0);
  const fakeGlobal = path.join(root, 'gitconfig');
  fs.writeFileSync(fakeGlobal, '[protocol "file"]\n\tallow = always\n');
  process.env.GIT_CONFIG_GLOBAL = fakeGlobal;

  const cfg = { remote: 'file://' + remoteDir, branch: 'main', gitUserName: 't', gitUserEmail: 't@t', autoRepo: false };
  const homeA = makeHome('home-a', [
    { id: SX, title: 'X', events: [userMsg('X 起始', 0)] },
    { id: SY, title: 'Y', events: [userMsg('Y 起始', 0)] },
    { id: SZ, title: 'Z', events: [userMsg('Z 起始', 0)] },
    { id: SW, title: 'W', events: [userMsg('W 起始', 0)] },
  ]);
  const A = new SyncEngine(homeA, cfg, () => {});
  const homeB = makeHome('home-b');
  const B = new SyncEngine(homeB, cfg, () => {});

  await step('准备：A 首次上传，B 取回', async () => {
    assert.equal((await A.execute({ direction: 'push', scope: 'all' })).ok, true);
    assert.equal((await B.execute({ direction: 'pull', scope: 'all' })).ok, true);
    assert.ok(sessionTexts(homeB, SX), 'B 应该拿到了 X');
    assert.ok(sessionTexts(homeB, SW), 'B 应该拿到了 W');
  });

  let aXBefore = null;
  await step('B 改会话 X 并推送；A 改会话 Y —— 此时 A 落后 main', async () => {
    appendEvents(homeB, SX, ['B 改了 X']);
    assert.equal((await B.execute({ direction: 'push', scope: 'all' })).ok, true);
    appendEvents(homeA, SY, ['A 改了 Y']);
    await A.git(['fetch', 'origin', '--prune']);
    const c = await counts(A);
    assert.ok(c.behind > 0, `A 应当落后 main，实际 behind=${c.behind}`);
    aXBefore = fs.readFileSync(sessionFile(homeA, SX));
  });

  await step('核心性质：A 落后 main 时推送成功，且 main 同时拿到双方内容', async () => {
    const r = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    assert.equal(r.result.conflicts.length, 0, '不该有冲突');
    await A.git(['fetch', 'origin', '--prune']);
    const mx = await mainSessionTexts(homeA, SX);
    const my = await mainSessionTexts(homeA, SY);
    assert.ok(mx.includes('B 改了 X'), 'main 上 X 应当是 B 的版本');
    assert.ok(my.includes('A 改了 Y'), 'main 上 Y 应当是 A 的版本');
  });

  await step('核心性质：A 的本机工作树一个字节都没变，也没被迫拉取', async () => {
    assert.ok(aXBefore.equals(fs.readFileSync(sessionFile(homeA, SX))), 'A 本机的 X 必须保持原样');
    assert.ok(!sessionTexts(homeA, SX).includes('B 改了 X'), 'A 本机不该看到 B 对 X 的改动');
    assert.ok(sessionTexts(homeA, SY).includes('A 改了 Y'), 'A 本机的 Y 是它自己改的');
  });

  await step('核心性质：A 永不分叉（ahead=0），想拉时是纯快进', async () => {
    const c = await counts(A);
    assert.equal(c.ahead, 0, `A 不该领先 main（ahead=${c.ahead}）`);
    assert.ok(c.behind > 0, 'A 应当只是落后');
    // 纯快进：HEAD 是 origin/main 的祖先，merge --ff-only 必然成功
    const ff = await A.git(['merge', '--ff-only', 'origin/main']);
    assert.equal(ff.code, 0, `快进应当成功：${ff.err}`);
    assert.ok(sessionTexts(homeA, SX).includes('B 改了 X'), '快进后才拿到 B 的 X');
    const c2 = await counts(A);
    assert.equal(c2.behind, 0);
    assert.equal(c2.ahead, 0);
  });

  /* ---------------- 忽略 ---------------- */
  await step('忽略：本机忽略会话 X 后，main 上 X 的新版本不会被本机拉下来', async () => {
    B.writeIgnoreConfig({});                     // 清一下，确保 B 不忽略
    A.writeIgnoreConfig({ sessions: [SY] });     // 先只忽略 Y，专心测 X 的拉取
    appendEvents(homeB, SX, ['B 又改了 X']);
    assert.equal((await B.execute({ direction: 'push', scope: 'all' })).ok, true);
    A.writeIgnoreConfig({ sessions: [SX] });     // 现在忽略 X
    const before = fs.readFileSync(sessionFile(homeA, SX));
    const r = await A.execute({ direction: 'pull', scope: 'all' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    assert.ok(before.equals(fs.readFileSync(sessionFile(homeA, SX))), '被忽略的 X 不该被拉取更新');
    A.writeIgnoreConfig({ sessions: [] });
  });

  await step('忽略：被忽略的会话即使落后，也不阻塞其他会话交付给 main', async () => {
    // A 忽略 X（此时 X 在 main 上更新、在本机落后），改 Y 并推送
    A.writeIgnoreConfig({ sessions: [SX] });
    appendEvents(homeA, SY, ['A 再改 Y']);
    const r = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r.ok, true, JSON.stringify(r.result?.error || r.error));
    await A.git(['fetch', 'origin', '--prune']);
    const mx = await mainSessionTexts(homeA, SX);
    const my = await mainSessionTexts(homeA, SY);
    assert.ok(mx.includes('B 又改了 X'), 'main 上 X 必须仍是 B 的版本（忽略不得回退它）');
    assert.ok(my.includes('A 再改 Y'), 'main 应当拿到 A 对 Y 的新改动');
    A.writeIgnoreConfig({ sessions: [] });
  });

  /* ---------------- 部分交付 ---------------- */
  await step('部分交付：能交付的先交付，真冲突的留下等裁决', async () => {
    // 把 X 重新对齐，避免上一轮的"落后"干扰判断
    await A.execute({ direction: 'pull', scope: 'all' });
    await B.execute({ direction: 'pull', scope: 'all' });

    // 先让两边完全同步，然后 B 改 X 推上去，A 在没拉取的情况下也改 X → 真正的分叉
    assert.equal((await A.execute({ direction: 'pull', scope: 'all' })).ok, true);
    assert.equal((await B.execute({ direction: 'pull', scope: 'all' })).ok, true);
    appendEvents(homeB, SX, ['B 分叉 X']);
    assert.equal((await B.execute({ direction: 'push', scope: 'all' })).ok, true);
    appendEvents(homeA, SX, ['A 分叉 X']);   // A 没拉过 B 的改动 → 与 main 分叉
    appendEvents(homeA, SZ, ['A 改 Z']);     // Z 是干净的可交付单元

    const r = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r.ok, false, '有真冲突时应报告未完成');
    assert.equal(r.result.conflicts.length, 1, '恰好一项待裁决');
    assert.equal(r.result.conflicts[0].sessionId, SX);
    assert.ok(r.result.delivered?.length, 'Z 应当已经被交付');
    await A.git(['fetch', 'origin', '--prune']);
    const mx = await mainSessionTexts(homeA, SX);
    const mz = await mainSessionTexts(homeA, SZ);
    assert.ok(!mx.includes('A 分叉 X'), 'main 的 X 不该被 A 的分叉版覆盖');
    assert.ok(mz.includes('A 改 Z'), 'main 应当已经拿到 A 的 Z');
    assert.ok(sessionTexts(homeA, SX).includes('A 分叉 X'), 'A 本机的 X 保持原样');
  });

  await step('待裁决的会话：本机文件不动，裁决「两边都留」后收敛', async () => {
    const pending = A.listPending();
    assert.equal(pending.length, 1);
    const c = pending[0].conflicts[0];
    const before = fs.readFileSync(sessionFile(homeA, SX));
    assert.ok(before.length > 0);
    const r = await A.resolveConflicts({ pendingId: pending[0].id, decisions: [{ id: c.id, choice: 'both' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(r.detail.both[0].newSessionId, '应当导入了远端那一支为新会话');
    assert.equal(A.listPending().length, 0, '待裁决记录已清空');
  });

  await step('强制覆盖：用本机版本覆盖 main', async () => {
    const rel = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    appendEvents(homeB, SW, ['B 在 W 上写的']);
    assert.equal((await B.execute({ direction: 'push', scope: 'all' })).ok, true);
    appendEvents(homeA, SW, ['A 在 W 上写的']);   // A 没拉过 → 两边分叉

    const p0 = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(p0.ok, false, '不强制时应当报冲突');

    const r = await A.forceUnit(rel, 'push');
    assert.equal(r.ok, true, JSON.stringify(r.error));
    await A.git(['fetch', 'origin', '--prune']);
    const mw = await mainSessionTexts(homeA, SW);
    assert.ok(mw.includes('A 在 W 上写的'), 'main 应当被本机版本覆盖');
    assert.ok(!mw.includes('B 在 W 上写的'), 'main 上不该再有远端那一版');
  });

  await step('强制覆盖：用远端版本覆盖本机', async () => {
    const rel = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    // B 在自己的版本上继续写并强制推上去 → main 与 A 又不一致
    appendEvents(homeB, SW, ['B 又写了一句']);
    const rb = await B.forceUnit(rel, 'push');
    assert.equal(rb.ok, true, JSON.stringify(rb.error));
    await A.git(['fetch', 'origin', '--prune']);

    const r = await A.forceUnit(rel, 'pull');
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const aw = sessionTexts(homeA, SW);
    assert.ok(aw.includes('B 在 W 上写的') && aw.includes('B 又写了一句'), '本机应当被 main 的版本覆盖');
  });

  await step('强制覆盖会消解同一条待裁决记录', async () => {
    const rel = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    appendEvents(homeB, SW, ['B 制造分叉']);
    const rb = await B.execute({ direction: 'push', scope: 'all' });
    if (!rb.ok) await B.forceUnit(rel, 'push');   // 若 B 自己也分叉了就直接强制
    appendEvents(homeA, SW, ['A 制造分叉']);
    const hold = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(hold.ok, false, '这一步应当产生待裁决');
    assert.ok(A.listPending().some((x) => x.conflicts.some((c) => c.path === rel)), '应当登记了 SW 的冲突');

    const r = await A.forceUnit(rel, 'push');
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.clearedPending, true, '强制覆盖应当顺带消解那条待裁决');
    assert.ok(!A.listPending().some((x) => x.conflicts.some((c) => c.path === rel)), 'SW 不该再留在待裁决里');
    await A.git(['fetch', 'origin', '--prune']);
    const mw = await mainSessionTexts(homeA, SW);
    assert.ok(mw.includes('A 制造分叉'), 'main 应当被本机版本覆盖');
  });

  await step('推送侧裁决「保留本机」= 用本机覆盖 main，绝不能被当成删除', async () => {
    const rel = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    // 重新制造一个分叉
    await A.execute({ direction: 'pull', scope: 'all' });
    appendEvents(homeB, SW, ['B 最后一次']);
    const rb = await B.execute({ direction: 'push', scope: 'all' });
    if (!rb.ok) await B.forceUnit(rel, 'push');
    appendEvents(homeA, SW, ['A 最后一次']);
    const hold = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(hold.ok, false, '应当产生待裁决');

    const pending = A.listPending();
    const c = pending.flatMap((x) => x.conflicts).find((x) => x.path === rel);
    assert.ok(c, '应当登记了 SW 的冲突');

    const r = await A.resolveConflicts({ pendingId: pending[0].id, decisions: [{ id: c.id, choice: 'local' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error));

    await A.git(['fetch', 'origin', '--prune']);
    const mw = await mainSessionTexts(homeA, SW);
    assert.ok(mw, 'main 上这个会话必须还在 —— 选「保留本机」不是删除');
    assert.ok(mw.length > 0, 'main 上这个会话不能变成空文件');
    assert.ok(mw.includes('A 最后一次'), 'main 应当被本机版本覆盖');
    assert.ok(sessionTexts(homeA, SW).includes('A 最后一次'), '本机这一版保持不变');
  });

  await step('部分裁决：只提交已选的那一项，其余留在待裁决里', async () => {
    // 同时制造两个分叉会话：X 与 W
    const relW = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    await A.execute({ direction: 'pull', scope: 'all' });
    await B.execute({ direction: 'pull', scope: 'all' });
    appendEvents(homeB, SX, ['B 分叉 X 二']);
    appendEvents(homeB, SW, ['B 分叉 W 二']);
    const rb = await B.execute({ direction: 'push', scope: 'all' });
    if (!rb.ok) { for (const c of B.listPending().flatMap((x) => x.conflicts)) await B.forceUnit(c.path, 'push'); }
    appendEvents(homeA, SX, ['A 分叉 X 二']);
    appendEvents(homeA, SW, ['A 分叉 W 二']);
    const hold = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(hold.ok, false, '应当产生两项待裁决');

    const store = A.listPending()[0];
    assert.equal(store.conflicts.length, 2, `应当有两项待裁决，实际 ${store.conflicts.length}`);
    const only = store.conflicts.find((c) => c.path === relW);

    const r = await A.resolveConflicts({ pendingId: store.id, decisions: [{ id: only.id, choice: 'local' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.remaining, 1, '应当还剩一项待裁决');

    const left = A.listPending();
    assert.equal(left.length, 1, '待裁决记录应当保留');
    assert.equal(left[0].conflicts.length, 1, '只剩没裁决的那一项');
    assert.ok(left[0].conflicts[0].path !== relW, '已裁决的那项应当从待裁决里消失');
  });

  await step('删除类：裁决「只在本机删除」后不再重复问，且 main 保持原样', async () => {
    const relW = `sessions/${sessionSlugFromCwd(CWD)}/${SW}/session.v4.jsonl.zstd`;
    await A.execute({ direction: 'pull', scope: 'all' });
    await B.execute({ direction: 'pull', scope: 'all' });

    // 本机把 W 的会话整个删掉
    fs.rmSync(path.dirname(sessionFile(homeA, SW)), { recursive: true, force: true });
    fs.rmSync(path.join(homeA, 'storages', 'session_projcache', 'sessions', SW + '.json'), { force: true });

    const r1 = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r1.ok, false, '删除应当进待裁决（删除绝不自动传播）');
    const store = A.listPending()[0];
    const c = store.conflicts.find((x) => x.path === relW);
    assert.ok(c, '应当登记 W 的删除冲突');
    assert.equal(c.reason, 'delete-local');

    const r2 = await A.resolveConflicts({ pendingId: store.id, decisions: [{ id: c.id, choice: 'keep' }] });
    assert.equal(r2.ok, true, JSON.stringify(r2.error));
    await A.git(['fetch', 'origin', '--prune']);
    const mw = await mainSessionTexts(homeA, SW);
    assert.ok(mw && mw.length > 0, 'main 上这个会话必须还在');

    // 再推一次：同一个删除不该被重复问（其他历史遗留的冲突与本用例无关，只断言 W 本身）
    const r3 = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r3.ok, true, `不该重复报同一个删除：${r3.result?.error || ''}`);
    assert.equal(
      A.listPending().some((x) => x.conflicts.some((c) => c.path === relW)),
      false,
      '同一个删除不该被重复问第二次',
    );
  });

  await step('删除类：裁决「同步删除到 main」会把删除真的交付上去', async () => {
    const relZ = `sessions/${sessionSlugFromCwd(CWD)}/${SZ}/session.v4.jsonl.zstd`;
    fs.rmSync(path.dirname(sessionFile(homeA, SZ)), { recursive: true, force: true });
    fs.rmSync(path.join(homeA, 'storages', 'session_projcache', 'sessions', SZ + '.json'), { force: true });

    const r1 = await A.execute({ direction: 'push', scope: 'all' });
    assert.equal(r1.ok, false, '应当进待裁决');
    const store = A.listPending()[0];
    const c = store.conflicts.find((x) => x.path === relZ);
    assert.ok(c, '应当登记 Z 的删除冲突');

    const r2 = await A.resolveConflicts({ pendingId: store.id, decisions: [{ id: c.id, choice: 'delete' }] });
    assert.equal(r2.ok, true, JSON.stringify(r2.error));
    await A.git(['fetch', 'origin', '--prune']);
    const mz = await mainSessionTexts(homeA, SZ);
    assert.equal(mz, null, 'main 上这个会话应当已经不存在');
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
