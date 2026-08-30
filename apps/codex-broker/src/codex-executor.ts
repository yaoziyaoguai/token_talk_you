import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  outputJsonSchemaFor,
  parseAgentTaskOutput,
  type AgentTrace,
  type AgentTaskRequest,
} from "@token-talk/agent-protocol";
import { buildTaskPrompt, promptVersionFor } from "./task-prompts.js";
import type { BrokerRuntimeConfig } from "./runtime-config.js";

const MAX_PROMPT_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

export interface BrokerExecutionResult {
  output: unknown;
  trace: AgentTrace;
}

export interface BrokerTaskExecutor {
  run(request: AgentTaskRequest, signal?: AbortSignal): Promise<BrokerExecutionResult>;
}

export class CodexTaskExecutor implements BrokerTaskExecutor {
  constructor(private readonly config: BrokerRuntimeConfig) {}

  async run(request: AgentTaskRequest, parentSignal?: AbortSignal): Promise<BrokerExecutionResult> {
    const prompt = buildTaskPrompt(request);
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error("Codex task prompt exceeds 3MB");
    await mkdir(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const taskRoot = await mkdtemp(join(this.config.workspaceRoot, "task-"));
    const workspace = join(taskRoot, "workspace");
    const schemaPath = join(taskRoot, "output-schema.json");
    const outputPath = join(taskRoot, "last-message.json");
    try {
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(schemaPath, JSON.stringify(outputJsonSchemaFor(request.kind)), { mode: 0o600, flag: "wx" });
      const effort = isAuditTask(request.kind) ? this.config.auditEffort : this.config.defaultEffort;
      const command = buildCodexExecCommand({
        codexBin: this.config.codexBin,
        workspace,
        schemaPath,
        outputPath,
        effort,
        ...(this.config.model ? { model: this.config.model } : {}),
      });
      await runCodex(
        command.command,
        command.args,
        prompt,
        this.config.timeoutMs,
        this.config.terminationGraceMs,
        parentSignal,
      );
      const output = JSON.parse(await readBoundedFile(outputPath, MAX_OUTPUT_BYTES, "Codex output")) as unknown;
      return {
        output: parseAgentTaskOutput(request.kind, output),
        trace: {
          taskKind: request.kind,
          promptVersion: promptVersionFor(request.kind),
          providerId: "openai-codex-subscription",
          modelId: this.config.model ?? "codex-default",
          reasoningEffort: effort,
        },
      };
    } finally {
      await rm(taskRoot, { recursive: true, force: true });
    }
  }
}

export function buildCodexExecCommand(input: {
  codexBin: string;
  workspace: string;
  schemaPath: string;
  outputPath: string;
  effort: BrokerRuntimeConfig["defaultEffort"];
  model?: string;
}): { command: string; args: string[] } {
  return {
    command: input.codexBin,
    args: [
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--skip-git-repo-check",
      "--cd", input.workspace,
      "--output-schema", input.schemaPath,
      "--output-last-message", input.outputPath,
      "--json",
      "--config", `model_reasoning_effort=${input.effort}`,
      ...(input.model ? ["--model", input.model] : []),
      "-",
    ],
  };
}

export function runCodex(
  command: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
  terminationGraceMs: number,
  parentSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env: safeCodexEnvironment(process.env),
      stdio: "pipe",
      detached: true,
    });
    let settled = false;
    let terminationError: Error | undefined;
    let diagnostics = "";
    let eventBuffer = "";
    let eventDiagnostic = "";
    let observedBytes = 0;
    let escalation: NodeJS.Timeout | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      parentSignal?.removeEventListener("abort", abort);
      operation();
    };
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const requestTermination = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      terminate("SIGTERM");
      escalation = setTimeout(() => terminate("SIGKILL"), terminationGraceMs);
      escalation.unref();
    };
    const abort = () => requestTermination(new Error("Codex task was cancelled"));
    const timeout = setTimeout(() => {
      requestTermination(new Error(`Codex task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      observedBytes += chunk.byteLength;
      if (observedBytes > MAX_OUTPUT_BYTES) {
        requestTermination(new Error("Codex event stream exceeded 5MB"));
      }
      eventBuffer += chunk.toString("utf8");
      const lines = eventBuffer.split("\n");
      eventBuffer = lines.pop()?.slice(-MAX_DIAGNOSTIC_BYTES) ?? "";
      for (const line of lines) eventDiagnostic = codexDiagnosticFromEvent(line) ?? eventDiagnostic;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostics.length < MAX_DIAGNOSTIC_BYTES) diagnostics += chunk.toString("utf8").slice(0, MAX_DIAGNOSTIC_BYTES - diagnostics.length);
    });
    child.once("error", (error) => finish(() => reject(new Error(`Could not start Codex: ${error.message}`))));
    child.once("exit", (code, signal) => finish(() => {
      eventDiagnostic = codexDiagnosticFromEvent(eventBuffer) ?? eventDiagnostic;
      if (terminationError) reject(terminationError);
      else if (code === 0) resolve();
      else {
        const detail = eventDiagnostic || diagnostics.trim();
        reject(new Error(`Codex exited with ${code ?? signal ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`));
      }
    }));
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(prompt);
  });
}

export function codexDiagnosticFromEvent(line: string): string | undefined {
  if (!line.trim()) return undefined;
  let event: unknown;
  try { event = JSON.parse(line); }
  catch { return undefined; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "turn.failed" && record.type !== "error") return undefined;
  const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const message = typeof nested?.message === "string"
    ? nested.message
    : typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : undefined;
  return message?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").slice(0, 1_000);
}

export function safeCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return Object.fromEntries(allowed.flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
}

async function readBoundedFile(path: string, maximumBytes: number, label: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size <= 0 || metadata.size > maximumBytes) throw new Error(`${label} has an invalid size`);
  return readFile(path, "utf8");
}

function isAuditTask(kind: AgentTaskRequest["kind"]): boolean {
  return kind === "research-audit" || kind === "script-audit";
}
