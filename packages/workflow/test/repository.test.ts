import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeedSnapshot } from "@token-talk/domain";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStudioRepository } from "../src/index.js";

const NOW = "2026-08-28T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JsonStudioRepository", () => {
  it("reopens the most recently saved snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-"));
    roots.push(root);
    const first = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const snapshot = await first.load();
    const firstSeries = snapshot.series[0];
    if (!firstSeries) throw new Error("seed series missing");
    firstSeries.title = "重启后仍然存在";
    await first.save(snapshot);

    const reopened = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));

    expect((await reopened.load()).series[0]?.title).toBe("重启后仍然存在");
  });

  it("returns defensive copies instead of leaking mutable repository state", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-"));
    roots.push(root);
    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const first = await repository.load();
    const firstSeries = first.series[0];
    if (!firstSeries) throw new Error("seed series missing");
    firstSeries.title = "未保存的标题";

    expect((await repository.load()).series[0]?.title).not.toBe("未保存的标题");
  });

  it("rejects a stale writer instead of overwriting another Studio instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-"));
    roots.push(root);
    const first = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const second = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const firstSnapshot = await first.load();
    const staleSnapshot = await second.load();
    const firstSeries = firstSnapshot.series[0];
    const staleSeries = staleSnapshot.series[0];
    if (!firstSeries || !staleSeries) throw new Error("seed series missing");
    firstSeries.title = "第一个实例的更新";
    staleSeries.title = "过期实例的覆盖";

    await first.save(firstSnapshot);

    await expect(second.save(staleSnapshot)).rejects.toThrow("snapshot revision");
    expect((await second.load()).series[0]?.title).toBe("第一个实例的更新");
  });

  it("reclaims a fresh lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-"));
    roots.push(root);
    await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    await writeFile(join(root, "studio.json.lock"), "2147483647 crashed\n", "utf8");

    const reopened = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));

    expect((await reopened.load()).schemaVersion).toBe(1);
  });

  it("reopens a legacy short-form workspace without deleting history or spend boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-legacy-"));
    roots.push(root);
    const legacy = createSeedSnapshot(NOW) as unknown as Record<string, any>;
    legacy.recipes[0].targetMinutes = { min: 8, max: 12 };
    const legacyPreviewProvider = legacy.providers.find((provider: { id: string }) => provider.id === "local-macos-say");
    legacyPreviewProvider.label = "macOS 系统配音";
    legacyPreviewProvider.description = "仅可在 Mac 上使用。";
    legacy.runs[0].productionIntent = {
      hook: "旧版十分钟试跑",
      targetMinutes: 10,
      musicPolicy: "minimal",
      budgetPolicy: "economy",
      maxCostCny: 2,
      sonicPalette: [],
      sonicExclusions: [],
    };
    const legacyClaimNode = legacy.runs[0].nodes.find((node: { id: string }) => node.id === "claim-ledger");
    legacyClaimNode.inputArtifactIds = ["artifact-sources"];
    legacyClaimNode.inputVersionIds = legacyClaimNode.inputVersionIds.slice(-1);
    legacy.runs[0].nodes = legacy.runs[0].nodes.filter((node: { id: string }) => node.id !== "release-editorial");
    legacy.runs[0].artifacts = legacy.runs[0].artifacts.filter((artifact: { id: string }) => artifact.id !== "artifact-release-copy");
    const legacyPublishNode = legacy.runs[0].nodes.find((node: { id: string }) => node.id === "publish-package");
    legacyPublishNode.inputArtifactIds = legacyPublishNode.inputArtifactIds.filter((id: string) => id !== "artifact-release-copy");
    legacyPublishNode.prerequisiteNodeIds = legacyPublishNode.prerequisiteNodeIds.filter((id: string) => id !== "release-editorial");
    legacy.runs[0].spendAuthorizations = [{
      id: "legacy-authorization",
      nodeId: "audio-mix",
      providerId: "paid-tts",
      modelId: "tts-v1",
      inputVersionIds: [],
      maxAttempts: 1,
      maxCostCny: 2,
      approvedAt: NOW,
      expiresAt: "2026-08-29T00:00:00.000Z",
    }];
    await writeFile(join(root, "studio.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const migrated = await repository.load();

    expect(migrated.recipes[0]).toMatchObject({
      targetMinutes: { min: 15, max: 25 },
      legacyTargetMinutes: { min: 8, max: 12 },
    });
    expect(migrated.providers.find((provider) => provider.id === "local-macos-say")).toMatchObject({
      label: "系统桌读预听",
      description: expect.stringContaining("Linux 使用 eSpeak NG"),
    });
    expect(migrated.runs[0]).toMatchObject({
      status: "needs_human",
      productionIntent: { targetMinutes: 15, legacyTargetMinutes: 10 },
      spendAuthorizations: [],
    });
    expect(migrated.runs[0]?.nodes.find((node) => node.id === "episode-blueprint")).toMatchObject({
      status: "stale",
      staleReason: expect.stringContaining("15 分钟最低规格"),
    });
    expect(migrated.runs[0]?.nodes.find((node) => node.id === "claim-ledger")?.inputArtifactIds)
      .toEqual(["artifact-research-plan", "artifact-sources"]);
    expect(migrated.runs[0]?.nodes.find((node) => node.id === "release-editorial")).toMatchObject({
      role: "发行编辑",
      capability: "release.copy",
      prerequisiteNodeIds: ["script-audit", "script-repair"],
    });
    for (const nodeId of ["visual-pack", "voice-casting", "music-cue-sheet"]) {
      expect(migrated.runs[0]?.nodes.find((node) => node.id === nodeId)?.prerequisiteNodeIds)
        .toEqual(["script-audit", "script-repair"]);
    }
    expect(migrated.runs[0]?.nodes.find((node) => node.id === "publish-package")).toMatchObject({
      inputArtifactIds: expect.arrayContaining(["artifact-release-copy"]),
      prerequisiteNodeIds: expect.arrayContaining(["release-editorial"]),
    });
  });

  it("migrates existing production nodes behind the latest passing script audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-talk-audit-gate-"));
    roots.push(root);
    const legacy = createSeedSnapshot(NOW) as unknown as Record<string, any>;
    const run = legacy.runs[0];
    run.status = "active";
    for (const nodeId of ["release-editorial", "visual-pack", "voice-casting", "music-cue-sheet"]) {
      const node = run.nodes.find((candidate: { id: string }) => candidate.id === nodeId);
      node.status = "succeeded";
      node.prerequisiteNodeIds = ["script-repair"];
    }
    const auditArtifact = run.artifacts.find((artifact: { id: string }) => artifact.id === "artifact-script-audit");
    const auditVersion = auditArtifact.versions.find((version: { id: string }) => version.id === auditArtifact.activeVersionId);
    auditVersion.data = { verdict: "revise", findings: [{ id: "finding-1", severity: "warning" }] };
    await writeFile(join(root, "studio.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const repository = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
    const migrated = (await repository.load()).runs[0];

    for (const nodeId of ["release-editorial", "visual-pack", "voice-casting", "music-cue-sheet"]) {
      expect(migrated?.nodes.find((node) => node.id === nodeId)).toMatchObject({
        status: "stale",
        staleReason: "脚本返修后的独立审校尚未通过",
        prerequisiteNodeIds: ["script-audit", "script-repair"],
      });
    }
    expect(migrated?.status).toBe("active");
  });
});
