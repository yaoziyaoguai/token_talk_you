import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateInboxSchema } from "../src/shared/api.js";
import { createStudioServer } from "../src/server/create-server.js";

const MUTATION_TOKEN = "token-talk-trend-collector-test-token";
let root: string;

describe("server trend collection", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "token-talk-trend-collector-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("collects without an open browser, serves the cache, and exposes background degradation", async () => {
    const listSignals = vi.fn()
      .mockImplementationOnce(async () => feed())
      .mockRejectedValueOnce(new Error("upstream timeout"));
    const app = await createStudioServer({
      workspaceRoot: root,
      now: () => new Date().toISOString(),
      mutationToken: MUTATION_TOKEN,
      trendGateway: { listSignals },
      editorialModel: null,
      trendCollectionIntervalMs: 250,
    });

    await vi.waitFor(() => expect(listSignals).toHaveBeenCalledTimes(1), { timeout: 1_000 });

    const cached = await app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "x-token-talk-token": MUTATION_TOKEN },
    });
    const current = CandidateInboxSchema.parse(cached.json());

    expect(cached.statusCode).toBe(200);
    expect(listSignals).toHaveBeenCalledTimes(1);
    expect(current.collector).toMatchObject({
      state: "ready",
      cadenceSeconds: 1,
      consecutiveFailures: 0,
    });
    expect(current.collector?.lastSuccessfulAt).toBe(current.fetchedAt);
    expect(Date.parse(current.collector?.nextAttemptAt ?? "")).toBeGreaterThan(Date.parse(current.fetchedAt));

    await vi.waitFor(() => expect(listSignals).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    await wait(20);
    const degradedResponse = await app.inject({
      method: "POST",
      url: "/api/candidates",
      headers: { "x-token-talk-token": MUTATION_TOKEN },
    });
    const degraded = CandidateInboxSchema.parse(degradedResponse.json());

    expect(listSignals).toHaveBeenCalledTimes(2);
    expect(degraded.freshness).toMatchObject({
      status: "current",
      lastSuccessfulAt: current.fetchedAt,
    });
    expect(degraded.collector).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
      lastSuccessfulAt: current.fetchedAt,
    });
    expect(degraded.collector?.message).toContain("upstream timeout");
    expect(Date.parse(degraded.collector?.nextAttemptAt ?? "") - Date.parse(degraded.collector?.lastAttemptAt ?? "")).toBeGreaterThanOrEqual(490);

    await app.close();
    await wait(650);
    expect(listSignals).toHaveBeenCalledTimes(2);
  });
});

function feed() {
  const fetchedAt = new Date().toISOString();
  return {
    signals: [{
      id: "source:technology:ai-podcast",
      sourceId: "source",
      sourceLabel: "Test source",
      platform: "hacker-news" as const,
      title: "AI podcast production workflows",
      url: "https://example.com/ai-podcast",
      observedAt: fetchedAt,
      rank: 1,
    }],
    fetchedAt,
    warnings: [],
    sources: [{ id: "source", label: "Test source", count: 1, status: "ready" as const }],
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
