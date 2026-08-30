import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EpisodeCandidateSchema,
  EpisodeOpportunitySchema,
  podcastChapterPlanIssues,
  PublicationRecordSchema,
  SeriesBibleSchema,
  SpendAuthorizationSchema,
  type EpisodeCandidate,
  type EpisodeOpportunity,
  type SeriesBible,
  type StudioSnapshot,
  type WorkflowRun,
} from "@token-talk/domain";
import { createSeedSnapshot } from "@token-talk/domain";
import {
  applyNodeExecution,
  artifactDataSha256,
  beginNodeExecution,
  createRunFromCandidate,
  JsonStudioRepository,
  recoverInterruptedExecutions,
  reviseArtifact,
  synchronizeRun,
  type NodeExecutionOutcome,
} from "@token-talk/workflow";
import type {
  AuthorizeNodeSpendInput,
  AgentLoopResult,
  CreateCustomOpportunityInput,
  CreateSeriesInput,
  ExecuteNodeInput,
  NodeExecutionPreview,
  ReconcileExecutionCostInput,
  RegisterPublicationInput,
  RegisterPublicationResponse,
  StartEpisodeInput,
} from "../shared/api.js";
import { ReleasePackageSchema, type ReleasePackage } from "../shared/api.js";
import type { StoredReleaseAsset } from "./release-asset-store.js";
import { CandidateStudio, type CandidateInbox } from "./candidate-studio.js";
import type { PodcastEditorialModel } from "./editorial-model.js";
import type { NodeExecutor } from "./node-executor.js";
import { sanitizeResearchPacketRevision, setResearchSourceVerification } from "./research-ledger.js";
import { TrendGateway } from "./trend-gateway.js";
import { TrendHistoryStore } from "./trend-history.js";
import { TrendCollector, type TrendCollectorStatus } from "./trend-collector.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";

export class StudioService {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly executingNodes = new Set<string>();
  private readonly detachedExecutions = new Map<string, Promise<void>>();
  private closePromise?: Promise<void>;

  private constructor(
    private readonly repository: JsonStudioRepository,
    private readonly now: () => string,
    private readonly candidates: CandidateStudio,
    private readonly trendCollector: TrendCollector,
    private readonly nodeExecutor: NodeExecutor,
    private readonly releaseWorkspaceLease: () => Promise<void>,
  ) {}

