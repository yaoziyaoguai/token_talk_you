import { createSeedSnapshot } from "@token-talk/domain";
import { describe, expect, it } from "vitest";
import {
  applyNodeExecution,
  beginNodeExecution,
  createRunFromCandidate,
  recoverInterruptedExecutions,
  reviseArtifact,
  synchronizeRun,
} from "../src/index.js";

const NOW = "2026-08-28T00:00:00.000Z";
const NOW_LATER = "2026-08-28T01:00:00.000Z";

describe("artifact revision", () => {
  it("marks every dependent node stale when a locked planning artifact changes", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");

    const revised = reviseArtifact(run, "artifact-blueprint", { title: "新的节目蓝图" }, NOW_LATER);

    expect(revised.artifacts.find((item) => item.id === "artifact-blueprint")?.versions).toHaveLength(2);
    expect(revised.nodes.find((item) => item.id === "segment-room-1")?.status).toBe("stale");
    expect(revised.nodes.find((item) => item.id === "publish-package")?.status).toBe("stale");
    expect(revised.nodes.find((item) => item.id === "episode-blueprint")?.status).toBe("succeeded");
    expect(revised.nodes.find((item) => item.id === "segment-room-1")?.inputVersionIds).toContain("artifact-blueprint-v1");
    expect(revised.artifacts.find((item) => item.id === "artifact-blueprint")?.activeVersionId).toBe("artifact-blueprint-v2");
  });

  it("rejects an unknown artifact instead of mutating the run", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");

    expect(() => reviseArtifact(run, "missing", {}, NOW_LATER)).toThrow("Artifact 'missing' was not found");
    expect(run.updatedAt).toBe(NOW);
  });

  it("keeps never-executed downstream nodes pending after an upstream revision", () => {
    const run = createPodcastRun();

    const revised = reviseArtifact(run, "artifact-blueprint", { status: "draft", segments: [{ title: "新版" }] }, NOW_LATER);

    expect(revised.nodes.find((node) => node.id === "segment-room-1")?.status).toBe("pending");
    expect(revised.nodes.find((node) => node.id === "publish-package")?.status).toBe("pending");
  });
});

