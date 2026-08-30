import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createSeedSnapshot, EpisodeCandidateSchema } from "@token-talk/domain";
import { artifactDataSha256, beginNodeExecution, createRunFromCandidate, JsonStudioRepository, reviseArtifact, type NodeExecutionOutcome } from "@token-talk/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioServer as createStudioServerBase, type CreateStudioServerOptions } from "../src/server/create-server.js";
import { LocalProductionExecutor } from "../src/server/local-production-executor.js";
import { ReleaseAssetStore } from "../src/server/release-asset-store.js";
import type { NodeExecutionContext } from "../src/server/node-executor.js";
import { StaticSourceVerifier } from "../src/server/source-verifier.js";
import { StudioService } from "../src/server/studio-service.js";
import { acquireWorkspaceLease, workspaceLockCommand } from "../src/server/workspace-lease.js";

const NOW = "2026-08-28T00:00:00.000Z";
const TEST_MUTATION_TOKEN = "token-talk-test-mutation-token-000001";
let root: string;

async function createStudioServer(options: CreateStudioServerOptions) {
  const releaseAssetStore = options.releaseAssetStore ?? new ReleaseAssetStore(
    options.workspaceRoot,
    options.now ?? (() => NOW),
    async () => ({
      integratedLoudnessLufs: -16,
      truePeakDbtp: -2,
      loudnessRangeLu: 5,
      loudnessMeasuredWith: "ffmpeg-loudnorm-ebu-r128",
    }),
  );
  const app = await createStudioServerBase({ ...options, mutationToken: TEST_MUTATION_TOKEN, releaseAssetStore });
  const originalInject = app.inject.bind(app);
  app.inject = ((optionsOrUrl?: any, callback?: any) => {
    if (!optionsOrUrl || typeof optionsOrUrl === "string") {
      return callback ? originalInject(optionsOrUrl, callback) : originalInject(optionsOrUrl);
    }
    const request = {
      ...optionsOrUrl,
      headers: { ...optionsOrUrl.headers, "x-token-talk-token": TEST_MUTATION_TOKEN },
    };
    return callback ? originalInject(request, callback) : originalInject(request);
  }) as typeof app.inject;
  return app;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "token-talk-studio-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function agentLoopCandidate(id: string) {
  return EpisodeCandidateSchema.parse({
    id,
    origin: "custom",
    title: "Agent Loop 自动恢复测试",
    hook: "验证零成本 Agent 中断后可以自动接续。",
    rationale: "服务级自动恢复回归测试。",
    category: "other",
    platform: "测试编辑部",
    suggestedRoles: ["主持", "事实编辑"],
    verdict: "rapid_brief",
    targetMinutes: { min: 15, max: 25 },
    score: { overall: 80, audienceRelevance: 80, conversationPotential: 80, evidenceDepth: 80, longformDepth: 70, freshness: 50, seriesFit: 80, feasibility: 90, risk: 10 },
    evidence: [],
    verification: { status: "ready", reason: "测试资料已齐备", independentSources: 2 },
    generatedAt: NOW,
  });
}

