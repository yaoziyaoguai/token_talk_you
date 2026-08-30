import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";
import {
  AdoptCandidateInputSchema,
  AddMusicAssetMetadataSchema,
  AuthorizeNodeSpendInputSchema,
  CreateCustomOpportunityInputSchema,
  CreateSeriesInputSchema,
  ExecuteNodeInputSchema,
  ReconcileExecutionCostInputSchema,
  RegisterCoverMetadataSchema,
  RegisterPublicationInputSchema,
  RegisterReleaseMasterMetadataSchema,
  ReviseArtifactInputSchema,
  ReviewSourceInputSchema,
  SelectCoverInputSchema,
  StartEpisodeInputSchema,
} from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError, StudioService } from "./studio-service.js";
import type { PodcastEditorialModel } from "./editorial-model.js";
import { UnixSocketCodexAgentClient } from "./codex-agent-client.js";
import { CodexAgentNodeExecutor } from "./codex-agent-node-executor.js";
import { LocalProductionExecutor } from "./local-production-executor.js";
import type { NodeExecutor } from "./node-executor.js";
import { OllamaPodcastProductionModel, type PodcastProductionModel } from "./production-model.js";
import { ProductionModelNodeExecutor } from "./production-node-executor.js";
import { createDefaultFreeResearchGateway, type ResearchSearchGateway } from "./research-gateway.js";
import { ResearchNodeExecutor } from "./research-node-executor.js";
import { SafeHttpsSourceVerifier, type ResearchSourceVerifier } from "./source-verifier.js";
import type { TrendGateway } from "./trend-gateway.js";
import { MusicLibraryInputError, MusicLibraryStore } from "./music-library.js";
import { ReleaseAssetInputError, ReleaseAssetStore } from "./release-asset-store.js";
import { ElevenLabsVoiceRenderer } from "./elevenlabs-voice-renderer.js";

const MAX_MUSIC_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 256 * 1024 * 1024;

export interface CreateStudioServerOptions {
  workspaceRoot: string;
  now?: () => string;
  trendGateway?: Pick<TrendGateway, "listSignals">;
  editorialModel?: PodcastEditorialModel | null;
  nodeExecutor?: NodeExecutor;
  researchGateway?: ResearchSearchGateway;
  sourceVerifier?: ResearchSourceVerifier;
  mutationToken?: string;
  productionModel?: PodcastProductionModel | null;
  trendCollectionIntervalMs?: number;
  publicOrigin?: string;
  clientRoot?: string;
  releaseAssetStore?: Pick<ReleaseAssetStore, "addMaster" | "addCover">;
}

