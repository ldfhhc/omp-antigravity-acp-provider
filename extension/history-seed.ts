// Hidden history/request seed steps must only acknowledge with OK. Stop at the
// first tool/permission, a non-ACK, or a fixed per-step deadline so a looping
// model cannot keep running after Pi refuses its tools. Session-update and MCP
// callbacks must signal failure without throwing.

const ACK = "OK";
const TEXT_LIMIT = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_HINT = "Compact OMP history before retrying.";
const TOOL_REASON = `ACP history seed requested a tool or permission. ${RETRY_HINT}`;
const ACK_REASON = `ACP history seed did not acknowledge with OK. ${RETRY_HINT}`;
const DEADLINE_REASON = `ACP history seed exceeded its acknowledgement deadline. ${RETRY_HINT}`;
const DISPOSED_REASON = `ACP history seed guard was disposed. ${RETRY_HINT}`;

export class HistorySeedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistorySeedError";
  }
}

export class HistorySeedGuard {
  private readonly parent?: AbortSignal;
  private readonly timeoutMs: number;
  private buffer = "";
  private failure?: HistorySeedError;
  private child?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private detachParent?: () => void;
  private rejectInflight?: (reason: unknown) => void;
  private used = false;
  private disposed = false;

  constructor(parent?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.parent = parent;
    this.timeoutMs = timeoutMs;
  }

  get text(): string {
    return this.buffer;
  }

  appendText(delta: string): void {
    if (this.disposed || typeof delta !== "string" || delta.length === 0) return;
    const room = TEXT_LIMIT - this.buffer.length;
    if (room <= 0) return;
    this.buffer += delta.length <= room ? delta : delta.slice(0, room);
  }

  rejectTool(): void {
    this.fail(TOOL_REASON);
  }

  async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new HistorySeedError(DISPOSED_REASON);
    if (this.used) throw new HistorySeedError(`ACP history seed step already started. ${RETRY_HINT}`);
    this.used = true;

    const child = new AbortController();
    this.child = child;

    if (this.parent?.aborted) {
      this.abortChild(this.parentReason());
      throw this.parentReason();
    }
    if (this.failure) {
      this.abortChild(this.failure);
      throw this.failure;
    }

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let settled = false;
    const finish = (apply: () => void) => {
      if (settled) return;
      settled = true;
      this.rejectInflight = undefined;
      this.disarm();
      apply();
    };
    this.rejectInflight = reason => finish(() => reject(reason));

    try {
      this.arm(child);
      if (this.parent?.aborted) {
        this.signalParentAbort();
        return await promise;
      }
      if (this.failure) {
        this.abortChild(this.failure);
        finish(() => reject(this.failure));
        return await promise;
      }

      let pending: Promise<T>;
      try {
        pending = Promise.resolve(request(child.signal));
      } catch (error) {
        finish(() => reject(this.settledError() ?? error));
        return await promise;
      }
      pending.then(
        value => finish(() => {
          const error = this.settledError();
          if (error !== undefined) reject(error);
          else resolve(value);
        }),
        error => finish(() => reject(this.settledError() ?? error)),
      );
      return await promise;
    } finally {
      this.rejectInflight = undefined;
      this.disarm();
    }
  }

  assertAcknowledged(): void {
    if (this.failure) throw this.failure;
    if (this.buffer.trim() !== ACK) throw this.record(ACK_REASON);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disarm();
    const reject = this.rejectInflight;
    this.rejectInflight = undefined;
    if (this.parent?.aborted) {
      this.abortChild(this.parentReason());
      reject?.(this.parentReason());
      return;
    }
    if (this.failure) {
      this.abortChild(this.failure);
      reject?.(this.failure);
      return;
    }
    this.abortChild();
    reject?.(new HistorySeedError(DISPOSED_REASON));
  }

  private arm(child: AbortController): void {
    const parent = this.parent;
    if (parent) {
      const onAbort = () => this.signalParentAbort();
      parent.addEventListener("abort", onAbort, { once: true });
      this.detachParent = () => parent.removeEventListener("abort", onAbort);
      if (parent.aborted) onAbort();
    }
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.fail(DEADLINE_REASON);
    }, this.timeoutMs);
    timer.unref?.();
    this.timer = timer;
    if (child.signal.aborted && this.failure) this.rejectInflight?.(this.failure);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.detachParent?.();
    this.detachParent = undefined;
  }

  private fail(reason: string): void {
    if (this.disposed) return;
    if (this.parent?.aborted) {
      this.signalParentAbort();
      return;
    }
    const error = this.record(reason);
    this.abortChild(error);
    try { this.rejectInflight?.(error); } catch { /* Callbacks must not throw. */ }
  }

  private signalParentAbort(): void {
    const reason = this.parentReason();
    this.abortChild(reason);
    try { this.rejectInflight?.(reason); } catch { /* Callbacks must not throw. */ }
  }

  private abortChild(reason?: unknown): void {
    const child = this.child;
    if (!child || child.signal.aborted) return;
    try { child.abort(reason); } catch { /* Request abort listeners must not escape callbacks. */ }
  }

  private record(reason: string): HistorySeedError {
    return this.failure ??= new HistorySeedError(reason);
  }

  private settledError(): unknown {
    if (this.parent?.aborted) return this.parentReason();
    return this.failure;
  }

  private parentReason(): unknown {
    const reason = this.parent?.reason;
    if (reason !== undefined) return reason;
    return new DOMException("This operation was aborted", "AbortError");
  }
}
