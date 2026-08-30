import { createHash } from "node:crypto";
import {
  EpisodeCandidateSchema,
  type EpisodeCandidate,
  type SeriesBible,
  type StudioSnapshot,
} from "@token-talk/domain";
import {
  OllamaPodcastEditorialModel,
  type PodcastEditorialIdea,
  type PodcastEditorialModel,
  type PodcastTopicClusterInput,
} from "./editorial-model.js";
import type { TrendHistoryStore } from "./trend-history.js";
import { TrendGateway, type RawTrendSignal, type TrendFeed } from "./trend-gateway.js";

export interface CandidateInbox {
  items: EpisodeCandidate[];
  fetchedAt: string;
  sources: Array<{ id: string; label: string; count: number; status: "ready" | "degraded" | "unavailable" }>;
  warnings: string[];
  freshness: { status: "current" | "fallback"; lastSuccessfulAt: string; attemptedAt?: string };
}

interface TrendCluster {
  id: string;
  primary: RawTrendSignal;
  signals: RawTrendSignal[];
}

interface CandidateStudioOptions {
  gateway?: Pick<TrendGateway, "listSignals">;
  history?: Pick<TrendHistoryStore, "capture">;
  model?: PodcastEditorialModel | null;
  now?: () => Date;
}

const TREND_CANDIDATE_LIMIT = 24;
const MODEL_CLUSTER_LIMIT = 28;

export class CandidateStudio {
  private readonly gateway: Pick<TrendGateway, "listSignals">;
  private readonly history: Pick<TrendHistoryStore, "capture"> | undefined;
  private readonly model: PodcastEditorialModel | null;
  private readonly now: () => Date;
  private cache?: { expiresAt: number; value: CandidateInbox };
  private refreshPromise: Promise<CandidateInbox> | undefined;

  constructor(options: CandidateStudioOptions = {}) {
    this.gateway = options.gateway ?? new TrendGateway();
    this.history = options.history;
    this.model = options.model === undefined ? new OllamaPodcastEditorialModel() : options.model;
    this.now = options.now ?? (() => new Date());
  }

  async list(snapshot: StudioSnapshot, force = false): Promise<CandidateInbox> {
    if (!force && this.cache && this.cache.expiresAt > this.now().getTime()) {
      return { ...this.cache.value, items: [...this.cache.value.items, ...seriesCandidates(snapshot, this.now())] };
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshTrend().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    const value = await this.refreshPromise;
    return { ...value, items: [...value.items, ...seriesCandidates(snapshot, this.now())] };
  }

  async listResponsive(snapshot: StudioSnapshot, force = false, responseBudgetMs = 8_000): Promise<CandidateInbox> {
    const attemptedAt = this.now().toISOString();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ state: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ state: "timeout" }), Math.max(1, responseBudgetMs));
      timeoutId.unref?.();
    });
    const result = await Promise.race([
      this.list(snapshot, force).then(
        (value) => ({ state: "ready" as const, value }),
        (error: unknown) => ({ state: "failed" as const, error }),
      ),
      timeout,
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    if (result.state === "ready") return result.value;

    const reason = result.state === "timeout"
      ? "热点仍在后台采集，先展示可用的系列选题。"
      : `热点采集暂不可用，先展示系列选题：${errorMessage(result.error)}`;
    const fallback = this.cache?.value;
    if (fallback) {
      return {
        ...fallback,
        items: [...fallback.items, ...seriesCandidates(snapshot, this.now())],
        freshness: { status: "fallback", lastSuccessfulAt: fallback.fetchedAt, attemptedAt },
        warnings: [...fallback.warnings, reason],
      };
    }
    return {
      items: seriesCandidates(snapshot, this.now()),
      fetchedAt: attemptedAt,
      sources: [],
      warnings: [reason],
      freshness: { status: "fallback", lastSuccessfulAt: snapshot.updatedAt, attemptedAt },
    };
  }

  private async refreshTrend(): Promise<CandidateInbox> {
    let feed: TrendFeed;
    try {
      feed = await this.gateway.listSignals();
    } catch (error) {
      if (!this.cache) throw error;
      return {
        ...this.cache.value,
        freshness: { status: "fallback", lastSuccessfulAt: this.cache.value.fetchedAt, attemptedAt: this.now().toISOString() },
        warnings: [...this.cache.value.warnings, `本次刷新失败，继续使用最后一次成功候选：${errorMessage(error)}`],
      };
    }
    if (feed.signals.length === 0 && this.cache) {
      return {
        ...this.cache.value,
        sources: feed.sources,
        freshness: { status: "fallback", lastSuccessfulAt: this.cache.value.fetchedAt, attemptedAt: feed.fetchedAt },
        warnings: [...feed.warnings, `本次刷新没有可用信号，继续使用 ${formatTime(this.cache.value.fetchedAt)} 的最后一次成功候选。`],
      };
    }
    const warnings = [...feed.warnings];
    if (this.history) {
      try {
        feed = await this.history.capture(feed);
      } catch (error) {
        warnings.push(`趋势历史暂不可用，本轮只展示当前快照：${errorMessage(error)}`);
      }
    }
    const clusters = selectClustersForEditorial(clusterSignals(feed.signals), MODEL_CLUSTER_LIMIT);
    let modelIdeas = new Map<string, PodcastEditorialIdea>();
    if (this.model && clusters.length > 0) {
      try {
        const modelInputs = clusters.flatMap((cluster) => {
          const input = modelCluster(cluster, feed.fetchedAt);
          return input ? [input] : [];
        });
        const ideas = modelInputs.length > 0 ? await this.model.generate(modelInputs) : [];
        modelIdeas = new Map(ideas.map((idea) => [idea.signalId, idea]));
      } catch (error) {
        warnings.push(`本地 AI 选题总编暂不可用，已使用可审计规则降级：${errorMessage(error)}`);
      }
    }

    const candidates = selectPortfolio(
      clusters.map((cluster) => trendCandidate(cluster, feed.fetchedAt, modelIdeas.get(cluster.primary.id))),
      TREND_CANDIDATE_LIMIT,
    );
    const value: CandidateInbox = {
      items: candidates,
      fetchedAt: feed.fetchedAt,
      sources: feed.sources,
      warnings,
      freshness: { status: "current", lastSuccessfulAt: feed.fetchedAt },
    };
    if (candidates.length > 0) {
      this.cache = { expiresAt: this.now().getTime() + 15 * 60_000, value };
    }
    return value;
  }

  async find(snapshot: StudioSnapshot, candidateId: string): Promise<EpisodeCandidate | undefined> {
    return (await this.list(snapshot)).items.find((candidate) => candidate.id === candidateId);
  }
}

