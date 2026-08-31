import { createHash } from "node:crypto";
import {
  WorkflowRunSchema,
  type Artifact,
  type ExecutionReceipt,
  type EpisodeCandidate,
  type EpisodeProductionIntent,
  type WorkflowNode,
  type WorkflowRun,
} from "@token-talk/domain";

export interface NodeExecutionOutcome {
  status: Exclude<ExecutionReceipt["status"], "running">;
  providerId: string;
  modelId: string;
  billing: ExecutionReceipt["billing"];
  estimatedCostCny: number;
  actualCostCny?: number;
  startedAt: string;
  finishedAt: string;
  errorMessage?: string;
  outputs?: Record<string, unknown>;
}

export interface NodeExecutionStart {
  providerId: string;
  modelId: string;
  billing: ExecutionReceipt["billing"];
  estimatedCostCny: number;
  startedAt: string;
}

export interface CreateRunFromCandidateOptions {
  id: string;
  opportunityId: string;
  seriesId: string;
  recipeId: string;
  productionIntent: Omit<EpisodeProductionIntent, "sonicPalette" | "sonicExclusions"> & Partial<Pick<EpisodeProductionIntent, "sonicPalette" | "sonicExclusions">>;
  now: string;
}

export function createRunFromCandidate(
  candidate: EpisodeCandidate,
  options: CreateRunFromCandidateOptions,
): WorkflowRun {
  const artifacts = [
    newArtifact("artifact-brief", "episode.brief", {
      title: candidate.title,
      hook: candidate.hook,
      centralQuestion: candidate.editorial?.centralQuestion ?? candidate.hook,
      listenerPromise: candidate.editorial?.listenerPromise ?? candidate.hook,
      selectionReasons: candidate.editorial?.selectionReasons ?? [candidate.rationale],
      rationale: candidate.rationale,
      verdict: candidate.verdict,
      targetMinutes: options.productionIntent.targetMinutes,
    }, options.now),
    newArtifact("artifact-research-plan", "research.plan", { status: "pending", queries: [] }, options.now),
    newArtifact("artifact-sources", "research.packet", {
      status: candidate.verification.status === "ready"
        ? "verified"
        : candidate.evidence.length > 0 ? "discovery_only" : "pending",
      sourceKind: candidate.origin === "trend" ? "discovery_signals" : "editorial_seed",
      verifiedIndependentSourceCount: candidate.verification.independentSources,
      sources: candidate.evidence,
      gaps: candidate.verification.status === "ready" ? [] : [candidate.verification.reason],
    }, options.now),
    newArtifact("artifact-claims", "claim.ledger", { status: "pending", claims: [] }, options.now),
    newArtifact("artifact-research-audit", "research.audit", { status: "pending", findings: [] }, options.now),
    newArtifact("artifact-cast", "cast.plan", {
      status: "pending",
      policy: options.productionIntent.castPolicy?.mode ?? "dynamic",
      recurringRoles: options.productionIntent.castPolicy?.roles ?? [],
      suggestedRoles: candidate.suggestedRoles,
    }, options.now),
    newArtifact("artifact-blueprint", "episode.blueprint", {
      status: "pending",
      targetMinutes: candidate.targetMinutes,
      segments: [],
    }, options.now),
    newArtifact("artifact-emotion", "audio.emotional-arc", { status: "pending", beats: [] }, options.now),
    newArtifact("artifact-segment-1", "script.segment", { status: "pending", lines: [] }, options.now),
    newArtifact("artifact-script", "script.assembled", { status: "pending", segments: [] }, options.now),
    newArtifact("artifact-script-audit", "script.audit", { status: "pending", findings: [] }, options.now),
    newArtifact("artifact-release-copy", "release.copy", { status: "pending", showNotes: [], keywords: [] }, options.now),
    newArtifact("artifact-voices", "voice.plan", { status: "pending", confirmed: false, selections: [] }, options.now),
    newArtifact("artifact-cues", "music.cue-sheet", { status: "pending", cues: [], silenceAllowed: true }, options.now),
    newArtifact("artifact-audio", "audio.master", { status: "pending" }, options.now),
    newArtifact("artifact-audio-audit", "audio.audit", { status: "pending", findings: [] }, options.now),
    newArtifact("artifact-visuals", "visual.pack", { status: "pending", covers: [], chapterArtBriefs: [] }, options.now),
    newArtifact("artifact-publish", "publish.package", { status: "pending" }, options.now),
  ];

  const deepNodes = [
    newNode("episode-opportunity", "选题机会", "planning", "总编", "editorial.opportunity", [], ["artifact-brief"], "succeeded"),
    newNode("research-plan", "研究检索计划", "planning", "研究策划 Agent", "research.plan", ["artifact-brief"], ["artifact-research-plan"], "ready"),
    newNode("source-packet", "前采与资料包", "planning", "助理制作人", "research.search", ["artifact-brief", "artifact-research-plan"], ["artifact-sources"]),
    newNode("claim-ledger", "事实账本", "planning", "事实编辑", "research.claims", ["artifact-research-plan", "artifact-sources"], ["artifact-claims"]),
    newNode("evidence-audit", "证据审计", "planning", "独立审计 Agent", "research.audit", ["artifact-sources", "artifact-claims"], ["artifact-research-audit"]),
    newNode("research-repair", "研究定向返修", "planning", "研究返修 Agent", "research.plan", ["artifact-brief", "artifact-research-plan", "artifact-sources", "artifact-claims", "artifact-research-audit"], ["artifact-research-plan"], "pending", ["evidence-audit"]),
    newNode("cast-plan", "本期角色编排", "planning", "选角导演", "cast.plan", ["artifact-brief", "artifact-claims"], ["artifact-cast"], "pending", ["evidence-audit", "research-repair"]),
    newNode("episode-blueprint", "叙事与章节蓝图", "planning", "节目制作人 / Story Editor", "episode.blueprint", ["artifact-claims", "artifact-cast"], ["artifact-blueprint"]),
    newNode("emotional-arc", "情绪与声音曲线", "planning", "声音设计师", "audio.emotional-arc", ["artifact-blueprint"], ["artifact-emotion"]),
    newNode("segment-room-1", "逐章写作", "production", "分段编剧", "script.segment", ["artifact-blueprint", "artifact-sources"], ["artifact-segment-1"]),
    newNode("showrunner-assembly", "整集故事编辑", "production", "Showrunner / 故事编辑", "script.assemble", ["artifact-segment-1", "artifact-cast"], ["artifact-script"]),
    newNode("script-audit", "桌读与逐句审校", "production", "独立审计 Agent", "script.audit", ["artifact-script"], ["artifact-script-audit"]),
    newNode("script-repair", "脚本定向返修", "production", "脚本编辑", "script.repair", ["artifact-script", "artifact-script-audit"], ["artifact-script"], "pending", ["script-audit"]),
    newNode("release-editorial", "标题、简介与 Show Notes", "production", "发行编辑", "release.copy", ["artifact-script", "artifact-blueprint", "artifact-sources"], ["artifact-release-copy"], "pending", ["script-audit", "script-repair"]),
    newNode("visual-pack", "单集封面与章节视觉", "production", "视觉编辑", "image.generate", ["artifact-brief", "artifact-blueprint", "artifact-script"], ["artifact-visuals"], "pending", ["script-audit", "script-repair"]),
    newNode("voice-casting", "选角与声音试演", "production", "声音导演", "voice.synthesize", ["artifact-script", "artifact-cast"], ["artifact-voices"], "pending", ["script-audit", "script-repair"]),
    newNode("music-cue-sheet", "音乐、声景与留白", "production", "声音设计师", "music.plan", ["artifact-script", "artifact-emotion"], ["artifact-cues"], "pending", ["script-audit", "script-repair"]),
    newNode("audio-mix", "对白剪辑与母带", "production", "混音工程师", "audio.render", ["artifact-script", "artifact-voices", "artifact-cues"], ["artifact-audio"]),
    newNode("audio-audit", "成片质量审计", "production", "QC / 独立审计 Agent", "audio.audit", ["artifact-audio"], ["artifact-audio-audit"]),
    newNode("publish-package", "发行包与章节清单", "production", "发行制作人", "publish.package", ["artifact-audio", "artifact-visuals", "artifact-audio-audit", "artifact-release-copy"], ["artifact-publish"], "pending", ["audio-audit", "release-editorial"]),
  ];
  const rapidNodes = [
    newNode("episode-opportunity", "选题机会", "planning", "总编", "editorial.opportunity", [], ["artifact-brief"], "succeeded"),
    newNode("research-plan", "研究检索计划", "planning", "研究策划 Agent", "research.plan", ["artifact-brief"], ["artifact-research-plan"], "ready"),
    newNode("source-packet", "前采与资料包", "planning", "助理制作人", "research.search", ["artifact-brief", "artifact-research-plan"], ["artifact-sources"]),
    newNode("claim-ledger", "事实账本", "planning", "事实编辑", "research.claims", ["artifact-research-plan", "artifact-sources"], ["artifact-claims"]),
    newNode("evidence-audit", "证据审计", "planning", "独立审计 Agent", "research.audit", ["artifact-sources", "artifact-claims"], ["artifact-research-audit"]),
    newNode("research-repair", "研究定向返修", "planning", "研究返修 Agent", "research.plan", ["artifact-brief", "artifact-research-plan", "artifact-sources", "artifact-claims", "artifact-research-audit"], ["artifact-research-plan"], "pending", ["evidence-audit"]),
    newNode("cast-plan", "本期角色编排", "planning", "选角导演", "cast.plan", ["artifact-brief", "artifact-claims"], ["artifact-cast"], "pending", ["evidence-audit", "research-repair"]),
    newNode("episode-blueprint", "叙事与章节蓝图", "planning", "节目制作人 / Story Editor", "episode.blueprint", ["artifact-claims", "artifact-cast"], ["artifact-blueprint"]),
    newNode("emotional-arc", "情绪与声音曲线", "planning", "声音设计师", "audio.emotional-arc", ["artifact-blueprint"], ["artifact-emotion"]),
    newNode("segment-room-1", "逐章写作", "production", "分段编剧", "script.segment", ["artifact-blueprint", "artifact-sources"], ["artifact-segment-1"]),
    newNode("showrunner-assembly", "整集故事编辑", "production", "Showrunner / 故事编辑", "script.assemble", ["artifact-segment-1", "artifact-cast"], ["artifact-script"]),
    newNode("script-audit", "桌读与逐句审校", "production", "独立审计 Agent", "script.audit", ["artifact-script"], ["artifact-script-audit"]),
    newNode("script-repair", "脚本定向返修", "production", "脚本编辑", "script.repair", ["artifact-script", "artifact-script-audit"], ["artifact-script"], "pending", ["script-audit"]),
    newNode("release-editorial", "标题、简介与 Show Notes", "production", "发行编辑", "release.copy", ["artifact-script", "artifact-blueprint", "artifact-sources"], ["artifact-release-copy"], "pending", ["script-audit", "script-repair"]),
    newNode("visual-pack", "单集封面与章节视觉", "production", "视觉编辑", "image.generate", ["artifact-brief", "artifact-blueprint", "artifact-script"], ["artifact-visuals"], "pending", ["script-audit", "script-repair"]),
    newNode("voice-casting", "选角与声音试演", "production", "声音导演", "voice.synthesize", ["artifact-script", "artifact-cast"], ["artifact-voices"], "pending", ["script-audit", "script-repair"]),
    newNode("music-cue-sheet", "音乐、声景与留白", "production", "声音设计师", "music.plan", ["artifact-script", "artifact-emotion"], ["artifact-cues"], "pending", ["script-audit", "script-repair"]),
    newNode("audio-mix", "对白剪辑与母带", "production", "混音工程师", "audio.render", ["artifact-script", "artifact-voices", "artifact-cues"], ["artifact-audio"]),
    newNode("audio-audit", "成片质量审计", "production", "QC / 独立审计 Agent", "audio.audit", ["artifact-audio"], ["artifact-audio-audit"]),
    newNode("publish-package", "发行包与章节清单", "production", "发行制作人", "publish.package", ["artifact-audio", "artifact-visuals", "artifact-audio-audit", "artifact-release-copy"], ["artifact-publish"], "pending", ["audio-audit", "release-editorial"]),
  ];
  const nodes = options.recipeId === "rapid-topic-v1" ? rapidNodes : deepNodes;

  for (const node of nodes) {
    node.inputVersionIds = node.inputArtifactIds.flatMap((artifactId) => {
      const input = artifacts.find((artifact) => artifact.id === artifactId);
      return input ? [input.activeVersionId] : [];
    });
  }

  return WorkflowRunSchema.parse({
    id: options.id,
    opportunityId: options.opportunityId,
    title: candidate.title,
    seriesId: options.seriesId,
    recipeId: options.recipeId,
    productionIntent: options.productionIntent,
    status: "active",
    createdAt: options.now,
    updatedAt: options.now,
    nodes,
    artifacts,
    spendAuthorizations: [],
    executionReceipts: [],
  });
}