  static async create(
    workspaceRoot: string,
    now: () => string,
    trendGateway: Pick<TrendGateway, "listSignals"> = new TrendGateway({ now }),
    editorialModel?: PodcastEditorialModel | null,
    nodeExecutor?: NodeExecutor,
    trendCollectionIntervalMs?: number,
  ): Promise<StudioService> {
    const releaseWorkspaceLease = await acquireWorkspaceLease(workspaceRoot);
    try {
      await rm(join(workspaceRoot, ".studio-staging"), { recursive: true, force: true });
      const repository = await JsonStudioRepository.open(workspaceRoot, () => createSeedSnapshot(now()));
      if (!nodeExecutor) throw new Error("Studio requires a node executor");
      const snapshot = await repository.load();
      const abandonedRunIds = new Set(snapshot.runs.filter(hasRunningExecution).map((run) => run.id));
      if (abandonedRunIds.size > 0) {
        const recoveredAt = now();
        snapshot.runs = snapshot.runs.map((run) => abandonedRunIds.has(run.id) ? recoverInterruptedExecutions(run, recoveredAt) : run);
        snapshot.updatedAt = recoveredAt;
        await repository.save(snapshot);
      }
      const candidates = new CandidateStudio({
        gateway: trendGateway,
        history: new TrendHistoryStore(workspaceRoot),
        now: () => new Date(now()),
        ...(editorialModel === undefined ? {} : { model: editorialModel }),
      });
      const trendCollector = new TrendCollector(async () => candidates.list(await repository.load(), true), {
        now,
        ...(trendCollectionIntervalMs === undefined ? {} : { intervalMs: trendCollectionIntervalMs }),
      });
      const service = new StudioService(repository, now, candidates, trendCollector, nodeExecutor, releaseWorkspaceLease);
      trendCollector.start();
      return service;
    } catch (error) {
      await releaseWorkspaceLease();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      await this.trendCollector.close();
      await Promise.allSettled([...this.detachedExecutions.values()]);
      await this.releaseWorkspaceLease();
    })();
    await this.closePromise;
  }

  async bootstrap(): Promise<StudioSnapshot> {
    return this.repository.load();
  }

  async releasePackage(runId: string): Promise<ReleasePackage> {
    const snapshot = await this.repository.load();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
    if (run.executionReceipts.some((receipt) => receipt.nodeId === "audio-audit" && receipt.status === "running" && !receipt.finishedAt)) {
      throw new StudioConflictError("成片质量审计正在进行，旧发布包已失效。");
    }
    if (!["release_ready", "completed"].includes(run.status)) throw new StudioConflictError("本集尚未通过发布检查，不能导出发行清单。");
    assertPublishNodeSucceeded(run);
    const artifact = run.artifacts.find((candidate) => ["publish.package", "publish-package"].includes(candidate.kind));
    const version = artifact?.versions.find((candidate) => candidate.id === artifact.activeVersionId);
    if (version && artifactDataSha256(version.data) !== version.sha256) {
      throw new StudioConflictError("当前发布包内容与校验值不一致，请重新运行发布检查。");
    }
    const parsed = ReleasePackageSchema.safeParse(version?.data);
    if (!parsed.success) throw new StudioConflictError("当前发布包不完整，请重新运行发布检查。");
    const audioAudit = run.artifacts.find((candidate) => ["audio.audit", "audio-audit"].includes(candidate.kind));
    if (!audioAudit || parsed.data.audioAuditArtifactVersionId !== audioAudit.activeVersionId) {
      throw new StudioConflictError("发布包绑定的成片质量审计已过期，请重新运行发布检查。");
    }
    if (run.status === "completed" && (!version || !hasPublicationBinding(run, version, parsed.data))) {
      throw new StudioConflictError("当前发布包与外部发布记录不匹配，已停止导出。");
    }
    return parsed.data;
  }

  async registerPublication(runId: string, input: RegisterPublicationInput): Promise<RegisterPublicationResponse> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((candidate) => candidate.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      const existing = run.publicationRecords.find((record) => record.requestId === input.requestId);
      if (existing) {
        if (!publicationMatchesInput(existing, input)) throw new StudioConflictError("发布登记请求标识已被另一条记录使用。");
        const opportunity = publicationOpportunity(snapshot, run);
        return { run, ...(opportunity ? { opportunity } : {}), record: existing };
      }
      if (!["release_ready", "completed"].includes(run.status)) {
        throw new StudioConflictError("只有通过发布检查的单集才能登记外部发布结果。");
      }
      if (hasRunningExecution(run)) throw new StudioConflictError("当前仍有制作步骤在执行，不能登记外部发布结果。");
      assertPublishNodeSucceeded(run);
      const artifact = run.artifacts.find((candidate) => ["publish.package", "publish-package"].includes(candidate.kind));
      const version = artifact?.versions.find((candidate) => candidate.id === artifact.activeVersionId);
      if (version && artifactDataSha256(version.data) !== version.sha256) {
        throw new StudioConflictError("当前发布包内容与校验值不一致，请重新运行发布检查。");
      }
      const releasePackage = ReleasePackageSchema.safeParse(version?.data);
      if (!artifact || !version || !releasePackage.success) throw new StudioConflictError("当前发布包不完整，请重新运行发布检查。");
      if (run.status === "completed" && !hasPublicationBinding(run, version, releasePackage.data)) {
        throw new StudioConflictError("当前发布包与已有外部发布记录不匹配，不能追加平台。");
      }
      const audioAudit = run.artifacts.find((candidate) => ["audio.audit", "audio-audit"].includes(candidate.kind));
      if (!audioAudit || releasePackage.data.audioAuditArtifactVersionId !== audioAudit.activeVersionId) {
        throw new StudioConflictError("当前发布包绑定的成片质量审计已过期，请重新运行发布检查。");
      }
      const recordedAt = this.now();
      const eventAt = input.status === "published" ? input.publishedAt : input.attemptedAt;
      if (Date.parse(eventAt) > Date.parse(recordedAt) + 5 * 60_000) {
        throw new StudioConflictError(input.status === "published" ? "发布时间不能晚于当前时间。" : "失败时间不能晚于当前时间。");
      }
      if (input.status === "published") {
        const unreconciled = run.executionReceipts.some((receipt) => receipt.billing === "metered" && receipt.status !== "running" && receipt.actualCostCny === undefined);
        if (unreconciled) throw new StudioConflictError("本集仍有按次费用未对账，完成对账后才能登记已发布。");
        const duplicate = run.publicationRecords.find((record) => record.status === "published" && (
          record.episodeUrl === input.episodeUrl
          || (record.platform.toLowerCase() === input.platform.toLowerCase() && record.externalEpisodeId === input.externalEpisodeId)
        ));
        if (duplicate) throw new StudioConflictError("这个外部节目已经登记，不能重复记账。");
      }
      const record = PublicationRecordSchema.parse({
        id: `publication-${randomUUID()}`,
        ...input,
        releasePackageVersionId: version.id,
        releasePackageSha256: version.sha256,
        audioSha256: releasePackage.data.checksums.audioSha256,
        coverSha256: releasePackage.data.checksums.coverSha256,
        registeredAt: recordedAt,
      });
      run.publicationRecords.push(record);
      if (record.status === "published") run.status = "completed";
      run.updatedAt = recordedAt;
      snapshot.runs[index] = run;
      synchronizeOpportunityStatus(snapshot, run);
      snapshot.updatedAt = recordedAt;
      await this.repository.save(snapshot);
      const opportunity = publicationOpportunity(snapshot, run);
      return { run, ...(opportunity ? { opportunity } : {}), record };
    });
  }

  async createSeries(input: CreateSeriesInput): Promise<SeriesBible> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const existing = snapshot.series.find((series) => series.creationRequestId === input.requestId);
      if (existing) return existing;
      const series = SeriesBibleSchema.parse({
        id: `series-${randomUUID()}`,
        creationRequestId: input.requestId,
        title: input.title,
        promise: input.promise,
        audience: input.audience,
        castPolicy: input.castPolicy,
        sonicBible: { musicPolicy: input.musicPolicy, palette: [], exclusions: [] },
        memory: [],
      });
      snapshot.series.push(series);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return series;
    });
  }

  async listCandidates(force = false): Promise<CandidateInbox & { collector: TrendCollectorStatus }> {
    const value = await this.candidates.listResponsive(await this.repository.load(), force);
    // 免费数据源和本地模型可以慢，但不能阻塞工作台；后续轮询会接住后台完成的新快照。
    const collector = this.trendCollector.status();
    if (
      value.freshness.status === "fallback"
      || !collector.lastAttemptAt
      || collector.state === "collecting"
      || collector.lastSuccessfulAt !== value.fetchedAt
    ) this.trendCollector.observe(value);
    return { ...value, collector: this.trendCollector.status() };
  }

  async adoptCandidate(candidateId: string, verificationConfirmed: boolean): Promise<EpisodeOpportunity> {
    const candidate = await this.candidates.find(await this.repository.load(), candidateId);
    if (!candidate) throw new StudioNotFoundError(`Candidate '${candidateId}' was not found`);
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      return this.createOpportunity(snapshot, candidate, verificationConfirmed);
    });
  }

  async adoptCustom(input: CreateCustomOpportunityInput): Promise<EpisodeOpportunity> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const candidateId = `candidate-custom-${input.requestId}`;
      const existing = snapshot.opportunities.find((item) => item.candidateId === candidateId);
      if (existing) return existing;
      const targetMinutes = input.targetMinutes;
      const candidate = EpisodeCandidateSchema.parse({
        id: candidateId,
        origin: "custom",
        title: input.title,
        hook: input.hook,
        rationale: "由主编直接提出，进入统一的资料、角色、脚本与声音制作流程。",
        category: "other",
        platform: "主编提案",
        suggestedRoles: ["本期主持", "观点挑战者", "事实核验者"],
        verdict: targetMinutes <= 25 ? "rapid_brief" : "deep_discussion",
        targetMinutes: targetMinutes <= 25 ? { min: 15, max: 25 } : { min: Math.max(15, targetMinutes - 8), max: Math.min(240, targetMinutes + 12) },
        score: {
          overall: 76,
          audienceRelevance: 72,
          conversationPotential: 82,
          evidenceDepth: 45,
          longformDepth: targetMinutes > 25 ? 88 : 76,
          freshness: 70,
          seriesFit: 70,
          feasibility: 88,
          risk: 20,
        },
        evidence: [],
        verification: { status: "review_required", reason: "资料编辑需要在制作前建立来源账本。", independentSources: 0 },
        editorial: {
          whyNow: "这是主编当前最想回答的问题，不依赖外部热度成立。",
          centralQuestion: input.hook,
          listenerPromise: "围绕一个明确问题，给出可追溯、可争论且值得听完的回答。",
          selectionReasons: ["来自主编原创判断", "已明确核心追问", "可进入统一制作流程"],
          signalPlatforms: ["主编提案"],
          signalCount: 1,
          provider: "human",
        },
        generatedAt: this.now(),
      });
      return this.createOpportunity(snapshot, candidate, true);
    });
  }

  async startOpportunity(opportunityId: string, input: StartEpisodeInput): Promise<{ opportunity: EpisodeOpportunity; run: WorkflowRun }> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.opportunities.findIndex((item) => item.id === opportunityId);
      const opportunity = snapshot.opportunities[index];
      if (!opportunity) throw new StudioNotFoundError(`Opportunity '${opportunityId}' was not found`);
      if (opportunity.runId) {
        const existingRun = snapshot.runs.find((run) => run.id === opportunity.runId);
        if (existingRun) return { opportunity, run: existingRun };
      }
      const recipe = snapshot.recipes.find((item) => item.id === input.recipeId);
      if (!recipe) throw new StudioNotFoundError(`Recipe '${input.recipeId}' was not found`);
      const needsFactLedger = opportunity.candidate.origin === "trend"
        && (opportunity.candidate.verification.status !== "ready" || opportunity.candidate.verification.independentSources < 2);
      if (needsFactLedger && !recipe.capabilityIds.includes("research.claims")) {
        throw new StudioConflictError("该候选必须先建立事实账本，不能使用省略事实核验的快速制作配方。");
      }

      const candidate = EpisodeCandidateSchema.parse({
        ...opportunity.candidate,
        title: input.title,
        hook: input.hook,
        editorial: {
          whyNow: opportunity.candidate.editorial?.whyNow ?? opportunity.candidate.rationale,
          centralQuestion: input.centralQuestion,
          listenerPromise: input.listenerPromise,
          selectionReasons: opportunity.candidate.editorial?.selectionReasons ?? [opportunity.candidate.rationale],
          signalPlatforms: opportunity.candidate.editorial?.signalPlatforms ?? [opportunity.candidate.platform],
          signalCount: opportunity.candidate.editorial?.signalCount ?? opportunity.candidate.evidence.length,
          provider: opportunity.candidate.editorial?.provider ?? "human",
        },
        targetMinutes: {
          min: Math.max(15, input.targetMinutes - (input.targetMinutes <= 25 ? 5 : 10)),
          max: Math.min(240, input.targetMinutes + (input.targetMinutes <= 25 ? 5 : 15)),
        },
      });
      const seriesId = candidate.seriesId ?? ensureTrendSeries(snapshot);
      const series = snapshot.series.find((item) => item.id === seriesId);
      const run = createRunFromCandidate(candidate, {
        id: `run-${randomUUID()}`,
        opportunityId,
        seriesId,
        recipeId: recipe.id,
        productionIntent: {
          hook: input.hook,
          targetMinutes: input.targetMinutes,
          musicPolicy: input.musicPolicy,
          budgetPolicy: input.budgetPolicy,
          maxCostCny: input.maxCostCny,
          castPolicy: series?.castPolicy ?? { mode: "dynamic", recurringRoleIds: [], roles: [] },
          sonicPalette: series?.sonicBible.palette ?? [],
          sonicExclusions: series?.sonicBible.exclusions ?? [],
        },
        now: this.now(),
      });
      const started = EpisodeOpportunitySchema.parse({
        ...opportunity,
        title: input.title,
        candidate,
        status: "in_production",
        runId: run.id,
      });
      snapshot.opportunities[index] = started;
      snapshot.runs.unshift(run);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return { opportunity: started, run };
    });
  }

  async reviseArtifact(runId: string, artifactId: string, data: unknown): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((run) => run.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      assertRunNotPublished(run);
      const existingArtifact = run.artifacts.find((candidate) => candidate.id === artifactId);
      if (!existingArtifact) throw new StudioNotFoundError(`Artifact '${artifactId}' was not found`);
      const activeVersion = existingArtifact.versions.find((version) => version.id === existingArtifact.activeVersionId);
      assertProtectedArtifactFieldsUnchanged(existingArtifact.kind, data, activeVersion?.data);
      assertSeriesCastPolicyPreserved(run, existingArtifact.kind, data);
      assertPodcastBlueprintRevision(run, existingArtifact.kind, data);
      let revisedData = data;
      if (["research.packet", "source-packet"].includes(existingArtifact.kind)) {
        try {
          revisedData = sanitizeResearchPacketRevision(data, activeVersion?.data);
        } catch (error) {
          if (error instanceof Error) throw new StudioConflictError(error.message);
          throw error;
        }
      }
      let revised: WorkflowRun;
      try {
        revised = reviseArtifact(run, artifactId, revisedData, this.now());
      } catch (error) {
        if (error instanceof Error && error.message.includes("was not found")) throw new StudioNotFoundError(error.message);
        throw error;
      }
      const artifact = revised.artifacts.find((candidate) => candidate.id === artifactId);
      if (artifact && ["research.packet", "source-packet"].includes(artifact.kind)) {
        const producer = revised.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId));
        if (producer) {
          producer.status = "stale";
          producer.staleReason = "来源账本已由人工更新，需要重新通过来源核验";
        }
      }
      snapshot.runs[index] = revised;
      synchronizeOpportunityStatus(snapshot, revised);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return revised;
    });
  }

  async registerReleaseMaster(runId: string, stored: StoredReleaseAsset): Promise<WorkflowRun> {
    return this.registerReleaseAsset(runId, ["audio.master", "audio-master"], stored.data, (current) => ({ ...current, ...stored.data }));
  }

  async registerCover(runId: string, stored: StoredReleaseAsset): Promise<WorkflowRun> {
    return this.registerReleaseAsset(runId, ["visual.pack", "visual-pack"], stored.data, (current) => {
      const coverId = typeof stored.data.id === "string" ? stored.data.id : undefined;
      if (!coverId) throw new StudioConflictError("封面登记结果缺少有效标识。");
      const existing = Array.isArray(current.covers) ? current.covers.filter((cover) => {
        return !cover || typeof cover !== "object" || Array.isArray(cover) || (cover as Record<string, unknown>).sha256 !== stored.data.sha256;
      }) : [];
      const selectedCoverId = typeof current.selectedCoverId === "string"
        && existing.some((cover) => cover && typeof cover === "object" && !Array.isArray(cover) && (cover as Record<string, unknown>).id === current.selectedCoverId)
        ? current.selectedCoverId
        : undefined;
      return { ...current, status: selectedCoverId ? "cover_ready" : "needs_selection", covers: [stored.data, ...existing], selectedCoverId };
    });
  }

  async selectCover(runId: string, coverId: string): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((run) => run.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      assertRunNotPublished(run);
      const artifact = run.artifacts.find((candidate) => ["visual.pack", "visual-pack"].includes(candidate.kind));
      if (!artifact) throw new StudioNotFoundError("单集封面产物不存在。");
      const active = artifact.versions.find((version) => version.id === artifact.activeVersionId);
      const current = active?.data && typeof active.data === "object" && !Array.isArray(active.data)
        ? active.data as Record<string, unknown>
        : {};
      const covers = Array.isArray(current.covers) ? current.covers : [];
      const selected = covers.find((cover) => cover && typeof cover === "object" && !Array.isArray(cover) && (cover as Record<string, unknown>).id === coverId);
      if (!selected) throw new StudioConflictError("所选封面不在当前候选中，请重新选择。");
      const revised = reviseArtifact(run, artifact.id, { ...current, status: "cover_ready", selectedCoverId: coverId }, this.now());
      snapshot.runs[index] = revised;
      synchronizeOpportunityStatus(snapshot, revised);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return revised;
    });
  }

  private async registerReleaseAsset(
    runId: string,
    artifactKinds: ["audio.master", "audio-master"] | ["visual.pack", "visual-pack"],
    storedData: Record<string, unknown>,
    merge: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((run) => run.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      assertRunNotPublished(run);
      const artifact = run.artifacts.find((candidate) => (artifactKinds as readonly string[]).includes(candidate.kind));
      if (!artifact) throw new StudioNotFoundError(`Artifact '${artifactKinds[0]}' was not found`);
      const producer = run.nodes.find((node) => node.outputArtifactIds.includes(artifact.id));
      if (!producer) throw new StudioConflictError("登记资产没有对应的制作步骤。");
      assertAssetRegistrationReady(run, producer);
      if (artifactKinds[0] === "audio.master") assertReleaseMasterDuration(run, storedData);
      const active = artifact.versions.find((version) => version.id === artifact.activeVersionId);
      const current = active?.data && typeof active.data === "object" && !Array.isArray(active.data)
        ? active.data as Record<string, unknown>
        : {};
      const revised = reviseArtifact(run, artifact.id, merge(current), this.now());
      completeRegisteredAssetProducer(revised, artifact.id, artifactKinds[0], this.now());
      const synchronized = synchronizeRun(revised);
      snapshot.runs[index] = synchronized;
      synchronizeOpportunityStatus(snapshot, synchronized);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return synchronized;
    });
  }

  async reviewResearchSource(
    runId: string,
    artifactId: string,
    sourceId: string,
    verified: boolean,
  ): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((run) => run.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      assertRunNotPublished(run);
      const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact || !["research.packet", "source-packet"].includes(artifact.kind)) {
        throw new StudioNotFoundError(`Research artifact '${artifactId}' was not found`);
      }
      const activeVersion = artifact.versions.find((version) => version.id === artifact.activeVersionId);
      let reviewedData: Record<string, unknown>;
      try {
        reviewedData = setResearchSourceVerification(activeVersion?.data, sourceId, verified, this.now());
      } catch (error) {
        if (error instanceof Error && error.message.includes("was not found")) throw new StudioNotFoundError(error.message);
        if (error instanceof Error) throw new StudioConflictError(error.message);
        throw error;
      }
      const revised = reviseArtifact(run, artifactId, reviewedData, this.now());
      const producer = revised.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId));
      if (producer) {
        producer.status = "stale";
        producer.staleReason = "来源账本已由人工更新，需要重新通过来源核验";
      }
      snapshot.runs[index] = revised;
      synchronizeOpportunityStatus(snapshot, revised);
      snapshot.updatedAt = this.now();
      await this.repository.save(snapshot);
      return revised;
    });
  }

  async previewNodeExecution(runId: string, nodeId: string): Promise<NodeExecutionPreview> {
    const snapshot = await this.repository.load();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
    const node = run.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new StudioNotFoundError(`Node '${nodeId}' was not found`);
    const plan = this.nodeExecutor.plan?.({ run, node }) ?? {
      providerId: node.providerId ?? "local-production-engine",
      modelId: node.modelId ?? node.capability,
      billing: "local_compute" as const,
      estimatedCostCny: node.estimatedCostCny,
    };
    return executionPreview(run, node, plan, this.now());
  }

  async authorizeNodeSpend(
    runId: string,
    nodeId: string,
    input: AuthorizeNodeSpendInput,
  ): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((candidate) => candidate.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      assertRunNotPublished(run);
      const node = run.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new StudioNotFoundError(`Node '${nodeId}' was not found`);
      if (node.status === "running") throw new StudioConflictError(`节点“${node.label}”正在执行，不能修改成本授权。`);
      const plan = this.nodeExecutor.plan?.({ run, node }) ?? {
        providerId: node.providerId ?? "local-production-engine",
        modelId: node.modelId ?? node.capability,
        billing: "local_compute" as const,
        estimatedCostCny: node.estimatedCostCny,
      };
      if (plan.billing !== "metered") throw new StudioConflictError(`节点“${node.label}”不需要按次成本授权。`);
      if (roundCost(input.maxCostCny) !== roundCost(plan.estimatedCostCny)) {
        throw new StudioConflictError("授权金额必须与当前执行预估完全一致；服务、脚本或声音变化后请重新预览。 ");
      }
      const preview = executionPreview(run, node, plan, this.now());
      if (preview.blocker === "unreconciled_cost") {
        throw new StudioConflictError("本集存在尚未对账的计费执行，确认实际成本前不能创建新授权。 ");
      }
      if (plan.estimatedCostCny > preview.remainingBudgetCny) {
        throw new StudioConflictError(`节点“${node.label}”预计成本超出本集剩余现金上限。`);
      }
      if (preview.authorization === "active" && preview.maxAttempts === input.maxAttempts) return run;

      const approvedAt = this.now();
      const authorization = SpendAuthorizationSchema.parse({
        id: `authorization-${randomUUID()}`,
        nodeId: node.id,
        providerId: plan.providerId,
        modelId: plan.modelId,
        inputVersionIds: activeArtifactVersionIds(run, node.inputArtifactIds),
        maxAttempts: input.maxAttempts,
        maxCostCny: input.maxCostCny,
        approvedAt,
        expiresAt: new Date(Date.parse(approvedAt) + 30 * 60_000).toISOString(),
      });
      run.spendAuthorizations.push(authorization);
      node.authorizedCostCny = input.maxCostCny;
      run.updatedAt = approvedAt;
      snapshot.runs[index] = run;
      snapshot.updatedAt = approvedAt;
      await this.repository.save(snapshot);
      return run;
    });
  }

  async reconcileExecutionCost(runId: string, receiptId: string, input: ReconcileExecutionCostInput): Promise<WorkflowRun> {
    return this.withMutationLock(async () => {
      const snapshot = await this.repository.load();
      const index = snapshot.runs.findIndex((run) => run.id === runId);
      const run = snapshot.runs[index];
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      const receipt = run.executionReceipts.find((candidate) => candidate.id === receiptId);
      if (!receipt) throw new StudioNotFoundError(`Receipt '${receiptId}' was not found`);
      if (this.detachedExecutions.has(receipt.id)) {
        throw new StudioConflictError("执行器尚未确认停止，实际费用仍可能变化，暂时不能完成对账。");
      }
      if (receipt.billing !== "metered") throw new StudioConflictError("只有按次计费的执行可以补录实际成本。");
      if (receipt.status === "running" || !receipt.finishedAt) throw new StudioConflictError("执行仍在进行，不能提前补录实际成本。");
      const actualCostCny = roundCost(input.actualCostCny);
      if (receipt.actualCostCny !== undefined) {
        if (roundCost(receipt.actualCostCny) === actualCostCny) return run;
        throw new StudioConflictError("这笔执行已经完成对账，不能覆盖原始成本记录。");
      }
      const reconciledAt = this.now();
      receipt.actualCostCny = actualCostCny;
      receipt.reconciledAt = reconciledAt;
      receipt.reconciliationNote = input.note;
      receipt.providerInvoiceId = input.providerInvoiceId;
      const node = run.nodes.find((candidate) => candidate.id === receipt.nodeId);
      const latestForNode = [...run.executionReceipts].reverse().find((candidate) => candidate.nodeId === receipt.nodeId);
      if (node && latestForNode?.id === receipt.id) node.actualCostCny = actualCostCny;
      run.updatedAt = reconciledAt;
      snapshot.runs[index] = run;
      snapshot.updatedAt = reconciledAt;
      await this.repository.save(snapshot);
      return run;
    });
  }

  async executeNode(runId: string, nodeId: string, requestSignal?: AbortSignal, input: ExecuteNodeInput = {}): Promise<WorkflowRun> {
    const executionKey = `${runId}:${nodeId}`;
    if (this.executingNodes.has(executionKey)) {
      throw new StudioConflictError("这个制作步骤正在运行，请等待当前执行完成。");
    }
    this.executingNodes.add(executionKey);
    let detachedExecution = false;
    try {
      const prepared = await this.withMutationLock(async () => {
        const snapshot = await this.repository.load();
        const index = snapshot.runs.findIndex((run) => run.id === runId);
        const run = snapshot.runs[index];
        if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
        assertRunNotPublished(run);
        const node = run.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) throw new StudioNotFoundError(`Node '${nodeId}' was not found`);
        assertExecutionInput(run, node, input);
        if (node.status === "pending" || node.status === "running" || node.status === "awaiting_spend_approval") {
          throw new StudioConflictError(`节点“${node.label}”尚未满足执行条件。`);
        }
        const sourceFailureRepair = node.id === "research-repair"
          && run.nodes.some((candidate) => candidate.id === "source-packet" && candidate.status === "failed");
        if (!sourceFailureRepair) {
          for (const prerequisiteId of node.prerequisiteNodeIds) {
            const prerequisite = run.nodes.find((candidate) => candidate.id === prerequisiteId);
            if (!prerequisite) throw new StudioConflictError(`节点“${node.label}”引用了不存在的审核步骤。`);
            if (prerequisite.status !== "succeeded") {
              throw new StudioConflictError(`请先完成审核步骤“${prerequisite.label}”。`);
            }
          }
          const blockingProducer = node.inputArtifactIds
            .map((artifactId) => run.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId)))
            .find((producer) => producer && producer.status !== "succeeded");
          if (blockingProducer) {
            throw new StudioConflictError(`请先完成上游步骤“${blockingProducer.label}”。`);
          }
        }
        const startedAt = this.now();
        const plan = this.nodeExecutor.plan?.({ run, node }) ?? {
          providerId: node.providerId ?? "local-production-engine",
          modelId: node.modelId ?? node.capability,
          billing: "local_compute" as const,
          estimatedCostCny: node.estimatedCostCny,
        };
        assertPlanAuthorized(run, node, plan, startedAt);
        const running = beginNodeExecution(run, nodeId, {
          providerId: plan.providerId,
          modelId: plan.modelId,
          billing: plan.billing,
          estimatedCostCny: plan.estimatedCostCny,
          startedAt,
        });
        const runningNode = running.nodes.find((candidate) => candidate.id === nodeId);
        if (!runningNode) throw new StudioNotFoundError(`Node '${nodeId}' was not found`);
        const runningReceipt = [...running.executionReceipts].reverse().find((receipt) =>
          receipt.nodeId === nodeId && receipt.status === "running" && !receipt.finishedAt,
        );
        if (!runningReceipt) throw new Error("节点执行缺少持久化 attempt receipt");
        snapshot.runs[index] = running;
        snapshot.updatedAt = startedAt;
        await this.repository.save(snapshot);
        return {
          plan,
          startedAt,
          running,
          runningNode,
          retryFeedback: node.lastError,
          attemptId: runningReceipt.id,
          input,
          inputVersionIds: [...runningNode.inputVersionIds],
          outputVersionIds: activeArtifactVersionIds(running, runningNode.outputArtifactIds),
        };
      });

      let outcome;
      try {
        outcome = await executeWithDeadline(
          this.nodeExecutor,
          {
            run: prepared.running,
            node: prepared.runningNode,
            attemptId: prepared.attemptId,
            ...(prepared.retryFeedback ? { retryFeedback: prepared.retryFeedback } : {}),
            ...(prepared.input.segmentId ? { input: prepared.input } : {}),
          },
          prepared.plan.timeoutMs ?? 120_000,
          requestSignal,
        );
      } catch (error) {
        const message = safeExecutionError(error);
        if (error instanceof UnconfirmedExecutionError) {
          detachedExecution = true;
          const settlement = error.pending.then(() => undefined, () => undefined).finally(() => {
            this.detachedExecutions.delete(prepared.attemptId);
            this.executingNodes.delete(executionKey);
          });
          this.detachedExecutions.set(prepared.attemptId, settlement);
        }
        outcome = {
          status: error instanceof UnconfirmedExecutionError ? "needs_human" as const : "failed" as const,
          providerId: prepared.runningNode.providerId ?? "local-production-engine",
          modelId: prepared.runningNode.modelId ?? "execution-error",
          billing: prepared.plan.billing,
          estimatedCostCny: prepared.plan.estimatedCostCny,
          ...(["free", "local_compute"].includes(prepared.plan.billing) ? { actualCostCny: 0 } : {}),
          startedAt: prepared.startedAt,
          finishedAt: this.now(),
          errorMessage: message,
        };
      }

      return await this.withMutationLock(async () => {
        const snapshot = await this.repository.load();
        const index = snapshot.runs.findIndex((run) => run.id === runId);
        const latestRun = snapshot.runs[index];
        if (!latestRun) throw new StudioNotFoundError(`Run '${runId}' was not found`);
        const latestNode = latestRun.nodes.find((candidate) => candidate.id === nodeId);
        if (!latestNode) throw new StudioNotFoundError(`Node '${nodeId}' was not found`);
        const inputsChanged = !sameValues(activeArtifactVersionIds(latestRun, latestNode.inputArtifactIds), prepared.inputVersionIds);
        const outputsChanged = !sameValues(activeArtifactVersionIds(latestRun, latestNode.outputArtifactIds), prepared.outputVersionIds);
        const executionContext = {
          run: prepared.running,
          node: prepared.runningNode,
          attemptId: prepared.attemptId,
          ...(prepared.retryFeedback ? { retryFeedback: prepared.retryFeedback } : {}),
          ...(prepared.input.segmentId ? { input: prepared.input } : {}),
        };
        if (inputsChanged || outputsChanged) {
          await this.nodeExecutor.discard?.(executionContext, outcome);
        }
        let finalOutcome = inputsChanged || outputsChanged
          ? failedExecutionOutcome(outcome, "执行期间输入或人工草稿已更新，本次旧结果未写入，请重新运行。", this.now())
          : outcome;
        let mediaCommitted = false;
        if (!inputsChanged && !outputsChanged && this.nodeExecutor.commit) {
          try {
            finalOutcome = await this.nodeExecutor.commit(executionContext, outcome);
            mediaCommitted = true;
          } catch (error) {
            await this.nodeExecutor.discard?.(executionContext, outcome);
            finalOutcome = failedExecutionOutcome(outcome, `媒体暂存提交失败：${safeExecutionError(error)}`, this.now());
          }
        }
        let executed: WorkflowRun;
        try {
          executed = applyNodeExecution(latestRun, nodeId, finalOutcome, this.now());
          retainScriptNodeUntilEveryChapterExists(executed, nodeId);
        } catch (error) {
          await this.nodeExecutor.discard?.(executionContext, finalOutcome);
          mediaCommitted = false;
          executed = applyNodeExecution(
            latestRun,
            nodeId,
            failedExecutionOutcome(finalOutcome, `执行结果无法写入工作流：${safeExecutionError(error)}`, this.now()),
            this.now(),
          );
        }
        snapshot.runs[index] = executed;
        synchronizeOpportunityStatus(snapshot, executed);
        snapshot.updatedAt = this.now();
        try {
          await this.repository.save(snapshot);
        } catch (error) {
          if (mediaCommitted) {
            try {
              await this.nodeExecutor.discard?.(executionContext, finalOutcome);
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "工作流保存失败，且已提交媒体无法清理。");
            }
          }
          throw error;
        }
        return executed;
      });
    } finally {
      if (!detachedExecution) this.executingNodes.delete(executionKey);
    }
  }

  async continueAgentLoop(runId: string, requestSignal?: AbortSignal, maxExecutedNodes = 40): Promise<AgentLoopResult> {
    const executedNodeIds: string[] = [];
    const stepLimit = Math.max(1, Math.min(40, Math.round(maxExecutedNodes)));
    for (let step = 0; step < stepLimit; step += 1) {
      const snapshot = await this.repository.load();
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
      const availableNodes = run.nodes.filter((candidate) =>
        candidate.status === "ready" || candidate.status === "stale" || candidate.status === "failed");
      if (availableNodes.length === 0) return {
        run,
        executedNodeIds,
        reason: run.nodes.some((candidate) => candidate.status === "failed") ? "failed" : "completed_available_work",
      };

      let selectedNode: WorkflowRun["nodes"][number] | undefined;
      let blocker: Pick<AgentLoopResult, "stoppedAtNodeId" | "reason"> | undefined;
      for (const candidate of availableNodes) {
        if (candidate.status === "failed") {
          const dedicatedRepair = candidate.id === "source-packet"
            ? run.nodes.find((node) => node.id === "research-repair")
            : undefined;
          if (dedicatedRepair && dedicatedRepair.status !== "succeeded") {
            if (dedicatedRepair.status === "needs_human") {
              blocker ??= { stoppedAtNodeId: dedicatedRepair.id, reason: "requires_input" };
            } else if (dedicatedRepair.status !== "ready" && dedicatedRepair.status !== "stale" && dedicatedRepair.status !== "failed") {
              blocker ??= { stoppedAtNodeId: dedicatedRepair.id, reason: "failed" };
            }
            continue;
          }
          if (failedAttempts(run, candidate.id) >= 3) {
            blocker ??= { stoppedAtNodeId: candidate.id, reason: "repair_limit" };
            continue;
          }
        }
        if (isBoundedAgentLoop(candidate.capability) && boundedLoopAttempts(run, candidate) >= boundedLoopLimit(candidate)) {
          blocker ??= { stoppedAtNodeId: candidate.id, reason: "repair_limit" };
          continue;
        }
        if (!isNodeGraphExecutable(run, candidate)) continue;
        const plan = this.nodeExecutor.plan?.({ run, node: candidate }) ?? {
          providerId: candidate.providerId ?? "local-production-engine",
          modelId: candidate.modelId ?? candidate.capability,
          billing: "local_compute" as const,
          estimatedCostCny: candidate.estimatedCostCny,
        };
        if (plan.billing === "metered" && executionPreview(run, candidate, plan, this.now()).authorization !== "active") {
          blocker ??= { stoppedAtNodeId: candidate.id, reason: "awaiting_spend_authorization" };
          continue;
        }
        selectedNode = candidate;
        break;
      }
      if (!selectedNode) return {
        run,
        executedNodeIds,
        ...blocker,
        reason: blocker?.reason ?? (run.nodes.some((candidate) => candidate.status === "failed") ? "failed" : "completed_available_work"),
      };

      const updated = await this.executeNode(runId, selectedNode.id, requestSignal, nextAgentLoopExecutionInput(run, selectedNode));
      executedNodeIds.push(selectedNode.id);
      const updatedNode = updated.nodes.find((candidate) => candidate.id === selectedNode.id);
      if (updatedNode?.status === "failed") {
        const hasAutomaticRepair = selectedNode.id === "source-packet"
          && updated.nodes.some((candidate) => candidate.id === "research-repair" && candidate.status === "ready");
        if (!hasAutomaticRepair) {
          const repairLimitReached = failedAttempts(updated, selectedNode.id) >= 3;
          return {
            run: updated,
            executedNodeIds,
            stoppedAtNodeId: selectedNode.id,
            reason: repairLimitReached ? "repair_limit" : "continue_available_work",
          };
        }
      }
      if (updatedNode?.status === "needs_human") {
        return { run: updated, executedNodeIds, stoppedAtNodeId: selectedNode.id, reason: "requires_input" };
      }
    }
    const snapshot = await this.repository.load();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new StudioNotFoundError(`Run '${runId}' was not found`);
    return {
      run,
      executedNodeIds,
      reason: run.nodes.some((candidate) => candidate.status === "ready" || candidate.status === "stale")
        ? "continue_available_work"
        : "completed_available_work",
    };
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async createOpportunity(
    snapshot: StudioSnapshot,
    candidate: EpisodeCandidate,
    verificationConfirmed: boolean,
  ): Promise<EpisodeOpportunity> {
    if (candidate.verdict === "skip" || candidate.verification.status === "blocked") {
      throw new StudioConflictError("该候选当前不可采用，请先补齐证据或更改总编判断。");
    }
    if (candidate.verification.status === "review_required" && !verificationConfirmed) {
      throw new StudioConflictError("采用前需要确认：当前信号仍需在资料阶段补齐独立来源。");
    }
    const existing = snapshot.opportunities.find((item) => item.candidateId === candidate.id);
    if (existing) return existing;
    const opportunity = EpisodeOpportunitySchema.parse({
      id: `opportunity-${randomUUID()}`,
      candidateId: candidate.id,
      title: candidate.title,
      origin: candidate.origin,
      verdict: candidate.verdict,
      evidence: candidate.evidence,
      candidate,
      adoptedAt: this.now(),
      status: "adopted",
    });
    snapshot.opportunities.unshift(opportunity);
    snapshot.updatedAt = this.now();
    await this.repository.save(snapshot);
    return opportunity;
  }
}

