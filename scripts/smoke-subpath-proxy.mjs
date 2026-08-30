import { createServer, request } from "node:http";

const upstream = new URL(process.env.TOKEN_TALK_PROXY_UPSTREAM ?? "http://127.0.0.1:4329");
const basePath = process.env.TOKEN_TALK_PROXY_BASE_PATH ?? "/token-talk/";
const port = Number.parseInt(process.env.TOKEN_TALK_PROXY_PORT ?? "4330", 10);

if (!basePath.startsWith("/") || !basePath.endsWith("/")) {
  throw new Error("TOKEN_TALK_PROXY_BASE_PATH must start and end with /");
}

const server = createServer((incoming, outgoing) => {
  const incomingUrl = new URL(incoming.url ?? "/", "http://localhost");
  if (!incomingUrl.pathname.startsWith(basePath)) {
    outgoing.writeHead(404).end();
    return;
  }

  const target = new URL(incomingUrl.pathname.slice(basePath.length - 1) || "/", upstream);
  target.search = incomingUrl.search;
  const proxy = request(target, {
    method: incoming.method,
    headers: { ...incoming.headers, host: upstream.host },
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  proxy.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error.message);
  });
  incoming.pipe(proxy);
});

server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
