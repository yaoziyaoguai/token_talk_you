import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSeedSnapshot } from "@token-talk/domain";
import { reviseArtifact } from "@token-talk/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalProductionExecutor } from "../src/server/local-production-executor.js";
import { MusicLibraryStore } from "../src/server/music-library.js";
import { ReleasePackageSchema } from "../src/shared/api.js";

const NOW = "2026-08-29T00:00:00.000Z";
let root: string;
const execFile = promisify(execFileCallback);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "token-talk-local-production-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalProductionExecutor external voice routing", () => {
  it("preserves chapter and claim metadata while assembling the full script", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-segment-1", {
      status: "draft",
      lines: [{
        segmentId: "segment-1",
        speaker: "引导者",
        text: "根据当前资料，先确认证据边界。",
        claimIds: ["claim-1"],
        delivery: "克制",
        pauseAfterMs: 400,
      }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "showrunner-assembly");
    if (!node) throw new Error("assembly node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "assemble-metadata", signal: new AbortController().signal });

    expect(outcome.outputs?.["artifact-script"]).toMatchObject({
      lines: [{
        segmentId: "segment-1",
        speaker: "引导者",
        claimIds: ["claim-1"],
        delivery: "克制",
        pauseAfterMs: 400,
      }],
    });
  });

  it("keeps locked and unrelated chapters during a free local chapter regeneration", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-blueprint", {
      status: "draft",
      segments: [
        { id: "segment-1", title: "开场", minutes: 3, material: ["开场材料"] },
        { id: "segment-2", title: "分歧", minutes: 5, material: ["新的已核验材料"] },
        { id: "segment-3", title: "收束", minutes: 3, material: ["收束材料"] },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-segment-1", {
      status: "draft",
      lockedSegmentIds: ["segment-1"],
      lines: [
        { segmentId: "segment-1", speaker: "引导者", text: "锁定开场", claimIds: [] },
        { segmentId: "segment-2", speaker: "引导者", text: "旧分歧", claimIds: [] },
        { segmentId: "segment-3", speaker: "引导者", text: "保留收束", claimIds: [] },
      ],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "segment-room-1");
    if (!node) throw new Error("script node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "local-target-segment", input: { segmentId: "segment-2" }, signal: new AbortController().signal });

    expect(outcome.outputs?.["artifact-segment-1"]).toMatchObject({
      lockedSegmentIds: ["segment-1"],
      generation: { mode: "structured_template_fallback", targetSegmentId: "segment-2" },
      lines: [
        expect.objectContaining({ segmentId: "segment-1", text: "锁定开场" }),
        expect.objectContaining({ segmentId: "segment-2", text: "接下来谈“分歧”。" }),
        expect.objectContaining({ segmentId: "segment-2", text: "新的已核验材料" }),
        expect.objectContaining({ segmentId: "segment-3", text: "保留收束" }),
      ],
    });
  });

  it("carries a fixed series cast into the local cast plan", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    run.productionIntent = {
      ...run.productionIntent!,
      castPolicy: {
        mode: "fixed",
        recurringRoleIds: ["series-host"],
        roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持长期栏目视角" }],
      },
    };
    const node = run.nodes.find((candidate) => candidate.id === "cast-plan");
    if (!node) throw new Error("cast node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "fixed-cast", signal: new AbortController().signal });

    expect(outcome.outputs?.["artifact-cast"]).toMatchObject({
      policy: "fixed",
      roles: [{ id: "series-host", name: "栏目主持", responsibility: "维持长期栏目视角" }],
    });
  });

  it("plans and renders a configured ElevenLabs multi-role voice track as a metered execution", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [
        { speaker: "引导者", text: "今天我们谈一个问题。" },
        { speaker: "质疑者", text: "这个结论真的成立吗？" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [
        { role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_host_001", use: "release_candidate" },
        { role: "质疑者", providerId: "elevenlabs-v3", voiceId: "voice_guest_002", use: "release_candidate" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", { status: "confirmed", confirmed: true, cues: [] }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const render = vi.fn(async () => ({
      audioChunks: [new Uint8Array([0x49, 0x44, 0x33])],
      submittedCharacters: 20,
      providerCharacterCost: 100,
      requestIds: ["request-one"],
    }));
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [
        { voiceId: "voice_host_001", name: "Host", labels: {} },
        { voiceId: "voice_guest_002", name: "Guest", labels: {} },
      ]),
      render,
    });

    expect(executor.plan({ run, node })).toMatchObject({
      providerId: "elevenlabs-v3",
      modelId: "eleven_v3",
      billing: "metered",
    });
    const context = { run, node, attemptId: "attempt-voice-1", signal: new AbortController().signal };
    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({
      status: "succeeded",
      providerId: "elevenlabs-v3",
      modelId: "eleven_v3",
      billing: "metered",
      actualCostCny: 0.07,
    });
    expect(outcome.outputs?.["artifact-audio"]).toMatchObject({
      status: "preview_ready",
      previewKind: "external_voice_render",
      releaseReady: false,
      rightsState: "pending_automated_audit",
    });
    expect(render).toHaveBeenCalledWith([
      { speaker: "引导者", text: "今天我们谈一个问题。", voiceId: "voice_host_001" },
      { speaker: "质疑者", text: "这个结论真的成立吗？", voiceId: "voice_guest_002" },
    ], expect.any(AbortSignal));
    const outputPath = join(root, "media", "run-deep-reading", "voice-render-attempt-voice-1.mp3");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await executor.commit(context, outcome);
    await expect(readFile(outputPath)).resolves.toEqual(Buffer.from([0x49, 0x44, 0x33]));
    await executor.discard(context, outcome);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before a paid voice call when the script contains an unmapped speaker", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [
        { speaker: "主持", text: "先从已知事实开始。" },
        { speaker: "临时嘉宾", text: "我补充一个新的视角。" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-cast", {
      status: "draft",
      roles: [{ id: "host", name: "主持" }, { id: "guest", name: "嘉宾" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "主持", providerId: "elevenlabs-v3", voiceId: "voice_host_001", use: "release_candidate" }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const render = vi.fn();
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => true, render });

    expect(executor.plan({ run, node })).toMatchObject({ billing: "local_compute", estimatedCostCny: 0 });
    const outcome = await executor.execute({ run, node, attemptId: "attempt-missing-role", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ status: "failed", actualCostCny: 0 });
    expect(outcome.errorMessage).toContain("角色方案之外");
    expect(render).not.toHaveBeenCalled();
  });

  it("fails before a paid voice call when a mapped speaker is outside the cast plan", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "未登记角色", text: "我不在本期角色方案里。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "未登记角色", providerId: "elevenlabs-v3", voiceId: "voice_unknown_001", use: "release_candidate" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", { status: "confirmed", confirmed: true, cues: [] }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const render = vi.fn();
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_unknown_001", name: "Unknown", labels: {} }]),
      render,
    });

    expect(executor.plan({ run, node })).toMatchObject({ billing: "local_compute", estimatedCostCny: 0 });
    const outcome = await executor.execute({ run, node, attemptId: "attempt-outside-cast", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ status: "failed", actualCostCny: 0 });
    expect(outcome.errorMessage).toContain("角色方案之外");
    expect(render).not.toHaveBeenCalled();
  });

  it("fails before a paid voice call until the current music cue plan is ready", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "先确认配乐和留白。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_host_001", use: "release_candidate" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", {
      status: "draft",
      confirmed: false,
      cues: [{ id: "closing", durationSeconds: 1, selection: { action: "silence" } }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const render = vi.fn();
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_host_001", name: "Host", labels: {} }]),
      render,
    });

    expect(executor.plan({ run, node })).toMatchObject({ billing: "local_compute", estimatedCostCny: 0 });
    const outcome = await executor.execute({ run, node, attemptId: "attempt-unconfirmed-cue", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ status: "failed", actualCostCny: 0 });
    expect(outcome.errorMessage).toContain("配乐方案尚未生成");
    expect(render).not.toHaveBeenCalled();
  });

  it("falls back to a local preview voice when an account voice id is no longer available", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "先确认当前账户仍然拥有这个音色。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "ready",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_removed_001", use: "release_candidate" }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "voice-casting");
    if (!node) throw new Error("voice node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_current_001", name: "Current", labels: {} }]),
      render: vi.fn(),
    });

    const outcome = await executor.execute({ run, node, attemptId: "voice-catalog-gate", signal: new AbortController().signal });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-voices"]).toMatchObject({
      status: "ready",
      confirmed: true,
      selections: [{ providerId: "local-macos-say", use: "preview_only" }],
      catalogError: expect.stringContaining("已移除"),
    });
  });

  it("records zero actual cost when the release voice catalog blocks rendering before the paid call", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "先确认当前账户仍然拥有这个音色。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_removed_001", use: "release_candidate" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", { status: "confirmed", confirmed: true, cues: [] }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const render = vi.fn();
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_current_001", name: "Current", labels: {} }]),
      render,
    });

    expect(executor.plan({ run, node })).toMatchObject({ billing: "metered" });
    const outcome = await executor.execute({ run, node, attemptId: "catalog-preflight-zero-cost", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ status: "failed", billing: "metered", actualCostCny: 0 });
    expect(render).not.toHaveBeenCalled();
  });

  it("normalizes a mixed-provider voice plan to the zero-cost local preview", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [
        { speaker: "主持", text: "先从事实开始。" },
        { speaker: "嘉宾", text: "再补一个反例。" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-cast", {
      status: "draft",
      roles: [{ id: "host", name: "主持" }, { id: "guest", name: "嘉宾" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [
        { role: "主持", providerId: "local-macos-say", voiceId: "Tingting", use: "preview_only" },
        { role: "嘉宾", providerId: "elevenlabs-v3", voiceId: "voice_guest_001", use: "release_candidate" },
      ],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "voice-casting");
    if (!node) throw new Error("voice node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_guest_001", name: "Guest", labels: {} }]),
      render: vi.fn(),
    });

    const outcome = await executor.execute({ run, node, attemptId: "mixed-provider-gate", signal: new AbortController().signal });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-voices"]).toMatchObject({
      confirmed: true,
      selections: expect.arrayContaining([expect.objectContaining({ providerId: "local-macos-say" })]),
    });
  });

  it("offers only rights-registered music plus silence and defaults to a safe cue plan", async () => {
    const library = new MusicLibraryStore(root, () => NOW);
    const asset = await library.add(silentWavBuffer(), {
      title: "低密度钢琴",
      mood: "reflective",
      energy: 1,
      bpm: 72,
      tags: "钢琴, 低密度",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
    });
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "主持", text: "这一段需要一个克制的结尾。" }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "music-cue-sheet");
    if (!node) throw new Error("music node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() }, library);

    const proposal = await executor.execute({ run, node, attemptId: "music-proposal", signal: new AbortController().signal });
    expect(proposal.status).toBe("succeeded");
    const plan = proposal.outputs?.["artifact-cues"] as { cues: Array<{ id: string; choices: Array<{ action: string; assetId?: string }>; selection: unknown }> };
    expect(plan.cues).toHaveLength(3);
    expect(plan.cues.every((cue) => cue.choices[0]?.action === "silence")).toBe(true);
    expect(plan.cues.find((cue) => cue.id === "closing")?.choices).toContainEqual(expect.objectContaining({ action: "asset", assetId: asset.id }));

    const confirmed = {
      ...(proposal.outputs?.["artifact-cues"] as Record<string, unknown>),
      status: "ready",
      confirmed: true,
      cues: plan.cues.map((cue) => ({
        ...cue,
        selection: cue.id === "closing" ? { action: "asset", assetId: asset.id } : { action: "silence" },
      })),
    };
    run = reviseArtifact(run, "artifact-cues", confirmed, NOW);
    const accepted = await executor.execute({ run, node, attemptId: "music-confirmed", signal: new AbortController().signal });
    expect(accepted.status).toBe("succeeded");
    expect(accepted.outputs?.["artifact-cues"]).toMatchObject({ selectedAssetIds: [asset.id] });
  });

  it("turns Agent sound direction into rights-safe executable cues", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "先让观点落下，再进入下一章。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", {
      status: "creative_ready",
      policy: "narrative",
      generatedBy: { taskKind: "music-plan", providerId: "openai-codex-subscription" },
      cues: [
        { id: "cue-one", segmentId: "opening", action: "silence", durationSeconds: 2, mood: "克制", intensity: 1, purpose: "让观点落下" },
        { id: "cue-two", segmentId: "segment-2", action: "transition", durationSeconds: 4, mood: "聚焦", intensity: 2, purpose: "进入下一章" },
      ],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "music-cue-sheet");
    if (!node) throw new Error("music node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "agent-music-clearance", signal: new AbortController().signal });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-cues"]).toMatchObject({
      status: "ready",
      confirmed: true,
      libraryAssetCount: 0,
      generatedBy: { taskKind: "music-plan" },
      cues: [
        expect.objectContaining({ id: "cue-one", selection: { action: "silence" }, choices: [expect.objectContaining({ action: "silence" })] }),
        expect.objectContaining({ id: "cue-two", selection: { action: "silence" }, choices: [expect.objectContaining({ action: "silence" })] }),
      ],
    });
  });

  it("renders script pauses into a duration-measured local table read", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "完成不等于已经理解。", pauseAfterMs: 1_000 }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "local-macos-say", voiceId: "Tingting", use: "preview_only" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", {
      status: "confirmed",
      confirmed: true,
      cues: [{ id: "opening", durationSeconds: 0, selection: { action: "silence" } }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });
    const context = { run, node, attemptId: "table-read-with-pause", signal: new AbortController().signal };

    const outcome = await executor.execute(context);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-audio"]).toMatchObject({
      status: "preview_ready",
      durationSeconds: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Number((outcome.outputs?.["artifact-audio"] as Record<string, unknown>).durationSeconds)).toBeGreaterThan(1);
    await executor.commit(context, outcome);
  });

  it("mixes a confirmed licensed cue into the rendered voice track and records the asset id", async () => {
    const dryPath = join(root, "dry.mp3");
    const musicPath = join(root, "music.wav");
    await execFile("/opt/homebrew/bin/ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:a", "libmp3lame", dryPath]);
    await execFile("/opt/homebrew/bin/ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", musicPath]);
    const library = new MusicLibraryStore(root, () => NOW);
    const asset = await library.add(await readFile(musicPath), {
      title: "结尾音色",
      mood: "reflective",
      energy: 1,
      tags: "结尾",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
    });
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      lines: [{ speaker: "引导者", text: "这是需要混音的结尾。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-voices", {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_host_001", use: "release_candidate" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-cues", {
      status: "confirmed",
      confirmed: true,
      cues: [{ id: "closing", durationSeconds: 1, selection: { action: "asset", assetId: asset.id } }],
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, {
      isConfigured: () => true,
      listVoices: vi.fn(async () => [{ voiceId: "voice_host_001", name: "Host", labels: {} }]),
      render: vi.fn(async () => ({
        audioChunks: [await readFile(dryPath)],
        submittedCharacters: 10,
        providerCharacterCost: 10,
        requestIds: ["request-mixed"],
      })),
    }, library);

    const context = { run, node, attemptId: "attempt-mixed", signal: new AbortController().signal };
    const outcome = await executor.execute(context);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-audio"]).toMatchObject({ mixedAssetIds: [asset.id] });
    await executor.commit(context, outcome);
    const output = await readFile(join(root, "media", "run-deep-reading", "voice-render-attempt-mixed.mp3"));
    expect(output.byteLength).toBeGreaterThan(1_000);
  });

  it("does not present an unconfigured external service as a paid executable plan", () => {
    const snapshot = createSeedSnapshot(NOW);
    const run = snapshot.runs[0];
    if (!run) throw new Error("seed run missing");
    const voiceArtifact = run.artifacts.find((artifact) => artifact.id === "artifact-voices");
    const voiceVersion = voiceArtifact?.versions.find((version) => version.id === voiceArtifact.activeVersionId);
    if (!voiceVersion) throw new Error("voice artifact missing");
    voiceVersion.data = {
      status: "confirmed",
      confirmed: true,
      selections: [{ role: "引导者", providerId: "elevenlabs-v3", voiceId: "voice_host_001", use: "release_candidate" }],
    };
    const node = run.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    expect(executor.plan({ run, node })).toMatchObject({ billing: "local_compute", estimatedCostCny: 0 });
  });

  it("blocks a release master outside the Apple loudness and true-peak envelope", async () => {
    let run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    run = reviseArtifact(run, "artifact-script", {
      status: "assembled_draft",
      lines: [{ segmentId: "opening", speaker: "引导者", text: "完整逐字稿。" }],
    }, NOW);
    run = reviseArtifact(run, "artifact-audio", {
      status: "release_master",
      mediaUrl: "/media/run/release-master.m4a",
      sha256: "a".repeat(64),
      durationSeconds: 2_280,
      releaseReady: true,
      audioQc: { integratedLoudnessLufs: -20.5, truePeakDbtp: -0.2 },
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "audio-audit");
    if (!node) throw new Error("audio audit node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "attempt-audio-qc", signal: new AbortController().signal });

    expect(outcome.outputs?.["artifact-audio-audit"]).toMatchObject({
      verdict: "revise",
      findings: expect.arrayContaining([
        expect.stringContaining("-16 ±1 LUFS"),
        expect.stringContaining("-1 dBTP"),
      ]),
      checks: expect.arrayContaining(["integrated-loudness", "true-peak"]),
    });
  });

  it("does not mark a publish package complete when the audio is still a preview", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const initialRun = snapshot.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    let run = reviseArtifact(initialRun, "artifact-audio", {
      status: "preview_ready",
      mediaUrl: "/media/run/table-read.m4a",
      releaseReady: false,
    }, NOW);
    run = reviseArtifact(run, "artifact-visuals", {
      covers: [{
        id: "cover-final",
        mediaUrl: "/media/run/cover.png",
        mimeType: "image/png",
        bytes: 4096,
        sha256: "b".repeat(64),
        width: 1400,
        height: 1400,
        altText: "红色声波",
        externalPlatformPublished: true,
        rights: { owner: "Token Talk 编辑部", basis: "owned", commercialUseConfirmed: true },
      }],
      selectedCoverId: "cover-final",
    }, NOW);
    const node = run.nodes.find((candidate) => candidate.id === "publish-package");
    if (!node) throw new Error("publish node missing");
    const executor = new LocalProductionExecutor(root, () => NOW, { isConfigured: () => false, render: vi.fn() });

    const outcome = await executor.execute({ run, node, attemptId: "attempt-publish-preview", signal: new AbortController().signal });

    expect(outcome.status).toBe("failed");
    expect(outcome.outputs?.["artifact-publish"]).toMatchObject({
      status: "blocked",
      blockers: expect.arrayContaining(["音频仍是桌读或预览，缺少发行母带"]),
    });

    run = reviseArtifact(run, "artifact-audio", {
      status: "release_master",
      mediaUrl: "/media/run/release-master.m4a",
      mimeType: "audio/mp4",
      bytes: 8192,
      sha256: "a".repeat(64),
      durationSeconds: 1_800,
      rights: { owner: "Token Talk 编辑部", basis: "owned", commercialUseConfirmed: true, voiceConsentConfirmed: true, musicRightsConfirmed: true },
      releaseReady: true,
    }, NOW);
    run = reviseArtifact(run, "artifact-script", {
      status: "assembled_draft",
      lines: [
        { segmentId: "opening", speaker: "引导者", text: "今天我们把问题说清楚。" },
        { segmentId: "closing", speaker: "质疑者", text: "最后保留证据边界。" },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-blueprint", {
      segments: [
        { id: "opening", title: "把问题说清楚", minutes: 3 },
        { id: "closing", title: "保留什么判断", minutes: 3 },
      ],
    }, NOW);
    run = reviseArtifact(run, "artifact-sources", verifiedSourcePacket(), NOW);
    const activeAudio = run.artifacts.find((artifact) => artifact.id === "artifact-audio")?.activeVersionId;
    if (!activeAudio) throw new Error("active audio missing");
    run = reviseArtifact(run, "artifact-audio-audit", {
      verdict: "pass",
      findings: [],
      checkedAudioVersionId: activeAudio,
    }, NOW);
    const releaseAudioVersion = run.artifacts.find((artifact) => artifact.id === "artifact-audio")?.versions.find((version) => version.id === activeAudio);
    if (!releaseAudioVersion) throw new Error("release audio version missing");
    const releaseAudioData = releaseAudioVersion.data as Record<string, unknown>;
    releaseAudioData.externalPlatformPublished = true;
    const mismatched = await executor.execute({ run, node, attemptId: "attempt-publish-mismatched-duration", signal: new AbortController().signal });
    expect(mismatched.status).toBe("failed");
    expect(mismatched.outputs?.["artifact-publish"]).toMatchObject({
      status: "blocked",
      blockers: expect.arrayContaining(["发行母带时长与节目章节差异过大，请校对蓝图或重新导出母带"]),
    });
    releaseAudioData.durationSeconds = 360;
    const blueprintArtifact = run.artifacts.find((artifact) => artifact.id === "artifact-blueprint");
    const blueprintVersion = blueprintArtifact?.versions.find((version) => version.id === blueprintArtifact.activeVersionId);
    if (!blueprintVersion) throw new Error("blueprint version missing");
    const blueprintSegments = (blueprintVersion.data as { segments: Array<{ minutes: number }> }).segments;
    blueprintSegments.forEach((segment) => { segment.minutes = 3.45; });
    const overrun = await executor.execute({ run, node, attemptId: "attempt-publish-chapter-overrun", signal: new AbortController().signal });
    expect(overrun.status).toBe("failed");
    expect(overrun.outputs?.["artifact-publish"]).toMatchObject({
      status: "blocked",
      blockers: expect.arrayContaining(["节目章节越过发行母带结尾，请校对蓝图或重新导出母带"]),
    });
    blueprintSegments.forEach((segment) => { segment.minutes = 3; });
    const releaseAudioBytes = releaseAudioData.bytes;
    delete releaseAudioData.bytes;
    const incomplete = await executor.execute({ run, node, attemptId: "attempt-publish-incomplete", signal: new AbortController().signal });
    expect(incomplete.status).toBe("failed");
    expect(incomplete.outputs?.["artifact-publish"]).toMatchObject({
      status: "blocked",
      blockers: ["发行资产或清单元数据不完整，请重新登记母带、封面并运行发布检查"],
    });
    releaseAudioData.bytes = releaseAudioBytes;
    const ready = await executor.execute({ run, node, attemptId: "attempt-publish-master", signal: new AbortController().signal });
    expect(ready.status).toBe("succeeded");
    expect(ready.outputs?.["artifact-publish"]).toMatchObject({
      schemaVersion: 1,
      status: "release_ready",
      releaseReady: true,
      audioAuditArtifactVersionId: expect.any(String),
      cover: { id: "cover-final" },
      transcript: { lineCount: 2, lines: [{ speaker: "引导者" }, { speaker: "质疑者" }] },
      chapters: [{ title: "把问题说清楚", startSeconds: 0 }, { title: "保留什么判断", startSeconds: 180 }],
      sources: [{ id: "source-one" }, { id: "source-two" }],
      disclosures: { aiAssisted: false, automatedAudioAudit: true },
      checksums: { audioSha256: "a".repeat(64), coverSha256: "b".repeat(64) },
    });
    expect(ready.outputs?.["artifact-publish"]).not.toHaveProperty("audio.externalPlatformPublished");
    expect(ready.outputs?.["artifact-publish"]).not.toHaveProperty("cover.externalPlatformPublished");
    const invalidManifest = structuredClone(ready.outputs?.["artifact-publish"]) as { chapters: Array<{ durationSeconds: number }> };
    invalidManifest.chapters[0]!.durationSeconds = 999;
    expect(ReleasePackageSchema.safeParse(invalidManifest).success).toBe(false);
    run.executionReceipts.push({
      id: "receipt-assisted-research",
      nodeId: "source-packet",
      providerId: "research-agent-orchestrator",
      modelId: "free-multi-source-discovery-v1",
      status: "succeeded",
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
      startedAt: NOW,
      finishedAt: NOW,
    });
    const aiAssisted = await executor.execute({ run, node, attemptId: "attempt-publish-ai-assisted", signal: new AbortController().signal });
    expect(aiAssisted.outputs?.["artifact-publish"]).toMatchObject({ disclosures: { aiAssisted: true } });
  });
});

function verifiedSourcePacket() {
  return {
    status: "verified",
    sources: [
      { id: "source-one", title: "来源一", url: "https://one.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:one.example", verificationMethod: "server_action" },
      { id: "source-one", title: "伪造的重复来源", url: "https://forged.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:forged.example", verificationMethod: "server_action" },
      { id: "source-two", title: "来源二", url: "https://two.example/report", verificationStatus: "verified", verifiedBy: "本地主编", verifiedAt: NOW, provenanceGroup: "domain:two.example", verificationMethod: "server_action" },
    ],
  };
}

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
