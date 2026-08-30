import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
  AddMusicAssetMetadataSchema,
  MusicAssetSchema,
  MusicLibrarySchema,
  type AddMusicAssetMetadata,
  type MusicAsset,
  type MusicLibrary,
} from "../shared/api.js";

const execFile = promisify(execFileCallback);
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export class MusicLibraryInputError extends Error {}

export class MusicLibraryStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly manifestPath: string;
  private readonly mediaRoot: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => string,
  ) {
    this.manifestPath = join(workspaceRoot, "music", "library.json");
    this.mediaRoot = join(workspaceRoot, "media", "music-library");
  }

  async list(): Promise<MusicLibrary> {
    try {
      const raw = await readFile(this.manifestPath);
      if (raw.byteLength > MAX_MANIFEST_BYTES) throw new Error("音乐素材清单超过 2MB 安全上限。");
      return MusicLibrarySchema.parse(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (isMissingFile(error)) return { assets: [] };
      throw error;
    }
  }

  async add(buffer: Buffer, rawMetadata: AddMusicAssetMetadata, signal?: AbortSignal): Promise<MusicAsset> {
    return this.withMutationLock(async () => {
      const metadata = AddMusicAssetMetadataSchema.parse(rawMetadata);
      const format = detectAudioFormat(buffer);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const current = await this.list();
      const existing = current.assets.find((asset) => asset.sha256 === sha256);
      if (existing) return existing;
      await mkdir(this.mediaRoot, { recursive: true });
      await mkdir(join(this.workspaceRoot, "music"), { recursive: true });
      const id = `music-${randomUUID()}`;
      const filename = `${id}.${format.extension}`;
      const filePath = join(this.mediaRoot, filename);
      await writeFile(filePath, buffer, { flag: "wx" });
      try {
        const addedAt = this.now();
        const asset = MusicAssetSchema.parse({
          id,
          title: metadata.title,
          mediaUrl: `/media/music-library/${encodeURIComponent(filename)}`,
          mimeType: format.mimeType,
          bytes: buffer.byteLength,
          sha256,
          durationSeconds: await readDurationSeconds(filePath, signal),
          mood: metadata.mood,
          energy: metadata.energy,
          ...(typeof metadata.bpm === "number" ? { bpm: metadata.bpm } : {}),
          tags: (metadata.tags ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
          license: {
            basis: metadata.licenseBasis,
            commercialUseConfirmed: true,
            ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
            confirmedAt: addedAt,
          },
          addedAt,
        });
        const next = MusicLibrarySchema.parse({ assets: [asset, ...current.assets] });
        await writeManifest(this.manifestPath, next);
        return asset;
      } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
      }
    });
  }

  async resolveAssetPath(assetId: string): Promise<string | undefined> {
    const asset = (await this.list()).assets.find((candidate) => candidate.id === assetId);
    if (!asset) return undefined;
    return join(this.mediaRoot, basename(decodeURIComponent(asset.mediaUrl)));
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function detectAudioFormat(buffer: Buffer): { extension: "mp3" | "wav" | "m4a"; mimeType: MusicAsset["mimeType"] } {
  if (buffer.byteLength < 12) throw new MusicLibraryInputError("音频文件过小或格式不可识别。");
  if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) {
    return { extension: "mp3", mimeType: "audio/mpeg" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
    return { extension: "wav", mimeType: "audio/wav" };
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return { extension: "m4a", mimeType: "audio/mp4" };
  }
  throw new MusicLibraryInputError("只支持 MP3、WAV 或 M4A 音频。");
}

async function readDurationSeconds(filePath: string, signal?: AbortSignal): Promise<number> {
  try {
    const { stdout } = await execFile(process.env.FFPROBE_PATH ?? "ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { timeout: 10_000, signal });
    const durationSeconds = Number(stdout.trim());
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) return durationSeconds;
  } catch {
    // 统一在下方返回输入错误，避免把不可解码素材带入付费混音节点。
  }
  throw new MusicLibraryInputError("音频无法解码或没有有效时长。");
}

async function writeManifest(path: string, library: MusicLibrary): Promise<void> {
  const serialized = JSON.stringify(library, null, 2);
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error("音乐素材清单超过 2MB 安全上限。");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
