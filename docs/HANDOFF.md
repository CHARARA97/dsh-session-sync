# 交接说明（给下一个会话）

本文件是**实战笔记**：这里记的是这个插件在这一台机器上真实踩过的坑、当前状态、以及还没做完的事。
读完它再动代码，能省掉至少三轮误判。规格本身见 [design-sync-model.md](design-sync-model.md)，README 见仓库根目录。

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 插件源码 | `/home/CHARARA97/Documents/deepseek-harness/default-workspace/dsh-chat-sync` |
| 插件仓库（GitHub） | `git@github.com:CHARARA97/dsh-session-sync.git`（**SSH**） |
| 数据仓库（GitHub） | `https://github.com/CHARARA97/dsh-sync.git` |
| 当前 HEAD / 版本 | `9c3ebe4` / `1.1.1` |
| npm 上的版本 | **1.1.0（落后！1.1.1 还没发布）** |
| DSH_HOME | `/home/rkn/.dsh`（`/home/CHARARA97` 与 `/home/rkn` 是同一个目录） |
| profile | `/home/rkn/.dsh/profiles/web`（桌面版是 `profiles/desktop`） |
| 测试 | `npm test` → 64 项（engine 27 / delivery 16 / client-render 21） |

**先记住一句话：这台机器上有两个 GitHub 远端。** 见下一节。

---

## 1. 两个远端 —— 最容易踩的坑

| 远端 | 装什么 | 查它的方式 |
|---|---|---|
| **数据仓库** `dsh-sync` | 会话日志、工作区项目文件、附件 | `git -C ~/.dsh ...` |
| **插件仓库** `dsh-session-sync` | 插件自己的源码 | `git -C <插件目录> ...` |

用户说"看远端"时**先确认是哪一个**，或者两个都查。我在此栽过：连着三次"看远端"都只查了数据仓库，
完全没打开插件仓库，于是"批量选项那两个提交"在我视野里根本不存在，还被用户当场指出。

---

## 2. 插件是怎么被加载的 —— 第二个坑（症状极像"改了不生效"）

profile 里的依赖**必须是指向源码的 `link:`**：

```sh
readlink -f ~/.dsh/profiles/web/node_modules/@charara97/dsh-session-sync
# 期望输出：/home/CHARARA97/Documents/deepseek-harness/default-workspace/dsh-chat-sync
```

如果它是**目录副本**（而不是软链），宿主加载的就是那份**快照**，你在源码里的所有修改它都看不见。
更糟的是 profile 里可能**同时**存在 `"@charara97/dsh-session-sync": "^1.0.0"`（npm 副本）和
`"@local/dsh-chat-sync": "link:..."`（旧名链接），**两条都列在 bundles 里** —— 加载哪一份全看运气。

判断宿主到底加载了哪一代：

```sh
curl -s http://127.0.0.1:3080/chat-sync/api/ping | grep -o '"build":"[^"]*"'   # 没有 build 字段 = 旧一代
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/chat-sync/api/session/repair?path=x  # 404 = 旧一代
```

修复（**顺序不能乱**，否则 `bundle-in-use`）：

1. `plugin_manager set_bundle` → 目标 `@local/dsh-chat-sync`、`enabled=false`
2. `plugin_manager remove_bundle` → `@local/dsh-chat-sync`
3. `plugin_manager remove_bundle` → `@charara97/dsh-session-sync`
4. `plugin_manager install_bundle` → 源码目录的**绝对路径**

最后确认 `node_modules/@charara97/dsh-session-sync` 是软链、且 `package.json` 依赖只剩一条。

> **重启 DSH 只刷新模块，不改变加载来源。** 来源没修好，重启多少次都是旧代码。

---

## 3. 不可动摇的不变量（改代码前必读）

1. **会话日志只增不减。** 行 `seq` 从 0 严格 +1；**不许回滚、不许复用 seq、不许整文件覆盖**。
   `seq` 还被 `.sourceEventSeqs`、`.data.throughSeq` 引用，**重新编号是禁止的**。
2. **任何"让日志变短"的写入都是 bug。** 无论它来自快进、合并、交付、还是恢复。
3. **push 绝不改本机工作树 / HEAD / 真实 index。** 它用临时 index +
   `update-index --cacheinfo` + `write-tree` + `commit-tree <tree> -p origin/main -p HEAD` + `git push <sha>:refs/heads/main`。
   **父提交必须是 (origin/main, 本地 HEAD) 双父**，否则"本机永不分叉"的保证失效。
4. **main 立即可信；本机只可能落后。** 取回是纯快进或逐条保护合并。
5. **真冲突停手等裁决；删除每次都问；"两边都留"** 把远端版本另存（会话→导入为新会话）。
6. 忽略/裁决存 `~/.dsh/.chat-sync/ignore.json`（**不同步**）。
7. 会话日志格式：**多帧 zstd，一次追加一帧**。健康日志 = 帧数 == 行数。

---

## 4. 血泪清单（都已发生，别再踩）

### 4.1 `git log -- <路径>` 会骗你 —— 必须加 `--full-history`

