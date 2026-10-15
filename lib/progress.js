/**
 * 运行日志（过程可见性的核心）。
 *
 * 每次 push/pull 都是一个 Run：引擎把每一步写进带序号的环形缓冲，
 * 浏览器按 `since` 增量拉取，所以过程是「流式可见」的，而不是结束后一句话。
 */

const DEFAULT_LIMIT = 4000;

export class ProgressLog {
  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
    this.entries = [];
    this.next = 1;
  }

  /**
   * 追加一条。
   * @param {'info'|'done'|'warn'|'error'|'step'} level
   * @param {string} stage  机器可读阶段名（fetch/merge/push/ws…）
   * @param {string} text   给人看的一行
   * @param {object} [extra] 附加结构化信息（如 { files: 3 }）
   */
  push(level, stage, text, extra = undefined) {
    const entry = { n: this.next++, t: Date.now(), level, stage, text: String(text) };
    if (extra && typeof extra === 'object') entry.extra = extra;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return entry;
  }

  info(stage, text, extra) { return this.push('info', stage, text, extra); }
  step(stage, text, extra) { return this.push('step', stage, text, extra); }
  warn(stage, text, extra) { return this.push('warn', stage, text, extra); }
  error(stage, text, extra) { return this.push('error', stage, text, extra); }
  done(stage, text, extra) { return this.push('done', stage, text, extra); }

  /** 序号大于 n 的条目（增量拉取） */
  since(n) {
    const from = Number(n) || 0;
    return this.entries.filter((e) => e.n > from);
  }

  /** 最后一条（用于「当前正在做什么」） */
  last() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  all() {
    return this.entries.slice();
  }

  clear() {
    this.entries = [];
    this.next = 1;
  }
}

/**
 * 一次操作（push 或 pull）的运行状态。
 * 同一个 Run 既服务 /api/progress 的轮询，也服务同步等待的 agent 工具。
 */
export class RunState {
  constructor({ runId, direction, scope, reason }) {
    this.runId = runId;
    this.direction = direction;   // 'push' | 'pull'
    this.scope = scope;           // 'session' | 'all'
    this.reason = reason || '';
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.running = true;
    this.result = null;           // 完成后的汇总对象
    this.error = null;
    this.progress = new ProgressLog();
  }

  get durationMs() {
    return (this.finishedAt || Date.now()) - this.startedAt;
  }

  summary() {
    return {
      runId: this.runId,
      direction: this.direction,
      scope: this.scope,
      reason: this.reason,
      running: this.running,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt || null,
      durationMs: this.durationMs,
      error: this.error,
      last: this.progress.last(),
      result: this.result,
    };
  }
}