function modelCluster(cluster: TrendCluster, fetchedAt: string): PodcastTopicClusterInput | undefined {
  const currentSignals = currentSignalsFor(cluster.signals, fetchedAt);
  if (currentSignals.length === 0) return undefined;
  const contextSignals = selectSignalsForModel(currentSignals);
  const primarySignal = currentSignals.find((signal) => signal.id === cluster.primary.id) ?? currentSignals[0]!;
  return {
    signalId: cluster.primary.id,
    sourceTitle: primarySignal.title,
    relatedTitles: contextSignals.filter((signal) => signal.id !== primarySignal.id).map((signal) => signal.title),
    platforms: unique(currentSignals.map((signal) => platformLabel(signal.platform))),
    bestRank: Math.min(...currentSignals.map((signal) => signal.rank)),
    signalCount: currentSignals.length,
  };
}

function trendCandidate(
  cluster: TrendCluster,
  fetchedAt: string,
  idea: PodcastEditorialIdea | undefined,
): EpisodeCandidate {
  const sourceText = cluster.signals.map((signal) => signal.title).join(" ");
  const category = categoryFor(sourceText);
  const currentSignals = currentSignalsFor(cluster.signals, fetchedAt);
  const scoringSignals = currentSignals.length > 0 ? currentSignals : [cluster.primary];
  const currentCluster = { ...cluster, signals: scoringSignals, primary: scoringSignals[0] ?? cluster.primary };
  const platforms = unique(scoringSignals.map((signal) => signal.platform));
  const bestRank = Math.min(...scoringSignals.map((signal) => signal.rank));
  const localPlatformCount = platforms.filter((platform) => platform !== "hacker-news" && platform !== "wikipedia").length;
  const signalStrength = clamp(102 - bestRank * 3 + Math.min(18, (platforms.length - 1) * 7));
  const risk = riskScore(sourceText, category);
  const weakSignalPenalty = weakSignalPenaltyFor(currentCluster);
  const groundedIdea = idea && currentSignals.length > 0 && !currentSignals.some(isCorrectionSignal) && isGroundedIdea(idea, currentSignals) ? idea : undefined;
  const ruleAudience = clamp(categoryAudience(category) + signalStrength * 0.25 + localPlatformCount * 6 - weakSignalPenalty);
  const ruleConversation = clamp(conversationBase(sourceText, category) + platforms.length * 5 - weakSignalPenalty);
  const ruleLongform = clamp(longformBase(category) + platforms.length * 4 - weakSignalPenalty);
  const evidenceDepth = 0;
  const signalAgeHours = ageInHours(cluster.signals, fetchedAt);
  const momentum = clusterMomentum(scoringSignals);
  const seriesFit = clamp(seriesFitFor(category) + (platforms.length > 1 ? 6 : 0));
  const score = {
    audienceRelevance: blend(ruleAudience, groundedIdea?.audienceRelevance),
    conversationPotential: blend(ruleConversation, groundedIdea?.conversationPotential),
    evidenceDepth,
    longformDepth: blend(ruleLongform, groundedIdea?.longformDepth),
    freshness: clamp(100 - Math.max(0, bestRank - 1) * 2 - signalAgeHours * 3),
    seriesFit: blend(seriesFit, groundedIdea?.seriesFit),
    feasibility: risk >= 70 ? 58 : 84,
    risk,
    overall: 0,
  };
  score.overall = Math.round(
    score.audienceRelevance * 0.17
    + score.conversationPotential * 0.23
    + score.evidenceDepth * 0.14
    + score.longformDepth * 0.18
    + score.freshness * 0.09
    + score.seriesFit * 0.08
    + score.feasibility * 0.06
    + (100 - score.risk) * 0.05,
  );

  const signalPlatformCount = platforms.length;
  const requiresFactResearch = risk >= 70;
  const verdict = decideVerdict(score, groundedIdea?.verdict, requiresFactResearch, weakSignalPenalty);
  const groundedTitle = groundedIdea
    ? groundedIdea.title
    : editorialTitle(cluster.primary.title, category, verdict);
  const fallback = fallbackEditorial(currentCluster, category, verdict, score, momentum);
  const evidence = cluster.signals.flatMap((signal) => {
    const items = [{
      id: `${signal.id}-source`,
      source: `${platformLabel(signal.platform)} · ${signal.sourceLabel}`,
      platform: signal.platform,
      title: signal.title,
      url: signal.url,
      observedAt: signal.observedAt,
      signal: signal.heat ? `热度 ${Math.round(signal.heat).toLocaleString()}` : `榜单第 ${signal.rank} 位`,
    }];
    if (signal.discussionUrl) {
      items.push({
        id: `${signal.id}-discussion`,
        source: `${platformLabel(signal.platform)}讨论区`,
        platform: signal.platform,
        title: `${signal.title} 的公开讨论`,
        url: signal.discussionUrl,
        observedAt: signal.observedAt,
        signal: "只用于发现分歧，不作为独立事实来源",
      });
    }
    return items;
  });

  return EpisodeCandidateSchema.parse({
    id: `candidate-${cluster.id}`,
    origin: "trend",
    title: groundedTitle,
    hook: groundedIdea?.hook ?? fallback.hook,
    rationale: fallback.selectionReasons.join("；"),
    category,
    platform: platforms.map(platformLabel).slice(0, 3).join(" + "),
    suggestedRoles: groundedIdea?.suggestedRoles ?? rolesFor(category, verdict),
    verdict,
    targetMinutes: targetMinutesFor(verdict),
    score,
    evidence,
    verification: {
      status: "review_required",
      reason: requiresFactResearch
        ? `当前 ${signalPlatformCount} 个平台只构成发现线索，不是独立事实来源；本期必须先建立事实账本，至少补齐并核验两个独立来源。`
        : `当前有 ${signalPlatformCount} 个平台发现信号；立项只代表值得研究，制作前仍要补齐并核验独立事实来源。`,
      independentSources: 0,
    },
    editorial: {
      whyNow: fallback.whyNow,
      centralQuestion: groundedIdea?.centralQuestion ?? fallback.centralQuestion,
      listenerPromise: groundedIdea?.listenerPromise ?? fallback.listenerPromise,
      selectionReasons: fallback.selectionReasons,
      signalPlatforms: platforms,
      signalCount: scoringSignals.length,
      provider: groundedIdea ? "local_ai" : "rules",
      momentum,
    },
    generatedAt: fetchedAt,
  });
}