function isBoundedAgentLoop(capability: string): boolean {
  return capability === "research.search" || capability === "research.audit" || capability === "script.audit";
}

function isNodeGraphExecutable(run: WorkflowRun, node: WorkflowRun["nodes"][number]): boolean {
  const sourceFailureRepair = node.id === "research-repair"
    && run.nodes.some((candidate) => candidate.id === "source-packet" && candidate.status === "failed");
  if (sourceFailureRepair) return true;
  const prerequisitesReady = node.prerequisiteNodeIds.every((nodeId) =>
    run.nodes.find((candidate) => candidate.id === nodeId)?.status === "succeeded");
  if (!prerequisitesReady) return false;
  return node.inputArtifactIds.every((artifactId) => {
    const producer = run.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId));
    return !producer || producer.status === "succeeded";
  });
}

function completedAttempts(run: WorkflowRun, nodeId: string): number {
  return run.executionReceipts.filter((receipt) => receipt.nodeId === nodeId && receipt.status === "succeeded").length;
}

function failedAttempts(run: WorkflowRun, nodeId: string): number {
  return run.executionReceipts.filter((receipt) =>
    receipt.nodeId === nodeId && (receipt.status === "failed" || receipt.status === "rejected")).length;
}

function boundedLoopAttempts(run: WorkflowRun, node: WorkflowRun["nodes"][number]): number {
  if (node.capability === "research.search") {
    return failedAttempts(run, node.id);
  }
  return completedAttempts(run, node.id);
}

