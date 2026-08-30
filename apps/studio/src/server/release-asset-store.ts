import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  RegisterCoverMetadataSchema,
  RegisterReleaseMasterMetadataSchema,
  type RegisterCoverMetadata,
  type RegisterReleaseMasterMetadata,
} from "../shared/api.js";

const execFile = promisify(execFileCallback);
const MAX_RELEASE_MASTER_BYTES = 256 * 1024 * 1024;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const MAX_RELEASE_LIBRARY_BYTES = 4 * 1024 * 1024 * 1024;
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";

export class ReleaseAssetInputError extends Error {}

export interface StoredReleaseAsset {
  data: Record<string, unknown>;
  cleanup: () => Promise<void>;
}

export interface AudioLoudnessQc {
  integratedLoudnessLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
  loudnessMeasuredWith: "ffmpeg-loudnorm-ebu-r128";
}

export class ReleaseAssetStore {
  private readonly mediaRoot: string;

  constructor(
    workspaceRoot: string,
    private readonly now: () => string,
    private readonly measureLoudness: (filePath: string, signal?: AbortSignal) => Promise<AudioLoudnessQc> = probeAudioLoudness,
  ) {
    this.mediaRoot = join(workspaceRoot, "media", "release-assets");
  }

  async addMaster(buffer: Buffer, rawMetadata: RegisterReleaseMasterMetadata, signal?: AbortSignal): Promise<StoredReleaseAsset> {
    if (buffer.byteLength > MAX_RELEASE_MASTER_BYTES) throw new ReleaseAssetInputError("发行母带不能超过 256MB。");
    const metadata = RegisterReleaseMasterMetadataSchema.parse(rawMetadata);
    const format = detectAudioFormat(buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const stored = await this.writeAsset(`master-${sha256}`, format.extension, buffer);
    try {
      const probe = await probeMedia(stored.filePath, signal);
      const durationSeconds = Number(probe.format?.duration);
      const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !audioStream) {
        throw new ReleaseAssetInputError("发行母带无法解码或没有有效音轨。");
      }
      const audioQc = await probeAudioLevels(stored.filePath, signal);
      if (audioQc.meanVolumeDb <= -55 || audioQc.maxVolumeDb <= -40) {
        throw new ReleaseAssetInputError("发行母带接近全程静音或电平过低，请检查导出文件。");
      }
      // 极短占位文件会在带节目目标的服务层被拒绝；避免 loudnorm 先吞掉更准确的错误。
      const loudnessQc = durationSeconds >= 3 ? await this.measureLoudness(stored.filePath, signal) : {};
      const contentQc = await probeAudioContent(stored.filePath, durationSeconds, signal);
      if (
        contentQc.spectralEntropyMean < 0.06
        || contentQc.spectralFluxMean < 0.001
        || contentQc.spectralFlatnessMean > 0.7
      ) {
        throw new ReleaseAssetInputError("发行母带疑似固定测试音、噪声或占位内容，请上传真实节目导出文件。");
      }
      const registeredAt = this.now();
      return {
        data: {
          status: "release_master",
          mediaUrl: stored.mediaUrl,
          mimeType: format.mimeType,
          bytes: buffer.byteLength,
          sha256,
          durationSeconds,
          audioQc: {
            ...audioQc,
            ...loudnessQc,
            ...contentQc,
            codecName: audioStream.codec_name,
            sampleRate: numericValue(audioStream.sample_rate),
            channels: numericValue(audioStream.channels),
            bitRate: numericValue(audioStream.bit_rate ?? probe.format?.bit_rate),
          },
          releaseReady: true,
          rights: {
            owner: metadata.rightsOwner,
            basis: metadata.licenseBasis,
            commercialUseConfirmed: true,
            voiceConsentConfirmed: true,
            musicRightsConfirmed: true,
            ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
            confirmedAt: registeredAt,
          },
          registeredAt,
        },
        cleanup: stored.cleanup,
      };
    } catch (error) {
      await stored.cleanup();
      if (error instanceof ReleaseAssetInputError) throw error;
      throw new ReleaseAssetInputError("发行母带无法解码或格式不受支持。");
    }
  }

