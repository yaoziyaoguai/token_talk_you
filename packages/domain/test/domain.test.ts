import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSeedSnapshot,
  podcastChapterPlanIssues,
  PublicationRecordSchema,
  ProviderProfileSchema,
  SeriesBibleSchema,
  WorkflowRunSchema,
} from "../src/index.js";

const NOW = "2026-08-28T00:00:00.000Z";

describe("podcast domain", () => {
  it("defaults a series to episode-derived casting without a fixed cast", () => {
    const series = SeriesBibleSchema.parse({
      id: "series-1",
      title: "Token Talk 读书会",
      promise: "把一本书谈成值得继续追问的问题",
      audience: "希望深入理解一本书的中文听众",
      castPolicy: { mode: "dynamic" },
      sonicBible: { musicPolicy: "narrative", palette: ["prepared-piano"] },
      memory: [],
    });

    expect(series.castPolicy.mode).toBe("dynamic");
    expect(series.castPolicy.recurringRoleIds).toEqual([]);
  });

  it("rejects ambiguous or internally inconsistent series casts", () => {
    const result = SeriesBibleSchema.safeParse({
      id: "series-invalid-cast",
      title: "失真的系列",
      promise: "不会被保存",
      audience: "编辑",
      castPolicy: {
        mode: "fixed",
        recurringRoleIds: ["host", "host", "missing"],
        roles: [
          { id: "host", name: "主持" },
          { id: "host", name: "嘉宾" },
          { id: "guest", name: "主持" },
        ],
        minSpeakers: 4,
        maxSpeakers: 1,
      },
      sonicBible: { musicPolicy: "minimal", palette: [], exclusions: [] },
      memory: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path[1])).toEqual(expect.arrayContaining(["roles", "recurringRoleIds", "minSpeakers"]));
  });

  it("does not treat a free quota as commercial permission", () => {
    const provider = ProviderProfileSchema.parse({
      id: "voice-free",
      capability: "voice.synthesize",
      label: "Free Voice",
      deployment: "external",
      billing: { type: "free", unit: "character", rate: 0, currency: "USD" },
      quota: { amount: 10_000, unit: "character", renewal: "monthly" },
      rights: { commercialUse: "restricted", attributionRequired: true },
      verifiedAt: "2026-08-28",
      availability: { status: "needs_config", reason: "API key required" },
    });

    expect(provider.billing.type).toBe("free");
    expect(provider.rights.commercialUse).toBe("restricted");
  });

  it("seeds distinct rapid and deep-reading recipes", () => {
    const snapshot = createSeedSnapshot("2026-08-28T00:00:00.000Z");

    expect(snapshot.recipes.map((recipe) => recipe.id)).toEqual([
      "rapid-topic-v1",
      "deep-reading-v1",
    ]);
    expect(snapshot.recipes[0]?.targetMinutes).not.toEqual(snapshot.recipes[1]?.targetMinutes);
    expect(snapshot.recipes.every((recipe) => recipe.targetMinutes.min >= 15)).toBe(true);
  });

  it("enforces long-form chapter density, minimum chapter duration, and total duration", () => {
    expect(podcastChapterPlanIssues([
      { title: "提出问题", minutes: 10 },
      { title: "证据与反例", minutes: 10 },
      { title: "判断边界", minutes: 10 },
    ], 30)).toEqual([]);
    expect(podcastChapterPlanIssues([
      { title: "过短", minutes: 1 },
      { title: "第二章", minutes: 4 },
      { title: "第三章", minutes: 4 },
      { title: "第四章", minutes: 4 },
    ], 30)).toEqual(expect.arrayContaining([
      expect.stringContaining("最多安排 3 个章节"),
      expect.stringContaining("至少需要 2 分钟"),
      expect.stringContaining("偏离目标"),
    ]));
  });

  it("keeps engineering process records outside the podcast product snapshot", () => {
    const snapshot = createSeedSnapshot("2026-08-28T00:00:00.000Z");
    expect("loops" in snapshot).toBe(false);
    expect(snapshot.opportunities).toEqual([]);
  });

  it("uses a content hash and records the exact input versions consumed by each node", () => {
    const snapshot = createSeedSnapshot("2026-08-28T00:00:00.000Z");
    const run = snapshot.runs[0];
    const brief = run?.artifacts.find((artifact) => artifact.id === "artifact-brief");
    const sourceNode = run?.nodes.find((node) => node.id === "source-packet");
    const expectedHash = createHash("sha256")
      .update(JSON.stringify({ title: "为什么我们还需要认真读《思考，快与慢》" }))
      .digest("hex");

    expect(brief?.versions[0]?.sha256).toBe(expectedHash);
    expect(sourceNode?.inputVersionIds).toEqual(["artifact-brief-v1"]);
  });

  it("accepts only immutable HTTPS publication evidence with bound media checksums", () => {
    const valid = {
      id: "publication-1",
      requestId: "publish-request-001",
      platform: "小宇宙",
      status: "published" as const,
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      releasePackageVersionId: "artifact-publish-v2",
      releasePackageSha256: "a".repeat(64),
      audioSha256: "b".repeat(64),
      coverSha256: "c".repeat(64),
      publishedAt: NOW,
      registeredAt: NOW,
    };

    expect(PublicationRecordSchema.parse(valid)).toMatchObject({ status: "published", platform: "小宇宙" });
    expect(PublicationRecordSchema.safeParse({ ...valid, episodeUrl: "http://example.com/episode" }).success).toBe(false);
    expect(PublicationRecordSchema.safeParse({ ...valid, audioSha256: "not-a-checksum" }).success).toBe(false);
  });

  it("does not reinterpret a legacy completed run as externally published", () => {
    const run = structuredClone(createSeedSnapshot(NOW).runs[0]!);
    run.status = "completed";
    run.publicationRecords = [];

    expect(WorkflowRunSchema.parse(run).status).toBe("release_ready");
  });
});
