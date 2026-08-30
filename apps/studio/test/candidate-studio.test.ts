import { createSeedSnapshot } from "@token-talk/domain";
import { describe, expect, it, vi } from "vitest";
import { CandidateStudio } from "../src/server/candidate-studio.js";
import type { PodcastEditorialModel } from "../src/server/editorial-model.js";
import type { RawTrendSignal, TrendFeed } from "../src/server/trend-gateway.js";

const NOW = "2026-08-29T01:00:00.000Z";

describe("CandidateStudio", () => {
  it("returns series ideas within the response budget while slow trend sources continue in the background", async () => {
    const listSignals = vi.fn(() => new Promise<TrendFeed>(() => undefined));
    const snapshot = createSeedSnapshot(NOW);
    const studio = new CandidateStudio({ gateway: { listSignals }, model: null, now: () => new Date(NOW) });

    const result = await studio.listResponsive(snapshot, true, 5);

    expect(result.items.some((item) => item.origin === "series")).toBe(true);
    expect(result.items.some((item) => item.origin === "trend")).toBe(false);
    expect(result.freshness.status).toBe("fallback");
    expect(result.warnings.join(" ")).toContain("后台采集");
    expect(listSignals).toHaveBeenCalledOnce();
  });

  it("caches a completed empty trend snapshot instead of returning to fallback", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const listSignals = vi.fn(async () => ({
      signals: [],
      fetchedAt: NOW,
      warnings: [],
      sources: [{ id: "quiet-source", label: "Quiet source", count: 0, status: "ready" as const }],
    }));
    const studio = new CandidateStudio({ gateway: { listSignals }, model: null, now: () => new Date(NOW) });

    const collected = await studio.list(snapshot, true);
    const refreshed = await studio.list(snapshot, true);
    const cached = studio.readCached(snapshot);

    expect(collected.items.some((item) => item.origin === "trend")).toBe(false);
    expect(refreshed.freshness.status).toBe("current");
    expect(cached.freshness.status).toBe("current");
    expect(cached.sources).toEqual([{ id: "quiet-source", label: "Quiet source", count: 0, status: "ready" }]);
    expect(listSignals).toHaveBeenCalledTimes(2);
  });

  it("keeps each series proposal identity stable when another proposal is adopted", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const studio = new CandidateStudio({ gateway: gateway([]), model: null, now: () => new Date(NOW) });
    const first = await studio.list(snapshot, true);
    const seriesCandidates = first.items.filter((item) => item.origin === "series");
    const adopted = seriesCandidates[0];
    const untouched = seriesCandidates[1];
    if (!adopted || !untouched) throw new Error("series candidates missing");
    snapshot.opportunities.unshift({
      id: "opportunity-series-stability",
      candidateId: adopted.id,
      title: adopted.title,
      origin: adopted.origin,
      verdict: adopted.verdict,
      evidence: adopted.evidence,
      candidate: adopted,
      adoptedAt: NOW,
      status: "adopted",
    });

    const refreshed = await studio.list(snapshot, false);
    const sameProposal = refreshed.items.find((item) => item.title === untouched.title);
    expect(sameProposal?.id).toBe(untouched.id);
    expect(sameProposal?.episodeNumber).toBe((untouched.episodeNumber ?? 0) + 1);
  });

  it("clusters cross-platform signals and lets the local AI editor shape a grounded podcast pitch", async () => {
    const signals = [
      signal("newsnow:weibo:mortgage", "存量房贷利率调整", "weibo", 1),
      signal("newsnow:baidu:mortgage", "存量房贷利率调整影响月供", "baidu", 3),
      signal("hacker-news:htmx", "Htmx 4.0.0", "hacker-news", 1),
    ];
    const model: PodcastEditorialModel = {
      id: "test-editor",
      async generate() {
        return [{
          signalId: "newsnow:weibo:mortgage",
          title: "房贷利率再调整：省下的钱和没有改变的压力",
          hook: "月供下降是好消息，但它能改变家庭的长期选择吗？",
          whyNow: "多个中文平台同时出现房贷调整讨论。",
          centralQuestion: "利率变化真正改变了谁的现金流和住房选择？",
          listenerPromise: "听完能看懂月供、收入预期和住房决策之间的关系。",
          selectionReasons: ["影响大量家庭", "存在短期收益与长期压力的分歧"],
          suggestedRoles: ["家庭财务观察者", "住房政策研究者", "普通购房者视角"],
          verdict: "deep_discussion",
          audienceRelevance: 92,
          conversationPotential: 94,
          longformDepth: 88,
          seriesFit: 82,
        }];
      },
    };
    const studio = new CandidateStudio({ gateway: gateway(signals), model, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const mortgage = result.items.find((candidate) => candidate.title.includes("省下的钱"));
    const release = result.items.find((candidate) => candidate.title.includes("Htmx"));

    expect(mortgage?.editorial).toMatchObject({
      provider: "local_ai",
      signalCount: 2,
      signalPlatforms: ["weibo", "baidu"],
    });
    expect(mortgage?.verdict).toBe("deep_discussion");
    expect(mortgage?.verification.independentSources).toBe(0);
    expect(mortgage?.verification.reason).toContain("平台发现信号");
    expect(mortgage?.score.evidenceDepth).toBe(0);
    expect(mortgage?.suggestedRoles).toEqual(["家庭财务观察者", "住房政策研究者", "普通购房者视角"]);
    expect(release?.verdict).toBe("skip");
    expect(mortgage!.score.overall).toBeGreaterThan(release!.score.overall);
  });

  it("forces high-risk events into fact research and rejects unsupported model numbers in titles", async () => {
    const signals = [signal("newsnow:weibo:flood", "尼泊尔山洪救援持续", "weibo", 2)];
    const model: PodcastEditorialModel = {
      id: "test-editor",
      async generate() {
        return [{
          signalId: "newsnow:weibo:flood",
          title: "尼泊尔山洪已造成 9999 人失联",
          hook: "先核验灾害信息。",
          whyNow: "救援正在进行。",
          centralQuestion: "哪些信息已经确认？",
          listenerPromise: "分清已知与未知。",
          selectionReasons: ["公共安全事件"],
          suggestedRoles: ["事实核验者"],
          verdict: "deep_discussion",
          audienceRelevance: 95,
          conversationPotential: 90,
          longformDepth: 90,
          seriesFit: 70,
        }];
      },
    };
    const studio = new CandidateStudio({ gateway: gateway(signals), model, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;

    expect(candidate.title).not.toContain("9999");
    expect(candidate.verdict).toBe("research_first");
    expect(candidate.verification.status).toBe("review_required");
    expect(candidate.verification.independentSources).toBe(0);
    expect(candidate.verification.reason).toContain("不是独立事实来源");
  });

  it("keeps unrelated named entities in separate clusters", async () => {
    const studio = new CandidateStudio({
      gateway: gateway([
        signal("newsnow:weibo:alpha", "甲公司发布100款人工智能模型", "weibo", 1),
        signal("newsnow:baidu:beta", "乙公司发布人工智能模型", "baidu", 2),
      ]),
      model: null,
      now: () => new Date(NOW),
    });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const trends = result.items.filter((item) => item.origin === "trend");
    expect(trends).toHaveLength(2);
    expect(trends.map((item) => item.editorial?.signalCount)).toEqual([1, 1]);
  });

  it("does not merge brand subjects or move a number from one brand to another", async () => {
    const model: PodcastEditorialModel = {
      id: "cross-brand-editor",
      async generate(clusters) {
        return [{
          signalId: clusters[0]!.signalId,
          title: "华为 AI 手机销量 100 万",
          hook: "华为 AI 手机销量已经达到 100 万。",
          whyNow: "两个品牌都在发布 AI 手机。",
          centralQuestion: "AI 手机销量说明了什么？",
          listenerPromise: "分清销量与真实使用价值。",
          selectionReasons: ["手机市场正在变化"],
          suggestedRoles: ["手机行业观察者"],
          verdict: "rapid_brief",
          audienceRelevance: 80,
          conversationPotential: 80,
          longformDepth: 70,
          seriesFit: 70,
        }];
      },
    };
    const studio = new CandidateStudio({
      gateway: gateway([
        signal("newsnow:weibo:apple", "苹果发布 AI 手机销量 100 万", "weibo", 1),
        signal("newsnow:baidu:huawei", "华为发布 AI 手机", "baidu", 2),
      ]),
      model,
      now: () => new Date(NOW),
    });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const trends = result.items.filter((item) => item.origin === "trend");
    expect(trends).toHaveLength(2);
    expect(trends.every((item) => item.editorial?.provider === "rules")).toBe(true);
    expect(trends.some((item) => item.hook.includes("华为") && item.hook.includes("100"))).toBe(false);
  });

  it("does not move a number between brands inside one mixed headline", async () => {
    const model: PodcastEditorialModel = {
      id: "mixed-headline-editor",
      async generate(clusters) {
        return [{
          signalId: clusters[0]!.signalId,
          title: "华为 AI 手机销量 100 万",
          hook: "华为 AI 手机销量已经达到 100 万。",
          whyNow: "手机品牌都在发布 AI 手机。",
          centralQuestion: "AI 手机销量说明了什么？",
          listenerPromise: "分清销量与真实使用价值。",
          selectionReasons: ["手机市场正在变化"],
          suggestedRoles: ["手机行业观察者"],
          verdict: "rapid_brief",
          audienceRelevance: 80,
          conversationPotential: 80,
          longformDepth: 70,
          seriesFit: 70,
        }];
      },
    };
    const studio = new CandidateStudio({
      gateway: gateway([signal("newsnow:weibo:mixed", "苹果 AI 手机销量 100 万，华为发布 AI 手机", "weibo", 1)]),
      model,
      now: () => new Date(NOW),
    });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;
    expect(candidate.editorial?.provider).toBe("rules");
    expect(candidate.hook).not.toContain("华为 AI 手机销量已经达到 100 万");
  });

  it("keeps a late correction in model context and the full candidate source trail", async () => {
    let relatedTitles: string[] = [];
    const model: PodcastEditorialModel = {
      id: "correction-aware-editor",
      async generate(clusters) {
        relatedTitles = clusters[0]?.relatedTitles ?? [];
        return [{
          signalId: clusters[0]!.signalId,
          title: "苹果公司 AI 手机销量 100 万",
          hook: "苹果公司 AI 手机销量已经达到 100 万。",
          whyNow: "相关数据正在传播。",
          centralQuestion: "这个销量意味着什么？",
          listenerPromise: "理解市场变化。",
          selectionReasons: ["市场关注"],
          suggestedRoles: ["行业观察者"],
          verdict: "rapid_brief",
          audienceRelevance: 80,
          conversationPotential: 80,
          longformDepth: 70,
          seriesFit: 70,
        }];
      },
    };
    const repeated = Array.from({ length: 16 }, (_, index) =>
      signal(`newsnow:platform-${index}:claim`, "苹果公司 AI 手机销量 100 万", `platform-${index}`, index + 1),
    );
    const correction = signal("newsnow:official:correction", "苹果公司回应 AI 手机销量 100 万数据有误", "official", 17);
    const studio = new CandidateStudio({ gateway: gateway([...repeated, correction]), model, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;
    expect(relatedTitles.some((title) => title.includes("数据有误"))).toBe(true);
    expect(candidate.evidence.some((item) => item.title.includes("数据有误"))).toBe(true);
    expect(candidate.evidence).toHaveLength(17);
    expect(candidate.editorial?.provider).toBe("rules");
  });

  it("does not call a month-old platform signal simultaneous with a current signal", async () => {
    const old = { ...signal("newsnow:baidu:old", "高校试点人工智能助教", "baidu", 2), observedAt: "2026-07-29T01:00:00.000Z" };
    const studio = new CandidateStudio({
      gateway: gateway([signal("newsnow:weibo:new", "高校试点人工智能助教", "weibo", 1), old]),
      model: null,
      now: () => new Date(NOW),
    });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;
    expect(candidate.editorial?.signalPlatforms).toEqual(["weibo"]);
    expect(candidate.editorial?.whyNow).toContain("单一平台");
    expect(candidate.editorial?.whyNow).not.toContain("正在上升");
  });

  it("describes rank movement only when a previous snapshot supports it", async () => {
    const movingSignal = {
      ...signal("newsnow:weibo:movement", "AI 助手进入办公软件", "weibo", 3),
      momentum: {
        state: "rising" as const,
        rankDelta: 5,
        previousRank: 8,
        comparedAt: "2026-08-29T00:55:00.000Z",
      },
    };
    const studio = new CandidateStudio({ gateway: gateway([movingSignal]), model: null, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;

    expect(candidate.editorial?.momentum).toEqual({ state: "rising", rankDelta: 5, comparedAt: "2026-08-29T00:55:00.000Z" });
    expect(candidate.editorial?.whyNow).toContain("上升 5 位");
  });

  it("does not let a month-old fact enter current model context or output", async () => {
    let relatedTitles: string[] = [];
    const model: PodcastEditorialModel = {
      id: "freshness-editor",
      async generate(clusters) {
        relatedTitles = clusters[0]?.relatedTitles ?? [];
        return [{
          signalId: clusters[0]!.signalId,
          title: "苹果 AI 手机销量 100 万",
          hook: "苹果 AI 手机销量已经达到 100 万。",
          whyNow: "苹果刚刚发布 AI 手机。",
          centralQuestion: "销量说明了什么？",
          listenerPromise: "理解产品与市场。",
          selectionReasons: ["新品发布"],
          suggestedRoles: ["科技观察者"],
          verdict: "rapid_brief",
          audienceRelevance: 80,
          conversationPotential: 80,
          longformDepth: 70,
          seriesFit: 70,
        }];
      },
    };
    const old = { ...signal("newsnow:baidu:old-sales", "苹果 AI 手机销量 100 万", "baidu", 2), observedAt: "2026-07-29T01:00:00.000Z" };
    const studio = new CandidateStudio({
      gateway: gateway([signal("newsnow:weibo:new-phone", "苹果发布 AI 手机", "weibo", 1), old]),
      model,
      now: () => new Date(NOW),
    });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;
    expect(relatedTitles.some((title) => title.includes("100 万"))).toBe(false);
    expect(candidate.editorial?.provider).toBe("rules");
    expect(candidate.hook).not.toContain("100 万");
    expect(candidate.evidence.some((item) => item.title.includes("100 万"))).toBe(true);
  });

  it("falls back as a whole when the model adds unsupported facts outside the title", async () => {
    const model: PodcastEditorialModel = {
      id: "unsafe-editor",
      async generate() {
        return [{
          signalId: "newsnow:weibo:bank",
          title: "银行服务变化后，普通人该关注什么？",
          hook: "监管机构已确认有 9999 人无法取款。",
          whyNow: "讨论正在升温。",
          centralQuestion: "哪些信息已经确认？",
          listenerPromise: "分清事实与传闻。",
          selectionReasons: ["影响普通家庭"],
          suggestedRoles: ["事实核验者"],
          verdict: "rapid_brief",
          audienceRelevance: 90,
          conversationPotential: 90,
          longformDepth: 80,
          seriesFit: 70,
        }];
      },
    };
    const studio = new CandidateStudio({ gateway: gateway([signal("newsnow:weibo:bank", "银行服务调整引发讨论", "weibo", 1)]), model, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    const candidate = result.items.find((item) => item.origin === "trend")!;
    expect(candidate.editorial?.provider).toBe("rules");
    expect(candidate.hook).not.toContain("9999");
  });

  it("returns auditable rule candidates when the local model fails", async () => {
    const model: PodcastEditorialModel = {
      id: "offline-editor",
      async generate() {
        throw new Error("connection refused");
      },
    };
    const studio = new CandidateStudio({ gateway: gateway([signal("newsnow:weibo:education", "高校试点人工智能助教", "weibo", 1)]), model, now: () => new Date(NOW) });

    const result = await studio.list(createSeedSnapshot(NOW), true);
    expect(result.items.find((item) => item.origin === "trend")?.editorial?.provider).toBe("rules");
    expect(result.warnings.join(" ")).toContain("规则降级");
    expect(result.warnings.join(" ")).toContain("connection refused");
  });

  it("serves the last successful candidate portfolio when every fresh source fails", async () => {
    let call = 0;
    const studio = new CandidateStudio({
      gateway: {
        async listSignals() {
          call += 1;
          if (call === 1) return gateway([signal("newsnow:weibo:education", "高校试点人工智能助教", "weibo", 1)]).listSignals();
          return {
            signals: [],
            fetchedAt: "2026-08-29T02:00:00.000Z",
            warnings: ["all sources unavailable"],
            sources: [{ id: "newsnow", label: "NewsNow", count: 0, status: "unavailable" as const }],
          };
        },
      },
      model: null,
      now: () => new Date(NOW),
    });

    const first = await studio.list(createSeedSnapshot(NOW), true);
    const second = await studio.list(createSeedSnapshot(NOW), true);

    expect(second.items.find((item) => item.origin === "trend")?.id).toBe(first.items.find((item) => item.origin === "trend")?.id);
    expect(second.fetchedAt).toBe(NOW);
    expect(second.warnings.join(" ")).toContain("最后一次成功候选");
    expect(second.sources[0]?.status).toBe("unavailable");
  });

  it("coalesces concurrent refreshes into one gateway request", async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listSignals = vi.fn(async () => {
      await waiting;
      return gateway([signal("newsnow:weibo:education", "高校试点人工智能助教", "weibo", 1)]).listSignals();
    });
    const studio = new CandidateStudio({ gateway: { listSignals }, model: null, now: () => new Date(NOW) });

    const first = studio.list(createSeedSnapshot(NOW), true);
    const second = studio.list(createSeedSnapshot(NOW), true);
    release();
    await Promise.all([first, second]);

    expect(listSignals).toHaveBeenCalledTimes(1);
  });
});

function signal(id: string, title: string, platform: string, rank: number): RawTrendSignal {
  return {
    id,
    title,
    sourceId: platform === "hacker-news" ? "hacker-news" : "newsnow",
    sourceLabel: platform === "hacker-news" ? "Hacker News" : "NewsNow",
    platform,
    url: `https://${platform}.example/${encodeURIComponent(title)}`,
    observedAt: NOW,
    rank,
  };
}

function gateway(signals: RawTrendSignal[]): { listSignals(): Promise<TrendFeed> } {
  return {
    async listSignals() {
      return {
        signals,
        fetchedAt: NOW,
        warnings: [],
        sources: [{ id: "newsnow", label: "NewsNow 中文热榜", count: signals.length, status: "ready" }],
      };
    },
  };
}
