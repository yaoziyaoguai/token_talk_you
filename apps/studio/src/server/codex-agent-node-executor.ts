import { randomUUID } from "node:crypto";
import {
  TOKEN_TALK_AGENT_PROTOCOL_VERSION,
  type AgentTaskKind,
  type AgentTaskRequest,
} from "@token-talk/agent-protocol";
import { podcastChapterPlanIssues, type WorkflowRun } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";
import type { CodexAgentClient } from "./codex-agent-client.js";
import type { NodeExecutionContext, NodeExecutionPlan, NodeExecutor, NodePlanningContext } from "./node-executor.js";
import { reviewResearchPacket } from "./research-ledger.js";

const CHARACTERS_PER_MINUTE = 220;
const CODEX_AGENT_TIMEOUT_MS = 15 * 60_000;

const TASK_KIND_BY_CAPABILITY: Record<string, AgentTaskKind | undefined> = {
  "research.plan": "research-plan",
  "research.claims": "research-claims",
  "research.audit": "research-audit",
  "cast.plan": "cast-plan",
  "episode.blueprint": "episode-blueprint",
  "script.segment": "script-segment",
  "script.audit": "script-audit",
  "script.repair": "script-repair",
  "music.plan": "music-plan",
  "image.generate": "cover-brief",
  "release.copy": "release-copy",
};

export class CodexAgentNodeExecutor implements NodeExecutor {
  constructor(
    private readonly client: CodexAgentClient,
    private readonly fallback: NodeExecutor,
    private readonly now: () => string,
  ) {}

  plan(context: NodePlanningContext): NodeExecutionPlan {
    if (!this.isSupported(context) || !this.client.isConfigured()) return this.fallback.plan?.(context) ?? localPlan(context);
    return {
      providerId: this.client.providerId,
      modelId: this.client.modelId,
      billing: "subscription",
      estimatedCostCny: 0,
      timeoutMs: CODEX_AGENT_TIMEOUT_MS,
    };
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (!this.isSupported(context)) return this.fallback.execute(context);
    if (!this.client.isConfigured()) {
      return agentFallbackOutcome(
        context,
        await this.fallback.execute(context),
        "Token Talk Codex Broker 未配置。",
      );
    }
    const startedAt = this.now();
    try {
      if (context.node.capability === "research.plan" && context.node.id === "research-repair" && researchAuditPassed(context.run)) {
        return passedResearchRepair(context, startedAt, this.now(), this.client);
      }
      if (context.node.capability === "script.repair" && scriptAuditPassed(context.run)) {
        return passedRepair(context, startedAt, this.now(), this.client);
      }
      const task = taskFor(context);
      const result = await this.client.run(task, context.signal);
      const artifactId = context.node.outputArtifactIds[0];
      if (!artifactId) throw new Error("Codex Agent 节点缺少输出产物。");
      const normalized = normalizeOutput(context, artifactId, result.output, result.trace);
      if (context.node.capability === "music.plan") {
        return await finalizeMusicPlan(context, artifactId, normalized, result.trace, this.fallback, startedAt, this.now);
      }
      return {
        status: "succeeded",
        providerId: result.trace.providerId,
        modelId: result.trace.modelId,
        billing: "subscription",
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt,
        finishedAt: this.now(),
        outputs: { [artifactId]: normalized },
      };
    } catch (error) {
      return {
        status: "failed",
        providerId: this.client.providerId,
        modelId: this.client.modelId,
        billing: "subscription",
        estimatedCostCny: 0,
        startedAt,
        finishedAt: this.now(),
        errorMessage: `Codex Agent 未完成：${safeMessage(error)}`.slice(0, 800),
      };
    }
  }

