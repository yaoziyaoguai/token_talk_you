import type { CandidateInbox } from "./candidate-studio.js";

export type TrendCollectorState = "scheduled" | "collecting" | "ready" | "degraded" | "error" | "stopped";

export interface TrendCollectorStatus {
  state: TrendCollectorState;
  refreshing?: boolean | undefined;
  cadenceSeconds: number;
  consecutiveFailures: number;
  nextAttemptAt?: string | undefined;
  lastAttemptAt?: string | undefined;
  lastSuccessfulAt?: string | undefined;
  message?: string | undefined;
}

interface TrendCollectorOptions {
  intervalMs?: number;
  maxBackoffMs?: number;
  now?: () => string;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;

export class TrendCollector {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private current: TrendCollectorStatus;

  constructor(
    private readonly collect: () => Promise<CandidateInbox>,
    options: TrendCollectorOptions = {},
  ) {
    this.intervalMs = positiveMilliseconds(options.intervalMs ?? DEFAULT_INTERVAL_MS, "trend collection interval");
    this.maxBackoffMs = Math.max(this.intervalMs, positiveMilliseconds(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "trend collection backoff"));
    this.now = options.now ?? (() => new Date().toISOString());
    this.current = {
      state: "scheduled",
      cadenceSeconds: Math.max(1, Math.ceil(this.intervalMs / 1_000)),
      consecutiveFailures: 0,
    };
  }

  start(): void {
    if (this.closed || this.timer || this.inFlight) return;
    this.schedule(this.intervalMs);
  }

  status(): TrendCollectorStatus {
    return { ...this.current };
  }

  async settleCurrentCollection(): Promise<void> {
    await this.inFlight;
  }

  observe(inbox: CandidateInbox): void {
    const degraded = inbox.freshness.status === "fallback" || !inbox.sources.some((source) => source.status === "ready");
    if (degraded) {
      this.current = {
        ...this.current,
        state: "degraded",
        refreshing: false,
        consecutiveFailures: this.current.consecutiveFailures + 1,
        lastAttemptAt: inbox.freshness.attemptedAt ?? inbox.fetchedAt,
        lastSuccessfulAt: inbox.freshness.lastSuccessfulAt,
        message: inbox.warnings.at(-1) ?? "本轮热点采集未获得可用信号。",
      };
      return;
    }
    this.current = {
      ...this.current,
      state: "ready",
      refreshing: false,
      consecutiveFailures: 0,
      lastAttemptAt: inbox.fetchedAt,
      lastSuccessfulAt: inbox.freshness.lastSuccessfulAt,
      message: undefined,
    };
  }

  async collectNow(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight) return this.inFlight;
    this.clearScheduledTimer();
    const lastSuccessfulAt = this.current.lastSuccessfulAt;
    this.current = {
      ...this.current,
      // 有可用缓存时继续展示最后一次可信结果，避免后台刷新让首页闪成“采集中”。
      state: lastSuccessfulAt ? this.current.state === "ready" ? "ready" : "degraded" : "collecting",
      refreshing: true,
      lastAttemptAt: this.now(),
      nextAttemptAt: undefined,
      message: undefined,
    };
    const task = (async () => {
      try {
        this.observe(await this.collect());
      } catch (error) {
        this.current = {
          ...this.current,
          state: "error",
          refreshing: false,
          consecutiveFailures: this.current.consecutiveFailures + 1,
          lastSuccessfulAt,
          message: error instanceof Error ? error.message : "热点采集失败",
        };
      }
    })().finally(() => {
      this.inFlight = undefined;
      if (!this.closed) this.schedule(this.nextDelayMs());
    });
    this.inFlight = task;
    await task;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearScheduledTimer();
    await this.inFlight;
    this.current = { ...this.current, state: "stopped", refreshing: false, nextAttemptAt: undefined };
  }

  private nextDelayMs(): number {
    if (this.current.consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.min(10, this.current.consecutiveFailures));
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.current = {
      ...this.current,
      nextAttemptAt: new Date(Date.parse(this.now()) + delayMs).toISOString(),
    };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.collectNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearScheduledTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function positiveMilliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return Math.max(1, Math.round(value));
}
