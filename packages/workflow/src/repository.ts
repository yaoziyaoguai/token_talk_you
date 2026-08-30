import { randomUUID } from "node:crypto";
import { open as openFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  StudioSnapshotSchema,
  type StudioSnapshot,
} from "@token-talk/domain";
import { artifactDataSha256 } from "./run.js";

export class JsonStudioRepository {
  readonly #filePath: string;

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  static async open(
    root: string,
    seedFactory: () => StudioSnapshot,
  ): Promise<JsonStudioRepository> {
    await mkdir(root, { recursive: true });
    const filePath = join(root, "studio.json");

    const repository = new JsonStudioRepository(filePath);
    const release = await acquireFileLock(`${filePath}.lock`);
    try {
      try {
        await repository.#readSnapshot();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await repository.#persist(StudioSnapshotSchema.parse(seedFactory()));
      }
    } finally {
      await release();
    }
    return repository;
  }

  async load(): Promise<StudioSnapshot> {
    return this.#readSnapshot();
  }

  async save(snapshot: StudioSnapshot): Promise<void> {
    const requested = StudioSnapshotSchema.parse(snapshot);
    const release = await acquireFileLock(`${this.#filePath}.lock`);
    try {
      const current = await this.#readSnapshot();
      if (requested.revision !== current.revision) {
        throw new StudioRepositoryConflictError(
          `Studio snapshot revision ${requested.revision} is stale; current revision is ${current.revision}.`,
        );
      }
      await this.#persist(StudioSnapshotSchema.parse({ ...requested, revision: current.revision + 1 }));
    } finally {
      await release();
    }
  }

  async #persist(snapshot: StudioSnapshot): Promise<void> {
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await openFile(temporaryPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#filePath);
  }

  async #readSnapshot(): Promise<StudioSnapshot> {
    const stored = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
    return StudioSnapshotSchema.parse(migrateLegacyLongFormSnapshot(stored));
  }
}

export class StudioRepositoryConflictError extends Error {}

function migrateLegacyLongFormSnapshot(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = structuredClone(value) as Record<string, unknown>;
  for (const recipeValue of Array.isArray(snapshot.recipes) ? snapshot.recipes : []) {
    const recipe = asRecord(recipeValue);
    const range = asRecord(recipe.targetMinutes);
    const minimum = numeric(range.min);
    const maximum = numeric(range.max);
    if (minimum === undefined || maximum === undefined || minimum >= 15) continue;
    recipe.legacyTargetMinutes = { min: minimum, max: maximum };
    recipe.targetMinutes = recipe.contentProduct === "rapid"
      ? { min: 15, max: 25 }
      : { min: 15, max: Math.max(15, maximum) };
  }
  for (const opportunityValue of Array.isArray(snapshot.opportunities) ? snapshot.opportunities : []) {
    migrateCandidateRange(asRecord(asRecord(opportunityValue).candidate));
  }
  for (const runValue of Array.isArray(snapshot.runs) ? snapshot.runs : []) {
    const run = asRecord(runValue);
    migrateResearchFeedbackContract(run);
    migrateReleaseEditorialContract(run);
    const intent = asRecord(run.productionIntent);
    const targetMinutes = numeric(intent.targetMinutes);
    if (targetMinutes === undefined || targetMinutes >= 15) continue;
    intent.legacyTargetMinutes = targetMinutes;
    intent.targetMinutes = 15;
    if (run.status !== "completed" && run.status !== "release_ready") {
      run.status = "needs_human";
      const nodes = Array.isArray(run.nodes) ? run.nodes.map(asRecord) : [];
      const boundary = nodes.findIndex((node) => node.id === "episode-blueprint");
      if (boundary >= 0) {
        nodes.slice(boundary).forEach((node, index) => {
          node.status = index === 0 ? "stale" : "pending";
          node.staleReason = "旧版短节目已迁移到 15 分钟最低规格，需要重新确认蓝图";
        });
        const affectedNodeIds = new Set(nodes.slice(boundary).flatMap((node) => typeof node.id === "string" ? [node.id] : []));
        run.spendAuthorizations = (Array.isArray(run.spendAuthorizations) ? run.spendAuthorizations : [])
          .filter((authorization) => !affectedNodeIds.has(String(asRecord(authorization).nodeId ?? "")));
      }
    }
  }
  return snapshot;
}