  async discard(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<void> {
    await this.fallback.discard?.(context, outcome);
  }

  async commit(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<NodeExecutionOutcome> {
    return await this.fallback.commit?.(context, outcome) ?? outcome;
  }

  private isSupported(context: Pick<NodeExecutionContext, "node">): boolean {
    return TASK_KIND_BY_CAPABILITY[context.node.capability] !== undefined;
  }
}

async function finalizeMusicPlan(
  context: NodeExecutionContext,
  artifactId: string,
  creativeDirection: Record<string, unknown>,
  trace: Record<string, unknown>,
  fallback: NodeExecutor,
  startedAt: string,
  now: () => string,
): Promise<NodeExecutionOutcome> {
  const run = structuredClone(context.run);
  const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
  const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
  if (!active) throw new Error("音乐节点缺少可用于授权匹配的产物版本。");
  active.data = creativeDirection;
  const finalized = await fallback.execute({ ...context, run });
  if (finalized.status !== "succeeded") return finalized;
  const outputs = Object.fromEntries(Object.entries(finalized.outputs ?? {}).map(([outputId, output]) => [
    outputId,
    {
      ...asRecord(output),
      creativeDirection,
      generatedBy: creativeDirection.generatedBy,
    },
  ]));
  return {
    ...finalized,
    providerId: `${String(trace.providerId)}+internal-music-library`,
    modelId: `${String(trace.modelId)}+licensed-cues-v1`,
    billing: "subscription",
    estimatedCostCny: 0,
    actualCostCny: 0,
    startedAt,
    finishedAt: now(),
    outputs,
  };
}

function agentFallbackOutcome(
  context: NodeExecutionContext,
  fallback: NodeExecutionOutcome,
  reason: string,
): NodeExecutionOutcome {
  const independentAuditRequired = context.node.capability === "research.audit" || context.node.capability === "script.audit";
  const outputs = Object.fromEntries(Object.entries(fallback.outputs ?? {}).map(([artifactId, value]) => [
    artifactId,
    {
      ...asRecord(value),
      agentFallback: {
        requiredProviderId: "openai-codex-subscription",
        reason,
        deterministicFallbackProviderId: fallback.providerId,
      },
    },
  ]));
  return {
    ...fallback,
    status: independentAuditRequired ? "failed" : fallback.status,
    outputs,
    ...(independentAuditRequired || fallback.status !== "succeeded"
      ? { errorMessage: `Codex Agent 未完成：${reason}`.slice(0, 800) }
      : {}),
  };
}

function taskFor(context: NodeExecutionContext): AgentTaskRequest {
  const kind = TASK_KIND_BY_CAPABILITY[context.node.capability];
  if (!kind) throw new Error(`节点能力“${context.node.capability}”不支持 Codex Agent。`);
  const run = context.run;
  const common = productionContext(run, context.node.outputArtifactIds[0], context.input?.segmentId, context.retryFeedback);
  const payload = payloadFor(kind, run, common);
  return {
    protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION,
    requestId: `agent-${context.attemptId}-${randomUUID()}`,
    kind,
    payload,
  };
}

function payloadFor(kind: AgentTaskKind, run: WorkflowRun, common: Record<string, unknown>): unknown {
  if (["cast-plan", "episode-blueprint", "script-segment", "music-plan"].includes(kind)) return common;
  if (kind === "research-plan") {
    const brief = asRecord(activeArtifactData(run, "artifact-brief"));
    const currentPlan = asRecord(activeArtifactData(run, "artifact-research-plan"));
    const sourcePacket = asRecord(activeArtifactData(run, "artifact-sources"));
    const auditFindings = asArray(asRecord(activeArtifactData(run, "artifact-research-audit")).findings);
    const sourceGapFindings = asArray(sourcePacket.gaps).flatMap((value, index) => typeof value === "string" && value.trim() ? [{
      id: `source-gap-${index + 1}`,
      severity: "critical",
      category: "coverage",
      description: value.trim(),
      evidence: `当前资料包状态：${stringValue(sourcePacket.status) ?? "unknown"}`,
      repairInstruction: "改写成更短、更具体、包含英文实体或学术术语的检索式，补齐至少两个独立相关来源。",
    }] : []);
    return {
      title: run.title,
      centralQuestion: stringValue(brief.centralQuestion) ?? run.title,
      listenerPromise: stringValue(brief.listenerPromise) ?? "",
      currentQueries: asArray(currentPlan.queries).flatMap((value) => {
        const query = stringValue(asRecord(value).query);
        return query ? [query] : [];
      }),
      auditFindings: [...auditFindings, ...sourceGapFindings],
    };
  }
  if (kind === "research-claims") {
    const plan = asRecord(activeArtifactData(run, "artifact-research-plan"));
    const previousClaims = asRecord(activeArtifactData(run, "artifact-claims"));
    return {
      title: run.title,
      centralQuestion: stringValue(asRecord(activeArtifactData(run, "artifact-brief")).centralQuestion) ?? run.title,
      sources: verifiedResearchSources(run),
      synthesisDirectives: asArray(plan.synthesisDirectives).flatMap((value) => stringValue(value) ?? []),
      previousSynthesis: asRecord(previousClaims.evidenceSynthesis),
    };
  }
  if (kind === "research-audit") {
    return {
      title: run.title,
      centralQuestion: stringValue(asRecord(activeArtifactData(run, "artifact-brief")).centralQuestion) ?? run.title,
      sources: verifiedResearchSources(run),
      claims: verifiedClaims(run),
      evidenceSynthesis: asRecord(asRecord(activeArtifactData(run, "artifact-claims")).evidenceSynthesis),
    };
  }
  if (kind === "cover-brief") {
    return {
      title: run.title,
      brief: asRecord(activeArtifactData(run, "artifact-brief")),
      series: { id: run.seriesId },
      chapters: asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments),
      script: scriptPayload(run),
      visualConstraints: [
        "正方形单集封面，3000x3000 交付",
        "缩略图尺寸仍能辨认主体",
        "不使用未经授权的人物肖像、商标或版权角色",
        "发行封面主体本身承担识别，不在图片中内嵌节目标题或 Logo",
        "章节图与主封面属于同一视觉系统",
      ],
    };
  }
  if (kind === "release-copy") {
    const brief = asRecord(activeArtifactData(run, "artifact-brief"));
    return {
      title: run.title,
      hook: stringValue(brief.listenerPromise) ?? stringValue(brief.hook) ?? run.productionIntent?.hook ?? run.title,
      script: scriptPayload(run),
      chapters: asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments),
      verifiedSources: verifiedResearchSources(run),
    };
  }
  const script = scriptPayload(run);
  if (kind === "script-audit") return { ...common, script, auditRound: auditRound(run, "script-audit") };
  if (kind === "script-repair") return {
    ...common,
    script,
    findings: asArray(asRecord(activeArtifactData(run, "artifact-script-audit")).findings),
    repairRound: auditRound(run, "script-repair"),
  };
  throw new Error(`任务类型“${kind}”没有可用载荷。`);
}