function boundedLoopLimit(node: WorkflowRun["nodes"][number]): number {
  return node.capability === "research.audit" ? 6 : 4;
}

function nextAgentLoopExecutionInput(run: WorkflowRun, node: WorkflowRun["nodes"][number]): ExecuteNodeInput {
  if (node.capability !== "script.segment") return {};
  const blueprint = activeRecord(run, "artifact-blueprint");
  const scriptArtifactId = node.outputArtifactIds[0];
  const script = scriptArtifactId ? activeRecord(run, scriptArtifactId) : {};
  const completedSegmentIds = new Set(Array.isArray(script.lines) ? script.lines.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const segmentId = (value as Record<string, unknown>).segmentId;
    return typeof segmentId === "string" && segmentId.trim() ? [segmentId] : [];
  }) : []);
  const nextSegmentId = Array.isArray(blueprint.segments) ? blueprint.segments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const segmentId = (value as Record<string, unknown>).id;
    return typeof segmentId === "string" && segmentId.trim() && !completedSegmentIds.has(segmentId) ? [segmentId] : [];
  }).at(0) : undefined;
  return nextSegmentId ? { segmentId: nextSegmentId } : {};
}

function retainScriptNodeUntilEveryChapterExists(run: WorkflowRun, nodeId: string): void {
  const node = run.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.capability !== "script.segment") return;
  const blueprint = activeRecord(run, "artifact-blueprint");
  const segmentIds = Array.isArray(blueprint.segments) ? blueprint.segments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id] : [];
  }) : [];
  if (segmentIds.length === 0) return;
  const artifactId = node.outputArtifactIds[0];
  const script = artifactId ? activeRecord(run, artifactId) : {};
  const completed = new Set(Array.isArray(script.lines) ? script.lines.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).segmentId;
    return typeof id === "string" && id.trim() ? [id] : [];
  }) : []);
  if (segmentIds.every((id) => completed.has(id))) return;
  node.status = "ready";
  node.staleReason = "仍有章节等待独立生成";
  for (const consumer of run.nodes.filter((candidate) => candidate.id !== node.id && candidate.inputArtifactIds.includes(artifactId ?? ""))) {
    consumer.status = consumer.status === "succeeded" ? "stale" : "pending";
    consumer.staleReason = "逐章脚本尚未全部生成";
  }
  run.status = "active";
}

