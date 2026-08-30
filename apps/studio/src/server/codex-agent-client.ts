import http from "node:http";
import {
  AgentTaskSuccessSchema,
  type AgentTaskRequest,
  type AgentTrace,
} from "@token-talk/agent-protocol";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface CodexAgentClient {
  readonly providerId: string;
  readonly modelId: string;
  isConfigured(): boolean;
  run(request: AgentTaskRequest, signal: AbortSignal): Promise<{ output: unknown; trace: AgentTrace }>;
}

export interface UnixSocketCodexAgentClientOptions {
  socketPath?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class UnixSocketCodexAgentClient implements CodexAgentClient {
  readonly providerId = "openai-codex-subscription";
  readonly modelId: string;
  private readonly socketPath: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: UnixSocketCodexAgentClientOptions = {}) {
    const environment = options.environment ?? process.env;
    this.socketPath = options.socketPath?.trim() || environment.TOKEN_TALK_CODEX_SOCKET_PATH?.trim();
    this.modelId = environment.TOKEN_TALK_CODEX_MODEL?.trim() || "codex-default";
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  isConfigured(): boolean {
    return Boolean(this.socketPath);
  }

  async run(request: AgentTaskRequest, signal: AbortSignal): Promise<{ output: unknown; trace: AgentTrace }> {
    if (!this.socketPath) throw new Error("Token Talk Codex Broker 未配置 TOKEN_TALK_CODEX_SOCKET_PATH。");
    const payload = JSON.stringify(request);
    const response = await requestOverSocket(this.socketPath, payload, this.timeoutMs, signal);
    const parsed = parseResponse(response.statusCode, response.body);
    if (parsed.requestId !== request.requestId) throw new Error("Token Talk Codex Broker 返回了不匹配的任务结果。");
    return { output: parsed.output, trace: parsed.trace };
  }
}

function requestOverSocket(
  socketPath: string,
  body: string,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
      operation();
    };
    const request = http.request({
      socketPath,
      method: "POST",
      path: "/v1/tasks",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error("Token Talk Codex Broker 响应超过 5MB。"));
        else chunks.push(chunk);
      });
      response.once("end", () => finish(() => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      })));
      response.once("error", (error) => finish(() => reject(error)));
    });
    const abort = () => request.destroy(parentSignal.reason instanceof Error ? parentSignal.reason : new Error("Codex Agent 请求已取消。"));
    const timeout = setTimeout(() => request.destroy(new Error(`Token Talk Codex Broker 在 ${timeoutMs}ms 内没有响应。`)), timeoutMs);
    timeout.unref();
    request.once("error", (error) => finish(() => reject(error)));
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
    request.end(body);
  });
}

function parseResponse(statusCode: number, body: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Token Talk Codex Broker 返回了无效响应（HTTP ${statusCode}）。`);
  }
  if (statusCode < 200 || statusCode >= 300) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "任务未完成";
    const code = payload && typeof payload === "object" && "errorCode" in payload && typeof payload.errorCode === "string"
      ? payload.errorCode
      : "unknown_error";
    const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
      ? payload.detail
      : "";
    throw new Error(`Token Talk Codex Broker：${message} [${code}]${detail ? ` ${detail}` : ""}`);
  }
  return AgentTaskSuccessSchema.parse(payload);
}
