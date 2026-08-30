import { z } from "zod";
import { readBoundedJson } from "./bounded-json.js";

export type ProductionCapability = "cast.plan" | "episode.blueprint" | "script.segment" | "music.plan";

export interface GroundedClaim {
  id: string;
  text: string;
  sourceIds: string[];
  spokenQualifier?: string;
}

export interface ProductionModelRequest {
  capability: ProductionCapability;
  title: string;
  targetMinutes: number;
  targetCharacters: number;
  brief: Record<string, unknown>;
  claims: GroundedClaim[];
  cast: Record<string, unknown>;
  blueprint: Record<string, unknown>;
  emotion: Record<string, unknown>;
  musicPolicy: "minimal" | "narrative" | "immersive";
  targetSegment?: Record<string, unknown>;
  currentScript?: {
    lockedSegmentIds: string[];
    lines: Array<Record<string, unknown>>;
  };
}

export interface PodcastProductionModel {
  readonly providerId: string;
  readonly modelId: string;
  generate(request: ProductionModelRequest, signal: AbortSignal): Promise<unknown>;
}

export interface OllamaPodcastProductionModelOptions {
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const OLLAMA_RESPONSE_LIMIT = 4 * 1024 * 1024;

export class OllamaPodcastProductionModel implements PodcastProductionModel {
  readonly providerId = "local-ollama-production";
  readonly modelId: string;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaPodcastProductionModelOptions = {}) {
    const environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (environment.TOKEN_TALK_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
    if (!isLoopbackUrl(this.baseUrl)) throw new Error("Production Ollama must use a loopback URL");
    this.modelId = environment.TOKEN_TALK_PRODUCTION_MODEL?.trim() || "qwen3:8b";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async generate(request: ProductionModelRequest, parentSignal: AbortSignal): Promise<unknown> {
    const requestUrl = `${this.baseUrl}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Production model timed out")), this.timeoutMs);
    const onParentAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    try {
      const response = await this.fetcher(requestUrl, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.modelId,
          stream: false,
          think: true,
          keep_alive: "10m",
          format: formatFor(request.capability),
          options: { temperature: 0.35, num_ctx: 32_768 },
          messages: [
            { role: "system", content: systemPrompt(request) },
            { role: "user", content: JSON.stringify(request) },
          ],
        }),
      });
      if (response.url && new URL(response.url).origin !== new URL(requestUrl).origin) {
        throw new Error("Production model response crossed the configured loopback origin");
      }
      if (!response.ok) throw new Error(`Production model HTTP ${response.status}`);
      const payload = await readBoundedJson(response, OLLAMA_RESPONSE_LIMIT, "Production model");
      const content = OllamaEnvelopeSchema.parse(payload).message.content;
      return JSON.parse(content) as unknown;
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

const OllamaEnvelopeSchema = z.object({
  message: z.object({ content: z.string().min(1) }),
}).passthrough();

function systemPrompt(request: ProductionModelRequest): string {
  return `你是 Token Talk 的播客制作 Agent，当前执行 ${request.capability}。只输出符合 JSON Schema 的 JSON。

硬规则：
1. 只能使用输入 claims 中的事实；不得补写外部数字、引语、研究结论或人物经历。
2. 角色按本期问题动态编排 1–4 个认知角色，不默认双人主持，不使用真人姓名。
3. 台词中的事实判断必须填写 claimIds；claimIds 只能来自输入 claims。
4. script.segment 要接近 targetCharacters，形成可真实桌读的长篇对话，不用提纲、占位符或“此处展开”。
5. 对话要有追问、反例、澄清和自然承接；角色不能轮流念资料。
6. music.plan 只设计 cue 与检索意图，不得声称已有音乐授权；观点密集处优先留白。
7. 不确定内容要使用输入 claim 的 spokenQualifier，不把争议说成定论。
${request.targetSegment ? "8. 这是章节级重生成：只输出 targetSegment 的台词；参考 currentScript 保持前后语义承接，不得改写其他章节。" : ""}`;
}

function formatFor(capability: ProductionCapability): Record<string, unknown> {
  if (capability === "cast.plan") return {
    type: "object",
    properties: { roles: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: {
      id: { type: "string" }, name: { type: "string" }, responsibility: { type: "string" }, speakingStyle: { type: "string" }, mustAsk: { type: "string" }, voiceBrief: { type: "string" },
    }, required: ["id", "name", "responsibility", "speakingStyle", "mustAsk", "voiceBrief"] } } },
    required: ["roles"],
  };
  if (capability === "episode.blueprint") return {
    type: "object",
    properties: { segments: { type: "array", minItems: 3, maxItems: 12, items: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, minutes: { type: "number" }, purpose: { type: "string" }, claimIds: { type: "array", items: { type: "string" } }, tension: { type: "string" }, handoff: { type: "string" },
    }, required: ["id", "title", "minutes", "purpose", "claimIds", "tension", "handoff"] } } },
    required: ["segments"],
  };
  if (capability === "script.segment") return {
    type: "object",
    properties: { lines: { type: "array", minItems: 4, maxItems: 800, items: { type: "object", properties: {
      segmentId: { type: "string" }, speaker: { type: "string" }, text: { type: "string" }, claimIds: { type: "array", items: { type: "string" }, maxItems: 4 }, delivery: { type: "string" }, pauseAfterMs: { type: "integer", minimum: 0, maximum: 5000 },
    }, required: ["segmentId", "speaker", "text", "claimIds"] } } },
    required: ["lines"],
  };
  return {
    type: "object",
    properties: { cues: { type: "array", maxItems: 24, items: { type: "object", properties: {
      id: { type: "string" }, segmentId: { type: "string" }, action: { type: "string", enum: ["silence", "transition", "bed", "outro"] }, durationSeconds: { type: "number", minimum: 0, maximum: 30 }, mood: { type: "string" }, intensity: { type: "integer", minimum: 0, maximum: 5 }, purpose: { type: "string" }, assetQuery: { type: "string" },
    }, required: ["id", "segmentId", "action", "durationSeconds", "mood", "intensity", "purpose", "assetQuery"] } } },
    required: ["cues"],
  };
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && ["127.0.0.1", "localhost", "::1"].includes(hostname);
  } catch {
    return false;
  }
}