function migrateReleaseEditorialContract(run: Record<string, unknown>): void {
  const publicationRecords = Array.isArray(run.publicationRecords) ? run.publicationRecords.map(asRecord) : [];
  if (run.status === "completed" || publicationRecords.some((record) => record.status === "published")) return;
  const createdAt = typeof run.updatedAt === "string" ? run.updatedAt : typeof run.createdAt === "string" ? run.createdAt : new Date(0).toISOString();
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts.map(asRecord) : [];
  let contractChanged = false;
  let releaseArtifact = artifacts.find((artifact) => artifact.id === "artifact-release-copy");
  if (!releaseArtifact) {
    const data = { status: "pending", showNotes: [], keywords: [] };
    releaseArtifact = {
      id: "artifact-release-copy",
      kind: "release.copy",
      activeVersionId: "artifact-release-copy-v1",
      versions: [{
        id: "artifact-release-copy-v1",
        createdAt,
        sha256: artifactDataSha256(data),
        source: "derived",
        data,
      }],
    };
    artifacts.push(releaseArtifact);
    run.artifacts = artifacts;
    contractChanged = true;
  }

  const nodes = Array.isArray(run.nodes) ? run.nodes.map(asRecord) : [];
  const scriptRepair = nodes.find((node) => node.id === "script-repair");
  if (!nodes.some((node) => node.id === "release-editorial")) {
    const inputArtifactIds = ["artifact-script", "artifact-blueprint", "artifact-sources"];
    const releaseNode = {
      id: "release-editorial",
      label: "标题、简介与 Show Notes",
      phase: "production",
      role: "发行编辑",
      capability: "release.copy",
      status: scriptRepair?.status === "succeeded" ? "ready" : "pending",
      inputArtifactIds,
      inputVersionIds: inputArtifactIds.flatMap((artifactId) => {
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        return typeof artifact?.activeVersionId === "string" ? [artifact.activeVersionId] : [];
      }),
      outputArtifactIds: ["artifact-release-copy"],
      prerequisiteNodeIds: ["script-repair"],
      estimatedCostCny: 0,
    };
    const insertion = nodes.findIndex((node) => node.id === "script-repair");
    nodes.splice(insertion >= 0 ? insertion + 1 : nodes.length, 0, releaseNode);
    run.nodes = nodes;
    contractChanged = true;
  }

  const publish = nodes.find((node) => node.id === "publish-package");
  if (!publish) return;
  const publishInputs = Array.isArray(publish.inputArtifactIds) ? publish.inputArtifactIds.filter((value): value is string => typeof value === "string") : [];
  if (!publishInputs.includes("artifact-release-copy")) {
    publish.inputArtifactIds = [...publishInputs, "artifact-release-copy"];
    contractChanged = true;
  }
  const prerequisites = Array.isArray(publish.prerequisiteNodeIds) ? publish.prerequisiteNodeIds.filter((value): value is string => typeof value === "string") : [];
  if (!prerequisites.includes("release-editorial")) {
    publish.prerequisiteNodeIds = [...prerequisites, "release-editorial"];
    contractChanged = true;
  }
  if (contractChanged && publish.status === "succeeded") {
    publish.status = "stale";
    publish.staleReason = "发行文案工作流已升级，需要补齐标题、摘要与 Show Notes";
    run.status = "active";
  }
}

function migrateResearchFeedbackContract(run: Record<string, unknown>): void {
  const nodes = Array.isArray(run.nodes) ? run.nodes.map(asRecord) : [];
  const claimNode = nodes.find((node) => node.id === "claim-ledger");
  if (!claimNode) return;
  const inputs = Array.isArray(claimNode.inputArtifactIds)
    ? claimNode.inputArtifactIds.filter((value): value is string => typeof value === "string")
    : [];
  if (inputs.includes("artifact-research-plan")) return;
  claimNode.inputArtifactIds = ["artifact-research-plan", ...inputs];
  const inputVersions = Array.isArray(claimNode.inputVersionIds)
    ? claimNode.inputVersionIds.filter((value): value is string => typeof value === "string")
    : [];
  const plan = (Array.isArray(run.artifacts) ? run.artifacts : [])
    .map(asRecord).find((artifact) => artifact.id === "artifact-research-plan");
  const activeVersionId = typeof plan?.activeVersionId === "string" ? plan.activeVersionId : undefined;
  claimNode.inputVersionIds = activeVersionId ? [activeVersionId, ...inputVersions] : inputVersions;
}

function migrateCandidateRange(candidate: Record<string, unknown>): void {
  const range = asRecord(candidate.targetMinutes);
  const minimum = numeric(range.min);
  const maximum = numeric(range.max);
  if (minimum === undefined || maximum === undefined || minimum >= 15) return;
  candidate.legacyTargetMinutes = { min: minimum, max: maximum };
  candidate.targetMinutes = { min: 15, max: Math.max(25, maximum) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const handle = await openFile(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      await handle.sync();
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(20);
    }
  }
  throw new Error("Studio workspace is busy; could not acquire the repository write lock.");
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const [contents, metadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const pid = Number.parseInt(contents.trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) return !processIsAlive(pid);
    return Date.now() - metadata.mtimeMs > 30_000;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
