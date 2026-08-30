import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const LOCK_HOLDER_SCRIPT = `
printf 'acquired\\n'
IFS= read -r _ || true
`;

export async function acquireWorkspaceLease(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const path = join(root, ".studio-server.lock");
  const command = workspaceLockCommand(path);
  await access(command.executable, constants.X_OK).catch(() => {
    throw new Error(`缺少工作区锁工具 ${command.executable}，不能安全启动 Studio。`);
  });
  const holder = await startLockHolder(command).catch(() => {
    throw new Error("这个 Token Talk 工作区已由另一个 Studio 进程打开。");
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holder.stdin.end("release\n");
    await waitForExit(holder);
  };
}

export function workspaceLockCommand(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  const executable = environment.LOCKF_PATH?.trim() || (platform === "linux" ? "/usr/bin/flock" : "/usr/bin/lockf");
  const args = basename(executable) === "flock"
    ? ["-n", path, "/bin/sh", "-c", LOCK_HOLDER_SCRIPT]
    : ["-s", "-t", "0", "-k", path, "/bin/sh", "-c", LOCK_HOLDER_SCRIPT];
  return { executable, args };
}

function startLockHolder(command: { executable: string; args: string[] }): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(command.executable, command.args);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("工作区锁工具响应超时。")));
    }, 2_000);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`工作区锁被占用（${code ?? "unknown"}）。`))));
    child.stdout.once("data", (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes("acquired")) return;
      finish(() => resolve(child));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