describe("node execution", () => {
  it("persists a running attempt before replacing it with the final receipt", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const running = beginNodeExecution(run, "source-packet", {
      providerId: "test-executor",
      modelId: "research-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      startedAt: NOW_LATER,
    });

    expect(running.nodes.find((node) => node.id === "source-packet")?.status).toBe("running");
    expect(running.executionReceipts.at(-1)).toMatchObject({ status: "running", startedAt: NOW_LATER });
    expect(running.executionReceipts.at(-1)?.finishedAt).toBeUndefined();

    const completed = applyNodeExecution(running, "source-packet", {
      status: "succeeded",
      providerId: "test-executor",
      modelId: "research-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW_LATER,
      finishedAt: "2026-08-28T01:00:02.000Z",
      outputs: { "artifact-sources": { status: "verified", sources: [] } },
    });
    expect(completed.executionReceipts).toHaveLength(1);
    expect(completed.executionReceipts[0]).toMatchObject({ status: "succeeded", finishedAt: "2026-08-28T01:00:02.000Z" });
  });

  it("turns an interrupted persisted attempt into an explicit reconciliation gate", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const running = beginNodeExecution(run, "source-packet", {
      providerId: "test-executor",
      modelId: "research-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      startedAt: NOW,
    });

    const recovered = recoverInterruptedExecutions(running, NOW_LATER);

    expect(recovered.nodes.find((node) => node.id === "source-packet")).toMatchObject({
      status: "needs_human",
      lastError: "上一次执行在服务重启前中断，外部费用或文件结果未知；请先核对执行回执。",
    });
    expect(recovered.executionReceipts.at(-1)).toMatchObject({
      status: "needs_human",
      finishedAt: NOW_LATER,
      errorMessage: "上一次执行在服务重启前中断，外部费用或文件结果未知；请先核对执行回执。",
    });
  });

  it("records a generated version, the consumed input versions, and a receipt", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const staleRun = reviseArtifact(run, "artifact-claims", { status: "verified", claims: [] }, NOW_LATER);

    const executed = applyNodeExecution(staleRun, "cast-plan", {
      status: "succeeded",
      providerId: "local-production-engine",
      modelId: "cast-plan-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: "2026-08-28T01:00:01.000Z",
      finishedAt: "2026-08-28T01:00:02.000Z",
      outputs: {
        "artifact-cast": { status: "draft", policy: "dynamic", roles: [{ name: "问题拆解者" }] },
      },
    }, "2026-08-28T01:00:02.000Z");

    const cast = executed.artifacts.find((artifact) => artifact.id === "artifact-cast");
    const node = executed.nodes.find((item) => item.id === "cast-plan");
    expect(cast?.versions).toHaveLength(2);
    expect(cast?.activeVersionId).toBe("artifact-cast-v2");
    expect(cast?.versions[1]?.source).toBe("generated");
    expect(node).toMatchObject({
      status: "succeeded",
      providerId: "local-production-engine",
      modelId: "cast-plan-v1",
      inputVersionIds: ["artifact-brief-v1", "artifact-claims-v2"],
    });
    expect(executed.executionReceipts).toHaveLength(1);
    expect(executed.executionReceipts[0]).toMatchObject({
      nodeId: "cast-plan",
      status: "succeeded",
      actualCostCny: 0,
    });
    expect(executed.nodes.find((item) => item.id === "episode-blueprint")?.status).toBe("stale");
  });

  it("records a receipt without invalidating consumers when generated output is unchanged", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!artifact || !active) throw new Error("source artifact missing");

    const executed = applyNodeExecution(run, "source-packet", {
      status: "succeeded",
      providerId: "human-research",
      modelId: "source-gate-v1",
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW_LATER,
      outputs: { "artifact-sources": active.data },
    }, NOW_LATER);

    expect(executed.artifacts.find((candidate) => candidate.id === "artifact-sources")?.versions).toHaveLength(1);
    expect(executed.nodes.find((candidate) => candidate.id === "claim-ledger")?.status).toBe("succeeded");
    expect(executed.executionReceipts).toHaveLength(1);
  });

  it("does not propagate claim invalidation backwards through the research repair feedback edge", () => {
    const run = createPodcastRun();
    const source = run.nodes.find((node) => node.id === "source-packet");
    const claims = run.nodes.find((node) => node.id === "claim-ledger");
    const repair = run.nodes.find((node) => node.id === "research-repair");
    if (!source || !claims || !repair) throw new Error("research nodes missing");
    source.status = "succeeded";
    claims.status = "ready";
    repair.status = "succeeded";

    const executed = applyNodeExecution(run, claims.id, {
      status: "succeeded",
      providerId: "test-agent",
      modelId: "claims-v1",
      billing: "subscription",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW_LATER,
      outputs: { "artifact-claims": { status: "verified", claims: [{ id: "claim-1", sourceIds: ["source-1"] }] } },
    }, NOW_LATER);

    expect(executed.nodes.find((node) => node.id === "source-packet")?.status).toBe("succeeded");
    expect(executed.nodes.find((node) => node.id === "research-repair")?.status).toBe("stale");
  });

  it("invalidates an existing release package when the audio audit produces a new result", () => {
    const run = createPodcastRun();
    const audioAudit = run.nodes.find((node) => node.id === "audio-audit");
    const publish = run.nodes.find((node) => node.id === "publish-package");
    if (!audioAudit || !publish) throw new Error("release nodes missing");
    audioAudit.status = "ready";
    publish.status = "succeeded";
    run.status = "release_ready";

    const running = beginNodeExecution(run, audioAudit.id, {
      providerId: "audio-auditor",
      modelId: "release-preflight-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      startedAt: NOW,
    });
    expect(running.nodes.find((node) => node.id === "publish-package")?.status).toBe("succeeded");
    expect(running.status).toBe("release_ready");

    const reviewed = applyNodeExecution(running, audioAudit.id, {
      status: "succeeded",
      providerId: "audio-auditor",
      modelId: "release-preflight-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW_LATER,
      outputs: { "artifact-audio-audit": { verdict: "pass", findings: [], checkedAudioVersionId: "artifact-audio-v1" } },
    }, NOW_LATER);

    expect(reviewed.nodes.find((node) => node.id === "publish-package")).toMatchObject({
      status: "stale",
      staleReason: "上游产物已生成新版本，需要重新运行",
    });
    expect(reviewed.status).toBe("active");
  });

  it("derives failed and completed run status from the whole graph", () => {
    const failedRun = createPodcastRun();
    const sourceNode = failedRun.nodes.find((node) => node.id === "source-packet");
    if (!sourceNode) throw new Error("source node missing");
    sourceNode.status = "ready";
    const failed = applyNodeExecution(failedRun, "source-packet", {
      status: "failed",
      providerId: "test-executor",
      modelId: "research-v1",
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW_LATER,
      errorMessage: "research failed",
    }, NOW_LATER);
    expect(failed.status).toBe("failed");
    expect(failed.nodes.find((node) => node.id === "research-repair")).toMatchObject({
      status: "ready",
      staleReason: "资料不足，自动重写检索计划",
    });
    const parallel = failed.nodes.find((node) => node.id === "visual-pack");
    if (!parallel) throw new Error("parallel node missing");
    parallel.status = "ready";
    const stillFailed = beginNodeExecution(failed, parallel.id, {
      providerId: "image-provider",
      modelId: "image-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      startedAt: NOW_LATER,
    });
    expect(stillFailed.status).toBe("failed");

    const completedRun = createPodcastRun();
    const publish = completedRun.nodes.find((node) => node.id === "publish-package");
    if (!publish) throw new Error("publish node missing");
    publish.status = "ready";
    const completed = applyNodeExecution(completedRun, publish.id, {
      status: "succeeded",
      providerId: "publisher",
      modelId: "publish-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW_LATER,
      outputs: { "artifact-publish": { status: "ready", releaseReady: true } },
    }, NOW_LATER);
    expect(completed.status).toBe("release_ready");
  });

  it("derives completed only from a successful external publication record", () => {
    const run = createPodcastRun();
    run.status = "release_ready";
    run.publicationRecords.push({
      id: "publication-1",
      requestId: "publish-request-001",
      platform: "小宇宙",
      status: "published",
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      releasePackageVersionId: "artifact-publish-v1",
      releasePackageSha256: "a".repeat(64),
      audioSha256: "b".repeat(64),
      coverSha256: "c".repeat(64),
      publishedAt: NOW,
      registeredAt: NOW,
    });

    expect(synchronizeRun(run).status).toBe("completed");
  });
});

