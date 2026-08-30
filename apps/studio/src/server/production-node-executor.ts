import { z } from "zod";
import { podcastChapterPlanIssues, type Artifact, type WorkflowRun } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";
import type { NodeExecutionContext, NodeExecutionPlan, NodeExecutor, NodePlanningContext } from "./node-executor.js";
import type { GroundedClaim, PodcastProductionModel, ProductionCapability, ProductionModelRequest } from "./production-model.js";
import { reviewResearchPacket } from "./research-ledger.js";

const SUPPORTED_CAPABILITIES = new Set<ProductionCapability>([
  "cast.plan",
  "episode.blueprint",
  "script.segment",
  "music.plan",
]);
const CHARACTERS_PER_MINUTE = 220;

const CastOutputSchema = z.object({
  roles: z.array(z.object({
    id: z.string().trim().min(1).max(48),
    name: z.string().trim().min(1).max(24),
    responsibility: z.string().trim().min(1).max(180),
    speakingStyle: z.string().trim().min(1).max(120),
    mustAsk: z.string().trim().min(1).max(180),
    voiceBrief: z.string().trim().min(1).max(120),
  })).min(1).max(4),
});

const BlueprintOutputSchema = z.object({
  segments: z.array(z.object({
    id: z.string().trim().min(1).max(48),
    title: z.string().trim().min(1).max(45),
    minutes: z.number().min(2).max(60),
    purpose: z.string().trim().min(1).max(180),
    claimIds: z.array(z.string().min(1)).max(12),
    tension: z.string().trim().min(1).max(180),
    handoff: z.string().trim().min(1).max(180),
  })).min(3).max(12),
});

const ScriptOutputSchema = z.object({
  lines: z.array(z.object({
    segmentId: z.string().trim().min(1).max(48),
    speaker: z.string().trim().min(1).max(24),
    text: z.string().trim().min(1).max(1_200),
    claimIds: z.array(z.string().min(1)).max(4),
    delivery: z.string().trim().min(1).max(80).optional(),
    pauseAfterMs: z.number().int().min(0).max(5_000).optional(),
  })).min(4).max(800),
});

const MusicOutputSchema = z.object({
  cues: z.array(z.object({
    id: z.string().trim().min(1).max(48),
    segmentId: z.string().trim().min(1).max(48),
    action: z.enum(["silence", "transition", "bed", "outro"]),
    durationSeconds: z.number().min(0).max(30),
    mood: z.string().trim().min(1).max(80),
    intensity: z.number().int().min(0).max(5),
    purpose: z.string().trim().min(1).max(180),
    assetQuery: z.string().trim().max(180),
  })).max(24),
});

export class ProductionModelNodeExecutor implements NodeExecutor {
  constructor(
    private readonly model: PodcastProductionModel | null,
    private readonly fallback: NodeExecutor,
    private readonly now: () => string,
  ) {}

  plan(context: NodePlanningContext): NodeExecutionPlan {
    if (!this.model || !isSupported(context.node.capability)) {
      return this.fallback.plan?.(context) ?? localPlan(context);
    }
    return {
      providerId: this.model.providerId,
      modelId: this.model.modelId,
      billing: "local_compute",
      estimatedCostCny: 0,
      timeoutMs: 125_000,
    };
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (!this.model || !isSupported(context.node.capability)) return this.fallback.execute(context);
    const startedAt = this.now();
    try {
      const request = productionRequest(
        context.run,
        context.node.capability,
        context.node.outputArtifactIds[0],
        context.input?.segmentId,
      );
      const generated = validateOutput(request, await this.model.generate(request, context.signal));
      const artifactId = context.node.outputArtifactIds[0];
      if (!artifactId) throw new Error("制作模型节点没有输出产物");
      return {
        status: "succeeded",
        providerId: this.model.providerId,
        modelId: this.model.modelId,
        billing: "local_compute",
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt,
        finishedAt: this.now(),
        outputs: { [artifactId]: generated },
      };
    } catch (error) {
      const fallback = await this.fallback.execute(context);
      const reason = safeMessage(error);
      const canProceedToPlanningReview = fallback.status === "succeeded"
        && ["cast.plan", "episode.blueprint"].includes(context.node.capability);
      return {
        ...fallback,
        status: canProceedToPlanningReview ? "succeeded" : "failed",
        providerId: "local-production-fallback",
        modelId: `${context.node.capability}-template-fallback-v1`,
        startedAt,
        finishedAt: this.now(),
        ...(canProceedToPlanningReview ? {} : { errorMessage: `本地 AI 制作模型未通过：${reason}`.slice(0, 800) }),
        outputs: Object.fromEntries(Object.entries(fallback.outputs ?? {}).map(([artifactId, value]) => [
          artifactId,
          {
            ...asRecord(value),
            generation: { mode: "structured_template_fallback", reason },
          },
        ])),
      };
    }
  }

