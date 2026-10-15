/**
 * 通用工具：子进程执行、zstd 编解码、路径/时间/体积格式化。
 *
 * 这里只放与 DSH 无关的纯工具，方便脱离宿主单独测试（tests/ 用同一份实现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* ================= zstd ================= */

let zstdCompressSync = null;
let zstdDecompressSync = null;
try {
  const zlib = await import('node:zlib');
  zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
  zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
} catch { /* 旧 Node 没有 zstd：会话日志按不可合并处理 */ }

/** zstd 帧魔数（小端 0xFD2FB528） */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function hasZstd() {
  return typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function';
}

export function isZstd(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

/**
 * 计算从 offset 开始的第一个完整 zstd 帧的结束位置。
 * 帧结构见 zstandard 格式规范；Node 对截断帧可能返回部分输出，所以先校验分帧。
 */
export function zstdFrameEnd(buf, offset = 0) {
  if (offset + 5 > buf.length || !buf.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) throw new Error('bad-frame');
  const descriptor = buf[offset + 4];
  if (descriptor & 0x08) throw new Error('reserved-frame-bit');
  const single = Boolean(descriptor & 0x20);
  const contentSize = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  let cursor = offset + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSize;
  let last = false;
  while (!last) {
    if (cursor + 3 > buf.length) throw new Error('truncated-block-header');
    const block = buf.readUIntLE(cursor, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error('reserved-block-type');
    last = Boolean(block & 1);
    cursor += 3 + (type === 1 ? 1 : block >>> 3);
    if (cursor > buf.length) throw new Error('truncated-block');
  }
  cursor += descriptor & 0x04 ? 4 : 0;
  if (cursor > buf.length) throw new Error('truncated-checksum');
  return cursor;
}

/** 解码完整 zstd 流（可能由多个帧组成）；任一帧损坏返回 null，绝不静默丢事件。 */
export function zstdDecode(buf) {
  if (typeof zstdDecompressSync !== 'function') return null;
  if (!isZstd(buf)) return null;
  try {
    const chunks = [];
    let offset = 0;
    while (offset < buf.length) {
      // 跳过 skippable frame（magic 0x184D2A5?）
      if (offset + 8 <= buf.length && (buf.readUInt32LE(offset) & 0xfffffff0) === 0x184d2a50) {
        const end = offset + 8 + buf.readUInt32LE(offset + 4);
        if (end > buf.length) return null;
        offset = end;
        continue;
      }
      const end = zstdFrameEnd(buf, offset);
      chunks.push(zstdDecompressSync(buf.subarray(offset, end)));
      offset = end;
    }
    return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  } catch {
    return null;
  }
}

/** 压缩成单个 zstd 帧；zstd 不可用时返回 null。 */
export function zstdEncode(buf) {
  if (typeof zstdCompressSync !== 'function') return null;
  try {
    const out = zstdCompressSync(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch {
    return null;
  }
}

/**
 * 只读文件开头，解出会话日志的第一帧（表头行），避免为了一行表头把整个日志读进内存。
 * 第一次读 64KiB，不够就按 4 倍增长，直到 maxBytes。
 */
export function readFirstFrame(file, maxBytes = 4 * 1024 * 1024) {
  if (typeof zstdDecompressSync !== 'function') return null;
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    let want = 64 * 1024;
    for (;;) {
      const size = Math.min(want, maxBytes);
      const raw = Buffer.alloc(size);
      const n = fs.readSync(fd, raw, 0, size, 0);
      const buf = raw.subarray(0, n);
      try {
        const end = zstdFrameEnd(buf, 0);
        return zstdDecompressSync(buf.subarray(0, end));
      } catch {
        if (n < size || size >= maxBytes) return null;
        want = size * 4;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/* ================= 子进程 ================= */

/**
 * 执行一条外部命令，永远 resolve（不抛），返回 { code, out, err }。
 *  - binary=true  → out 为 Buffer
 *  - onStderr     → 每收到一段 stderr 就回调（用于 git --progress 的实时进度）
 *  - missing      → 命中 ENOENT 时置 true（用于识别未安装 git/gh）
 *  - stdin        → 写进子进程的标准输入后关闭（git hash-object --stdin 用）
 */
export function run(cmd, args, {
  cwd = undefined,
  env = undefined,
  timeoutMs = 120000,
  binary = false,
  onStderr = null,
  stdin = null,
} = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let err = '';
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: binary ? Buffer.alloc(0) : '', err: String(e?.message || e), missing: true });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }, Math.max(1000, timeoutMs));
    // 永远把 stdin 关掉：既喂给 hash-object，也避免子进程等一个永远不来的 EOF
    try {
      if (stdin !== null && stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    } catch { /* 子进程可能已经退出 */ }
    child.stdout?.on('data', (d) => { chunks.push(d); });
    child.stderr?.on('data', (d) => { err += d.toString(); if (onStderr) { try { onStderr(d.toString()); } catch { /* ignore */ } } });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = String(e?.message || e);
      resolve({ code: -1, out: binary ? Buffer.alloc(0) : chunks.map(String).join(''), err: msg, missing: e?.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: binary ? Buffer.concat(chunks) : chunks.map(String).join(''), err: err + (code === null ? '\n(killed: timeout)' : '') });
    });
  });
}

/* ================= 格式化 ================= */

export function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
}

/** 文件/分支名安全的时间戳，如 2026-10-15T21-40-02 */
export function ts(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 归一化相对路径：统一分隔符、去掉前导 ./ 与 / */
export function normRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/{2,}/g, '/');
}

/** 把绝对路径转成相对 home 的 posix 相对路径；不在 home 下返回 null */
export function relTo(home, abs) {
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return normRel(rel);
}

export function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim()) || '';
}

/** 截断长文本，用于日志/摘要 */
export function clip(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
