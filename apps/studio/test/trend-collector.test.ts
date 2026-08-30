import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateInbox } from "../src/server/candidate-studio.js";
import { TrendCollector } from "../src/server/trend-collector.js";

const NOW = "2026-08-29T01:00:00.000Z";
const INTERVAL_MS = 1_000;

describe("TrendCollector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects on the server cadence and schedules the next successful attempt", async () => {
    const collect = vi.fn(async () => currentInbox());
    const collector = createCollector(collect);

    collector.start();

    expect(collector.status()).toMatchObject({
      state: "scheduled",
      cadenceSeconds: 1,
      consecutiveFailures: 0,
      nextAttemptAt: "2026-08-29T01:00:01.000Z",
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(collector.status()).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
      lastAttemptAt: NOW,
      lastSuccessfulAt: NOW,
      nextAttemptAt: "2026-08-29T01:00:02.000Z",
    });
    await collector.close();
  });

  it("backs off after failures and preserves the last successful collection", async () => {
    const collect = vi.fn<() => Promise<CandidateInbox>>()
      .mockResolvedValueOnce(currentInbox())
      .mockRejectedValueOnce(new Error("source timeout"))
      .mockResolvedValueOnce(currentInbox("2026-08-29T01:00:04.000Z"));
    const collector = createCollector(collect);
    collector.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(collector.status()).toMatchObject({
      state: "error",
      consecutiveFailures: 1,
      lastSuccessfulAt: NOW,
      message: "source timeout",
      nextAttemptAt: "2026-08-29T01:00:04.000Z",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(collect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(collect).toHaveBeenCalledTimes(3);
    expect(collector.status()).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
      lastSuccessfulAt: "2026-08-29T01:00:04.000Z",
    });
    await collector.close();
  });

  it("coalesces overlapping collection requests", async () => {
    let resolveCollection: ((value: CandidateInbox) => void) | undefined;
    const collect = vi.fn(() => new Promise<CandidateInbox>((resolve) => {
      resolveCollection = resolve;
    }));
    const collector = createCollector(collect);

    const first = collector.collectNow();
    const second = collector.collectNow();

    expect(collect).toHaveBeenCalledTimes(1);
    expect(collector.status().state).toBe("collecting");
    resolveCollection?.(currentInbox());
    await Promise.all([first, second]);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(collector.status().state).toBe("ready");
    await collector.close();
  });

  it("cancels scheduled collection when the service closes", async () => {
    const collect = vi.fn(async () => currentInbox());
    const collector = createCollector(collect);
    collector.start();

    await collector.close();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(collect).not.toHaveBeenCalled();
    expect(collector.status()).toMatchObject({ state: "stopped", nextAttemptAt: undefined });
  });

  it("waits for an active collection before completing shutdown and does not reschedule it", async () => {
    let resolveCollection: ((value: CandidateInbox) => void) | undefined;
    const collect = vi.fn(() => new Promise<CandidateInbox>((resolve) => {
      resolveCollection = resolve;
    }));
    const collector = createCollector(collect);
    const collection = collector.collectNow();
    let closed = false;

    const closing = collector.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveCollection?.(currentInbox());
    await Promise.all([collection, closing]);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(closed).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collector.status()).toMatchObject({ state: "stopped", nextAttemptAt: undefined });
  });
});

function createCollector(collect: () => Promise<CandidateInbox>): TrendCollector {
  return new TrendCollector(collect, {
    intervalMs: INTERVAL_MS,
    maxBackoffMs: 8_000,
    now: () => new Date().toISOString(),
  });
}

function currentInbox(fetchedAt = NOW): CandidateInbox {
  return {
    items: [],
    fetchedAt,
    sources: [{ id: "source", label: "Test source", count: 1, status: "ready" }],
    warnings: [],
    freshness: { status: "current", lastSuccessfulAt: fetchedAt },
  };
}
