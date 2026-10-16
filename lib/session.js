/**
 * 会话日志的定位、读取与「同 id 会话」的一致性判断。
 *
 * 会话在磁盘上的布局（DSH HOME 下）：
 *   sessions/<cwd-slug>/<session-id>/session[.vN].jsonl[.zstd]
 * 目录名不一定带 `session-` 前缀，所以 **表头行里的 id 才是权威**。
 * 表头行是 v4 日志的第一行：{"type":"session","version":4,"id":"session-…","cwd":…}
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFirstFrame, zstdDecode, zstdEncode, ZSTD_MAGIC, normRel } from './util.js';

export const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/i;

/** 会话日志文件的优先级：版本号大的优先，未压缩优先（与 DSH 自身的扫描顺序一致） */
export function sessionLogRank(name) {
  const m = SESSION_LOG_RE.exec(name);
  if (!m) return -1;
  const ver = m[1] ? Number(m[1]) : 0;
  const zstd = /\.zstd$/i.test(name) ? 0 : 1;
  return ver * 10 + zstd;
}

/**
 * 由会话 cwd 推导它所在的 sessions 子目录名。
 * 观察到的规则：去掉前导 `/`，`/` → `-`，其余非 [A-Za-z0-9-] 字符写成 `~` + 大写 UTF-16 码元十六进制，
 * 整体用 `--` 包裹。例如 /home/me/实验报告 → --home-me-~5B9E~9A8C~62A5~544A--
 */
export function sessionSlugFromCwd(cwd) {
  const s = String(cwd ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9-]/.test(ch)) out += ch;
    else if (ch === '/') out += '-';
    else {
      const code = ch.codePointAt(0);
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return '--' + out + '--';
}

/** 会话投影缓存文件（标题 / cwd 的可再生缓存，也是跨机还原归属关系的线索） */
export function projCachePath(home, id) {
  return path.join(home, 'storages', 'session_projcache', 'sessions', String(id) + '.json');
}

export function readSessionTitle(home, id) {
  try {
    const j = JSON.parse(fs.readFileSync(projCachePath(home, id), 'utf8'));
    const val = j?.record?.rows?.title?.val;
    if (typeof val === 'string' && val.trim()) return val.trim();
  } catch { /* 缓存缺失/损坏都只是没有标题 */ }
  return '';
}

/** 解码一份会话日志：返回逐行原始 JSON 文本（保序、保字节语义）与表头对象 */
export function decodeSessionLog(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const text = buf.subarray(0, 4).equals(ZSTD_MAGIC) ? zstdDecode(buf) : buf;
  if (!text) return null;
  let str;
  try {
    str = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  } catch {
    return null;
  }
  try {
    const rows = str.split('\n').filter((l) => l.trim());
    if (!rows.length) return null;
    const parsed = rows.map((l) => JSON.parse(l));
    if (!parsed[0] || parsed[0].type !== 'session') return null;
    if (parsed.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) return null;
    if (parsed.slice(1).some((r) => r.type === 'session')) return null;
    return { rows, parsed, header: parsed[0] };
  } catch {
    return null;
  }
}

/**
 * 校验已解析日志的格式不变量。
 *
 * 目前能确定的一条：除表头外每一行都要带 seq，从 0 开始、严格 +1、不重复。
 * 这不是多余检查 —— 真实事故里两个 DSH 宿主各自追加同一个会话，文件变成
 * 「seq 0..2791 后面又接了 1789」，DSH 直接拒绝加载整个会话。
 *
 * @returns {{ok: boolean, problems: Array<{line:number, reason:string, expected?:number, got?:number}>, rowCount: number}}
 */
export function validateSessionLog(decoded) {
  const rows = decoded?.parsed;
  if (!Array.isArray(rows) || rows.length < 2) {
    return { ok: false, problems: [{ line: 1, reason: 'empty' }], rowCount: Array.isArray(rows) ? rows.length : 0 };
  }
  const problems = [];
  let expected = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 0) {
      problems.push({ line: i + 1, reason: 'missing-seq' });
      continue;
    }
    if (r.seq !== expected) {
      problems.push({ line: i + 1, reason: r.seq > expected ? 'gap' : 'rewind', expected, got: r.seq });
      expected = r.seq + 1;
      continue;
    }
    expected += 1;
  }
  return { ok: problems.length === 0, problems, rowCount: rows.length };
}

/** 校验一份会话日志 Buffer（解析不出来也算不通过） */
export function inspectSessionLog(buf) {
  const decoded = decodeSessionLog(buf);
  if (!decoded) return { ok: false, decoded: null, problems: [{ line: 0, reason: 'unreadable' }], rowCount: 0 };
  return { ...validateSessionLog(decoded), decoded };
}

