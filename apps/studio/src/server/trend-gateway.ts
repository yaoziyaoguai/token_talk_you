import { createHash } from "node:crypto";
import { readBoundedJson } from "./bounded-json.js";

export interface RawTrendSignal {
  id: string;
  title: string;
  sourceId: string;
  sourceLabel: string;
  platform: string;
  url: string;
  observedAt: string;
  timeBasis?: "source" | "collected";
  rank: number;
  heat?: number;
  discussionUrl?: string;
  momentum?: TrendMomentum;
}

export interface TrendMomentum {
  state: "unknown" | "new" | "rising" | "steady" | "falling" | "mixed";
  rankDelta?: number;
  previousRank?: number;
  comparedAt?: string;
}

export interface TrendSourceStatus {
  id: string;
  label: string;
  count: number;
  status: "ready" | "degraded" | "unavailable";
}

export interface TrendFeed {
  signals: RawTrendSignal[];
  sources: TrendSourceStatus[];
  warnings: string[];
  fetchedAt: string;
}

export interface TrendGatewayOptions {
  fetcher?: typeof fetch;
  now?: () => string;
  timeout?: number;
  environment?: NodeJS.ProcessEnv;
  includeLocalSources?: boolean;
}

const HN_TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item";
const WIKIMEDIA_TOP_URL =
  "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/zh.wikipedia.org/all-access";
const DEFAULT_HOT_PLATFORMS = [
  "weibo",
  "baidu",
  "zhihu",
  "bilibili",
  "36kr",
  "ithome",
  "sspai",
  "thepaper",
  "douyin",
  "toutiao",
];
const HN_ITEM_LIMIT = 16;
const HOT_ITEM_LIMIT = 12;
const SIGNAL_LIMIT = 180;
const DEFAULT_TIMEOUT = 8_000;
const MAX_TREND_RESPONSE_BYTES = 2 * 1024 * 1024;

interface Collector {
  id: string;
  label: string;
  collect: (observedAt: string) => Promise<CollectorOutput>;
}

interface CollectorOutput {
  signals: RawTrendSignal[];
  warnings: string[];
}

export class TrendGateway {
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  private readonly timeout: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly includeLocalSources: boolean;

  constructor(options: TrendGatewayOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.environment = options.environment ?? process.env;
    this.includeLocalSources = options.includeLocalSources ?? true;
  }

  async listSignals(): Promise<TrendFeed> {
    const fetchedAt = this.now();
    const collectors: Collector[] = [
      ...(this.includeLocalSources ? [
        {
          id: "newsnow",
          label: "NewsNow 中文热榜",
          collect: (observedAt: string) => this.listNewsNow(observedAt),
        },
        {
          id: "dailyhot",
          label: "DailyHot 中文热榜",
          collect: (observedAt: string) => this.listDailyHot(observedAt),
        },
      ] : []),
      {
        id: "hacker-news",
        label: "Hacker News",
        collect: async (observedAt) => ({ signals: await this.listHackerNews(observedAt), warnings: [] }),
      },
      {
        id: "wikipedia-zh",
        label: "中文 Wikipedia",
        collect: async (observedAt) => ({ signals: await this.listWikipedia(observedAt), warnings: [] }),
      },
    ];
    const settled = await Promise.allSettled(
      collectors.map((collector) => collector.collect(fetchedAt)),
    );
    const warnings: string[] = [];
    const sources: TrendSourceStatus[] = [];
    const signals: RawTrendSignal[] = [];

    settled.forEach((result, index) => {
      const collector = collectors[index]!;
      if (result.status === "fulfilled" && result.value.signals.length > 0) {
        signals.push(...result.value.signals);
        warnings.push(...result.value.warnings.map((warning) => `${collector.label} degraded: ${warning}`));
        sources.push({
          id: collector.id,
          label: collector.label,
          count: result.value.signals.length,
          status: result.value.warnings.length > 0 ? "degraded" : "ready",
        });
        return;
      }
      const reason = result.status === "rejected" ? errorMessage(result.reason) : "no signals";
      warnings.push(`${collector.label} unavailable: ${reason}`);
      sources.push({ id: collector.id, label: collector.label, count: 0, status: "unavailable" });
    });

    return {
      signals: selectSignalPortfolio(deduplicate(signals), SIGNAL_LIMIT),
      sources,
      warnings,
      fetchedAt,
    };
  }