function productionContext(
  run: WorkflowRun,
  outputArtifactId?: string,
  targetSegmentId?: string,
  retryFeedback?: string,
): Record<string, unknown> {
  const episodeTargetMinutes = run.productionIntent?.targetMinutes ?? 30;
  const blueprint = asRecord(activeArtifactData(run, "artifact-blueprint"));
  const targetSegment = targetSegmentId
    ? asArray(blueprint.segments).map(asRecord).find((segment) => segment.id === targetSegmentId)
    : undefined;
  if (targetSegmentId && !targetSegment) throw new Error(`节目蓝图中不存在章节“${targetSegmentId}”。`);
  const targetMinutes = targetSegment ? Math.max(3, Math.round(numberValue(targetSegment.minutes) || 3)) : episodeTargetMinutes;
  const nominalTargetCharacters = Math.round(targetMinutes * CHARACTERS_PER_MINUTE);
  const targetCharacters = retryFeedback?.includes("字，不符合")
    ? Math.round(nominalTargetCharacters * (retryFeedback.includes("超出") ? 0.85 : 0.9))
    : nominalTargetCharacters;
  const currentScript = targetSegment && outputArtifactId ? asRecord(activeArtifactData(run, outputArtifactId)) : undefined;
  return {
    title: run.title,
    targetMinutes,
    targetCharacters,
    brief: asRecord(activeArtifactData(run, "artifact-brief")),
    claims: verifiedClaims(run),
    evidenceSynthesis: asRecord(asRecord(activeArtifactData(run, "artifact-claims")).evidenceSynthesis),
    castPolicy: asRecord(run.productionIntent?.castPolicy),
    cast: asRecord(activeArtifactData(run, "artifact-cast")),
    blueprint,
    emotion: asRecord(activeArtifactData(run, "artifact-emotion")),
    musicPolicy: run.productionIntent?.musicPolicy ?? "minimal",
    ...(retryFeedback ? { retryFeedback } : {}),
    ...(targetSegment ? { targetSegment } : {}),
    ...(currentScript ? {
      currentScript: {
        ...currentScript,
        lockedSegmentIds: asArray(currentScript.lockedSegmentIds).filter((value): value is string => typeof value === "string"),
        lines: agentScriptLines(currentScript.lines),
      },
    } : {}),
  };
}

