import { createHash } from "node:crypto";
import type { Artifact } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";
import type { NodeExecutionContext, NodeExecutionPlan, NodeExecutor, NodePlanningContext } from "./node-executor.js";
import { canonicalizeHttpsUrl, type ResearchSearchGateway, type ResearchSource } from "./research-gateway.js";
import { reviewResearchPacket } from "./research-ledger.js";
import { StaticSourceVerifier, type ResearchSourceVerifier, type SourceVerificationCheck } from "./source-verifier.js";

const RESEARCH_NODE_TIMEOUT_MS = 120_000;

export class ResearchNodeExecutor implements NodeExecutor {
  constructor(
    private readonly gateway: ResearchSearchGateway,
    private readonly fallback: NodeExecutor,
    private readonly now: () => string,
    private readonly verifier: ResearchSourceVerifier = new StaticSourceVerifier([]),
  ) {}

  plan(context: NodePlanningContext): NodeExecutionPlan {
    if (context.node.capability === "research.search") {
      return {
        providerId: "research-agent-orchestrator",
        modelId: "free-multi-source-discovery-v1",
        billing: "free",
        estimatedCostCny: 0,
        timeoutMs: RESEARCH_NODE_TIMEOUT_MS,
      };
    }
    return this.fallback.plan?.(context) ?? {
      providerId: context.node.providerId ?? "local-production-engine",
      modelId: context.node.modelId ?? context.node.capability,
      billing: "local_compute",
      estimatedCostCny: context.node.estimatedCostCny,
    };
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (context.node.capability !== "research.search") return this.fallback.execute(context);
    const startedAt = this.now();
    const artifactId = context.node.outputArtifactIds[0];
    if (!artifactId) throw new Error("资料节点没有输出产物。");
    const current = asRecord(activeArtifactData(context, artifactId));
    const existingSources = asArray(current.sources);
    const protectedSourceIds = new Set(asArray(asRecord(activeArtifactData(context, "artifact-claims")).claims)
      .flatMap((claim) => asArray(asRecord(claim).sourceIds))
      .filter((sourceId): sourceId is string => typeof sourceId === "string"));
    const auditText = JSON.stringify(asArray(asRecord(activeArtifactData(context, "artifact-research-audit")).findings));
    existingSources.forEach((source) => {
      const sourceId = asRecord(source).id;
      if (typeof sourceId === "string" && auditText.includes(sourceId)) protectedSourceIds.add(sourceId);
    });

    const plan = researchQueries(context);
    const queries = plan.queries;
    // 公共论文索引的前三条常被宽泛主题占据；先多取两条，再按单条检索意图做严格覆盖率过滤。
    const results = [];
    for (const query of queries) {
      results.push(await this.gateway.search({ ...query, maxResultsPerProvider: 5 }, context.signal));
    }
    const attempts = results.flatMap((result, index) => result.attempts.map((attempt) => ({ ...attempt, query: queries[index]?.query })));
    const rawDiscovered = results.flatMap((result) => result.sources);
    const queryTexts = queries.map((query) => query.query);
    const discovered = plan.explicit ? rankRelevantSources(rawDiscovered, queryTexts) : rawDiscovered;
    const refreshedProviderIds = new Set(attempts
      .filter((attempt) => attempt.status === "succeeded")
      .map((attempt) => attempt.providerId));
    const sources = mergeSources(existingSources, discovered, refreshedProviderIds, protectedSourceIds);
    const researchSources = sources.flatMap(asResearchSource);
    const apiChecks = researchSources.flatMap((source) => scholarlyMetadataCheck(source, this.now()));
    const checkedByApi = new Set(apiChecks.map((check) => check.sourceId));
    const webChecks = await this.verifier.verify(researchSources.filter((source) => !checkedByApi.has(source.id)), context.signal);
    const checks = [...apiChecks, ...webChecks];
    const checkedSources = applyChecks(sources, checks);
    const checkedReview = reviewResearchPacket({ status: "machine_checked", sources: checkedSources });
    const failedAttempts = attempts.filter((attempt) => attempt.status === "failed");
    const previousResearch = asRecord(current.research);
    const previousAutoGaps = new Set(asArray(previousResearch.autoGaps).filter((gap): gap is string => typeof gap === "string"));
    const humanGaps = asArray(current.gaps).filter((gap): gap is string =>
      typeof gap === "string" && gap.trim().length > 0 && !previousAutoGaps.has(gap),
    );
    const autoGaps = [
      ...failedAttempts.map((attempt) => `${attempt.providerLabel}：${attempt.error ?? "检索失败"}`),
      ...(sources.length === 0 ? ["自动研究没有找到可用来源，请检查公开来源连接或补充原始报道、论文、机构材料。"] : []),
      ...(checks.filter((check) => check.status === "failed").map((check) => `${check.sourceId}：${check.error ?? "机器核验失败"}`)),
    ];
    const gaps = [...humanGaps, ...autoGaps];

    return {
      status: checkedReview.ready ? "succeeded" : "failed",
      providerId: "research-agent-orchestrator",
      modelId: `${researchRouteId(attempts)}+source-verification-v2`,
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt,
      finishedAt: this.now(),
      outputs: {
        [artifactId]: {
          ...current,
          status: checkedReview.ready ? "machine_checked" : "needs_research",
          sourceKind: "agent_discovery",
          verifiedIndependentSourceCount: checkedReview.verifiedIndependentSourceCount,
          sources: checkedSources,
          gaps: [...new Set(gaps)],
          research: {
            queries: queryTexts,
            searchedAt: this.now(),
            attempts,
            checks,
            autoGaps,
          },
          checklist: [
            "机器已固定 HTTPS 可达性、页面元数据与内容指纹，不等同于人工事实背书",
            "每条可播事实必须绑定来源 ID，并由独立审计 Agent 检查限定语和证据边界",
            "只有彼此独立的来源域名才能计入 verifiedIndependentSourceCount",
          ],
          note: checkedReview.ready
            ? "资料包已通过机器来源核验；后续论点和脚本仍必须保持来源 ID 与限定语可追溯。"
            : "自动来源核验尚未形成两个独立的可访问来源；系统不会伪造事实或把发现线索标成可信证据。",
        },
      },
      ...(checkedReview.ready ? {} : { errorMessage: "自动来源核验未形成两个独立的可访问来源。" }),
    };
  }

