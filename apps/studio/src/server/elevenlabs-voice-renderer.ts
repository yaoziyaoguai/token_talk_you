const ELEVENLABS_DIALOGUE_URL = "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128";
const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false";
const MAX_DIALOGUE_CHARACTERS = 1_900;
const MAX_AUDIO_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_TOTAL_BYTES = 128 * 1024 * 1024;
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface VoiceDialogueLine {
  speaker: string;
  text: string;
  voiceId: string;
}

export interface ElevenLabsRenderResult {
  audioChunks: Uint8Array[];
  submittedCharacters: number;
  providerCharacterCost?: number;
  requestIds: string[];
}

export interface ElevenLabsVoiceSummary {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  previewUrl?: string;
  labels: Record<string, string>;
}

export class ElevenLabsRenderError extends Error {
  constructor(
    message: string,
    readonly submittedCharacters: number,
    readonly costKnown: boolean,
    readonly providerCharacterCost?: number,
  ) {
    super(message);
    this.name = "ElevenLabsRenderError";
  }
}

export class ElevenLabsVoiceRenderer {
  private readonly fetchImpl: typeof fetch;
  private voiceCache?: { expiresAt: number; voices: ElevenLabsVoiceSummary[] };

  constructor(
    private readonly apiKey = process.env.ELEVENLABS_API_KEY,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.trim().length > 0;
  }

  async listVoices(signal: AbortSignal): Promise<ElevenLabsVoiceSummary[]> {
    if (!this.isConfigured()) return [];
    if (this.voiceCache && this.voiceCache.expiresAt > Date.now()) return this.voiceCache.voices;
    const response = await this.fetchImpl(ELEVENLABS_VOICES_URL, {
      method: "GET",
      redirect: "error",
      headers: { "xi-api-key": this.apiKey! },
      signal,
    });
    if (!response.ok) throw new Error(`ElevenLabs 音色目录返回 HTTP ${response.status}。`);
    const data = asRecord(await readBoundedJson(response, 2 * 1024 * 1024));
    const voices = asArray(data.voices).flatMap((item) => {
      const voice = asRecord(item);
      if (!isValidElevenLabsVoiceId(voice.voice_id) || typeof voice.name !== "string" || !voice.name.trim()) return [];
      const previewUrl = safeHttpsUrl(voice.preview_url);
      const labels = Object.fromEntries(Object.entries(asRecord(voice.labels)).flatMap(([key, value]) => {
        return typeof value === "string" && key.length <= 80 && value.length <= 160 ? [[key, value]] : [];
      }));
      return [{
        voiceId: voice.voice_id,
        name: voice.name.trim().slice(0, 160),
        ...(typeof voice.category === "string" ? { category: voice.category.slice(0, 80) } : {}),
        ...(typeof voice.description === "string" ? { description: voice.description.slice(0, 500) } : {}),
        ...(previewUrl ? { previewUrl } : {}),
        labels,
      }];
    }).slice(0, 100);
    this.voiceCache = { expiresAt: Date.now() + 5 * 60_000, voices };
    return voices;
  }