/** 读取文件的表头行；失败返回 null */
export function readHeader(abs) {
  const frame = readFirstFrame(abs);
  if (!frame) return null;
  const nl = frame.indexOf(0x0a);
  const line = nl >= 0 ? frame.subarray(0, nl) : frame;
  try {
    const j = JSON.parse(line.toString('utf8'));
    return j && j.type === 'session' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 扫描本机会话日志。
 * @returns {Array<{id,slug,dirName,relDir,relLog,absLog,size,mtime,cwd,headerOk}>}
 */
export function listLocalSessions(home, headerCache = new Map()) {
  const root = path.join(home, 'sessions');
  const out = [];
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const slugEnt of slugs) {
    const slug = slugEnt.name;
    const slugDir = path.join(root, slug);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(slugDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const ent of sessionDirs) {
      const dir = path.join(slugDir, ent.name);
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => SESSION_LOG_RE.test(f));
      } catch {
        continue;
      }
      if (!files.length) continue;
      // 一个会话目录里可能同时存在 session.jsonl.zstd 与 session.v4.jsonl.zstd：取版本最高的
      files.sort((a, b) => sessionLogRank(b) - sessionLogRank(a));
      const name = files[0];
      const absLog = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(absLog); } catch { continue; }
      const key = absLog + '|' + stat.size + '|' + stat.mtimeMs;
      let header = headerCache.get(key);
      if (header === undefined) {
        header = readHeader(absLog);
        headerCache.set(key, header);
        if (headerCache.size > 2000) headerCache.clear();
      }
      const relLog = normRel(path.relative(home, absLog));
      const id = (header && typeof header.id === 'string' && header.id)
        || (/^session-/.test(ent.name) ? ent.name : '')
        || ent.name;
      out.push({
        id,
        slug,
        dirName: ent.name,
        relDir: normRel(path.relative(home, dir)),
        relLog,
        absLog,
        size: stat.size,
        mtime: stat.mtimeMs,
        cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
        headerOk: Boolean(header),
      });
    }
  }
  return out;
}

/**
 * 会话日志合并：只接受「严格追加」这一种本质无冲突的情况。
 * 分叉（两边各自往后写了不同事件）不是冲突判定错误，而是真实的两个版本 ——
 * 调用方必须把它抛给用户裁决，不能自己挑一边。
 *
 * @returns {{ok:true, buf:Buffer, mode:'equal'|'ours'|'theirs'}|{ok:false, reason:string}}
 */
export function mergeSessionLog(oursBuf, theirsBuf) {
  if (oursBuf.equals(theirsBuf)) return { ok: true, buf: oursBuf, mode: 'equal' };
  const ours = decodeSessionLog(oursBuf);
  const theirs = decodeSessionLog(theirsBuf);
  if (!ours || !theirs) return { ok: false, reason: 'unreadable' };
  if (JSON.stringify(ours.header) !== JSON.stringify(theirs.header)) {
    // 表头不同（例如 cwd/agentPreset 被改过）不是行级冲突，但两边确实是不同会话根；
    // 交给用户裁决，避免把两份历史混成一份无法解码的日志。
    return { ok: false, reason: 'header-mismatch' };
  }
  const prefix = (a, b) => a.length <= b.length && a.every((row, i) => row === b[i]);
  if (prefix(ours.rows, theirs.rows)) return { ok: true, buf: theirsBuf, mode: 'theirs' };
  if (prefix(theirs.rows, ours.rows)) return { ok: true, buf: oursBuf, mode: 'ours' };
  return { ok: false, reason: 'divergent' };
}

/**
 * 把一份会话日志复制成一个新会话（新 id）。
 * 只改表头行的 id，其余事件原样保留（seq/turn/step 是格式自己的关系，重排会毁掉日志）。
 *
 * @param home   DSH HOME
 * @param src    Buffer（内存里的日志）或字符串（磁盘上的绝对路径）
 * @param newId  新会话 id
 * @param baseName 新日志的文件名；缺省沿用源文件名（如 session.v4.jsonl.zstd）
 * @returns {string|null} 新日志的绝对路径
 */
export function duplicateSessionLog(home, src, newId, baseName = null) {
  let name = baseName;
  let buf;
  if (Buffer.isBuffer(src)) {
    buf = src;
  } else {
    try { buf = fs.readFileSync(src); } catch { return null; }
    if (!name) name = path.basename(String(src));
  }
  if (!name || !SESSION_LOG_RE.test(name)) name = 'session.v4.jsonl.zstd';
  const decoded = decodeSessionLog(buf);
  if (!decoded) return null;
  const header = { ...decoded.header, id: newId };
  const rows = [JSON.stringify(header), ...decoded.rows.slice(1)];
  const text = rows.join('\n') + '\n';
  const isCompressed = buf.subarray(0, 4).equals(ZSTD_MAGIC);
  const payload = isCompressed ? zstdEncode(text) : Buffer.from(text, 'utf8');
  if (!payload) return null;
  const slug = sessionSlugFromCwd(header.cwd || '');
  const dir = path.join(home, 'sessions', slug, newId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(target, payload);
  // 投影缓存是可再生的，但复制一份能让新会话立刻带上标题；里面出现的旧 id 一并替换。
  try {
    const oldId = decoded.header.id;
    const cache = projCachePath(home, oldId);
    if (fs.existsSync(cache)) {
      const text2 = fs.readFileSync(cache, 'utf8').split(oldId).join(newId);
      const dest = projCachePath(home, newId);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text2, 'utf8');
    }
  } catch { /* 缓存复制失败不影响会话本体 */ }
  return target;
}

/** 生成一个新的合法会话 id（与 DSH 的 session-<uuid> 形式一致） */
export function newSessionId() {
  return 'session-' + randomUUID();
}

/** 消息条数粗估：用事件行数近似（不含表头），用于冲突两侧的对比展示 */
export function eventCount(rows) {
  return Array.isArray(rows) ? Math.max(0, rows.length - 1) : 0;
}