function activeRecord(run: WorkflowRun, artifactId: string): Record<string, unknown> {
  const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
  const version = artifact?.versions.find((candidate) => candidate.id === artifact.activeVersionId);
  return version?.data && typeof version.data === "object" && !Array.isArray(version.data)
    ? version.data as Record<string, unknown>
    : {};
}

function synchronizeOpportunityStatus(snapshot: StudioSnapshot, run: WorkflowRun): void {
  const opportunity = snapshot.opportunities.find((candidate) => candidate.id === run.opportunityId || candidate.runId === run.id);
  if (!opportunity?.runId) return;
  opportunity.status = run.status === "completed"
    ? "published"
    : run.status === "release_ready" ? "release_ready" : "in_production";
}

function assertPlanAuthorized(
  run: WorkflowRun,
  node: WorkflowRun["nodes"][number],
  plan: NonNullable<ReturnType<NonNullable<NodeExecutor["plan"]>>>,
  now: string,
): void {
  if (plan.billing !== "metered") return;
  const unreconciled = run.executionReceipts.find((receipt) =>
    receipt.billing === "metered"
    && receipt.status !== "running"
    && receipt.actualCostCny === undefined,
  );
  if (unreconciled) {
    throw new StudioConflictError("本集存在尚未对账的计费执行，确认实际成本前不能再次调用付费服务。");
  }
  const inputVersionIds = node.inputArtifactIds.flatMap((artifactId) => {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    return artifact ? [artifact.activeVersionId] : [];
  });
  const budget = run.productionIntent?.maxCostCny ?? node.authorizedCostCny ?? 0;
  const spent = committedSpendCny(run);
  if (plan.estimatedCostCny > Math.max(0, budget - spent)) {
    throw new StudioConflictError(`节点“${node.label}”预计成本超出本集剩余现金上限。`);
  }
  const authorization = run.spendAuthorizations.find((candidate) =>
    candidate.nodeId === node.id
    && candidate.providerId === plan.providerId
    && candidate.modelId === plan.modelId
    && candidate.maxCostCny >= plan.estimatedCostCny
    && candidate.approvedAt <= now
    && candidate.expiresAt > now
    && sameValues(candidate.inputVersionIds, inputVersionIds),
  );
  if (!authorization) {
    throw new StudioConflictError(`节点“${node.label}”尚未获得与当前输入、服务和模型匹配的成本授权。`);
  }
  const attempts = run.executionReceipts.filter((receipt) =>
    receipt.nodeId === node.id
    && receipt.providerId === plan.providerId
    && receipt.modelId === plan.modelId
    && receipt.startedAt >= authorization.approvedAt,
  ).length;
  if (attempts >= authorization.maxAttempts) {
    throw new StudioConflictError(`节点“${node.label}”已用完本次成本授权的尝试次数。`);
  }
}