function seriesCandidates(snapshot: StudioSnapshot, now: Date): EpisodeCandidate[] {
  return snapshot.series.flatMap((series) => {
    const adoptedSeriesEpisodes = snapshot.opportunities.filter((opportunity) => opportunity.candidate.seriesId === series.id).length;
    const legacyRuns = snapshot.runs.filter((run) => run.seriesId === series.id && !run.opportunityId).length;
    const nextEpisode = adoptedSeriesEpisodes + legacyRuns + 1;
    return seriesIdeas(series).map((idea, index) => EpisodeCandidateSchema.parse({
      id: stableSeriesCandidateId(series.id, idea.title, idea.hook),
      origin: "series",
      title: idea.title,
      hook: idea.hook,
      rationale: `延续“${series.promise}”的栏目承诺，同时为本期保留一个可争论的问题。`,
      category: idea.category,
      platform: series.title,
      seriesId: series.id,
      episodeNumber: nextEpisode + index,
      suggestedRoles: ["本期主持", "观点挑战者", "资料研究员"],
      verdict: "series_episode",
      targetMinutes: { min: 30, max: 60 },
      score: {
        overall: 82 - index * 3,
        audienceRelevance: 78,
        conversationPotential: 84 - index * 2,
        evidenceDepth: 62,
        longformDepth: 90,
        freshness: 58,
        seriesFit: 96,
        feasibility: 82,
        risk: 18,
      },
      evidence: [],
      verification: {
        status: "ready",
        reason: "系列候选可立项，资料与版本信息将在研究阶段补齐。",
        independentSources: 0,
      },
      editorial: {
        whyNow: `这是“${series.title}”下一期可延续的长期命题。`,
        centralQuestion: idea.title,
        listenerPromise: series.promise,
        selectionReasons: ["延续栏目承诺", "具备可争论的问题", "适合沉淀为系列记忆"],
        signalPlatforms: [series.title],
        signalCount: 1,
        provider: "series",
      },
      generatedAt: now.toISOString(),
    }));
  });
}

