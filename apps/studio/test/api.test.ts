import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedSnapshot } from "@token-talk/domain";
import { StudioApi } from "../src/client/api.js";

const NOW = "2026-08-29T00:00:00.000Z";

describe("StudioApi request ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a bootstrap request that never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const request = StudioApi.loadBootstrap();
    const rejection = expect(request).rejects.toThrow("请求超时，请重试");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("keeps the deadline active while the response body is still streaming", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { status: 200, headers: { "content-type": "application/json" } }))));

    const request = StudioApi.loadBootstrap();
    const rejection = expect(request).rejects.toThrow("请求超时，请重试");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("adds the bootstrap mutation token to write requests", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const token = "browser-local-mutation-token-000001";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, mutationToken: token }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot.runs[0]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    await StudioApi.loadBootstrap();
    await StudioApi.executeNode("run-deep-reading", "source-packet");

    const requestHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(requestHeaders.get("x-token-talk-token")).toBe(token);
  });

  it("uploads release media with rights metadata instead of exposing protected artifact fields", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, mutationToken: "browser-local-mutation-token-000002" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot.runs[0]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await StudioApi.loadBootstrap();
    const file = new File(["audio"], "master.wav", { type: "audio/wav" });

    await StudioApi.registerReleaseMaster("run-deep-reading", file, {
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
      voiceConsentConfirmed: true,
      musicRightsConfirmed: true,
    });

    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/runs/run-deep-reading/release-master?");
    expect(url).toContain("rightsOwner=Token+Talk+%E7%BC%96%E8%BE%91%E9%83%A8");
    expect(url).toContain("voiceConsentConfirmed=true");
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get("content-type")).toBe("audio/wav");
  });

  it("selects a registered cover through a protected business action", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const token = "browser-local-mutation-token-000003";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, mutationToken: token }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot.runs[0]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await StudioApi.loadBootstrap();

    await StudioApi.selectCover("run-deep-reading", "cover-final");

    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/runs/run-deep-reading/cover-selection");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ coverId: "cover-final" });
    expect(new Headers(init.headers).get("x-token-talk-token")).toBe(token);
  });

  it("registers an external publication through the protected ledger endpoint", async () => {
    const snapshot = createSeedSnapshot(NOW);
    const run = snapshot.runs[0]!;
    const record = {
      id: "publication-1",
      requestId: "publish-request-001",
      platform: "小宇宙",
      status: "published" as const,
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      releasePackageVersionId: "artifact-publish-v1",
      releasePackageSha256: "a".repeat(64),
      audioSha256: "b".repeat(64),
      coverSha256: "c".repeat(64),
      publishedAt: NOW,
      registeredAt: NOW,
    };
    run.status = "completed";
    run.publicationRecords.push(record);
    const token = "browser-local-mutation-token-000004";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, mutationToken: token }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run, record }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await StudioApi.loadBootstrap();
    const input = {
      requestId: "publish-request-001",
      platform: "小宇宙",
      status: "published" as const,
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      publishedAt: NOW,
    };

    await StudioApi.registerPublication(run.id, input);

    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/runs/${run.id}/publications`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(new Headers(init.headers).get("x-token-talk-token")).toBe(token);
  });
});
