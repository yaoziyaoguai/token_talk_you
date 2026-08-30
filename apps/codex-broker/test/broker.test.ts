import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_TALK_AGENT_PROTOCOL_VERSION, type AgentTaskRequest } from "@token-talk/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBrokerServer } from "../src/broker-server.js";
import { buildCodexExecCommand, codexDiagnosticFromEvent, type BrokerExecutionResult, type BrokerTaskExecutor } from "../src/codex-executor.js";
import { loadBrokerRuntimeConfig } from "../src/runtime-config.js";

let root: string | undefined;
let broker: CodexBrokerServer | undefined;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Token Talk Codex broker", () => {
  it("serves health, rejects malformed tasks, and executes an idempotent request once", async () => {
    root = await mkdtemp(join(tmpdir(), "token-talk-broker-"));
    const socketPath = join(root, "broker.sock");
    let resolveExecution: ((value: BrokerExecutionResult) => void) | undefined;
    const execution = new Promise<BrokerExecutionResult>((resolve) => { resolveExecution = resolve; });
    const executor: BrokerTaskExecutor = { run: vi.fn(() => execution) };
    broker = new CodexBrokerServer({ socketPath, executor, concurrency: 1, maxBacklog: 2, idempotencyTtlMs: 60_000, modelId: "codex-test" });
    await broker.listen();

    const health = await socketRequest(socketPath, "GET", "/health");
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION, capacity: 1, modelId: "codex-test" });

    const malformed = await socketRequest(socketPath, "POST", "/v1/tasks", { requestId: "too-short" });
    expect(malformed.statusCode).toBe(400);

    const task = topicEditorRequest("topic-editor-request-001");
    const first = socketRequest(socketPath, "POST", "/v1/tasks", task);
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalledTimes(1));
    const second = socketRequest(socketPath, "POST", "/v1/tasks", task);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executor.run).toHaveBeenCalledTimes(1);

    resolveExecution?.(successfulTopicResult());
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(JSON.parse(firstResponse.body)).toMatchObject({ ok: true, requestId: task.requestId, output: { ideas: [] } });
  });

  it("limits runtime settings and builds a read-only Codex command", () => {
    expect(() => loadBrokerRuntimeConfig({ TOKEN_TALK_CODEX_CONCURRENCY: "3" })).toThrow("TOKEN_TALK_CODEX_CONCURRENCY");
    expect(loadBrokerRuntimeConfig({ TOKEN_TALK_CODEX_EFFORT: "max", TOKEN_TALK_CODEX_AUDIT_EFFORT: "xhigh" })).toMatchObject({ defaultEffort: "max", auditEffort: "xhigh" });

    const command = buildCodexExecCommand({
      codexBin: "/usr/local/bin/codex",
      workspace: "/tmp/task/workspace",
      schemaPath: "/tmp/task/schema.json",
      outputPath: "/tmp/task/output.json",
      effort: "xhigh",
      model: "gpt-5.4",
    });
    expect(command).toMatchObject({ command: "/usr/local/bin/codex" });
    expect(command.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--disable", "shell_tool", "--disable", "unified_exec", "--model", "gpt-5.4"]));
    expect(command.args).not.toContain("danger-full-access");
  });

  it("returns a stable diagnostic code without exposing executor details", async () => {
    root = await mkdtemp(join(tmpdir(), "token-talk-broker-"));
    const socketPath = join(root, "broker.sock");
    const executor: BrokerTaskExecutor = {
      run: vi.fn(async () => { throw new Error("Codex exited with 1: private diagnostic"); }),
    };
    broker = new CodexBrokerServer({ socketPath, executor, concurrency: 1, maxBacklog: 2, idempotencyTtlMs: 60_000 });
    await broker.listen();

    const response = await socketRequest(socketPath, "POST", "/v1/tasks", topicEditorRequest("topic-editor-request-failure-001"));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(422);
    expect(body).toMatchObject({ error: "Agent task failed", errorCode: "codex_process_failed", detail: "Codex CLI 执行失败。" });
    expect(response.body).not.toContain("private diagnostic");
  });

  it("extracts only failure diagnostics from the Codex event stream", () => {
    expect(codexDiagnosticFromEvent(JSON.stringify({ type: "turn.failed", error: { message: "schema is invalid" } }))).toBe("schema is invalid");
    expect(codexDiagnosticFromEvent(JSON.stringify({ type: "error", message: "model unavailable" }))).toBe("model unavailable");
    expect(codexDiagnosticFromEvent(JSON.stringify({ type: "item.completed", item: { text: "private task content" } }))).toBeUndefined();
  });
});

function topicEditorRequest(requestId: string): AgentTaskRequest {
  return {
    protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION,
    requestId,
    kind: "topic-editor",
    payload: {
      signals: [{ title: "开源模型发布", source: "example" }],
      series: [],
      editorialPolicy: "事实优先",
    },
  };
}

function successfulTopicResult(): BrokerExecutionResult {
  return {
    output: { ideas: [] },
    trace: {
      taskKind: "topic-editor",
      promptVersion: "test-v1",
      providerId: "test-executor",
      modelId: "test-model",
      reasoningEffort: "high",
    },
  };
}

function socketRequest(socketPath: string, method: string, path: string, payload?: unknown): Promise<{ statusCode: number; body: string }> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path,
      ...(body ? { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(body);
  });
}