function executionPreview(
  run: WorkflowRun,
  node: WorkflowRun["nodes"][number],
  plan: NonNullable<ReturnType<NonNullable<NodeExecutor["plan"]>>>,
  now: string,
): NodeExecutionPreview {
  const spent = committedSpendCny(run);
  const budget = run.productionIntent?.maxCostCny ?? node.authorizedCostCny ?? 0;
  const hasUnreconciledCost = run.executionReceipts.some((receipt) =>
    receipt.billing === "metered" && receipt.status !== "running" && receipt.actualCostCny === undefined,
  );
  const base = {
    providerId: plan.providerId,
    modelId: plan.modelId,
    billing: plan.billing,
    estimatedCostCny: plan.estimatedCostCny,
    remainingBudgetCny: hasUnreconciledCost ? 0 : roundCost(Math.max(0, budget - spent)),
    ...(hasUnreconciledCost ? { blocker: "unreconciled_cost" as const } : {}),
  };
  if (plan.billing !== "metered") {
    return { ...base, authorization: "not_required", attemptsUsed: 0 };
  }
  const inputVersionIds = activeArtifactVersionIds(run, node.inputArtifactIds);
  const authorization = [...run.spendAuthorizations].reverse().find((candidate) =>
    candidate.nodeId === node.id
    && candidate.providerId === plan.providerId
    && candidate.modelId === plan.modelId
    && candidate.maxCostCny >= plan.estimatedCostCny
    && candidate.approvedAt <= now
    && candidate.expiresAt > now
    && sameValues(candidate.inputVersionIds, inputVersionIds),
  );
  if (!authorization) return { ...base, authorization: "required", attemptsUsed: 0 };
  const attemptsUsed = run.executionReceipts.filter((receipt) =>
    receipt.nodeId === node.id
    && receipt.providerId === plan.providerId
    && receipt.modelId === plan.modelId
    && receipt.startedAt >= authorization.approvedAt,
  ).length;
  return {
    ...base,
    authorization: attemptsUsed >= authorization.maxAttempts ? "exhausted" : "active",
    attemptsUsed,
    maxAttempts: authorization.maxAttempts,
    expiresAt: authorization.expiresAt,
  };
}

