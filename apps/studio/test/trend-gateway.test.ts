import { describe, expect, it, vi } from "vitest";
import { TrendGateway } from "../src/server/trend-gateway.js";

const NOW = "2026-08-29T12:34:56.000Z";
const HN_TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_PREFIX = "https://hacker-news.firebaseio.com/v0/item/";
const WIKIMEDIA_PREFIX =
  "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/zh.wikipedia.org/all-access/";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TrendGateway", () => {
  it("collects, filters, deduplicates, and limits signals from both sources", async () => {
    const hnIds = Array.from({ length: 13 }, (_, index) => 101 + index);
    const requestedWikiDates: string[] = [];
    const requestedHnIds: number[] = [];
    let activeHnItems = 0;
    let maxActiveHnItems = 0;

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === HN_TOPSTORIES_URL) return jsonResponse(hnIds);

      if (url.startsWith(HN_ITEM_PREFIX)) {
        const id = Number(url.slice(HN_ITEM_PREFIX.length, -".json".length));
        requestedHnIds.push(id);
        activeHnItems += 1;
        maxActiveHnItems = Math.max(maxActiveHnItems, activeHnItems);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeHnItems -= 1;
        return jsonResponse({
          id,
          type: "story",
          title: id === 101 ? "Shared launch" : `HN story ${id}`,
          url: id === 102 ? undefined : `https://news.example/${id}`,
          score: 500 - id,
        });
      }

      if (url.startsWith(WIKIMEDIA_PREFIX)) {
        const date = url.slice(WIKIMEDIA_PREFIX.length);
        requestedWikiDates.push(date);
        if (date === "2026/08/28") return jsonResponse({ error: "not found" }, 404);
        if (date === "2026/08/27") {
          return jsonResponse({
            items: [
              {
                articles: [
                  { article: "Main_Page", rank: 1, views: 1_000_000 },
                  { article: "Special:Search", rank: 2, views: 900_000 },
                  { article: "2026", rank: 3, views: 800_000 },
                  { article: "2026年8月27日", rank: 4, views: 700_000 },
                  { article: "Shared_launch", rank: 5, views: 600_000 },
                  ...Array.from({ length: 10 }, (_, index) => ({
                    article: `中文热点_${index + 1}`,
                    rank: index + 6,
                    views: 500_000 - index,
                  })),
                ],
              },
            ],
          });
        }
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({
      fetcher,
      now: () => NOW,
      timeout: 1_000,
      includeLocalSources: false,
    }).listSignals();

    expect(result.fetchedAt).toBe(NOW);
    expect(result.warnings).toEqual([]);
    expect(result.signals).toHaveLength(24);
    expect(requestedWikiDates).toEqual(["2026/08/28", "2026/08/27"]);
    expect(requestedHnIds).toEqual(hnIds);
    expect(maxActiveHnItems).toBe(13);

    expect(result.signals[0]).toEqual({
      id: "hacker-news:101",
      title: "Shared launch",
      sourceId: "hacker-news",
      sourceLabel: "Hacker News",
      platform: "hacker-news",
      url: "https://news.example/101",
      discussionUrl: "https://news.ycombinator.com/item?id=101",
      observedAt: NOW,
      timeBasis: "collected",
      rank: 1,
      heat: 399,
    });
    expect(result.signals.find((signal) => signal.id === "hacker-news:102")?.url).toBe(
      "https://news.ycombinator.com/item?id=102",
    );
    expect(result.signals.some((signal) => signal.title === "Main Page")).toBe(false);
    expect(result.signals.some((signal) => signal.title.startsWith("Special:"))).toBe(false);
    expect(result.signals.some((signal) => signal.title === "2026")).toBe(false);
    expect(result.signals.filter((signal) => signal.title === "Shared launch")).toHaveLength(2);
    expect(result.signals.some((signal) => signal.platform === "wikipedia")).toBe(true);
    expect(result.sources).toEqual([
      { id: "hacker-news", label: "Hacker News", count: 13, status: "ready" },
      { id: "wikipedia-zh", label: "中文 Wikipedia", count: 11, status: "ready" },
    ]);
  });

  it("returns the available source with a warning when one source fails", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === HN_TOPSTORIES_URL) return jsonResponse({ error: "unavailable" }, 503);
      if (url === `${WIKIMEDIA_PREFIX}2026/08/28`) {
        return jsonResponse({
          items: [
            {
              articles: [{ article: "人工智能", rank: 7, views: 123_456 }],
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({
      fetcher,
      now: () => NOW,
      timeout: 1_000,
      includeLocalSources: false,
    }).listSignals();

    expect(result.fetchedAt).toBe(NOW);
    expect(result.warnings).toEqual(["Hacker News unavailable: HTTP 503"]);
    expect(result.signals).toEqual([
      {
        id: "wikipedia:%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
        title: "人工智能",
        sourceId: "wikipedia-zh",
        sourceLabel: "中文维基百科",
        platform: "wikipedia",
        url: "https://zh.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
        observedAt: "2026-08-28T12:34:56.000Z",
        timeBasis: "source",
        rank: 7,
        heat: 123_456,
      },
    ]);
    expect(result.sources).toEqual([
      { id: "hacker-news", label: "Hacker News", count: 0, status: "unavailable" },
      { id: "wikipedia-zh", label: "中文 Wikipedia", count: 1, status: "ready" },
    ]);
  });

  it("collects Chinese hot lists and preserves the same story across platforms for clustering", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://newsnow.local/api/s")) {
        const platform = new URL(url).searchParams.get("id")!;
        return jsonResponse({
          updatedTime: Date.parse(NOW),
          items: [{ id: `${platform}-1`, title: "存量房贷利率调整", url: `https://${platform}.example/topic` }],
        });
      }
      if (url.startsWith("http://dailyhot.local/")) {
        const platform = new URL(url).pathname.slice(1);
        return jsonResponse({
          code: 200,
          updateTime: NOW,
          data: [{ id: `${platform}-1`, title: "存量房贷利率调整", url: `https://${platform}.example/topic`, hot: 88_000 }],
        });
      }
      if (url === HN_TOPSTORIES_URL) return jsonResponse({ error: "offline" }, 503);
      if (url.startsWith(WIKIMEDIA_PREFIX)) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({
      fetcher,
      now: () => NOW,
      timeout: 1_000,
      environment: {
        TOKEN_TALK_NEWSNOW_URL: "http://newsnow.local",
        TOKEN_TALK_DAILYHOT_URL: "http://dailyhot.local",
      },
    }).listSignals();

    expect(result.signals).toHaveLength(10);
    expect(new Set(result.signals.map((signal) => signal.platform)).size).toBe(10);
    expect(result.signals.every((signal) => signal.sourceId === "newsnow")).toBe(true);
    expect(result.sources.slice(0, 2)).toEqual([
      { id: "newsnow", label: "NewsNow 中文热榜", count: 10, status: "ready" },
      { id: "dailyhot", label: "DailyHot 中文热榜", count: 10, status: "ready" },
    ]);
  });

  it("marks an aggregator degraded when some configured platforms fail", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://newsnow.local/api/s")) {
        const platform = new URL(url).searchParams.get("id")!;
        if (platform === "douyin") throw new Error("connection refused");
        return jsonResponse({
          updatedTime: Date.parse(NOW),
          items: [{ id: `${platform}-1`, title: `${platform} 热点`, url: `https://${platform}.example/topic` }],
        });
      }
      if (url.startsWith("http://dailyhot.local/")) throw new Error("offline");
      if (url === HN_TOPSTORIES_URL || url.startsWith(WIKIMEDIA_PREFIX)) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({
      fetcher,
      now: () => NOW,
      timeout: 1_000,
      environment: {
        TOKEN_TALK_NEWSNOW_URL: "http://newsnow.local",
        TOKEN_TALK_DAILYHOT_URL: "http://dailyhot.local",
      },
    }).listSignals();

    expect(result.sources[0]).toMatchObject({ id: "newsnow", count: 9, status: "degraded" });
    expect(result.warnings.join(" ")).toContain("1/10 platforms unavailable: douyin");
  });

  it("marks DailyHot degraded when a platform returns a business error", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://newsnow.local/api/s")) throw new Error("offline");
      if (url.startsWith("http://dailyhot.local/")) {
        const platform = new URL(url).pathname.slice(1);
        if (platform === "douyin") return jsonResponse({ code: 500, data: [] });
        return jsonResponse({ code: 200, updateTime: NOW, data: [{ id: platform, title: `${platform} 热点`, url: `https://${platform}.example/topic` }] });
      }
      if (url === HN_TOPSTORIES_URL || url.startsWith(WIKIMEDIA_PREFIX)) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({
      fetcher,
      now: () => NOW,
      timeout: 1_000,
      environment: {
        TOKEN_TALK_NEWSNOW_URL: "http://newsnow.local",
        TOKEN_TALK_DAILYHOT_URL: "http://dailyhot.local",
      },
    }).listSignals();

    expect(result.sources.find((source) => source.id === "dailyhot")).toMatchObject({ count: 9, status: "degraded" });
    expect(result.warnings.join(" ")).toContain("1/10 platforms unavailable: douyin");
  });

  it("blocks redirects and unsafe Hacker News article protocols", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === HN_TOPSTORIES_URL) return jsonResponse([101]);
      if (url === `${HN_ITEM_PREFIX}101.json`) {
        return jsonResponse({ id: 101, type: "story", title: "Unsafe link", url: "javascript:alert(1)" });
      }
      if (url.startsWith(WIKIMEDIA_PREFIX)) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({ fetcher, now: () => NOW, includeLocalSources: false }).listSignals();

    expect(result.signals[0]?.url).toBe("https://news.ycombinator.com/item?id=101");
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  });

  it("rejects cross-origin and oversized trend responses", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === HN_TOPSTORIES_URL) {
        const response = jsonResponse([]);
        Object.defineProperty(response, "url", { value: "https://redirected.example/private" });
        return response;
      }
      if (url.startsWith(WIKIMEDIA_PREFIX)) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await new TrendGateway({ fetcher, now: () => NOW, includeLocalSources: false }).listSignals();

    expect(result.signals).toEqual([]);
    expect(result.warnings.join(" ")).toContain("crossed the configured origin");
    expect(result.warnings.join(" ")).toContain("exceeds 2097152 bytes");
  });
});
