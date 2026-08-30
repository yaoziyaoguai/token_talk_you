import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Artifact, WorkflowRun } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";
import { ReleasePackageSchema } from "../shared/api.js";
import {
  ElevenLabsRenderError,
  ElevenLabsVoiceRenderer,
  estimateElevenLabsCostCny,
  isValidElevenLabsVoiceId,
  type ElevenLabsRenderResult,
  type VoiceDialogueLine,
} from "./elevenlabs-voice-renderer.js";
import type { NodeExecutionContext, NodeExecutionPlan, NodeExecutor, NodePlanningContext } from "./node-executor.js";
import { reviewResearchPacket } from "./research-ledger.js";
import { MusicLibraryStore } from "./music-library.js";

const execFile = promisify(execFileCallback);
const CHINESE_PREVIEW_VOICES = [
  "Tingting",
  "Eddy (中文（中国大陆）)",
  "Flo (中文（中国大陆）)",
  "Reed (中文（中国大陆）)",
];
const TABLE_READ_SPEECH_RATE = "132";

export class LocalProductionExecutor implements NodeExecutor {
  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => string,
    private readonly elevenLabs: Pick<ElevenLabsVoiceRenderer, "isConfigured" | "render"> & Partial<Pick<ElevenLabsVoiceRenderer, "listVoices">> = new ElevenLabsVoiceRenderer(),
    private readonly musicLibrary: Pick<MusicLibraryStore, "list" | "resolveAssetPath"> = new MusicLibraryStore(workspaceRoot, now),
  ) {}

  plan(context: NodePlanningContext): NodeExecutionPlan {
    const externalVoice = this.externalVoicePlan(context.run, context.node.capability);
    if (externalVoice) return externalVoice;
    return {
      providerId: "local-production-engine",
      modelId: context.node.capability,
      billing: "local_compute",
      estimatedCostCny: 0,
      timeoutMs: 120_000,
    };
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    const startedAt = this.now();
    const plan = this.plan(context);
    const result = await this.runCapability(context);
    return {
      ...result,
      billing: plan.billing,
      estimatedCostCny: plan.estimatedCostCny,
      ...(result.actualCostCny !== undefined
        ? { actualCostCny: result.actualCostCny }
        : plan.billing === "metered" ? {} : { actualCostCny: 0 }),
      startedAt,
      finishedAt: this.now(),
    };
  }

  async discard(context: Omit<NodeExecutionContext, "signal">, _outcome: NodeExecutionOutcome): Promise<void> {
    const mediaDirectory = join(this.workspaceRoot, "media", safeFileSegment(context.run.id));
    const renderId = safeFileSegment(context.attemptId);
    await Promise.all([
      rm(this.stagingDirectory(context.run.id, context.attemptId), { recursive: true, force: true }),
      rm(join(mediaDirectory, `table-read-${renderId}.m4a`), { force: true }),
      rm(join(mediaDirectory, `voice-render-${renderId}.mp3`), { force: true }),
    ]);
  }

  async commit(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<NodeExecutionOutcome> {
    if (context.node.capability !== "audio.render" || outcome.status !== "succeeded") return outcome;
    const stage = this.stagingDirectory(context.run.id, context.attemptId);
    const mediaDirectory = join(this.workspaceRoot, "media", safeFileSegment(context.run.id));
    const renderId = safeFileSegment(context.attemptId);
    const filenames = [`table-read-${renderId}.m4a`, `voice-render-${renderId}.mp3`];
    const moved: string[] = [];
    await mkdir(mediaDirectory, { recursive: true });
    try {
      let committed = false;
      for (const filename of filenames) {
        const source = join(stage, filename);
        const target = join(mediaDirectory, filename);
        try {
          await rename(source, target);
          moved.push(target);
          committed = true;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      if (!committed) throw new Error("音频执行成功但私有暂存区没有可提交的媒体文件。");
      await rm(stage, { recursive: true, force: true });
      return outcome;
    } catch (error) {
      await Promise.all(moved.map((path) => rm(path, { force: true })));
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  private stagingDirectory(runId: string, attemptId: string): string {
    return join(this.workspaceRoot, ".studio-staging", safeFileSegment(runId), safeFileSegment(attemptId));
  }

  private externalVoicePlan(run: WorkflowRun, capability: string): NodeExecutionPlan | undefined {
    if (capability !== "audio.render") return undefined;
    const voicePlan = asRecord(activeArtifactData(run, "artifact-voices"));
    if (!voicePlanReady(voicePlan)) return undefined;
    const selections = asArray(voicePlan.selections).map(asRecord);
    const lines = collectScriptLines(run);
    if (!scriptSpeakersBelongToCast(run, lines) || !musicCuePlanReady(run)) return undefined;
    if (!selections.every((selection) =>
      selection.providerId === "elevenlabs-v3" && isValidElevenLabsVoiceId(selection.voiceId),
    )) return undefined;
    const canUsePaidRendering = this.elevenLabs.isConfigured() && voiceSelectionsExactlyMatch(lines, selections);
    const characters = lines.reduce((total, line) => total + line.text.length, 0);
    return {
      providerId: "elevenlabs-v3",
      modelId: "eleven_v3",
      billing: canUsePaidRendering ? "metered" : "local_compute",
      estimatedCostCny: canUsePaidRendering ? estimateElevenLabsCostCny(characters) : 0,
      timeoutMs: 15 * 60_000,
    };
  }

  private async runCapability(context: NodeExecutionContext): Promise<ExecutionDraft> {
    const { run, node } = context;
    switch (node.capability) {
      case "research.search":
        return researchPacket(run, node.outputArtifactIds[0]);
      case "research.claims":
        return claimLedger(run, node.outputArtifactIds[0]);
      case "research.audit":
        return researchAudit(run, node.outputArtifactIds[0]);
      case "cast.plan":
        return castPlan(run, node.outputArtifactIds[0]);
      case "episode.blueprint":
        return episodeBlueprint(run, node.outputArtifactIds[0]);
      case "audio.emotional-arc":
        return emotionalArc(run, node.outputArtifactIds[0]);
      case "script.segment":
        return scriptSegment(run, node.outputArtifactIds[0], context.input?.segmentId);
      case "script.assemble":
        return assembleScript(run, node.outputArtifactIds[0]);
      case "script.audit":
        return scriptAudit(run, node.outputArtifactIds[0]);
      case "script.repair":
        return scriptRepair(run, node.outputArtifactIds[0]);
      case "voice.synthesize":
        return this.confirmVoiceCasting(run, node.outputArtifactIds[0], context.signal);
      case "music.plan":
        return this.planMusic(run, node.outputArtifactIds[0]);
      case "audio.render":
        return this.renderTableRead(run, node.outputArtifactIds[0], context.signal, context.attemptId);
      case "audio.audit":
        return audioAudit(run, node.outputArtifactIds[0]);
      case "image.generate":
        return visualBrief(run, node.outputArtifactIds[0]);
      case "release.copy":
        return releaseCopy(run, node.outputArtifactIds[0]);
      case "publish.package":
        return publishPackage(run, node.outputArtifactIds[0]);
      default:
        throw new Error(`当前本地执行器不支持“${node.label}”（${node.capability}）。`);
    }
  }

  private async confirmVoiceCasting(run: WorkflowRun, artifactId: string | undefined, signal: AbortSignal): Promise<ExecutionDraft> {
    const current = asRecord(activeArtifactData(run, "artifact-voices"));
    const selections = asArray(current.selections).map(asRecord);
    const usesElevenLabs = selections.some((selection) => selection.providerId === "elevenlabs-v3");
    let allowedVoiceIds: Set<string> | undefined;
    let catalogError: string | undefined;
    if (usesElevenLabs) {
      try {
        if (!this.elevenLabs.isConfigured() || !this.elevenLabs.listVoices) throw new Error("ElevenLabs 音色目录尚未接通。");
        allowedVoiceIds = new Set((await this.elevenLabs.listVoices(signal)).map((voice) => voice.voiceId));
        if (selections.some((selection) => typeof selection.voiceId !== "string" || !allowedVoiceIds?.has(selection.voiceId))) {
          catalogError = "声音方案包含账户中不存在或已移除的 ElevenLabs 音色，请重新选择。";
        }
      } catch (error) {
        catalogError = error instanceof Error ? error.message : "ElevenLabs 音色目录暂不可用。";
      }
    }
    return voiceCasting(run, artifactId, allowedVoiceIds, catalogError, this.now());
  }

  private async renderTableRead(
    run: WorkflowRun,
    artifactId: string | undefined,
    signal: AbortSignal,
    attemptId: string,
  ): Promise<ExecutionDraft> {
    if (!artifactId) throw new Error("音频节点没有输出产物。 ");
    const lines = collectScriptLines(run);
    if (lines.length === 0) {
      return blocked("local-macos-say", "table-read-v1", artifactId, {
        status: "needs_script",
        message: "脚本中还没有可朗读的台词，请先完成或人工编辑脚本。",
      }, "脚本中还没有可朗读的台词，请先完成或人工编辑脚本。");
    }

    const voicePlan = asRecord(activeArtifactData(run, "artifact-voices"));
    if (!voicePlanReady(voicePlan)) {
      return failure("local-production-engine", "voice-plan-required-v1", "声音方案尚未生成，请重新运行声音编排。");
    }
    const selections = asArray(voicePlan.selections).map(asRecord);
    if (!scriptSpeakersBelongToCast(run, lines)) {
      return failure("local-production-engine", "cast-plan-required-v1", "脚本包含本期角色方案之外的说话人，请先返修脚本或更新角色方案。");
    }
    if (!voiceSelectionsExactlyMatch(lines, selections)) {
      return failure("local-production-engine", "voice-map-required-v1", "脚本角色与声音方案不一致，请重新运行声音编排。");
    }
    if (!musicCuePlanReady(run)) {
      return failure("local-production-engine", "music-cue-plan-required-v1", "配乐方案尚未生成，请重新运行配乐与留白。");
    }
    const externalProviders = [...new Set(selections.flatMap((selection) =>
      typeof selection.providerId === "string" && selection.providerId !== "local-macos-say" ? [selection.providerId] : [],
    ))];
    if (externalProviders.length > 0) {
      const allElevenLabs = selections.length > 0 && selections.every((selection) =>
        selection.providerId === "elevenlabs-v3" && isValidElevenLabsVoiceId(selection.voiceId),
      );
      if (externalProviders.length === 1 && externalProviders[0] === "elevenlabs-v3" && allElevenLabs && this.elevenLabs.isConfigured()) {
        const invalidVoice = await this.invalidElevenLabsVoice(selections, signal);
        if (invalidVoice) {
          return { ...failure("elevenlabs-v3", "voice-catalog-gate-v1", invalidVoice), actualCostCny: 0 };
        }
        return this.renderElevenLabs(run, artifactId, lines, selections, signal, attemptId);
      }
      return failure(
        "local-production-engine",
        "external-voice-adapter-required-v1",
        externalProviders.includes("elevenlabs-v3")
          ? allElevenLabs ? "ElevenLabs 声音已选择，但服务端尚未配置 ELEVENLABS_API_KEY。" : "同一次生成必须为所有角色填写有效的 ElevenLabs Voice ID，暂不支持混用本地与外部声音。"
          : "已保存外部声音选择；当前版本尚未接通对应的服务适配器。",
      );
    }

    const runFolder = safeFileSegment(run.id);
    const renderId = safeFileSegment(attemptId);
    const stagingDirectory = this.stagingDirectory(run.id, attemptId);
    const temporaryDirectory = join(stagingDirectory, "work");
    const outputName = `table-read-${renderId}.m4a`;
    const outputPath = join(stagingDirectory, outputName);
    const dryPath = join(temporaryDirectory, "dry-table-read.m4a");
    await mkdir(temporaryDirectory, { recursive: true });
    const speakers = [...new Set(lines.map((line) => line.speaker ?? "旁白"))];
    const selectedVoices = new Map(selections.flatMap((selection) =>
      typeof selection.role === "string" && typeof selection.voiceId === "string"
        ? [[selection.role, selection.voiceId] as const]
        : [],
    ));
    const voiceMap = Object.fromEntries(speakers.map((speaker, index) => [
      speaker,
      selectedVoices.get(speaker) ?? CHINESE_PREVIEW_VOICES[index % CHINESE_PREVIEW_VOICES.length],
    ]));

    try {
      const timelineFiles: string[] = [];
      const pauseFiles = new Map<number, string>();
      for (const [index, line] of lines.entries()) {
        const linePath = join(temporaryDirectory, `line-${String(index).padStart(3, "0")}.aiff`);
        timelineFiles.push(linePath);
        await execFile("/usr/bin/say", [
          "-v",
          voiceMap[line.speaker ?? "旁白"] ?? CHINESE_PREVIEW_VOICES[0] ?? "Tingting",
          "-r",
          TABLE_READ_SPEECH_RATE,
          "-o",
          linePath,
          line.text,
        ], { signal });
        const pauseAfterMs = Math.max(0, Math.min(10_000, line.pauseAfterMs ?? 0));
        if (pauseAfterMs > 0) {
          let pausePath = pauseFiles.get(pauseAfterMs);
          if (!pausePath) {
            pausePath = join(temporaryDirectory, `pause-${pauseAfterMs}.aiff`);
            await execFile("/opt/homebrew/bin/ffmpeg", [
              "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
              "-t", (pauseAfterMs / 1_000).toFixed(3), "-c:a", "pcm_s16be", pausePath,
            ], { signal });
            pauseFiles.set(pauseAfterMs, pausePath);
          }
          timelineFiles.push(pausePath);
        }
      }
      const manifestPath = join(temporaryDirectory, "concat.txt");
      await writeFile(manifestPath, timelineFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
      await execFile("/opt/homebrew/bin/ffmpeg", [
        "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifestPath,
        "-c:a", "aac", "-b:a", "128k", dryPath,
      ], { signal });
      const mix = await this.applyMusicCueMix(run, dryPath, outputPath, signal);
      const durationSeconds = await probeAudioDuration(outputPath);
      const sha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
      const targetMinutes = run.productionIntent?.targetMinutes ?? 30;
      return success("local-macos-say", "table-read-v1", {
        [artifactId]: {
          status: "preview_ready",
          previewKind: "local_table_read",
          mediaUrl: `/media/${encodeURIComponent(runFolder)}/${encodeURIComponent(basename(outputPath))}`,
          lineCount: lines.length,
          durationSeconds: Math.round(durationSeconds * 100) / 100,
          targetMinutes,
          sha256,
          voiceMap,
          mixedAssetIds: mix.mixedAssetIds,
          releaseReady: false,
          note: "零现金桌读，仅用于检查节奏、错字和结构；正式发行前必须重新选角、混音并完成授权检查。",
        },
      });
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : "本地语音工具执行失败";
      throw new Error(`无法生成本地桌读：${message}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async invalidElevenLabsVoice(selections: Array<Record<string, unknown>>, signal: AbortSignal): Promise<string | undefined> {
    if (!this.elevenLabs.listVoices) return "无法读取 ElevenLabs 账户音色目录，请重新连接后确认声音方案。";
    try {
      const allowed = new Set((await this.elevenLabs.listVoices(signal)).map((voice) => voice.voiceId));
      const missing = selections.find((selection) => typeof selection.voiceId !== "string" || !allowed.has(selection.voiceId));
      return missing ? "声音方案包含账户中不存在或已移除的 ElevenLabs 音色，请重新选择。" : undefined;
    } catch (error) {
      return error instanceof Error ? `无法复核 ElevenLabs 音色目录：${error.message}` : "无法复核 ElevenLabs 音色目录。";
    }
  }

  private async renderElevenLabs(
    run: WorkflowRun,
    artifactId: string,
    lines: Array<{ speaker?: string; text: string }>,
    selections: Array<Record<string, unknown>>,
    signal: AbortSignal,
    attemptId: string,
  ): Promise<ExecutionDraft> {
    const voiceMap = new Map(selections.flatMap((selection) =>
      typeof selection.role === "string" && typeof selection.voiceId === "string"
        ? [[selection.role, selection.voiceId] as const]
        : [],
    ));
    if (!voiceSelectionsExactlyMatch(lines, selections)) {
      return blocked("elevenlabs-v3", "eleven_v3", artifactId, {
        status: "needs_voice_id",
        message: "脚本角色与声音方案不一致，请先为每个实际说话角色选择已授权音色。",
      }, "脚本角色与声音方案不一致，请先为每个实际说话角色选择已授权音色。");
    }
    const dialogue: VoiceDialogueLine[] = lines.map((line) => ({
      speaker: line.speaker ?? "旁白",
      text: line.text,
      voiceId: voiceMap.get(line.speaker ?? "旁白")!,
    }));
    let rendered: ElevenLabsRenderResult;
    try {
      rendered = await this.elevenLabs.render(dialogue, signal);
    } catch (error) {
      if (error instanceof ElevenLabsRenderError) {
        return {
          status: "failed",
          providerId: "elevenlabs-v3",
          modelId: "eleven_v3",
          outputs: {},
          ...(error.costKnown && error.providerCharacterCost !== undefined ? { actualCostCny: estimateElevenLabsCostCny(error.providerCharacterCost) } : {}),
          errorMessage: error.message,
        };
      }
      throw error;
    }

    const runFolder = safeFileSegment(run.id);
    const renderId = safeFileSegment(attemptId);
    const stagingDirectory = this.stagingDirectory(run.id, attemptId);
    const temporaryDirectory = join(stagingDirectory, "work");
    const outputName = `voice-render-${renderId}.mp3`;
    const outputPath = join(stagingDirectory, outputName);
    const dryPath = join(temporaryDirectory, "dry-voice-render.mp3");
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      if (rendered.audioChunks.length === 1) {
        const audio = rendered.audioChunks[0];
        if (!audio) throw new Error("ElevenLabs 没有返回音频分块。");
        await writeFile(dryPath, audio);
      } else {
        const chunkFiles: string[] = [];
        for (const [index, audio] of rendered.audioChunks.entries()) {
          const chunkPath = join(temporaryDirectory, `dialogue-${String(index).padStart(3, "0")}.mp3`);
          await writeFile(chunkPath, audio);
          chunkFiles.push(chunkPath);
        }
        const manifestPath = join(temporaryDirectory, "concat.txt");
        await writeFile(manifestPath, chunkFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
        await execFile("/opt/homebrew/bin/ffmpeg", [
          "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifestPath,
          "-c:a", "copy", dryPath,
        ], { signal });
      }
      const mix = await this.applyMusicCueMix(run, dryPath, outputPath, signal);
      return {
        status: "succeeded",
        providerId: "elevenlabs-v3",
        modelId: "eleven_v3",
        ...(rendered.providerCharacterCost !== undefined ? { actualCostCny: estimateElevenLabsCostCny(rendered.providerCharacterCost) } : {}),
        outputs: {
          [artifactId]: {
            status: "preview_ready",
            previewKind: "external_voice_render",
            mediaUrl: `/media/${encodeURIComponent(runFolder)}/${encodeURIComponent(basename(outputPath))}`,
            lineCount: lines.length,
            submittedCharacters: rendered.submittedCharacters,
            providerCharacterCost: rendered.providerCharacterCost,
            requestIds: rendered.requestIds,
            mixedAssetIds: mix.mixedAssetIds,
            releaseReady: false,
            rightsState: "pending_automated_audit",
            note: "已生成多角色声音轨；发行前仍需完成响度、自动成片审计与声音权利核验。",
          },
        },
      };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : "音频文件合并失败";
      return {
        status: "failed",
        providerId: "elevenlabs-v3",
        modelId: "eleven_v3",
        outputs: {},
        ...(rendered.providerCharacterCost !== undefined ? { actualCostCny: estimateElevenLabsCostCny(rendered.providerCharacterCost) } : {}),
        errorMessage: `语音已生成并计费，但本地音频整理失败：${message}`,
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async planMusic(run: WorkflowRun, artifactId: string | undefined): Promise<ExecutionDraft> {
    if (!artifactId) throw new Error("配乐节点没有输出产物。");
    const script = collectScriptLines(run);
    if (script.length === 0) return failure("music-director", "licensed-cues-v1", "配乐方案缺少脚本输入，请先完成脚本制作。");
    const library = await this.musicLibrary.list();
    const current = asRecord(activeArtifactData(run, artifactId));
    const currentCues = asArray(current.cues).map(asRecord);
    const selectedAssetIds = currentCues.flatMap((cue) => {
      const selection = asRecord(cue.selection);
      return selection.action === "asset" && typeof selection.assetId === "string" ? [selection.assetId] : [];
    });
    const validConfirmation = current.confirmed === true
      && ["ready", "confirmed"].includes(String(current.status))
      && currentCues.length > 0
      && currentCues.every((cue) => {
        const selection = asRecord(cue.selection);
        return selection.action === "silence"
          || (selection.action === "asset" && typeof selection.assetId === "string" && library.assets.some((asset) => asset.id === selection.assetId));
      });
    if (validConfirmation) {
      return success("music-director", "licensed-cues-v1", {
        [artifactId]: { ...current, selectedAssetIds: [...new Set(selectedAssetIds)] },
      });
    }

    const policy = run.productionIntent?.musicPolicy ?? "minimal";
    const defaultCueDefinitions = [
      { id: "opening", label: "开场", targetMood: "curious", targetEnergy: 1, durationSeconds: 0, purpose: "第一句话先建立信任，默认干声" },
      { id: "first-transition", label: "第一次转场", targetMood: "neutral", targetEnergy: policy === "immersive" ? 3 : 2, durationSeconds: 4, purpose: "只标记结构变化，不替观点制造情绪" },
      { id: "closing", label: "结尾余味", targetMood: "reflective", targetEnergy: 1, durationSeconds: 7, purpose: "结论说完后再进入，不遮盖最后一句" },
    ] as const;
    const generatedBy = asRecord(current.generatedBy);
    const agentDirected = generatedBy.taskKind === "music-plan" && currentCues.length > 0;
    const cueDefinitions = agentDirected ? currentCues.map((cue, index) => {
      const action = typeof cue.action === "string" ? cue.action : "silence";
      return {
        ...cue,
        id: typeof cue.id === "string" ? cue.id : `cue-${index + 1}`,
        label: `${typeof cue.segmentId === "string" ? cue.segmentId : `段落 ${index + 1}`} · ${musicActionLabel(action)}`,
        targetMood: typeof cue.mood === "string" ? cue.mood : "neutral",
        targetEnergy: Math.max(0, Math.min(5, numberValue(cue.intensity))),
        durationSeconds: Math.max(0, Math.min(60, numberValue(cue.durationSeconds))),
        purpose: typeof cue.purpose === "string" ? cue.purpose : "服务章节结构",
      };
    }) : [...defaultCueDefinitions];
    const cues = cueDefinitions.map((definition) => {
      const previous = currentCues.find((cue) => cue.id === definition.id);
      const usesMusic = !agentDirected || asRecord(definition).action !== "silence";
      const choices = [
        { action: "silence", title: "留白", score: 100, reason: definition.purpose },
        ...(usesMusic && definition.durationSeconds > 0 ? rankMusicAssets(library.assets, definition.targetMood, definition.targetEnergy, run).slice(0, 3) : []),
      ];
      const previousSelection = asRecord(previous?.selection);
      const previousAssetStillAvailable = previousSelection.action === "asset"
        && choices.some((choice) => choice.action === "asset" && choice.assetId === previousSelection.assetId);
      return {
        ...definition,
        choices,
        selection: previousSelection.action === "silence" || previousAssetStillAvailable
          ? previousSelection
          : { action: "silence" },
      };
    });
    return success("music-director", "licensed-cues-v1", {
      [artifactId]: {
      status: "ready",
      confirmed: true,
      policy,
      libraryAssetCount: library.assets.length,
      cues,
      ...(agentDirected ? { generatedBy } : {}),
      rules: ["观点密集处优先留白", "只从已登记商业使用依据的音乐库选择", "音乐进入和退出都必须服务结构而非掩盖内容"],
      },
    });
  }

  private async applyMusicCueMix(
    run: WorkflowRun,
    dryPath: string,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<{ mixedAssetIds: string[] }> {
    const cuePlan = asRecord(activeArtifactData(run, "artifact-cues"));
    const selected = asArray(cuePlan.cues).map(asRecord).flatMap((cue) => {
      const selection = asRecord(cue.selection);
      const durationSeconds = numberValue(cue.durationSeconds);
      return selection.action === "asset" && typeof selection.assetId === "string" && durationSeconds > 0
        ? [{ cueId: String(cue.id ?? "cue"), assetId: selection.assetId, durationSeconds }]
        : [];
    });
    if (selected.length === 0) {
      await copyFile(dryPath, outputPath);
      return { mixedAssetIds: [] };
    }
    const dryDuration = await probeAudioDuration(dryPath);
    const inputs: string[] = [];
    const filters: string[] = [];
    const labels = ["[0:a]"];
    for (const [index, cue] of selected.entries()) {
      const assetPath = await this.musicLibrary.resolveAssetPath(cue.assetId);
      if (!assetPath) throw new Error(`音乐素材“${cue.assetId}”已不存在，请重新确认 Cue。`);
      inputs.push("-stream_loop", "-1", "-i", assetPath);
      const startSeconds = cueStartSeconds(cue.cueId, dryDuration, cue.durationSeconds, index, selected.length);
      const delayMs = Math.max(0, Math.round(startSeconds * 1_000));
      const fadeOutStart = Math.max(0, cue.durationSeconds - 0.6);
      const label = `[music${index}]`;
      filters.push(`[${index + 1}:a]atrim=duration=${cue.durationSeconds.toFixed(3)},afade=t=in:st=0:d=0.35,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.6,volume=0.14,adelay=${delayMs}|${delayMs}${label}`);
      labels.push(label);
    }
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0[out]`);
    await execFile("/opt/homebrew/bin/ffmpeg", [
      "-y", "-loglevel", "error", "-i", dryPath, ...inputs,
      "-filter_complex", filters.join(";"), "-map", "[out]",
      "-c:a", outputPath.endsWith(".mp3") ? "libmp3lame" : "aac", "-b:a", "128k", outputPath,
    ], { signal });
    return { mixedAssetIds: selected.map((cue) => cue.assetId) };
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface ExecutionDraft {
  status: NodeExecutionOutcome["status"];
  providerId: string;
  modelId: string;
  outputs: Record<string, unknown>;
  actualCostCny?: number;
  errorMessage?: string;
}

function researchPacket(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("资料节点没有输出产物。");
  const current = asRecord(activeArtifactData(run, artifactId));
  const sources = asArray(current.sources);
  const review = reviewResearchPacket(current);
  if (review.ready) {
    return success("research-source-verifier", "source-gate-v1", {
      [artifactId]: { ...current, verifiedIndependentSourceCount: review.verifiedIndependentSourceCount },
    });
  }
  return blocked("local-production-engine", "research-checklist-v1", artifactId, {
    ...current,
    status: "needs_research",
    verifiedIndependentSourceCount: review.verifiedIndependentSourceCount,
    checklist: [
      "补充至少两个彼此独立、可打开的事实来源",
      "逐条记录发布日期、作者或机构与原始链接",
      "区分已经确认、仍有争议和无法核实的内容",
    ],
    note: "热榜与聚合站只用于发现选题，不计入独立事实来源。",
  }, "资料包未形成至少两个独立的已核验来源，请补充或修订来源后重跑。");
}

function claimLedger(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("事实账本节点没有输出产物。");
  const current = asRecord(activeArtifactData(run, artifactId));
  const claims = asArray(current.claims);
  const sourceIds = verifiedSourceIds(run);
  const complete = sourceIds.size >= 2 && current.status === "verified" && claims.length > 0 && claims.every((claim) => {
    const item = asRecord(claim);
    const claimSourceIds = asArray(item.sourceIds).filter((value): value is string => typeof value === "string");
    return typeof item.text === "string"
      && item.text.trim().length > 0
      && claimSourceIds.length > 0
      && claimSourceIds.every((sourceId) => sourceIds.has(sourceId));
  });
  if (complete) return success("research-ledger", "claim-ledger-v1", { [artifactId]: current });
  return failure(
    "local-production-engine",
    "claim-ledger-agent-required-v1",
    "自动资料已就绪，但本地执行器不会从标题编造事实；请接通 Token Talk Codex Broker 生成带来源 ID 与限定语的论点账本。",
  );
}

function castPlan(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("角色节点没有输出产物。");
  const current = asRecord(activeArtifactData(run, artifactId));
  const suggested = asArray(current.suggestedRoles).filter((item): item is string => typeof item === "string");
  const centralQuestion = stringAt(run, "artifact-brief", "centralQuestion") ?? run.title;
  const policy = run.productionIntent?.castPolicy ?? { mode: "dynamic" as const, recurringRoleIds: [], roles: [] };
  const configured = policy.roles.map((role, index) => castRole({
    id: role.id,
    name: role.name,
    ...(role.responsibility ? { responsibility: role.responsibility } : {}),
    ...(role.speakingStyle ? { speakingStyle: role.speakingStyle } : {}),
    ...(role.voiceBrief ? { voiceBrief: role.voiceBrief } : {}),
  }, index, centralQuestion));
  if (policy.mode !== "dynamic" && configured.length === 0) {
    return blocked("local-production-engine", "series-cast-required-v1", artifactId, {
      status: "needs_series_cast",
      policy: policy.mode,
      roles: [],
      note: "该系列选择了固定或常驻阵容，但还没有登记角色。请先补齐系列角色。",
    }, "固定或常驻系列缺少角色配置，请补齐系列角色后重跑。");
  }
  const fallbackNames = suggested.length > 0 ? suggested : ["问题引导者", "事实编辑", "观点挑战者"];
  const existingNames = new Set(configured.map((role) => role.name));
  const maxSpeakers = policy.maxSpeakers ?? 4;
  const generated = fallbackNames
    .filter((name) => !existingNames.has(name))
    .slice(0, Math.max(0, maxSpeakers - configured.length))
    .map((name, index) => castRole({ id: `role-${configured.length + index + 1}`, name }, configured.length + index, centralQuestion));
  const roles = policy.mode === "fixed" ? configured : policy.mode === "recurring_with_guests" ? [...configured, ...generated] : generated;
  return success("local-production-engine", `${policy.mode}-cast-v1`, {
    [artifactId]: {
      status: "draft",
      policy: policy.mode,
      centralQuestion,
      roles,
    },
  });
}

function castRole(
  role: { id: string; name: string; responsibility?: string; speakingStyle?: string; voiceBrief?: string },
  index: number,
  centralQuestion: string,
): Record<string, string> {
  return {
    id: role.id,
    name: role.name,
    responsibility: role.responsibility ?? roleResponsibility(role.name, index),
    speakingStyle: role.speakingStyle ?? (index === 0 ? "克制、清楚、善于追问" : "短句、有立场、必须回应证据"),
    mustAsk: index === 0 ? centralQuestion : `关于“${centralQuestion}”，最容易被忽略的反例是什么？`,
    voiceBrief: role.voiceBrief ?? (index % 2 === 0 ? "中速、温暖、低表演感" : "稍快、清晰、保留质疑感"),
  };
}

function episodeBlueprint(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("节目蓝图节点没有输出产物。");
  const claims = claimTexts(run);
  const targetMinutes = run.productionIntent?.targetMinutes ?? 30;
  const centralQuestion = stringAt(run, "artifact-brief", "centralQuestion") ?? run.title;
  const sections = claims.length > 0 ? claims.slice(0, 4) : [];
  if (sections.length === 0) {
    return blocked("local-production-engine", "blueprint-v1", artifactId, {
      status: "needs_claims",
      centralQuestion,
      segments: [],
      note: "蓝图需要至少一条已核验事实；请先完成资料包或事实账本。",
    }, "蓝图需要至少一条已核验事实，请先完成资料包或事实账本。");
  }
  const chapterCount = Math.max(3, Math.min(24, Math.ceil(targetMinutes / 10)));
  const baseMinutes = Math.floor(targetMinutes / chapterCount);
  const remainder = targetMinutes - baseMinutes * chapterCount;
  const segmentMinutes = Array.from({ length: chapterCount }, (_, index) => baseMinutes + (index < remainder ? 1 : 0));
  return success("local-production-engine", "blueprint-v1", {
    [artifactId]: {
      status: "draft",
      centralQuestion,
      targetMinutes,
      segments: segmentMinutes.map((minutes, index) => {
        if (index === 0) return { id: "opening", title: "把问题说清楚", minutes, purpose: "建立听众承诺", material: [centralQuestion] };
        if (index === segmentMinutes.length - 1) return { id: "closing", title: "保留什么判断", minutes, purpose: "给出边界清楚的结论", material: [centralQuestion] };
        const text = sections[(index - 1) % sections.length];
        return { id: `segment-${index}`, title: `证据与分歧 ${index}`, minutes, purpose: "用已核验材料推进问题", material: text ? [text] : [centralQuestion] };
      }),
    },
  });
}

function emotionalArc(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("情绪曲线节点没有输出产物。");
  const blueprint = asRecord(activeArtifactData(run, "artifact-blueprint"));
  const segments = asArray(blueprint.segments);
  if (segments.length === 0) return blocked("local-production-engine", "emotional-arc-v1", artifactId, { status: "needs_blueprint", beats: [] }, "情绪曲线需要节目蓝图，请先完成蓝图后重跑。");
  const beatNames = ["好奇", "聚焦", "张力", "澄清", "余味"];
  return success("local-production-engine", "emotional-arc-v1", {
    [artifactId]: {
      status: "draft",
      beats: segments.map((segment, index) => ({
        segmentId: asRecord(segment).id ?? `segment-${index + 1}`,
        emotion: beatNames[Math.min(index, beatNames.length - 1)],
        energy: Math.min(4, 2 + (index % 3)),
        soundDirection: index === 0 ? "干声开场，先不铺音乐" : "只在转场给短 Cue，观点冲突处留白",
      })),
    },
  });
}

function scriptSegment(run: WorkflowRun, artifactId: string | undefined, targetSegmentId?: string): ExecutionDraft {
  if (!artifactId) throw new Error("脚本节点没有输出产物。");
  const blueprint = asRecord(activeArtifactData(run, "artifact-blueprint"));
  const segments = asArray(blueprint.segments);
  if (segments.length === 0) return blocked("local-production-engine", "script-draft-v1", artifactId, { status: "needs_blueprint", lines: [] }, "脚本节点需要节目蓝图，请先完成蓝图后重跑。");
  const selectedSegments = targetSegmentId
    ? segments.filter((segment) => asRecord(segment).id === targetSegmentId)
    : segments;
  if (targetSegmentId && selectedSegments.length === 0) throw new Error(`节目蓝图中不存在章节“${targetSegmentId}”。`);
  const roles = castRoleNames(run);
  const listenerPromise = stringAt(run, "artifact-brief", "listenerPromise") ?? "把问题说清楚";
  const generatedLines = selectedSegments.flatMap((segment) => {
    const item = asRecord(segment);
    const index = Math.max(0, segments.findIndex((candidate) => asRecord(candidate).id === item.id));
    const material = asArray(item.material).filter((value): value is string => typeof value === "string");
    const speaker = roles[index % roles.length] ?? "本期主持";
    const claimIds = asArray(item.claimIds).filter((value): value is string => typeof value === "string");
    return [
      { segmentId: item.id, speaker: index === 0 ? roles[0] ?? "本期主持" : speaker, text: index === 0 ? `这一期我们想做到一件事：${listenerPromise}` : `接下来谈“${String(item.title ?? "这一部分")}”。`, claimIds: [] },
      ...material.map((text) => ({ segmentId: item.id, speaker, text, claimIds })),
    ];
  });
  const current = asRecord(activeArtifactData(run, artifactId));
  const lines = targetSegmentId
    ? mergeLocalSegmentLines(segments, asArray(current.lines), targetSegmentId, generatedLines)
    : generatedLines;
  return success("local-production-engine", "script-draft-v1", {
    [artifactId]: {
      ...current,
      status: "draft",
      title: run.title,
      lines,
      lockedSegmentIds: asArray(current.lockedSegmentIds).filter((value): value is string => typeof value === "string"),
      factualPolicy: "only_verified_material",
      ...(targetSegmentId ? { generation: { mode: "structured_template_fallback", targetSegmentId } } : {}),
    },
  });
}

function mergeLocalSegmentLines(
  segments: unknown[],
  currentLines: unknown[],
  segmentId: string,
  generatedLines: Array<Record<string, unknown>>,
): unknown[] {
  const order = segments.map((segment) => String(asRecord(segment).id ?? ""));
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...currentLines.filter((line) => asRecord(line).segmentId !== segmentId), ...generatedLines]
    .map((line, index) => ({ line, index }))
    .sort((left, right) => {
      const leftOrder = orderIndex.get(String(asRecord(left.line).segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndex.get(String(asRecord(right.line).segmentId ?? "")) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ line }) => line);
}

function assembleScript(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("整集脚本节点没有输出产物。");
  const lines = collectScriptLines(run, ["artifact-segment-1"]);
  if (lines.length === 0) return blocked("local-production-engine", "script-assembly-v1", artifactId, { status: "needs_segments", lines: [] }, "整集脚本需要至少一个脚本分段，请先生成或编辑分段后重跑。");
  return success("local-production-engine", "script-assembly-v1", {
    [artifactId]: { status: "assembled_draft", title: run.title, lines, estimatedCharacters: lines.reduce((total, line) => total + line.text.length, 0) },
  });
}

function voiceCasting(
  run: WorkflowRun,
  artifactId: string | undefined,
  allowedElevenLabsVoiceIds: Set<string> | undefined,
  catalogError: string | undefined,
  validatedAt: string,
): ExecutionDraft {
  if (!artifactId) throw new Error("声音试演节点没有输出产物。");
  const lines = collectScriptLines(run);
  if (lines.length === 0) throw new Error("脚本中还没有可用于声音试演的台词。");
  const roles = scriptSpeakers(lines);
  const current = asRecord(activeArtifactData(run, artifactId));
  const selections = asArray(current.selections).map(asRecord);
  if (!scriptSpeakersBelongToCast(run, lines)) {
    return failure("local-production-engine", "cast-plan-required-v1", "脚本包含本期角色方案之外的说话人，请先运行脚本返修或更新角色方案。");
  }
  const selectedProviders = new Set(selections.map((selection) => selection.providerId));
  const validSelection = voicePlanReady(current)
    && selectedProviders.size === 1
    && voiceSelectionsExactlyMatch(lines, selections)
    && selections.every((selection) => {
      if (selection.providerId === "local-macos-say") return typeof selection.voiceId === "string" && selection.voiceId.trim().length > 0;
      return selection.providerId === "elevenlabs-v3"
        && isValidElevenLabsVoiceId(selection.voiceId)
        && typeof selection.voiceId === "string"
        && allowedElevenLabsVoiceIds?.has(selection.voiceId) === true;
    });
  const characters = lines.reduce((total, line) => total + line.text.length, 0);
  const defaultSelections = roles.map((role, index) => ({
    role,
    providerId: "local-macos-say",
    voiceId: CHINESE_PREVIEW_VOICES[index % CHINESE_PREVIEW_VOICES.length],
    use: "preview_only",
  }));
  const plan = {
    status: "ready",
    confirmed: true,
    characters,
    roles,
    selections: validSelection ? selections : defaultSelections,
    candidates: voiceProviderCandidates(characters),
    ...(allowedElevenLabsVoiceIds ? { voiceCatalogValidatedAt: validatedAt } : {}),
    ...(catalogError ? { catalogError } : {}),
    rules: [
      "角色严格按本期 cast 计划映射，不默认固定双人或固定音色",
      "macOS 系统声音只用于零现金桌读，不作为发行母带",
      "免费额度不等于商用授权；声音复刻必须保存明确同意记录",
    ],
  };
  return success("voice-router", "voice-plan-v1", { [artifactId]: plan });
}

function voiceProviderCandidates(characters: number): Array<Record<string, unknown>> {
  return [
    { providerId: "local-macos-say", label: "macOS 系统配音", estimatedCostCny: 0, configured: true, executable: true, releaseUse: "preview_only", note: "零现金、最快，用于结构和节奏检查" },
    { providerId: "alibaba-qwen-tts", label: "Qwen3-TTS Flash", estimatedCostCny: roundCost(characters / 10_000 * 0.8), configured: Boolean(process.env.DASHSCOPE_API_KEY), executable: false, releaseUse: "terms_review", freeQuota: "已完成成本评估，当前版本尚未接通执行适配器" },
    { providerId: "volcengine-doubao-tts", label: "豆包语音合成大模型", estimatedCostCny: roundCost(characters / 10_000 * 4.5), configured: Boolean(process.env.ARK_API_KEY), executable: false, releaseUse: "terms_review", note: "已完成成本评估，当前版本尚未接通执行适配器" },
    { providerId: "elevenlabs-v3", label: "ElevenLabs v3", estimatedCostCny: estimateElevenLabsCostCny(characters), configured: Boolean(process.env.ELEVENLABS_API_KEY), executable: Boolean(process.env.ELEVENLABS_API_KEY), releaseUse: "paid_plan_only", freeQuota: "免费层仅限非商用且需署名，以当前账户条款为准" },
  ];
}

function roundCost(value: number): number {
  return Math.round(value * 100) / 100;
}

function visualBrief(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("视觉节点没有输出产物。");
  return failure("local-production-engine", "cover-provider-required-v1", "封面生成服务尚未配置，不能伪造可发布的视觉资产。");
}

function researchAudit(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("证据审计节点没有输出产物。");
  const review = reviewResearchPacket(activeArtifactData(run, "artifact-sources"));
  const findings = review.ready ? [] : ["资料包尚未形成至少两个独立的已核验来源。"];
  return success("local-research-auditor", "source-audit-v1", {
    [artifactId]: {
      verdict: findings.length === 0 ? "pass" : "revise",
      status: findings.length === 0 ? "passed" : "revise",
      findings,
      verifiedIndependentSourceCount: review.verifiedIndependentSourceCount,
    },
  });
}

function scriptAudit(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("脚本审计节点没有输出产物。");
  const lines = collectScriptLines(run);
  const cast = new Set(castRoleNames(run));
  const findings = [
    lines.length < 4 ? "脚本台词不足，无法形成可试听的节目。" : undefined,
    lines.some((line) => !line.speaker || !cast.has(line.speaker)) ? "脚本包含本期角色方案外的说话人。" : undefined,
  ].filter((finding): finding is string => Boolean(finding));
  return success("local-script-auditor", "script-structure-audit-v1", {
    [artifactId]: {
      verdict: findings.length === 0 ? "pass" : "revise",
      summary: findings.length === 0 ? "脚本结构检查通过。" : "脚本结构检查发现需要返修的问题。",
      findings: findings.map((description, index) => ({
        id: `local-script-audit-${index + 1}`,
        severity: "warning",
        category: "structure",
        description,
        evidence: description,
        repairInstruction: description,
      })),
    },
  });
}

function scriptRepair(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("脚本返修节点没有输出产物。");
  const script = asRecord(activeArtifactData(run, "artifact-script"));
  const audit = asRecord(activeArtifactData(run, "artifact-script-audit"));
  if (audit.verdict !== "pass") {
    const roles = castRoleNames(run);
    const fallbackRole = roles[0];
    const repairedLines = normalizeLines(script.lines).map((line) => ({
      ...line,
      speaker: line.speaker && roles.includes(line.speaker) ? line.speaker : fallbackRole,
    }));
    if (!fallbackRole || repairedLines.length < 4) {
      return failure("local-script-repair", "bounded-local-repair-v1", "本地返修器不能在缺少足够台词或角色时补写内容；请接通 Codex Broker 自动返修，或人工编辑脚本后重试。");
    }
    return success("local-script-repair", "bounded-local-repair-v1", {
      [artifactId]: {
        ...script,
        status: "repaired_draft",
        lines: repairedLines,
        repairNote: "本地返修仅规范了未登记说话人，不补写新事实或新台词。",
      },
    });
  }
  return success("local-script-repair", "pass-through-v1", { [artifactId]: script });
}

function releaseCopy(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("发行编辑节点没有输出产物。");
  const brief = asRecord(activeArtifactData(run, "artifact-brief"));
  const chapters = releaseChapters(run);
  const summary = stringValue(brief.listenerPromise) ?? stringValue(brief.hook) ?? run.productionIntent?.hook ?? run.title;
  return success("local-release-editor", "release-copy-template-v1", {
    [artifactId]: {
      status: "ready",
      episodeTitle: run.title.slice(0, 120),
      summary,
      showNotes: chapters.map((chapter) => `${formatChapterTimestamp(chapter.startSeconds)} ${chapter.title}`),
      keywords: [],
      generationNote: "本地模板只整理已有标题、听众承诺与章节；接通 Codex Broker 后由发行编辑 Agent 完成检索友好的最终文案。",
    },
  });
}

function audioAudit(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("成片审计节点没有输出产物。");
  const audio = asRecord(activeArtifactData(run, "artifact-audio"));
  const lines = collectScriptLines(run);
  const durationSeconds = numberValue(audio.durationSeconds);
  const targetSeconds = (run.productionIntent?.targetMinutes ?? 30) * 60;
  const audioQc = asRecord(audio.audioQc);
  const integratedLoudnessLufs = optionalNumber(audioQc.integratedLoudnessLufs);
  const truePeakDbtp = optionalNumber(audioQc.truePeakDbtp);
  const findings = [
    audio.releaseReady !== true ? "当前音频不是已登记的发行母带" : undefined,
    typeof audio.mediaUrl !== "string" || !audio.mediaUrl.startsWith("/media/") ? "发行母带缺少受控媒体地址" : undefined,
    typeof audio.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(audio.sha256) ? "发行母带缺少校验值" : undefined,
    durationSeconds <= 0 ? "发行母带缺少有效时长" : undefined,
    durationSeconds > 0 && (durationSeconds < targetSeconds * 0.85 || durationSeconds > targetSeconds * 1.2)
      ? `音频时长 ${Math.round(durationSeconds / 6) / 10} 分钟偏离 ${Math.round(targetSeconds / 60)} 分钟目标`
      : undefined,
    audio.releaseReady === true && integratedLoudnessLufs === undefined ? "发行母带缺少 integrated loudness 测量" : undefined,
    integratedLoudnessLufs !== undefined && (integratedLoudnessLufs < -17 || integratedLoudnessLufs > -15)
      ? `发行母带响度为 ${integratedLoudnessLufs} LUFS，不符合 -16 ±1 LUFS 目标`
      : undefined,
    audio.releaseReady === true && truePeakDbtp === undefined ? "发行母带缺少 true peak 测量" : undefined,
    truePeakDbtp !== undefined && truePeakDbtp > -1
      ? `发行母带 true peak 为 ${truePeakDbtp} dBTP，高于 -1 dBTP 上限`
      : undefined,
    lines.length === 0 ? "逐字稿为空，无法进行对白一致性检查" : undefined,
  ].filter((finding): finding is string => Boolean(finding));
  const audioArtifact = run.artifacts.find((candidate) => candidate.id === "artifact-audio");
  return success("local-audio-auditor", "release-preflight-v1", {
    [artifactId]: {
      verdict: findings.length === 0 ? "pass" : "revise",
      status: findings.length === 0 ? "passed" : "blocked",
      summary: findings.length === 0 ? "发行母带、响度、峰值、时长和逐字稿检查通过。" : "成片技术与内容检查发现需要返修的问题。",
      findings,
      checkedAudioVersionId: audioArtifact?.activeVersionId,
      checks: ["release-master", "checksum", "duration", "integrated-loudness", "true-peak", "transcript"],
    },
  });
}

function publishPackage(run: WorkflowRun, artifactId: string | undefined): ExecutionDraft {
  if (!artifactId) throw new Error("发布节点没有输出产物。");
  const audio = asRecord(activeArtifactData(run, "artifact-audio"));
  const visual = asRecord(activeArtifactData(run, "artifact-visuals"));
  const selectedCoverId = typeof visual.selectedCoverId === "string" ? visual.selectedCoverId : undefined;
  const selectedCover = asArray(visual.covers).map(asRecord).find((cover) => cover.id === selectedCoverId);
  const audioAuditArtifact = run.artifacts.find((artifact) => artifact.id === "artifact-audio-audit");
  const audioAudit = asRecord(activeArtifactData(run, "artifact-audio-audit"));
  const transcriptLines = collectScriptLines(run).map((line) => ({ speaker: line.speaker ?? "旁白", text: line.text }));
  const blueprintSegments = asArray(asRecord(activeArtifactData(run, "artifact-blueprint")).segments);
  const chapters = releaseChapters(run);
  const audioDurationSeconds = numberValue(audio.durationSeconds);
  const chapterDurationSeconds = chapters.reduce((total, chapter) => total + chapter.durationSeconds, 0);
  const chapterDurationTolerance = Math.max(60, audioDurationSeconds * 0.15);
  const chaptersExceedAudio = chapterDurationSeconds > audioDurationSeconds + 1;
  const sourceReview = reviewResearchPacket(activeArtifactData(run, "artifact-sources"));
  const sources = verifiedReleaseSources(sourceReview.verifiedSources);
  const releaseCopyData = asRecord(activeArtifactData(run, "artifact-release-copy"));
  const editorial = {
    episodeTitle: stringValue(releaseCopyData.episodeTitle),
    summary: stringValue(releaseCopyData.summary),
    showNotes: asArray(releaseCopyData.showNotes).flatMap((value) => stringValue(value) ?? []),
    keywords: asArray(releaseCopyData.keywords).flatMap((value) => stringValue(value) ?? []),
  };
  const researchRequired = run.nodes.some((node) => node.capability === "research.search");
  const blockers = [
    audio.releaseReady !== true || typeof audio.mediaUrl !== "string" || !audio.mediaUrl.startsWith("/media/") ? "音频仍是桌读或预览，缺少发行母带" : undefined,
    typeof audio.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(audio.sha256) ? "发行母带缺少可信校验值" : undefined,
    !selectedCover ? "尚未从候选中选定发行封面" : undefined,
    typeof selectedCover?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(selectedCover.sha256) ? "发行封面缺少可信校验值" : undefined,
    transcriptLines.length === 0 ? "整集逐字稿为空" : undefined,
    chapters.length === 0 || chapters.length !== blueprintSegments.length ? "节目蓝图存在缺少标题或时长的章节" : undefined,
    audioDurationSeconds <= 0 ? "发行母带缺少有效时长" : undefined,
    audioDurationSeconds > 0 && chapters.length > 0 && chaptersExceedAudio ? "节目章节越过发行母带结尾，请校对蓝图或重新导出母带" : undefined,
    audioDurationSeconds > 0 && chapters.length > 0 && !chaptersExceedAudio && Math.abs(chapterDurationSeconds - audioDurationSeconds) > chapterDurationTolerance
      ? "发行母带时长与节目章节差异过大，请校对蓝图或重新导出母带"
      : undefined,
    researchRequired && !sourceReview.ready ? "资料包尚未形成至少两个独立的已核验来源" : undefined,
    releaseCopyData.status !== "ready" || !editorial.episodeTitle || !editorial.summary ? "发行文案尚未完成标题、摘要与 Show Notes 编辑" : undefined,
    audioAudit.verdict !== "pass" ? "当前音频版本尚未通过自动成片质量审计" : undefined,
  ].filter(Boolean);
  if (blockers.length > 0) {
    return blocked("local-production-engine", "publish-gate-v1", artifactId, {
      status: "blocked",
      blockers,
    }, "发布检查未通过，请修复阻塞项后重跑。");
  }
  if (!selectedCover) throw new Error("发布检查通过后仍未找到发行封面。");
  const voicePlan = asRecord(activeArtifactData(run, "artifact-voices"));
  const cuePlan = asRecord(activeArtifactData(run, "artifact-cues"));
  const cast = asRecord(activeArtifactData(run, "artifact-cast"));
  const persons = asArray(cast.roles).flatMap((role) => {
    const value = asRecord(role);
    const name = stringValue(value.name);
    if (!name) return [];
    return [{ name, role: stringValue(value.responsibility) ?? "本期节目角色" }];
  });
  const parsedReleasePackage = ReleasePackageSchema.safeParse({
    schemaVersion: 1,
    status: "release_ready",
    releaseReady: true,
    episode: {
      runId: run.id,
      title: editorial.episodeTitle,
      seriesId: run.seriesId,
      hook: run.productionIntent?.hook ?? run.title,
      targetMinutes: run.productionIntent?.targetMinutes ?? Math.max(1, Math.round(numberValue(audio.durationSeconds) / 60)),
      generatedAt: run.updatedAt,
    },
    audio: {
      mediaUrl: audio.mediaUrl,
      mimeType: audio.mimeType,
      bytes: audio.bytes,
      sha256: audio.sha256,
      durationSeconds: audio.durationSeconds,
      releaseReady: audio.releaseReady,
      audioQc: audio.audioQc,
    },
    cover: {
      id: selectedCover.id,
      mediaUrl: selectedCover.mediaUrl,
      mimeType: selectedCover.mimeType,
      bytes: selectedCover.bytes,
      sha256: selectedCover.sha256,
      width: selectedCover.width,
      height: selectedCover.height,
      altText: selectedCover.altText,
    },
    transcript: { format: "speaker_lines", lineCount: transcriptLines.length, lines: transcriptLines },
    chapters,
    sources,
    editorial,
    podcasting2: {
      chapters: {
        mimeType: "application/json+chapters",
        data: {
          version: "1.2.0",
          title: editorial.episodeTitle,
          description: editorial.summary,
          chapters: chapters.map((chapter) => ({ startTime: chapter.startSeconds, title: chapter.title })),
        },
      },
      transcript: {
        sourceFormat: "speaker_lines",
        recommendedMimeType: "text/vtt",
        status: "requires_forced_alignment",
        speakerLabels: true,
      },
      persons,
    },
    disclosures: {
      aiAssisted: releaseWasAiAssisted(run, audio, selectedCover, voicePlan),
      automatedAudioAudit: true,
      cast: asArray(cast.roles).flatMap((role) => {
        const name = typeof role === "string" ? role : asRecord(role).name;
        return typeof name === "string" && name.trim() ? [name.trim()] : [];
      }),
      voices: asArray(voicePlan.selections).flatMap((value) => {
        const selection = asRecord(value);
        if (typeof selection.role !== "string" || typeof selection.providerId !== "string" || typeof selection.voiceId !== "string") return [];
        return [{ role: selection.role, providerId: selection.providerId, voiceId: selection.voiceId, ...(typeof selection.use === "string" ? { use: selection.use } : {}) }];
      }),
      musicCues: asArray(cuePlan.cues).flatMap((value) => {
        const cue = asRecord(value);
        const selection = asRecord(cue.selection);
        if (typeof cue.id !== "string" || !["silence", "asset"].includes(String(selection.action))) return [];
        return [{ id: cue.id, action: selection.action, ...(typeof selection.assetId === "string" ? { assetId: selection.assetId } : {}) }];
      }),
      rights: { audio: audio.rights, cover: selectedCover.rights },
    },
    checksums: { audioSha256: audio.sha256, coverSha256: selectedCover.sha256 },
    audioAuditArtifactVersionId: audioAuditArtifact?.activeVersionId,
  });
  if (!parsedReleasePackage.success) {
    return blocked("local-production-engine", "publish-gate-v1", artifactId, {
      status: "blocked",
      blockers: ["发行资产或清单元数据不完整，请重新登记母带、封面并运行发布检查"],
    }, "发行资产或清单元数据不完整，请重新登记母带、封面并运行发布检查。");
  }
  return success("local-production-engine", "publish-package-v1", {
    [artifactId]: parsedReleasePackage.data,
  });
}

function releaseWasAiAssisted(run: WorkflowRun, audio: Record<string, unknown>, cover: Record<string, unknown>, voicePlan: Record<string, unknown>): boolean {
  const aiProviderIds = new Set(["local-ollama-production", "research-agent-orchestrator", "elevenlabs-v3", "alibaba-qwen-tts", "volcengine-doubao-tts"]);
  const hasAiExecution = run.executionReceipts.some((receipt) => receipt.status !== "failed" && aiProviderIds.has(receipt.providerId));
  const hasGeneratedVoice = asArray(voicePlan.selections).some((value) => aiProviderIds.has(String(asRecord(value).providerId)));
  const audioRights = asRecord(audio.rights);
  const coverRights = asRecord(cover.rights);
  return hasAiExecution || hasGeneratedVoice || audioRights.basis === "generated" || coverRights.basis === "generated";
}

function releaseChapters(run: WorkflowRun): Array<{ id: string; title: string; startSeconds: number; durationSeconds: number }> {
  const blueprint = asRecord(activeArtifactData(run, "artifact-blueprint"));
  let startSeconds = 0;
  return asArray(blueprint.segments).flatMap((value, index) => {
    const segment = asRecord(value);
    const durationSeconds = Math.round(numberValue(segment.minutes) * 60);
    if (typeof segment.title !== "string" || !segment.title.trim() || durationSeconds <= 0) return [];
    const chapter = {
      id: typeof segment.id === "string" && segment.id.trim() ? segment.id : `chapter-${index + 1}`,
      title: segment.title.trim(),
      startSeconds,
      durationSeconds,
    };
    startSeconds += durationSeconds;
    return [chapter];
  });
}

function formatChapterTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function verifiedReleaseSources(values: Array<Record<string, unknown>>): Array<{ id: string; title: string; url: string; publisher?: string; publishedAt?: string }> {
  return values.flatMap((source) => {
    if (typeof source.id !== "string" || typeof source.title !== "string" || typeof source.url !== "string") return [];
    return [{
      id: source.id,
      title: source.title,
      url: source.url,
      ...(typeof source.publisher === "string" && source.publisher.trim() ? { publisher: source.publisher } : {}),
      ...(typeof source.publishedAt === "string" && source.publishedAt.trim() ? { publishedAt: source.publishedAt } : {}),
    }];
  });
}

function success(providerId: string, modelId: string, outputs: Record<string, unknown>): ExecutionDraft {
  return { status: "succeeded", providerId, modelId, outputs };
}

function failure(providerId: string, modelId: string, errorMessage: string): ExecutionDraft {
  return { status: "failed", providerId, modelId, outputs: {}, errorMessage };
}

function blocked(providerId: string, modelId: string, artifactId: string, data: unknown, errorMessage: string): ExecutionDraft {
  return { status: "failed", providerId, modelId, outputs: { [artifactId]: data }, errorMessage };
}

function activeArtifactData(run: WorkflowRun, artifactId: string): unknown {
  const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
  return activeVersion(artifact)?.data;
}

function activeVersion(artifact: Artifact | undefined): Artifact["versions"][number] | undefined {
  return artifact?.versions.find((version) => version.id === artifact.activeVersionId);
}

function stringAt(run: WorkflowRun, artifactId: string, key: string): string | undefined {
  const value = asRecord(activeArtifactData(run, artifactId))[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function claimTexts(run: WorkflowRun): string[] {
  const ledger = asRecord(activeArtifactData(run, "artifact-claims"));
  const packetReview = reviewResearchPacket(activeArtifactData(run, "artifact-sources"));
  const sourceIds = packetReview.verifiedSourceIds;
  if (ledger.status !== "verified" || !packetReview.ready) return [];
  const claims = asArray(ledger.claims).flatMap((claim) => {
    if (typeof claim === "string") return [claim];
    const item = asRecord(claim);
    const text = item.text;
    const claimSourceIds = asArray(item.sourceIds).filter((value): value is string => typeof value === "string");
    return typeof text === "string" && claimSourceIds.length > 0 && claimSourceIds.every((sourceId) => sourceIds.has(sourceId)) ? [text] : [];
  });
  if (claims.length > 0) return claims;
  if (run.nodes.some((node) => node.capability === "research.claims")) return [];
  const sources = asRecord(activeArtifactData(run, "artifact-sources"));
  if (!packetReview.ready) return [];
  return asArray(sources.sources).flatMap((source) => {
    const title = asRecord(source).title;
    return typeof title === "string" ? [title] : [];
  });
}

function verifiedSourceIds(run: WorkflowRun): Set<string> {
  const review = reviewResearchPacket(activeArtifactData(run, "artifact-sources"));
  return review.ready ? review.verifiedSourceIds : new Set();
}

function castRoleNames(run: WorkflowRun): string[] {
  const cast = asRecord(activeArtifactData(run, "artifact-cast"));
  const roles = asArray(cast.roles).flatMap((role) => {
    if (typeof role === "string") return [role];
    const name = asRecord(role).name;
    return typeof name === "string" ? [name] : [];
  });
  return roles.length > 0 ? roles : ["本期主持", "事实编辑"];
}

interface LocalScriptLine {
  speaker?: string;
  text: string;
  segmentId?: string;
  claimIds?: string[];
  delivery?: string;
  pauseAfterMs?: number;
}

function collectScriptLines(run: WorkflowRun, preferredArtifactIds = ["artifact-script", "artifact-segment-1"]): LocalScriptLine[] {
  for (const artifactId of preferredArtifactIds) {
    const data = asRecord(activeArtifactData(run, artifactId));
    const direct = normalizeLines(data.lines);
    if (direct.length > 0) return direct;
    const nested = asArray(data.segments).flatMap((segment) => normalizeLines(asRecord(segment).lines));
    if (nested.length > 0) return nested;
  }
  return [];
}

function scriptSpeakers(lines: LocalScriptLine[]): string[] {
  return [...new Set(lines.map((line) => line.speaker ?? "旁白"))];
}

function voiceSelectionsExactlyMatch(lines: LocalScriptLine[], selections: Array<Record<string, unknown>>): boolean {
  const speakers = scriptSpeakers(lines);
  if (speakers.length === 0 || selections.length !== speakers.length) return false;
  const roles = selections.flatMap((selection) => typeof selection.role === "string" && selection.role.trim() ? [selection.role.trim()] : []);
  return roles.length === selections.length
    && new Set(roles).size === roles.length
    && speakers.every((speaker) => roles.includes(speaker));
}

function scriptSpeakersBelongToCast(run: WorkflowRun, lines: LocalScriptLine[]): boolean {
  const allowedRoles = new Set(castRoleNames(run));
  return scriptSpeakers(lines).every((speaker) => allowedRoles.has(speaker));
}

function voicePlanReady(plan: Record<string, unknown>): boolean {
  return plan.confirmed === true && ["ready", "confirmed"].includes(String(plan.status));
}

function musicCuePlanReady(run: WorkflowRun): boolean {
  return voicePlanReady(asRecord(activeArtifactData(run, "artifact-cues")));
}

function normalizeLines(value: unknown): LocalScriptLine[] {
  return asArray(value).flatMap((line) => {
    if (typeof line === "string" && line.trim()) return [{ text: line.trim() }];
    const item = asRecord(line);
    if (typeof item.text !== "string" || !item.text.trim()) return [];
    return [{
      ...(typeof item.speaker === "string" && item.speaker.trim() ? { speaker: item.speaker.trim() } : {}),
      text: item.text.trim(),
      ...(typeof item.segmentId === "string" && item.segmentId.trim() ? { segmentId: item.segmentId.trim() } : {}),
      ...(Array.isArray(item.claimIds) ? { claimIds: item.claimIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) } : {}),
      ...(typeof item.delivery === "string" && item.delivery.trim() ? { delivery: item.delivery.trim() } : {}),
      ...(Number.isInteger(item.pauseAfterMs) && Number(item.pauseAfterMs) >= 0 ? { pauseAfterMs: Number(item.pauseAfterMs) } : {}),
    }];
  });
}

function roleResponsibility(name: string, index: number): string {
  if (/事实|核验|研究/.test(name)) return "守住事实边界，指出来源与不确定性";
  if (/挑战|质疑|反方/.test(name)) return "寻找反例，阻止节目过早达成共识";
  if (index === 0) return "维持主问题与节奏，让每一段都兑现听众承诺";
  return "从该角色的专业视角解释影响并回应反驳";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rankMusicAssets(
  assets: Awaited<ReturnType<MusicLibraryStore["list"]>>["assets"],
  targetMood: string,
  targetEnergy: number,
  run: WorkflowRun,
): Array<Record<string, unknown>> {
  const seriesPalette = new Set(run.productionIntent?.sonicPalette ?? []);
  const seriesExclusions = new Set(run.productionIntent?.sonicExclusions ?? []);
  return assets.map((asset) => {
    const tagMatches = asset.tags.filter((tag) => seriesPalette.has(tag)).length;
    const exclusionMatches = asset.tags.filter((tag) => seriesExclusions.has(tag)).length;
    const moodMatch = asset.mood === targetMood;
    const score = Math.max(0, Math.min(100,
      58 + (moodMatch ? 24 : 0) - Math.abs(asset.energy - targetEnergy) * 10 + tagMatches * 5 - exclusionMatches * 30 + (asset.bpm && asset.bpm >= 60 && asset.bpm <= 110 ? 4 : 0),
    ));
    const reasons = [moodMatch ? "情绪匹配" : `情绪为 ${asset.mood}`, `能量 ${asset.energy}`, tagMatches ? `命中 ${tagMatches} 个系列音色标签` : "未命中系列标签", exclusionMatches ? `触发 ${exclusionMatches} 个系列排除标签` : "未触发排除标签"];
    return {
      action: "asset",
      assetId: asset.id,
      title: asset.title,
      mediaUrl: asset.mediaUrl,
      score,
      reason: reasons.join(" · "),
      mood: asset.mood,
      energy: asset.energy,
      ...(asset.bpm ? { bpm: asset.bpm } : {}),
    };
  }).sort((left, right) => Number(right.score) - Number(left.score));
}

function musicActionLabel(action: string): string {
  if (action === "transition") return "转场";
  if (action === "bed") return "铺底";
  if (action === "outro") return "尾声";
  return "留白";
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function probeAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFile("/opt/homebrew/bin/ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], { timeout: 10_000 });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取干声音频时长。");
  return duration;
}

function cueStartSeconds(
  cueId: string,
  totalDuration: number,
  cueDuration: number,
  index: number,
  cueCount: number,
): number {
  const latestStart = Math.max(0, totalDuration - cueDuration);
  if (cueId === "opening") return 0;
  if (cueId === "closing") return latestStart;
  if (cueId === "first-transition") return Math.min(latestStart, totalDuration * 0.33);
  return Math.min(latestStart, totalDuration * ((index + 1) / (cueCount + 1)));
}