export async function createStudioServer(
  options: CreateStudioServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date().toISOString());
  const mutationToken = options.mutationToken ?? randomBytes(32).toString("base64url");
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  if (mutationToken.length < 32) throw new Error("Studio mutation token must contain at least 32 characters");
  const elevenLabsVoices = new ElevenLabsVoiceRenderer();
  const localExecutor = new LocalProductionExecutor(options.workspaceRoot, now, elevenLabsVoices);
  const productionModel = options.productionModel === undefined
    ? process.env.TOKEN_TALK_PRODUCTION_MODEL ? new OllamaPodcastProductionModel() : null
    : options.productionModel;
  const productionExecutor = new ProductionModelNodeExecutor(productionModel, localExecutor, now);
  const codexExecutor = new CodexAgentNodeExecutor(new UnixSocketCodexAgentClient(), productionExecutor, now);
  const nodeExecutor = options.nodeExecutor ?? new ResearchNodeExecutor(
    options.researchGateway ?? createDefaultFreeResearchGateway(now),
    codexExecutor,
    now,
    options.sourceVerifier ?? new SafeHttpsSourceVerifier(now),
  );
  const service = await StudioService.create(
    options.workspaceRoot,
    now,
    options.trendGateway,
    options.editorialModel,
    nodeExecutor,
    options.trendCollectionIntervalMs,
  );
  const musicLibrary = new MusicLibraryStore(options.workspaceRoot, now);
  const releaseAssets = options.releaseAssetStore ?? new ReleaseAssetStore(options.workspaceRoot, now);
  const app = Fastify({ logger: false });
  const uploadGate = new AsyncSemaphore(1);
  const uploadReleases = new WeakMap<object, () => void>();
  const activeUploadHandlers = new WeakSet<object>();
  app.addContentTypeParser(
    ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "image/jpeg", "image/png", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_RELEASE_ASSET_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onClose", async () => service.close());
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedRequestHost(request.headers.host, publicOrigin)) {
      return reply.status(403).send({ code: "LOCAL_ACCESS_ONLY", message: "Studio 拒绝未配置主机的访问。", issues: [] });
    }
    if (!request.url.startsWith("/api/")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (!isSameOriginBrowserRequest(request.headers.origin, request.headers.host, request.headers["sec-fetch-site"], publicOrigin)) {
      return reply.status(403).send({ code: "CROSS_SITE_REQUEST", message: "Studio 拒绝跨站写入请求。", issues: [] });
    }
    if (!matchesToken(request.headers["x-token-talk-token"], mutationToken)) {
      return reply.status(403).send({ code: "INVALID_LOCAL_TOKEN", message: "Studio 本地写入令牌无效，请刷新页面。", issues: [] });
    }
  });
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!isBinaryAssetUpload(request.method, request.url)) return payload;
    const release = await uploadGate.acquire();
    if (request.raw.aborted) {
      release();
      return payload;
    }
    uploadReleases.set(request.raw, release);
    return payload;
  });
  const releaseUpload = (request: { raw: object }) => {
    const release = uploadReleases.get(request.raw);
    if (!release) return;
    uploadReleases.delete(request.raw);
    release();
  };
  const beginUploadHandler = (request: FastifyRequest) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeUploadHandlers.add(request.raw);
    request.raw.once("aborted", abort);
    if (request.raw.aborted) controller.abort();
    return {
      signal: controller.signal,
      finish: () => {
        request.raw.off("aborted", abort);
        activeUploadHandlers.delete(request.raw);
        releaseUpload(request);
      },
    };
  };
  app.addHook("onError", async (request) => releaseUpload(request));
  app.addHook("onResponse", async (request) => releaseUpload(request));
  app.addHook("onRequestAbort", async (request) => {
    if (!activeUploadHandlers.has(request.raw)) releaseUpload(request);
  });
  const mediaRoot = resolve(options.workspaceRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaRoot,
    prefix: "/media/",
    decorateReply: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413) {
      return reply.status(413).send({ code: "ASSET_TOO_LARGE", message: "上传文件超过 Studio 允许的大小。", issues: [] });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "INVALID_INPUT",
        message: "请求内容不符合 Studio 数据契约。",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (error instanceof StudioNotFoundError) {
      return reply.status(404).send({
        code: "NOT_FOUND",
        message: error.message,
        issues: [],
      });
    }
    if (error instanceof StudioConflictError) {
      return reply.status(409).send({
        code: "CONFLICT",
        message: error.message,
        issues: [],
      });
    }
    if (error instanceof MusicLibraryInputError) {
      return reply.status(400).send({ code: "INVALID_AUDIO", message: error.message, issues: [] });
    }
    if (error instanceof ReleaseAssetInputError) {
      return reply.status(400).send({ code: "INVALID_RELEASE_ASSET", message: error.message, issues: [] });
    }
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Studio 无法完成请求。",
      issues: [],
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/bootstrap", async () => {
    const snapshot = await service.bootstrap();
    return {
      ...snapshot,
      providers: snapshot.providers.map((provider) => {
        if (provider.id === "local-ollama-production") {
          return { ...provider, availability: productionModel ? { status: "configured" as const, reason: "运行时已配置，尚未完成连通性验证" } : provider.availability };
        }
        if (provider.id === "elevenlabs-v3") {
          return { ...provider, availability: elevenLabsVoices.isConfigured() ? { status: "configured" as const, reason: "运行时已配置，声音目录尚未验证" } : provider.availability };
        }
        return provider;
      }),
      mutationToken,
    };
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/release-package", async (request, reply) => {
    const releasePackage = await service.releasePackage(request.params.runId);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", 'attachment; filename="token-talk-release.json"')
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(releasePackage);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/chapters.json", async (request, reply) => {
    const releasePackage = await service.releasePackage(request.params.runId);
    const chapters = releasePackage.podcasting2?.chapters;
    if (!chapters) throw new StudioConflictError("当前发布包尚未生成 Podcasting 2.0 章节数据。");
    return reply
      .header("content-type", chapters.mimeType)
      .header("content-disposition", 'inline; filename="chapters.json"')
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .header("x-content-type-options", "nosniff")
      .send(chapters.data);
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/publications", async (request) => {
    const input = RegisterPublicationInputSchema.parse(request.body);
    return service.registerPublication(request.params.runId, input);
  });

  app.post<{ Querystring: { refresh?: string; cached?: string } }>("/api/candidates", async (request) => {
    if (request.query.cached === "true") return service.listCachedCandidates();
    return service.listCandidates(request.query.refresh === "true");
  });

  app.post<{ Params: { candidateId: string } }>("/api/candidates/:candidateId/adopt", async (request, reply) => {
    const input = AdoptCandidateInputSchema.parse(request.body);
    const opportunity = await service.adoptCandidate(request.params.candidateId, input.verificationConfirmed);
    return reply.status(201).send({ opportunity });
  });

  app.post("/api/opportunities/custom", async (request, reply) => {
    const input = CreateCustomOpportunityInputSchema.parse(request.body);
    const opportunity = await service.adoptCustom(input);
    return reply.status(201).send({ opportunity });
  });

  app.post<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId/start", async (request, reply) => {
    const input = StartEpisodeInputSchema.parse(request.body);
    const started = await service.startOpportunity(request.params.opportunityId, input);
    return reply.status(201).send(started);
  });

  app.post("/api/series", async (request, reply) => {
    const input = CreateSeriesInputSchema.parse(request.body);
    const series = await service.createSeries(input);
    return reply.status(201).send(series);
  });

  app.put<{ Params: { runId: string; artifactId: string } }>(
    "/api/runs/:runId/artifacts/:artifactId",
    async (request) => {
      const input = ReviseArtifactInputSchema.parse(request.body);
      return service.reviseArtifact(
        request.params.runId,
        request.params.artifactId,
        input.data,
      );
    },
  );

  app.post<{ Params: { runId: string; artifactId: string; sourceId: string } }>(
    "/api/runs/:runId/artifacts/:artifactId/sources/:sourceId/verification",
    async (request) => {
      const input = ReviewSourceInputSchema.parse(request.body);
      return service.reviewResearchSource(
        request.params.runId,
        request.params.artifactId,
        request.params.sourceId,
        input.verified,
      );
    },
  );

  app.post<{ Params: { runId: string; nodeId: string } }>(
    "/api/runs/:runId/nodes/:nodeId/execute",
    async (request, reply) => {
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort(new Error("浏览器连接已关闭"));
      };
      reply.raw.once("close", disconnect);
      try {
        const input = ExecuteNodeInputSchema.parse(request.body ?? {});
        return await service.executeNode(request.params.runId, request.params.nodeId, controller.signal, input);
      } finally {
        reply.raw.off("close", disconnect);
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/agent-loop",
    async (request, reply) => {
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort(new Error("浏览器连接已关闭"));
      };
      reply.raw.once("close", disconnect);
      try {
        return await service.continueAgentLoop(request.params.runId, controller.signal, 1);
      } finally {
        reply.raw.off("close", disconnect);
      }
    },
  );

  app.post<{ Params: { runId: string; receiptId: string } }>(
    "/api/runs/:runId/receipts/:receiptId/reconcile",
    async (request) => {
      const input = ReconcileExecutionCostInputSchema.parse(request.body);
      return service.reconcileExecutionCost(request.params.runId, request.params.receiptId, input);
    },
  );

  app.get<{ Params: { runId: string; nodeId: string } }>(
    "/api/runs/:runId/nodes/:nodeId/execution-plan",
    async (request) => service.previewNodeExecution(request.params.runId, request.params.nodeId),
  );

  app.post<{ Params: { runId: string; nodeId: string } }>(
    "/api/runs/:runId/nodes/:nodeId/spend-authorizations",
    async (request, reply) => {
      const input = AuthorizeNodeSpendInputSchema.parse(request.body);
      const run = await service.authorizeNodeSpend(request.params.runId, request.params.nodeId, input);
      return reply.status(201).send(run);
    },
  );

  app.post<{ Params: { runId: string }; Querystring: Record<string, unknown> }>(
    "/api/runs/:runId/release-master",
    { bodyLimit: MAX_RELEASE_ASSET_BYTES },
    async (request) => {
      const upload = beginUploadHandler(request);
      try {
        const metadata = RegisterReleaseMasterMetadataSchema.parse(request.query);
        if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
          throw new ReleaseAssetInputError("请选择一个 MP3、WAV 或 M4A 发行母带。");
        }
        const stored = await releaseAssets.addMaster(request.body, metadata, upload.signal);
        try {
          return await service.registerReleaseMaster(request.params.runId, stored);
        } catch (error) {
          await stored.cleanup();
          throw error;
        }
      } finally {
        upload.finish();
      }
    },
  );

  app.post<{ Params: { runId: string }; Querystring: Record<string, unknown> }>(
    "/api/runs/:runId/cover-art",
    { bodyLimit: 20 * 1024 * 1024 },
    async (request) => {
      const upload = beginUploadHandler(request);
      try {
        const metadata = RegisterCoverMetadataSchema.parse(request.query);
        if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
          throw new ReleaseAssetInputError("请选择一张 JPG 或 PNG 单集封面。");
        }
        const stored = await releaseAssets.addCover(request.body, metadata, upload.signal);
        try {
          return await service.registerCover(request.params.runId, stored);
        } catch (error) {
          await stored.cleanup();
          throw error;
        }
      } finally {
        upload.finish();
      }
    },
  );

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cover-selection", async (request) => {
    const input = SelectCoverInputSchema.parse(request.body);
    return service.selectCover(request.params.runId, input.coverId);
  });

  app.get("/api/music-assets", async () => musicLibrary.list());

  app.post("/api/voice-catalog", async (request) => {
    if (!elevenLabsVoices.isConfigured()) return { providerId: "elevenlabs-v3", configured: false, voices: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    request.raw.once("aborted", () => controller.abort());
    try {
      return { providerId: "elevenlabs-v3", configured: true, voices: await elevenLabsVoices.listVoices(controller.signal) };
    } catch (error) {
      return { providerId: "elevenlabs-v3", configured: true, voices: [], warning: error instanceof Error ? error.message : "ElevenLabs 音色目录暂不可用。" };
    } finally {
      clearTimeout(timer);
    }
  });

  app.post<{ Querystring: Record<string, unknown> }>("/api/music-assets", { bodyLimit: MAX_MUSIC_ASSET_BYTES }, async (request, reply) => {
    const upload = beginUploadHandler(request);
    try {
      const metadata = AddMusicAssetMetadataSchema.parse(request.query);
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        throw new MusicLibraryInputError("请选择一个 MP3、WAV 或 M4A 文件。");
      }
      if (request.body.byteLength > MAX_MUSIC_ASSET_BYTES) throw new MusicLibraryInputError("音乐素材不能超过 25MB。");
      const asset = await musicLibrary.add(request.body, metadata, upload.signal);
      return reply.status(201).send(asset);
    } finally {
      upload.finish();
    }
  });

  if (options.clientRoot) {
    const clientRoot = resolve(options.clientRoot);
    const clientIndex = await readFile(resolve(clientRoot, "index.html"));
    await app.register(fastifyStatic, {
      root: clientRoot,
      prefix: "/",
      decorateReply: false,
      wildcard: false,
      index: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/media/")) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "请求的资源不存在。", issues: [] });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return reply.status(404).send({ code: "NOT_FOUND", message: "请求的资源不存在。", issues: [] });
      }
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(clientIndex);
    });
  }

  return app;
}

function parsePublicOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const origin = new URL(value);
  if (
    origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("TOKEN_TALK_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or hash");
  }
  return origin;
}

function isAllowedRequestHost(value: string | undefined, publicOrigin: URL | undefined): boolean {
  if (isLoopbackHost(value)) return true;
  return Boolean(publicOrigin && canonicalHost(value) === publicOrigin.host.toLowerCase());
}

function isLoopbackHost(value: string | undefined): boolean {
  const host = canonicalHost(value);
  if (!host) return false;
  const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function canonicalHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function isSameOriginBrowserRequest(
  originValue: string | undefined,
  host: string | undefined,
  fetchSite: string | string[] | undefined,
  publicOrigin: URL | undefined,
): boolean {
  if (Array.isArray(fetchSite) || (fetchSite && fetchSite !== "same-origin")) return false;
  if (!originValue) return true;
  try {
    const origin = new URL(originValue);
    if (canonicalHost(origin.host) !== canonicalHost(host)) return false;
    if (publicOrigin && canonicalHost(host) === publicOrigin.host.toLowerCase()) {
      return origin.origin === publicOrigin.origin;
    }
    return (origin.protocol === "http:" || origin.protocol === "https:") && isLoopbackHost(origin.host);
  } catch {
    return false;
  }
}

function matchesToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isBinaryAssetUpload(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/api/music-assets" || pathname.endsWith("/release-master") || pathname.endsWith("/cover-art");
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}
