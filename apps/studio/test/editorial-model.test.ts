import { describe, expect, it, vi } from "vitest";
import { OllamaPodcastEditorialModel } from "../src/server/editorial-model.js";

const cluster = {
  signalId: "signal-one",
  sourceTitle: "高校试点人工智能助教",
  relatedTitles: [],
  platforms: ["微博"],
  bestRank: 1,
  signalCount: 1,
};

function validResponse(url = "http://127.0.0.1:11434/api/chat"): Response {
  const response = new Response(JSON.stringify({
    message: {
      content: JSON.stringify({
        ideas: [{
          signalId: "signal-one",
          title: "AI 助教改变了什么？",
          hook: "先看它如何影响学习。",
          whyNow: "高校正在试点。",
          centralQuestion: "AI 助教改善学习了吗？",
          listenerPromise: "分清工具与教学效果。",
          selectionReasons: ["影响学习方式"],
          suggestedRoles: ["教育观察者"],
          verdict: "rapid_brief",
          audienceRelevance: 70,
          conversationPotential: 70,
          longformDepth: 65,
          seriesFit: 60,
        }],
      }),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("OllamaPodcastEditorialModel privacy boundary", () => {
  it("disables redirects for loopback editorial requests", async () => {
    const fetcher = vi.fn(async () => validResponse()) as unknown as typeof fetch;
    const model = new OllamaPodcastEditorialModel({ fetcher, environment: {}, timeoutMs: 1_000 });

    await model.generate([cluster]);

    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:11434/api/chat", expect.objectContaining({ redirect: "error" }));
  });

  it("rejects a response that crossed the configured loopback origin", async () => {
    const fetcher = vi.fn(async () => validResponse("https://remote.example/capture")) as unknown as typeof fetch;
    const model = new OllamaPodcastEditorialModel({ fetcher, environment: {}, timeoutMs: 1_000 });

    await expect(model.generate([cluster])).rejects.toThrow("crossed the configured loopback origin");
  });

  it("rejects an oversized local model response before buffering it", async () => {
    const fetcher = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    const model = new OllamaPodcastEditorialModel({ fetcher, environment: {}, timeoutMs: 1_000 });

    await expect(model.generate([cluster])).rejects.toThrow("exceeds 4194304 bytes");
  });
});