  async render(lines: VoiceDialogueLine[], signal: AbortSignal): Promise<ElevenLabsRenderResult> {
    if (!this.isConfigured()) throw new ElevenLabsRenderError("ElevenLabs API Key 尚未配置。", 0, true);
    const chunks = chunkDialogue(lines);
    if (chunks.length === 0) throw new ElevenLabsRenderError("脚本中没有可生成的台词。", 0, true);
    const audioChunks: Uint8Array[] = [];
    const requestIds: string[] = [];
    let submittedCharacters = 0;
    let providerCharacterCost = 0;
    let providerCostComplete = true;
    let totalBytes = 0;

    for (const inputs of chunks) {
      const characterCount = inputs.reduce((total, input) => total + input.text.length, 0);
      let response: Response;
      try {
        response = await this.fetchImpl(ELEVENLABS_DIALOGUE_URL, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "xi-api-key": this.apiKey!,
          },
          body: JSON.stringify({
            inputs: inputs.map((input) => ({ text: input.text, voice_id: input.voiceId })),
            model_id: "eleven_v3",
          }),
          signal,
        });
      } catch (error) {
        const message = signal.aborted ? "ElevenLabs 生成已取消。" : "ElevenLabs 请求未确认完成，需要核对服务端用量。";
        throw new ElevenLabsRenderError(message, submittedCharacters, false, providerCharacterCost || undefined);
      }
      const responseCharacterCost = parseNonnegativeNumber(response.headers.get("character-cost"));
      if (!response.ok) {
        const billed = responseCharacterCost === undefined ? undefined : providerCharacterCost + responseCharacterCost;
        throw new ElevenLabsRenderError(`ElevenLabs 返回 HTTP ${response.status}，需要核对配置与用量。`, submittedCharacters, responseCharacterCost !== undefined && providerCostComplete, billed);
      }
      submittedCharacters += characterCount;
      if (responseCharacterCost === undefined) providerCostComplete = false;
      else providerCharacterCost += responseCharacterCost;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
        throw new ElevenLabsRenderError("ElevenLabs 没有返回可识别的音频。", submittedCharacters, providerCostComplete, providerCostComplete ? providerCharacterCost : undefined);
      }
      const requestId = response.headers.get("request-id");
      if (requestId) requestIds.push(requestId.slice(0, 160));
      let audio: Uint8Array;
      try {
        audio = await readBoundedAudio(response, MAX_AUDIO_CHUNK_BYTES);
      } catch (error) {
        throw new ElevenLabsRenderError(
          error instanceof Error ? error.message : "ElevenLabs 音频响应无法读取。",
          submittedCharacters,
          providerCostComplete,
          providerCostComplete ? providerCharacterCost : undefined,
        );
      }
      totalBytes += audio.byteLength;
      if (totalBytes > MAX_AUDIO_TOTAL_BYTES) {
        throw new ElevenLabsRenderError("整集语音超过 128MB 安全上限，请缩短脚本或分集。", submittedCharacters, providerCostComplete, providerCostComplete ? providerCharacterCost : undefined);
      }
      audioChunks.push(audio);
    }

    return { audioChunks, submittedCharacters, ...(providerCostComplete ? { providerCharacterCost } : {}), requestIds };
  }
}

export function estimateElevenLabsCostCny(characters: number): number {
  if (characters <= 0) return 0;
  return Math.max(0.01, Math.round((characters / 1_000 * 0.1 * 7.2) * 100) / 100);
}

export function isValidElevenLabsVoiceId(value: unknown): value is string {
  return typeof value === "string" && VOICE_ID_PATTERN.test(value);
}

function chunkDialogue(lines: VoiceDialogueLine[]): VoiceDialogueLine[][] {
  const normalized = lines.flatMap((line) => {
    const text = line.text.trim();
    if (!text) return [];
    if (!isValidElevenLabsVoiceId(line.voiceId)) {
      throw new ElevenLabsRenderError(`角色“${line.speaker}”的 Voice ID 无效。`, 0, true);
    }
    return splitLongLine({ ...line, text });
  });
  const chunks: VoiceDialogueLine[][] = [];
  let current: VoiceDialogueLine[] = [];
  let currentCharacters = 0;
  for (const line of normalized) {
    if (current.length > 0 && currentCharacters + line.text.length > MAX_DIALOGUE_CHARACTERS) {
      chunks.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(line);
    currentCharacters += line.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitLongLine(line: VoiceDialogueLine): VoiceDialogueLine[] {
  const parts: VoiceDialogueLine[] = [];
  let remaining = line.text;
  while (remaining.length > MAX_DIALOGUE_CHARACTERS) {
    const window = remaining.slice(0, MAX_DIALOGUE_CHARACTERS);
    const minimumBreak = Math.floor(MAX_DIALOGUE_CHARACTERS * 0.55);
    const candidates = ["。", "！", "？", "；", "，", "\n", " "].map((token) => window.lastIndexOf(token));
    const bestBreak = Math.max(...candidates);
    const splitAt = bestBreak >= minimumBreak ? bestBreak + 1 : MAX_DIALOGUE_CHARACTERS;
    parts.push({ ...line, text: remaining.slice(0, splitAt).trim() });
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push({ ...line, text: remaining });
  return parts;
}

async function readBoundedAudio(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("单段语音超过 16MB 安全上限。 ");
  if (!response.body) throw new Error("ElevenLabs 返回了空音频。 ");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("单段语音超过 16MB 安全上限。 ");
    }
    chunks.push(chunk.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseNonnegativeNumber(value: string | null): number | undefined {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("ElevenLabs 音色目录响应过大。");
  if (!response.body) throw new Error("ElevenLabs 音色目录返回空响应。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("ElevenLabs 音色目录响应过大。");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
