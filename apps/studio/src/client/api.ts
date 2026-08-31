/// <reference types="vite/client" />

import { SeriesBibleSchema } from "@token-talk/domain/model";
import {
  AdoptCandidateResponseSchema,
  AgentLoopJobResponseSchema,
  AgentLoopResultSchema,
  CandidateInboxSchema,
  MusicAssetSchema,
  MusicLibrarySchema,
  NodeExecutionPreviewSchema,
  RegisterPublicationResponseSchema,
  StartEpisodeResponseSchema,
  StudioBootstrapSchema,
  VoiceCatalogSchema,
  WorkflowRunSchema,
  type StudioBootstrap,
  type AdoptCandidateResponse,
  type CandidateInbox,
  type AddMusicAssetMetadata,
  type AuthorizeNodeSpendInput,
  type CreateSeriesInput,
  type CreateCustomOpportunityInput,
  type ExecuteNodeInput,
  type AgentLoopResult,
  type AgentLoopJob,
  type StartEpisodeInput,
  type StartEpisodeResponse,
  type NodeExecutionPreview,
  type ReconcileExecutionCostInput,
  type RegisterPublicationInput,
  type RegisterPublicationResponse,
  type RegisterCoverMetadata,
  type RegisterReleaseMasterMetadata,
  type MusicAsset,
  type MusicLibrary,
  type WorkflowRun,
  type VoiceCatalog,
} from "../shared/api.js";

const REQUEST_TIMEOUT_MS = 15_000;
const EXECUTION_TIMEOUT_MS = 15 * 60_000 + 15_000;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
let mutationToken: string | undefined;

const studioBasePath = import.meta.env.BASE_URL === "/"
  ? ""
  : import.meta.env.BASE_URL.replace(/\/$/, "");

export function studioPath(path: string): string {
  if (!path.startsWith("/")) throw new Error("Studio path must start with /");
  return `${studioBasePath}${path}`;
}

async function request(input: RequestInfo | URL, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET") {
    if (!mutationToken) throw new Error("本地写入令牌尚未就绪，请刷新页面");
    headers.set("x-token-talk-token", mutationToken);
  }
  try {
    const target = typeof input === "string" && input.startsWith("/") ? studioPath(input) : input;
    const response = await fetch(target, { ...init, headers, signal: controller.signal });
    const text = await readBoundedResponse(response, MAX_API_RESPONSE_BYTES);
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new Error("Studio 返回了无法读取的响应");
    }
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时，请重试");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Studio 响应超过 8MB 上限");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("Studio 响应超过 8MB 上限");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function serverMessage(body: unknown, fallback: string): string {
  return body && typeof body === "object" && "message" in body && typeof body.message === "string"
    ? body.message
    : fallback;
}

