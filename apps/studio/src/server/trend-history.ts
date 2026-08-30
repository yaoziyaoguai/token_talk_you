import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RawTrendSignal, TrendFeed, TrendMomentum } from "./trend-gateway.js";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_COUNT = 2_016;
const SNAPSHOT_VERSION = 1;

const SnapshotSignalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourceId: z.string().min(1),
  sourceLabel: z.string().min(1),
  platform: z.string().min(1),
  url: z.string().url(),
  observedAt: z.string().datetime(),
  timeBasis: z.enum(["source", "collected"]).optional(),
  rank: z.number().int().positive(),
  heat: z.number().finite().optional(),
  discussionUrl: z.string().url().optional(),
});

const TrendSnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  fetchedAt: z.string().datetime(),
  signals: z.array(SnapshotSignalSchema).max(1_000),
  sources: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["ready", "degraded", "unavailable"]),
  })).max(100).optional(),
});

type TrendSnapshot = z.infer<typeof TrendSnapshotSchema>;

export class TrendHistoryStore {
  private readonly snapshotRoot: string;

  constructor(workspaceRoot: string) {
    this.snapshotRoot = join(workspaceRoot, "trends", "snapshots");
  }

  async capture(feed: TrendFeed): Promise<TrendFeed> {
    await mkdir(this.snapshotRoot, { recursive: true });
    const previous = await this.readLatestSnapshot();
    const signals = feed.signals.map((signal) => ({
      ...signal,
      momentum: movementFor(signal, previous),
    }));
    await this.persist({
      version: SNAPSHOT_VERSION,
      fetchedAt: feed.fetchedAt,
      signals: feed.signals.map(withoutMomentum),
      sources: feed.sources.map((source) => ({ id: source.id, status: source.status })),
    });
    return { ...feed, signals };
  }

  private async readLatestSnapshot(): Promise<TrendSnapshot | undefined> {
    const names = (await readdir(this.snapshotRoot))
      .filter((name) => /^snapshot-\d{13}-[a-f0-9]{10}\.json$/.test(name))
      .sort()
      .reverse();
    for (const name of names.slice(0, 20)) {
      const path = join(this.snapshotRoot, name);
      try {
        if ((await stat(path)).size > MAX_SNAPSHOT_BYTES) continue;
        return TrendSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        // 单个快照损坏不应让后续采集失去全部历史。
      }
    }
    return undefined;
  }

  private async persist(snapshot: TrendSnapshot): Promise<void> {
    const parsed = TrendSnapshotSchema.parse(snapshot);
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) throw new Error("trend snapshot exceeds 4MB limit");
    const timestamp = Date.parse(parsed.fetchedAt);
    if (!Number.isFinite(timestamp)) throw new Error("trend snapshot has invalid collection time");
    const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 10);
    const path = join(this.snapshotRoot, `snapshot-${timestamp}-${digest}.json`);
    try {
      await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await this.pruneOldSnapshots();
  }

  private async pruneOldSnapshots(): Promise<void> {
    const names = (await readdir(this.snapshotRoot))
      .filter((name) => /^snapshot-\d{13}-[a-f0-9]{10}\.json$/.test(name))
      .sort();
    const expired = names.slice(0, Math.max(0, names.length - MAX_SNAPSHOT_COUNT));
    await Promise.all(expired.map((name) => unlink(join(this.snapshotRoot, name))));
  }
}

function movementFor(signal: RawTrendSignal, previous: TrendSnapshot | undefined): TrendMomentum {
  if (!previous) return { state: "unknown" };
  const previousSignal = previous.signals
    .filter((item) => signalKey(item) === signalKey(signal))
    .sort((left, right) => left.rank - right.rank)[0];
  if (!previousSignal) {
    const previousSource = previous.sources?.find((source) => source.id === signal.sourceId);
    return previousSource?.status === "ready"
      ? { state: "new", comparedAt: previous.fetchedAt }
      : { state: "unknown", comparedAt: previous.fetchedAt };
  }
  const rankDelta = previousSignal.rank - signal.rank;
  const state = rankDelta >= 2 ? "rising" : rankDelta <= -2 ? "falling" : "steady";
  return { state, rankDelta, previousRank: previousSignal.rank, comparedAt: previous.fetchedAt };
}

function signalKey(signal: Pick<RawTrendSignal, "platform" | "title">): string {
  return `${signal.platform}:${signal.title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]/gu, "")}`;
}

function withoutMomentum(signal: RawTrendSignal): z.infer<typeof SnapshotSignalSchema> {
  const { momentum: _momentum, ...snapshotSignal } = signal;
  return SnapshotSignalSchema.parse(snapshotSignal);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