function normalizeOutput(
  context: NodeExecutionContext,
  artifactId: string,
  value: unknown,
  trace: Record<string, unknown>,
): Record<string, unknown> {
  const run = context.run;
  const capability = context.node.capability;
  const output = asRecord(value);
  const generatedBy = { providerId: trace.providerId, modelId: trace.modelId, taskKind: trace.taskKind, promptVersion: trace.promptVersion, reasoningEffort: trace.reasoningEffort };
  if (capability === "research.audit" || capability === "script.audit") return { ...output, generatedBy };
  if (capability === "research.plan") return {
    status: "draft",
    queries: asArray(output.queries),
    synthesisDirectives: context.node.id === "research-repair"
      ? uniqueValues([
        ...asArray(asRecord(activeArtifactData(run, "artifact-research-plan")).synthesisDirectives),
        ...asArray(output.synthesisDirectives),
      ], 30)
      : asArray(output.synthesisDirectives),
    generatedBy,
  };
  if (capability === "research.claims") {
    const knownSourceIds = reviewResearchPacket(activeArtifactData(run, "artifact-sources")).verifiedSourceIds;
    const claims = asArray(output.claims).map(asRecord);
    const invalidClaims = claims.filter((claim) => {
      const sourceIds = asArray(claim.sourceIds).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      return !(typeof claim.id === "string"
        && typeof claim.text === "string"
        && sourceIds.length > 0
        && sourceIds.every((id) => knownSourceIds.has(id)));
    });
    if (invalidClaims.length > 0) {
      const invalidIds = invalidClaims.flatMap((claim) => stringValue(claim.id) ?? []).join("、");
      throw new Error(`Codex 论点引用了当前可信资料集合之外的来源：${invalidIds || "未编号 claim"}`);
    }
    if (claims.length === 0) throw new Error("Codex 论点没有引用当前机器核验资料包中的来源。");
    const claimIds = new Set(claims.flatMap((claim) => stringValue(claim.id) ?? []));
    const citedSourceIds = new Set(claims.flatMap((claim) => asArray(claim.sourceIds))
      .filter((sourceId): sourceId is string => typeof sourceId === "string"));
    const evidenceSynthesis = asRecord(output.evidenceSynthesis);
    const dimensions = asArray(evidenceSynthesis.dimensions).map(asRecord);
    if (dimensions.some((dimension) => asArray(dimension.claimIds)
      .some((claimId) => typeof claimId !== "string" || !claimIds.has(claimId)))) {
      throw new Error("Codex 证据综合引用了不存在的 claim。");
    }
    const synthesizedClaimIds = new Set(dimensions.flatMap((dimension) => asArray(dimension.claimIds))
      .filter((claimId): claimId is string => typeof claimId === "string"));
    const orphanClaimIds = [...claimIds].filter((claimId) => !synthesizedClaimIds.has(claimId));
    if (orphanClaimIds.length > 0) {
      throw new Error(`Codex 证据综合存在未进入任何维度的 claim：${orphanClaimIds.join("、")}`);
    }
    const sourceAssessments = asArray(evidenceSynthesis.sourceAssessments).map(asRecord);
    const assessedSourceIds = new Set(sourceAssessments.flatMap((assessment) => stringValue(assessment.sourceId) ?? []));
    if ([...citedSourceIds].some((sourceId) => !assessedSourceIds.has(sourceId))) {
      throw new Error("Codex 证据综合没有评估所有被引用来源。");
    }
    if ([...assessedSourceIds].some((sourceId) => !knownSourceIds.has(sourceId))) {
      throw new Error("Codex 证据质量表引用了当前资料包之外的来源。");
    }
    const excludedSourceIds = new Set(asArray(evidenceSynthesis.excludedSources).map(asRecord)
      .flatMap((excluded) => stringValue(excluded.sourceId) ?? []));
    if ([...excludedSourceIds].some((sourceId) => !knownSourceIds.has(sourceId) || citedSourceIds.has(sourceId))) {
      throw new Error("Codex 证据综合的排除来源与当前 claim 或资料包冲突。");
    }
    if ([...knownSourceIds].some((sourceId) => !assessedSourceIds.has(sourceId) && !excludedSourceIds.has(sourceId))) {
      throw new Error("Codex 证据综合没有评估或排除所有机器核验来源。");
    }
    return {
      status: "verified",
      claims,
      evidenceSynthesis,
      evidenceTier: "machine_checked_metadata",
      generatedBy,
    };
  }
  if (capability === "cast.plan") {
    const castPolicy = run.productionIntent?.castPolicy;
    const policy = castPolicy?.mode ?? "dynamic";
    const configured = castPolicy?.roles ?? [];
    const generated = asArray(output.roles);
    const roles = policy === "fixed" ? configured : policy === "recurring_with_guests" ? [...configured, ...generated] : generated;
    const minimum = castPolicy?.minSpeakers ?? 1;
    const maximum = castPolicy?.maxSpeakers ?? 6;
    const roleIds = roles.flatMap((role) => stringValue(asRecord(role).id) ?? []);
    const roleNames = roles.flatMap((role) => stringValue(asRecord(role).name) ?? []);
    if (roles.length < minimum || roles.length > maximum) {
      throw new Error(`Codex 选角人数为 ${roles.length}，不符合本期 ${minimum}–${maximum} 人约束。`);
    }
    if (new Set(roleIds).size !== roles.length || new Set(roleNames).size !== roles.length) {
      throw new Error("Codex 选角包含重复或缺失的角色 ID / 名称。");
    }
    return { status: "draft", policy, roles, generatedBy };
  }
  if (capability === "episode.blueprint") {
    const targetMinutes = run.productionIntent?.targetMinutes ?? 30;
    const segments = asArray(output.segments).map(asRecord);
    const chapterIssues = podcastChapterPlanIssues(segments.flatMap((segment) => {
      const title = stringValue(segment.title);
      const minutes = numberValue(segment.minutes);
      return title && minutes > 0 ? [{ title, minutes }] : [];
    }), targetMinutes);
    if (chapterIssues[0]) throw new Error(chapterIssues[0]);
    return { status: "draft", targetMinutes, segments, generatedBy };
  }
  if (capability === "image.generate") {
    const current = asRecord(activeArtifactData(run, artifactId));
    const chapterArtBriefs = asArray(output.chapterArtBriefs);
    const expectedSegmentIds = asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments)
      .flatMap((segment) => stringValue(asRecord(segment).id) ?? []);
    const actualSegmentIds = chapterArtBriefs.flatMap((brief) => stringValue(asRecord(brief).segmentId) ?? []);
    if (new Set(actualSegmentIds).size !== actualSegmentIds.length
      || expectedSegmentIds.some((segmentId) => !actualSegmentIds.includes(segmentId))
      || actualSegmentIds.some((segmentId) => !expectedSegmentIds.includes(segmentId))) {
      throw new Error("章节视觉 Brief 必须与当前节目蓝图逐章对应。");
    }
    const coverBrief = { ...output };
    delete coverBrief.chapterArtBriefs;
    return {
      ...current,
      status: "brief_ready",
      coverBrief,
      chapterArtBriefs,
      covers: asArray(current.covers),
      generatedBy,
    };
  }
  if (capability === "release.copy") return {
    status: "ready",
    episodeTitle: output.episodeTitle,
    summary: output.summary,
    showNotes: asArray(output.showNotes),
    keywords: asArray(output.keywords),
    generatedBy,
  };
  if (capability === "script.segment" || capability === "script.repair") {
    const generatedLines = asArray(output.lines);
    const targetSegmentId = context.input?.segmentId;
    if (targetSegmentId && generatedLines.some((line) => asRecord(line).segmentId !== targetSegmentId)) {
      throw new Error("章节级重生成返回了目标章节之外的台词。");
    }
    const targetMinutes = targetSegmentId
      ? numberValue(asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments)
        .map(asRecord).find((segment) => segment.id === targetSegmentId)?.minutes)
      : run.productionIntent?.targetMinutes ?? 30;
    const generatedCharacters = generatedLines.reduce<number>((total, line) => total + String(asRecord(line).text ?? "").length, 0);
    const targetCharacters = targetMinutes * CHARACTERS_PER_MINUTE;
    const minimumCharacters = Math.round(targetCharacters * 0.85);
    const maximumCharacters = Math.round(targetCharacters * 1.2);
    if (generatedCharacters < minimumCharacters || generatedCharacters > maximumCharacters) {
      throw new Error(`Codex 脚本为 ${generatedCharacters} 字，不符合 ${targetMinutes} 分钟目标的 ${minimumCharacters}–${maximumCharacters} 字范围。`);
    }
    const current = asRecord(activeArtifactData(run, artifactId));
    const lines = targetSegmentId
      ? mergeSegmentLines(run, asArray(current.lines), targetSegmentId, generatedLines)
      : generatedLines;
    const characters = lines.reduce<number>((total, line) => total + String(asRecord(line).text ?? "").length, 0);
    return {
      ...current,
      status: "draft",
      title: run.title,
      lines,
      lockedSegmentIds: asArray(current.lockedSegmentIds).filter((item): item is string => typeof item === "string"),
      estimatedCharacters: characters,
      estimatedMinutes: Math.round((characters / CHARACTERS_PER_MINUTE) * 10) / 10,
      factualPolicy: "verified_claim_references_only",
      generatedBy,
    };
  }
  return {
    status: "draft",
    policy: run.productionIntent?.musicPolicy ?? "minimal",
    cues: asArray(output.cues),
    rightsStatus: "unresolved",
    releaseReady: false,
    generatedBy,
  };
}