  async addCover(buffer: Buffer, rawMetadata: RegisterCoverMetadata, signal?: AbortSignal): Promise<StoredReleaseAsset> {
    if (buffer.byteLength > MAX_COVER_BYTES) throw new ReleaseAssetInputError("单集封面不能超过 20MB。");
    const metadata = RegisterCoverMetadataSchema.parse(rawMetadata);
    const format = detectImageFormat(buffer);
    if (format.extension === "png" && pngHasTransparency(buffer)) {
      throw new ReleaseAssetInputError("单集封面不能包含透明通道，请导出为不透明 JPG 或 PNG。");
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const id = `cover-${sha256}`;
    const stored = await this.writeAsset(id, format.extension, buffer);
    try {
      const probe = await probeMedia(stored.filePath, signal);
      const stream = probe.streams?.find((candidate) => candidate.codec_type === "video");
      const width = Number(stream?.width);
      const height = Number(stream?.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new ReleaseAssetInputError("单集封面无法解码。");
      }
      if (width !== height) throw new ReleaseAssetInputError("单集封面必须是正方形。");
      if (width < 1400 || width > 3000) throw new ReleaseAssetInputError("单集封面尺寸必须在 1400×1400 到 3000×3000 之间。");
      if (hasAlphaChannel(stream?.pix_fmt)) throw new ReleaseAssetInputError("单集封面不能包含透明通道，请导出为不透明 JPG 或 PNG。");
      const registeredAt = this.now();
      return {
        data: {
          id,
          mediaUrl: stored.mediaUrl,
          mimeType: format.mimeType,
          bytes: buffer.byteLength,
          sha256,
          width,
          height,
          altText: metadata.altText,
          rights: {
            owner: metadata.rightsOwner,
            basis: metadata.licenseBasis,
            commercialUseConfirmed: true,
            ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
            confirmedAt: registeredAt,
          },
          registeredAt,
        },
        cleanup: stored.cleanup,
      };
    } catch (error) {
      await stored.cleanup();
      if (error instanceof ReleaseAssetInputError) throw error;
      throw new ReleaseAssetInputError("单集封面无法解码或格式不受支持。");
    }
  }

  private async writeAsset(id: string, extension: string, buffer: Buffer): Promise<{ filePath: string; mediaUrl: string; cleanup: () => Promise<void> }> {
    await mkdir(this.mediaRoot, { recursive: true });
    const filename = `${id}.${extension}`;
    const filePath = join(this.mediaRoot, filename);
    let created = false;
    try {
      await stat(filePath);
    } catch {
      const usedBytes = await directoryBytes(this.mediaRoot);
      if (usedBytes + buffer.byteLength > MAX_RELEASE_LIBRARY_BYTES) {
        throw new ReleaseAssetInputError("发行素材库已达到 4GB 上限，请先清理不再使用的旧素材。");
      }
      try {
        await writeFile(filePath, buffer, { flag: "wx" });
        created = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    return {
      filePath,
      mediaUrl: `/media/release-assets/${encodeURIComponent(filename)}`,
      cleanup: async () => {
        if (created) await unlink(filePath).catch(() => undefined);
      },
    };
  }
}

async function directoryBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true });
  const sizes = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => (await stat(join(root, entry.name))).size));
  return sizes.reduce((total, size) => total + size, 0);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function detectAudioFormat(buffer: Buffer): { extension: "mp3" | "wav" | "m4a"; mimeType: "audio/mpeg" | "audio/wav" | "audio/mp4" } {
  if (buffer.byteLength < 12) throw new ReleaseAssetInputError("发行母带过小或格式不可识别。");
  if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) return { extension: "mp3", mimeType: "audio/mpeg" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return { extension: "wav", mimeType: "audio/wav" };
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return { extension: "m4a", mimeType: "audio/mp4" };
  throw new ReleaseAssetInputError("发行母带只支持 MP3、WAV 或 M4A。");
}

function detectImageFormat(buffer: Buffer): { extension: "png" | "jpg"; mimeType: "image/png" | "image/jpeg" } {
  if (buffer.byteLength >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mimeType: "image/png" };
  if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: "jpg", mimeType: "image/jpeg" };
  throw new ReleaseAssetInputError("单集封面只支持 JPG 或 PNG。");
}

interface MediaProbe {
  format?: { duration?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
  }>;
}

async function probeMedia(filePath: string, signal?: AbortSignal): Promise<MediaProbe> {
  const { stdout } = await execFile(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=duration,bit_rate:stream=codec_type,codec_name,sample_rate,channels,bit_rate,width,height,pix_fmt",
    "-of", "json",
    filePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024, signal });
  return JSON.parse(stdout) as MediaProbe;
}

