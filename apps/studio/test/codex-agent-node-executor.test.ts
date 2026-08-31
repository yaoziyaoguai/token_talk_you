import { createSeedSnapshot } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";
import { describe, expect, it, vi } from "vitest";
import { CodexAgentNodeExecutor } from "../src/server/codex-agent-node-executor.js";
import type { CodexAgentClient } from "../src/server/codex-agent-client.js";
import type { NodeExecutor } from "../src/server/node-executor.js";

const NOW = "2026-08-30T00:00:00.000Z";

describe("CodexAgentNodeExecutor", () => {
  it("allows long-form Codex nodes enough time for deep audit and chapter work", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "research.audit");
    if (!run || !node) throw new Error("seed audit missing");
    const client: CodexAgentClient = { providerId: "openai-codex-subscription", modelId: "codex-test", isConfigured: () => true, run: vi.fn() };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    expect(executor.plan({ run, node })).toMatchObject({ timeoutMs: 15 * 60_000 });
  });

  it("routes a production node through the broker and preserves dynamic-cast metadata", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "cast.plan");
    if (!run || !node) throw new Error("seed cast plan missing");
    run.productionIntent = {
      hook: "验证动态选角约束",
      targetMinutes: 30,
      musicPolicy: "minimal",
      budgetPolicy: "local",
      maxCostCny: 0,
      castPolicy: { mode: "dynamic", recurringRoleIds: [], roles: [], minSpeakers: 1, maxSpeakers: 4 },
      sonicPalette: [],
      sonicExclusions: [],
    };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: { roles: [{ id: "systems", name: "系统观察者", responsibility: "拆解系统影响", speakingStyle: "冷静", mustAsk: "谁承担代价", voiceBrief: "中速" }] },
        trace: { taskKind: "cast-plan" as const, promptVersion: "token-talk/cast-plan-v1", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "xhigh" as const },
      })),
    };
    const fallback = failingFallback();
    const executor = new CodexAgentNodeExecutor(client, fallback, () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-cast-001", signal: new AbortController().signal });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "cast-plan",
      protocolVersion: "token-talk/codex-agent-v1",
      payload: expect.objectContaining({ castPolicy: expect.objectContaining({ mode: "dynamic", maxSpeakers: 4 }) }),
    }), expect.any(AbortSignal));
    expect(fallback.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "succeeded", billing: "subscription", providerId: "openai-codex-subscription" });
    expect(outcome.outputs).toMatchObject({
      [node.outputArtifactIds[0]!]: {
        status: "draft",
        policy: "dynamic",
        roles: [{ name: "系统观察者" }],
        generatedBy: { taskKind: "cast-plan", reasoningEffort: "xhigh" },
      },
    });
  });

  it("routes final script, chapters, and verified sources to the release editor Agent", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "release.copy");
    const script = run?.artifacts.find((artifact) => artifact.id === "artifact-script");
    const scriptVersion = script?.versions.find((version) => version.id === script.activeVersionId);
    const blueprint = run?.artifacts.find((artifact) => artifact.id === "artifact-blueprint");
    const blueprintVersion = blueprint?.versions.find((version) => version.id === blueprint.activeVersionId);
    const sources = run?.artifacts.find((artifact) => artifact.id === "artifact-sources");
    const sourceVersion = sources?.versions.find((version) => version.id === sources.activeVersionId);
    if (!run || !node || !scriptVersion || !blueprintVersion || !sourceVersion) throw new Error("release editorial fixture missing");
    scriptVersion.data = { lines: [{ segmentId: "opening", speaker: "引导者", text: "先说清问题。", claimIds: [] }] };
    blueprintVersion.data = { segments: [{ id: "opening", title: "先说清问题", minutes: 10 }] };
    sourceVersion.data = { status: "verified", sources: [machineCheckedSource("source-one", "https://one.example/report"), machineCheckedSource("source-two", "https://two.example/report")] };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: { episodeTitle: "直觉可靠吗？", summary: "从证据边界讨论直觉。", showNotes: ["00:00 先说清问题"], keywords: ["判断"] },
        trace: { taskKind: "release-copy" as const, promptVersion: "token-talk/release-editor-v2", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "high" as const },
      })),
    };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-release-copy-001", signal: new AbortController().signal });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "release-copy",
      payload: expect.objectContaining({
        script: { lines: [expect.objectContaining({ text: "先说清问题。" })] },
        chapters: [expect.objectContaining({ id: "opening" })],
        verifiedSources: expect.arrayContaining([expect.objectContaining({ id: "source-one" })]),
      }),
    }), expect.any(AbortSignal));
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      status: "ready",
      episodeTitle: "直觉可靠吗？",
      generatedBy: { taskKind: "release-copy" },
    });
  });

  it("falls back without pretending that an unconfigured broker ran the task", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "cast.plan");
    if (!run || !node) throw new Error("seed cast plan missing");
    const fallback = succeedingFallback(node.outputArtifactIds[0]!);
    const client: CodexAgentClient = { providerId: "openai-codex-subscription", modelId: "codex-test", isConfigured: () => false, run: vi.fn() };
    const executor = new CodexAgentNodeExecutor(client, fallback, () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-cast-002", signal: new AbortController().signal });

    expect(client.run).not.toHaveBeenCalled();
    expect(fallback.execute).toHaveBeenCalledTimes(1);
    expect(outcome.providerId).toBe("local-fallback");
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      agentFallback: {
        requiredProviderId: "openai-codex-subscription",
        deterministicFallbackProviderId: "local-fallback",
        reason: expect.stringContaining("未配置"),
      },
    });
  });

  it("fails an independent audit when Codex is unavailable instead of accepting a local self-review", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "research.audit");
    if (!run || !node) throw new Error("seed research audit missing");
    const fallback = succeedingFallback(node.outputArtifactIds[0]!);
    const client: CodexAgentClient = { providerId: "openai-codex-subscription", modelId: "codex-test", isConfigured: () => false, run: vi.fn() };
    const executor = new CodexAgentNodeExecutor(client, fallback, () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-audit-001", signal: new AbortController().signal });

    expect(outcome).toMatchObject({
      status: "failed",
      providerId: "local-fallback",
      errorMessage: expect.stringContaining("Codex Agent 未完成"),
    });
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      agentFallback: {
        requiredProviderId: "openai-codex-subscription",
        deterministicFallbackProviderId: "local-fallback",
      },
    });
  });

  it("fails a configured Agent node instead of silently accepting its deterministic fallback", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "cast.plan");
    if (!run || !node) throw new Error("seed cast plan missing");
    const fallback = succeedingFallback(node.outputArtifactIds[0]!);
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => { throw new Error("Agent output failed schema validation"); }),
    };
    const executor = new CodexAgentNodeExecutor(client, fallback, () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-cast-invalid", signal: new AbortController().signal });

    expect(fallback.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "failed",
      providerId: "openai-codex-subscription",
      billing: "subscription",
      errorMessage: expect.stringContaining("schema validation"),
    });
    expect(outcome.outputs).toBeUndefined();
  });

  it("routes claim synthesis through Codex and rejects source IDs outside the machine-checked packet", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "research.claims");
    const sources = run?.artifacts.find((artifact) => artifact.id === "artifact-sources");
    const sourceVersion = sources?.versions.find((version) => version.id === sources.activeVersionId);
    if (!run || !node || !sourceVersion) throw new Error("research claim fixture missing");
    sourceVersion.data = {
      status: "machine_checked",
      sources: [
        machineCheckedSource("source-one", "https://one.example/report"),
        machineCheckedSource("source-two", "https://two.example/report"),
        { ...machineCheckedSource("source-one-duplicate", "https://duplicate.example/report"), title: "source-one" },
      ],
    };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: {
          claims: [{ id: "claim-one", text: "来源一提供了可复查的页面元数据。", sourceIds: ["source-one"], spokenQualifier: "根据该来源的页面元数据" }],
          evidenceSynthesis: evidenceSynthesis(),
        },
        trace: { taskKind: "research-claims" as const, promptVersion: "token-talk/research-claims-v1", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "xhigh" as const },
      })),
    };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-claims-001", signal: new AbortController().signal });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research-claims",
      payload: expect.objectContaining({
        sources: [expect.objectContaining({ id: "source-one" }), expect.objectContaining({ id: "source-two" })],
      }),
    }), expect.any(AbortSignal));
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      status: "verified",
      evidenceTier: "machine_checked_metadata",
      claims: [expect.objectContaining({ sourceIds: ["source-one"] })],
      evidenceSynthesis: expect.objectContaining({ thesis: expect.stringContaining("长期能力") }),
    });
  });

  it("routes an editable research plan through Codex and carries audit findings into repair", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const planArtifact = researchPlanArtifact({
      status: "draft",
      queries: [{ query: "旧检索词", intent: "旧意图", language: "zh", sourceKinds: ["web"] }],
    });
    run.artifacts.push(planArtifact);
    const audit = run.artifacts.find((artifact) => artifact.id === "artifact-research-audit");
    const auditVersion = audit?.versions.find((version) => version.id === audit.activeVersionId);
    if (!auditVersion) throw new Error("research audit fixture missing");
    auditVersion.data = {
      verdict: "revise",
      findings: [{
        id: "finding-evidence-gap",
        severity: "critical",
        category: "coverage",
        description: "没有回答中心问题",
        evidence: "现有来源只介绍产品页面",
        repairInstruction: "寻找衡量推理质量的实证研究",
      }],
    };
    const sources = run.artifacts.find((artifact) => artifact.id === "artifact-sources");
    const sourceVersion = sources?.versions.find((version) => version.id === sources.activeVersionId);
    if (!sourceVersion) throw new Error("source fixture missing");
    sourceVersion.data = { status: "needs_research", gaps: ["只有一个相关来源"] };
    const node = {
      ...run.nodes[0]!,
      id: "research-repair",
      label: "研究定向返修",
      role: "研究返修 Agent",
      capability: "research.plan",
      inputArtifactIds: ["artifact-brief", "artifact-research-audit"],
      outputArtifactIds: ["artifact-research-plan"],
    };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: {
          queries: [
            { query: "AI assisted programming reasoning quality empirical study", intent: "补齐实证证据", language: "en", sourceKinds: ["scholarly", "primary"] },
            { query: "AI 编程 认知卸载 反例", intent: "寻找边界和反例", language: "zh", sourceKinds: ["scholarly", "web"] },
          ],
          synthesisDirectives: ["分开任务效率与长期能力"],
        },
        trace: { taskKind: "research-plan" as const, promptVersion: "token-talk/research-planner-v1", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "xhigh" as const },
      })),
    };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-research-plan-001", signal: new AbortController().signal });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research-plan",
      payload: expect.objectContaining({
        currentQueries: ["旧检索词"],
        auditFindings: expect.arrayContaining([
          expect.objectContaining({ id: "finding-evidence-gap", repairInstruction: expect.stringContaining("实证研究") }),
          expect.objectContaining({ id: "source-gap-1", description: "只有一个相关来源" }),
        ]),
      }),
    }), expect.any(AbortSignal));
    expect(outcome.outputs?.["artifact-research-plan"]).toMatchObject({
      status: "draft",
      queries: expect.arrayContaining([expect.objectContaining({ language: "en", sourceKinds: ["scholarly", "primary"] })]),
      synthesisDirectives: ["分开任务效率与长期能力"],
    });
  });

  it("does not ask Codex to rewrite a passing research plan", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    run.artifacts.push(researchPlanArtifact({ status: "draft", queries: [{ query: "保留的检索词" }] }));
    const node = {
      ...run.nodes[0]!,
      id: "research-repair",
      label: "研究定向返修",
      role: "研究返修 Agent",
      capability: "research.plan",
      outputArtifactIds: ["artifact-research-plan"],
    };
    const client: CodexAgentClient = { providerId: "openai-codex-subscription", modelId: "codex-test", isConfigured: () => true, run: vi.fn() };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-research-plan-002", signal: new AbortController().signal });

    expect(client.run).not.toHaveBeenCalled();
    expect(outcome.outputs?.["artifact-research-plan"]).toMatchObject({ queries: [{ query: "保留的检索词" }] });
  });

  it("turns a visual node into an editable cover and chapter-art brief before image generation", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "image.generate");
    const blueprint = run?.artifacts.find((artifact) => artifact.id === "artifact-blueprint");
    const blueprintVersion = blueprint?.versions.find((version) => version.id === blueprint.activeVersionId);
    if (!run || !node || !blueprintVersion) throw new Error("visual fixture missing");
    blueprintVersion.data = { segments: [{ id: "opening", title: "提出问题", minutes: 10 }] };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: {
          concept: "证据被逐层展开",
          subject: "编辑桌上的资料层",
          composition: "单主体",
          palette: ["red", "white"],
          typography: "短标题",
          imagePrompt: "Editorial still life",
          negativePrompt: "dashboard",
          altText: "资料在桌面逐层展开",
          chapterArtBriefs: [{ segmentId: "opening", title: "提出问题", concept: "第一层资料", imagePrompt: "First evidence layer", altText: "第一层资料被打开" }],
        },
        trace: { taskKind: "cover-brief" as const, promptVersion: "token-talk/cover-director-v3", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "high" as const },
      })),
    };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-visual-001", signal: new AbortController().signal });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "cover-brief",
      payload: expect.objectContaining({
        chapters: [expect.objectContaining({ id: "opening" })],
        script: expect.any(Object),
      }),
    }), expect.any(AbortSignal));
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      status: "brief_ready",
      coverBrief: expect.objectContaining({ concept: "证据被逐层展开" }),
      chapterArtBriefs: [expect.objectContaining({ segmentId: "opening" })],
    });
  });

  it("regenerates one script segment without replacing locked or unrelated segments", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "script.segment");
    const blueprint = run?.artifacts.find((artifact) => artifact.id === "artifact-blueprint");
    const script = node ? run?.artifacts.find((artifact) => artifact.id === node.outputArtifactIds[0]) : undefined;
    const cast = run?.artifacts.find((artifact) => artifact.id === "artifact-cast");
    const blueprintVersion = blueprint?.versions.find((version) => version.id === blueprint.activeVersionId);
    const scriptVersion = script?.versions.find((version) => version.id === script.activeVersionId);
    const castVersion = cast?.versions.find((version) => version.id === cast.activeVersionId);
    if (!run || !node || !blueprintVersion || !scriptVersion || !castVersion) throw new Error("script segment fixture missing");
    castVersion.data = {
      status: "draft",
      policy: "dynamic",
      roles: [
        { id: "host", name: "主持", responsibility: "推进问题" },
        { id: "guest", name: "来宾", responsibility: "提供反例" },
      ],
    };
    blueprintVersion.data = {
      status: "draft",
      segments: [
        { id: "segment-1", title: "开场", minutes: 3 },
        { id: "segment-2", title: "分歧", minutes: 8 },
      ],
    };
    scriptVersion.data = {
      status: "draft",
      lockedSegmentIds: ["segment-1"],
      lines: [
        { segmentId: "segment-1", speaker: "主持", text: "锁定的开场", claimIds: [] },
        { segmentId: "segment-2", speaker: "主持", text: "旧的分歧", claimIds: [] },
      ],
    };
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: { lines: [
          { segmentId: "segment-2", speaker: "host", text: longLine("新的分歧一"), claimIds: [] },
          { segmentId: "segment-2", speaker: "guest", text: longLine("新的分歧二"), claimIds: [] },
          { segmentId: "segment-2", speaker: "host", text: longLine("新的追问"), claimIds: [] },
          { segmentId: "segment-2", speaker: "guest", text: longLine("新的澄清"), claimIds: [] },
        ] },
        trace: { taskKind: "script-segment" as const, promptVersion: "token-talk/segment-writer-v2", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "max" as const },
      })),
    };
    const executor = new CodexAgentNodeExecutor(client, failingFallback(), () => NOW);

    const outcome = await executor.execute({
      run,
      node,
      attemptId: "receipt-segment-001",
      input: { segmentId: "segment-2" },
      retryFeedback: "上次脚本过长，请压缩重复解释。",
      signal: new AbortController().signal,
    });

    expect(client.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: "script-segment",
      payload: expect.objectContaining({
        targetCharacters: 1_760,
        targetSegment: expect.objectContaining({ id: "segment-2", title: "分歧" }),
        currentScript: expect.objectContaining({ lockedSegmentIds: ["segment-1"] }),
        retryFeedback: "上次脚本过长，请压缩重复解释。",
      }),
    }), expect.any(AbortSignal));
    expect(outcome.outputs?.[node.outputArtifactIds[0]!]).toMatchObject({
      lockedSegmentIds: ["segment-1"],
      lines: [
        expect.objectContaining({ segmentId: "segment-1", text: "锁定的开场" }),
        expect.objectContaining({ segmentId: "segment-2", speaker: "主持", text: expect.stringContaining("新的分歧一") }),
        expect.objectContaining({ segmentId: "segment-2", speaker: "来宾", text: expect.stringContaining("新的分歧二") }),
        expect.objectContaining({ segmentId: "segment-2", text: expect.stringContaining("新的追问") }),
        expect.objectContaining({ segmentId: "segment-2", text: expect.stringContaining("新的澄清") }),
      ],
    });
  });

  it("runs Agent music direction through the local rights-clearance layer", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.capability === "music.plan");
    if (!run || !node) throw new Error("music node missing");
    const artifactId = node.outputArtifactIds[0]!;
    const client: CodexAgentClient = {
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      isConfigured: () => true,
      run: vi.fn(async () => ({
        output: {
          cues: [{ id: "cue-one", segmentId: "opening", action: "silence", durationSeconds: 2, mood: "克制", intensity: 1, purpose: "让观点落下", assetQuery: "" }],
        },
        trace: { taskKind: "music-plan" as const, promptVersion: "token-talk/music-director-v1", providerId: "openai-codex-subscription", modelId: "codex-test", reasoningEffort: "high" as const },
      })),
    };
    const fallback: NodeExecutor = {
      execute: vi.fn(async (context: Parameters<NodeExecutor["execute"]>[0]) => {
        const artifact = context.run.artifacts.find((candidate) => candidate.id === artifactId);
        const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
        expect(active?.data).toMatchObject({
          status: "draft",
          cues: [expect.objectContaining({ id: "cue-one" })],
          generatedBy: { taskKind: "music-plan" },
        });
        return {
          ...successfulOutcome(artifactId),
          outputs: { [artifactId]: { status: "ready", confirmed: true, cues: [{ id: "cue-one", selection: { action: "silence" } }] } },
        };
      }),
    };
    const executor = new CodexAgentNodeExecutor(client, fallback, () => NOW);

    const outcome = await executor.execute({ run, node, attemptId: "receipt-music-001", signal: new AbortController().signal });

    expect(fallback.execute).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: "succeeded",
      providerId: "openai-codex-subscription+internal-music-library",
      billing: "subscription",
      outputs: {
        [artifactId]: {
          status: "ready",
          confirmed: true,
          creativeDirection: { cues: [expect.objectContaining({ id: "cue-one" })] },
          generatedBy: { taskKind: "music-plan" },
        },
      },
    });
  });
});

