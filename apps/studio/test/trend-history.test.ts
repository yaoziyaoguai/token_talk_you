import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrendHistoryStore } from "../src/server/trend-history.js";
import type { TrendFeed } from "../src/server/trend-gateway.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "token-talk-trends-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("TrendHistoryStore", () => {
  it("persists immutable snapshots and derives movement only from a real previous rank", async () => {
    const firstStore = new TrendHistoryStore(root);
    const first = await firstStore.capture(feed("2026-08-29T01:00:00.000Z", [
      signal("weibo-ai", "AI 助手进入办公软件", "weibo", 8),
    ]));

    expect(first.signals[0]?.momentum).toEqual({ state: "unknown" });

    const second = await firstStore.capture(feed("2026-08-29T01:05:00.000Z", [
      signal("weibo-ai-next", "AI助手进入办公软件", "weibo", 3),
      signal("zhihu-audio", "AI 播客开始流行", "zhihu", 6),
    ]));

    expect(second.signals[0]?.momentum).toEqual({
      state: "rising",
      rankDelta: 5,
      previousRank: 8,
      comparedAt: "2026-08-29T01:00:00.000Z",
    });
    expect(second.signals[1]?.momentum).toEqual({
      state: "new",
      comparedAt: "2026-08-29T01:00:00.000Z",
    });

    const restartedStore = new TrendHistoryStore(root);
    const third = await restartedStore.capture(feed("2026-08-29T01:10:00.000Z", [
      signal("weibo-ai-third", "AI 助手进入办公软件", "weibo", 4),
    ]));

    expect(third.signals[0]?.momentum).toEqual({
      state: "steady",
      rankDelta: -1,
      previousRank: 3,
      comparedAt: "2026-08-29T01:05:00.000Z",
    });
    expect(await readdir(join(root, "trends", "snapshots"))).toHaveLength(3);
  });

  it("does not label a recovered source signal as new after an outage", async () => {
    const store = new TrendHistoryStore(root);
    await store.capture(feedWithStatus("2026-08-29T01:00:00.000Z", [
      signal("weibo-old", "上一轮话题", "weibo", 2),
    ], "ready"));
    await store.capture(feedWithStatus("2026-08-29T01:05:00.000Z", [], "unavailable"));
    const recovered = await store.capture(feedWithStatus("2026-08-29T01:10:00.000Z", [
      signal("weibo-recovered", "恢复后的新话题", "weibo", 1),
    ], "ready"));

    expect(recovered.signals[0]?.momentum).toEqual({
      state: "unknown",
      comparedAt: "2026-08-29T01:05:00.000Z",
    });
  });
});

function feed(fetchedAt: string, signals: TrendFeed["signals"]): TrendFeed {
  return {
    signals,
    fetchedAt,
    sources: [{ id: "test", label: "测试热榜", count: signals.length, status: "ready" }],
    warnings: [],
  };
}

function feedWithStatus(fetchedAt: string, signals: TrendFeed["signals"], status: "ready" | "degraded" | "unavailable"): TrendFeed {
  return {
    signals,
    fetchedAt,
    sources: [{ id: "test", label: "测试热榜", count: signals.length, status }],
    warnings: status === "ready" ? [] : ["source unavailable"],
  };
}

function signal(id: string, title: string, platform: string, rank: number): TrendFeed["signals"][number] {
  return {
    id,
    title,
    sourceId: "test",
    sourceLabel: "测试热榜",
    platform,
    url: `https://example.com/${id}`,
    observedAt: "2026-08-29T01:00:00.000Z",
    timeBasis: "source",
    rank,
  };
}