```
git log --all --oneline       -- <路径>   → 12 个提交   ← 默认历史简化，漏掉承载完整内容的快照提交
git log --all --full-history --oneline -- <路径>   → 35 个提交   ← 正确
```

我因为只看前者，**三次断言"没有回滚"，全错**，直到用户坚持"日志文件本身被回滚了呢"才挖出来。
查"某个文件历史上有没有被改坏"时，一律用 `--full-history`。

### 4.2 取回的快进分支跳过了守卫（1.1.1 已修）

`pull` 里"能纯快进就快进"的分支在 `merge --ff-only` 成功后**直接 return**，
把紧随其后的两段守卫（① 日志不许被改回旧版 ② 结果必须是合法日志）整个跳过 —— 而快进是**会改写工作树**的。

**真实事故**：本机 3905 行的会话日志被一次取回覆盖成远端 3714 行的旧版，丢掉 202 行（含用户 18:26 那条需求）。
两个提交是元凶：`4ad6fc9`（第一次截断）、`f4c9b13`（覆盖后再也回不来）。

修法：`sessionLogsShrunkBy()` 先算"远端那一版会不会让任何日志变短"（只有它是本机内容的**严格超集**才允许快进），
再做 `guardSessionLogs()`（快进与合并两条路径都必须跑），恢复前把被替换的那一份另存到
`.chat-sync/session-backup/pull-<ts>/`（机器本地，不同步）。

### 4.3 交付树会把更旧的日志推回 main（1.1.1 已修）

交付树是从 main 的树出发的；如果某轮判定认为"不需要叠加"（例如 A1 已同步，但 DSH 在快照之后又追加了新行），
交付树里就留着远端那份更旧的日志 —— **然后把本机已有的行回退给了远端**，之后一次快进就把本机也截断。

修法：`buildDeliveryCommit` 里逐个核对 `cls.units` 中的会话日志，交付树里那一版但凡不是"本机磁盘内容的超集"，
就改用本机内容交付。**只处理本轮参与判定的单元** —— 被忽略/静音的路径不碰（那是用户明确的选择）。

### 4.4 回归测试必须"修复前失败"

`tests/engine.test.mjs` 里 `回归：远端被「坏交付」退回旧版时，快进不得截断本机会话日志`
完整复现了 4.2 的事故。**验过**：旧引擎下它失败（26/27），修复后通过（27/27）。
写这类测试时，请同样验证"没有修复时它确实失败"，否则等于没测。

### 4.5 手写夹具害我漏了一个真 bug

`/units` 接口曾经返回嵌套结构（`units: {units: [...]}`）而客户端读数组，导致**界面「条目状态」表永远是空的**。
我的 client 测试之所以通过，是因为**夹具是我手写的扁平结构、与真实服务端不一致**。
**教训：夹具要么来自真实响应，要么补一条"形状断言"。**

（这个 bug 最终由**另一台机器**在 `68d13f0` 修掉，而且它那版更好：形状不对就**明确报错**，
而不是静默当成空表。合并时我采用了它的版本。）

### 4.6 会话日志"修复"的唯一安全做法是截断

DSH 遇到 `seq` 断点会拒绝加载（`released v2 row M has seq gap`）。历史上出现过
`0..2791` 后面接 `1789..1969` 的损坏。**唯一安全的修法是截断到最后一个合法前缀**（不触碰任何 `seq`），
原件备份到 `.chat-sync/session-backup/<ts>/`。见 `previewSessionRepair()` / `repairSessionLog()`。

### 4.7 嵌套 git 仓库（gitlink）

工作区里的独立 git 仓库不能随父目录同步（git 只记 `gitlink`，不带内容，父仓库提交必失败）。
`discoverGitlinks()` + `rememberGitlinks()` 会把它们从索引里摘掉，并明确报一句"有几个嵌套仓库未同步"。
用户已选择**保持不同步**，可用 `chat-sync.json` 的 `workspaceExtraIgnore` 静音。

### 4.8 同步垃圾

- `sessions/**/*.bak-*`：历史遗留的备份文件被同步（main 上有一个 571 KB 的）。
- `*.remote-<时间>`：`两边都留` 产生的一次性副本。
- `build/`、`.cache/`、`.dshtmp/`、`students.backup/`：CMake 生成物与整份重复副本。
  `reports/.dsh-chat-sync-ignore` 与 `reports/students/.dsh-chat-sync-ignore` **目前只有模板注释、没有任何规则**。

### 4.9 工具层面的两个小坑

- **Node 里 `1 << 31` 是负数**（位运算 32 位有符号），当 `maxBuffer` 传给 `execFileSync` 会直接抛错。
  用 `1 << 30` 或 `1073741824`。
- **`git rebase --continue` 会打开编辑器**，没有 TTY 就永久挂起。用 `GIT_EDITOR=true git rebase --continue`。
- 插件仓库提交时**显式带身份**，别依赖全局配置：
  `git -c user.name="CHARARA97" -c user.email="CHARARA97@users.noreply.github.com" commit ...`