function stableSeriesCandidateId(seriesId: string, title: string, hook: string): string {
  const fingerprint = createHash("sha256").update(`${seriesId}\0${title}\0${hook}`).digest("hex").slice(0, 16);
  return `candidate-${seriesId}-${fingerprint}`;
}

function clusterSignals(signals: RawTrendSignal[]): TrendCluster[] {
  const clusters: TrendCluster[] = [];
  for (const signal of signals) {
    const cluster = clusters.find((candidate) => candidate.signals.some((item) => equivalentTopic(item.title, signal.title)));
    if (cluster) {
      cluster.signals.push(signal);
      cluster.signals.sort(bySignalStrength);
      cluster.primary = cluster.signals[0]!;
      continue;
    }
    clusters.push({ id: stableClusterId(signal), primary: signal, signals: [signal] });
  }
  return clusters
    .map((cluster) => ({ ...cluster, id: canonicalClusterId(cluster) }))
    .sort((left, right) => clusterStrength(right) - clusterStrength(left));
}

function equivalentTopic(left: string, right: string): boolean {
  const normalizedLeft = normalizeTopicText(left);
  const normalizedRight = normalizeTopicText(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftTerms = meaningfulTerms(left);
  const rightTerms = meaningfulTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return false;
  const leftEntities = namedEntities(left);
  const rightEntities = namedEntities(right);
  if (leftEntities.size > 0 && rightEntities.size > 0 && ![...leftEntities].some((entity) => rightEntities.has(entity))) {
    return false;
  }
  const shared = [...leftTerms].filter((term) => rightTerms.has(term));
  const overlap = shared.length / Math.min(leftTerms.size, rightTerms.size);
  return shared.length >= 2 && overlap >= 0.45;
}

const topicSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const STOP_WORDS = new Set([
  "官方", "最新", "热点", "正在", "发生", "引发", "背后", "为什么", "如何", "哪些", "目前",
  "信息", "问题", "真的", "网友", "回应", "发布", "宣布", "一个", "这个", "已经", "可以",
]);
const SUBJECT_ALIASES = new Map<string, string[]>([
  ["苹果", ["苹果", "apple"]],
  ["华为", ["华为", "huawei"]],
  ["小米", ["小米", "xiaomi"]],
  ["腾讯", ["腾讯", "tencent"]],
  ["阿里巴巴", ["阿里巴巴", "阿里", "alibaba"]],
  ["字节跳动", ["字节跳动", "字节", "bytedance"]],
  ["百度", ["百度", "baidu"]],
  ["微软", ["微软", "microsoft"]],
  ["谷歌", ["谷歌", "google"]],
  ["OpenAI", ["openai"]],
  ["Anthropic", ["anthropic"]],
  ["特斯拉", ["特斯拉", "tesla"]],
]);

function meaningfulTerms(value: string): Set<string> {
  return new Set([...topicSegmenter.segment(value)]
    .filter((part) => part.isWordLike)
    .map((part) => normalizeTopicText(part.segment))
    .filter((term) => term.length >= 2 && !/^\d+(?:\.\d+)?%?$/.test(term) && !STOP_WORDS.has(term)));
}

function clusterStrength(cluster: TrendCluster): number {
  const platforms = unique(cluster.signals.map((signal) => signal.platform)).length;
  return 100 - cluster.primary.rank * 2 + Math.min(30, (platforms - 1) * 12) + Math.min(12, cluster.signals.length * 2);
}

function bySignalStrength(left: RawTrendSignal, right: RawTrendSignal): number {
  return signalSourcePriority(left) - signalSourcePriority(right) || left.rank - right.rank;
}

function signalSourcePriority(signal: RawTrendSignal): number {
  if (signal.sourceId === "newsnow") return 0;
  if (signal.sourceId === "dailyhot") return 1;
  if (signal.sourceId === "hacker-news") return 2;
  return 3;
}

function stableClusterId(signal: RawTrendSignal): string {
  return signal.id.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 100);
}