function failingFallback(): NodeExecutor {
  return {
    execute: vi.fn(async () => { throw new Error("fallback should not run"); }),
  };
}

function succeedingFallback(artifactId: string): NodeExecutor {
  return {
    execute: vi.fn(async () => successfulOutcome(artifactId)),
  };
}

function successfulOutcome(artifactId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    providerId: "local-fallback",
    modelId: "template-v1",
    billing: "local_compute",
    estimatedCostCny: 0,
    actualCostCny: 0,
    startedAt: NOW,
    finishedAt: NOW,
    outputs: { [artifactId]: { status: "draft", roles: [] } },
  };
}

function longLine(prefix: string): string {
  return `${prefix}，${"用于验证章节级字数约束的自然对话内容。".repeat(20)}`;
}

function machineCheckedSource(id: string, url: string) {
  return {
    id,
    title: id,
    url,
    verificationStatus: "machine_checked",
    machineCheckedAt: NOW,
    verificationMethod: "safe_https_metadata",
    provenanceGroup: id === "source-one" ? "domain:one.example" : "domain:two.example",
    responseContentType: "text/html",
    responseSha256: "a".repeat(64),
  };
}

function evidenceSynthesis() {
  return {
    thesis: "现有摘要只能支撑短期任务结果，不足以判定长期能力变化。",
    dimensions: [
      { id: "judgment", label: "判断", definition: "发现错误建议的能力", indicators: ["错误识别率"], timeHorizon: "即时", evidenceState: "mixed", evidenceBasis: "operational_proxy", claimIds: ["claim-one"], scope: "特定页面元数据" },
      { id: "retention", label: "保持", definition: "脱离工具后的知识保持", indicators: ["延迟测验"], timeHorizon: "长期", evidenceState: "unresolved", evidenceBasis: "none", claimIds: [], scope: "未提供长期资料" },
    ],
    scopeBoundary: "只覆盖当前机器核验资料包。",
    sourceAssessments: [{ sourceId: "source-one", studyType: "unknown", peerReviewStatus: "unknown", sample: "unknown", comparison: "unknown", measures: [], limitations: ["仅提供元数据"], independenceNotes: "样本与资助关系未知" }],
    excludedSources: [{ sourceId: "source-two", reason: "未进入当前 claim" }],
    unresolvedQuestions: ["长期保持是否受影响？"],
  };
}

function researchPlanArtifact(data: unknown) {
  return {
    id: "artifact-research-plan",
    kind: "research.plan",
    activeVersionId: "artifact-research-plan-v1",
    versions: [{
      id: "artifact-research-plan-v1",
      createdAt: NOW,
      sha256: "f".repeat(64),
      source: "seed" as const,
      data,
    }],
  };
}