export const StudioApi = {
  configureLocalSession(token: string | undefined): void {
    mutationToken = token && token.length >= 32 ? token : undefined;
  },

  async loadBootstrap(): Promise<StudioBootstrap> {
    const { response, body } = await request("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error("无法载入 Studio 数据");
    const bootstrap = StudioBootstrapSchema.parse(body);
    mutationToken = bootstrap.mutationToken;
    return bootstrap;
  },

  async loadCandidates(refresh = false, cached = false): Promise<CandidateInbox> {
    const query = refresh ? "?refresh=true" : cached ? "?cached=true" : "";
    const { response, body } = await request(`/api/candidates${query}`, { method: "POST" });
    if (!response.ok) throw new Error("无法载入今日选题");
    return CandidateInboxSchema.parse(body);
  },

  async createSeries(input: CreateSeriesInput): Promise<StudioBootstrap["series"][number]> {
    const { response, body } = await request("/api/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法创建系列"));
    return SeriesBibleSchema.parse(body);
  },

  async adoptCandidate(candidateId: string, verificationConfirmed: boolean): Promise<AdoptCandidateResponse> {
    const { response, body } = await request(`/api/candidates/${encodeURIComponent(candidateId)}/adopt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationConfirmed }),
    });
    if (!response.ok) {
      throw new Error(serverMessage(body, "无法采用这个选题"));
    }
    return AdoptCandidateResponseSchema.parse(body);
  },

  async adoptCustom(input: CreateCustomOpportunityInput): Promise<AdoptCandidateResponse> {
    const { response, body } = await request("/api/opportunities/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("无法采用这个自定义选题");
    return AdoptCandidateResponseSchema.parse(body);
  },

  async startEpisode(opportunityId: string, input: StartEpisodeInput): Promise<StartEpisodeResponse> {
    const { response, body } = await request(`/api/opportunities/${encodeURIComponent(opportunityId)}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(serverMessage(body, "无法启动节目制作"));
    }
    return StartEpisodeResponseSchema.parse(body);
  },

  async reviseArtifact(
    runId: string,
    artifactId: string,
    data: unknown,
  ): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${runId}/artifacts/${artifactId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!response.ok) throw new Error("无法保存产物版本");
    return WorkflowRunSchema.parse(body);
  },

  async reviewResearchSource(
    runId: string,
    artifactId: string,
    sourceId: string,
    verified: boolean,
  ): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/sources/${encodeURIComponent(sourceId)}/verification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verified }),
    });
    if (!response.ok) throw new Error("无法保存来源核验");
    return WorkflowRunSchema.parse(body);
  },

  async executeNode(runId: string, nodeId: string, input: ExecuteNodeInput = {}): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, EXECUTION_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(serverMessage(body, "无法运行制作步骤"));
    }
    return WorkflowRunSchema.parse(body);
  },

  async continueAgentLoop(runId: string): Promise<AgentLoopResult> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/agent-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, EXECUTION_TIMEOUT_MS);
    if (!response.ok) throw new Error(serverMessage(body, "无法继续自动制作"));
    return AgentLoopResultSchema.parse(body);
  },

  async startAgentLoopJob(runId: string, idempotencyKey: string): Promise<AgentLoopJob> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/agent-loop-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: "{}",
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法启动云端自动制作"));
    return AgentLoopJobResponseSchema.parse(body);
  },

  async loadLatestAgentLoopJob(runId: string): Promise<AgentLoopJob> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/agent-loop-jobs/latest`, { cache: "no-store" });
    if (!response.ok) throw new Error(serverMessage(body, "无法读取云端自动制作状态"));
    return AgentLoopJobResponseSchema.parse(body);
  },

  async loadAgentLoopJob(runId: string, jobId: string): Promise<AgentLoopJob> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/agent-loop-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(serverMessage(body, "无法读取云端自动制作状态"));
    return AgentLoopJobResponseSchema.parse(body);
  },

  async cancelAgentLoopJob(runId: string, jobId: string): Promise<AgentLoopJob> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/agent-loop-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法停止云端自动制作"));
    return AgentLoopJobResponseSchema.parse(body);
  },

  async loadExecutionPreview(runId: string, nodeId: string): Promise<NodeExecutionPreview> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/execution-plan`);
    if (!response.ok) throw new Error(serverMessage(body, "无法读取执行成本"));
    return NodeExecutionPreviewSchema.parse(body);
  },

  async authorizeNodeSpend(
    runId: string,
    nodeId: string,
    input: AuthorizeNodeSpendInput,
  ): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/spend-authorizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法保存成本授权"));
    return WorkflowRunSchema.parse(body);
  },

  async reconcileExecutionCost(runId: string, receiptId: string, input: ReconcileExecutionCostInput): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/receipts/${encodeURIComponent(receiptId)}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法完成成本对账"));
    return WorkflowRunSchema.parse(body);
  },

  async registerReleaseMaster(runId: string, file: File, metadata: RegisterReleaseMasterMetadata): Promise<WorkflowRun> {
    const query = releaseRightsQuery(metadata);
    query.set("voiceConsentConfirmed", "true");
    query.set("musicRightsConfirmed", "true");
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/release-master?${query}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }, EXECUTION_TIMEOUT_MS);
    if (!response.ok) throw new Error(serverMessage(body, "无法登记发行母带"));
    return WorkflowRunSchema.parse(body);
  },

  async registerCover(runId: string, file: File, metadata: RegisterCoverMetadata): Promise<WorkflowRun> {
    const query = releaseRightsQuery(metadata);
    query.set("altText", metadata.altText);
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/cover-art?${query}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }, EXECUTION_TIMEOUT_MS);
    if (!response.ok) throw new Error(serverMessage(body, "无法登记单集封面"));
    return WorkflowRunSchema.parse(body);
  },

  async selectCover(runId: string, coverId: string): Promise<WorkflowRun> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/cover-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverId }),
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法选择发行封面"));
    return WorkflowRunSchema.parse(body);
  },

  async registerPublication(runId: string, input: RegisterPublicationInput): Promise<RegisterPublicationResponse> {
    const { response, body } = await request(`/api/runs/${encodeURIComponent(runId)}/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法登记外部发布结果"));
    return RegisterPublicationResponseSchema.parse(body);
  },

  async loadMusicAssets(): Promise<MusicLibrary> {
    const { response, body } = await request("/api/music-assets");
    if (!response.ok) throw new Error(serverMessage(body, "无法读取音乐素材库"));
    return MusicLibrarySchema.parse(body);
  },

  async loadVoiceCatalog(): Promise<VoiceCatalog> {
    const { response, body } = await request("/api/voice-catalog", { method: "POST" });
    if (!response.ok) throw new Error(serverMessage(body, "无法读取声音目录"));
    return VoiceCatalogSchema.parse(body);
  },

  async addMusicAsset(file: File, metadata: AddMusicAssetMetadata): Promise<MusicAsset> {
    const query = new URLSearchParams({
      title: metadata.title,
      mood: metadata.mood,
      energy: String(metadata.energy),
      ...(typeof metadata.bpm === "number" ? { bpm: String(metadata.bpm) } : {}),
      ...(metadata.tags ? { tags: metadata.tags } : {}),
      licenseBasis: metadata.licenseBasis,
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      commercialUseConfirmed: "true",
    });
    const { response, body } = await request(`/api/music-assets?${query}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) throw new Error(serverMessage(body, "无法加入音乐素材"));
    return MusicAssetSchema.parse(body);
  },
};

function releaseRightsQuery(metadata: {
  rightsOwner: string;
  licenseBasis: string;
  sourceUrl?: string | undefined;
  commercialUseConfirmed: true | "true";
}): URLSearchParams {
  return new URLSearchParams({
    rightsOwner: metadata.rightsOwner,
    licenseBasis: metadata.licenseBasis,
    ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    commercialUseConfirmed: "true",
  });
}