function roundCost(value: number): number {
  return Math.round(value * 100) / 100;
}

function failedExecutionOutcome(outcome: NodeExecutionOutcome, errorMessage: string, finishedAt: string): NodeExecutionOutcome {
  return {
    status: "failed",
    providerId: outcome.providerId,
    modelId: outcome.modelId,
    billing: outcome.billing,
    estimatedCostCny: outcome.estimatedCostCny,
    ...(outcome.actualCostCny !== undefined ? { actualCostCny: outcome.actualCostCny } : {}),
    startedAt: outcome.startedAt,
    finishedAt,
    errorMessage,
  };
}

function committedSpendCny(run: WorkflowRun): number {
  return run.executionReceipts.reduce((total, receipt) => {
    if (receipt.actualCostCny !== undefined) return total + receipt.actualCostCny;
    if (receipt.billing === "metered" && receipt.status === "running") return total + receipt.estimatedCostCny;
    return total;
  }, 0);
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasRunningExecution(run: WorkflowRun): boolean {
  return run.nodes.some((node) => node.status === "running")
    || run.executionReceipts.some((receipt) => receipt.status === "running" && !receipt.finishedAt);
}

function assertRunNotPublished(run: WorkflowRun): void {
  if (run.publicationRecords.some((record) => record.status === "published")) {
    throw new StudioConflictError("本集已经发布，制作内容与发行资产已锁定；修订请新建一期。");
  }
}

function assertPublishNodeSucceeded(run: WorkflowRun): void {
  if (run.nodes.find((node) => node.capability === "publish.package")?.status !== "succeeded") {
    throw new StudioConflictError("当前发布检查已失效，请重新运行发布检查。");
  }
}

function publicationOpportunity(snapshot: StudioSnapshot, run: WorkflowRun): EpisodeOpportunity | undefined {
  return snapshot.opportunities.find((opportunity) => opportunity.id === run.opportunityId || opportunity.runId === run.id);
}

function publicationMatchesInput(record: WorkflowRun["publicationRecords"][number], input: RegisterPublicationInput): boolean {
  if (record.status !== input.status || record.platform !== input.platform) return false;
  if (record.status === "published" && input.status === "published") {
    return record.externalEpisodeId === input.externalEpisodeId
      && record.episodeUrl === input.episodeUrl
      && record.channelUrl === input.channelUrl
      && record.publishedAt === input.publishedAt;
  }
  if (record.status === "failed" && input.status === "failed") {
    return record.attemptedAt === input.attemptedAt && record.failureReason === input.failureReason;
  }
  return false;
}

function hasPublicationBinding(run: WorkflowRun, version: { id: string; sha256: string }, releasePackage: ReleasePackage): boolean {
  return run.publicationRecords.some((record) => record.status === "published"
    && record.releasePackageVersionId === version.id
    && record.releasePackageSha256 === version.sha256
    && record.audioSha256 === releasePackage.checksums.audioSha256
    && record.coverSha256 === releasePackage.checksums.coverSha256);
}

function activeArtifactVersionIds(run: WorkflowRun, artifactIds: string[]): string[] {
  return artifactIds.flatMap((artifactId) => {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    return artifact ? [artifact.activeVersionId] : [];
  });
}

function assertProtectedArtifactFieldsUnchanged(kind: string, data: unknown, activeData: unknown): void {
  if (["publish.package", "publish-package"].includes(kind)) {
    throw new StudioConflictError("发布包只能由发布检查生成，不能通过通用编辑接口写入。");
  }
  const protectedFields = ["audio.master", "audio-master"].includes(kind)
    ? ["mediaUrl", "mimeType", "bytes", "sha256", "durationSeconds", "audioQc", "releaseReady", "rights", "registeredAt"]
    : ["visual.pack", "visual-pack"].includes(kind)
      ? ["covers", "selectedCoverId"]
      : [];
  if (protectedFields.length === 0) return;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StudioConflictError(["audio.master", "audio-master"].includes(kind) ? "发行母带必须通过母带登记完成。" : "封面与发布资产必须通过对应登记流程完成。");
  }
  const next = data as Record<string, unknown>;
  const current = activeData && typeof activeData === "object" && !Array.isArray(activeData)
    ? activeData as Record<string, unknown>
    : {};
  const changed = protectedFields.some((field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]));
  if (!changed) return;
  if (["audio.master", "audio-master"].includes(kind)) throw new StudioConflictError("发行母带、试听地址和授权状态不能通过结构化数据伪造，请使用母带登记。");
  throw new StudioConflictError("封面文件和授权状态不能通过结构化数据伪造，请使用封面登记。");
}

function assertSeriesCastPolicyPreserved(run: WorkflowRun, kind: string, data: unknown): void {
  const policy = run.productionIntent?.castPolicy;
  if (!["cast.plan", "cast-plan"].includes(kind) || !policy || policy.mode === "dynamic") return;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StudioConflictError("系列固定或常驻角色只能在系列设置中修改。");
  }
  const roles = Array.isArray((data as Record<string, unknown>).roles)
    ? (data as Record<string, unknown>).roles as unknown[]
    : [];
  const proposed = roles.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const role = value as Record<string, unknown>;
    return typeof role.id === "string" && role.id.trim() && typeof role.name === "string" && role.name.trim()
      ? [normalizeSeriesRole(role)]
      : [];
  });
  const configured = policy.roles.map((role) => normalizeSeriesRole(role));
  const configuredById = new Map(configured.map((role) => [role.id, role]));
  const configuredByName = new Map(configured.map((role) => [role.name, role]));
  const validRoleList = proposed.length === roles.length
    && new Set(proposed.map((role) => role.id?.trim())).size === proposed.length
    && new Set(proposed.map((role) => role.name?.trim())).size === proposed.length;
  const preserved = validRoleList && (policy.mode === "fixed"
    ? JSON.stringify(proposed) === JSON.stringify(configured)
    : configured.every((role) => proposed.filter((candidate) => candidate.id === role.id).length === 1
      && proposed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(role)))
      && proposed.every((candidate) => {
        const recurringRole = configuredById.get(candidate.id) ?? configuredByName.get(candidate.name);
        return !recurringRole || JSON.stringify(candidate) === JSON.stringify(recurringRole);
      }));
  if (!preserved) throw new StudioConflictError("系列固定或常驻角色只能在系列设置中修改。");
}

function normalizeSeriesRole(role: Record<string, unknown>): Record<string, string | undefined> {
  return {
    id: typeof role.id === "string" ? role.id : undefined,
    name: typeof role.name === "string" ? role.name : undefined,
    responsibility: typeof role.responsibility === "string" ? role.responsibility : undefined,
    speakingStyle: typeof role.speakingStyle === "string" ? role.speakingStyle : undefined,
    voiceBrief: typeof role.voiceBrief === "string" ? role.voiceBrief : undefined,
  };
}