function canonicalClusterId(cluster: TrendCluster): string {
  const entities = unique(cluster.signals.flatMap((signal) => [...namedEntities(signal.title)])).sort();
  const terms = [...meaningfulTerms(cluster.primary.title)].sort();
  const fingerprint = [...entities, ...terms].slice(0, 6).join(":") || cluster.primary.id;
  return `topic:${createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)}`;
}

function categoryFor(title: string): EpisodeCandidate["category"] {
  if (/\bai\b|llm|模型|人工智能|openai|agent|软件|开源|算法|芯片|机器人|数据中心|科技|互联网|github/i.test(title)) return "ai_tech";
  if (/经济|消费|金融|股票|基金|银行|房贷|公积金|就业|工资|职场|公司|市场|商业|营收|财报|供应链|美联储/.test(title)) return "business";
  if (/教育|学校|高校|高考|中考|考试|学生|教师|留学|大学/.test(title)) return "education";
  if (/医疗|医生|医院|癌症|疫苗|健康|疾病|减肥|营养/.test(title)) return "health";
  if (/研究|科学|太空|物理|生物|气候|核聚变/.test(title)) return "science";
  if (/电影|电视剧|综艺|明星|演员|导演|音乐|演唱会|游戏|文化|艺术|版权/.test(title)) return "culture";
  if (/国际|外交|战争|冲突|制裁|美国|欧洲|日本|韩国|伊朗|以色列|尼泊尔/.test(title)) return "world";
  if (/社会|政策|城市|法律|法院|警方|灾害|泥石流|暴雨|地震|事故|人口|新生儿/.test(title)) return "society";
  if (/生活|情感|家庭|住房|旅行|旅游|美食|工作|普通人/.test(title)) return "life";
  return "other";
}

function riskScore(title: string, category: EpisodeCandidate["category"]): number {
  if (/伤亡|死亡|去世|逝世|身亡|遇难|失联|地震|台风|暴雨|山洪|泥石流|救援|灾害|战争|冲突|枪杀|绑架|轰炸|空袭|爆炸|自杀/.test(title)) return 76;
  if (/警方|法院|通报|外交|制裁|医疗|疾病|癌症|疫苗|法律|法规|违法|诈骗|食物中毒|房贷|美联储/.test(title)) return 52;
  if (category === "health" || category === "world") return 44;
  return 18;
}

function weakSignalPenaltyFor(cluster: TrendCluster): number {
  const title = cluster.primary.title;
  const platforms = unique(cluster.signals.map((signal) => signal.platform)).length;
  let penalty = 0;
  if (/\bshow hn\b|\bask hn\b|\bv?\d+(?:\.\d+){1,3}\b|release notes|is now open|github repository/i.test(title)) penalty += 24;
  if (/剧宣|红毯|自拍|造型|恋情|没放过|疑似被|影帝|影后|长相太年轻/.test(title)) penalty += 18;
  if (normalizeTopicText(title).length <= 5 && platforms === 1) penalty += 20;
  if (cluster.primary.sourceId === "wikipedia-zh" && platforms === 1) penalty += 26;
  if (cluster.primary.sourceId === "hacker-news" && platforms === 1) penalty += 12;
  return penalty;
}

function categoryAudience(category: EpisodeCandidate["category"]): number {
  if (category === "business" || category === "society" || category === "ai_tech" || category === "life") return 62;
  if (category === "education" || category === "health" || category === "world") return 58;
  if (category === "science" || category === "culture") return 52;
  return 42;
}

function conversationBase(title: string, category: EpisodeCandidate["category"]): number {
  let score = ["business", "society", "ai_tech", "education", "health", "world"].includes(category) ? 62 : 52;
  if (/为什么|如何|争议|影响|应该|是否|还能|值得|选择|代价|权利|谁/.test(title)) score += 12;
  if (/榜单|名单|发布|上线|版本|走红|剧宣/.test(title)) score -= 10;
  return score;
}

function longformBase(category: EpisodeCandidate["category"]): number {
  if (["business", "society", "ai_tech", "science", "education", "health", "world", "books"].includes(category)) return 68;
  if (category === "culture" || category === "life") return 60;
  return 48;
}

function seriesFitFor(category: EpisodeCandidate["category"]): number {
  if (category === "books") return 94;
  if (["ai_tech", "business", "science", "education", "society"].includes(category)) return 74;
  return 60;
}

function blend(ruleValue: number, modelValue: number | undefined): number {
  if (modelValue === undefined) return Math.round(ruleValue);
  return Math.round(ruleValue * 0.58 + clamp(modelValue) * 0.42);
}

