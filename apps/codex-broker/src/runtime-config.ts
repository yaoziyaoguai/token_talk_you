export interface BrokerRuntimeConfig {
  socketPath: string;
  workspaceRoot: string;
  codexBin: string;
  model?: string;
  defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
  auditEffort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  terminationGraceMs: number;
  concurrency: number;
  maxBacklog: number;
  idempotencyTtlMs: number;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function loadBrokerRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): BrokerRuntimeConfig {
  const defaultEffort = text(environment, "TOKEN_TALK_CODEX_EFFORT") ?? "high";
  const auditEffort = text(environment, "TOKEN_TALK_CODEX_AUDIT_EFFORT") ?? "xhigh";
  if (!EFFORTS.has(defaultEffort) || !EFFORTS.has(auditEffort)) throw new Error("Codex effort must be low|medium|high|xhigh|max");
  return {
    socketPath: text(environment, "TOKEN_TALK_CODEX_SOCKET_PATH") ?? "/run/token-talk-codex/worker.sock",
    workspaceRoot: text(environment, "TOKEN_TALK_CODEX_WORKSPACE_ROOT") ?? "/var/lib/token-talk-codex/workspace",
    codexBin: text(environment, "CODEX_BIN") ?? "codex",
    ...(text(environment, "TOKEN_TALK_CODEX_MODEL") ? { model: text(environment, "TOKEN_TALK_CODEX_MODEL")! } : {}),
    defaultEffort: defaultEffort as BrokerRuntimeConfig["defaultEffort"],
    auditEffort: auditEffort as BrokerRuntimeConfig["auditEffort"],
    timeoutMs: integer(environment, "TOKEN_TALK_CODEX_TIMEOUT_MS", 720_000, 10_000, 900_000),
    terminationGraceMs: integer(environment, "TOKEN_TALK_CODEX_TERMINATION_GRACE_MS", 2_000, 250, 10_000),
    concurrency: integer(environment, "TOKEN_TALK_CODEX_CONCURRENCY", 1, 1, 2),
    maxBacklog: integer(environment, "TOKEN_TALK_CODEX_MAX_BACKLOG", 20, 1, 100),
    idempotencyTtlMs: integer(environment, "TOKEN_TALK_CODEX_IDEMPOTENCY_TTL_MS", 600_000, 60_000, 3_600_000),
  };
}

function text(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value || undefined;
}

function integer(environment: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = text(environment, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