  async discard(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<void> {
    await this.fallback.discard?.(context, outcome);
  }

  async commit(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<NodeExecutionOutcome> {
    return await this.fallback.commit?.(context, outcome) ?? outcome;
  }
}

interface PlannedResearchQuery {
  query: string;
  sourceKinds?: Array<"scholarly" | "primary" | "book" | "web">;
}

function researchQueries(context: NodeExecutionContext): { queries: PlannedResearchQuery[]; explicit: boolean } {
  const planned = asArray(asRecord(activeArtifactData(context, "artifact-research-plan")).queries).flatMap((value) => {
    const record = asRecord(value);
    const query = record.query;
    if (typeof query !== "string" || query.trim().length < 2) return [];
    const sourceKinds = asArray(record.sourceKinds).filter((kind): kind is "scholarly" | "primary" | "book" | "web" =>
      kind === "scholarly" || kind === "primary" || kind === "book" || kind === "web",
    );
    return [{ query: query.trim().slice(0, 240), ...(sourceKinds.length > 0 ? { sourceKinds: [...new Set(sourceKinds)] } : {}) }];
  });
  if (planned.length > 0) {
    return { queries: [...new Map(planned.map((entry) => [entry.query, entry])).values()].slice(0, 6), explicit: true };
  }
  const brief = asRecord(activeArtifactData(context, "artifact-brief"));
  const values = [brief.title, brief.centralQuestion, brief.hook, context.run.title]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return { queries: [{ query: [...new Set(values)].join(" ").slice(0, 240) }], explicit: false };
}

function activeArtifactData(context: NodePlanningContext, artifactId: string): unknown {
  const artifact = context.run.artifacts.find((candidate) => candidate.id === artifactId);
  return activeVersion(artifact)?.data;
}

function activeVersion(artifact: Artifact | undefined): Artifact["versions"][number] | undefined {
  return artifact?.versions.find((version) => version.id === artifact.activeVersionId);
}

function mergeSources(
  existing: unknown[],
  discovered: ResearchSource[],
  refreshedProviderIds: Set<string>,
  protectedSourceIds: Set<string>,
): unknown[] {
  const merged = new Map<string, unknown>();
  existing.forEach((source, index) => {
    const record = asRecord(source);
    const providerId = typeof record.providerId === "string" ? record.providerId : undefined;
    const sourceId = typeof record.id === "string" ? record.id : undefined;
    const isReplaceableDiscovery = providerId
      && refreshedProviderIds.has(providerId)
      && record.verificationStatus !== "verified"
      && (!sourceId || !protectedSourceIds.has(sourceId));
    if (!isReplaceableDiscovery) merged.set(sourceKey(source, `existing-${index}`), source);
  });
  discovered.forEach((source) => {
    if (!merged.has(source.url)) merged.set(source.url, source);
  });
  return [...merged.values()];
}

function sourceKey(value: unknown, fallback: string): string {
  const record = asRecord(value);
  return canonicalizeHttpsUrl(typeof record.url === "string" ? record.url.trim() : undefined) ?? fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asResearchSource(value: unknown): ResearchSource[] {
  const source = asRecord(value);
  if (typeof source.id !== "string" || typeof source.title !== "string" || typeof source.url !== "string") return [];
  const url = canonicalizeHttpsUrl(source.url);
  if (!url) return [];
  return [{
    id: source.id,
    title: source.title,
    url,
    providerId: typeof source.providerId === "string" ? source.providerId : "manual-source",
    providerLabel: typeof source.providerLabel === "string" ? source.providerLabel : "编辑来源",
    sourceKind: source.sourceKind === "encyclopedia" || source.sourceKind === "scholarly_metadata" || source.sourceKind === "book_metadata" ? source.sourceKind : "web",
    verificationStatus: "unverified",
    discoveredAt: typeof source.discoveredAt === "string" ? source.discoveredAt : "1970-01-01T00:00:00.000Z",
    ...(typeof source.publisher === "string" ? { publisher: source.publisher } : {}),
    ...(typeof source.excerpt === "string" ? { excerpt: source.excerpt } : {}),
    ...(Array.isArray(source.authors) ? { authors: source.authors.filter((author): author is string => typeof author === "string") } : {}),
  }];
}

function applyChecks(sources: unknown[], checks: SourceVerificationCheck[]): unknown[] {
  const byId = new Map(checks.map((check) => [check.sourceId, check]));
  return sources.map((value) => {
    const source = { ...asRecord(value) };
    const check = typeof source.id === "string" ? byId.get(source.id) : undefined;
    if (!check) return source;
    if (check.status !== "checked") {
      source.verificationStatus = "unverified";
      source.lastCheckedAt = check.checkedAt;
      source.verificationError = check.error;
      return source;
    }
    return {
      ...source,
      verificationStatus: "machine_checked",
      machineCheckedAt: check.checkedAt,
      verificationMethod: check.verificationMethod ?? "safe_https_metadata",
      provenanceGroup: check.provenanceGroup,
      responseContentType: check.responseContentType,
      responseSha256: check.responseSha256,
      ...(check.pageTitle ? { pageTitle: check.pageTitle } : {}),
      ...(check.excerpt ? { excerpt: check.excerpt } : {}),
    };
  });
}

function scholarlyMetadataCheck(source: ResearchSource, checkedAt: string): SourceVerificationCheck[] {
  if (source.sourceKind !== "scholarly_metadata" && source.sourceKind !== "book_metadata") return [];
  const publisher = source.publisher?.trim().toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, "-").replace(/^-|-$/g, "");
  const authorTeam = source.sourceKind === "scholarly_metadata" ? provenanceAuthorTeam(source.authors) : undefined;
  return [{
    sourceId: source.id,
    url: source.url,
    status: "checked",
    checkedAt,
    verificationMethod: "public_api_metadata",
    provenanceGroup: authorTeam ? `authors:${authorTeam}` : publisher ? `publisher:${publisher}` : `provider:${source.providerId}`,
    responseContentType: source.sourceKind === "book_metadata"
      ? "application/vnd.token-talk.public-book-metadata+json"
      : "application/vnd.token-talk.public-scholarly-metadata+json",
    responseSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    pageTitle: source.title,
    ...(source.excerpt ? { excerpt: source.excerpt } : {}),
  }];
}

function provenanceAuthorTeam(authors: string[] | undefined): string | undefined {
  const normalized = (authors ?? []).slice(0, 3).map((author) => author.trim().toLowerCase()
    .replace(/[^a-z0-9\p{L}]+/gu, "-").replace(/^-|-$/g, "")).filter(Boolean);
  return normalized.length > 0 ? normalized.join("+") : undefined;
}

function rankRelevantSources(sources: ResearchSource[], queries: string[]): ResearchSource[] {
  const queryProfiles = queries.map((query) => ({ terms: queryTerms(query), phrases: topicPhrases(query) }))
    .filter((profile) => profile.terms.length > 0);
  const requiresAiContext = queries.some((query) => /(?:\bai\b|人工智能|生成式)/iu.test(query));
  const requiresProgrammingContext = queries.some((query) =>
    /(?:\bcode\b|coding|programming|programmer|developer|software engineer|编程|代码|开发者|程序员)/iu.test(query),
  );
  const ranked = sources.map((source) => {
    const haystack = `${source.title} ${source.excerpt ?? ""}`.toLowerCase();
    const normalizedHaystack = normalizeWords(haystack);
    const bestMatch = queryProfiles.map(({ terms, phrases }) => {
      const matchedTerms = terms.filter((term) => normalizedHaystack.includes(term));
      const matchedPhrases = phrases.filter((phrase) => normalizedHaystack.includes(phrase));
      return { matchedTerms, matchedPhrases, coverage: matchedTerms.length / terms.length };
    }).sort((left, right) => right.coverage - left.coverage || right.matchedTerms.length - left.matchedTerms.length)[0]
      ?? { matchedTerms: [], matchedPhrases: [], coverage: 0 };
    const hasAiContext = /(?:\bai\b|chatgpt|copilot|large language model|\bllm\b|generative artificial intelligence|生成式|人工智能)/iu.test(haystack);
    const hasProgrammingContext = /(?:programmer|developer|software engineering|code generation|code review|coding|programming|debugging|\bbug\b|编程|代码|开发者|程序员)/iu.test(haystack);
    const relevanceScore = Math.round((bestMatch.coverage * 10 + bestMatch.matchedTerms.length * 2 + (source.excerpt ? 1 : 0)) * 10) / 10;
    return {
      ...source,
      relevanceScore,
      matchedTerms: bestMatch.matchedTerms,
      matchedPhrases: bestMatch.matchedPhrases,
      queryCoverage: bestMatch.coverage,
      hasAiContext,
      hasProgrammingContext,
    };
  }).filter((source) => source.matchedTerms.length >= 2
      && source.queryCoverage >= 1 / 3
      && source.matchedPhrases.length > 0
      && (!requiresAiContext || source.hasAiContext)
      && (!requiresProgrammingContext || source.hasProgrammingContext))
    .sort((left, right) => right.relevanceScore - left.relevanceScore);
  const seenTitles = new Set<string>();
  return ranked.filter((source) => {
    const title = normalizeWords(source.title);
    if (seenTitles.has(title)) return false;
    seenTitles.add(title);
    return true;
  }).slice(0, 24);
}

function topicPhrases(value: string): string[] {
  const methodTerms = new Set([
    "controlled", "empirical", "field", "longitudinal", "randomized", "research", "study", "trial",
  ]);
  const words = normalizeWords(value).split(" ").filter((word) => word.length >= 2 && !methodTerms.has(word));
  return [...new Set(words.slice(0, -1).flatMap((word, index) => {
    const next = words[index + 1];
    return next ? [`${word} ${next}`] : [];
  }))];
}

function normalizeWords(value: string): string {
  return value.toLowerCase()
    .replace(/code[- ]generating models?/gu, " ai code assistant ")
    .replace(/large language models?|generative artificial intelligence|generative ai|chatgpt|github copilot|copilot|\bllms?\b/gu, " ai ")
    .replace(/software engineers?|software developers?|programmers?|developers?/gu, " developer ")
    .replace(/coding|programming/gu, " code ")
    .replace(/comprehension|understanding/gu, " comprehension ")
    .replace(/[^a-z0-9+#\p{Script=Han}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function queryTerms(value: string): string[] {
  const stop = new Set([
    "about", "agent", "analysis", "artificial", "based", "effect", "effects", "empirical", "generative",
    "controlled", "experiment", "field", "human", "impact", "intelligence", "longitudinal", "randomized",
    "research", "study", "trial", "using", "with",
  ]);
  const latin = normalizeWords(value).match(/[a-z][a-z0-9+#.-]{1,}/g)?.filter((term) => !stop.has(term)) ?? [];
  const chinese = value.match(/[\p{Script=Han}]{2,8}/gu) ?? [];
  return [...new Set([...latin, ...chinese])].slice(0, 40);
}

function researchRouteId(attempts: Array<{ providerId: string; status: "succeeded" | "failed" }>): string {
  if (attempts.length === 0) return "free-multi-source-discovery:no-attempts";
  return attempts.map((attempt) => `${attempt.providerId}:${attempt.status}`).join("+");
}