async function probeAudioLevels(filePath: string, signal?: AbortSignal): Promise<{ meanVolumeDb: number; maxVolumeDb: number; measuredWith: "ffmpeg-volumedetect" }> {
  const { stderr } = await execFile(FFMPEG_PATH, [
    "-hide_banner", "-nostats", "-i", filePath,
    "-af", "volumedetect", "-f", "null", "-",
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal });
  const meanVolumeDb = parseVolume(stderr, "mean_volume");
  const maxVolumeDb = parseVolume(stderr, "max_volume");
  if (meanVolumeDb === undefined || maxVolumeDb === undefined) {
    throw new ReleaseAssetInputError("无法完成发行母带电平检测。");
  }
  return { meanVolumeDb, maxVolumeDb, measuredWith: "ffmpeg-volumedetect" };
}

async function probeAudioLoudness(filePath: string, signal?: AbortSignal): Promise<AudioLoudnessQc> {
  const { stderr } = await execFile(FFMPEG_PATH, [
    "-hide_banner", "-nostats", "-i", filePath,
    "-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
    "-f", "null", "-",
  ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, signal });
  const reportText = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
  if (!reportText) throw new ReleaseAssetInputError("无法完成发行母带响度检测。");
  const report = JSON.parse(reportText) as Record<string, unknown>;
  const integratedLoudnessLufs = numericValue(report.input_i);
  const truePeakDbtp = numericValue(report.input_tp);
  const loudnessRangeLu = numericValue(report.input_lra);
  if (integratedLoudnessLufs === undefined || truePeakDbtp === undefined || loudnessRangeLu === undefined) {
    throw new ReleaseAssetInputError("无法完成发行母带响度检测。");
  }
  return { integratedLoudnessLufs, truePeakDbtp, loudnessRangeLu, loudnessMeasuredWith: "ffmpeg-loudnorm-ebu-r128" };
}

async function probeAudioContent(filePath: string, durationSeconds: number, signal?: AbortSignal): Promise<{
  spectralEntropyMean: number;
  spectralFluxMean: number;
  spectralFlatnessMean: number;
  sampledSeconds: number;
  contentMeasuredWith: "ffmpeg-aspectralstats";
}> {
  const sampleDuration = Math.min(20, durationSeconds);
  const starts = [...new Set([
    0,
    Math.max(0, durationSeconds / 2 - sampleDuration / 2),
    Math.max(0, durationSeconds - sampleDuration),
  ].map((value) => Math.round(value * 1_000) / 1_000))];
  const outputs = await Promise.all(starts.map(async (start) => {
    const { stderr } = await execFile(FFMPEG_PATH, [
      "-hide_banner", "-nostats",
      "-ss", String(start), "-t", String(sampleDuration),
      "-i", filePath,
      "-af", "aspectralstats=win_size=1024:measure=entropy+flux+flatness,ametadata=print",
      "-f", "null", "-",
    ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal });
    return stderr;
  }));
  const output = outputs.join("\n");
  const entropy = parseSpectralValues(output, "entropy");
  const flux = parseSpectralValues(output, "flux");
  const flatness = parseSpectralValues(output, "flatness");
  if (!entropy.length || !flux.length || !flatness.length) {
    throw new ReleaseAssetInputError("无法完成发行母带内容有效性检测。");
  }
  return {
    spectralEntropyMean: mean(entropy),
    spectralFluxMean: mean(flux),
    spectralFlatnessMean: mean(flatness),
    sampledSeconds: sampleDuration * starts.length,
    contentMeasuredWith: "ffmpeg-aspectralstats",
  };
}

function parseVolume(output: string, label: "mean_volume" | "max_volume"): number | undefined {
  const value = output.match(new RegExp(`${label}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?) dB`, "i"))?.[1];
  if (!value) return undefined;
  return value.toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(value);
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSpectralValues(output: string, metric: "entropy" | "flux" | "flatness"): number[] {
  const pattern = new RegExp(`lavfi\\.aspectralstats\\.\\d+\\.${metric}=([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?)`, "gi");
  return [...output.matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite);
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function hasAlphaChannel(pixelFormat: string | undefined): boolean {
  return typeof pixelFormat === "string" && /^(?:rgba|bgra|argb|abgr|ya|yuva)/.test(pixelFormat);
}

function pngHasTransparency(buffer: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.byteLength) return false;
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IHDR" && length >= 10 && [4, 6].includes(buffer[dataStart + 9]!)) return true;
    if (type === "tRNS") return true;
    if (type === "IEND") return false;
    offset = dataEnd + 4;
  }
  return false;
}