### 4.10 验证的边界

**没有浏览器控制。** 测试可以验语法、清单、实时 slot 树，**不能验外观**；client 测试用的是自写的最小 React 替身。
界面相关的改动，最终要让人在真的界面上看一眼。

---

## 5. 当前状态（写完本文件时）

- 插件仓库：`9c3ebe4`，版本 `1.1.1`，已推送；npm 上仍是 `1.1.0`。
- 测试：64 项全绿（`npm test`）。
- 待裁决记录：**0 条**。
- 已记住的裁决：**98 条，全是 `delete`**（那批 profile 清单/锁文件已决定"同步删除到远端"）。
- 被忽略的工作区：**6 个** —— `nvim`、`reports`、`students`、`car`、`实验报告`×2。
  **也就是目前只有 `default-workspace` 真的在同步。** 这与用户"想同步项目源码"的意图可能冲突，需确认。
- 从事故中恢复出来的会话：`session-55845cd8-25a4-4e1f-88ed-3e6261129f13`（3905 行，含 18:26 那条需求）。
  恢复方式：`git -C ~/.dsh cat-file blob 0c90b6e:<日志路径>` →
  用 `lib/session.js` 的 `duplicateSessionLog(home, buf, newId)` 另存为新会话（不动正在写入的那份）。
- 机器身份：`/etc/machine-id = b40fa0129a614a1eb76b52f642486755`，主机名 `RaikunasLaptop`。
  （"另一台设备"的说法与观测不符；上面两个路径是同一个 inode。移动端/另一台机器可能确实存在，但本会话无法验证。）

---

## 6. 还没做完

1. **发布 npm 1.1.1**（在有凭据的设备上）。npm 已开启 2FA（`auth-and-writes`）。
   ```sh
   npm test && npm publish      # 版本已是 1.1.1
   npm view @charara97/dsh-session-sync version
   ```
2. **6 个被忽略的工作区**：确认是要恢复同步，还是有意排除。
3. **补两份工作区忽略规则**：`reports/.dsh-chat-sync-ignore`、`reports/students/.dsh-chat-sync-ignore`
   至少加 `build/`、`.cache/`、`.dshtmp/`、`students.backup/`。
4. **清理 sessions 下的 `.bak-` 文件**，并给忽略清单加 `sessions/**/*.bak-*`。
5. **插件源码被"双重管理"**：它既在 `default-workspace` 的 chat-sync 同步范围里（影子仓库仍跟踪 16 个文件），
   又有自己的 `.git`。两边同时改会撞成冲突。要么让 git 独占（把那些路径从影子仓库摘掉），要么维持现状（有守卫，不会静默覆盖）。
6. **空待裁决目录**：`newPendingStore` 无条件建目录，没产生冲突时留下空目录垃圾（我手工清过 17 个）。
   建议改成"真有冲突才落盘"。
7. **残留限制**：守卫只能保住"取回之前磁盘上已有的内容"。若日志已被截断、DSH 又往被截断的版本上追加了新行
   （`seq` 被复用），那部分新行无法再拼回原日志，只能各自成为独立记录。
8. **在真界面上确认**「一键全部设为某个选项」（`e5f7ed9` / 另一台机器的 `749e67b`、`41a2fde`）能用，
   且对删除类冲突的语义正确（`delete` / `keep`，而不是 `local`）。

---

## 7. 常用命令

```sh
# 加载来源与世代
readlink -f ~/.dsh/profiles/web/node_modules/@charara97/dsh-session-sync
curl -s http://127.0.0.1:3080/chat-sync/api/ping | grep -o '"build":"[^"]*"'

# 数据仓库：某个文件的历史（一定要 --full-history）
git -C ~/.dsh log --all --full-history --oneline -- 'sessions/<slug>/<id>/session.v4.jsonl.zstd'

# 读某个提交里的会话日志
git -C ~/.dsh cat-file blob <提交>:<路径> | zstd -dc | head

# 会话日志健康检查（行数 / seq 范围 / 断点）
zstd -dc <日志> | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const L=s.split("\n").filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);let p=null,g=0;for(const j of L){if(typeof j.seq==="number"){if(p!==null&&j.seq!==p+1)g++;p=j.seq}}console.log("行数",L.length,"seq末",p,"断点",g)})'

# 插件：测试 / 提交 / 推送
npm test
git -c user.name="CHARARA97" -c user.email="CHARARA97@users.noreply.github.com" commit -am "..."
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main
```

---

## 8. 与用户打交道的注意事项

- **他说的事情先当作对的去验证**，尤其当他说"我明明做过 X"。这一轮我三次断言"没有回滚"，
  最后是用户的坚持才让我换了个判据挖出真相。
- **不要用"检查过、没问题"结束话题**，如果检查方法本身有盲区（例如只看最新版本、或用了会做历史简化的命令）。
  把**判据**说清楚，比给结论更重要。
- 用语正式、简明。少用感叹号，不要用"棒极了"这类词。
- 他关心的是**两台机器之间能不能可靠搬运**，不是插件内部的优雅。