describe("Studio API", () => {
  it("reports configured production services from runtime state", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      productionModel: { providerId: "local-ollama-production", modelId: "test-model", generate: vi.fn() },
    });

    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers.find((provider: { id: string }) => provider.id === "local-ollama-production").availability).toEqual({
      status: "configured",
      reason: "运行时已配置，尚未完成连通性验证",
    });
    await app.close();
  });

  it("rejects generic artifact edits that replace a series fixed cast", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    run.productionIntent = {
      hook: "验证系列固定角色边界",
      targetMinutes: 30,
      musicPolicy: "minimal",
      budgetPolicy: "local",
      maxCostCny: 0,
      sonicPalette: [],
      sonicExclusions: [],
      castPolicy: {
        mode: "fixed",
        recurringRoleIds: ["series-host"],
        roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持栏目视角" }],
      },
    };
    snapshot.runs[0] = run;
    await repository.save(snapshot);
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });

    const response = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-cast",
      payload: { data: { status: "draft", roles: [{ id: "replacement", name: "临时替换者" }] } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("只能在系列设置中修改");
    await app.close();
  });

  it("rejects generic artifact edits that rewrite a configured role's meaning", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    run.productionIntent = {
      hook: "验证系列角色语义边界",
      targetMinutes: 30,
      musicPolicy: "minimal",
      budgetPolicy: "local",
      maxCostCny: 0,
      sonicPalette: [],
      sonicExclusions: [],
      castPolicy: {
        mode: "recurring_with_guests",
        recurringRoleIds: ["series-host"],
        roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持栏目视角", speakingStyle: "克制追问", voiceBrief: "中速、低表演感" }],
      },
    };
    await repository.save(snapshot);
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });

    const rewrittenResponse = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-cast",
      payload: {
        data: {
          status: "draft",
          roles: [
            { id: "series-host", name: "栏目主持", responsibility: "维持栏目视角", speakingStyle: "克制追问", voiceBrief: "中速、低表演感" },
            { id: "series-host", name: "栏目主持", responsibility: "替品牌背书", speakingStyle: "夸张煽动", voiceBrief: "高速叫卖" },
            { id: "episode-guest", name: "本期嘉宾", responsibility: "补充反例" },
          ],
        },
      },
    });

    expect(rewrittenResponse.statusCode).toBe(409);
    expect(rewrittenResponse.json().message).toContain("只能在系列设置中修改");

    const impersonationResponse = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-cast",
      payload: {
        data: {
          status: "draft",
          roles: [
            { id: "series-host", name: "栏目主持", responsibility: "维持栏目视角", speakingStyle: "克制追问", voiceBrief: "中速、低表演感" },
            { id: "episode-imposter", name: "栏目主持", responsibility: "替品牌背书" },
          ],
        },
      },
    });

    expect(impersonationResponse.statusCode).toBe(409);
    expect(impersonationResponse.json().message).toContain("只能在系列设置中修改");

    const malformedResponse = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-cast",
      payload: {
        data: {
          status: "draft",
          roles: [
            { id: "series-host", name: "栏目主持", responsibility: "维持栏目视角", speakingStyle: "克制追问", voiceBrief: "中速、低表演感" },
            "unparsed-role",
          ],
        },
      },
    });

    expect(malformedResponse.statusCode).toBe(409);
    expect(malformedResponse.json().message).toContain("只能在系列设置中修改");
    await app.close();
  });

  it("stores only recognized, rights-confirmed music assets and deduplicates identical audio", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const query = new URLSearchParams({
      title: "克制的转场",
      mood: "reflective",
      energy: "2",
      bpm: "76",
      tags: "钢琴, 转场",
      licenseBasis: "owned",
      commercialUseConfirmed: "true",
    });
    const audio = silentWavBuffer();
    const added = await app.inject({
      method: "POST",
      url: `/api/music-assets?${query}`,
      headers: { "content-type": "audio/wav" },
      payload: audio,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      title: "克制的转场",
      mimeType: "audio/wav",
      mood: "reflective",
      energy: 2,
      bpm: 76,
      tags: ["钢琴", "转场"],
      license: { basis: "owned", commercialUseConfirmed: true },
    });
    expect(added.json().mediaUrl).toMatch(/^\/media\/music-library\/music-[a-f0-9-]+\.wav$/);
    expect(added.json().durationSeconds).toBeGreaterThan(0);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/music-assets?${query}`,
      headers: { "content-type": "audio/wav" },
      payload: audio,
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().id).toBe(added.json().id);
    const library = await app.inject({ method: "GET", url: "/api/music-assets" });
    expect(library.json().assets).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/music-assets?${query}`,
      headers: { "content-type": "audio/mpeg" },
      payload: Buffer.from("this is not audio"),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("INVALID_AUDIO");
    const forged = await app.inject({
      method: "POST",
      url: `/api/music-assets?${query}`,
      headers: { "content-type": "audio/mpeg" },
      payload: Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(32)]),
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().message).toContain("无法解码");
    await app.close();
  });

  it("cancels media probing and cleans the stored file when an upload aborts", async () => {
    const store = new ReleaseAssetStore(root, () => NOW);
    const controller = new AbortController();
    controller.abort();

    await expect(store.addMaster(silentWavBuffer(), {
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
      voiceConsentConfirmed: true,
      musicRightsConfirmed: true,
    }, controller.signal)).rejects.toThrow("发行母带无法解码或格式不受支持");

    await expect(readdir(join(root, "media", "release-assets"))).resolves.toEqual([]);
  });

  it("measures integrated loudness and true peak with the production FFmpeg analyzer", async () => {
    const store = new ReleaseAssetStore(root, () => NOW);
    const stored = await store.addMaster(variedVoiceLikeWavBuffer(3, 1_000), {
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
      voiceConsentConfirmed: true,
      musicRightsConfirmed: true,
    });

    expect(stored.data.audioQc).toMatchObject({
      integratedLoudnessLufs: expect.any(Number),
      truePeakDbtp: expect.any(Number),
      loudnessRangeLu: expect.any(Number),
      loudnessMeasuredWith: "ffmpeg-loudnorm-ebu-r128",
    });
    await stored.cleanup();
  });

  it("registers validated release masters and podcast-compliant cover art through trusted actions", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const rights = new URLSearchParams({
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: "true",
      voiceConsentConfirmed: "true",
      musicRightsConfirmed: "true",
    });
    const placeholder = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: toneWavBuffer(),
    });
    expect(placeholder.statusCode).toBe(409);
    expect(placeholder.json().message).toContain("疑似占位或截断文件");

    const silentMaster = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: silentWavBuffer(20 * 60, 1_000),
    });
    expect(silentMaster.statusCode).toBe(400);
    expect(silentMaster.json().message).toContain("静音或电平过低");

    const fixedTone = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: toneWavBuffer(20 * 60, 1_000),
    });
    expect(fixedTone.statusCode).toBe(400);
    expect(fixedTone.json().message).toContain("固定测试音");

    const releaseMaster = variedVoiceLikeWavBuffer(31 * 60, 1_000);
    const master = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: releaseMaster,
    });
    expect(master.statusCode).toBe(200);
    const audio = master.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-audio");
    expect(audio.versions.at(-1).data).toMatchObject({
      status: "release_master",
      releaseReady: true,
      mimeType: "audio/wav",
      audioQc: {
        measuredWith: "ffmpeg-volumedetect",
        loudnessMeasuredWith: "ffmpeg-loudnorm-ebu-r128",
        contentMeasuredWith: "ffmpeg-aspectralstats",
        meanVolumeDb: expect.any(Number),
        maxVolumeDb: expect.any(Number),
        integratedLoudnessLufs: -16,
        truePeakDbtp: -2,
        loudnessRangeLu: 5,
        codecName: "pcm_s16le",
        sampleRate: 1_000,
        channels: 1,
        spectralEntropyMean: expect.any(Number),
        spectralFluxMean: expect.any(Number),
        spectralFlatnessMean: expect.any(Number),
      },
      rights: {
        owner: "Token Talk 编辑部",
        basis: "owned",
        commercialUseConfirmed: true,
        voiceConsentConfirmed: true,
        musicRightsConfirmed: true,
      },
    });
    expect(audio.versions.at(-1).data.mediaUrl).toMatch(/^\/media\/release-assets\/master-[a-f0-9-]+\.wav$/);
    const audioNode = master.json().nodes.find((node: { id: string }) => node.id === "audio-mix");
    expect(master.json().executionReceipts.at(-1)).toMatchObject({
      nodeId: "audio-mix",
      modelId: "release-master-registration-v1",
      reviewedInputVersionIds: audioNode.inputVersionIds,
    });
    const duplicateMaster = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: releaseMaster,
    });
    const duplicateAudio = duplicateMaster.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-audio");
    expect(duplicateMaster.statusCode).toBe(200);
    expect(duplicateAudio.versions.at(-1).data.mediaUrl).toBe(audio.versions.at(-1).data.mediaUrl);
    expect((await readdir(join(root, "media", "release-assets"))).filter((name) => name.startsWith("master-"))).toHaveLength(1);

    const coverRights = new URLSearchParams({
      altText: "一束红色声波穿过深色纸张",
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "commissioned",
      commercialUseConfirmed: "true",
    });
    const cover = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/cover-art?${coverRights}`,
      headers: { "content-type": "image/png" },
      payload: solidPngBuffer(1400, 1400),
    });
    expect(cover.statusCode).toBe(200);
    const visual = cover.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-visuals");
    const coverId = visual.versions.at(-1).data.covers[0].id;
    expect(visual.versions.at(-1).data).toMatchObject({
      status: "needs_selection",
      covers: [expect.objectContaining({
        id: expect.stringMatching(/^cover-/),
        width: 1400,
        height: 1400,
        altText: "一束红色声波穿过深色纸张",
        rights: expect.objectContaining({ owner: "Token Talk 编辑部", basis: "commissioned", commercialUseConfirmed: true }),
      })],
    });
    expect(visual.versions.at(-1).data.selectedCoverId).toBeUndefined();

    const selectedCover = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/cover-selection",
      payload: { coverId },
    });
    expect(selectedCover.statusCode).toBe(200);
    const selectedVisual = selectedCover.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-visuals");
    expect(selectedVisual.versions.at(-1).data).toMatchObject({ status: "cover_ready", selectedCoverId: coverId });

    const unknownCover = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/cover-selection",
      payload: { coverId: "cover-not-in-candidates" },
    });
    expect(unknownCover.statusCode).toBe(409);

    const invalidCover = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/cover-art?${coverRights}`,
      headers: { "content-type": "image/png" },
      payload: solidPngBuffer(1400, 1200),
    });
    expect(invalidCover.statusCode).toBe(400);
    expect(invalidCover.json().message).toContain("正方形");

    const transparentCover = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/cover-art?${coverRights}`,
      headers: { "content-type": "image/png" },
      payload: solidPngBuffer(1400, 1400, 6),
    });
    expect(transparentCover.statusCode).toBe(400);
    expect(transparentCover.json().message).toContain("透明通道");

    const oversizedCover = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/cover-art?${coverRights}`,
      headers: { "content-type": "image/png" },
      payload: Buffer.alloc(20 * 1024 * 1024 + 1),
    });
    expect(oversizedCover.statusCode).toBe(413);
    expect(oversizedCover.json().code).toBe("ASSET_TOO_LARGE");
    await app.close();
  });

  it("does not let generic artifact editing forge release readiness", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const forgedAudio = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-audio",
      payload: { data: { status: "release_master", mediaUrl: "/media/fake.m4a", releaseReady: true } },
    });
    const forgedCover = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-visuals",
      payload: { data: { status: "cover_ready", covers: [{ mediaUrl: "/media/fake.png" }] } },
    });
    const forgedPublishCover = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-publish",
      payload: { data: { status: "ready", cover: { mediaUrl: "/media/fake.png" }, releaseReady: true } },
    });
    const forgedPublishMetadata = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-publish",
      payload: { data: { status: "draft", injectedPlatformId: "fake-platform" } },
    });
    expect(forgedAudio.statusCode).toBe(409);
    expect(forgedAudio.json().message).toContain("发行母带");
    expect(forgedCover.statusCode).toBe(409);
    expect(forgedCover.json().message).toContain("封面");
    expect(forgedPublishCover.statusCode).toBe(409);
    expect(forgedPublishCover.json().message).toContain("发布包");
    expect(forgedPublishMetadata.statusCode).toBe(409);
    expect(forgedPublishMetadata.json().message).toContain("发布包");
    await app.close();
  });

  it("takes a newly created canonical run through protected release assets, automated audit, and publishing", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const canonicalCandidate = EpisodeCandidateSchema.parse({
      id: "candidate-canonical-release",
      origin: "trend",
      title: "Canonical 发行链",
      hook: "验证新工作流的真实发行资产。",
      rationale: "覆盖 dot-kind 发行路径。",
      category: "ai_tech",
      platform: "Hacker News",
      suggestedRoles: ["主持"],
      verdict: "rapid_brief",
      targetMinutes: { min: 15, max: 25 },
      score: { overall: 80, audienceRelevance: 80, conversationPotential: 80, evidenceDepth: 70, longformDepth: 70, freshness: 85, seriesFit: 70, feasibility: 90, risk: 15 },
      evidence: [],
      verification: { status: "ready", reason: "测试来源已核验", independentSources: 2 },
      generatedAt: NOW,
    });
    let run = createRunFromCandidate(canonicalCandidate, {
      id: "run-canonical-release",
      opportunityId: "opportunity-canonical-release",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: "验证新工作流的真实发行资产。", targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
      now: NOW,
    });
    run = reviseArtifact(run, "artifact-script", {
      status: "assembled_draft",
      lines: [
        { segmentId: "opening", speaker: "主持", text: "先核对真实发行链。" },
        { segmentId: "closing", speaker: "主持", text: "再给出有边界的结论。" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-blueprint", {
      segments: [
        { id: "opening", title: "核对发行链", minutes: 7 },
        { id: "evidence", title: "证据与边界", minutes: 7 },
        { id: "closing", title: "结论与边界", minutes: 6 },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-sources", {
      status: "verified",
      sources: [
        { id: "source-one", title: "来源一", url: "https://one.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:one.example", verificationMethod: "server_action" },
        { id: "source-two", title: "来源二", url: "https://two.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:two.example", verificationMethod: "server_action" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-release-copy", {
      status: "ready",
      episodeTitle: canonicalCandidate.title,
      summary: canonicalCandidate.hook,
      showNotes: ["00:00 核对发行链", "07:00 证据与边界", "14:00 结论与边界"],
      keywords: ["播客制作", "发行审计"],
    }, NOW);
    for (const node of run.nodes) node.status = "succeeded";
    run.nodes.find((node) => node.id === "audio-mix")!.status = "ready";
    run.nodes.find((node) => node.id === "visual-pack")!.status = "ready";
    run.nodes.find((node) => node.id === "audio-audit")!.status = "pending";
    run.nodes.find((node) => node.id === "publish-package")!.status = "pending";
    run.status = "active";
    snapshot.runs.unshift(run);
    snapshot.opportunities.unshift({
      id: "opportunity-canonical-release",
      candidateId: canonicalCandidate.id,
      title: canonicalCandidate.title,
      origin: canonicalCandidate.origin,
      verdict: canonicalCandidate.verdict,
      evidence: canonicalCandidate.evidence,
      candidate: canonicalCandidate,
      adoptedAt: NOW,
      status: "in_production",
      runId: run.id,
    });
    await repository.save(snapshot);

    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const prematurePackage = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(prematurePackage.statusCode).toBe(409);
    const masterRights = new URLSearchParams({ rightsOwner: "Token Talk 编辑部", licenseBasis: "owned", commercialUseConfirmed: "true", voiceConsentConfirmed: "true", musicRightsConfirmed: "true" });
    const master = await app.inject({ method: "POST", url: `/api/runs/${run.id}/release-master?${masterRights}`, headers: { "content-type": "audio/wav" }, payload: variedVoiceLikeWavBuffer(20 * 60, 1_000) });
    expect(master.statusCode).toBe(200);
    expect(master.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-audio").kind).toBe("audio.master");
    expect(master.json().nodes.find((node: { id: string }) => node.id === "audio-audit").status).toBe("ready");

    const coverRights = new URLSearchParams({ altText: "红色声波与黑色留白", rightsOwner: "Token Talk 编辑部", licenseBasis: "owned", commercialUseConfirmed: "true" });
    const cover = await app.inject({ method: "POST", url: `/api/runs/${run.id}/cover-art?${coverRights}`, headers: { "content-type": "image/png" }, payload: solidPngBuffer(1400, 1400) });
    expect(cover.statusCode).toBe(200);
    const visual = cover.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-visuals");
    expect(visual.kind).toBe("visual.pack");
    const coverId = visual.versions.at(-1).data.covers[0].id;
    const selection = await app.inject({ method: "POST", url: `/api/runs/${run.id}/cover-selection`, payload: { coverId } });
    expect(selection.statusCode).toBe(200);

    const audioAudit = await app.inject({ method: "POST", url: `/api/runs/${run.id}/nodes/audio-audit/execute` });
    expect(audioAudit.statusCode).toBe(200);
    expect(audioAudit.json().nodes.find((node: { id: string }) => node.id === "publish-package").status).toBe("ready");

    const releaseReady = await app.inject({ method: "POST", url: `/api/runs/${run.id}/nodes/publish-package/execute` });
    expect(releaseReady.statusCode).toBe(200);
    expect(releaseReady.json().status).toBe("release_ready");
    const publishArtifact = releaseReady.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-publish");
    expect(publishArtifact.kind).toBe("publish.package");
    expect(publishArtifact.versions.at(-1).data).toMatchObject({
      schemaVersion: 1,
      status: "release_ready",
      releaseReady: true,
      cover: { id: coverId },
      transcript: { lineCount: 2 },
      chapters: expect.arrayContaining([expect.objectContaining({ id: "opening", title: "核对发行链", startSeconds: 0 })]),
      sources: [{ id: "source-one" }, { id: "source-two" }],
      editorial: { episodeTitle: canonicalCandidate.title, keywords: ["播客制作", "发行审计"] },
      podcasting2: {
        chapters: {
          mimeType: "application/json+chapters",
          data: { version: "1.2.0", chapters: expect.arrayContaining([expect.objectContaining({ startTime: 0, title: "核对发行链" })]) },
        },
        transcript: { recommendedMimeType: "text/vtt", status: "requires_forced_alignment" },
      },
    });
    const releasePackage = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(releasePackage.statusCode, releasePackage.body).toBe(200);
    expect(releasePackage.headers["content-disposition"]).toContain("token-talk-release.json");
    expect(releasePackage.headers["cache-control"]).toBe("no-store");
    expect(releasePackage.headers["x-content-type-options"]).toBe("nosniff");
    const firstReleasePackage = releasePackage.json();
    expect(firstReleasePackage).toMatchObject({ schemaVersion: 1, episode: { runId: run.id, title: canonicalCandidate.title }, transcript: { lineCount: 2 }, audioAuditArtifactVersionId: expect.any(String) });
    const chapters = await app.inject({ method: "GET", url: `/api/runs/${run.id}/chapters.json` });
    expect(chapters.statusCode).toBe(200);
    expect(chapters.headers["content-type"]).toContain("application/json+chapters");
    expect(chapters.headers["access-control-allow-origin"]).toBe("*");
    expect(chapters.json()).toMatchObject({ version: "1.2.0", chapters: expect.arrayContaining([expect.objectContaining({ startTime: 0, title: "核对发行链" })]) });
    const replayedPublish = await app.inject({
      method: "PUT",
      url: `/api/runs/${run.id}/artifacts/artifact-publish`,
      payload: { data: publishArtifact.versions.at(-1).data },
    });
    expect(replayedPublish.statusCode).toBe(409);
    expect(replayedPublish.json().message).toContain("发布包");

    const repeatedAudioAudit = await app.inject({ method: "POST", url: `/api/runs/${run.id}/nodes/audio-audit/execute` });
    expect(repeatedAudioAudit.statusCode).toBe(200);
    expect(repeatedAudioAudit.json().status).toBe("release_ready");
    expect(repeatedAudioAudit.json().nodes.find((node: { id: string }) => node.id === "publish-package")).toMatchObject({ status: "succeeded" });
    const supersededPackage = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(supersededPackage.statusCode).toBe(200);
    const refreshedPackage = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(refreshedPackage.statusCode).toBe(200);
    expect(refreshedPackage.json().audioAuditArtifactVersionId).toBe(firstReleasePackage.audioAuditArtifactVersionId);
    const readyBootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(readyBootstrap.json().opportunities.find((item: { id: string }) => item.id === "opportunity-canonical-release").status).toBe("release_ready");

    const tamperedSnapshot = await repository.load();
    const tamperedRun = tamperedSnapshot.runs.find((candidate) => candidate.id === run.id);
    const tamperedPublishNode = tamperedRun?.nodes.find((node) => node.capability === "publish.package");
    if (!tamperedRun || !tamperedPublishNode) throw new Error("tampered release run missing");
    tamperedPublishNode.status = "stale";
    await repository.save(tamperedSnapshot);
    const staleNodeRegistration = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/publications`,
      payload: { requestId: "publication-stale-001", platform: "小宇宙", status: "failed", attemptedAt: "2026-08-27T23:45:00.000Z", failureReason: "测试过期发布包" },
    });
    expect(staleNodeRegistration.statusCode).toBe(409);
    expect(staleNodeRegistration.json().message).toContain("发布检查已失效");
    const restoredSnapshot = await repository.load();
    const restoredPublishNode = restoredSnapshot.runs.find((candidate) => candidate.id === run.id)?.nodes.find((node) => node.capability === "publish.package");
    if (!restoredPublishNode) throw new Error("release node restore target missing");
    restoredPublishNode.status = "succeeded";
    await repository.save(restoredSnapshot);

    const corruptedSnapshot = await repository.load();
    const corruptedRun = corruptedSnapshot.runs.find((candidate) => candidate.id === run.id);
    const corruptedArtifact = corruptedRun?.artifacts.find((artifact) => artifact.id === "artifact-publish");
    const corruptedVersion = corruptedArtifact?.versions.find((version) => version.id === corruptedArtifact.activeVersionId);
    if (!corruptedVersion || !corruptedVersion.data || typeof corruptedVersion.data !== "object") throw new Error("release package corruption target missing");
    corruptedVersion.data = { ...corruptedVersion.data as Record<string, unknown>, status: "tampered" };
    await repository.save(corruptedSnapshot);
    const corruptedDownload = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(corruptedDownload.statusCode).toBe(409);
    expect(corruptedDownload.json().message).toContain("内容与校验值不一致");
    const corruptedRegistration = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/publications`,
      payload: { requestId: "publication-corrupt-001", platform: "小宇宙", status: "failed", attemptedAt: "2026-08-27T23:45:00.000Z", failureReason: "测试发布包损坏" },
    });
    expect(corruptedRegistration.statusCode).toBe(409);
    const repairedSnapshot = await repository.load();
    const repairedArtifact = repairedSnapshot.runs.find((candidate) => candidate.id === run.id)?.artifacts.find((artifact) => artifact.id === "artifact-publish");
    const repairedVersion = repairedArtifact?.versions.find((version) => version.id === repairedArtifact.activeVersionId);
    if (!repairedVersion) throw new Error("release package repair target missing");
    repairedVersion.data = refreshedPackage.json();
    await repository.save(repairedSnapshot);

    const failedPublication = {
      requestId: "publication-failed-001",
      platform: "小宇宙",
      status: "failed",
      attemptedAt: "2026-08-27T23:50:00.000Z",
      failureReason: "平台稿件校验未通过",
    };
    const failedRegistration = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: failedPublication });
    expect(failedRegistration.statusCode).toBe(200);
    expect(failedRegistration.json()).toMatchObject({ run: { status: "release_ready" }, opportunity: { status: "release_ready" }, record: { status: "failed", platform: "小宇宙" } });
    const idempotentFailure = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: failedPublication });
    expect(idempotentFailure.statusCode).toBe(200);
    expect(idempotentFailure.json().record.id).toBe(failedRegistration.json().record.id);
    expect(idempotentFailure.json().run.publicationRecords).toHaveLength(1);
    const conflictingRetry = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...failedPublication, failureReason: "重用请求标识伪造另一次结果" } });
    expect(conflictingRetry.statusCode).toBe(409);
    const futureRegistration = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...failedPublication, requestId: "publication-future-001", attemptedAt: "2026-08-29T00:00:00.000Z" } });
    expect(futureRegistration.statusCode).toBe(409);

    const currentPublishArtifact = repeatedAudioAudit.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-publish");
    const currentPublishVersion = currentPublishArtifact.versions.find((version: { id: string }) => version.id === currentPublishArtifact.activeVersionId);
    const successfulPublication = {
      requestId: "publication-success-001",
      platform: "小宇宙",
      status: "published",
      externalEpisodeId: "canonical-episode-guid",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/canonical-release",
      channelUrl: "https://www.xiaoyuzhoufm.com/podcast/token-talk",
      publishedAt: "2026-08-27T23:55:00.000Z",
    };
    const unreconciledSnapshot = await repository.load();
    const unreconciledRun = unreconciledSnapshot.runs.find((candidate) => candidate.id === run.id);
    if (!unreconciledRun) throw new Error("unreconciled release run missing");
    unreconciledRun.executionReceipts.push({
      id: "receipt-publication-cost",
      nodeId: "voice-render",
      providerId: "metered-voice",
      modelId: "voice-v1",
      status: "needs_human",
      billing: "metered",
      estimatedCostCny: 0.2,
      startedAt: "2026-08-27T23:40:00.000Z",
      finishedAt: "2026-08-27T23:41:00.000Z",
      errorMessage: "供应商返回结果不明确",
    });
    await repository.save(unreconciledSnapshot);
    const costBlocked = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...successfulPublication, requestId: "publication-cost-blocked-001" } });
    expect(costBlocked.statusCode).toBe(409);
    expect(costBlocked.json().message).toContain("费用未对账");
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/receipts/receipt-publication-cost/reconcile`,
      payload: { actualCostCny: 0.18, note: "已核对供应商账单", providerInvoiceId: "invoice-publication-001" },
    });
    expect(reconciled.statusCode).toBe(200);
    const published = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: successfulPublication });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      run: { status: "completed" },
      opportunity: { status: "published" },
      record: {
        status: "published",
        releasePackageVersionId: currentPublishVersion.id,
        releasePackageSha256: currentPublishVersion.sha256,
        audioSha256: refreshedPackage.json().checksums.audioSha256,
        coverSha256: refreshedPackage.json().checksums.coverSha256,
      },
    });
    expect(published.json().run.publicationRecords).toHaveLength(2);

    const reboundSnapshot = await repository.load();
    const reboundArtifact = reboundSnapshot.runs.find((candidate) => candidate.id === run.id)?.artifacts.find((artifact) => artifact.id === "artifact-publish");
    const reboundVersion = reboundArtifact?.versions.find((version) => version.id === reboundArtifact.activeVersionId);
    if (!reboundVersion || !reboundVersion.data || typeof reboundVersion.data !== "object") throw new Error("published package binding target missing");
    const reboundData = reboundVersion.data as Record<string, unknown>;
    const reboundEpisode = reboundData.episode as Record<string, unknown>;
    reboundVersion.data = { ...reboundData, episode: { ...reboundEpisode, title: "重算校验值的伪造发布包" } };
    reboundVersion.sha256 = artifactDataSha256(reboundVersion.data);
    await repository.save(reboundSnapshot);
    const reboundDownload = await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` });
    expect(reboundDownload.statusCode).toBe(409);
    expect(reboundDownload.json().message).toContain("外部发布记录不匹配");
    const reboundPlatform = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...successfulPublication, requestId: "publication-rebound-001", platform: "Apple Podcasts", externalEpisodeId: "apple-rebound-guid", episodeUrl: "https://podcasts.apple.com/example/rebound" } });
    expect(reboundPlatform.statusCode).toBe(409);
    expect(reboundPlatform.json().message).toContain("不能追加平台");
    const bindingRestoredSnapshot = await repository.load();
    const bindingRestoredArtifact = bindingRestoredSnapshot.runs.find((candidate) => candidate.id === run.id)?.artifacts.find((artifact) => artifact.id === "artifact-publish");
    const bindingRestoredVersion = bindingRestoredArtifact?.versions.find((version) => version.id === bindingRestoredArtifact.activeVersionId);
    if (!bindingRestoredVersion) throw new Error("published package binding restore target missing");
    bindingRestoredVersion.data = refreshedPackage.json();
    bindingRestoredVersion.sha256 = artifactDataSha256(bindingRestoredVersion.data);
    await repository.save(bindingRestoredSnapshot);

    const duplicateEpisode = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...successfulPublication, requestId: "publication-duplicate-001" } });
    expect(duplicateEpisode.statusCode).toBe(409);
    const secondPlatform = await app.inject({ method: "POST", url: `/api/runs/${run.id}/publications`, payload: { ...successfulPublication, requestId: "publication-success-002", platform: "Apple Podcasts", externalEpisodeId: "apple-canonical-guid", episodeUrl: "https://podcasts.apple.com/example/canonical-release" } });
    expect(secondPlatform.statusCode).toBe(200);
    expect(secondPlatform.json().run.publicationRecords).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: `/api/runs/${run.id}/release-package` })).statusCode).toBe(200);

    const reopened = await app.inject({
      method: "PUT",
      url: `/api/runs/${run.id}/artifacts/artifact-brief`,
      payload: { data: { title: "发行后重新编辑" } },
    });
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json().message).toContain("已经发布");
    const rerun = await app.inject({ method: "POST", url: `/api/runs/${run.id}/nodes/source-packet/execute` });
    expect(rerun.statusCode).toBe(409);
    expect(rerun.json().message).toContain("已经发布");
    const reopenedBootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(reopenedBootstrap.json().opportunities.find((item: { id: string }) => item.id === "opportunity-canonical-release").status).toBe("published");
    await app.close();
  });

  it("does not let asset registration bypass unfinished upstream production", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const scriptNode = run?.nodes.find((node) => node.id === "showrunner-assembly");
    if (!scriptNode) throw new Error("seed script node missing");
    scriptNode.status = "pending";
    await repository.save(snapshot);
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const rights = new URLSearchParams({
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: "true",
      voiceConsentConfirmed: "true",
      musicRightsConfirmed: "true",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: toneWavBuffer(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("整集统筹");
    await app.close();
  });

  it("rejects cross-site, invalid-token, and DNS-rebinding mutation requests", async () => {
    const app = await createStudioServerBase({ workspaceRoot: root, now: () => NOW, mutationToken: TEST_MUTATION_TOKEN });
    const crossSite = await app.inject({
      method: "POST",
      url: "/api/series",
      headers: { host: "localhost:80", origin: "https://evil.example", "x-token-talk-token": TEST_MUTATION_TOKEN },
      payload: { title: "拒绝", promise: "拒绝", audience: "拒绝", castPolicy: { mode: "dynamic" }, musicPolicy: "minimal" },
    });
    const missingToken = await app.inject({
      method: "POST",
      url: "/api/series",
      headers: { host: "localhost:80" },
      payload: { title: "拒绝", promise: "拒绝", audience: "拒绝", castPolicy: { mode: "dynamic" }, musicPolicy: "minimal" },
    });
    const rebound = await app.inject({
      method: "POST",
      url: "/api/series",
      headers: { host: "attacker.example", origin: "http://attacker.example", "x-token-talk-token": TEST_MUTATION_TOKEN },
      payload: { title: "拒绝", promise: "拒绝", audience: "拒绝", castPolicy: { mode: "dynamic" }, musicPolicy: "minimal" },
    });

    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().code).toBe("CROSS_SITE_REQUEST");
    expect(missingToken.statusCode).toBe(403);
    expect(missingToken.json().code).toBe("INVALID_LOCAL_TOKEN");
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json().code).toBe("LOCAL_ACCESS_ONLY");
    const mediaRebound = await app.inject({ method: "GET", url: "/media/music-library/private.mp3", headers: { host: "attacker.example" } });
    expect(mediaRebound.statusCode).toBe(403);
    expect(mediaRebound.json().code).toBe("LOCAL_ACCESS_ONLY");
    const candidateGet = await app.inject({ method: "GET", url: "/api/candidates?refresh=true", headers: { host: "localhost:80" } });
    const candidateCrossSite = await app.inject({
      method: "POST",
      url: "/api/candidates?refresh=true",
      headers: { host: "localhost:80", origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-token-talk-token": TEST_MUTATION_TOKEN },
    });
    const voiceMissingToken = await app.inject({ method: "POST", url: "/api/voice-catalog", headers: { host: "localhost:80" } });
    expect(candidateGet.statusCode).toBe(404);
    expect(candidateCrossSite.statusCode).toBe(403);
    expect(candidateCrossSite.json().code).toBe("CROSS_SITE_REQUEST");
    expect(voiceMissingToken.statusCode).toBe(403);
    expect(voiceMissingToken.json().code).toBe("INVALID_LOCAL_TOKEN");
    await app.close();
  });

  it("rejects regeneration of a locked script segment before invoking an Agent", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const script = run?.artifacts.find((artifact) => artifact.id === "artifact-segment-1");
    const active = script?.versions.find((version) => version.id === script.activeVersionId);
    if (!run || !active) throw new Error("segment fixture missing");
    active.data = {
      status: "draft",
      lockedSegmentIds: ["segment-1"],
      lines: [{ segmentId: "segment-1", speaker: "主持", text: "锁定内容", claimIds: [] }],
    };
    await repository.save(snapshot);
    const execute = vi.fn(async (): Promise<NodeExecutionOutcome> => ({
      status: "succeeded",
      providerId: "test-agent",
      modelId: "segment-v1",
      billing: "subscription",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      outputs: { "artifact-segment-1": { status: "draft", lines: [] } },
    }));
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/segment-room-1/execute",
      payload: { segmentId: "segment-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("已锁定");
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows only the configured HTTPS public origin", async () => {
    const app = await createStudioServerBase({
      workspaceRoot: root,
      now: () => NOW,
      mutationToken: TEST_MUTATION_TOKEN,
      publicOrigin: "https://talk.example.com",
    });
    const payload = {
      requestId: "public-origin-series-001",
      title: "公开部署系列",
      promise: "验证精确公网来源",
      audience: "制作团队",
      castPolicy: { mode: "dynamic", recurringRoleIds: [], roles: [] },
      musicPolicy: "minimal",
    };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/series",
      headers: {
        host: "talk.example.com",
        origin: "https://talk.example.com",
        "sec-fetch-site": "same-origin",
        "x-token-talk-token": TEST_MUTATION_TOKEN,
      },
      payload,
    });
    const downgradedOrigin = await app.inject({
      method: "POST",
      url: "/api/series",
      headers: {
        host: "talk.example.com",
        origin: "http://talk.example.com",
        "sec-fetch-site": "same-origin",
        "x-token-talk-token": TEST_MUTATION_TOKEN,
      },
      payload,
    });
    const forgedHost = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "attacker.example" },
    });

    expect(accepted.statusCode).toBe(201);
    expect(downgradedOrigin.statusCode).toBe(403);
    expect(downgradedOrigin.json().code).toBe("CROSS_SITE_REQUEST");
    expect(forgedHost.statusCode).toBe(403);
    expect(forgedHost.json().code).toBe("LOCAL_ACCESS_ONLY");
    await app.close();
  });

  it("accepts an HTTPS public IP as the exact production origin", async () => {
    const app = await createStudioServerBase({
      workspaceRoot: root,
      now: () => NOW,
      mutationToken: TEST_MUTATION_TOKEN,
      publicOrigin: "https://182.92.85.15",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: {
        host: "182.92.85.15",
        origin: "https://182.92.85.15",
        "sec-fetch-site": "same-origin",
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("serves the production client with SPA fallback without swallowing API 404s", async () => {
    const clientRoot = join(root, "client");
    await mkdir(join(clientRoot, "assets"), { recursive: true });
    await writeFile(join(clientRoot, "index.html"), "<!doctype html><main>Token Talk Studio</main>");
    await writeFile(join(clientRoot, "assets", "app.js"), "globalThis.tokenTalkLoaded = true;");
    const app = await createStudioServerBase({
      workspaceRoot: root,
      now: () => NOW,
      mutationToken: TEST_MUTATION_TOKEN,
      clientRoot,
    });

    const health = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:80" } });
    const index = await app.inject({ method: "GET", url: "/", headers: { host: "localhost:80" } });
    const nestedRoute = await app.inject({ method: "GET", url: "/production/run-deep-reading", headers: { host: "localhost:80" } });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js", headers: { host: "localhost:80" } });
    const unknownApi = await app.inject({ method: "GET", url: "/api/unknown", headers: { host: "localhost:80" } });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("Token Talk Studio");
    expect(nestedRoute.statusCode).toBe(200);
    expect(nestedRoute.body).toContain("Token Talk Studio");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("tokenTalkLoaded");
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers["content-type"]).toContain("application/json");
    expect(unknownApi.json().code).toBe("NOT_FOUND");
    await app.close();
  });

  it("fails discovery automatically until independent sources are machine-checked or edited", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      researchGateway: {
        async search() {
          return {
            sources: [{
              id: "source-discovery",
              title: "待核验来源",
              url: "https://example.com/discovery",
              providerId: "test-public-source",
              providerLabel: "测试公共源",
              sourceKind: "web" as const,
              verificationStatus: "unverified" as const,
              discoveredAt: NOW,
            }],
            attempts: [{
              providerId: "test-public-source",
              providerLabel: "测试公共源",
              billing: "free" as const,
              status: "succeeded" as const,
              resultCount: 1,
            }],
          };
        },
      },
      sourceVerifier: new StaticSourceVerifier([]),
    });
    const gated = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/execute",
    });

    expect(gated.statusCode).toBe(200);
    expect(gated.json().nodes.find((node: { id: string }) => node.id === "source-packet").status).toBe("failed");
    const gatedPacket = gated.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-sources");
    expect(gatedPacket.versions.at(-1).data).toMatchObject({
      status: "needs_research",
      verifiedIndependentSourceCount: 0,
      sources: [expect.objectContaining({ verificationStatus: "unverified" })],
    });
    expect(gated.json().executionReceipts.at(-1)).toMatchObject({
      providerId: "research-agent-orchestrator",
      modelId: "test-public-source:succeeded+source-verification-v2",
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
    });

    await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-sources",
      payload: {
        data: {
          status: "needs_human",
          verifiedIndependentSourceCount: 0,
          sources: [
            { id: "source-one", title: "来源一", url: "https://example.com/one", verificationStatus: "unverified" },
            { id: "source-two", title: "来源二", url: "https://independent.example/two", verificationStatus: "unverified" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/artifacts/artifact-sources/sources/source-one/verification",
      payload: { verified: true },
    });
    const reviewed = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/artifacts/artifact-sources/sources/source-two/verification",
      payload: { verified: true },
    });
    expect(reviewed.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-sources").versions.at(-1).data).toMatchObject({
      status: "verified",
      verifiedIndependentSourceCount: 2,
      sources: [
        expect.objectContaining({ verificationMethod: "server_action", verifiedBy: "本地主编", provenanceGroup: "domain:example.com" }),
        expect.objectContaining({ verificationMethod: "server_action", verifiedBy: "本地主编", provenanceGroup: "domain:independent.example" }),
      ],
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/execute",
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().nodes.find((node: { id: string }) => node.id === "source-packet").status).toBe("succeeded");
    await app.close();
  });

  it("does not let generic artifact JSON forge a trusted source review", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const revised = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-sources",
      payload: {
        data: {
          status: "verified",
          verifiedIndependentSourceCount: 2,
          sources: [
            { id: "one", title: "一", url: "https://same.example/one", verificationStatus: "verified", verifiedBy: "伪造身份", verifiedAt: NOW, provenanceGroup: "publisher:a", verificationMethod: "server_action" },
            { id: "two", title: "二", url: "https://same.example/two", verificationStatus: "verified", verifiedBy: "伪造身份", verifiedAt: NOW, provenanceGroup: "publisher:b", verificationMethod: "server_action" },
          ],
        },
      },
    });
    const packet = revised.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-sources").versions.at(-1).data;

    expect(packet).toMatchObject({ status: "needs_research", verifiedIndependentSourceCount: 0 });
    expect(packet.sources).toEqual([
      expect.objectContaining({ verificationStatus: "unverified" }),
      expect.objectContaining({ verificationStatus: "unverified" }),
    ]);
    expect(packet.sources[0]).not.toHaveProperty("verifiedBy");
    await app.close();
  });

  it("creates and serves a real local table-read preview from script lines", async () => {
    if (process.platform !== "darwin") return;
    const now = () => new Date().toISOString();
    const localExecutor = new LocalProductionExecutor(root, now, { isConfigured: () => false, render: vi.fn() });
    const app = await createStudioServer({
      workspaceRoot: root,
      now,
      nodeExecutor: {
        plan: (context) => localExecutor.plan(context),
        execute: async (context) => context.node.capability === "script.audit"
          ? {
              status: "succeeded",
              providerId: "independent-audit-test-agent",
              modelId: "script-audit-test-v1",
              billing: "subscription",
              estimatedCostCny: 0,
              actualCostCny: 0,
              startedAt: now(),
              finishedAt: now(),
              outputs: { [context.node.outputArtifactIds[0]!]: { verdict: "pass", findings: [] } },
            }
          : localExecutor.execute(context),
        discard: (context, outcome) => localExecutor.discard(context, outcome),
        commit: (context, outcome) => localExecutor.commit(context, outcome),
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-script",
      payload: {
        data: {
          status: "assembled_draft",
          lines: [
            { speaker: "引导者", text: "欢迎来到 Token Talk。" },
            { speaker: "质疑者", text: "这是一段本地桌读测试。" },
            { speaker: "引导者", text: "我们先把问题的边界说清楚。" },
            { speaker: "质疑者", text: "然后再看一个不那么直观的反例。" },
          ],
        },
      },
    });
    const auditedScript = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/script-audit/execute" });
    expect(auditedScript.statusCode).toBe(200);
    expect(auditedScript.json().nodes.find((node: { id: string }) => node.id === "script-audit").status).toBe("succeeded");
    const repairedScript = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/script-repair/execute" });
    expect(repairedScript.statusCode).toBe(200);
    expect(repairedScript.json().nodes.find((node: { id: string }) => node.id === "script-repair").status).toBe("succeeded");
    const voices = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/voice-casting/execute" });
    expect(voices.statusCode).toBe(200);
    expect(voices.json().nodes.find((node: { id: string }) => node.id === "voice-casting").status).toBe("succeeded");
    const music = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/music-cue-sheet/execute" });
    expect(music.statusCode).toBe(200);
    expect(music.json().nodes.find((node: { id: string }) => node.id === "music-cue-sheet").status).toBe("succeeded");
    const rendered = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/audio-mix/execute",
    });

    expect(rendered.statusCode).toBe(200);
    const audio = rendered.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-audio");
    const preview = audio.versions.at(-1).data;
    expect(preview).toMatchObject({ status: "preview_ready", previewKind: "local_table_read", releaseReady: false });
    const media = await app.inject({ method: "GET", url: preview.mediaUrl });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toContain("audio");
    expect(media.rawPayload.byteLength).toBeGreaterThan(1_000);
    await app.close();
  }, 15_000);

  it("executes a workflow node and persists its generated artifact receipt", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        async execute({ node }) {
          return {
            status: "succeeded" as const,
            providerId: "test-local-executor",
            modelId: "research-packet-v1",
            billing: "local_compute" as const,
            estimatedCostCny: 0,
            actualCostCny: 0,
            startedAt: NOW,
            finishedAt: NOW,
            outputs: {
              [node.outputArtifactIds[0] ?? "missing"]: {
                status: "verified",
                verifiedIndependentSourceCount: 2,
                sources: [{ title: "来源一" }, { title: "来源二" }],
              },
            },
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/execute",
    });

    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.executionReceipts.at(-1)).toMatchObject({
      nodeId: "source-packet",
      providerId: "test-local-executor",
      status: "succeeded",
    });
    expect(run.artifacts.find((artifact: { id: string }) => artifact.id === "artifact-sources").versions).toHaveLength(2);
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().runs[0].executionReceipts).toHaveLength(1);
    await app.close();
  });

  it("rejects a duplicate execution while the same node is already running", async () => {
    let releaseExecution: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let started: () => void = () => undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        async execute({ node }) {
          started();
          await waiting;
          return {
            status: "succeeded" as const,
            providerId: "test-executor",
            modelId: "test-v1",
            billing: "local_compute" as const,
            estimatedCostCny: 0,
            actualCostCny: 0,
            startedAt: NOW,
            finishedAt: NOW,
            outputs: { [node.outputArtifactIds[0] ?? "missing"]: { status: "done" } },
          };
        },
      },
    });
    const first = app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    await didStart;
    const inFlight = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const inFlightRun = inFlight.json().runs[0];
    expect(inFlightRun.nodes.find((node: { id: string }) => node.id === "source-packet").status).toBe("running");
    expect(inFlightRun.executionReceipts.at(-1)).toMatchObject({ nodeId: "source-packet", status: "running" });
    expect(inFlightRun.executionReceipts.at(-1).finishedAt).toBeUndefined();
    const duplicate = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toContain("正在运行");
    releaseExecution();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it("persists a failed node and execution receipt when an executor crashes", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        async execute() {
          throw new Error("本地声音工具不可用");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/audio-mix/execute",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().nodes.find((node: { id: string }) => node.id === "audio-mix")).toMatchObject({
      status: "failed",
      lastError: "本地声音工具不可用",
    });
    expect(response.json().executionReceipts.at(-1)).toMatchObject({
      nodeId: "audio-mix",
      status: "failed",
      errorMessage: "本地声音工具不可用",
    });
    await app.close();
  });

  it("does not call a metered executor without input-scoped spend authorization", async () => {
    const execute = vi.fn(async () => { throw new Error("must not execute"); });
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "paid-search", modelId: "paid-v1", billing: "metered", estimatedCostCny: 0.2 };
        },
        execute,
      },
    });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("成本授权");
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("stops a persistent deep-research audit loop after six completed rounds", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "active";
    run.nodes.forEach((node) => { node.status = "pending"; });
    const audit = run.nodes.find((node) => node.id === "evidence-audit");
    if (!audit) throw new Error("evidence audit missing");
    audit.status = "ready";
    run.executionReceipts = Array.from({ length: 6 }, (_, index) => ({
      id: `receipt-audit-${index + 1}`,
      nodeId: audit.id,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      status: "succeeded" as const,
      billing: "subscription" as const,
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
    }));
    await repository.save(snapshot);
    const execute = vi.fn();
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: { execute },
    });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/agent-loop" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "repair_limit",
      stoppedAtNodeId: "evidence-audit",
      executedNodeIds: [],
    });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not consume an Agent audit round when infrastructure fails before producing an audit", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "active";
    run.nodes.forEach((node) => { node.status = "pending"; });
    const source = run.nodes.find((node) => node.id === "source-packet");
    const claims = run.nodes.find((node) => node.id === "claim-ledger");
    const audit = run.nodes.find((node) => node.id === "evidence-audit");
    if (!source || !claims || !audit) throw new Error("research nodes missing");
    source.status = "succeeded";
    claims.status = "succeeded";
    audit.status = "ready";
    run.executionReceipts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `receipt-audit-success-${index + 1}`,
        nodeId: audit.id,
        providerId: "openai-codex-subscription",
        modelId: "codex-test",
        status: "succeeded" as const,
        billing: "subscription" as const,
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
      })),
      {
        id: "receipt-audit-timeout",
        nodeId: audit.id,
        providerId: "openai-codex-subscription",
        modelId: "codex-test",
        status: "failed" as const,
        billing: "subscription" as const,
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
        errorMessage: "timeout",
      },
    ];
    await repository.save(snapshot);
    const execute = vi.fn(async () => ({
      status: "failed" as const,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      billing: "subscription" as const,
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      errorMessage: "test stop",
    }));
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/agent-loop" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reason: "continue_available_work", executedNodeIds: ["evidence-audit"] });
    expect(execute).toHaveBeenCalledOnce();
    await app.close();
  });

  it("automatically resumes a failed zero-cost Agent node on the next loop request", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const candidate = agentLoopCandidate("candidate-agent-recovery");
    const run = createRunFromCandidate(candidate, {
      id: "run-agent-recovery",
      opportunityId: "opportunity-agent-recovery",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: candidate.hook, targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
      now: NOW,
    });
    run.status = "failed";
    run.nodes.forEach((node) => { node.status = "pending"; });
    run.nodes.find((node) => node.id === "episode-opportunity")!.status = "succeeded";
    run.nodes.find((node) => node.id === "research-plan")!.status = "succeeded";
    run.nodes.find((node) => node.id === "source-packet")!.status = "succeeded";
    const claims = run.nodes.find((node) => node.id === "claim-ledger");
    if (!claims) throw new Error("claim ledger missing");
    claims.status = "failed";
    claims.lastError = "浏览器连接已中断，执行已请求取消";
    run.executionReceipts = [{
      id: "receipt-claims-cancelled",
      nodeId: claims.id,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      status: "failed",
      billing: "subscription",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      errorMessage: claims.lastError,
    }];
    snapshot.runs.unshift(run);
    await repository.save(snapshot);
    const execute = vi.fn(async ({ node }: NodeExecutionContext) => ({
      status: "succeeded" as const,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      billing: "subscription" as const,
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      outputs: { [node.outputArtifactIds[0]!]: { status: "verified", claims: [] } },
    }));
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-agent-recovery/agent-loop" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "continue_available_work",
      executedNodeIds: ["claim-ledger"],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect((await repository.load()).runs.find((item) => item.id === run.id)?.nodes.find((node) => node.id === claims.id)?.status).toBe("succeeded");
    await app.close();
  });

  it("stops automatic failed-node recovery after three failed or rejected attempts", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const candidate = agentLoopCandidate("candidate-agent-recovery-limit");
    const run = createRunFromCandidate(candidate, {
      id: "run-agent-recovery-limit",
      opportunityId: "opportunity-agent-recovery-limit",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: candidate.hook, targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
      now: NOW,
    });
    run.status = "failed";
    run.nodes.forEach((node) => { node.status = "pending"; });
    run.nodes.find((node) => node.id === "episode-opportunity")!.status = "succeeded";
    run.nodes.find((node) => node.id === "research-plan")!.status = "succeeded";
    run.nodes.find((node) => node.id === "source-packet")!.status = "succeeded";
    const claims = run.nodes.find((node) => node.id === "claim-ledger");
    if (!claims) throw new Error("claim ledger missing");
    claims.status = "failed";
    claims.lastError = "upstream unavailable";
    run.executionReceipts = Array.from({ length: 3 }, (_, index) => ({
      id: `receipt-claims-failed-${index + 1}`,
      nodeId: claims.id,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      status: index === 0 ? "failed" as const : "rejected" as const,
      billing: "subscription" as const,
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      errorMessage: claims.lastError,
    }));
    snapshot.runs.unshift(run);
    await repository.save(snapshot);
    const execute = vi.fn();
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-agent-recovery-limit/agent-loop" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reason: "repair_limit",
      stoppedAtNodeId: "claim-ledger",
      executedNodeIds: [],
    });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("prioritizes the dedicated research repair and never bypasses an unresolved repair", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const candidate = agentLoopCandidate("candidate-research-repair-recovery");
    const run = createRunFromCandidate(candidate, {
      id: "run-research-repair-recovery",
      opportunityId: "opportunity-research-repair-recovery",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: candidate.hook, targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
      now: NOW,
    });
    run.status = "failed";
    run.nodes.forEach((node) => { node.status = "pending"; });
    run.nodes.find((node) => node.id === "episode-opportunity")!.status = "succeeded";
    run.nodes.find((node) => node.id === "research-plan")!.status = "succeeded";
    const source = run.nodes.find((node) => node.id === "source-packet");
    const repair = run.nodes.find((node) => node.id === "research-repair");
    if (!source || !repair) throw new Error("research loop nodes missing");
    source.status = "failed";
    source.lastError = "retrieval timed out";
    repair.status = "failed";
    repair.lastError = "repair Agent interrupted";
    run.executionReceipts = [
      {
        id: "receipt-source-failed",
        nodeId: source.id,
        providerId: "free-research",
        modelId: "search-test",
        status: "failed",
        billing: "free",
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
        errorMessage: source.lastError,
      },
      {
        id: "receipt-repair-failed",
        nodeId: repair.id,
        providerId: "openai-codex-subscription",
        modelId: "codex-test",
        status: "failed",
        billing: "subscription",
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
        errorMessage: repair.lastError,
      },
    ];
    snapshot.runs.unshift(run);
    await repository.save(snapshot);
    const execute = vi.fn(async ({ node }: NodeExecutionContext) => ({
      status: "succeeded" as const,
      providerId: "openai-codex-subscription",
      modelId: "codex-test",
      billing: "subscription" as const,
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
      outputs: { [node.outputArtifactIds[0]!]: { status: "ready", queries: [{ query: "repaired query" }] } },
    }));
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-research-repair-recovery/agent-loop" });

    expect(response.statusCode).toBe(200);
    expect(response.json().executedNodeIds).toEqual(["research-repair"]);
    expect(execute).toHaveBeenCalledOnce();

    const unresolvedSnapshot = await repository.load();
    const unresolvedRun = unresolvedSnapshot.runs.find((item) => item.id === run.id)!;
    unresolvedRun.status = "failed";
    unresolvedRun.nodes.find((node) => node.id === source.id)!.status = "failed";
    unresolvedRun.nodes.find((node) => node.id === repair.id)!.status = "needs_human";
    await repository.save(unresolvedSnapshot);

    const unresolvedResponse = await app.inject({ method: "POST", url: "/api/runs/run-research-repair-recovery/agent-loop" });

    expect(unresolvedResponse.statusCode).toBe(200);
    expect(unresolvedResponse.json()).toMatchObject({
      reason: "requires_input",
      stoppedAtNodeId: "research-repair",
      executedNodeIds: [],
    });
    expect(execute).toHaveBeenCalledOnce();
    await app.close();
  });

  it("generates a long-form script one chapter per Agent-loop step before releasing the Showrunner", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const candidate = EpisodeCandidateSchema.parse({
      id: "candidate-chapter-loop",
      origin: "custom",
      title: "逐章生成测试",
      hook: "验证长篇脚本不会被一次性粗略生成。",
      rationale: "服务级逐章执行回归测试。",
      category: "other",
      platform: "测试编辑部",
      suggestedRoles: ["主持"],
      verdict: "rapid_brief",
      targetMinutes: { min: 15, max: 25 },
      score: { overall: 80, audienceRelevance: 80, conversationPotential: 80, evidenceDepth: 80, longformDepth: 80, freshness: 50, seriesFit: 80, feasibility: 90, risk: 10 },
      evidence: [],
      verification: { status: "ready", reason: "测试资料已齐备", independentSources: 2 },
      generatedAt: NOW,
    });
    let run = createRunFromCandidate(candidate, {
      id: "run-chapter-loop",
      opportunityId: "opportunity-chapter-loop",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: { hook: candidate.hook, targetMinutes: 20, musicPolicy: "minimal", budgetPolicy: "local", maxCostCny: 0 },
      now: NOW,
    });
    run = reviseArtifact(run, "artifact-blueprint", {
      status: "draft",
      targetMinutes: 20,
      segments: [
        { id: "opening", title: "提出问题", minutes: 7, purpose: "建立问题" },
        { id: "evidence", title: "证据与反例", minutes: 7, purpose: "检验证据" },
        { id: "closing", title: "判断边界", minutes: 6, purpose: "收束判断" },
      ],
    }, NOW);
    run.nodes.forEach((node) => { node.status = "needs_human"; });
    run.nodes.find((node) => node.id === "episode-opportunity")!.status = "succeeded";
    run.nodes.find((node) => node.id === "source-packet")!.status = "succeeded";
    run.nodes.find((node) => node.id === "cast-plan")!.status = "succeeded";
    run.nodes.find((node) => node.id === "episode-blueprint")!.status = "succeeded";
    run.nodes.find((node) => node.id === "segment-room-1")!.status = "ready";
    run.status = "active";
    snapshot.runs.unshift(run);
    await repository.save(snapshot);
    const segmentIds: string[] = [];
    const execute = vi.fn(async ({ run: executionRun, node, input }: NodeExecutionContext) => {
      const segmentId = input?.segmentId;
      if (!segmentId) throw new Error("chapter loop did not select a segment");
      segmentIds.push(segmentId);
      const artifact = executionRun.artifacts.find((item) => item.id === node.outputArtifactIds[0]);
      const current = artifact?.versions.find((version) => version.id === artifact.activeVersionId)?.data as { lines?: unknown[] } | undefined;
      return {
        status: "succeeded" as const,
        providerId: "test-chapter-agent",
        modelId: "chapter-v1",
        billing: "subscription" as const,
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
        outputs: { [node.outputArtifactIds[0]!]: { status: "draft", lines: [...(current?.lines ?? []), { segmentId, speaker: "主持", text: `${segmentId} 的完整章节`, claimIds: [] }] } },
      };
    });
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, nodeExecutor: { execute } });

    for (let step = 0; step < 3; step += 1) {
      const response = await app.inject({ method: "POST", url: "/api/runs/run-chapter-loop/agent-loop" });
      expect(response.statusCode).toBe(200);
      expect(response.json().executedNodeIds).toEqual(["segment-room-1"]);
    }

    const completed = (await repository.load()).runs.find((item) => item.id === "run-chapter-loop")!;
    expect(segmentIds).toEqual(["opening", "evidence", "closing"]);
    expect(completed.nodes.find((node) => node.id === "segment-room-1")?.status).toBe("succeeded");
    expect(completed.nodes.find((node) => node.id === "showrunner-assembly")?.status).toBe("ready");
    expect((completed.artifacts.find((artifact) => artifact.id === "artifact-segment-1")?.versions.at(-1)?.data as { lines: unknown[] }).lines).toHaveLength(3);
    await app.close();
  });

  it("continues the agent loop through zero-cost work and stops before paid TTS", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const candidate = EpisodeCandidateSchema.parse({
      id: "candidate-agent-loop",
      origin: "custom",
      title: "自动推进测试节目",
      hook: "验证自动生产链能在付费前可靠停下。",
      rationale: "服务级 Agent Loop 回归测试。",
      category: "other",
      platform: "测试编辑部",
      suggestedRoles: ["主持", "质疑者"],
      verdict: "rapid_brief",
      targetMinutes: { min: 15, max: 25 },
      score: { overall: 80, audienceRelevance: 80, conversationPotential: 80, evidenceDepth: 80, longformDepth: 60, freshness: 50, seriesFit: 80, feasibility: 90, risk: 10 },
      evidence: [],
      verification: { status: "ready", reason: "测试资料已齐备", independentSources: 2 },
      generatedAt: NOW,
    });
    const run = createRunFromCandidate(candidate, {
      id: "run-agent-loop",
      opportunityId: "opportunity-agent-loop",
      seriesId: snapshot.series[0]!.id,
      recipeId: "rapid-topic-v1",
      productionIntent: {
        hook: candidate.hook,
        targetMinutes: 20,
        musicPolicy: "minimal",
        budgetPolicy: "economy",
        maxCostCny: 3,
      },
      now: NOW,
    });
    snapshot.runs.unshift(run);
    await repository.save(snapshot);

    const execute = vi.fn(async ({ run: executionRun, node }: { run: typeof run; node: typeof run.nodes[number] }) => {
      const artifactId = node.outputArtifactIds[0];
      const artifact = artifactId ? executionRun.artifacts.find((candidate) => candidate.id === artifactId) : undefined;
      const current = artifact?.versions.find((version) => version.id === artifact.activeVersionId)?.data;
      return {
        status: "succeeded" as const,
        providerId: "test-agent-loop",
        modelId: node.capability,
        billing: "local_compute" as const,
        estimatedCostCny: 0,
        actualCostCny: 0,
        startedAt: NOW,
        finishedAt: NOW,
        outputs: {
          [artifactId ?? "missing"]: node.capability === "script.repair" ? current : { generatedBy: node.id },
        },
      };
    });
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan({ node }) {
          return node.capability === "audio.render"
            ? { providerId: "paid-tts", modelId: "tts-v1", billing: "metered", estimatedCostCny: 1.2 }
            : { providerId: "test-agent-loop", modelId: node.capability, billing: "local_compute", estimatedCostCny: 0 };
        },
        execute,
      },
    });

    const executedNodeIds: string[] = [];
    let result: Record<string, unknown> | undefined;
    for (let step = 0; step < 20; step += 1) {
      const response = await app.inject({ method: "POST", url: "/api/runs/run-agent-loop/agent-loop" });
      expect(response.statusCode).toBe(200);
      result = response.json() as Record<string, unknown>;
      const stepNodeIds = result.executedNodeIds as string[];
      expect(stepNodeIds).toHaveLength(result.reason === "continue_available_work" ? 1 : 0);
      executedNodeIds.push(...stepNodeIds);
      if (result.reason !== "continue_available_work") break;
    }

    expect(result).toMatchObject({
      reason: "awaiting_spend_authorization",
      stoppedAtNodeId: "audio-mix",
    });
    expect(executedNodeIds).toEqual(expect.arrayContaining([
      "source-packet",
      "claim-ledger",
      "evidence-audit",
      "cast-plan",
      "script-audit",
      "script-repair",
      "visual-pack",
      "voice-casting",
      "music-cue-sheet",
    ]));
    expect(execute.mock.calls.some(([context]) => context.node.id === "audio-mix")).toBe(false);
    expect((result?.run as typeof run).nodes.find((node) => node.id === "audio-mix")?.status).toBe("ready");
    await app.close();
  });

  it("previews and grants an exact input-scoped spend authorization before execution", async () => {
    const execute = vi.fn(async ({ node }: { node: { id: string } }) => ({
      status: "needs_human" as const,
      providerId: "paid-search",
      modelId: "paid-v1",
      billing: "metered" as const,
      estimatedCostCny: 0.2,
      actualCostCny: 0.2,
      startedAt: NOW,
      finishedAt: NOW,
      outputs: {},
      errorMessage: `${node.id} 已完成付费试跑`,
    }));
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "paid-search", modelId: "paid-v1", billing: "metered", estimatedCostCny: 0.2 };
        },
        execute,
      },
    });

    const preview = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      providerId: "paid-search",
      modelId: "paid-v1",
      billing: "metered",
      estimatedCostCny: 0.2,
      authorization: "required",
      attemptsUsed: 0,
    });

    const expandedAuthorization = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/spend-authorizations",
      payload: { maxCostCny: 0.2, maxAttempts: 3, termsConfirmed: true },
    });
    expect(expandedAuthorization.statusCode).toBe(400);

    const authorized = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/spend-authorizations",
      payload: { maxCostCny: 0.2, maxAttempts: 1, termsConfirmed: true },
    });
    expect(authorized.statusCode).toBe(201);
    expect(authorized.json().spendAuthorizations.at(-1)).toMatchObject({
      nodeId: "source-packet",
      providerId: "paid-search",
      modelId: "paid-v1",
      maxCostCny: 0.2,
      maxAttempts: 1,
    });

    const active = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(active.json()).toMatchObject({ authorization: "active", maxAttempts: 1, attemptsUsed: 0 });
    const execution = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    expect(execution.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();

    const exhausted = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(exhausted.json()).toMatchObject({ authorization: "exhausted", maxAttempts: 1, attemptsUsed: 1 });
    await app.close();
  });

  it("reserves running metered estimates so concurrent nodes cannot exceed the episode budget", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const sourceNode = run?.nodes.find((node) => node.id === "source-packet");
    const briefNode = run?.nodes.find((node) => node.id === "episode-brief");
    if (!run || !sourceNode || !briefNode) throw new Error("seed run missing");
    run.productionIntent = {
      hook: "验证并发预算",
      targetMinutes: 20,
      musicPolicy: "minimal",
      budgetPolicy: "economy",
      maxCostCny: 0.3,
      sonicPalette: [],
      sonicExclusions: [],
    };
    for (const node of [sourceNode, briefNode]) {
      run.spendAuthorizations.push({
        id: `authorization-${node.id}`,
        nodeId: node.id,
        providerId: "paid-test",
        modelId: "paid-v1",
        inputVersionIds: [...node.inputVersionIds],
        maxAttempts: 1,
        maxCostCny: 0.2,
        approvedAt: NOW,
        expiresAt: "2026-08-30T00:00:00.000Z",
      });
    }
    await repository.save(snapshot);
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async ({ node }: { node: { id: string } }) => {
      if (node.id !== "source-packet") throw new Error("second paid execution crossed the budget gate");
      started();
      await waiting;
      return {
        status: "failed" as const,
        providerId: "paid-test",
        modelId: "paid-v1",
        billing: "metered" as const,
        estimatedCostCny: 0.2,
        actualCostCny: 0.2,
        startedAt: NOW,
        finishedAt: NOW,
        outputs: {},
      };
    });
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "paid-test", modelId: "paid-v1", billing: "metered", estimatedCostCny: 0.2 };
        },
        execute,
      },
    });

    const first = app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    await didStart;
    const second = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/episode-brief/execute" });
    release();
    const completedFirst = await first;

    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain("剩余现金上限");
    expect(completedFirst.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    await app.close();
  });

  it("invalidates a spend authorization after an input artifact version changes", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "paid-claims", modelId: "paid-v1", billing: "metered", estimatedCostCny: 0.3 };
        },
        async execute() {
          throw new Error("must not execute");
        },
      },
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/runs/run-deep-reading/nodes/source-packet/spend-authorizations",
      payload: { maxCostCny: 0.3, maxAttempts: 1, termsConfirmed: true },
    });
    expect(authorized.statusCode).toBe(201);

    const revised = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-brief",
      payload: { data: { title: "changed brief" } },
    });
    expect(revised.statusCode).toBe(200);
    const preview = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(preview.json()).toMatchObject({ authorization: "required", attemptsUsed: 0 });
    await app.close();
  });

  it("keeps metered failure cost unknown after an authorized provider throws", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const node = run?.nodes.find((candidate) => candidate.id === "source-packet");
    if (!run || !node) throw new Error("seed node missing");
    run.spendAuthorizations.push({
      id: "authorization-paid-search",
      nodeId: node.id,
      providerId: "paid-search",
      modelId: "paid-v1",
      inputVersionIds: [...node.inputVersionIds],
      maxAttempts: 2,
      maxCostCny: 0.3,
      approvedAt: NOW,
      expiresAt: "2026-08-30T00:00:00.000Z",
    });
    await repository.save(snapshot);
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "paid-search", modelId: "paid-v1", billing: "metered", estimatedCostCny: 0.2 };
        },
        async execute() {
          throw new Error("provider response lost after charge");
        },
      },
    });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    const receipt = response.json().executionReceipts.at(-1);

    expect(response.statusCode).toBe(200);
    expect(receipt).toMatchObject({ status: "failed", billing: "metered" });
    expect(receipt).not.toHaveProperty("actualCostCny");
    const retry = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().message).toContain("尚未对账");
    const preview = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(preview.json()).toMatchObject({ blocker: "unreconciled_cost", remainingBudgetCny: 0 });
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/receipts/${receipt.id}/reconcile`,
      payload: { actualCostCny: 0.17, note: "已与供应商用量后台核对", providerInvoiceId: "invoice-001" },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().executionReceipts.at(-1)).toMatchObject({
      actualCostCny: 0.17,
      reconciliationNote: "已与供应商用量后台核对",
      providerInvoiceId: "invoice-001",
      reconciledAt: NOW,
    });
    const cleared = await app.inject({ method: "GET", url: "/api/runs/run-deep-reading/nodes/source-packet/execution-plan" });
    expect(cleared.json()).toMatchObject({ authorization: "active" });
    expect(cleared.json()).not.toHaveProperty("blocker");
    const overwrite = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/receipts/${receipt.id}/reconcile`,
      payload: { actualCostCny: 0.18, note: "尝试覆盖原始账单" },
    });
    expect(overwrite.statusCode).toBe(409);
    await app.close();
  });

  it("binds release checks to the active automated audio audit", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const audio = run?.artifacts.find((artifact) => artifact.id === "artifact-audio");
    const audioAudit = run?.nodes.find((node) => node.id === "audio-audit");
    const audioVersion = audio?.versions.find((version) => version.id === audio.activeVersionId);
    if (!run || !audio || !audioAudit || !audioVersion) throw new Error("seed audio missing");
    audioVersion.data = { status: "release_candidate", mediaUrl: "/media/run/final.m4a", releaseReady: true };
    audioAudit.status = "ready";
    await repository.save(snapshot);
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "audio-auditor", modelId: "release-preflight-v1", billing: "local_compute", estimatedCostCny: 0 };
        },
        async execute(context) {
          return {
            status: "succeeded" as const,
            providerId: "audio-auditor",
            modelId: "release-preflight-v1",
            billing: "local_compute" as const,
            estimatedCostCny: 0,
            actualCostCny: 0,
            startedAt: NOW,
            finishedAt: NOW,
            outputs: {
              [context.node.outputArtifactIds[0]!]: {
                verdict: "pass",
                findings: [],
                checkedAudioVersionId: context.run.artifacts.find((artifact) => artifact.id === "artifact-audio")?.activeVersionId,
              },
            },
          };
        },
      },
    });

    const audited = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/audio-audit/execute" });
    expect(audited.statusCode).toBe(200);
    expect(audited.json().executionReceipts.at(-1)).toMatchObject({ reviewedInputVersionIds: [audio.activeVersionId] });

    const forgedAudio = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-audio",
      payload: { data: { status: "release_candidate", mediaUrl: "/media/run/final-v2.m4a", releaseReady: true } },
    });
    expect(forgedAudio.statusCode).toBe(409);
    const rights = new URLSearchParams({
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: "true",
      voiceConsentConfirmed: "true",
      musicRightsConfirmed: "true",
    });
    const revisedAudio = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/release-master?${rights}`,
      headers: { "content-type": "audio/wav" },
      payload: variedVoiceLikeWavBuffer(31 * 60, 1_000),
    });
    expect(revisedAudio.statusCode).toBe(200);
    const staleAudit = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/audio-audit/execute" });
    expect(staleAudit.statusCode).toBe(200);
    const revisedAudioArtifact = staleAudit.json().artifacts.find((artifact: { id: string }) => artifact.id === "artifact-audio");
    expect(staleAudit.json().executionReceipts.at(-1)).toMatchObject({
      nodeId: "audio-audit",
      reviewedInputVersionIds: [revisedAudioArtifact.activeVersionId],
    });
    await app.close();
  });

  it("releases the mutation lock while a node executor is running and enforces its deadline", async () => {
    let started: () => void = () => undefined;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let releaseExecution: () => void = () => undefined;
    const executionCanStop = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        plan() {
          return { providerId: "hung-local", modelId: "hung-v1", billing: "local_compute", estimatedCostCny: 0, timeoutMs: 20 };
        },
        async execute() {
          started();
          await executionCanStop;
          throw new Error("provider eventually confirmed cancellation");
        },
      },
    });
    const execution = app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    await didStart;

    const created = await app.inject({
      method: "POST",
      url: "/api/series",
      payload: { requestId: "series-concurrent-request-0001", title: "并发系列", promise: "不被卡死", audience: "编辑", castPolicy: { mode: "dynamic" }, musicPolicy: "minimal" },
    });
    const completed = await execution;

    expect(created.statusCode).toBe(201);
    expect(completed.json().nodes.find((item: { id: string }) => item.id === "source-packet")).toMatchObject({
      status: "needs_human",
      lastError: expect.stringContaining("待人工对账"),
    });
    const blockedRetry = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/source-packet/execute" });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json().message).toContain("正在运行");

    const receipt = completed.json().executionReceipts.at(-1);
    const blockedReconciliation = await app.inject({
      method: "POST",
      url: `/api/runs/run-deep-reading/receipts/${receipt.id}/reconcile`,
      payload: { actualCostCny: 0, note: "执行器仍未确认停止" },
    });
    expect(blockedReconciliation.statusCode).toBe(409);
    expect(blockedReconciliation.json().message).toContain("尚未确认停止");

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(createStudioServer({ workspaceRoot: root, now: () => NOW })).rejects.toThrow("已由另一个 Studio 进程打开");

    releaseExecution();
    await closing;
    const reopened = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    await reopened.close();
  });

  it("recovers a fresh persisted running node immediately after restart", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    snapshot.runs[0] = beginNodeExecution(run, "source-packet", {
      providerId: "test-executor",
      modelId: "research-v1",
      billing: "local_compute",
      estimatedCostCny: 0,
      startedAt: NOW,
    });
    await repository.save(snapshot);

    const recoveredAt = "2026-08-28T00:01:00.000Z";
    const app = await createStudioServer({ workspaceRoot: root, now: () => recoveredAt });
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const recovered = bootstrap.json().runs[0];

    expect(recovered.nodes.find((node: { id: string }) => node.id === "source-packet")).toMatchObject({
      status: "needs_human",
      lastError: expect.stringContaining("结果未知"),
    });
    expect(recovered.executionReceipts.at(-1)).toMatchObject({
      status: "needs_human",
      finishedAt: recoveredAt,
    });
    await app.close();
  });

  it("allows only one Studio process to own a workspace", async () => {
    const first = await createStudioServer({ workspaceRoot: root, now: () => NOW });

    await expect(createStudioServer({ workspaceRoot: root, now: () => NOW })).rejects.toThrow("已由另一个 Studio 进程打开");
    await first.close();
    const reopened = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    expect((await reopened.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(200);
    await reopened.close();
  });

  it("removes private media staging left by an interrupted Studio before accepting work", async () => {
    const staleStage = join(root, ".studio-staging", "run-old", "attempt-old");
    await mkdir(staleStage, { recursive: true });
    await writeFile(join(staleStage, "voice-render-old.mp3"), Buffer.from("orphan"));

    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });

    await expect(readdir(join(root, ".studio-staging"))).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it("removes committed media when the workflow snapshot cannot be saved", async () => {
    const publicMedia = join(root, "media", "run-deep-reading", "save-failure.mp3");
    const discard = vi.fn(async () => rm(publicMedia, { force: true }));
    const executor = {
      async execute() {
        return {
          status: "succeeded" as const,
          providerId: "fault-injection",
          modelId: "save-failure-v1",
          billing: "local_compute" as const,
          estimatedCostCny: 0,
          actualCostCny: 0,
          startedAt: NOW,
          finishedAt: NOW,
          outputs: {},
        };
      },
      async commit(_context: unknown, outcome: NodeExecutionOutcome) {
        await mkdir(join(root, "media", "run-deep-reading"), { recursive: true });
        await writeFile(publicMedia, "committed-before-save");
        return outcome;
      },
      discard,
    };
    const service = await StudioService.create(root, () => NOW, undefined, undefined, executor);
    try {
      const repository = (service as unknown as { repository: JsonStudioRepository }).repository;
      const save = repository.save.bind(repository);
      let saveCalls = 0;
      vi.spyOn(repository, "save").mockImplementation(async (snapshot) => {
        saveCalls += 1;
        if (saveCalls === 2) throw new Error("injected snapshot ENOSPC");
        await save(snapshot);
      });

      await expect(service.executeNode("run-deep-reading", "source-packet")).rejects.toThrow("injected snapshot ENOSPC");
      expect(discard).toHaveBeenCalledOnce();
      await expect(access(publicMedia)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.close();
    }

    const reopened = await StudioService.create(root, () => NOW, undefined, undefined, executor);
    await expect(access(publicMedia)).rejects.toMatchObject({ code: "ENOENT" });
    await reopened.close();
  });

  it("atomically elects one owner when many contenders replace a stale workspace lock", async () => {
    await writeFile(join(root, ".studio-server.lock"), "999999\n", "utf8");

    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireWorkspaceLease(root)));
    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<() => Promise<void>> => attempt.status === "fulfilled");

    expect(acquired).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(11);
    await acquired[0]!.value();
  });

  it("uses flock semantics for Linux production workspace leases", () => {
    expect(workspaceLockCommand("/data/token-talk/.studio-server.lock", {}, "linux")).toEqual({
      executable: "/usr/bin/flock",
      args: ["-n", "/data/token-talk/.studio-server.lock", "/bin/sh", "-c", expect.stringContaining("acquired")],
    });
    expect(workspaceLockCommand("/tmp/token-talk.lock", { LOCKF_PATH: "/custom/lockf" }, "linux")).toEqual({
      executable: "/custom/lockf",
      args: ["-s", "-t", "0", "-k", "/tmp/token-talk.lock", "/bin/sh", "-c", expect.stringContaining("acquired")],
    });
  });

  it("serializes a long node execution with an artifact correction so the correction is not lost", async () => {
    let releaseExecution: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let started: () => void = () => undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const discard = vi.fn(async () => undefined);
    const commit = vi.fn(async (_context, outcome) => outcome);
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: {
        async execute({ node }) {
          started();
          await waiting;
          return {
            status: "succeeded" as const,
            providerId: "test-executor",
            modelId: "cast-v1",
            billing: "local_compute" as const,
            estimatedCostCny: 0,
            actualCostCny: 0,
            startedAt: NOW,
            finishedAt: NOW,
            outputs: { [node.outputArtifactIds[0] ?? "missing"]: { status: "draft", roles: [] } },
          };
        },
        commit,
        discard,
      },
    });
    const execution = app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/cast-plan/execute" });
    await didStart;
    const correction = app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-claims",
      payload: { data: { status: "verified", claims: [{ text: "纠正后的事实", sourceIds: ["source-one"] }] } },
    });
    expect((await correction).statusCode).toBe(200);
    releaseExecution();
    const executed = await execution;
    expect(executed.statusCode).toBe(200);
    expect(executed.json().nodes.find((item: { id: string }) => item.id === "cast-plan").lastError).toContain("旧结果未写入");

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const claims = bootstrap.json().runs[0].artifacts.find((artifact: { id: string }) => artifact.id === "artifact-claims");
    expect(claims.versions).toHaveLength(2);
    expect(claims.versions.at(-1).data.claims[0].text).toBe("纠正后的事实");
    expect(discard).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ attemptId: expect.stringContaining("receipt-cast-plan") }), expect.objectContaining({ status: "succeeded" }));
    await app.close();
  });

  it("blocks a node whose prerequisite reference is missing", async () => {
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await repository.load();
    const run = snapshot.runs[0];
    const node = run?.nodes.find((candidate) => candidate.id === "visual-pack");
    if (!node) throw new Error("visual node missing");
    node.prerequisiteNodeIds = ["missing-review"];
    await repository.save(snapshot);
    const execute = vi.fn();
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      nodeExecutor: { execute },
    });

    const response = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/visual-pack/execute" });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("不存在的审核步骤");
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires source packet revalidation after human changes before claims can run", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-sources",
      payload: { data: { status: "verified", verifiedIndependentSourceCount: 2, sources: [{ id: "one" }, { id: "two" }] } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-claims",
      payload: { data: { status: "needs_human", claims: [{ text: "没有来源的假事实" }] } },
    });

    const claims = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/claim-ledger/execute" });
    expect(claims.statusCode).toBe(409);
    expect(claims.json().message).toContain("资料包");
    const blueprint = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/episode-blueprint/execute" });
    expect(blueprint.statusCode).toBe(409);
    expect(blueprint.json().message).toContain("论点账本");
    await app.close();
  });

  it("blocks a stale downstream node until its stale producer is rerun", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-blueprint",
      payload: { data: { status: "revised", segments: [] } },
    });

    const audio = await app.inject({ method: "POST", url: "/api/runs/run-deep-reading/nodes/audio-mix/execute" });

    expect(audio.statusCode).toBe(409);
    expect(audio.json().message).toContain("整集统筹");
    await app.close();
  });

  it("uses automated audit prerequisites instead of artificial human gates", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const nodes = bootstrap.json().runs[0].nodes;
    expect(nodes.some((node: { capability: string }) => node.capability === "review.human")).toBe(false);
    const publish = nodes.find((node: { id: string }) => node.id === "publish-package");
    expect(publish.prerequisiteNodeIds).toContain("audio-audit");
    await app.close();
  });

  it("persists a series and exposes stale downstream nodes after an artifact revision", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const created = await app.inject({
      method: "POST",
      url: "/api/series",
      payload: {
        requestId: "series-persist-request-000001",
        title: "今天值得谈",
        promise: "把热点变成有来有回的讨论",
        audience: "关注科技与文化的中文听众",
        castPolicy: { mode: "dynamic" },
        musicPolicy: "minimal",
      },
    });
    expect(created.statusCode).toBe(201);
    const retried = await app.inject({
      method: "POST",
      url: "/api/series",
      payload: {
        requestId: "series-persist-request-000001",
        title: "今天值得谈",
        promise: "把热点变成有来有回的讨论",
        audience: "关注科技与文化的中文听众",
        castPolicy: { mode: "dynamic" },
        musicPolicy: "minimal",
      },
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().id).toBe(created.json().id);

    const revised = await app.inject({
      method: "PUT",
      url: "/api/runs/run-deep-reading/artifacts/artifact-blueprint",
      payload: { data: { title: "重新锁定的蓝图" } },
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().nodes.find((node: { id: string }) => node.id === "publish-package").status).toBe("stale");
    await app.close();

    const reopened = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const bootstrap = await reopened.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().series.some((series: { title: string }) => series.title === "今天值得谈")).toBe(true);
    await reopened.close();
  });

  it("returns structured validation errors", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
    const response = await app.inject({
      method: "POST",
      url: "/api/series",
      payload: { title: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_INPUT");
    expect(response.json().issues.length).toBeGreaterThan(0);
    await app.close();
  });

  it("does not let a research-first public event bypass the fact ledger with a rapid recipe", async () => {
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => NOW,
      editorialModel: null,
      trendGateway: {
        async listSignals() {
          return {
            signals: [{
              id: "newsnow:weibo:flood",
              sourceId: "newsnow",
              sourceLabel: "NewsNow",
              platform: "weibo",
              title: "尼泊尔山洪救援持续",
              url: "https://weibo.example/flood",
              observedAt: NOW,
              rank: 1,
            }],
            fetchedAt: NOW,
            warnings: [],
            sources: [{ id: "newsnow", label: "NewsNow 中文热榜", count: 1, status: "ready" as const }],
          };
        },
      },
    });
    const candidates = await app.inject({ method: "POST", url: "/api/candidates" });
    const candidate = candidates.json().items.find((item: { origin: string }) => item.origin === "trend");
    expect(candidate.verdict).toBe("research_first");

    const adopted = await app.inject({
      method: "POST",
      url: `/api/candidates/${candidate.id}/adopt`,
      payload: { verificationConfirmed: true },
    });
    expect(adopted.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST",
      url: `/api/opportunities/${adopted.json().opportunity.id}/start`,
      payload: {
        title: candidate.title,
        hook: candidate.hook,
        centralQuestion: candidate.editorial.centralQuestion,
        listenerPromise: candidate.editorial.listenerPromise,
        recipeId: "rapid-topic-v1",
        targetMinutes: 20,
        musicPolicy: "minimal",
        budgetPolicy: "economy",
        maxCostCny: 3,
      },
    });
    expect(started.statusCode).toBe(409);
    expect(started.json().message).toContain("事实账本");
    await app.close();
  });

  it("persists the central question and listener promise into the episode brief", async () => {
    const app = await createStudioServer({ workspaceRoot: root, now: () => NOW, editorialModel: null });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/opportunities/custom",
      payload: { requestId: "custom-request-001", title: "注意力实验", hook: "一个月不用推荐流会发生什么？", targetMinutes: 30 },
    });
    const retriedAdoption = await app.inject({
      method: "POST",
      url: "/api/opportunities/custom",
      payload: { requestId: "custom-request-001", title: "注意力实验", hook: "一个月不用推荐流会发生什么？", targetMinutes: 30 },
    });
    expect(retriedAdoption.json().opportunity.id).toBe(adopted.json().opportunity.id);
    const afterRetry = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(afterRetry.json().opportunities).toHaveLength(1);
    const started = await app.inject({
      method: "POST",
      url: `/api/opportunities/${adopted.json().opportunity.id}/start`,
      payload: {
        title: "注意力实验：离开推荐流一个月",
        hook: "这不是戒网挑战，而是一次可复盘的生活实验。",
        centralQuestion: "推荐流究竟替我们做了哪些选择？",
        listenerPromise: "听完得到一套可以亲自执行的注意力实验。",
        recipeId: "deep-reading-v1",
        targetMinutes: 35,
        musicPolicy: "minimal",
        budgetPolicy: "balanced",
        maxCostCny: 8,
      },
    });

    expect(started.statusCode).toBe(201);
    const brief = started.json().run.artifacts.find((artifact: { id: string }) => artifact.id === "artifact-brief");
    expect(brief.versions[0].data).toMatchObject({
      centralQuestion: "推荐流究竟替我们做了哪些选择？",
      listenerPromise: "听完得到一套可以亲自执行的注意力实验。",
    });
    await app.close();
  });
});

function silentWavBuffer(durationSeconds = 0.1, sampleRate = 8_000): Buffer {
  const sampleCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function toneWavBuffer(durationSeconds = 0.1, sampleRate = 8_000): Buffer {
  const buffer = silentWavBuffer(durationSeconds, sampleRate);
  const sampleCount = (buffer.byteLength - 44) / 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 120) * 4_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

function variedVoiceLikeWavBuffer(durationSeconds: number, sampleRate: number): Buffer {
  const buffer = silentWavBuffer(durationSeconds, sampleRate);
  const sampleCount = (buffer.byteLength - 44) / 2;
  const frequencies = [90, 140, 110, 170, 125, 155, 100, 180];
  const segmentSamples = Math.max(1, Math.floor(sampleRate / 4));
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = index / sampleRate;
    const frequency = frequencies[Math.floor(index / segmentSamples) % frequencies.length]!;
    const envelope = 0.3 + 0.7 * Math.sin(Math.PI * ((index % segmentSamples) / segmentSamples)) ** 2;
    const phraseGate = index % (sampleRate * 2) > sampleRate * 1.82 ? 0.08 : 1;
    const sample = (
      Math.sin(seconds * Math.PI * 2 * frequency) * 3_200
      + Math.sin(seconds * Math.PI * 4 * frequency) * 1_150
    ) * envelope * phraseGate;
    buffer.writeInt16LE(Math.round(sample), 44 + index * 2);
  }
  return buffer;
}

function solidPngBuffer(width: number, height: number, colorType = 2): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const channels = colorType === 6 ? 4 : 3;
  const row = Buffer.alloc(1 + width * channels);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.byteLength);
  return chunk;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
