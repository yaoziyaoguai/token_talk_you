import { CodexBrokerServer } from "./broker-server.js";
import { CodexTaskExecutor } from "./codex-executor.js";
import { loadBrokerRuntimeConfig } from "./runtime-config.js";

const config = loadBrokerRuntimeConfig();
const broker = new CodexBrokerServer({
  socketPath: config.socketPath,
  executor: new CodexTaskExecutor(config),
  concurrency: config.concurrency,
  maxBacklog: config.maxBacklog,
  idempotencyTtlMs: config.idempotencyTtlMs,
  modelId: config.model ?? "codex-default",
});

await broker.listen();
process.stdout.write(`token-talk-codex-broker listening on ${config.socketPath}\n`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await broker.close();
  process.exit(0);
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
