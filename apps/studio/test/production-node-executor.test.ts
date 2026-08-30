import { createSeedSnapshot, type WorkflowRun } from "@token-talk/domain";
import { reviseArtifact, type NodeExecutionOutcome } from "@token-talk/workflow";
import { describe, expect, it, vi } from "vitest";
import type { NodeExecutionContext, NodeExecutor } from "../src/server/node-executor.js";
import type { PodcastProductionModel, ProductionModelRequest } from "../src/server/production-model.js";
import { ProductionModelNodeExecutor } from "../src/server/production-node-executor.js";

const NOW = "2026-08-29T00:00:00.000Z";

describe("ProductionModelNodeExecutor", () => {
  it("lets the model choose a dynamic one-to-four role cast", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "cast-plan");
    if (!node) throw new Error("cast node missing");
    const model = fakeModel({
      roles: [{
        id: "role-systems-reader",
        name: "系统拆解者",
        responsibility: "把主问题拆成可验证的判断",
        speakingStyle: "冷静、短句、先定义再追问",
        mustAsk: "这个结论在哪些条件下不成立？",
        voiceBrief: "中速、克制、低表演感",
      }],
    });
    const fallback = fallbackExecutor();
    const executor = new ProductionModelNodeExecutor(model, fallback, () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-cast", signal: new AbortController().signal });

    expect(result).toMatchObject({ status: "succeeded", providerId: "test-production-model", modelId: "test-model" });
    expect(result.outputs?.["artifact-cast"]).toMatchObject({ policy: "dynamic", roles: [{ name: "系统拆解者" }] });
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it("keeps a fixed series cast even when the model proposes different roles", async () => {
    let run = groundedRun();
    run.productionIntent = {
      ...run.productionIntent!,
      castPolicy: {
        mode: "fixed",
        recurringRoleIds: ["series-host"],
        roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持长期栏目视角" }],
      },
    };
    run = reviseArtifact(run, "artifact-cast", {
      status: "pending",
      policy: "dynamic",
      recurringRoles: [{ id: "tampered-role", name: "被篡改的角色" }],
      suggestedRoles: ["临时评论员"],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "cast-plan");
    if (!node) throw new Error("cast node missing");
    const model = fakeModel({
      roles: [{ id: "model-guest", name: "临时评论员", responsibility: "评论", speakingStyle: "直接", mustAsk: "为什么？", voiceBrief: "快速" }],
    });
    const executor = new ProductionModelNodeExecutor(model, fallbackExecutor(), () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-fixed-cast", signal: new AbortController().signal });

    expect(result.outputs?.["artifact-cast"]).toMatchObject({
      policy: "fixed",
      roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持长期栏目视角" }],
    });
  });

  it("accepts a long script only when every role, segment, and claim reference is grounded", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "segment-room-1");
    if (!node) throw new Error("script node missing");
    const lines = Array.from({ length: 12 }, (_, index) => ({
      segmentId: ["opening", "evidence", "closing"][index % 3],
      speaker: index % 2 === 0 ? "问题引导者" : "事实编辑",
      text: `这是第 ${index + 1} 轮讨论。${"我们只沿着已核验材料推进，同时保留反例和限定条件。".repeat(13)}`,
      claimIds: [index % 2 === 0 ? "claim-one" : "claim-two"],
      pauseAfterMs: 250,
    }));
    const model = fakeModel({ lines });
    const executor = new ProductionModelNodeExecutor(model, fallbackExecutor(), () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-script", signal: new AbortController().signal });
    const script = result.outputs?.["artifact-segment-1"] as Record<string, unknown>;

    expect(result.status).toBe("succeeded");
    expect(script).toMatchObject({ factualPolicy: "verified_claim_references_only", estimatedCharacters: expect.any(Number) });
    expect(Number(script.estimatedCharacters)).toBeGreaterThanOrEqual(20 * 220 * 0.85);
  });

  it("regenerates only the requested chapter and keeps locked model input unchanged", async () => {
    let run = groundedRun();
    run = reviseArtifact(run, "artifact-blueprint", {
      status: "draft",
      segments: [
        { id: "opening", title: "开场", minutes: 7 },
        { id: "evidence", title: "证据", minutes: 7 },
        { id: "closing", title: "收束", minutes: 6 },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-segment-1", {
      status: "draft",
      lockedSegmentIds: ["opening"],
      lines: [
        { segmentId: "opening", speaker: "问题引导者", text: "锁定开场", claimIds: [] },
        { segmentId: "evidence", speaker: "事实编辑", text: "旧证据", claimIds: ["claim-one"] },
        { segmentId: "closing", speaker: "问题引导者", text: "保留结尾", claimIds: [] },
      ],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "segment-room-1");
    if (!node) throw new Error("script node missing");
    const text = "我们只沿着已核验材料推进，同时保留反例、限定条件和前后章节的自然承接。".repeat(10);
    const model = fakeModel({ lines: Array.from({ length: 4 }, (_, index) => ({
      segmentId: "evidence",
      speaker: index % 2 === 0 ? "问题引导者" : "事实编辑",
      text,
      claimIds: [index % 2 === 0 ? "claim-one" : "claim-two"],
    })) });
    const executor = new ProductionModelNodeExecutor(model, fallbackExecutor(), () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-target-segment", input: { segmentId: "evidence" }, signal: new AbortController().signal });

    expect(model.generate).toHaveBeenCalledWith(expect.objectContaining({
      targetMinutes: 7,
      targetSegment: expect.objectContaining({ id: "evidence" }),
      currentScript: expect.objectContaining({ lockedSegmentIds: ["opening"] }),
    }), expect.any(AbortSignal));
    const script = result.outputs?.["artifact-segment-1"] as { lockedSegmentIds: string[]; lines: Array<{ segmentId: string; text: string }> };
    expect(script.lockedSegmentIds).toEqual(["opening"]);
    expect(script.lines[0]).toMatchObject({ segmentId: "opening", text: "锁定开场" });
    expect(script.lines.filter((line) => line.segmentId === "evidence")).toHaveLength(4);
    expect(script.lines.filter((line) => line.segmentId === "evidence")).toEqual(expect.arrayContaining([expect.objectContaining({ text })]));
    expect(script.lines.at(-1)).toMatchObject({ segmentId: "closing", text: "保留结尾" });
  });

  it("rejects fabricated claim references and exposes an honest fallback draft", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "segment-room-1");
    if (!node) throw new Error("script node missing");
    const model = fakeModel({
      lines: [
        { segmentId: "opening", speaker: "问题引导者", text: "未经核验的断言。".repeat(100), claimIds: ["invented-claim"] },
        { segmentId: "evidence", speaker: "事实编辑", text: "继续断言。".repeat(100), claimIds: ["claim-one"] },
        { segmentId: "closing", speaker: "问题引导者", text: "收束。".repeat(100), claimIds: ["claim-two"] },
        { segmentId: "closing", speaker: "事实编辑", text: "保留边界。".repeat(100), claimIds: [] },
      ],
    });
    const fallback = fallbackExecutor();
    const executor = new ProductionModelNodeExecutor(model, fallback, () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-invalid", signal: new AbortController().signal });

    expect(result).toMatchObject({
      status: "failed",
      providerId: "local-production-fallback",
      errorMessage: expect.stringContaining("未核验 claim"),
    });
    expect(result.outputs?.["artifact-segment-1"]).toMatchObject({
      generation: { mode: "structured_template_fallback", reason: expect.stringContaining("invented-claim") },
    });
  });

  it("lets a grounded blueprint fallback proceed automatically", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "episode-blueprint");
    if (!node) throw new Error("blueprint node missing");
    const model = fakeModel({ segments: [] });
    const fallback = fallbackExecutor();
    const executor = new ProductionModelNodeExecutor(model, fallback, () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-blueprint-fallback", signal: new AbortController().signal });

    expect(result).toMatchObject({
      status: "succeeded",
      providerId: "local-production-fallback",
      modelId: "episode.blueprint-template-fallback-v1",
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.outputs?.["artifact-blueprint"]).toMatchObject({
      generation: { mode: "structured_template_fallback", reason: expect.any(String) },
    });
  });

  it("rejects continuous background beds under the minimal music policy", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "music-cue-sheet");
    if (!node) throw new Error("music node missing");
    const model = fakeModel({
      cues: [{ id: "cue-one", segmentId: "evidence", action: "bed", durationSeconds: 20, mood: "紧张", intensity: 3, purpose: "持续铺底", assetQuery: "pulse" }],
    });
    const executor = new ProductionModelNodeExecutor(model, fallbackExecutor(), () => NOW);

    const result = await executor.execute({ run, node, attemptId: "attempt-music", signal: new AbortController().signal });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("不允许持续铺底");
  });

  it("forwards obsolete media cleanup to the fallback executor", async () => {
    const run = groundedRun();
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const fallback = fallbackExecutor();
    fallback.discard = vi.fn(async () => undefined);
    fallback.commit = vi.fn(async (_context, outcome) => outcome);
    const executor = new ProductionModelNodeExecutor(null, fallback, () => NOW);
    const outcome = await fallback.execute({ run, node, attemptId: "attempt-audio", signal: new AbortController().signal });

    await executor.discard({ run, node, attemptId: "attempt-audio" }, outcome);
    await executor.commit({ run, node, attemptId: "attempt-audio" }, outcome);

    expect(fallback.discard).toHaveBeenCalledOnce();
    expect(fallback.commit).toHaveBeenCalledOnce();
  });
});

function groundedRun(): WorkflowRun {
  let run = createSeedSnapshot(NOW).runs[0];
  if (!run) throw new Error("seed run missing");
  run.productionIntent = {
    hook: "从直觉的边界开始",
    targetMinutes: 20,
    musicPolicy: "minimal",
    budgetPolicy: "local",
    maxCostCny: 0,
    sonicPalette: [],
    sonicExclusions: [],
  };
  run = reviseArtifact(run, "artifact-sources", {
    status: "verified",
    verifiedIndependentSourceCount: 2,
    sources: [
      { id: "source-one", title: "来源一", url: "https://one.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:one.example", verificationMethod: "server_action" },
      { id: "source-two", title: "来源二", url: "https://two.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:two.example", verificationMethod: "server_action" },
    ],
  }, NOW);
  run = reviseArtifact(run, "artifact-claims", {
    status: "verified",
    claims: [
      { id: "claim-one", text: "直觉在熟悉环境里可以提高判断速度。", sourceIds: ["source-one"], spokenQualifier: "在来源讨论的实验条件下" },
      { id: "claim-two", text: "同一机制在陌生环境里可能造成系统偏差。", sourceIds: ["source-two"] },
    ],
  }, NOW);
  run = reviseArtifact(run, "artifact-cast", {
    status: "draft",
    roles: [
      { id: "guide", name: "问题引导者" },
      { id: "facts", name: "事实编辑" },
    ],
  }, NOW);
  run = reviseArtifact(run, "artifact-blueprint", {
    status: "draft",
    segments: [
      { id: "opening", title: "开场", minutes: 7 },
      { id: "evidence", title: "证据", minutes: 7 },
      { id: "closing", title: "收束", minutes: 6 },
    ],
  }, NOW);
  return run;
}

function fakeModel(output: unknown): PodcastProductionModel {
  return {
    providerId: "test-production-model",
    modelId: "test-model",
    generate: vi.fn(async (_request: ProductionModelRequest) => output),
  };
}

function fallbackExecutor(): NodeExecutor & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (context: NodeExecutionContext): Promise<NodeExecutionOutcome> => ({
      status: "succeeded",
      providerId: "local-production-engine",
      modelId: "template-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      outputs: { [context.node.outputArtifactIds[0] ?? "missing"]: { status: "draft", lines: [], cues: [] } },
    })),
  };
}
