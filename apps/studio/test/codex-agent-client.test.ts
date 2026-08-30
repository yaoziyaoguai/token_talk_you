import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_TALK_AGENT_PROTOCOL_VERSION, type AgentTaskRequest } from "@token-talk/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { UnixSocketCodexAgentClient } from "../src/server/codex-agent-client.js";

let root: string | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("UnixSocketCodexAgentClient", () => {
  it("uses the isolated broker socket and validates the structured response", async () => {
    root = await mkdtemp(join(tmpdir(), "token-talk-agent-client-"));
    const socketPath = join(root, "broker.sock");
    let received: unknown;
    server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requestId: "agent-topic-editor-001",
        output: { ideas: [] },
        trace: {
          taskKind: "topic-editor",
          promptVersion: "token-talk/topic-editor-v1",
          providerId: "openai-codex-subscription",
          modelId: "codex-test",
          reasoningEffort: "high",
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolve);
    });

    const client = new UnixSocketCodexAgentClient({ socketPath, environment: { TOKEN_TALK_CODEX_MODEL: "codex-test" } });
    const result = await client.run(topicEditorRequest(), new AbortController().signal);

    expect(client.isConfigured()).toBe(true);
    expect(received).toMatchObject({ protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION, requestId: "agent-topic-editor-001", kind: "topic-editor" });
    expect(result).toMatchObject({ output: { ideas: [] }, trace: { modelId: "codex-test", taskKind: "topic-editor" } });
  });

  it("does not fabricate a configured broker when no socket is supplied", async () => {
    const client = new UnixSocketCodexAgentClient({ environment: {} });
    expect(client.isConfigured()).toBe(false);
    await expect(client.run(topicEditorRequest(), new AbortController().signal)).rejects.toThrow("TOKEN_TALK_CODEX_SOCKET_PATH");
  });
});

function topicEditorRequest(): AgentTaskRequest {
  return {
    protocolVersion: TOKEN_TALK_AGENT_PROTOCOL_VERSION,
    requestId: "agent-topic-editor-001",
    kind: "topic-editor",
    payload: { signals: [{ title: "测试信号" }], series: [], editorialPolicy: "事实优先" },
  };
}