  private async listNewsNow(fallbackObservedAt: string): Promise<CollectorOutput> {
    const baseUrl = configuredUrl(
      this.environment.TOKEN_TALK_NEWSNOW_URL,
      "http://127.0.0.1:4444",
    );
    return this.listHotPlatforms(async (platform) => {
      const url = new URL("/api/s", baseUrl);
      url.searchParams.set("id", platform);
      const payload = await this.fetchJson(url.toString());
      if (!isRecord(payload) || !Array.isArray(payload.items)) {
        throw new Error(`invalid ${platform} response`);
      }
      const observed = timestamp(payload.updatedTime, fallbackObservedAt);
      return payload.items.slice(0, HOT_ITEM_LIMIT).flatMap((value, index) => {
        if (!isRecord(value) || typeof value.title !== "string" || value.title.trim() === "") return [];
        const link = externalHttpUrl(value.url) ?? externalHttpUrl(value.mobileUrl);
        if (!link) return [];
        return [{
          id: signalId("newsnow", platform, value.id ?? value.title),
          title: value.title.trim(),
          sourceId: "newsnow",
          sourceLabel: "NewsNow",
          platform,
          url: link,
          observedAt: observed.value,
          timeBasis: observed.basis,
          rank: index + 1,
        }];
      });
    }, "NewsNow");
  }

