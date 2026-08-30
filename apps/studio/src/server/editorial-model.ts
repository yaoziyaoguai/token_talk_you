import { z } from "zod";
import { readBoundedJson } from "./bounded-json.js";

export interface PodcastTopicClusterInput {
  signalId: string;
  sourceTitle: string;
  relatedTitles: string[];
  platforms: string[];
  bestRank: number;
  signalCount: number;
}

export interface PodcastEditorialIdea {
  signalId: string;
  title: string;
  hook: string;
  whyNow: string;
  centralQuestion: string;
  listenerPromise: string;
  selectionReasons: string[];
  suggestedRoles: string[];
  verdict: "rapid_brief" | "deep_discussion" | "research_first" | "skip";
  audienceRelevance: number;
  conversationPotential: number;
  longformDepth: number;
  seriesFit: number;
}

export interface PodcastEditorialModel {
  id: string;
  generate(clusters: PodcastTopicClusterInput[]): Promise<PodcastEditorialIdea[]>;
}

export interface OllamaPodcastEditorialModelOptions {
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const EditorialIdeaSchema = z.object({
  signalId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  hook: z.string().trim().min(1).max(180),
  whyNow: z.string().trim().min(1).max(220),
  centralQuestion: z.string().trim().min(1).max(180),
  listenerPromise: z.string().trim().min(1).max(180),
  selectionReasons: z.array(z.string().trim().min(1).max(120)).min(1).max(3),
  suggestedRoles: z.array(z.string().trim().min(1).max(24)).min(1).max(4),
  verdict: z.enum(["rapid_brief", "deep_discussion", "research_first", "skip"]),
  audienceRelevance: z.number().min(0).max(100),
  conversationPotential: z.number().min(0).max(100),
  longformDepth: z.number().min(0).max(100),
  seriesFit: z.number().min(0).max(100),
});

const EditorialResponseSchema = z.object({
  ideas: z.array(EditorialIdeaSchema).max(12),
});
const MAX_OLLAMA_RESPONSE_BYTES = 4 * 1024 * 1024;

const OLLAMA_FORMAT = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          signalId: { type: "string" },
          title: { type: "string" },
          hook: { type: "string" },
          whyNow: { type: "string" },
          centralQuestion: { type: "string" },
          listenerPromise: { type: "string" },
          selectionReasons: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
          suggestedRoles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
          verdict: { type: "string", enum: ["rapid_brief", "deep_discussion", "research_first", "skip"] },
          audienceRelevance: { type: "number", minimum: 0, maximum: 100 },
          conversationPotential: { type: "number", minimum: 0, maximum: 100 },
          longformDepth: { type: "number", minimum: 0, maximum: 100 },
          seriesFit: { type: "number", minimum: 0, maximum: 100 },
        },
        required: [
          "signalId",
          "title",
          "hook",
          "whyNow",
          "centralQuestion",
          "listenerPromise",
          "selectionReasons",
          "suggestedRoles",
          "verdict",
          "audienceRelevance",
          "conversationPotential",
          "longformDepth",
          "seriesFit",
        ],
      },
    },
  },
  required: ["ideas"],
} as const;

export class OllamaPodcastEditorialModel implements PodcastEditorialModel {
  readonly id: string;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaPodcastEditorialModelOptions = {}) {
    const environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (environment.TOKEN_TALK_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
    if (!isLoopbackUrl(this.baseUrl)) {
      throw new Error("TOKEN_TALK_OLLAMA_URL must use a loopback address; remote editorial models require an explicit provider integration");
    }
    this.id = environment.TOKEN_TALK_EDITOR_MODEL?.trim() || "qwen3:8b";
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async generate(clusters: PodcastTopicClusterInput[]): Promise<PodcastEditorialIdea[]> {
    if (clusters.length === 0) return [];
    const requestUrl = `${this.baseUrl}/api/chat`;
    const response = await this.fetcher(requestUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.id,
        stream: false,
        think: true,
        keep_alive: "10m",
        format: OLLAMA_FORMAT,
        options: { temperature: 0.2, num_ctx: 24_576 },
        messages: [
          { role: "system", content: EDITORIAL_SYSTEM_PROMPT },
          {
            role: "user",
            content: `请从下面的真实信号簇中选择最多 12 个值得做中文播客的题目。只输出 JSON。\n\n${JSON.stringify(clusters)}`,
          },
        ],
      }),
    });
    if (response.url && new URL(response.url).origin !== new URL(requestUrl).origin) {
      throw new Error("Ollama response crossed the configured loopback origin");
    }
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await readBoundedJson(response, MAX_OLLAMA_RESPONSE_BYTES, "Ollama");
    if (!isRecord(payload) || !isRecord(payload.message) || typeof payload.message.content !== "string") {
      throw new Error("Ollama returned an invalid chat response");
    }
    const parsed = EditorialResponseSchema.parse(JSON.parse(payload.message.content));
    const knownSignals = new Set(clusters.map((cluster) => cluster.signalId));
    const seen = new Set<string>();
    return parsed.ideas.filter((idea) => {
      if (!knownSignals.has(idea.signalId) || seen.has(idea.signalId)) return false;
      seen.add(idea.signalId);
      return true;
    });
  }
}

const EDITORIAL_SYSTEM_PROMPT = `你是 Token Talk 的中文播客选题总编。你的任务不是复述热搜，而是判断哪些信号能支撑一集真正值得听、值得讨论、值得追更的节目。

硬规则：
1. 只使用输入中的事实和数字，不虚构采访、数据、因果、引语或背景。
2. 热度不等于价值。纯明星琐事、单一软件发布、教程链接、名单和无冲突词条通常应 skip 或 research_first。
3. 优先选择存在真实利益冲突、判断分歧、制度变化、技术影响或生活选择的题目。
4. 标题必须是播客命题，不得只是复制热搜标题；centralQuestion 必须可由不同立场展开。
5. suggestedRoles 是本期认知角色，按题目动态选择 1–4 个；禁止默认双人主持，也不要使用固定人名。
6. 15–25 分钟用 rapid_brief；30 分钟以上且有足够分歧与资料空间才用 deep_discussion。60 分钟以上仍必须能拆成逐章推进、可独立审校的结构，不得用重复和铺垫凑时长。
7. 高风险公共事件若来源不足，只能 research_first 或 skip，不扩写未证实细节。
8. selectionReasons 解释为什么值得占用制作资源，不要重复热度。
9. 分数必须保守。没有跨平台证据时，audienceRelevance、conversationPotential、longformDepth 不得仅因排名超过 75。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname;
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]");
  } catch {
    return false;
  }
}
