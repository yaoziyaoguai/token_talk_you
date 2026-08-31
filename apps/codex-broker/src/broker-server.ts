import http from "node:http";
import net from "node:net";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AgentTaskKindSchema,
  TOKEN_TALK_AGENT_PROTOCOL_VERSION,
  parseAgentTaskRequest,
  type AgentTaskRequest,
} from "@token-talk/agent-protocol";
import type { BrokerExecutionResult, BrokerTaskExecutor } from "./codex-executor.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;

interface Submission {
  result: Promise<BrokerExecutionResult>;
  cancel(): void;
}

interface QueueItem {
  request: AgentTaskRequest;
  controller: AbortController;
  resolve: (value: BrokerExecutionResult) => void;
  reject: (error: unknown) => void;
  state: "queued" | "running" | "settled";
}

interface IdempotencyRecord {
  item: QueueItem;
  result: Promise<BrokerExecutionResult>;
  subscribers: number;
  expiresAt: number;
}

export class CodexBrokerServer {
  private readonly server: http.Server;
  private readonly queue: QueueItem[] = [];
  private readonly activeControllers = new Set<AbortController>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private active = 0;
  private completed = 0;
  private failed = 0;
  private accepting = true;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly options: {
    socketPath: string;
    executor: BrokerTaskExecutor;
    concurrency: number;
    maxBacklog: number;
    idempotencyTtlMs: number;
    providerId?: string;
    modelId?: string;
  }) {
    this.server = http.createServer((request, response) => void this.handle(request, response));
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o660);
  }

  async close(): Promise<void> {
    this.accepting = false;
    for (const item of this.queue.splice(0)) {
      item.state = "settled";
      item.controller.abort();
      item.reject(new Error("Broker is shutting down"));
    }
    for (const controller of this.activeControllers) controller.abort();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  health(): Record<string, unknown> {
    return {
      protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION,
      providerId: this.options.providerId ?? "openai-codex-subscription",
      modelId: this.options.modelId ?? "codex-default",
      taskKinds: AgentTaskKindSchema.options,
      active: this.active,
      queued: this.queue.length,
      capacity: this.options.concurrency,
      completed: this.completed,
      failed: this.failed,
      startedAt: this.startedAt,
    };
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") return this.send(response, 200, this.health());
      if (request.method !== "POST" || request.url !== "/v1/tasks") return this.send(response, 404, { error: "Not found" });
      if (!this.accepting) return this.send(response, 503, { error: "Broker is shutting down" });
      const body = await readBody(request);
      if (body === undefined) return this.send(response, 413, { error: "Task request exceeds 3MB" });
      let task: AgentTaskRequest;
      try { task = parseAgentTaskRequest(JSON.parse(body)); }
      catch { return this.send(response, 400, { error: "Invalid Agent task request" }); }
      const submission = this.submit(task);
      if (!submission) return this.send(response, 503, { error: "Agent task backlog is full" }, 5);
      const cancel = () => { if (!response.writableEnded) submission.cancel(); };
      response.once("close", cancel);
      try {
        const result = await submission.result;
        response.off("close", cancel);
        return this.send(response, 200, { ok: true, requestId: task.requestId, ...result });
      } catch (error) {
        response.off("close", cancel);
        const failure = classifyTaskFailure(error);
        process.stderr.write(`[token-talk-codex-broker] ${task.requestId} ${failure.code}: ${failure.diagnostic}\n`);
        return this.send(response, 422, {
          error: "Agent task failed",
          errorCode: failure.code,
          detail: failure.detail,
          requestId: task.requestId,
        });
      }
    } catch {
      return this.send(response, 500, { error: "Internal broker error" });
    }
  }

  private submit(request: AgentTaskRequest): Submission | undefined {
    this.pruneIdempotency();
    const existing = this.idempotency.get(request.requestId);
    if (existing) return this.subscribe(existing);
    if (this.active >= this.options.concurrency && this.queue.length >= this.options.maxBacklog) return undefined;
    const controller = new AbortController();
    let item: QueueItem;
    const result = new Promise<BrokerExecutionResult>((resolve, reject) => {
      item = { request, controller, resolve, reject, state: "queued" };
      this.queue.push(item);
      this.drain();
    });
    const record: IdempotencyRecord = {
      item: item!,
      result,
      subscribers: 0,
      expiresAt: Date.now() + this.options.idempotencyTtlMs,
    };
    this.idempotency.set(request.requestId, record);
    void result.finally(() => {
      record.item.state = "settled";
      record.expiresAt = Date.now() + this.options.idempotencyTtlMs;
    }).catch(() => undefined);
    return this.subscribe(record);
  }

  private subscribe(record: IdempotencyRecord): Submission {
    record.subscribers += 1;
    let released = false;
    return {
      result: record.result,
      cancel: () => {
        if (released || record.item.state === "settled") return;
        released = true;
        record.subscribers = Math.max(0, record.subscribers - 1);
        if (record.subscribers > 0) return;
        if (record.item.state === "queued") {
          const index = this.queue.indexOf(record.item);
          if (index >= 0) this.queue.splice(index, 1);
          record.item.state = "settled";
          record.item.reject(new Error("Agent task was cancelled before execution"));
          return;
        }
        record.item.controller.abort();
      },
    };
  }

  private pruneIdempotency(): void {
    const now = Date.now();
    for (const [requestId, record] of this.idempotency) {
      if (record.item.state === "settled" && record.expiresAt <= now) this.idempotency.delete(requestId);
    }
  }

  private drain(): void {
    while (this.active < this.options.concurrency) {
      const item = this.queue.shift();
      if (!item) return;
      this.active += 1;
      item.state = "running";
      this.activeControllers.add(item.controller);
      void this.options.executor.run(item.request, item.controller.signal).then((result) => {
        this.completed += 1;
        item.resolve(result);
      }, (error) => {
        this.failed += 1;
        item.reject(error);
      }).finally(() => {
        item.state = "settled";
        this.activeControllers.delete(item.controller);
        this.active -= 1;
        this.drain();
      });
    }
  }

  private send(response: http.ServerResponse, status: number, value: unknown, retryAfter?: number): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
    });
    response.end(body);
  }
}

function classifyTaskFailure(error: unknown): { code: string; detail: string; diagnostic: string } {
  const message = safeDiagnostic(error);
  if (message.includes("timed out")) return { code: "task_timeout", detail: "Codex 任务超过运行时限。", diagnostic: message };
  if (message.includes("cancelled")) return { code: "task_cancelled", detail: "Codex 任务已取消。", diagnostic: message };
  if (message.includes("Could not start Codex")) return { code: "codex_unavailable", detail: "Codex CLI 无法启动。", diagnostic: message };
  if (message.includes("Codex exited with")) return { code: "codex_process_failed", detail: "Codex CLI 执行失败。", diagnostic: message };
  if (message.includes("JSON") || message.includes("parse") || message.includes("invalid size") || message.includes("validation")) {
    return { code: "invalid_agent_output", detail: "Codex 输出没有通过结构校验。", diagnostic: message };
  }
  return { code: "agent_execution_failed", detail: "Codex 任务没有完成。", diagnostic: message };
}

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : "Unknown broker task error")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    return undefined;
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) overflow = true;
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(overflow ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isSocket()) throw new Error(`Refusing to replace non-socket path '${path}'`);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (await socketReachable(path)) throw new Error(`Another Token Talk broker is listening on '${path}'`);
  await unlink(path);
}

function socketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