  private async listDailyHot(fallbackObservedAt: string): Promise<CollectorOutput> {
    const baseUrl = configuredUrl(
      this.environment.TOKEN_TALK_DAILYHOT_URL,
      "http://127.0.0.1:6688",
    );
    return this.listHotPlatforms(async (platform) => {
      const payload = await this.fetchJson(new URL(`/${platform}`, baseUrl).toString());
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error(`invalid ${platform} response`);
      }
      if (payload.code !== undefined && Number(payload.code) !== 200) {
        throw new Error(`${platform} business error ${String(payload.code)}`);
      }
      const observed = timestamp(payload.updateTime, fallbackObservedAt);
      return payload.data.slice(0, HOT_ITEM_LIMIT).flatMap((value, index) => {
        if (!isRecord(value) || typeof value.title !== "string" || value.title.trim() === "") return [];
        const link = externalHttpUrl(value.url) ?? externalHttpUrl(value.mobileUrl);
        if (!link) return [];
        const signal: RawTrendSignal = {
          id: signalId("dailyhot", platform, value.id ?? value.title),
          title: value.title.trim(),
          sourceId: "dailyhot",
          sourceLabel: "DailyHot",
          platform,
          url: link,
          observedAt: observed.value,
          timeBasis: observed.basis,
          rank: index + 1,
        };
        const heat = finiteNumber(value.hot);
        if (heat !== undefined) signal.heat = heat;
        return [signal];
      });
    }, "DailyHot");
  }

  private async listHotPlatforms(
    read: (platform: string) => Promise<RawTrendSignal[]>,
    sourceLabel: string,
  ): Promise<CollectorOutput> {
    const settled = await Promise.allSettled(DEFAULT_HOT_PLATFORMS.map(read));
    const signals = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (signals.length === 0) throw new Error(`${sourceLabel} returned no platform signals`);
    const failedPlatforms = settled.flatMap((result, index) =>
      result.status === "rejected" ? [DEFAULT_HOT_PLATFORMS[index] ?? `platform-${index + 1}`] : [],
    );
    return {
      signals,
      warnings: failedPlatforms.length > 0 ? [`${failedPlatforms.length}/${DEFAULT_HOT_PLATFORMS.length} platforms unavailable: ${failedPlatforms.join(", ")}`] : [],
    };
  }

  private async listHackerNews(observedAt: string): Promise<RawTrendSignal[]> {
    const payload = await this.fetchJson(HN_TOPSTORIES_URL);
    if (!Array.isArray(payload)) throw new Error("invalid topstories response");

    const ids = payload
      .filter((id): id is number => Number.isInteger(id))
      .slice(0, HN_ITEM_LIMIT);
    const items = await Promise.allSettled(
      ids.map((id) => this.fetchJson(`${HN_ITEM_URL}/${id}.json`)),
    );

    if (items.length > 0 && items.every((item) => item.status === "rejected")) {
      throw new Error("all item requests failed");
    }

    return items.flatMap((result, index) => {
      if (result.status === "rejected") return [];
      const item = result.value;
      if (
        !isRecord(item) ||
        item.type !== "story" ||
        item.deleted === true ||
        item.dead === true ||
        !Number.isInteger(item.id) ||
        typeof item.title !== "string" ||
        item.title.trim() === ""
      ) {
        return [];
      }

      const sourceId = String(item.id);
      const discussionUrl = `https://news.ycombinator.com/item?id=${sourceId}`;
      const itemObservedAt = typeof item.time === "number" && Number.isFinite(item.time)
        ? new Date(item.time * 1_000).toISOString()
        : observedAt;
      const signal: RawTrendSignal = {
        id: `hacker-news:${sourceId}`,
        title: item.title.trim(),
        sourceId: "hacker-news",
        sourceLabel: "Hacker News",
        platform: "hacker-news",
        url: externalHttpUrl(item.url) ?? discussionUrl,
        discussionUrl,
        observedAt: itemObservedAt,
        timeBasis: typeof item.time === "number" && Number.isFinite(item.time) ? "source" : "collected",
        rank: index + 1,
      };
      if (typeof item.score === "number" && Number.isFinite(item.score)) signal.heat = item.score;
      return [signal];
    });
  }

  private async listWikipedia(observedAt: string): Promise<RawTrendSignal[]> {
    const baseDate = new Date(observedAt);
    if (Number.isNaN(baseDate.getTime())) throw new Error("invalid current time");

    let lastError: unknown;
    for (let daysAgo = 1; daysAgo <= 2; daysAgo += 1) {
      const date = new Date(baseDate.getTime() - daysAgo * 24 * 60 * 60 * 1_000);
      const datePath = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
      ].join("/");

      try {
        const payload = await this.fetchJson(`${WIKIMEDIA_TOP_URL}/${datePath}`);
        const signals = parseWikipediaSignals(payload, date.toISOString());
        if (signals.length === 0) throw new Error("no valuable pageview entries");
        return signals;
      } catch (error) {
        lastError = error;
        if (errorMessage(error).includes("timed out")) break;
      }
    }

    throw new Error(`no recent pageview data: ${errorMessage(lastError)}`);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const requestUrl = new URL(url);
    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") throw new Error("trend source must use HTTP(S)");
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`request timed out after ${this.timeout}ms`));
      }, this.timeout);
    });

    try {
      const response = await Promise.race([
        this.fetcher(url, {
          redirect: "error",
          headers: {
            accept: "application/json",
            "user-agent": "TokenTalkStudio/0.1 (trend-gateway)",
          },
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (response.url && new URL(response.url).origin !== requestUrl.origin) {
        throw new Error("trend response crossed the configured origin");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await Promise.race([readBoundedJson(response, MAX_TREND_RESPONSE_BYTES, "trend source"), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}

function parseWikipediaSignals(payload: unknown, observedAt: string): RawTrendSignal[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error("invalid pageview response");
  const articles = payload.items.flatMap((item) =>
    isRecord(item) && Array.isArray(item.articles) ? item.articles : [],
  );
  if (articles.length === 0) throw new Error("invalid pageview response");

  return articles.flatMap((value) => {
    if (!isRecord(value) || typeof value.article !== "string" || typeof value.rank !== "number" || !Number.isInteger(value.rank)) return [];
    const title = decodeArticleTitle(value.article);
    if (isLowValueWikipediaTitle(title)) return [];
    const signal: RawTrendSignal = {
      id: `wikipedia:${encodeURIComponent(title)}`,
      title,
      sourceId: "wikipedia-zh",
      sourceLabel: "中文维基百科",
      platform: "wikipedia",
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
      observedAt,
      timeBasis: "source",
      rank: value.rank,
    };
    if (typeof value.views === "number" && Number.isFinite(value.views)) signal.heat = value.views;
    return [signal];
  }).slice(0, 30);
}

function decodeArticleTitle(article: string): string {
  let decoded = article;
  try {
    decoded = decodeURIComponent(article);
  } catch {
    // Wikimedia 偶尔会返回不完整转义，保留原始标题仍比丢弃整批数据更有价值。
  }
  return decoded.replaceAll("_", " ").trim();
}

function isLowValueWikipediaTitle(title: string): boolean {
  const normalized = title.normalize("NFKC").trim();
  if (normalized === "" || normalized === "-" || /^main page$/i.test(normalized)) return true;
  if (/^(?:special|wikipedia|file|category|template|help|portal|特殊|维基百科|維基百科|文件|檔案|分类|分類|模板|帮助|幫助|主题|主題)[:：]/i.test(normalized)) return true;
  if (/^\d{4}年?$/.test(normalized)) return true;
  if (/^\d{4}年\d{1,2}月(?:\d{1,2}日)?$/.test(normalized)) return true;
  if (/^\d{1,2}月\d{1,2}日$/.test(normalized)) return true;
  if (/^\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(normalized)) return true;
  return /^(?:(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}|\d{1,2} (?:january|february|march|april|may|june|july|august|september|october|november|december))$/i.test(normalized);
}

function deduplicate(signals: RawTrendSignal[]): RawTrendSignal[] {
  const ids = new Set<string>();
  const platformTitles = new Set<string>();
  const urls = new Set<string>();
  return [...signals]
    .sort((left, right) => sourcePriority(left.sourceId) - sourcePriority(right.sourceId) || left.rank - right.rank)
    .filter((signal) => {
      const platformTitle = `${signal.platform}:${normalizedTitle(signal.title)}`;
      const url = signal.url.toLocaleLowerCase().replace(/\/$/, "");
      if (ids.has(signal.id) || platformTitles.has(platformTitle) || urls.has(url)) return false;
      ids.add(signal.id);
      platformTitles.add(platformTitle);
      urls.add(url);
      return true;
    });
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]/gu, "");
}

function sourcePriority(sourceId: string): number {
  if (sourceId === "newsnow") return 0;
  if (sourceId === "dailyhot") return 1;
  if (sourceId === "hacker-news") return 2;
  return 3;
}

function selectSignalPortfolio(signals: RawTrendSignal[], limit: number): RawTrendSignal[] {
  const queues = new Map<string, RawTrendSignal[]>();
  for (const signal of signals) {
    const key = `${signal.sourceId}:${signal.platform}`;
    const queue = queues.get(key) ?? [];
    queue.push(signal);
    queues.set(key, queue);
  }
  const selected: RawTrendSignal[] = [];
  const orderedQueues = [...queues.values()];
  while (selected.length < limit && orderedQueues.some((queue) => queue.length > 0)) {
    for (const queue of orderedQueues) {
      const signal = queue.shift();
      if (signal) selected.push(signal);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function configuredUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/$/, "");
}

function signalId(source: string, platform: string, value: unknown): string {
  const digest = createHash("sha1").update(`${platform}:${String(value)}`).digest("hex").slice(0, 14);
  return `${source}:${platform}:${digest}`;
}

function timestamp(value: unknown, fallback: string): { value: string; basis: "source" | "collected" } {
  const parsed = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
  if (parsed && !Number.isNaN(parsed.getTime())) return { value: parsed.toISOString(), basis: "source" };
  return { value: fallback, basis: "collected" };
}

function externalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
