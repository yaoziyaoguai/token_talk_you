import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createStudioServer } from "./create-server.js";

const port = Number.parseInt(process.env.PORT ?? "4311", 10);
const host = process.env.HOST ?? "127.0.0.1";
const publicOrigin = process.env.TOKEN_TALK_PUBLIC_ORIGIN?.trim() || undefined;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (!loopbackHosts.has(host) && (process.env.TOKEN_TALK_CONTAINER_BIND !== "1" || !publicOrigin)) {
  throw new Error("Non-loopback binding requires TOKEN_TALK_CONTAINER_BIND=1 and an explicit TOKEN_TALK_PUBLIC_ORIGIN.");
}
const workspaceRoot = resolve(process.env.TOKEN_TALK_WORKSPACE ?? "workspace");
const bundledClientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
const clientRoot = process.env.TOKEN_TALK_CLIENT_ROOT
  ? resolve(process.env.TOKEN_TALK_CLIENT_ROOT)
  : process.env.NODE_ENV === "production" ? bundledClientRoot : undefined;
const app = await createStudioServer({
  workspaceRoot,
  ...(publicOrigin ? { publicOrigin } : {}),
  ...(clientRoot ? { clientRoot } : {}),
});

await app.listen({ port, host });
process.stdout.write(`Token Talk Studio listening at http://${host}:${port}\n`);