function decideVerdict(
  score: EpisodeCandidate["score"],
  modelVerdict: PodcastEditorialIdea["verdict"] | undefined,
  blocked: boolean,
  weakPenalty: number,
): EpisodeCandidate["verdict"] {
  if (blocked) return "research_first";
  if (modelVerdict === "skip" && score.overall < 64) return "skip";
  if (weakPenalty >= 24 && score.overall < 62) return "skip";
  if (modelVerdict === "deep_discussion" && score.conversationPotential >= 77 && score.longformDepth >= 74) return "deep_discussion";
  if (score.conversationPotential >= 77 && score.longformDepth >= 74 && score.evidenceDepth >= 56) return "deep_discussion";
  if (score.overall >= 62 && score.conversationPotential >= 60) return "rapid_brief";
  return modelVerdict === "rapid_brief" && score.overall >= 58 ? "rapid_brief" : "research_first";
}

function fallbackEditorial(
  cluster: TrendCluster,
  category: EpisodeCandidate["category"],
  verdict: EpisodeCandidate["verdict"],
  score: EpisodeCandidate["score"],
  momentum: NonNullable<NonNullable<EpisodeCandidate["editorial"]>["momentum"]>,
) {
  const platformCount = unique(cluster.signals.map((signal) => signal.platform)).length;
  const centralQuestion = centralQuestionFor(category);
  return {
    hook: verdict === "deep_discussion"
      ? `热搜给了一个结论，但这期节目要追问：${centralQuestion}`
      : `先不跟着热搜下结论，用来源分清变化、代价和仍然未知的部分。`,
    whyNow: whyNowFor(platformCount, momentum),
    centralQuestion,
    listenerPromise: `听完能分清已经发生的变化、不同立场的核心分歧，以及接下来该看哪些证据。`,
    selectionReasons: [
      `对话潜力 ${Math.round(score.conversationPotential)} 分`,
      `长音频展开空间 ${Math.round(score.longformDepth)} 分`,
      `${platformCount} 个平台信号可追溯`,
    ],
  };
}