export function reviseArtifact(
  run: WorkflowRun,
  artifactId: string,
  data: unknown,
  now = new Date().toISOString(),
): WorkflowRun {
  const next = WorkflowRunSchema.parse(structuredClone(run));
  const artifact = next.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`Artifact '${artifactId}' was not found`);

  const nextVersionNumber = artifact.versions.length + 1;
  const version = {
    id: `${artifact.id}-v${nextVersionNumber}`,
    createdAt: now,
    sha256: artifactDataSha256(data),
    source: "human" as const,
    data,
  };
  artifact.versions.push(version);
  artifact.activeVersionId = version.id;

  const staleNodeIds = invalidateConsumers(next, artifactId);
  next.spendAuthorizations = next.spendAuthorizations.filter(
    (authorization) => !staleNodeIds.has(authorization.nodeId),
  );
  next.updatedAt = now;
  next.status = deriveRunStatus(next);
  return WorkflowRunSchema.parse(next);
}

export function beginNodeExecution(
  run: WorkflowRun,
  nodeId: string,
  start: NodeExecutionStart,
): WorkflowRun {
  const next = WorkflowRunSchema.parse(structuredClone(run));
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node '${nodeId}' was not found`);
  if (["pending", "running", "awaiting_spend_approval"].includes(node.status)) {
    throw new Error(`Node '${nodeId}' is not executable`);
  }

  node.status = "running";
  node.providerId = start.providerId;
  node.modelId = start.modelId;
  node.lastError = undefined;
  node.staleReason = undefined;
  node.inputVersionIds = node.inputArtifactIds.flatMap((artifactId) => {
    const artifact = next.artifacts.find((candidate) => candidate.id === artifactId);
    return artifact ? [artifact.activeVersionId] : [];
  });
  next.executionReceipts.push({
    id: `receipt-${node.id}-${next.executionReceipts.length + 1}`,
    nodeId: node.id,
    providerId: start.providerId,
    modelId: start.modelId,
    status: "running",
    billing: start.billing,
    estimatedCostCny: start.estimatedCostCny,
    startedAt: start.startedAt,
    reviewedInputVersionIds: [...node.inputVersionIds],
  });
  next.updatedAt = start.startedAt;
  next.status = deriveRunStatus(next);
  return WorkflowRunSchema.parse(next);
}

export function recoverInterruptedExecutions(
  run: WorkflowRun,
  now = new Date().toISOString(),
): WorkflowRun {
  const next = WorkflowRunSchema.parse(structuredClone(run));
  const interruptedNodeIds = new Set(
    next.nodes.filter((node) => node.status === "running").map((node) => node.id),
  );
  const hasInterruptedReceipt = next.executionReceipts.some(
    (receipt) => receipt.status === "running" && !receipt.finishedAt,
  );
  if (interruptedNodeIds.size === 0 && !hasInterruptedReceipt) return next;

  const message = "上一次执行在服务重启前中断，外部费用或文件结果未知；请先核对执行回执。";
  for (const node of next.nodes) {
    if (!interruptedNodeIds.has(node.id)) continue;
    node.status = "needs_human";
    node.lastError = message;
  }
  for (const receipt of next.executionReceipts) {
    if (receipt.status !== "running" || receipt.finishedAt) continue;
    receipt.status = "needs_human";
    receipt.finishedAt = now;
    receipt.errorMessage = message;
  }
  next.status = deriveRunStatus(next);
  next.updatedAt = now;
  return WorkflowRunSchema.parse(next);
}

export function synchronizeRun(run: WorkflowRun): WorkflowRun {
  const next = WorkflowRunSchema.parse(structuredClone(run));
  promotePendingNodes(next);
  next.status = deriveRunStatus(next);
  return WorkflowRunSchema.parse(next);
}

export function applyNodeExecution(
  run: WorkflowRun,
  nodeId: string,
  outcome: NodeExecutionOutcome,
  now = new Date().toISOString(),
): WorkflowRun {
  const next = WorkflowRunSchema.parse(structuredClone(run));
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Node '${nodeId}' was not found`);
  if (node.status === "pending" || node.status === "awaiting_spend_approval") {
    throw new Error(`Node '${nodeId}' is not executable`);
  }

  const outputs = outcome.outputs ?? {};
  if (outcome.status === "succeeded") {
    const missingOutput = node.outputArtifactIds.find((artifactId) => !(artifactId in outputs));
    if (missingOutput) throw new Error(`Execution did not produce '${missingOutput}'`);
  }

  const changedArtifactIds: string[] = [];
  for (const [artifactId, data] of Object.entries(outputs)) {
    if (!node.outputArtifactIds.includes(artifactId)) {
      throw new Error(`Artifact '${artifactId}' is not an output of node '${nodeId}'`);
    }
    const artifact = next.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) throw new Error(`Artifact '${artifactId}' was not found`);
    const sha256 = artifactDataSha256(data);
    const activeVersion = artifact.versions.find((version) => version.id === artifact.activeVersionId);
    if (activeVersion?.sha256 === sha256) continue;
    const version = {
      id: `${artifact.id}-v${artifact.versions.length + 1}`,
      createdAt: now,
      sha256,
      source: "generated" as const,
      data,
    };
    artifact.versions.push(version);
    artifact.activeVersionId = version.id;
    changedArtifactIds.push(artifactId);
  }

  node.inputVersionIds = node.inputArtifactIds.flatMap((artifactId) => {
    const artifact = next.artifacts.find((candidate) => candidate.id === artifactId);
    return artifact ? [artifact.activeVersionId] : [];
  });
  node.status = outcome.status === "rejected" ? "failed" : outcome.status;
  node.providerId = outcome.providerId;
  node.modelId = outcome.modelId;
  node.estimatedCostCny = outcome.estimatedCostCny;
  node.actualCostCny = outcome.actualCostCny;
  node.staleReason = undefined;
  node.lastError = outcome.status === "failed" || outcome.status === "rejected" || (outcome.status === "needs_human" && outcome.errorMessage)
    ? outcome.errorMessage ?? "执行失败"
    : undefined;

  const runningReceipt = [...next.executionReceipts].reverse().find(
    (receipt) => receipt.nodeId === node.id && receipt.status === "running" && !receipt.finishedAt,
  );
  const completedReceipt = {
    id: runningReceipt?.id ?? `receipt-${node.id}-${next.executionReceipts.length + 1}`,
    nodeId: node.id,
    providerId: outcome.providerId,
    modelId: outcome.modelId,
    status: outcome.status,
    billing: outcome.billing,
    estimatedCostCny: outcome.estimatedCostCny,
    actualCostCny: outcome.actualCostCny,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    errorMessage: outcome.errorMessage,
  };
  if (runningReceipt) Object.assign(runningReceipt, completedReceipt);
  else next.executionReceipts.push(completedReceipt);

  for (const artifactId of changedArtifactIds) invalidateExecutedConsumers(next, artifactId, node.id);
  if (node.id === "source-packet" && node.status === "failed") {
    const repair = next.nodes.find((candidate) => candidate.id === "research-repair");
    if (repair) {
      repair.status = "ready";
      repair.inputVersionIds = repair.inputArtifactIds.flatMap((artifactId) => {
        const artifact = next.artifacts.find((candidate) => candidate.id === artifactId);
        return artifact ? [artifact.activeVersionId] : [];
      });
      repair.staleReason = "资料不足，自动重写检索计划";
    }
  }
  if (node.status === "succeeded") promotePendingNodes(next);
  next.updatedAt = now;
  next.status = deriveRunStatus(next);
  return WorkflowRunSchema.parse(next);
}

