import { createSeedSnapshot } from "@token-talk/domain";
import { describe, expect, it, vi } from "vitest";
import {
  ArxivResearchProvider,
  CrossrefResearchProvider,
  FreeResearchGateway,
  HackerNewsResearchProvider,
  OpenAlexResearchProvider,
  OpenLibraryResearchProvider,
  WikipediaResearchProvider,
  type ResearchProvider,
} from "../src/server/research-gateway.js";
import { ResearchNodeExecutor } from "../src/server/research-node-executor.js";
import { reviewResearchPacket, sanitizeResearchPacketRevision, setResearchSourceVerification } from "../src/server/research-ledger.js";
import { StaticSourceVerifier, isPublicAddress } from "../src/server/source-verifier.js";

const NOW = "2026-08-29T00:00:00.000Z";
const WIKIMEDIA_USER_AGENT = "TokenTalkTests/0.1 (test@example.com)";

describe("free research providers", () => {
  it("normalizes Wikipedia and Crossref results as unverified discoveries", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("https://zh.wikipedia.org/")) {
        return Response.json({
          pages: [{ key: "思考，快与慢", title: "思考，快与慢", description: "丹尼尔·卡尼曼著作" }],
        });
      }
      if (url.startsWith("https://api.crossref.org/works")) {
        return Response.json({
          message: {
            items: [{
              DOI: "10.1000/example",
              title: ["Thinking research"],
              author: [{ given: "Ada", family: "Lovelace" }],
              publisher: "Example Press",
              published: { "date-parts": [[2024, 6, 1]] },
              URL: "https://doi.org/10.1000/example",
            }],
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const gateway = new FreeResearchGateway([
      new WikipediaResearchProvider({ fetchImpl, userAgent: WIKIMEDIA_USER_AGENT }),
      new CrossrefResearchProvider({ fetchImpl }),
    ], () => NOW);

    const result = await gateway.search({ query: "思考，快与慢", maxResultsPerProvider: 2 });

    expect(result.sources).toHaveLength(2);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "wikipedia-zh", verificationStatus: "unverified" }),
      expect.objectContaining({ providerId: "crossref-public", publishedAt: "2024-06-01", verificationStatus: "unverified" }),
    ]));
    expect(result.attempts).toEqual([
      expect.objectContaining({ providerId: "wikipedia-zh", status: "succeeded", resultCount: 1 }),
      expect.objectContaining({ providerId: "crossref-public", status: "succeeded", resultCount: 1 }),
    ]);
  });

  it("deduplicates URLs and records provider failures without hiding successful sources", async () => {
    const sharedUrl = "https://example.com/source";
    const providers: ResearchProvider[] = [
      fakeProvider("source-a", [{ title: "来源", url: sharedUrl }]),
      fakeProvider("source-b", [{ title: "同一来源", url: sharedUrl }]),
      { id: "offline", label: "离线源", billing: "free", async search() { throw new Error("timeout"); } },
    ];
    const gateway = new FreeResearchGateway(providers, () => NOW);

    const result = await gateway.search({ query: "测试", maxResultsPerProvider: 3 });

    expect(result.sources).toHaveLength(1);
    expect(result.attempts.at(-1)).toMatchObject({ providerId: "offline", status: "failed", error: "timeout" });
  });

  it("extracts English topic entities for public web and scholarly discovery", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      if (url.origin === "https://hn.algolia.com") {
        return Response.json({
          hits: [{ title: "Not all AI-assisted programming is vibe coding", url: "https://simonwillison.net/2025/Mar/19/vibe-coding/", created_at: "2025-03-19T12:00:00.000Z" }],
        });
      }
      return Response.json({
        message: {
          items: [{ DOI: "10.1000/vibe", title: ["AI-Native Software Engineering and Vibe Coding"], URL: "https://doi.org/10.1000/vibe" }],
        },
      });
    });
    const gateway = new FreeResearchGateway([
      new HackerNewsResearchProvider({ fetchImpl }),
      new CrossrefResearchProvider({ fetchImpl }),
    ], () => NOW);

    const result = await gateway.search({
      query: "Vibe Coding 之后：软件开发正在变成什么？Loop Engineering 怎样避免只得到演示？AI Coding 如何验证？",
      maxResultsPerProvider: 3,
    });

    expect(requestedUrls.map((url) => url.searchParams.get(url.origin === "https://hn.algolia.com" ? "query" : "query.bibliographic"))).toEqual([
      "Vibe Coding",
      "Loop Engineering",
      "Vibe Coding Loop Engineering AI Coding",
    ]);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "hacker-news-public", publisher: "simonwillison.net", publishedAt: "2025-03-19" }),
      expect.objectContaining({ providerId: "crossref-public", title: "AI-Native Software Engineering and Vibe Coding" }),
    ]));
  });

  it("discovers books and papers through free public catalogues without treating metadata as verified facts", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      if (url.origin === "https://api.openalex.org") {
        return Response.json({
          results: [{
            id: "https://openalex.org/W1",
            doi: "https://doi.org/10.1234/research",
            display_name: "Deliberate reasoning under uncertainty",
            publication_date: "2026-02-03",
            authorships: [{ author: { display_name: "Ada Example" } }],
            primary_location: { source: { display_name: "Example Journal" } },
          }],
        });
      }
      return Response.json({
        docs: [{
          key: "OL1W",
          title: "Thinking, Fast and Slow",
          author_name: ["Daniel Kahneman"],
          first_publish_year: 2011,
          edition_count: 48,
        }],
      });
    });
    const gateway = new FreeResearchGateway([
      new OpenLibraryResearchProvider({ fetchImpl }),
      new OpenAlexResearchProvider({ fetchImpl }),
    ], () => NOW);

    const result = await gateway.search({ query: "Thinking Fast and Slow 直觉 决策", maxResultsPerProvider: 3 });

    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "open-library-public",
        url: "https://openlibrary.org/works/OL1W",
        sourceKind: "book_metadata",
        publishedAt: "2011-01-01",
        authors: ["Daniel Kahneman"],
        excerpt: expect.stringContaining("目录收录 48 个版本"),
        verificationStatus: "unverified",
      }),
      expect.objectContaining({
        providerId: "openalex-public",
        url: "https://doi.org/10.1234/research",
        publishedAt: "2026-02-03",
        publisher: "Example Journal",
        authors: ["Ada Example"],
        verificationStatus: "unverified",
      }),
    ]));
    expect(requestedUrls.find((url) => url.origin === "https://openlibrary.org")?.searchParams.get("fields"))
      .toBe("key,title,author_name,first_publish_year,edition_count,has_fulltext,public_scan_b");
    expect(requestedUrls.find((url) => url.origin === "https://api.openalex.org")?.searchParams.get("select"))
      .toContain("authorships");
  });

  it("reads arXiv Atom results as open scholarly abstracts over a fixed HTTPS origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).searchParams.get("search_query")).toBe("all:github AND (all:developer OR all:engineer OR all:programmer) AND (all:AI OR all:Copilot OR all:LLM OR all:ChatGPT)");
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>http://arxiv.org/abs/2401.12345v2</id>
            <published>2024-01-12T00:00:00Z</published>
            <title>Grounded Copilot: How Programmers Interact with Code-Generating Models</title>
            <summary>We report an observational study of professional programmers using an AI coding assistant.</summary>
            <author><name>Ada Example</name></author>
          </entry>
        </feed>`, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
    });
    const gateway = new FreeResearchGateway([new ArxivResearchProvider({ fetchImpl })], () => NOW);

    const result = await gateway.search({ query: "GitHub Copilot developer productivity experiment", maxResultsPerProvider: 3 });

    expect(result.sources).toEqual([expect.objectContaining({
      providerId: "arxiv-public",
      url: "https://arxiv.org/abs/2401.12345v2",
      authors: ["Ada Example"],
      publishedAt: "2024-01-12",
      excerpt: expect.stringContaining("professional programmers"),
    })]);
  });

  it("skips incompatible free catalogues when the research plan requests scholarly sources", async () => {
    const requestedOrigins: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestedOrigins.push(new URL(String(input)).origin);
      return new Response("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", {
        headers: { "content-type": "application/atom+xml" },
      });
    });
    const gateway = new FreeResearchGateway([
      new OpenLibraryResearchProvider({ fetchImpl }),
      new ArxivResearchProvider({ fetchImpl }),
    ], () => NOW);

    await gateway.search({
      query: "AI coding controlled experiment",
      sourceKinds: ["scholarly", "primary"],
      maxResultsPerProvider: 3,
    });

    expect(requestedOrigins).toEqual(["https://export.arxiv.org"]);
  });

  it("reports HTTP 200 contract drift as a provider failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "schema changed" }));
    const gateway = new FreeResearchGateway([
      new WikipediaResearchProvider({ fetchImpl, userAgent: WIKIMEDIA_USER_AGENT }),
    ], () => NOW);

    const result = await gateway.search({ query: "测试", maxResultsPerProvider: 2 });

    expect(result.sources).toEqual([]);
    expect(result.attempts).toEqual([
      expect.objectContaining({ providerId: "wikipedia-zh", status: "failed", resultCount: 0 }),
    ]);
  });

  it("refuses cross-origin responses and oversized JSON before parsing", async () => {
    const crossed = vi.fn<typeof fetch>(async () => {
      const response = Response.json({ pages: [] });
      Object.defineProperty(response, "url", { value: "https://redirected.example/internal" });
      return response;
    });
    const oversized = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "2000001" },
    }));
    const redirectGateway = new FreeResearchGateway([new WikipediaResearchProvider({ fetchImpl: crossed, userAgent: WIKIMEDIA_USER_AGENT })], () => NOW);
    const sizeGateway = new FreeResearchGateway([new WikipediaResearchProvider({ fetchImpl: oversized, userAgent: WIKIMEDIA_USER_AGENT })], () => NOW);

    const [redirectResult, sizeResult] = await Promise.all([
      redirectGateway.search({ query: "测试", maxResultsPerProvider: 1 }),
      sizeGateway.search({ query: "测试", maxResultsPerProvider: 1 }),
    ]);

    expect(crossed).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error" }));
    expect(redirectResult.attempts[0]).toMatchObject({ status: "failed", error: "响应越过固定知识源 origin" });
    expect(sizeResult.attempts[0]).toMatchObject({ status: "failed", error: "知识源响应超过 2MB 上限" });
  });
});

describe("ResearchNodeExecutor", () => {
  it("budgets enough time for sequential multi-query discovery and source verification", () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.id === "source-packet");
    if (!run || !node) throw new Error("source node missing");
    const executor = new ResearchNodeExecutor(new FreeResearchGateway([], () => NOW), { execute: vi.fn() }, () => NOW);

    expect(executor.plan({ run, node })).toMatchObject({
      providerId: "research-agent-orchestrator",
      billing: "free",
      timeoutMs: 120_000,
    });
  });

  it("forwards obsolete fallback media cleanup through the outer research wrapper", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    const node = run?.nodes.find((candidate) => candidate.id === "audio-mix");
    if (!run || !node) throw new Error("audio node missing");
    const discard = vi.fn(async () => undefined);
    const commit = vi.fn(async (_context, outcome) => outcome);
    const fallback = { execute: vi.fn(), discard, commit };
    const executor = new ResearchNodeExecutor(new FreeResearchGateway([], () => NOW), fallback, () => NOW);
    const outcome = { status: "succeeded", providerId: "local", modelId: "audio", billing: "local_compute", estimatedCostCny: 0, actualCostCny: 0, startedAt: NOW, finishedAt: NOW } as const;

    await executor.discard({ run, node, attemptId: "attempt-audio" }, outcome);
    await executor.commit({ run, node, attemptId: "attempt-audio" }, outcome);

    expect(discard).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("fails automatically when discovery does not produce two machine-checked sources", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    if (!node) throw new Error("source node missing");
    const gateway = new FreeResearchGateway([
      fakeProvider("public-source", [{ title: "研究结果", url: "https://example.com/research" }]),
    ], () => NOW);
    const fallback = { execute: vi.fn() };
    const executor = new ResearchNodeExecutor(gateway, fallback, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as Record<string, unknown>;

    expect(outcome).toMatchObject({
      status: "failed",
      providerId: "research-agent-orchestrator",
      billing: "free",
      estimatedCostCny: 0,
      actualCostCny: 0,
    });
    expect(packet).toMatchObject({
      status: "needs_research",
      verifiedIndependentSourceCount: 0,
      sources: [expect.objectContaining({ verificationStatus: "unverified" })],
    });
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it("automatically accepts two independently machine-checked public sources with provenance", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    if (!node) throw new Error("source node missing");
    const gateway = new FreeResearchGateway([
      fakeProvider("public-source", [
        { title: "来源一", url: "https://one.example/research" },
        { title: "来源二", url: "https://two.example/research" },
      ]),
    ], () => NOW);
    const verifier = new StaticSourceVerifier([
      {
        sourceId: "source-1f8f3d3ec41ca344",
        url: "https://one.example/research",
        status: "checked",
        checkedAt: NOW,
        provenanceGroup: "domain:one.example",
        responseContentType: "text/html",
        responseSha256: "a".repeat(64),
      },
      {
        sourceId: "source-b9f1a39f208d0086",
        url: "https://two.example/research",
        status: "checked",
        checkedAt: NOW,
        provenanceGroup: "domain:two.example",
        responseContentType: "text/html",
        responseSha256: "b".repeat(64),
      },
    ]);
    const executor = new ResearchNodeExecutor(gateway, { execute: vi.fn() }, () => NOW, verifier);

    const outcome = await executor.execute(executionContext(run, node));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs?.["artifact-sources"]).toMatchObject({
      status: "machine_checked",
      verifiedIndependentSourceCount: 2,
      sources: [
        expect.objectContaining({ verificationStatus: "machine_checked", verificationMethod: "safe_https_metadata", responseSha256: "a".repeat(64) }),
        expect.objectContaining({ verificationStatus: "machine_checked", verificationMethod: "safe_https_metadata", responseSha256: "b".repeat(64) }),
      ],
    });
  });

  it("uses an explicit research plan to discard irrelevant hits and trust bounded public scholarly metadata", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    if (!node) throw new Error("source node missing");
    run.artifacts.push({
      id: "artifact-research-plan",
      kind: "research.plan",
      activeVersionId: "artifact-research-plan-v1",
      versions: [{
        id: "artifact-research-plan-v1",
        createdAt: NOW,
        sha256: "f".repeat(64),
        source: "seed",
        data: {
          status: "draft",
          queries: [
            { query: "AI assisted programming reasoning quality empirical", sourceKinds: ["scholarly", "primary"] },
            { query: "generative coding programmer learning empirical", sourceKinds: ["scholarly"] },
            { query: "software engineers AI coding assistant comprehension controlled experiment", sourceKinds: ["scholarly", "primary"] },
            { query: "AI pair programmer bug detection trust calibration", sourceKinds: ["scholarly", "primary"] },
          ],
        },
      }],
    });
    const search = vi.fn<ResearchProvider["search"]>(async () => {
      return [
        {
          title: "AI assisted programming and reasoning quality: an empirical study",
          url: "https://doi.org/10.1000/reasoning-one",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "scholarly_metadata",
          verificationStatus: "unverified",
          publisher: "Journal One",
          excerpt: "An empirical study of reasoning quality during AI assisted programming.",
        },
        {
          title: "AI programming assistants and developer reasoning quality",
          url: "https://doi.org/10.1000/reasoning-two",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "scholarly_metadata",
          verificationStatus: "unverified",
          publisher: "Journal Two",
          excerpt: "Measures reasoning quality with and without AI assisted programming.",
        },
        {
          title: "Grounded Copilot: How Programmers Interact with Code-Generating Models",
          url: "https://arxiv.org/abs/2309.00001",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "scholarly_metadata",
          verificationStatus: "unverified",
          publisher: "Journal Three",
          excerpt: "An observational study of professional programmers using code-generating models.",
        },
        {
          title: "When AI Meets Expertise: Trust Calibration in Computer-Aided Polyp Detection",
          url: "https://unrelated.example/medical-calibration",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "scholarly_metadata",
          verificationStatus: "unverified",
          publisher: "Medical Journal",
          excerpt: "A study of physician trust calibration in computer-aided polyp detection.",
        },
        {
          title: "Airfoil optimization in turbulent flow",
          url: "https://unrelated.example/airfoil",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "web",
          verificationStatus: "unverified",
        },
        {
          title: "Generative AI and human learning in healthcare",
          url: "https://unrelated.example/healthcare-ai",
          providerId: "openalex-public",
          providerLabel: "OpenAlex",
          sourceKind: "scholarly_metadata",
          verificationStatus: "unverified",
          publisher: "Medical Journal",
          excerpt: "Generative systems support human learning in clinical care.",
        },
      ];
    });
    const provider: ResearchProvider = {
      id: "openalex-public",
      label: "OpenAlex",
      billing: "free",
      search,
    };
    const executor = new ResearchNodeExecutor(
      new FreeResearchGateway([provider], () => NOW),
      { execute: vi.fn() },
      () => NOW,
      new StaticSourceVerifier([]),
    );

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as { sources: Array<Record<string, unknown>>; research: { queries: string[] } };

    expect(outcome.status).toBe("succeeded");
    expect(packet.research.queries).toEqual([
      "AI assisted programming reasoning quality empirical",
      "generative coding programmer learning empirical",
      "software engineers AI coding assistant comprehension controlled experiment",
      "AI pair programmer bug detection trust calibration",
    ]);
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      query: "AI assisted programming reasoning quality empirical",
      sourceKinds: ["scholarly", "primary"],
    }), expect.any(AbortSignal));
    expect(packet.sources).toHaveLength(3);
    expect(packet.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining("reasoning quality"),
        verificationStatus: "machine_checked",
        verificationMethod: "public_api_metadata",
        provenanceGroup: "publisher:journal-one",
      }),
      expect.objectContaining({ provenanceGroup: "publisher:journal-two" }),
      expect.objectContaining({
        title: expect.stringContaining("Grounded Copilot"),
        provenanceGroup: "publisher:journal-three",
      }),
    ]));
    expect(packet.sources.some((source) => String(source.title).includes("Airfoil"))).toBe(false);
    expect(packet.sources.some((source) => String(source.title).includes("healthcare"))).toBe(false);
  });

  it("keeps a usable failure ledger when every network provider fails", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    if (!node) throw new Error("source node missing");
    const gateway = new FreeResearchGateway([
      { id: "offline", label: "离线源", billing: "free", async search() { throw new Error("network unavailable"); } },
    ], () => NOW);
    const executor = new ResearchNodeExecutor(gateway, { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as Record<string, unknown>;

    expect(outcome.status).toBe("failed");
    expect(packet).toMatchObject({
      status: "needs_research",
      research: {
        attempts: [expect.objectContaining({ providerId: "offline", status: "failed", error: "network unavailable" })],
      },
    });
    expect(packet.gaps).toEqual(expect.arrayContaining([expect.stringContaining("离线源")]));
  });

  it("does not overwrite an existing human-reviewed source when discovery finds the same URL", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!node || !active) throw new Error("research fixture missing");
    active.data = {
      status: "needs_human",
      verifiedIndependentSourceCount: 1,
      sources: [{
        id: "human-source",
        title: "人工核验标题",
        url: "https://example.com/shared#human-note",
        verificationStatus: "verified",
      }],
    };
    const gateway = new FreeResearchGateway([
      fakeProvider("public-source", [{ title: "自动标题", url: "https://example.com/shared" }]),
    ], () => NOW);
    const executor = new ResearchNodeExecutor(gateway, { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as { sources: Array<Record<string, unknown>> };

    expect(packet.sources).toEqual([
      expect.objectContaining({ id: "human-source", title: "人工核验标题", verificationStatus: "verified" }),
    ]);
  });

  it("replaces stale unverified results when the same provider refreshes successfully", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!node || !active) throw new Error("research fixture missing");
    active.data = {
      status: "needs_human",
      sources: [{
        id: "stale-auto-source",
        title: "与选题无关的旧结果",
        url: "https://old.example/irrelevant",
        providerId: "public-source",
        verificationStatus: "unverified",
      }],
    };
    const executor = new ResearchNodeExecutor(new FreeResearchGateway([
      fakeProvider("public-source", [{ title: "重试后的相关来源", url: "https://new.example/relevant" }]),
    ], () => NOW), { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as { sources: Array<Record<string, unknown>> };

    expect(packet.sources).toEqual([
      expect.objectContaining({ title: "重试后的相关来源", url: "https://new.example/relevant" }),
    ]);
  });

  it("retains a machine-checked source already cited by the claim ledger across a new search plan", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const sourceArtifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const sourceVersion = sourceArtifact?.versions.find((version) => version.id === sourceArtifact.activeVersionId);
    const claimArtifact = run.artifacts.find((candidate) => candidate.id === "artifact-claims");
    const claimVersion = claimArtifact?.versions.find((version) => version.id === claimArtifact.activeVersionId);
    const auditArtifact = run.artifacts.find((candidate) => candidate.id === "artifact-research-audit");
    const auditVersion = auditArtifact?.versions.find((version) => version.id === auditArtifact.activeVersionId);
    if (!node || !sourceVersion || !claimVersion || !auditVersion) throw new Error("research fixture missing");
    sourceVersion.data = {
      status: "machine_checked",
      sources: [
        {
          id: "cited-source",
          title: "上一轮已引用的论文",
          url: "https://old.example/cited",
          providerId: "refresh",
          providerLabel: "refresh",
          sourceKind: "scholarly_metadata",
          verificationStatus: "machine_checked",
          publisher: "Old Journal",
        },
        {
          id: "audit-source",
          title: "审计要求重新纳入的反例",
          url: "https://old.example/audit-counterexample",
          providerId: "refresh",
          providerLabel: "refresh",
          sourceKind: "scholarly_metadata",
          verificationStatus: "machine_checked",
          publisher: "Counterexample Journal",
        },
      ],
    };
    claimVersion.data = { status: "verified", claims: [{ id: "claim-one", text: "已引用", sourceIds: ["cited-source"] }] };
    auditVersion.data = { verdict: "revise", findings: [{ evidence: "请重新评估 audit-source" }] };
    const executor = new ResearchNodeExecutor(new FreeResearchGateway([
      fakeProvider("refresh", [{ title: "新检索计划的论文", url: "https://new.example/result" }]),
    ], () => NOW), { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));
    const packet = outcome.outputs?.["artifact-sources"] as { sources: Array<Record<string, unknown>> };

    expect(packet.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cited-source", title: "上一轮已引用的论文" }),
      expect.objectContaining({ id: "audit-source", title: "审计要求重新纳入的反例" }),
      expect.objectContaining({ title: "新检索计划的论文" }),
    ]));
  });

  it("reruns discovery when an edited research plan makes a verified source packet stale", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!node || !active) throw new Error("research fixture missing");
    // Studio 在调用执行器前会把 stale 节点转换为 running。
    node.status = "running";
    active.data = {
      status: "machine_checked",
      sources: [
        { id: "old-one", title: "旧来源一", url: "https://one.example/old", providerId: "refresh", verificationStatus: "machine_checked", provenanceGroup: "domain:one.example" },
        { id: "old-two", title: "旧来源二", url: "https://two.example/old", providerId: "refresh", verificationStatus: "machine_checked", provenanceGroup: "domain:two.example" },
      ],
    };
    const search = vi.fn(async () => []);
    const executor = new ResearchNodeExecutor(new FreeResearchGateway([
      { id: "refresh", label: "refresh", billing: "free", search },
    ], () => NOW), { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));

    expect(search).toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.outputs?.["artifact-sources"]).toMatchObject({ status: "needs_research", sources: [] });
  });

  it("replaces stale automatic failure gaps after a successful retry", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!node || !active) throw new Error("research fixture missing");
    active.data = { status: "pending", gaps: ["主编保留的问题"], sources: [] };
    const failedExecutor = new ResearchNodeExecutor(new FreeResearchGateway([
      { id: "offline", label: "离线源", billing: "free", async search() { throw new Error("timeout"); } },
    ], () => NOW), { execute: vi.fn() }, () => NOW);
    const first = await failedExecutor.execute(executionContext(run, node));
    active.data = first.outputs?.["artifact-sources"];
    const successfulExecutor = new ResearchNodeExecutor(new FreeResearchGateway([
      fakeProvider("online", [{ title: "新来源", url: "https://example.com/new" }]),
    ], () => NOW), { execute: vi.fn() }, () => NOW);

    const second = await successfulExecutor.execute(executionContext(run, node));
    const packet = second.outputs?.["artifact-sources"] as { gaps: string[] };

    expect(packet.gaps).toEqual(["主编保留的问题"]);
  });

  it("rejects forged verified counts and duplicate unreviewed source records", async () => {
    const run = createSeedSnapshot(NOW).runs[0];
    if (!run) throw new Error("seed run missing");
    const node = run.nodes.find((candidate) => candidate.id === "source-packet");
    const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-sources");
    const active = artifact?.versions.find((version) => version.id === artifact.activeVersionId);
    if (!node || !active) throw new Error("research fixture missing");
    active.data = {
      status: "verified",
      verifiedIndependentSourceCount: 2,
      sources: [null, { url: "https://example.com/source" }, { url: "https://example.com/source" }],
    };
    const gateway = new FreeResearchGateway([], () => NOW);
    const executor = new ResearchNodeExecutor(gateway, { execute: vi.fn() }, () => NOW);

    const outcome = await executor.execute(executionContext(run, node));

    expect(outcome.status).toBe("failed");
    expect(outcome.outputs?.["artifact-sources"]).toMatchObject({ verifiedIndependentSourceCount: 0 });
  });
});

describe("research packet review", () => {
  const verified = {
    verificationStatus: "verified" as const,
    verifiedBy: "主编",
    verifiedAt: NOW,
    verificationMethod: "server_action" as const,
  };

  it("does not count subdomains of one provenance group as independent", () => {
    const review = reviewResearchPacket({
      status: "verified",
      sources: [
        { ...verified, id: "one", title: "一", url: "https://www.example.com/one", provenanceGroup: "domain:example.com" },
        { ...verified, id: "two", title: "二", url: "https://news.example.com/two", provenanceGroup: "domain:example.com" },
      ],
    });

    expect(review).toMatchObject({ ready: false, verifiedIndependentSourceCount: 1 });
    expect([...review.verifiedSourceIds]).toEqual(["one", "two"]);
  });

  it("ignores claimed publisher groups and rejects duplicate IDs or URLs", () => {
    const review = reviewResearchPacket({
      status: "verified",
      sources: [
        { ...verified, id: "paper-one", title: "论文一", url: "https://one.example/paper", provenanceGroup: "domain:one.example" },
        { ...verified, id: "paper-two", title: "论文二", url: "https://two.example/paper", provenanceGroup: "domain:two.example" },
        { ...verified, id: "paper-two", title: "重复 ID", url: "https://third.example/item", provenanceGroup: "domain:third.example" },
        { ...verified, id: "paper-four", title: "重复 URL", url: "https://two.example/paper#copy", provenanceGroup: "domain:two.example" },
        { ...verified, id: "forged", title: "伪造分组", url: "https://same.example/item", provenanceGroup: "publisher:fake" },
      ],
    });

    expect(review).toMatchObject({ ready: true, verifiedIndependentSourceCount: 2 });
    expect([...review.verifiedSourceIds]).toEqual(["paper-one", "paper-two"]);
    expect(review.verifiedSources.map((source) => source.url)).toEqual([
      "https://one.example/paper",
      "https://two.example/paper",
    ]);
  });

  it("rejects ambiguous source identities before revision or verification", () => {
    const packet = {
      status: "needs_human",
      sources: [
        { id: "duplicate", title: "来源一", url: "https://one.example/report" },
        { id: "duplicate", title: "来源二", url: "https://two.example/report" },
      ],
    };

    expect(() => sanitizeResearchPacketRevision(packet, { sources: [] })).toThrow("资料来源 ID“duplicate”重复");
    expect(() => setResearchSourceVerification(packet, "duplicate", true, NOW)).toThrow("资料来源 ID“duplicate”重复");
  });
});

describe("source verifier network boundary", () => {
  it("rejects local, private, documentation, tunneled, and mapped addresses", () => {
    expect(isPublicAddress("0.0.0.0")).toBe(false);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.8")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("192.0.2.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("2002:7f00:1::1")).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});

function fakeProvider(
  id: string,
  results: Array<{ title: string; url: string }>,
): ResearchProvider {
  return {
    id,
    label: id,
    billing: "free",
    async search() {
      return results.map((result) => ({
        ...result,
        providerId: id,
        providerLabel: id,
        sourceKind: "web" as const,
        verificationStatus: "unverified" as const,
      }));
    },
  };
}

function executionContext(run: ReturnType<typeof createSeedSnapshot>["runs"][number], node: typeof run.nodes[number]) {
  return { run, node, attemptId: "receipt-test-1", signal: new AbortController().signal };
}