describe("candidate adoption", () => {
  it("creates a podcast-native run with research, dynamic casting, audit, music, cover, and release gates", () => {
    const run = createRunFromCandidate({
      id: "candidate-1",
      origin: "trend",
      title: "AI 搜索正在改变我们如何判断来源吗？",
      hook: "答案可能不在模型，而在引用链。",
      rationale: "有现实变化、争议与足够资料空间。",
      category: "ai_tech",
      platform: "Hacker News",
      suggestedRoles: ["技术观察者", "事实核验者"],
      verdict: "deep_discussion",
      targetMinutes: { min: 30, max: 45 },
      score: {
        overall: 82,
        audienceRelevance: 85,
        conversationPotential: 84,
        evidenceDepth: 68,
        longformDepth: 88,
        freshness: 90,
        seriesFit: 72,
        feasibility: 80,
        risk: 24,
      },
      evidence: [],
      verification: { status: "review_required", reason: "需要补充独立来源", independentSources: 0 },
      generatedAt: NOW,
    }, {
      id: "run-1",
      opportunityId: "opportunity-1",
      seriesId: "series-1",
      recipeId: "deep-reading-v1",
      productionIntent: {
        hook: "答案可能不在模型，而在引用链。",
        targetMinutes: 36,
        musicPolicy: "narrative",
        budgetPolicy: "balanced",
        maxCostCny: 12,
      },
      now: NOW,
    });

    expect(run.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "source-packet",
      "cast-plan",
      "music-cue-sheet",
      "visual-pack",
      "evidence-audit",
      "script-audit",
      "script-repair",
      "audio-audit",
    ]));
    expect(run.nodes.find((node) => node.id === "cast-plan")?.role).toBe("选角导演");
    expect(run.nodes.some((node) => node.capability === "review.human")).toBe(false);
    expect(run.nodes.find((node) => node.id === "cast-plan")?.prerequisiteNodeIds).toContain("evidence-audit");
    expect(run.nodes.find((node) => node.id === "script-repair")?.prerequisiteNodeIds).toContain("script-audit");
    expect(run.nodes.find((node) => node.id === "publish-package")?.prerequisiteNodeIds).toContain("audio-audit");
    expect(run.nodes.find((node) => node.id === "publish-package")?.prerequisiteNodeIds).toContain("release-editorial");
    expect(run.nodes.find((node) => node.id === "release-editorial")).toMatchObject({
      role: "发行编辑",
      capability: "release.copy",
      prerequisiteNodeIds: ["script-audit", "script-repair"],
    });
    for (const nodeId of ["visual-pack", "voice-casting", "music-cue-sheet"]) {
      expect(run.nodes.find((node) => node.id === nodeId)?.prerequisiteNodeIds)
        .toEqual(["script-audit", "script-repair"]);
    }
    expect(run.artifacts.find((artifact) => artifact.id === "artifact-cast")?.versions[0]?.data).toMatchObject({ policy: "dynamic" });
    expect(run.artifacts.find((artifact) => artifact.id === "artifact-sources")?.versions[0]?.data).toMatchObject({
      status: "pending",
      sourceKind: "discovery_signals",
      verifiedIndependentSourceCount: 0,
    });
  });

  it("uses a focused but still long-form production graph for a rapid brief", () => {
    const deepCandidate = {
      id: "candidate-rapid",
      origin: "trend" as const,
      title: "今天发生了什么？",
      hook: "在完整证据链里讲清楚。",
      rationale: "时效性选题。",
      category: "ai_tech" as const,
      platform: "Hacker News",
      suggestedRoles: ["本期主持"],
      verdict: "rapid_brief" as const,
      targetMinutes: { min: 15, max: 25 },
      score: { overall: 76, audienceRelevance: 80, conversationPotential: 70, evidenceDepth: 55, longformDepth: 58, freshness: 95, seriesFit: 68, feasibility: 92, risk: 20 },
      evidence: [],
      verification: { status: "review_required" as const, reason: "需要核验", independentSources: 0 },
      generatedAt: NOW,
    };
    const run = createRunFromCandidate(deepCandidate, {
      id: "run-rapid",
      opportunityId: "opportunity-rapid",
      seriesId: "series-rapid",
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: deepCandidate.hook, targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "economy", maxCostCny: 3 },
      now: NOW,
    });

    expect(run.nodes).toHaveLength(20);
    expect(run.nodes.find((node) => node.id === "research-plan")).toMatchObject({
      capability: "research.plan",
      status: "ready",
      outputArtifactIds: ["artifact-research-plan"],
    });
    expect(run.nodes.find((node) => node.id === "claim-ledger")).toMatchObject({
      capability: "research.claims",
      inputArtifactIds: ["artifact-research-plan", "artifact-sources"],
      outputArtifactIds: ["artifact-claims"],
    });
    expect(run.nodes.find((node) => node.id === "evidence-audit")?.inputArtifactIds).toContain("artifact-claims");
    expect(run.nodes.find((node) => node.id === "research-repair")?.prerequisiteNodeIds).toContain("evidence-audit");
    expect(run.nodes.find((node) => node.id === "cast-plan")?.prerequisiteNodeIds).toContain("research-repair");
    expect(run.nodes.some((node) => node.id === "music-cue-sheet")).toBe(true);
    expect(run.nodes.some((node) => node.id === "visual-pack")).toBe(true);
    expect(run.nodes.some((node) => node.id === "emotional-arc")).toBe(true);
    expect(run.nodes.some((node) => node.id === "showrunner-assembly")).toBe(true);
    const audioMix = run.nodes.find((node) => node.id === "audio-mix");
    if (!audioMix) throw new Error("rapid audio node missing");
    expect(audioMix.inputArtifactIds).toContain("artifact-cues");
    audioMix.status = "ready";
    run.spendAuthorizations.push({
      id: "authorization-rapid-audio",
      nodeId: audioMix.id,
      providerId: "paid-voice",
      modelId: "voice-v1",
      inputVersionIds: [...audioMix.inputVersionIds],
      maxAttempts: 1,
      maxCostCny: 1,
      approvedAt: NOW,
      expiresAt: "2026-08-29T00:00:00.000Z",
    });

    const revised = reviseArtifact(run, "artifact-cues", { status: "confirmed", confirmed: true, cues: [] }, NOW_LATER);

    expect(revised.nodes.find((node) => node.id === "audio-mix")?.status).toBe("stale");
    expect(revised.spendAuthorizations.some((authorization) => authorization.nodeId === "audio-mix")).toBe(false);
  });
});

function createPodcastRun() {
  const candidate = {
    id: "candidate-helper",
    origin: "trend" as const,
    title: "测试节目",
    hook: "测试工作流",
    rationale: "测试",
    category: "ai_tech" as const,
    platform: "Hacker News",
    suggestedRoles: ["主持"],
    verdict: "deep_discussion" as const,
    targetMinutes: { min: 30, max: 45 },
    score: { overall: 80, audienceRelevance: 80, conversationPotential: 80, evidenceDepth: 70, longformDepth: 80, freshness: 80, seriesFit: 70, feasibility: 80, risk: 20 },
    evidence: [],
    verification: { status: "review_required" as const, reason: "需要核验", independentSources: 0 },
    generatedAt: NOW,
  };
  return createRunFromCandidate(candidate, {
    id: "run-helper",
    opportunityId: "opportunity-helper",
    seriesId: "series-helper",
    recipeId: "deep-reading-v1",
    productionIntent: { hook: candidate.hook, targetMinutes: 36, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
    now: NOW,
  });
}