function invalidateConsumers(run: WorkflowRun, changedArtifactId: string): Set<string> {
  const pendingArtifacts = [changedArtifactId];
  const visitedArtifacts = new Set<string>();
  const staleNodeIds = new Set<string>();

  while (pendingArtifacts.length > 0) {
    const artifactId = pendingArtifacts.shift();
    if (!artifactId || visitedArtifacts.has(artifactId)) continue;
    visitedArtifacts.add(artifactId);

    for (const node of run.nodes) {
      if (!node.inputArtifactIds.includes(artifactId)) continue;
      if (node.status === "pending") continue;
      node.status = "stale";
      node.staleReason = "上游蓝图已更新，需要重新生成";
      staleNodeIds.add(node.id);
      if (node.id !== "research-repair") pendingArtifacts.push(...node.outputArtifactIds);
    }
  }

  return staleNodeIds;
}

function deriveRunStatus(run: WorkflowRun): WorkflowRun["status"] {
  if (run.publicationRecords.some((record) => record.status === "published")) return "completed";
  if (run.nodes.some((node) => node.status === "failed")) return "failed";
  const publishNode = run.nodes.find((node) => node.capability === "publish.package");
  if (publishNode?.status === "succeeded") return "release_ready";
  if (run.nodes.some((node) => node.status === "needs_human" || node.status === "awaiting_spend_approval")) return "needs_human";
  return "active";
}