function completeRegisteredAssetProducer(run: WorkflowRun, artifactId: string, artifactKind: "audio.master" | "visual.pack", completedAt: string): void {
  const producer = run.nodes.find((node) => node.outputArtifactIds.includes(artifactId));
  if (!producer) throw new StudioConflictError("登记资产没有对应的制作步骤。");
  const providerId = "human-asset-registration";
  const modelId = artifactKind === "audio.master" ? "release-master-registration-v1" : "cover-registration-v1";
  producer.status = "succeeded";
  producer.providerId = providerId;
  producer.modelId = modelId;
  producer.estimatedCostCny = 0;
  producer.actualCostCny = 0;
  producer.lastError = undefined;
  producer.staleReason = undefined;
  producer.inputVersionIds = activeArtifactVersionIds(run, producer.inputArtifactIds);
  run.executionReceipts.push({
    id: `receipt-${producer.id}-registration-${run.executionReceipts.length + 1}`,
    nodeId: producer.id,
    providerId,
    modelId,
    status: "succeeded",
    billing: "local_compute",
    estimatedCostCny: 0,
    actualCostCny: 0,
    startedAt: completedAt,
    finishedAt: completedAt,
    reviewedInputVersionIds: [...producer.inputVersionIds],
  });
}

function assertAssetRegistrationReady(run: WorkflowRun, producer: WorkflowRun["nodes"][number]): void {
  for (const prerequisiteId of producer.prerequisiteNodeIds) {
    const prerequisite = run.nodes.find((node) => node.id === prerequisiteId);
    if (!prerequisite || prerequisite.status !== "succeeded") {
      throw new StudioConflictError(`请先完成“${prerequisite?.label ?? prerequisiteId}”，再登记发行资产。`);
    }
  }
  for (const inputArtifactId of producer.inputArtifactIds) {
    const inputProducer = run.nodes.find((node) => node.outputArtifactIds.includes(inputArtifactId));
    if (inputProducer && inputProducer.status !== "succeeded") {
      throw new StudioConflictError(`请先完成上游步骤“${inputProducer.label}”，再登记发行资产。`);
    }
  }
}

function assertReleaseMasterDuration(run: WorkflowRun, data: Record<string, unknown>): void {
  const durationSeconds = typeof data.durationSeconds === "number" ? data.durationSeconds : Number.NaN;
  const blueprint = run.artifacts.find((artifact) => ["episode.blueprint", "episode-blueprint"].includes(artifact.kind));
  const blueprintVersion = blueprint?.versions.find((version) => version.id === blueprint.activeVersionId);
  const blueprintData = blueprintVersion?.data && typeof blueprintVersion.data === "object" && !Array.isArray(blueprintVersion.data)
    ? blueprintVersion.data as Record<string, unknown>
    : {};
  const targetMinutes = run.productionIntent?.targetMinutes
    ?? (typeof blueprintData.targetMinutes === "number" ? blueprintData.targetMinutes : undefined);
  const minimumSeconds = Math.max(60, (targetMinutes ?? 2) * 60 * 0.8);
  if (!Number.isFinite(durationSeconds) || durationSeconds < minimumSeconds) {
    const target = targetMinutes ? `本集目标约 ${targetMinutes} 分钟，` : "";
    throw new StudioConflictError(`${target}上传音频只有 ${formatDuration(durationSeconds)}，疑似占位或截断文件，不能登记为发行母带。`);
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "无有效时长";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function assertPodcastBlueprintRevision(run: WorkflowRun, kind: string, data: unknown): void {
  if (!["episode.blueprint", "episode-blueprint"].includes(kind)) return;
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const targetMinutes = run.productionIntent?.targetMinutes;
  if (!targetMinutes) return;
  const segments = Array.isArray(record.segments) ? record.segments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const segment = value as Record<string, unknown>;
    const title = typeof segment.title === "string" ? segment.title : "";
    const minutes = typeof segment.minutes === "number" ? segment.minutes : Number.NaN;
    return [{ title, minutes }];
  }) : [];
  const issues = podcastChapterPlanIssues(segments, targetMinutes);
  if (issues[0]) throw new StudioConflictError(issues[0]);
}

function assertExecutionInput(
  run: WorkflowRun,
  node: WorkflowRun["nodes"][number],
  input: ExecuteNodeInput,
): void {
  const output = run.artifacts.find((artifact) => artifact.id === node.outputArtifactIds[0]);
  const active = output?.versions.find((version) => version.id === output.activeVersionId);
  const data = active?.data && typeof active.data === "object" && !Array.isArray(active.data)
    ? active.data as Record<string, unknown>
    : {};
  const lockedSegmentIds = Array.isArray(data.lockedSegmentIds)
    ? data.lockedSegmentIds.filter((value): value is string => typeof value === "string")
    : [];

  if (!input.segmentId) {
    if (node.capability === "script.segment" && lockedSegmentIds.length > 0) {
      throw new StudioConflictError("脚本包含已锁定章节；请逐章重生成，或先解除章节锁定。 ");
    }
    return;
  }
  if (node.capability !== "script.segment") {
    throw new StudioConflictError("只有分段脚本节点支持章节级重生成。 ");
  }
  if (lockedSegmentIds.includes(input.segmentId)) {
    throw new StudioConflictError(`章节“${input.segmentId}”已锁定，不能重生成。`);
  }
  const blueprint = run.artifacts.find((artifact) => artifact.id === "artifact-blueprint");
  const blueprintVersion = blueprint?.versions.find((version) => version.id === blueprint.activeVersionId);
  const blueprintData = blueprintVersion?.data && typeof blueprintVersion.data === "object" && !Array.isArray(blueprintVersion.data)
    ? blueprintVersion.data as Record<string, unknown>
    : {};
  const segmentExists = Array.isArray(blueprintData.segments) && blueprintData.segments.some((value) => {
    return value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === input.segmentId;
  });
  if (!segmentExists) throw new StudioConflictError(`节目蓝图中不存在章节“${input.segmentId}”。`);
}

async function executeWithDeadline(
  executor: NodeExecutor,
  context: Omit<Parameters<NodeExecutor["execute"]>[0], "signal">,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<NodeExecutionOutcome> {
  const controller = new AbortController();
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: (reason: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
    timeout = setTimeout(() => {
      cancel(new Error(`节点执行超过 ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const cancel = (reason: Error) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectCancellation(reason);
  };
  const onParentAbort = () => cancel(new Error("浏览器连接已中断，执行已请求取消"));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const execution = executor.execute({ ...context, signal: controller.signal }).finally(() => {
    settled = true;
  });
  try {
    return await Promise.race([execution, cancellation]);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    await Promise.race([
      execution.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    if (!settled) {
      throw new UnconfirmedExecutionError(
        "执行器未确认取消；可能已经产生费用或文件。本次结果标记为待人工对账，结束前禁止重试。",
        execution,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

class UnconfirmedExecutionError extends Error {
  constructor(message: string, readonly pending: Promise<unknown>) {
    super(message);
  }
}

function safeExecutionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "节点执行失败";
  const redacted = raw
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "节点执行失败").slice(0, 800);
}

export class StudioNotFoundError extends Error {}
export class StudioConflictError extends Error {}

function ensureTrendSeries(snapshot: StudioSnapshot): string {
  const existing = snapshot.series.find((series) => series.id === "series-current-signals");
  if (existing) return existing.id;
  const series = SeriesBibleSchema.parse({
    id: "series-current-signals",
    title: "Token Talk 热点现场",
    promise: "不复述热搜，用来源、分歧和影响解释今天真正值得聊的事",
    audience: "关心科技、商业与文化变化，希望听见可靠判断的中文听众",
    castPolicy: { mode: "dynamic", minSpeakers: 1, maxSpeakers: 4 },
    sonicBible: {
      musicPolicy: "minimal",
      palette: ["dry-percussion", "subtle-pulse"],
      exclusions: ["新闻片头腔", "持续高密度铺底"],
    },
    memory: ["热点不是结论，节目必须明确已知、未知与争议"],
  });
  snapshot.series.push(series);
  return series.id;
}