function clusterMomentum(signals: RawTrendSignal[]): NonNullable<NonNullable<EpisodeCandidate["editorial"]>["momentum"]> {
  const known = signals.flatMap((signal) => signal.momentum && signal.momentum.state !== "unknown" ? [signal.momentum] : []);
  if (known.length === 0) return { state: "unknown" };
  const comparedAt = known.map((item) => item.comparedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const rising = known.filter((item) => item.state === "rising").sort((left, right) => (right.rankDelta ?? 0) - (left.rankDelta ?? 0))[0];
  const falling = known.filter((item) => item.state === "falling").sort((left, right) => (left.rankDelta ?? 0) - (right.rankDelta ?? 0))[0];
  if (rising) return { state: "rising", ...(rising.rankDelta === undefined ? {} : { rankDelta: rising.rankDelta }), ...(comparedAt ? { comparedAt } : {}) };
  if (known.every((item) => item.state === "new")) return { state: "new", ...(comparedAt ? { comparedAt } : {}) };
  if (known.every((item) => item.state === "falling") && falling) return { state: "falling", ...(falling.rankDelta === undefined ? {} : { rankDelta: falling.rankDelta }), ...(comparedAt ? { comparedAt } : {}) };
  if (known.every((item) => item.state === "steady")) return { state: "steady", ...(comparedAt ? { comparedAt } : {}) };
  return { state: "mixed", ...(comparedAt ? { comparedAt } : {}) };
}

function whyNowFor(
  platformCount: number,
  momentum: NonNullable<NonNullable<EpisodeCandidate["editorial"]>["momentum"]>,
): string {
  if (platformCount > 1) return `同一议题已在 ${platformCount} 个平台同时出现，不再只是单一榜单里的孤立信号。`;
  if (momentum.state === "rising" && momentum.rankDelta) return `同一平台相邻两次采集对比后，排名上升 ${momentum.rankDelta} 位；仍需判断它是否具备持续讨论价值。`;
  if (momentum.state === "new") return "本次采集新进入榜单；目前仍是单一平台观察，需要先判断它是否只是短时噪声。";
  if (momentum.state === "steady") return "这个议题连续两次出现在同一平台，排名基本稳定；仍需补充跨平台与事实来源。";
  if (momentum.state === "falling") return `同一平台相邻两次采集对比后，排名回落 ${Math.abs(momentum.rankDelta ?? 0)} 位；采用前要确认讨论窗口是否仍然成立。`;
  if (momentum.state === "mixed") return "不同信号的排名方向不一致，目前不能把它概括成统一的上涨或回落趋势。";
  return "目前只观察到单一平台信号，尚无排名变化或跨平台扩散证据，需要先判断它是否只是短时噪声。";
}

function centralQuestionFor(category: EpisodeCandidate["category"]): string {
  if (category === "ai_tech") return "技术承诺与真实影响之间差了什么？";
  if (category === "business") return "谁会因此受益、谁承担成本，普通人的选择会怎样变化？";
  if (category === "society" || category === "world") return "哪些事实已经确认，哪些判断仍然需要等待证据？";
  if (category === "education") return "这项变化究竟改善了学习，还是只改变了评价方式？";
  if (category === "health") return "个体故事、医学证据和公共建议之间该怎样划界？";
  if (category === "culture") return "这件事只是流行，还是反映了更持久的文化变化？";
  if (category === "science") return "研究真正证明了什么，又有哪些结论被传播放大了？";
  return "它为什么值得展开成一段完整论证，而不只是被看见一次？";
}

function editorialTitle(sourceTitle: string, category: EpisodeCandidate["category"], verdict: EpisodeCandidate["verdict"]): string {
  if (verdict === "skip") return `${sourceTitle}：暂不进入制作`;
  if (category === "business") return `${sourceTitle}：成本和选择会落到谁身上？`;
  if (category === "ai_tech") return `${sourceTitle}：技术新闻之外，真实改变是什么？`;
  if (category === "health") return `${sourceTitle}：个体故事能推出公共结论吗？`;
  if (category === "society" || category === "world") return `${sourceTitle}：哪些事实已经确认？`;
  return `${sourceTitle}：热度之外真正值得谈什么？`;
}

function rolesFor(category: EpisodeCandidate["category"], verdict: EpisodeCandidate["verdict"]): string[] {
  if (verdict === "rapid_brief") return ["事实讲述者", "影响分析者"];
  if (category === "ai_tech") return ["技术观察者", "产品怀疑者", "事实核验者"];
  if (category === "business") return ["商业分析者", "普通人视角", "反方评论者"];
  if (category === "science" || category === "health") return ["科学讲述者", "方法论审稿人", "风险沟通者"];
  if (category === "culture" || category === "books") return ["文化评论者", "文本细读者", "普通听众视角"];
  if (category === "society" || category === "world") return ["背景讲述者", "证据核验者", "立场挑战者"];
  return ["背景讲述者", "观点挑战者", "事实核验者"];
}

function targetMinutesFor(verdict: EpisodeCandidate["verdict"]): { min: number; max: number } {
  if (verdict === "deep_discussion") return { min: 30, max: 60 };
  if (verdict === "rapid_brief") return { min: 15, max: 25 };
  return { min: 25, max: 60 };
}

function isGrounded(value: string, signals: RawTrendSignal[]): boolean {
  const allowedNumbers = new Set(signals.flatMap((signal) => signal.title.match(/\d+(?:\.\d+)?%?/g) ?? []));
  const numbers = value.match(/\d+(?:\.\d+)?%?/g) ?? [];
  const unsupportedNumbers = numbers.some((number) => !allowedNumbers.has(number));
  const entities = [...namedEntities(value)];
  const unsupportedEntities = entities.some((entity) => !signals.some((signal) => namedEntities(signal.title).has(entity)));
  const unsupportedAttribution = /独家|内部消息|调查显示|研究表明|数据显示|据透露/.test(value);
  const factualClauses = splitFactClauses(value).filter((clause) => /\d/.test(clause) || namedEntities(clause).size > 0);
  const jointlySupported = factualClauses.every((claim) => {
    const claimNumbers = claim.match(/\d+(?:\.\d+)?%?/g) ?? [];
    const claimEntities = [...namedEntities(claim)];
    const claimTerms = meaningfulTerms(claim);
    const discriminatingTerms = [...claimTerms].filter((term) => {
      const supportCount = signals.filter((signal) => meaningfulTerms(signal.title).has(term)).length;
      return supportCount > 0 && supportCount < signals.length;
    });
    return signals.some((signal) => splitFactClauses(signal.title).some((sourceClause) => {
      const titleTerms = meaningfulTerms(sourceClause);
      return claimNumbers.every((number) => sourceClause.includes(number))
        && claimEntities.every((entity) => namedEntities(sourceClause).has(entity))
        && discriminatingTerms.every((term) => titleTerms.has(term));
    }));
  });
  return !unsupportedNumbers && !unsupportedEntities && !unsupportedAttribution && jointlySupported;
}

function isGroundedIdea(idea: PodcastEditorialIdea, signals: RawTrendSignal[]): boolean {
  const fields = [idea.title, idea.hook, idea.whyNow, idea.centralQuestion, idea.listenerPromise, ...idea.selectionReasons];
  const questionLike = /[？?]|为什么|如何|是否|什么|哪些|谁|怎样|多大|该不该/.test(idea.centralQuestion);
  return questionLike && fields.every((field) => isGrounded(field, signals));
}

function namedEntities(value: string): Set<string> {
  const entities: string[] = value.match(/[\p{Script=Han}A-Za-z0-9]{1,18}(?:公司|集团|大学|学院|银行|医院|政府|法院|警方|委员会|研究院)/gu) ?? [];
  for (const [canonical, aliases] of SUBJECT_ALIASES) {
    if (aliases.some((alias) => value.toLocaleLowerCase("zh-CN").includes(alias))) entities.push(canonical);
  }
  return new Set(entities);
}

function ageInHours(signals: RawTrendSignal[], fetchedAt: string): number {
  const fetchedTime = new Date(fetchedAt).getTime();
  const newestSignalTime = Math.max(...signals
    .filter((signal) => signal.timeBasis !== "collected")
    .map((signal) => new Date(signal.observedAt).getTime())
    .filter(Number.isFinite));
  if (!Number.isFinite(fetchedTime) || !Number.isFinite(newestSignalTime)) return 168;
  return Math.max(0, (fetchedTime - newestSignalTime) / 3_600_000);
}

function currentSignalsFor(signals: RawTrendSignal[], fetchedAt: string): RawTrendSignal[] {
  const fetchedTime = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetchedTime)) return [];
  return signals.filter((signal) => {
    if (signal.timeBasis === "collected") return false;
    const observedTime = new Date(signal.observedAt).getTime();
    if (!Number.isFinite(observedTime)) return false;
    const ageHours = (fetchedTime - observedTime) / 3_600_000;
    return ageHours >= -1 && ageHours <= 48;
  });
}