function invalidateExecutedConsumers(
  run: WorkflowRun,
  changedArtifactId: string,
  producerNodeId: string,
): void {
  const pendingArtifacts = [changedArtifactId];
  const visitedArtifacts = new Set<string>();

  while (pendingArtifacts.length > 0) {
    const artifactId = pendingArtifacts.shift();
    if (!artifactId || visitedArtifacts.has(artifactId)) continue;
    visitedArtifacts.add(artifactId);
    for (const node of run.nodes) {
      if (node.id === producerNodeId || !node.inputArtifactIds.includes(artifactId)) continue;
      if (node.status === "pending") continue;
      node.status = "stale";
      node.staleReason = "上游产物已生成新版本，需要重新运行";
      if (node.id !== "research-repair") pendingArtifacts.push(...node.outputArtifactIds);
    }
  }
}

function promotePendingNodes(run: WorkflowRun): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (node.status !== "pending") continue;
      const prerequisites = node.prerequisiteNodeIds.map((nodeId) =>
        run.nodes.find((candidate) => candidate.id === nodeId),
      );
      if (!prerequisites.every((prerequisite) => prerequisite?.status === "succeeded")) continue;
      const producers = node.inputArtifactIds.map((artifactId) =>
        run.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId)),
      );
      if (!producers.every((producer) => !producer || producer.status === "succeeded")) continue;
      node.inputVersionIds = node.inputArtifactIds.flatMap((artifactId) => {
        const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
        return artifact ? [artifact.activeVersionId] : [];
      });
      node.status = "ready";
      changed = true;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

export function artifactDataSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function newArtifact(id: string, kind: string, data: unknown, now: string): Artifact {
  const version = {
    id: `${id}-v1`,
    createdAt: now,
    sha256: artifactDataSha256(data),
    source: "derived" as const,
    data,
  };
  return { id, kind, activeVersionId: version.id, versions: [version] };
}

function newNode(
  id: string,
  label: string,
  phase: WorkflowNode["phase"],
  role: string,
  capability: string,
  inputArtifactIds: string[],
  outputArtifactIds: string[],
  status: WorkflowNode["status"] = "pending",
  prerequisiteNodeIds: string[] = [],
): WorkflowNode {
  return {
    id,
    label,
    phase,
    role,
    capability,
    status,
    inputArtifactIds,
    inputVersionIds: [],
    outputArtifactIds,
    prerequisiteNodeIds,
    estimatedCostCny: 0,
  };
}