function verifiedResearchSources(run: WorkflowRun): Record<string, unknown>[] {
  return reviewResearchPacket(activeArtifactData(run, "artifact-sources")).verifiedSources;
}

function uniqueValues(values: unknown[], limit: number): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(-limit);
}

function mergeSegmentLines(run: WorkflowRun, currentLines: unknown[], segmentId: string, generatedLines: unknown[]): unknown[] {
  const order = asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments)
    .map((segment) => stringValue(asRecord(segment).id))
    .filter((value): value is string => Boolean(value));
  const combined = [...currentLines.filter((line) => asRecord(line).segmentId !== segmentId), ...generatedLines];
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return combined.map((line, index) => ({ line, index })).sort((left, right) => {
    const leftOrder = orderIndex.get(String(asRecord(left.line).segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderIndex.get(String(asRecord(right.line).segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.index - right.index;
  }).map(({ line }) => line);
}

function passedRepair(
  context: NodeExecutionContext,
  startedAt: string,
  finishedAt: string,
  client: CodexAgentClient,
): NodeExecutionOutcome {
  const artifactId = context.node.outputArtifactIds[0];
  if (!artifactId) throw new Error("脚本返修节点缺少输出产物。");
  const currentScript = asRecord(activeArtifactData(context.run, artifactId));
  return {
    status: "succeeded",
    providerId: client.providerId,
    modelId: client.modelId,
    billing: "subscription",
    estimatedCostCny: 0,
    actualCostCny: 0,
    startedAt,
    finishedAt,
    outputs: { [artifactId]: currentScript },
  };
}

function passedResearchRepair(
  context: NodeExecutionContext,
  startedAt: string,
  finishedAt: string,
  client: CodexAgentClient,
): NodeExecutionOutcome {
  const artifactId = context.node.outputArtifactIds[0];
  if (!artifactId) throw new Error("研究返修节点缺少检索计划产物。");
  return {
    status: "succeeded",
    providerId: client.providerId,
    modelId: client.modelId,
    billing: "subscription",
    estimatedCostCny: 0,
    actualCostCny: 0,
    startedAt,
    finishedAt,
    outputs: { [artifactId]: asRecord(activeArtifactData(context.run, artifactId)) },
  };
}

function scriptAuditPassed(run: WorkflowRun): boolean {
  return asRecord(activeArtifactData(run, "artifact-script-audit")).verdict === "pass";
}

function researchAuditPassed(run: WorkflowRun): boolean {
  return asRecord(activeArtifactData(run, "artifact-research-audit")).verdict === "pass";
}

function scriptPayload(run: WorkflowRun): { lines: unknown[] } {
  return { lines: agentScriptLines(asRecord(activeArtifactData(run, "artifact-script")).lines) };
}

function agentScriptLines(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).flatMap((item) => {
    const line = asRecord(item);
    const segmentId = stringValue(line.segmentId);
    const speaker = stringValue(line.speaker);
    const text = stringValue(line.text);
    if (!segmentId || !speaker || !text) return [];
    return [{
      segmentId,
      speaker,
      text,
      claimIds: asArray(line.claimIds).filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      ...(stringValue(line.delivery) ? { delivery: stringValue(line.delivery) } : {}),
      ...(Number.isInteger(line.pauseAfterMs) && Number(line.pauseAfterMs) >= 0 ? { pauseAfterMs: Number(line.pauseAfterMs) } : {}),
    }];
  });
}

function auditRound(run: WorkflowRun, nodeId: string): number {
  return Math.min(5, Math.max(1, run.executionReceipts.filter((receipt) => receipt.nodeId === nodeId).length + 1));
}

function verifiedClaims(run: WorkflowRun): Array<Record<string, unknown>> {
  const ledger = asRecord(activeArtifactData(run, "artifact-claims"));
  if (ledger.status !== "verified") return [];
  return asArray(ledger.claims).flatMap((value, index) => {
    const claim = asRecord(value);
    const sourceIds = asArray(claim.sourceIds).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (typeof claim.text !== "string" || !claim.text.trim() || sourceIds.length === 0) return [];
    return [{
      id: typeof claim.id === "string" && claim.id.trim() ? claim.id : `claim-${index + 1}`,
      text: claim.text,
      sourceIds,
      ...(typeof claim.spokenQualifier === "string" && claim.spokenQualifier.trim() ? { spokenQualifier: claim.spokenQualifier } : {}),
    }];
  });
}

function activeArtifactData(run: WorkflowRun, artifactId: string): unknown {
  const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
  return artifact?.versions.find((version) => version.id === artifact.activeVersionId)?.data;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  return (error instanceof Error ? error.message : "未知错误").replace(/\s+/g, " ").slice(0, 300);
}