function selectSignalsForModel(signals: RawTrendSignal[]): RawTrendSignal[] {
  const selected: RawTrendSignal[] = [];
  const seen = new Set<string>();
  const add = (signal: RawTrendSignal) => {
    if (seen.has(signal.id) || selected.length >= 16) return;
    selected.push(signal);
    seen.add(signal.id);
  };
  signals.filter(isCorrectionSignal).forEach(add);
  signals.forEach((signal) => {
    if (!selected.some((item) => item.platform === signal.platform)) add(signal);
  });
  signals.forEach(add);
  return selected;
}

function isCorrectionSignal(signal: RawTrendSignal): boolean {
  return /否认|澄清|不实|不属实|辟谣|更正|争议|回应|数据有误|信息有误|并非|未曾|误传|错误|撤回/.test(signal.title);
}

function splitFactClauses(value: string): string[] {
  return value.split(/[，,；;。.!！?？:：]/u).map((clause) => clause.trim()).filter(Boolean);
}

function selectClustersForEditorial(clusters: TrendCluster[], limit: number): TrendCluster[] {
  const selected: TrendCluster[] = [];
  const categoryCounts = new Map<EpisodeCandidate["category"], number>();
  for (const cluster of clusters) {
    const category = categoryFor(cluster.signals.map((signal) => signal.title).join(" "));
    if ((categoryCounts.get(category) ?? 0) >= 4) continue;
    selected.push(cluster);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }
  for (const cluster of clusters) {
    if (selected.includes(cluster)) continue;
    selected.push(cluster);
    if (selected.length >= limit) break;
  }
  return selected;
}

function selectPortfolio(candidates: EpisodeCandidate[], limit: number): EpisodeCandidate[] {
  const sorted = [...candidates].sort((left, right) => right.score.overall - left.score.overall);
  const selected: EpisodeCandidate[] = [];
  const categoryCounts = new Map<EpisodeCandidate["category"], number>();
  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const cap = candidate.category === "other" ? 3 : 6;
    if ((categoryCounts.get(candidate.category) ?? 0) >= cap) continue;
    selected.push(candidate);
    categoryCounts.set(candidate.category, (categoryCounts.get(candidate.category) ?? 0) + 1);
  }
  return selected;
}

function seriesIdeas(series: SeriesBible) {
  if (series.title.includes("读书")) {
    return [
      { title: "《有限与无限的游戏》：为什么有些胜利会让游戏结束？", hook: "把人生当成比赛，可能正是问题本身。", category: "books" as const },
      { title: "《技术与文明》：工具究竟扩大了谁的选择？", hook: "技术从来不只提高效率，它也在重新分配权力。", category: "books" as const },
      { title: "《娱乐至死》在短视频时代还成立吗？", hook: "真正变化的也许不是媒介，而是我们对严肃的耐心。", category: "books" as const },
    ];
  }
  return [
    { title: `${series.title}：下一期从哪个反例开始？`, hook: "先找一个不符合常识的真实案例，再决定本期结论。", category: "other" as const },
  ];
}

function platformLabel(platform: string): string {
  return ({
    weibo: "微博",
    baidu: "百度",
    zhihu: "知乎",
    bilibili: "B 站",
    "36kr": "36氪",
    ithome: "IT之家",
    sspai: "少数派",
    thepaper: "澎湃",
    douyin: "抖音",
    toutiao: "今日头条",
    "hacker-news": "Hacker News",
    wikipedia: "中文维基",
  } as Record<string, string>)[platform] ?? platform;
}

function normalizeTopicText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]/gu, "");
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