  async discard(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<void> {
    await this.fallback.discard?.(context, outcome);
  }

  async commit(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<NodeExecutionOutcome> {
    return await this.fallback.commit?.(context, outcome) ?? outcome;
  }
}

function productionRequest(
  run: WorkflowRun,
  capability: ProductionCapability,
  outputArtifactId?: string,
  targetSegmentId?: string,
): ProductionModelRequest {
  const episodeTargetMinutes = run.productionIntent?.targetMinutes ?? 30;
  const blueprint = asRecord(activeArtifactData(run, "artifact-blueprint"));
  const targetSegment = targetSegmentId
    ? asArray(blueprint.segments).map(asRecord).find((segment) => segment.id === targetSegmentId)
    : undefined;
  if (targetSegmentId && !targetSegment) throw new Error(`节目蓝图中不存在章节“${targetSegmentId}”`);
  const targetMinutes = targetSegment ? Math.max(3, Math.round(numberValue(targetSegment.minutes) || 3)) : episodeTargetMinutes;
  const claims = groundedClaims(run);
  const currentCast = asRecord(activeArtifactData(run, "artifact-cast"));
  const castPolicy = run.productionIntent?.castPolicy;
  if (capability !== "cast.plan" && claims.length === 0) {
    throw new Error("没有通过来源门禁的 claim，不能生成节目内容");
  }
  return {
    capability,
    title: run.title,
    targetMinutes,
    targetCharacters: Math.round(targetMinutes * CHARACTERS_PER_MINUTE),
    brief: asRecord(activeArtifactData(run, "artifact-brief")),
    claims,
    cast: {
      ...currentCast,
      ...(castPolicy ? { policy: castPolicy.mode, recurringRoles: castPolicy.roles } : {}),
    },
    blueprint,
    emotion: asRecord(activeArtifactData(run, "artifact-emotion")),
    musicPolicy: run.productionIntent?.musicPolicy ?? "minimal",
    ...(targetSegment ? { targetSegment } : {}),
    ...(targetSegment && outputArtifactId ? {
      currentScript: currentScript(activeArtifactData(run, outputArtifactId)),
    } : {}),
  };
}

function validateOutput(request: ProductionModelRequest, value: unknown): Record<string, unknown> {
  if (request.capability === "cast.plan") {
    const parsed = CastOutputSchema.parse(value);
    const policy = request.cast.policy === "fixed" || request.cast.policy === "recurring_with_guests" ? request.cast.policy : "dynamic";
    const configured = asArray(request.cast.recurringRoles).flatMap((value, index) => {
      const role = asRecord(value);
      if (typeof role.id !== "string" || typeof role.name !== "string") return [];
      const centralQuestion = typeof request.brief.centralQuestion === "string" ? request.brief.centralQuestion : request.title;
      return [{
        id: role.id,
        name: role.name,
        responsibility: typeof role.responsibility === "string" ? role.responsibility : "维持系列角色的稳定职责",
        speakingStyle: typeof role.speakingStyle === "string" ? role.speakingStyle : index === 0 ? "克制、清楚、善于追问" : "短句、有立场、回应证据",
        mustAsk: centralQuestion,
        voiceBrief: typeof role.voiceBrief === "string" ? role.voiceBrief : "中速、清晰、低表演感",
      }];
    });
    if (policy !== "dynamic" && configured.length === 0) throw new Error("系列固定或常驻阵容缺少角色定义");
    const configuredNames = new Set(configured.map((role) => role.name));
    const generated = parsed.roles.filter((role) => !configuredNames.has(role.name));
    const roles = policy === "fixed" ? configured : policy === "recurring_with_guests" ? [...configured, ...generated].slice(0, 4) : generated;
    assertUnique(roles.map((role) => role.id), "角色 ID");
    assertUnique(roles.map((role) => role.name), "角色名");
    return { status: "draft", policy, roles, generation: generation(request) };
  }
  if (request.capability === "episode.blueprint") {
    const parsed = BlueprintOutputSchema.parse(value);
    assertUnique(parsed.segments.map((segment) => segment.id), "章节 ID");
    assertKnownClaims(parsed.segments.flatMap((segment) => segment.claimIds), request.claims);
    const chapterIssues = podcastChapterPlanIssues(parsed.segments, request.targetMinutes);
    if (chapterIssues[0]) throw new Error(chapterIssues[0]);
    return { status: "draft", targetMinutes: request.targetMinutes, segments: parsed.segments, generation: generation(request) };
  }
  if (request.capability === "script.segment") {
    const parsed = ScriptOutputSchema.parse(value);
    const roles = roleNames(request.cast);
    const segmentIds = blueprintSegmentIds(request.blueprint);
    if (roles.length === 0 || segmentIds.length === 0) throw new Error("脚本生成缺少已确认角色或节目蓝图");
    assertSubset(parsed.lines.map((line) => line.speaker), new Set(roles), "脚本出现蓝图外角色");
    const targetSegmentId = typeof request.targetSegment?.id === "string" ? request.targetSegment.id : undefined;
    assertSubset(parsed.lines.map((line) => line.segmentId), new Set(targetSegmentId ? [targetSegmentId] : segmentIds), targetSegmentId ? "章节重生成返回了其他章节" : "脚本出现蓝图外章节");
    assertKnownClaims(parsed.lines.flatMap((line) => line.claimIds), request.claims);
    if (!targetSegmentId) {
      assertSubset(roles, new Set(parsed.lines.map((line) => line.speaker)), "角色没有实际台词");
      assertSubset(segmentIds, new Set(parsed.lines.map((line) => line.segmentId)), "蓝图章节没有实际台词");
    }
    const generatedCharacters = parsed.lines.reduce((total, line) => total + line.text.length, 0);
    if (generatedCharacters < request.targetCharacters * 0.85 || generatedCharacters > request.targetCharacters * 1.2) {
      throw new Error(`脚本 ${generatedCharacters} 字，未达到目标 ${request.targetCharacters} 字的可桌读区间`);
    }
    const lines = targetSegmentId
      ? mergeSegmentLines(request.blueprint, request.currentScript?.lines ?? [], targetSegmentId, parsed.lines)
      : parsed.lines;
    const characters = lines.reduce((total, line) => total + String(line.text ?? "").length, 0);
    return {
      status: "draft",
      title: request.title,
      lines,
      lockedSegmentIds: request.currentScript?.lockedSegmentIds ?? [],
      estimatedCharacters: characters,
      estimatedMinutes: Math.round((characters / CHARACTERS_PER_MINUTE) * 10) / 10,
      factualPolicy: "verified_claim_references_only",
      generation: generation(request),
    };
  }
  const parsed = MusicOutputSchema.parse(value);
  const segmentIds = new Set(blueprintSegmentIds(request.blueprint));
  assertSubset(parsed.cues.map((cue) => cue.segmentId), segmentIds, "Cue 出现蓝图外章节");
  if (request.musicPolicy === "minimal" && parsed.cues.some((cue) => cue.action === "bed")) {
    throw new Error("minimal 音乐策略不允许持续铺底");
  }
  return {
    status: "draft",
    policy: request.musicPolicy,
    cues: parsed.cues,
    rightsStatus: "unresolved",
    releaseReady: false,
    rightsRule: "只有绑定内部授权资产或明确可商用生成回执后才能进入发行混音",
    generation: generation(request),
  };
}

function groundedClaims(run: WorkflowRun): GroundedClaim[] {
  const review = reviewResearchPacket(activeArtifactData(run, "artifact-sources"));
  if (!review.ready) return [];
  const ledger = asRecord(activeArtifactData(run, "artifact-claims"));
  if (ledger.status === "verified") {
    return asArray(ledger.claims).flatMap((value, index) => {
      const claim = asRecord(value);
      const sourceIds = asArray(claim.sourceIds).filter((item): item is string => typeof item === "string");
      if (typeof claim.text !== "string" || sourceIds.length === 0 || !sourceIds.every((id) => review.verifiedSourceIds.has(id))) return [];
      return [{
        id: typeof claim.id === "string" && claim.id.trim() ? claim.id : `claim-${index + 1}`,
        text: claim.text.trim(),
        sourceIds,
        ...(typeof claim.spokenQualifier === "string" && claim.spokenQualifier.trim() ? { spokenQualifier: claim.spokenQualifier.trim() } : {}),
      }];
    });
  }
  if (run.nodes.some((node) => node.capability === "research.claims")) return [];
  return asArray(asRecord(activeArtifactData(run, "artifact-sources")).sources).flatMap((value, index) => {
    const source = asRecord(value);
    if (source.verificationStatus !== "verified" || typeof source.id !== "string" || typeof source.title !== "string") return [];
    if (!review.verifiedSourceIds.has(source.id)) return [];
    return [{ id: `claim-${index + 1}`, text: source.title, sourceIds: [source.id] }];
  });
}

function roleNames(cast: Record<string, unknown>): string[] {
  return asArray(cast.roles).flatMap((value) => {
    const name = asRecord(value).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

function blueprintSegmentIds(blueprint: Record<string, unknown>): string[] {
  return asArray(blueprint.segments).flatMap((value) => {
    const id = asRecord(value).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function generation(request: ProductionModelRequest): Record<string, unknown> {
  return {
    mode: "local_ai_structured",
    targetMinutes: request.targetMinutes,
    targetCharacters: request.targetCharacters,
    groundedClaimIds: request.claims.map((claim) => claim.id),
    ...(typeof request.targetSegment?.id === "string" ? { targetSegmentId: request.targetSegment.id } : {}),
  };
}

function currentScript(value: unknown): NonNullable<ProductionModelRequest["currentScript"]> {
  const script = asRecord(value);
  return {
    lockedSegmentIds: asArray(script.lockedSegmentIds).filter((item): item is string => typeof item === "string"),
    lines: asArray(script.lines).flatMap((item) => {
      const line = asRecord(item);
      if (typeof line.segmentId !== "string" || typeof line.speaker !== "string" || typeof line.text !== "string") return [];
      return [{ ...line, claimIds: asArray(line.claimIds).filter((id): id is string => typeof id === "string") }];
    }),
  };
}

function mergeSegmentLines(
  blueprint: Record<string, unknown>,
  currentLines: Array<Record<string, unknown>>,
  segmentId: string,
  generatedLines: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const order = blueprintSegmentIds(blueprint);
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...currentLines.filter((line) => line.segmentId !== segmentId), ...generatedLines]
    .map((line, index) => ({ line, index }))
    .sort((left, right) => {
      const leftOrder = orderIndex.get(String(left.line.segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndex.get(String(right.line.segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ line }) => line);
}

function assertKnownClaims(ids: string[], claims: GroundedClaim[]): void {
  assertSubset(ids, new Set(claims.map((claim) => claim.id)), "模型引用了未核验 claim");
}

function assertSubset(values: string[], allowed: Set<string>, message: string): void {
  const unknown = [...new Set(values.filter((value) => !allowed.has(value)))];
  if (unknown.length > 0) throw new Error(`${message}：${unknown.join("、")}`);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 必须唯一`);
}

function activeArtifactData(run: WorkflowRun, artifactId: string): unknown {
  const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
  return activeVersion(artifact)?.data;
}

function activeVersion(artifact: Artifact | undefined): Artifact["versions"][number] | undefined {
  return artifact?.versions.find((version) => version.id === artifact.activeVersionId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSupported(value: string): value is ProductionCapability {
  return SUPPORTED_CAPABILITIES.has(value as ProductionCapability);
}

function localPlan(context: NodePlanningContext): NodeExecutionPlan {
  return {
    providerId: context.node.providerId ?? "local-production-engine",
    modelId: context.node.modelId ?? context.node.capability,
    billing: "local_compute",
    estimatedCostCny: context.node.estimatedCostCny,
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "模型输出无效").replace(/\s+/g, " ").slice(0, 300);
}
