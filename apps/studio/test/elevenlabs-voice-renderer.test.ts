import { describe, expect, it, vi } from "vitest";
import {
  ElevenLabsRenderError,
  ElevenLabsVoiceRenderer,
  estimateElevenLabsCostCny,
} from "../src/server/elevenlabs-voice-renderer.js";

describe("ElevenLabsVoiceRenderer", () => {
  it("lists a bounded, sanitized account voice catalog", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: "voice_host_001", name: "Host", category: "cloned", description: "Warm", preview_url: "https://cdn.example.com/host.mp3", labels: { language: "zh", accent: "mandarin" } },
        { voice_id: "bad/id", name: "Invalid", preview_url: "http://unsafe.example.com/a.mp3" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const renderer = new ElevenLabsVoiceRenderer("secret-key", fetcher as typeof fetch);

    const voices = await renderer.listVoices(new AbortController().signal);
    const cachedVoices = await renderer.listVoices(new AbortController().signal);

    expect(fetcher).toHaveBeenCalledWith("https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false", expect.objectContaining({ method: "GET", redirect: "error" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(voices).toEqual([{ voiceId: "voice_host_001", name: "Host", category: "cloned", description: "Warm", previewUrl: "https://cdn.example.com/host.mp3", labels: { language: "zh", accent: "mandarin" } }]);
    expect(cachedVoices).toEqual(voices);
  });

  it("uses the fixed dialogue endpoint and splits long multi-role scripts below the provider limit", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "character-cost": "1900", "request-id": "request-safe" },
    }));
    const renderer = new ElevenLabsVoiceRenderer("secret-key", fetcher as typeof fetch);

    const result = await renderer.render([
      { speaker: "主持", text: "甲".repeat(1_300), voiceId: "voice_host_001" },
      { speaker: "嘉宾", text: "乙".repeat(1_300), voiceId: "voice_guest_002" },
    ], new AbortController().signal);

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("secret-key");
      const body = JSON.parse(String(init?.body)) as { model_id: string; inputs: Array<{ text: string; voice_id: string }> };
      expect(body.model_id).toBe("eleven_v3");
      expect(body.inputs.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(1_900);
    }
    expect(result.submittedCharacters).toBe(2_600);
    expect(result.providerCharacterCost).toBe(3_800);
    expect(result.audioChunks).toHaveLength(2);
    expect(result.requestIds).toEqual(["request-safe", "request-safe"]);
    expect(estimateElevenLabsCostCny(2_600)).toBe(1.87);
    expect(estimateElevenLabsCostCny(1)).toBe(0.01);
  });

  it("rejects invalid voice identifiers before making a paid request", async () => {
    const fetcher = vi.fn();
    const renderer = new ElevenLabsVoiceRenderer("secret-key", fetcher as typeof fetch);

    await expect(renderer.render([
      { speaker: "主持", text: "测试", voiceId: "bad/id" },
    ], new AbortController().signal)).rejects.toMatchObject({
      name: "ElevenLabsRenderError",
      submittedCharacters: 0,
      costKnown: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caps provider audio responses and records that accepted text may already be billed", async () => {
    const renderer = new ElevenLabsVoiceRenderer("secret-key", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": String(17 * 1024 * 1024) },
    })) as typeof fetch);

    const rejection = renderer.render([
      { speaker: "主持", text: "测试成本", voiceId: "voice_host_001" },
    ], new AbortController().signal);

    await expect(rejection).rejects.toEqual(expect.objectContaining<Partial<ElevenLabsRenderError>>({
      submittedCharacters: 4,
      costKnown: false,
    }));
  });

  it("marks network failures as unreconciled instead of silently retrying", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } }))
      .mockRejectedValueOnce(new Error("connection lost"));
    const renderer = new ElevenLabsVoiceRenderer("secret-key", fetcher as typeof fetch);
    const rejection = renderer.render([
      { speaker: "主持", text: "甲".repeat(1_300), voiceId: "voice_host_001" },
      { speaker: "嘉宾", text: "乙".repeat(1_300), voiceId: "voice_guest_002" },
    ], new AbortController().signal);

    await expect(rejection).rejects.toMatchObject({ submittedCharacters: 1_300, costKnown: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
