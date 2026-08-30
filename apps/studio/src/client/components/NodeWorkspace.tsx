import type { ExecuteNodeInput, NodeExecutionPreview, RegisterCoverMetadata, RegisterPublicationInput, RegisterReleaseMasterMetadata, ReleaseRightsBasis, StudioBootstrap, VoiceCatalog, WorkflowRun } from "../../shared/api.js";
import { PREVIEW_VOICES } from "../../shared/preview-voices.js";
import type { Artifact, ArtifactVersion, WorkflowNode } from "@token-talk/domain/model";
import { BadgeCheck, ChevronDown, Download, ExternalLink, FileAudio, FileClock, ImagePlus, LoaderCircle, LockKeyhole, Music2, Play, RotateCw, Save, SearchCheck, ShieldCheck, SlidersHorizontal, Upload, WalletCards, Waypoints } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { StudioApi, studioPath } from "../api.js";
import { CastPlanEditor, EpisodeBlueprintEditor, ReleaseCopyEditor, ResearchPlanEditor, ScriptTranscriptEditor } from "./EditorialArtifactEditors.js";

interface NodeWorkspaceProps {
  data: StudioBootstrap;
  run: WorkflowRun;
  node: WorkflowNode;
  onReviseArtifact: (artifactId: string, value: unknown) => Promise<void>;
  onReviewResearchSource?: (artifactId: string, sourceId: string, verified: boolean) => Promise<void>;
  onExecuteNode: (nodeId: string, input?: ExecuteNodeInput) => Promise<void>;
  onLoadExecutionPreview?: (nodeId: string) => Promise<NodeExecutionPreview>;
  onAuthorizeSpend?: (nodeId: string, maxCostCny: number) => Promise<void>;
  onReconcileCost?: (receiptId: string, actualCostCny: number, note: string, providerInvoiceId?: string) => Promise<void>;
  onRegisterReleaseMaster?: ((file: File, metadata: RegisterReleaseMasterMetadata) => Promise<void>) | undefined;
  onRegisterCover?: ((file: File, metadata: RegisterCoverMetadata) => Promise<void>) | undefined;
  onSelectCover?: ((coverId: string) => Promise<void>) | undefined;
  onRegisterPublication?: ((input: RegisterPublicationInput) => Promise<void>) | undefined;
  onNavigateToNode?: ((nodeId: string) => void) | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function NodeWorkspace({ run, node, onReviseArtifact, onReviewResearchSource, onExecuteNode, onLoadExecutionPreview, onAuthorizeSpend, onReconcileCost, onRegisterReleaseMaster, onRegisterCover, onSelectCover, onRegisterPublication, onNavigateToNode, onDirtyChange }: NodeWorkspaceProps) {
  const output = findArtifacts(run, node.outputArtifactIds)[0];
  const productionLocked = run.status === "completed";
  const inputs = findInputVersions(run, node);
  const activeVersion = output?.versions.find((version) => version.id === output.activeVersionId);
  const [draft, setDraft] = useState(formatJson(activeVersion?.data));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [executeState, setExecuteState] = useState<"idle" | "running">("idle");
  const [executingSegmentId, setExecutingSegmentId] = useState<string>();
  const [mediaState, setMediaState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [reviewingSourceId, setReviewingSourceId] = useState<string>();
  const [voicePlanSaving, setVoicePlanSaving] = useState(false);
  const [musicPlanSaving, setMusicPlanSaving] = useState(false);
  const [managedArtifactSaving, setManagedArtifactSaving] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [executionPreview, setExecutionPreview] = useState<NodeExecutionPreview>();
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewLoadFailed, setPreviewLoadFailed] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [spendTermsConfirmed, setSpendTermsConfirmed] = useState(false);
  const [spendAuthorizing, setSpendAuthorizing] = useState(false);
  const [reconcileCost, setReconcileCost] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");
  const [reconcileInvoiceId, setReconcileInvoiceId] = useState("");
  const [reconcileBaseline, setReconcileBaseline] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string>();
  const persistedDraft = formatJson(activeVersion?.data);
  const draftDirty = draft !== persistedDraft;

  useEffect(() => () => onDirtyChange?.(false), [node.id, onDirtyChange]);

  useEffect(() => {
    setDraft(persistedDraft);
    setError(undefined);
    setSaveState("idle");
    setExecuteState("idle");
    setExecutingSegmentId(undefined);
    setMediaState("idle");
    setMediaAttempt(0);
    setReviewingSourceId(undefined);
    setVoicePlanSaving(false);
    setMusicPlanSaving(false);
    setManagedArtifactSaving(false);
    setPreviewDirty(false);
    setSpendTermsConfirmed(false);
    setReconcileCost("");
    setReconcileNote("");
    setReconcileInvoiceId("");
    setReconcileBaseline("");
  }, [activeVersion?.id, node.id, persistedDraft]);

  useEffect(() => {
    let cancelled = false;
    if (!onLoadExecutionPreview) {
      setExecutionPreview(undefined);
      setPreviewLoading(false);
      setPreviewLoadFailed(false);
      return () => { cancelled = true; };
    }
    setPreviewLoading(true);
    setPreviewLoadFailed(false);
    void onLoadExecutionPreview(node.id).then((preview) => {
      if (!cancelled) setExecutionPreview(preview);
    }).catch(() => {
      if (!cancelled) {
        setExecutionPreview(undefined);
        setPreviewLoadFailed(true);
      }
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [node.id, onLoadExecutionPreview, previewAttempt, run.updatedAt]);

  async function saveOutput() {
    if (!output) return;
    try {
      setError(undefined);
      setSaveState("saving");
      const value = JSON.parse(draft) as unknown;
      await onReviseArtifact(output.id, value);
      setSaveState("saved");
    } catch (reason) {
      setSaveState("idle");
      setError(reason instanceof SyntaxError ? "产物必须是有效的 JSON" : "保存失败，请重试");
    }
  }

  async function executeNode(input?: ExecuteNodeInput) {
    try {
      setError(undefined);
      setExecuteState("running");
      setExecutingSegmentId(input?.segmentId);
      if (input?.segmentId) await onExecuteNode(node.id, input);
      else await onExecuteNode(node.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运行失败，请重试");
    } finally {
      setExecuteState("idle");
      setExecutingSegmentId(undefined);
    }
  }

  async function toggleSourceVerification(sourceIndex: number) {
    if (!output) return;
    const sources = asArray(asRecord(activeVersion?.data).sources).map(asRecord);
    const source = sources[sourceIndex];
    if (!source || typeof source.url !== "string" || !source.url.startsWith("https://")) return;
    const sourceId = typeof source.id === "string" ? source.id : `source-${sourceIndex + 1}`;
    try {
      setError(undefined);
      setReviewingSourceId(sourceId);
      if (!onReviewResearchSource) throw new Error("来源核验服务不可用");
      await onReviewResearchSource(output.id, sourceId, source.verificationStatus !== "verified");
    } catch {
      setError("来源核验保存失败，请重试");
    } finally {
      setReviewingSourceId(undefined);
    }
  }

  async function saveVoicePlan(value: Record<string, unknown>) {
    if (!output) return;
    try {
      setError(undefined);
      setVoicePlanSaving(true);
      await onReviseArtifact(output.id, { ...value, status: "ready", confirmed: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "声音配置保存失败，请重试");
    } finally {
      setVoicePlanSaving(false);
    }
  }

  async function saveMusicPlan(value: Record<string, unknown>) {
    if (!output) return;
    try {
      setError(undefined);
      setMusicPlanSaving(true);
      await onReviseArtifact(output.id, { ...value, status: "ready", confirmed: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "音乐配置保存失败，请重试");
    } finally {
      setMusicPlanSaving(false);
    }
  }

  async function saveManagedArtifact(value: Record<string, unknown>) {
    if (!output) return;
    try {
      setError(undefined);
      setManagedArtifactSaving(true);
      await onReviseArtifact(output.id, value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "内容保存失败，请重试");
    } finally {
      setManagedArtifactSaving(false);
    }
  }

  async function authorizeSpend() {
    if (!executionPreview || !spendTermsConfirmed || !onAuthorizeSpend || !onLoadExecutionPreview) return;
    try {
      setError(undefined);
      setSpendAuthorizing(true);
      await onAuthorizeSpend(node.id, executionPreview.estimatedCostCny);
      setExecutionPreview(await onLoadExecutionPreview(node.id));
      setSpendTermsConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "成本授权失败，请重试");
    } finally {
      setSpendAuthorizing(false);
    }
  }

  async function submitReconciliation() {
    if (!unresolvedReceipt || !onReconcileCost || !onLoadExecutionPreview) return;
    try {
      setError(undefined);
      setReconciling(true);
      await onReconcileCost(unresolvedReceipt.id, Number(reconcileCost), reconcileNote.trim(), reconcileInvoiceId.trim() || undefined);
      setExecutionPreview(await onLoadExecutionPreview(node.id));
      setReconcileNote("");
      setReconcileInvoiceId("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "成本对账失败，请重试");
    } finally {
      setReconciling(false);
    }
  }

  const isRunning = executeState === "running" || node.status === "running";
  const spendBlocked = executionPreview?.billing === "metered"
    && (executionPreview.authorization !== "active" || executionPreview.blocker === "unreconciled_cost");
  const executionPreviewUnknown = node.capability === "audio.render" && (previewLoading || previewLoadFailed);
  const blockingNodes = findBlockingNodes(run, node);
  const executable = !productionLocked && !["pending", "running", "awaiting_spend_approval"].includes(node.status) && blockingNodes.length === 0 && !spendBlocked && !executionPreviewUnknown;
  const mediaPreview = output && ["audio.master", "audio-master"].includes(output.kind) ? audioMediaPreview(activeVersion?.data) : undefined;
  const structuredEditingAllowed = Boolean(!productionLocked && output && !["audio.master", "audio-master", "visual.pack", "visual-pack", "publish.package", "publish-package"].includes(output.kind));
  const previewOwnsEditing = Boolean(output && ["research.plan", "voice.plan", "voice-plan", "music.cue-sheet", "music-cue-sheet", "cast.plan", "cast-plan", "episode.blueprint", "episode-blueprint", "script.segment", "segment", "script.assembled", "episode-script", "release.copy", "visual.pack", "visual-pack"].includes(output.kind));
  const lockedScriptSegments = asArray(asRecord(activeVersion?.data).lockedSegmentIds).filter((value): value is string => typeof value === "string");
  const wholeScriptRerunBlocked = node.capability === "script.segment" && lockedScriptSegments.length > 0;
  const registrationAllowed = !productionLocked && assetRegistrationReady(run, node);
  const latestReceipt = [...run.executionReceipts].reverse().find((receipt) => receipt.nodeId === node.id);
  const unresolvedReceipt = run.executionReceipts.find((receipt) => receipt.billing === "metered" && receipt.status !== "running" && receipt.actualCostCny === undefined);
  const localControlsDirty = previewDirty
    || spendTermsConfirmed
    || reconcileCost !== reconcileBaseline
    || Boolean(reconcileNote.trim())
    || Boolean(reconcileInvoiceId.trim());

  useEffect(() => {
    onDirtyChange?.(draftDirty || localControlsDirty);
  }, [draftDirty, localControlsDirty, onDirtyChange]);

  useEffect(() => {
    const baseline = unresolvedReceipt?.estimatedCostCny.toFixed(2) ?? "";
    setReconcileBaseline(baseline);
    setReconcileCost(baseline);
    setReconcileNote("");
    setReconcileInvoiceId("");
  }, [unresolvedReceipt?.id, unresolvedReceipt?.estimatedCostCny]);

  return (
      <article className="node-workspace">
        <header className="node-workspace-header">
          <div>
            <p className="eyebrow">当前任务</p>
            <h2>{node.label}</h2>
            <p>{node.role} 负责这一制作步骤</p>
          </div>
          <div className="node-run-actions">
            <span className={`node-status-label ${node.status}`}>{isRunning ? "执行中" : statusLabel(node.status)}</span>
            <button className="primary-command node-run-command" type="button" disabled={!executable || isRunning || wholeScriptRerunBlocked} onClick={() => void executeNode()}>
              {productionLocked ? <LockKeyhole size={15} aria-hidden="true" /> : isRunning ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : node.status === "succeeded" || node.status === "stale" ? <RotateCw size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              {productionLocked ? "已锁定" : isRunning ? "正在运行" : wholeScriptRerunBlocked ? "请按章节重生成" : executionLabel(node)}
            </button>
          </div>
        </header>

        {productionLocked ? <div className="published-lock-callout" role="status"><LockKeyhole size={17} /><div><strong>本集制作已锁定</strong><span>当前内容与外部发布记录已绑定；可继续查看制作记录，修订请新建一期。</span></div></div> : null}

        {node.staleReason && (
          <div className="stale-callout" role="status">
            <Waypoints size={17} aria-hidden="true" />
            <div><strong>产物已失效</strong><span>{node.staleReason}</span></div>
          </div>
        )}

        {node.lastError && (
          <div className="execution-error" role="alert">
            <strong>执行没有完成</strong>
            <span>{node.lastError}</span>
          </div>
        )}

        {node.status === "pending" && blockingNodes.length > 0 ? (
          <div className="blocked-node-callout" role="status">
            <Waypoints size={17} aria-hidden="true" />
            <div><strong>这一步还在等待</strong><span>先完成：{blockingNodes.map((candidate) => candidate.label).join("、")}</span></div>
            {onNavigateToNode ? <button className="secondary-command" type="button" onClick={() => onNavigateToNode(blockingNodes[0]!.id)}>前往 {blockingNodes[0]!.label}</button> : null}
          </div>
        ) : null}


        {!productionLocked && executionPreview?.billing === "metered" ? (
          <section className={`spend-authorization ${executionPreview.authorization}`} aria-label="本次付费执行授权">
            <header>
              <span><WalletCards size={17} aria-hidden="true" /><strong>本次声音生成</strong></span>
              <em>{executionPreview.blocker === "unreconciled_cost" ? "费用待对账" : executionPreview.authorization === "active" ? <><BadgeCheck size={15} />已授权</> : executionPreview.authorization === "exhausted" ? "授权已使用" : "需要确认"}</em>
            </header>
            <dl>
              <div><dt>执行方式</dt><dd>发行声音合成</dd></div>
              <div><dt>当前预估</dt><dd>¥{executionPreview.estimatedCostCny.toFixed(2)}</dd></div>
              <div><dt>本集剩余</dt><dd>¥{executionPreview.remainingBudgetCny.toFixed(2)}</dd></div>
              <div><dt>尝试次数</dt><dd>{executionPreview.attemptsUsed}/{executionPreview.maxAttempts ?? 1}</dd></div>
            </dl>
            {executionPreview.blocker === "unreconciled_cost" ? <div className="cost-reconciliation"><p>上一笔付费执行的实际成本未知，核对供应商账单前不会再次调用。</p>{unresolvedReceipt && onReconcileCost ? <div><label><span>账单实际成本</span><input aria-label="账单实际成本" type="number" min="0" max="10000" step="0.01" value={reconcileCost} onChange={(event) => setReconcileCost(event.target.value)} /></label><label><span>对账说明</span><input aria-label="对账说明" maxLength={500} value={reconcileNote} placeholder="例如：供应商后台本次请求账单" onChange={(event) => setReconcileNote(event.target.value)} /></label><label><span>账单号</span><input aria-label="供应商账单号" maxLength={160} value={reconcileInvoiceId} placeholder="可选" onChange={(event) => setReconcileInvoiceId(event.target.value)} /></label><button className="primary-command" type="button" disabled={reconciling || reconcileNote.trim().length < 3 || !Number.isFinite(Number(reconcileCost)) || Number(reconcileCost) < 0} onClick={() => void submitReconciliation()}>{reconciling ? "保存中" : "完成对账"}</button></div> : null}</div> : executionPreview.authorization !== "active" ? <div className="spend-confirmation">
              <label><input type="checkbox" checked={spendTermsConfirmed} onChange={(event) => setSpendTermsConfirmed(event.target.checked)} /><span>确认当前脚本与角色声音已获授权，并批准一次不超过 ¥{executionPreview.estimatedCostCny.toFixed(2)} 的生成</span></label>
              <button className="primary-command" type="button" disabled={!spendTermsConfirmed || spendAuthorizing || executionPreview.estimatedCostCny > executionPreview.remainingBudgetCny} onClick={() => void authorizeSpend()}>{spendAuthorizing ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}{spendAuthorizing ? "授权中" : "授权本次生成"}</button>
            </div> : <p>授权仅适用于当前输入版本，脚本或声音选择变化后自动失效。</p>}
          </section>
        ) : previewLoading && node.capability === "audio.render" ? <div className="execution-preview-loading"><LoaderCircle className="is-spinning" size={15} />正在核对声音成本</div> : previewLoadFailed && node.capability === "audio.render" ? <div className="execution-preview-loading" role="alert"><span>声音成本状态读取失败</span><button className="secondary-command" type="button" onClick={() => setPreviewAttempt((value) => value + 1)}><RotateCw size={14} />重新核对</button></div> : null}

        <section className="artifact-editor" aria-label="制作草稿">
          <div className="workspace-section-heading">
            <div>
              <span>{output ? structuredEditingAllowed ? "制作草稿" : "发行资产" : "审核确认"}</span>
              <small>{output ? artifactLabel(output.kind) : "等待自动审计结果"}</small>
            </div>
            {structuredEditingAllowed && !previewOwnsEditing && (
              <button className="secondary-command" type="button" onClick={saveOutput} disabled={saveState === "saving"}>
                <Save size={15} aria-hidden="true" />
                {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存新版本"}
              </button>
            )}
          </div>
          {output ? (
            <>
              {mediaPreview ? <div className={`audio-preview ${mediaState}`}>
                <span>{mediaPreview.releaseReady ? "发行试听" : "桌读预听"}</span>
                {mediaState === "error" ? <div className="audio-preview-error" role="alert"><span>音频载入失败</span><button className="secondary-command" type="button" onClick={() => { setMediaState("idle"); setMediaAttempt((value) => value + 1); }}><RotateCw size={15} />重新载入</button></div> : <audio key={`${mediaPreview.url}-${mediaAttempt}`} controls preload="metadata" src={mediaPreview.url} onLoadStart={() => setMediaState("loading")} onLoadedMetadata={() => setMediaState("ready")} onError={() => setMediaState("error")}>当前浏览器无法播放音频。</audio>}
                <small>{mediaState === "loading" ? "正在读取音频信息…" : mediaPreview.releaseReady ? "已通过发行检查的节目音频。" : "用于检查结构、节奏和错字，不是发行母带。"}</small>
              </div> : null}
              <ArtifactPreview
                runId={run.id}
                releasePackageAvailable={["release_ready", "completed"].includes(run.status) && node.status === "succeeded"}
                publicationRecords={run.publicationRecords}
                kind={output.kind}
                readOnly={productionLocked}
                value={activeVersion?.data}
                reviewingSourceId={reviewingSourceId}
                onToggleSourceVerification={(sourceIndex) => void toggleSourceVerification(sourceIndex)}
                voicePlanSaving={voicePlanSaving}
                onSaveVoicePlan={(value) => void saveVoicePlan(value)}
                musicPlanSaving={musicPlanSaving}
                onSaveMusicPlan={(value) => void saveMusicPlan(value)}
                managedArtifactSaving={managedArtifactSaving}
                onSaveManagedArtifact={(value) => void saveManagedArtifact(value)}
                scriptSegmentLabels={blueprintSegmentLabels(run)}
                regeneratingSegmentId={executingSegmentId}
                onRegenerateScriptSegment={node.capability === "script.segment" && executable ? (segmentId) => void executeNode({ segmentId }) : undefined}
                onRegisterReleaseMaster={registrationAllowed ? onRegisterReleaseMaster : undefined}
                onRegisterCover={registrationAllowed ? onRegisterCover : undefined}
                onSelectCover={productionLocked ? undefined : onSelectCover}
                onRegisterPublication={onRegisterPublication}
                blockedBy={blockingNodes.map((candidate) => candidate.label)}
                onDirtyChange={setPreviewDirty}
              />
              {structuredEditingAllowed && !previewOwnsEditing ? <details className="advanced-artifact"><summary>高级：编辑结构化数据</summary><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`${node.label}结构化数据`} spellCheck={false} /></details> : null}
            </>
          ) : <div className="no-output">完成检查后，在右上角确认这一步。</div>}
          {error && <p className="field-error" role="alert">{error}</p>}
        </section>

        <details className="production-audit">
          <summary><FileClock size={16} />制作记录与技术详情<ChevronDown size={16} /></summary>
          <div className="production-audit-grid">
            <section>
              <div className="inspector-heading"><SlidersHorizontal size={16} /><h3>本集约束</h3></div>
              <dl><InspectorRow label="负责角色" value={node.role} /><InspectorRow label="目标时长" value={run.productionIntent ? `${run.productionIntent.targetMinutes} 分钟` : "按节目模板"} /><InspectorRow label="音乐策略" value={musicPolicyLabel(run.productionIntent?.musicPolicy)} /><InspectorRow label="现金上限" value={run.productionIntent ? `¥${run.productionIntent.maxCostCny.toFixed(2)}` : "尚未设置"} /></dl>
            </section>
            <section>
              <div className="inspector-heading"><Play size={16} /><h3>最近执行</h3></div>
              {latestReceipt ? <dl><InspectorRow label="状态" value={receiptStatusLabel(latestReceipt.status)} /><InspectorRow label="预估成本" value={`¥${latestReceipt.estimatedCostCny.toFixed(2)}`} /><InspectorRow label="实际成本" value={latestReceipt.actualCostCny === undefined ? "待对账" : `¥${latestReceipt.actualCostCny.toFixed(2)}`} /><InspectorRow label="执行器" value={latestReceipt.providerId} /><InspectorRow label="模型 / 配方" value={latestReceipt.modelId} /></dl> : <p>这个步骤还没有执行记录。</p>}
            </section>
            <section className="audit-inputs">
              <div className="inspector-heading"><FileClock size={16} /><h3>上游版本</h3></div>
              {inputs.length ? <div className="version-list">{inputs.map(({ artifact, version }) => <div key={artifact.id}><FileClock size={15} aria-hidden="true" /><span><strong>{artifactLabel(artifact.kind)}</strong><small>{version.id}</small>{version.id !== artifact.activeVersionId ? <em>当前 {artifact.activeVersionId}</em> : null}</span><code>{version.sha256.slice(0, 8)}</code></div>)}</div> : <p>此步骤没有上游输入。</p>}
            </section>
            <section>
              <div className="inspector-heading"><ShieldCheck size={16} /><h3>发布检查</h3></div>
              <strong className="rights-state">发布前核验</strong>
              <p>{node.capability === "voice.synthesize" ? "声音试演必须保存授权、使用范围和最终选择。" : "来源、音乐和视觉资产会在发布包中统一检查授权状态。"}</p>
            </section>
          </div>
        </details>
      </article>
  );
}

function findArtifacts(run: WorkflowRun, artifactIds: string[]): Artifact[] {
  return artifactIds.flatMap((id) => {
    const artifact = run.artifacts.find((candidate) => candidate.id === id);
    return artifact ? [artifact] : [];
  });
}

function blueprintSegmentLabels(run: WorkflowRun): Record<string, string> {
  const artifact = run.artifacts.find((candidate) => candidate.id === "artifact-blueprint");
  const version = artifact?.versions.find((candidate) => candidate.id === artifact.activeVersionId);
  return Object.fromEntries(asArray(asRecord(version?.data).segments).flatMap((item) => {
    const segment = asRecord(item);
    return typeof segment.id === "string" && typeof segment.title === "string" ? [[segment.id, segment.title]] : [];
  }));
}

function findInputVersions(
  run: WorkflowRun,
  node: WorkflowNode,
): Array<{ artifact: Artifact; version: ArtifactVersion }> {
  return node.inputArtifactIds.flatMap((artifactId, index) => {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return [];
    const consumedVersionId = node.inputVersionIds[index];
    const version = artifact.versions.find((candidate) => candidate.id === consumedVersionId);
    return version ? [{ artifact, version }] : [];
  });
}

function formatJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function receiptStatusLabel(status: WorkflowRun["executionReceipts"][number]["status"]): string {
  return ({ running: "执行中", succeeded: "已完成", failed: "失败", needs_human: "待核对", rejected: "已拒绝" })[status];
}

function statusLabel(status: WorkflowNode["status"]): string {
  return {
    pending: "等待",
    ready: "可执行",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    needs_human: "待核对",
    stale: "需要重跑",
    awaiting_spend_approval: "等待成本授权",
  }[status];
}

function ArtifactPreview({
  runId,
  releasePackageAvailable,
  publicationRecords,
  kind,
  readOnly,
  value,
  reviewingSourceId,
  onToggleSourceVerification,
  voicePlanSaving,
  onSaveVoicePlan,
  musicPlanSaving,
  onSaveMusicPlan,
  managedArtifactSaving,
  onSaveManagedArtifact,
  scriptSegmentLabels,
  regeneratingSegmentId,
  onRegenerateScriptSegment,
  onRegisterReleaseMaster,
  onRegisterCover,
  onSelectCover,
  onRegisterPublication,
  blockedBy,
  onDirtyChange,
}: {
  runId: string;
  releasePackageAvailable: boolean;
  publicationRecords: WorkflowRun["publicationRecords"];
  kind: string;
  readOnly: boolean;
  value: unknown;
  reviewingSourceId: string | undefined;
  onToggleSourceVerification: (sourceIndex: number) => void;
  voicePlanSaving: boolean;
  onSaveVoicePlan: (value: Record<string, unknown>) => void;
  musicPlanSaving: boolean;
  onSaveMusicPlan: (value: Record<string, unknown>) => void;
  managedArtifactSaving: boolean;
  onSaveManagedArtifact: (value: Record<string, unknown>) => void;
  scriptSegmentLabels: Record<string, string>;
  regeneratingSegmentId: string | undefined;
  onRegenerateScriptSegment?: ((segmentId: string) => void) | undefined;
  onRegisterReleaseMaster?: ((file: File, metadata: RegisterReleaseMasterMetadata) => Promise<void>) | undefined;
  onRegisterCover?: ((file: File, metadata: RegisterCoverMetadata) => Promise<void>) | undefined;
  onSelectCover?: ((coverId: string) => Promise<void>) | undefined;
  onRegisterPublication?: ((input: RegisterPublicationInput) => Promise<void>) | undefined;
  blockedBy: string[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  if (!value || typeof value !== "object") return <p className="artifact-preview-empty">暂无草稿内容。</p>;
  if (["research.packet", "source-packet"].includes(kind)) {
    return <ResearchPacketPreview value={value} reviewingSourceId={reviewingSourceId} onToggleVerification={onToggleSourceVerification} readOnly={readOnly} />;
  }
  if (kind === "research.plan") {
    return <ResearchPlanEditor value={value} saving={managedArtifactSaving} onSave={onSaveManagedArtifact} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (["voice.plan", "voice-plan"].includes(kind)) {
    return <VoicePlanPreview value={value} saving={voicePlanSaving} onSave={onSaveVoicePlan} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (["music.cue-sheet", "music-cue-sheet"].includes(kind)) {
    return <MusicPlanPreview value={value} saving={musicPlanSaving} onSave={onSaveMusicPlan} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (["cast.plan", "cast-plan"].includes(kind)) {
    return <CastPlanEditor value={value} saving={managedArtifactSaving} onSave={onSaveManagedArtifact} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (["episode.blueprint", "episode-blueprint"].includes(kind)) {
    return <EpisodeBlueprintEditor value={value} saving={managedArtifactSaving} onSave={onSaveManagedArtifact} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (kind === "release.copy") {
    return <ReleaseCopyEditor value={value} saving={managedArtifactSaving} onSave={onSaveManagedArtifact} onDirtyChange={onDirtyChange} readOnly={readOnly} />;
  }
  if (["script.segment", "segment", "script.assembled", "episode-script"].includes(kind)) {
    return <ScriptTranscriptEditor value={value} saving={managedArtifactSaving} onSave={onSaveManagedArtifact} onDirtyChange={onDirtyChange} readOnly={readOnly} segmentLabels={scriptSegmentLabels} regeneratingSegmentId={regeneratingSegmentId} onRegenerateSegment={onRegenerateScriptSegment} />;
  }
  if (["audio.master", "audio-master"].includes(kind)) {
    return <ReleaseMasterWorkbench value={value} onRegister={onRegisterReleaseMaster} blockedBy={blockedBy} onDirtyChange={onDirtyChange} />;
  }
  if (["visual.pack", "visual-pack"].includes(kind)) {
    return <VisualPackWorkbench value={value} briefSaving={managedArtifactSaving} readOnly={readOnly} onSaveBrief={onSaveManagedArtifact} onRegister={onRegisterCover} onSelect={onSelectCover} blockedBy={blockedBy} onDirtyChange={onDirtyChange} />;
  }
  if (["publish.package", "publish-package"].includes(kind)) {
    return <PublishPackagePreview runId={runId} value={value} available={releasePackageAvailable} records={publicationRecords} onRegister={onRegisterPublication} onDirtyChange={onDirtyChange} />;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
  return <dl className="artifact-preview">{entries.map(([key, item]) => <div key={key}><dt>{humanizeKey(key)}</dt><dd>{previewValue(item)}</dd></div>)}</dl>;
}

function ReleaseMasterWorkbench({ value, onRegister, blockedBy, onDirtyChange }: { value: unknown; onRegister?: ((file: File, metadata: RegisterReleaseMasterMetadata) => Promise<void>) | undefined; blockedBy: string[]; onDirtyChange: (dirty: boolean) => void }) {
  const data = asRecord(value);
  const rights = asRecord(data.rights);
  const audioQc = asRecord(data.audioQc);
  const [file, setFile] = useState<File>();
  const [rightsOwner, setRightsOwner] = useState("");
  const [licenseBasis, setLicenseBasis] = useState<ReleaseRightsBasis>("owned");
  const [sourceUrl, setSourceUrl] = useState("");
  const [commercialUseConfirmed, setCommercialUseConfirmed] = useState(false);
  const [voiceConsentConfirmed, setVoiceConsentConfirmed] = useState(false);
  const [musicRightsConfirmed, setMusicRightsConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [fileInputKey, setFileInputKey] = useState(0);
  const externalBasis = licenseBasis === "licensed" || licenseBasis === "generated";
  const canSubmit = Boolean(file && rightsOwner.trim() && commercialUseConfirmed && voiceConsentConfirmed && musicRightsConfirmed && (!externalBasis || safeExternalUrl(sourceUrl)) && onRegister);
  const dirty = Boolean(file || rightsOwner || sourceUrl || licenseBasis !== "owned" || commercialUseConfirmed || voiceConsentConfirmed || musicRightsConfirmed);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !onRegister || !canSubmit) return;
    try {
      setSaving(true);
      setError(undefined);
      await onRegister(file, {
        rightsOwner: rightsOwner.trim(),
        licenseBasis,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        commercialUseConfirmed: true,
        voiceConsentConfirmed: true,
        musicRightsConfirmed: true,
      });
      setFile(undefined);
      setRightsOwner("");
      setLicenseBasis("owned");
      setSourceUrl("");
      setCommercialUseConfirmed(false);
      setVoiceConsentConfirmed(false);
      setMusicRightsConfirmed(false);
      setFileInputKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发行母带登记失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return <section className="release-asset-workbench audio-master-workbench">
    <header>
      <span><FileAudio size={16} />发行母带</span>
      <strong className={data.releaseReady === true ? "ready" : "pending"}>{data.releaseReady === true ? "已登记" : "尚未登记"}</strong>
    </header>
    {data.releaseReady === true ? <div className="registered-asset-summary"><span><strong>{formatDuration(data.durationSeconds)}</strong><small>{String(data.mimeType ?? "节目音频")} · {formatBytes(data.bytes)}</small></span><span><strong>{formatLoudness(audioQc.integratedLoudnessLufs)}</strong><small>{formatTruePeak(audioQc.truePeakDbtp)} · {String(audioQc.sampleRate ?? "-")} Hz</small></span><span><strong>{String(rights.owner ?? "已登记权利人")}</strong><small>{releaseBasisLabel(rights.basis)} · 已确认商用</small></span></div> : <p className="release-asset-context">当前音频仍用于桌读或制作检查。发布前需要登记可发行的完整混音文件。</p>}
    {onRegister ? <form onSubmit={(event) => void submit(event)}>
      <label className="release-file-picker"><span><Upload size={16} />{file ? file.name : "选择 MP3、WAV 或 M4A"}</span><small>完整节目母带，最大 256MB</small><input key={fileInputKey} aria-label="选择发行母带" type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" onChange={(event) => setFile(event.target.files?.[0])} /></label>
      <div className="release-rights-grid">
        <label><span>权利人或授权主体</span><input aria-label="权利人或授权主体" value={rightsOwner} maxLength={120} onChange={(event) => setRightsOwner(event.target.value)} /></label>
        <label><span>许可依据</span><select aria-label="发行母带许可依据" value={licenseBasis} onChange={(event) => setLicenseBasis(event.target.value as ReleaseRightsBasis)}>{releaseBasisOptions()}</select></label>
        {externalBasis ? <label className="release-source-field"><span>授权或服务条款链接</span><input aria-label="发行母带授权来源" type="url" value={sourceUrl} placeholder="https://" onChange={(event) => setSourceUrl(event.target.value)} /></label> : null}
      </div>
      <div className="release-confirmations">
        <label><input type="checkbox" checked={voiceConsentConfirmed} onChange={(event) => setVoiceConsentConfirmed(event.target.checked)} /><span>本集全部音色和声音复刻已获授权</span></label>
        <label><input type="checkbox" checked={musicRightsConfirmed} onChange={(event) => setMusicRightsConfirmed(event.target.checked)} /><span>本集音乐和音效可进入商业发行</span></label>
        <label><input type="checkbox" checked={commercialUseConfirmed} onChange={(event) => setCommercialUseConfirmed(event.target.checked)} /><span>确认该母带可由 Token Talk 商业发布</span></label>
      </div>
      <footer><span>{error ?? "登记后会生成新版本，并自动重新运行成片质量审计。"}</span><button className="primary-command" type="submit" disabled={!canSubmit || saving}>{saving ? <LoaderCircle className="is-spinning" size={15} /> : <Upload size={15} />}{saving ? "正在登记" : "登记发行母带"}</button></footer>
    </form> : <div className="release-asset-waiting"><Waypoints size={16} /><span>{blockedBy.length ? `先完成${blockedBy.join("、")}，再登记发行母带。` : "完成上游内容与审核后，母带登记会在这里开放。"}</span></div>}
  </section>;
}

function VisualPackWorkbench({ value, briefSaving, readOnly, onSaveBrief, onRegister, onSelect, blockedBy, onDirtyChange }: { value: unknown; briefSaving: boolean; readOnly: boolean; onSaveBrief: (value: Record<string, unknown>) => void; onRegister?: ((file: File, metadata: RegisterCoverMetadata) => Promise<void>) | undefined; onSelect?: ((coverId: string) => Promise<void>) | undefined; blockedBy: string[]; onDirtyChange: (dirty: boolean) => void }) {
  const data = asRecord(value);
  const covers = asArray(data.covers).map(asRecord).filter((cover) => typeof cover.mediaUrl === "string" && cover.mediaUrl.startsWith("/media/"));
  const persistedBrief = JSON.stringify({ coverBrief: data.coverBrief, chapterArtBriefs: data.chapterArtBriefs });
  const [coverBrief, setCoverBrief] = useState<Record<string, unknown>>(() => structuredClone(asRecord(data.coverBrief)));
  const [chapterArtBriefs, setChapterArtBriefs] = useState<Array<Record<string, unknown>>>(() => structuredClone(asArray(data.chapterArtBriefs).map(asRecord)));
  const [file, setFile] = useState<File>();
  const [altText, setAltText] = useState("");
  const [rightsOwner, setRightsOwner] = useState("");
  const [licenseBasis, setLicenseBasis] = useState<ReleaseRightsBasis>("owned");
  const [sourceUrl, setSourceUrl] = useState("");
  const [commercialUseConfirmed, setCommercialUseConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectingId, setSelectingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [fileInputKey, setFileInputKey] = useState(0);
  const selectedCoverId = typeof data.selectedCoverId === "string" ? data.selectedCoverId : undefined;
  const externalBasis = licenseBasis === "licensed" || licenseBasis === "generated";
  const canSubmit = Boolean(file && altText.trim().length >= 3 && rightsOwner.trim() && commercialUseConfirmed && (!externalBasis || safeExternalUrl(sourceUrl)) && onRegister);
  const briefDirty = JSON.stringify({ coverBrief, chapterArtBriefs }) !== persistedBrief;
  const dirty = briefDirty || Boolean(file || altText || rightsOwner || sourceUrl || licenseBasis !== "owned" || commercialUseConfirmed);

  useEffect(() => {
    setCoverBrief(structuredClone(asRecord(data.coverBrief)));
    setChapterArtBriefs(structuredClone(asArray(data.chapterArtBriefs).map(asRecord)));
  }, [persistedBrief]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !onRegister || !canSubmit) return;
    try {
      setSaving(true);
      setError(undefined);
      await onRegister(file, {
        altText: altText.trim(),
        rightsOwner: rightsOwner.trim(),
        licenseBasis,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        commercialUseConfirmed: true,
      });
      setFile(undefined);
      setAltText("");
      setRightsOwner("");
      setLicenseBasis("owned");
      setSourceUrl("");
      setCommercialUseConfirmed(false);
      setFileInputKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "单集封面登记失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  async function selectCover(coverId: string) {
    if (!onSelect || coverId === selectedCoverId) return;
    try {
      setSelectingId(coverId);
      setError(undefined);
      await onSelect(coverId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发行封面选择失败，请重试");
    } finally {
      setSelectingId(undefined);
    }
  }

  return <section className="release-asset-workbench visual-pack-workbench">
    <header><span><ImagePlus size={16} />单集封面</span><strong className={selectedCoverId ? "ready" : "pending"}>{selectedCoverId ? "发行封面已选定" : covers.length > 0 ? `${covers.length} 张待选择` : "等待视觉编辑"}</strong></header>
    {Object.keys(coverBrief).length > 0 ? <div className="visual-brief-editor">
      <header><span>封面视觉 Brief</span><small>{chapterArtBriefs.length} 张章节图</small></header>
      <label><span>核心概念</span><textarea rows={2} disabled={readOnly} value={String(coverBrief.concept ?? "")} onChange={(event) => setCoverBrief((current) => ({ ...current, concept: event.target.value }))} /></label>
      <label><span>图像提示词</span><textarea rows={3} disabled={readOnly} value={String(coverBrief.imagePrompt ?? "")} onChange={(event) => setCoverBrief((current) => ({ ...current, imagePrompt: event.target.value }))} /></label>
      <label><span>无障碍描述</span><input disabled={readOnly} maxLength={240} value={String(coverBrief.altText ?? "")} onChange={(event) => setCoverBrief((current) => ({ ...current, altText: event.target.value }))} /></label>
      {chapterArtBriefs.length > 0 ? <ol>{chapterArtBriefs.map((brief, index) => <li key={String(brief.segmentId ?? index)}><strong>{String(brief.title ?? `第 ${index + 1} 章`)}</strong><label><span>章节视觉概念</span><input disabled={readOnly} value={String(brief.concept ?? "")} onChange={(event) => setChapterArtBriefs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, concept: event.target.value } : item))} /></label><label><span>章节图提示词</span><textarea rows={2} disabled={readOnly} value={String(brief.imagePrompt ?? "")} onChange={(event) => setChapterArtBriefs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, imagePrompt: event.target.value } : item))} /></label></li>)}</ol> : null}
      {!readOnly ? <footer><button className="primary-command" type="button" disabled={!briefDirty || briefSaving} onClick={() => onSaveBrief({ ...data, status: "brief_ready", coverBrief, chapterArtBriefs })}><Save size={15} />{briefSaving ? "保存中" : "保存视觉 Brief"}</button></footer> : null}
    </div> : typeof data.direction === "string" ? <p className="visual-direction">{data.direction}</p> : null}
    {covers.length > 0 ? <div className="cover-candidate-grid">{covers.map((cover) => {
      const coverId = String(cover.id ?? "");
      const selected = coverId === selectedCoverId;
      return <figure className={selected ? "selected" : ""} key={coverId || String(cover.mediaUrl)}><img src={studioPath(String(cover.mediaUrl))} alt={String(cover.altText ?? "单集封面候选")} /><figcaption><span><strong>{Number(cover.width)}×{Number(cover.height)}</strong><small>{String(cover.altText ?? "已登记封面")}</small></span><button className={selected ? "cover-selected-command" : "secondary-command"} type="button" disabled={selected || !onSelect || selectingId === coverId} onClick={() => void selectCover(coverId)}>{selected ? <><BadgeCheck size={14} />发行封面</> : selectingId === coverId ? "选择中" : "设为发行封面"}</button></figcaption></figure>;
    })}</div> : null}
    {onRegister ? <form onSubmit={(event) => void submit(event)}>
      <label className="release-file-picker"><span><Upload size={16} />{file ? file.name : "选择 JPG 或 PNG"}</span><small>正方形 1400–3000px，不含透明通道</small><input key={fileInputKey} aria-label="选择单集封面" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={(event) => setFile(event.target.files?.[0])} /></label>
      <div className="release-rights-grid">
        <label className="release-source-field"><span>封面内容描述</span><input aria-label="封面内容描述" value={altText} maxLength={240} onChange={(event) => setAltText(event.target.value)} /></label>
        <label><span>权利人或授权主体</span><input aria-label="封面权利人或授权主体" value={rightsOwner} maxLength={120} onChange={(event) => setRightsOwner(event.target.value)} /></label>
        <label><span>许可依据</span><select aria-label="单集封面许可依据" value={licenseBasis} onChange={(event) => setLicenseBasis(event.target.value as ReleaseRightsBasis)}>{releaseBasisOptions()}</select></label>
        {externalBasis ? <label className="release-source-field"><span>授权或生成服务条款链接</span><input aria-label="单集封面授权来源" type="url" value={sourceUrl} placeholder="https://" onChange={(event) => setSourceUrl(event.target.value)} /></label> : null}
      </div>
      <label className="single-rights-confirmation"><input type="checkbox" checked={commercialUseConfirmed} onChange={(event) => setCommercialUseConfirmed(event.target.checked)} /><span>确认图片、字体、人物肖像及生成服务条款允许商业播客使用</span></label>
      <footer><span>{error ?? "登记后进入候选区，由主编明确选为发行封面。"}</span><button className="primary-command" type="submit" disabled={!canSubmit || saving}>{saving ? <LoaderCircle className="is-spinning" size={15} /> : <Upload size={15} />}{saving ? "正在登记" : "登记单集封面"}</button></footer>
    </form> : <div className="release-asset-waiting"><Waypoints size={16} /><span>{blockedBy.length ? `先完成${blockedBy.join("、")}，再登记单集封面。` : "完成前置制作后，封面登记会在这里开放。"}</span></div>}
  </section>;
}

function PublishPackagePreview({ runId, value, available, records, onRegister, onDirtyChange }: {
  runId: string;
  value: unknown;
  available: boolean;
  records: WorkflowRun["publicationRecords"];
  onRegister?: ((input: RegisterPublicationInput) => Promise<void>) | undefined;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const data = asRecord(value);
  const blockers = asArray(data.blockers).filter((item): item is string => typeof item === "string");
  const transcript = asRecord(data.transcript);
  const chapters = asArray(data.chapters);
  const sources = asArray(data.sources);
  if (data.releaseReady === true && available) return <div className="publish-package-stack">
    <div className="publish-readiness ready"><ShieldCheck size={19} /><div className="release-package-summary"><strong>发布包已就绪</strong><span>发行母带、单集封面、逐字稿、章节、来源与自动成片审计已锁定。</span><div className="release-package-facts"><span>{Number(transcript.lineCount) || 0} 句逐字稿</span><span>{chapters.length} 个章节</span><span>{sources.length} 个已核验来源</span><span>母带与封面校验值已登记</span></div></div><a className="secondary-command release-package-download" href={studioPath(`/api/runs/${encodeURIComponent(runId)}/release-package`)} download><Download size={15} />下载发行清单</a></div>
    <PublicationLedger records={records} onRegister={onRegister} onDirtyChange={onDirtyChange} />
  </div>;
  if (data.releaseReady === true) return <div className="publish-readiness blocked"><Waypoints size={19} /><div><strong>发布包已失效</strong><span>上游内容或自动成片审计已经更新，请重新运行发布检查后再下载。</span></div></div>;
  return <div className="publish-readiness blocked"><Waypoints size={19} /><div><strong>还不能发布</strong>{blockers.length > 0 ? <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <span>运行发布检查后，这里会列出需要完成的事项。</span>}</div></div>;
}

function PublicationLedger({ records, onRegister, onDirtyChange }: {
  records: WorkflowRun["publicationRecords"];
  onRegister?: ((input: RegisterPublicationInput) => Promise<void>) | undefined;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<RegisterPublicationInput["status"]>("published");
  const [platform, setPlatform] = useState("");
  const [externalEpisodeId, setExternalEpisodeId] = useState("");
  const [episodeUrl, setEpisodeUrl] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [eventAt, setEventAt] = useState(() => localDateTimeValue(new Date()));
  const [failureReason, setFailureReason] = useState("");
  const [requestId, setRequestId] = useState(publicationRequestId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const published = records.filter((record) => record.status === "published");
  const dirty = Boolean(platform || externalEpisodeId || episodeUrl || channelUrl || failureReason || mode !== "published");
  const eventDate = new Date(eventAt);
  const eventTimeValid = Number.isFinite(eventDate.getTime());
  const canSubmit = Boolean(onRegister && platform.trim() && eventTimeValid && (mode === "published"
    ? externalEpisodeId.trim() && safeExternalUrl(episodeUrl) && (!channelUrl || safeExternalUrl(channelUrl))
    : failureReason.trim().length >= 3));

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!onRegister || !canSubmit) return;
    try {
      setSaving(true);
      setError(undefined);
      const common = { requestId, platform: platform.trim() };
      const input: RegisterPublicationInput = mode === "published"
        ? {
            ...common,
            status: "published",
            externalEpisodeId: externalEpisodeId.trim(),
            episodeUrl: episodeUrl.trim(),
            ...(channelUrl.trim() ? { channelUrl: channelUrl.trim() } : {}),
            publishedAt: eventDate.toISOString(),
          }
        : { ...common, status: "failed", attemptedAt: eventDate.toISOString(), failureReason: failureReason.trim() };
      await onRegister(input);
      setPlatform("");
      setExternalEpisodeId("");
      setEpisodeUrl("");
      setChannelUrl("");
      setFailureReason("");
      setEventAt(localDateTimeValue(new Date()));
      setMode("published");
      setRequestId(publicationRequestId());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发布结果登记失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return <section className="publication-ledger" aria-label="外部发布登记">
    <header><div><strong>{published.length ? "已发布" : "外部发布登记"}</strong><span>{published.length ? `${published.length} 个平台已确认上线` : "下载发布包后，在这里记录平台实际结果"}</span></div><BadgeCheck size={18} aria-hidden="true" /></header>
    {records.length ? <div className="publication-records">{[...records].reverse().map((record) => record.status === "published"
      ? <div className="published" key={record.id}><BadgeCheck size={16} /><span><strong>{record.platform}</strong><small>{formatTime(record.publishedAt)} · {record.externalEpisodeId}</small></span><a href={record.episodeUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${record.platform} 已发布节目`}><ExternalLink size={15} /></a></div>
      : <div className="failed" key={record.id}><Waypoints size={16} /><span><strong>{record.platform} 发布未完成</strong><small>{record.failureReason}</small></span><time dateTime={record.attemptedAt}>{formatTime(record.attemptedAt)}</time></div>)}</div> : null}
    {onRegister ? <details className="publication-entry" open={published.length === 0}>
      <summary>{published.length ? "登记另一个平台" : "登记本次发布结果"}</summary>
      <form onSubmit={(event) => void submit(event)}>
        <div className="publication-mode" role="group" aria-label="发布结果"><button type="button" className={mode === "published" ? "active" : ""} aria-pressed={mode === "published"} onClick={() => setMode("published")}><BadgeCheck size={14} />已上线</button><button type="button" className={mode === "failed" ? "active" : ""} aria-pressed={mode === "failed"} onClick={() => setMode("failed")}><Waypoints size={14} />发布失败</button></div>
        <div className="publication-fields">
          <label><span>平台</span><input aria-label="发布平台" value={platform} maxLength={80} placeholder="例如：小宇宙" onChange={(event) => setPlatform(event.target.value)} /></label>
          <label><span>{mode === "published" ? "发布时间" : "尝试时间"}</span><input aria-label={mode === "published" ? "发布时间" : "尝试时间"} type="datetime-local" value={eventAt} onChange={(event) => setEventAt(event.target.value)} /></label>
          {mode === "published" ? <><label><span>节目 ID / Feed GUID</span><input aria-label="外部节目 ID" value={externalEpisodeId} maxLength={240} onChange={(event) => setExternalEpisodeId(event.target.value)} /></label><label className="publication-wide-field"><span>公开节目链接</span><input aria-label="公开节目链接" type="url" value={episodeUrl} placeholder="https://" onChange={(event) => setEpisodeUrl(event.target.value)} /></label><label className="publication-wide-field"><span>频道或 RSS 链接（可选）</span><input aria-label="频道或 RSS 链接" type="url" value={channelUrl} placeholder="https://" onChange={(event) => setChannelUrl(event.target.value)} /></label></> : <label className="publication-wide-field"><span>失败原因</span><textarea aria-label="发布失败原因" value={failureReason} maxLength={1_000} onChange={(event) => setFailureReason(event.target.value)} /></label>}
        </div>
        <footer><span role={error ? "alert" : undefined}>{error ?? (mode === "published" ? "登记成功后，本集才会进入已发布状态。" : "失败记录不会把本集标记为已发布。")}</span><button className="primary-command" type="submit" disabled={!canSubmit || saving}>{saving ? <LoaderCircle className="is-spinning" size={15} /> : mode === "published" ? <BadgeCheck size={15} /> : <Waypoints size={15} />}{saving ? "正在登记" : mode === "published" ? "确认已发布" : "记录失败"}</button></footer>
      </form>
    </details> : null}
  </section>;
}

function publicationRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `publication-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function releaseBasisOptions() {
  return <><option value="owned">自有版权</option><option value="commissioned">委托创作</option><option value="licensed">第三方许可</option><option value="generated">生成服务授权</option></>;
}

function releaseBasisLabel(value: unknown): string {
  return ({ owned: "自有版权", commissioned: "委托创作", licensed: "第三方许可", generated: "生成服务授权" } as Record<string, string>)[String(value)] ?? "权利已登记";
}

function formatDuration(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "完整母带";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "文件已校验";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function MusicPlanPreview({
  value,
  saving,
  onSave,
  onDirtyChange,
  readOnly,
}: {
  value: unknown;
  saving: boolean;
  onSave: (value: Record<string, unknown>) => void;
  onDirtyChange: (dirty: boolean) => void;
  readOnly: boolean;
}) {
  const source = asRecord(value);
  const [plan, setPlan] = useState<Record<string, unknown>>(() => structuredClone(source));
  useEffect(() => setPlan(structuredClone(source)), [value]);
  const dirty = JSON.stringify(plan) !== JSON.stringify(source);
  useEffect(() => onDirtyChange(!readOnly && dirty), [dirty, onDirtyChange, readOnly]);
  const cues = asArray(plan.cues).map((cue) => ({ ...asRecord(cue) }));

  function updateCue(cueId: string, selectedValue: string) {
    const nextCues = cues.map((cue) => {
      if (cue.id !== cueId) return cue;
      return {
        ...cue,
        selection: selectedValue === "silence" ? { action: "silence" } : { action: "asset", assetId: selectedValue },
      };
    });
    setPlan({ ...plan, cues: nextCues, status: "ready", confirmed: true });
  }

  const ready = cues.length > 0 && cues.every((cue) => {
    const selection = asRecord(cue.selection);
    const choices = asArray(cue.choices).map(asRecord);
    return selection.action === "silence"
      || (selection.action === "asset" && choices.some((choice) => choice.action === "asset" && choice.assetId === selection.assetId));
  });

  return <div className="music-cue-workbench">
    <header><span><Music2 size={15} />{cues.length} 个声音节点</span><strong>{plan.confirmed === true ? "Cue 已就绪" : "等待声音导演"}</strong></header>
    <div className="music-cue-list">
      {cues.map((cue) => {
        const choices = asArray(cue.choices).map(asRecord);
        const selection = asRecord(cue.selection);
        const selectedValue = selection.action === "asset" ? String(selection.assetId ?? "") : "silence";
        const selectedChoice = choices.find((choice) => choice.action === "asset" && choice.assetId === selectedValue);
        return <article key={String(cue.id)}>
          <span className="cue-time">{Number(cue.durationSeconds) > 0 ? `${Number(cue.durationSeconds)}s` : "DRY"}</span>
          <div className="cue-copy"><strong>{String(cue.label ?? cue.id)}</strong><small>{String(cue.purpose ?? "")}</small></div>
          <label><span>声音选择</span><select aria-label={`${String(cue.label ?? cue.id)}：声音选择`} value={selectedValue} disabled={readOnly} onChange={(event) => updateCue(String(cue.id), event.target.value)}>
            {choices.map((choice) => <option key={`${String(cue.id)}-${String(choice.assetId ?? choice.action)}`} value={choice.action === "silence" ? "silence" : String(choice.assetId)}>{String(choice.title)}{choice.action === "asset" ? ` · ${Number(choice.score)}/100` : ""}</option>)}
          </select></label>
          {selectedChoice && typeof selectedChoice.mediaUrl === "string" ? <div className="cue-audition"><audio aria-label={`试听：${String(cue.label ?? cue.id)} · ${String(selectedChoice.title ?? "音乐")}`} controls preload="none" src={studioPath(selectedChoice.mediaUrl)}>当前浏览器无法播放音频。</audio><small>{String(selectedChoice.reason ?? "")}</small></div> : <div className="cue-silence"><span />保留节目呼吸</div>}
        </article>;
      })}
    </div>
    <footer><span>{Number(plan.libraryAssetCount) || 0} 条已登记音乐可参与匹配，发布前仍需核验授权</span><button className="primary-command" type="button" disabled={readOnly || !ready || saving} onClick={() => onSave(plan)}>{saving ? <LoaderCircle className="is-spinning" size={15} /> : readOnly ? <LockKeyhole size={15} /> : <Save size={15} />}{saving ? "正在保存" : readOnly ? "已锁定" : "保存音乐配置"}</button></footer>
  </div>;
}

function VoicePlanPreview({
  value,
  saving,
  onSave,
  onDirtyChange,
  readOnly,
}: {
  value: unknown;
  saving: boolean;
  onSave: (value: Record<string, unknown>) => void;
  onDirtyChange: (dirty: boolean) => void;
  readOnly: boolean;
}) {
  const source = asRecord(value);
  const [plan, setPlan] = useState<Record<string, unknown>>(() => structuredClone(source));
  useEffect(() => setPlan(structuredClone(source)), [value]);
  const dirty = JSON.stringify(plan) !== JSON.stringify(source);
  useEffect(() => onDirtyChange(!readOnly && dirty), [dirty, onDirtyChange, readOnly]);
  const candidates = asArray(plan.candidates).map(asRecord).filter((candidate) => typeof candidate.providerId === "string");
  const roles = asArray(plan.roles).filter((role): role is string => typeof role === "string");
  const selections = asArray(plan.selections).map((selection) => ({ ...asRecord(selection) }));
  const previewCandidate = candidates.find((candidate) => candidate.providerId === "local-macos-say");
  const previewVoices = asArray(previewCandidate?.voices).map(asRecord).flatMap((voice) =>
    typeof voice.id === "string" ? [{ id: voice.id, label: typeof voice.label === "string" ? voice.label : voice.id }] : [],
  );
  const availablePreviewVoices = previewVoices.length > 0
    ? previewVoices
    : PREVIEW_VOICES;
  const availablePreviewVoiceIds = new Set(availablePreviewVoices.map((voice) => voice.id));
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalog>();
  const [voiceCatalogLoading, setVoiceCatalogLoading] = useState(false);
  const [voiceCatalogError, setVoiceCatalogError] = useState<string>();
  const elevenLabsAvailable = candidates.some((candidate) => candidate.providerId === "elevenlabs-v3" && candidate.executable === true);

  useEffect(() => {
    if (readOnly || !elevenLabsAvailable) return;
    let cancelled = false;
    setVoiceCatalogLoading(true);
    setVoiceCatalogError(undefined);
    void StudioApi.loadVoiceCatalog().then((catalog) => {
      if (!cancelled) setVoiceCatalog(catalog);
    }).catch((reason: unknown) => {
      if (!cancelled) setVoiceCatalogError(reason instanceof Error ? reason.message : "声音目录暂不可用");
    }).finally(() => {
      if (!cancelled) setVoiceCatalogLoading(false);
    });
    return () => { cancelled = true; };
  }, [elevenLabsAvailable, readOnly]);

  function updateSelection(role: string, field: "providerId" | "voiceId", nextValue: string) {
    const nextSelections = roles.map((candidateRole, index) => {
      const current = selections.find((selection) => selection.role === candidateRole) ?? { role: candidateRole };
      if (candidateRole !== role) return current;
      const next = { ...current, [field]: nextValue };
      if (field === "providerId" && nextValue === "local-macos-say" && !next.voiceId) {
        next.voiceId = availablePreviewVoices[index % availablePreviewVoices.length]?.id;
      }
      if (field === "providerId" && nextValue !== "local-macos-say") next.voiceId = "";
      if (field === "providerId" && nextValue === "elevenlabs-v3" && voiceCatalog?.voices[0]) next.voiceId = voiceCatalog.voices[0].voiceId;
      if (field === "providerId") next.use = nextValue === "local-macos-say" ? "preview_only" : "release_candidate";
      return next;
    });
    setPlan({ ...plan, selections: nextSelections, confirmed: true, status: "ready" });
  }

  const sameProvider = new Set(selections.filter((selection) => roles.includes(String(selection.role))).map((selection) => selection.providerId)).size === 1;
  const ready = roles.length > 0 && roles.every((role) => {
    const selection = selections.find((candidate) => candidate.role === role);
    if (selection?.providerId === "local-macos-say") return typeof selection.voiceId === "string" && availablePreviewVoiceIds.has(selection.voiceId);
    return selection?.providerId === "elevenlabs-v3" && typeof selection.voiceId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(selection.voiceId);
  }) && sameProvider;

  return <div className="voice-plan-workbench">
    <header><span>本期 {roles.length} 个角色 · {Number(plan.characters || 0).toLocaleString()} 字</span><strong>{plan.confirmed === true ? "方案已就绪" : "等待声音选择"}</strong></header>
    <div className="voice-role-grid">
      {roles.map((role) => {
        const selection = selections.find((candidate) => candidate.role === role) ?? {};
        const selectedVoice = voiceCatalog?.voices.find((voice) => voice.voiceId === selection.voiceId);
        return <div className="voice-role-row" key={role}>
          <strong>{role}</strong>
          <label><span>{role} · 使用方式</span><select aria-label={`${role}：使用方式`} value={String(selection.providerId ?? "")} disabled={readOnly} onChange={(event) => updateSelection(role, "providerId", event.target.value)}>
            <option value="" disabled>选择服务</option>
            {candidates.map((candidate) => <option key={String(candidate.providerId)} value={String(candidate.providerId)} disabled={candidate.executable !== true}>{String(candidate.label ?? candidate.providerId)}{candidate.executable === true ? "" : " · 尚未接通"}</option>)}
          </select></label>
          {selection.providerId === "local-macos-say" ? <label><span>{role} · 声音</span><select aria-label={`${role}：声音`} value={String(selection.voiceId ?? "")} disabled={readOnly} onChange={(event) => updateSelection(role, "voiceId", event.target.value)}>{availablePreviewVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label> : selection.providerId === "elevenlabs-v3" ? <div className="account-voice-picker"><label><span>{role} · 账户音色</span><select aria-label={`${role}：账户音色`} value={String(selection.voiceId ?? "")} disabled={readOnly || voiceCatalogLoading || !voiceCatalog?.voices.length} onChange={(event) => updateSelection(role, "voiceId", event.target.value)}><option value="" disabled>{voiceCatalogLoading ? "正在读取音色" : "选择账户音色"}</option>{voiceCatalog?.voices.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name}{voice.labels.accent ? ` · ${voice.labels.accent}` : ""}</option>)}</select></label>{selectedVoice?.previewUrl ? <audio controls preload="none" src={selectedVoice.previewUrl} aria-label={`试听 ${role}：${selectedVoice.name}`}>当前浏览器无法播放音频。</audio> : null}{voiceCatalog?.warning || voiceCatalogError ? <small role="alert">{voiceCatalog?.warning ?? voiceCatalogError}</small> : null}</div> : null}
        </div>;
      })}
    </div>
    {!sameProvider ? <p className="voice-plan-constraint" role="alert">一段多人对话必须使用同一种生成方式。请把所有角色切到同一档位后再保存。</p> : null}
    <details className="voice-tier-details"><summary>比较声音档位与成本</summary><div className="voice-provider-ledger">
      {candidates.map((candidate) => <div key={String(candidate.providerId)}><span><strong>{String(candidate.label ?? "声音方案")}</strong><small>{voiceUseLabel(candidate.releaseUse)}{candidate.executable === true ? " · 可执行" : candidate.configured === true ? " · 已配置但未接通" : " · 尚未接通"}</small></span><em>约 ¥{Number(candidate.estimatedCostCny || 0).toFixed(2)}</em>{typeof candidate.freeQuota === "string" ? <small>{candidate.freeQuota}</small> : typeof candidate.note === "string" ? <small>{candidate.note}</small> : null}</div>)}
    </div></details>
    <button className="primary-command voice-confirm-command" type="button" disabled={readOnly || !ready || saving} onClick={() => onSave(plan)}>
      {saving ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : readOnly ? <LockKeyhole size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
      {saving ? "正在保存" : readOnly ? "已锁定" : "保存声音配置"}
    </button>
  </div>;
}

function voiceUseLabel(value: unknown): string {
  if (value === "preview_only") return "仅桌读";
  if (value === "paid_plan_only") return "付费方案可商用";
  return "发行前审条款";
}

function ResearchPacketPreview({
  value,
  reviewingSourceId,
  onToggleVerification,
  readOnly,
}: {
  value: unknown;
  reviewingSourceId: string | undefined;
  onToggleVerification: (sourceIndex: number) => void;
  readOnly: boolean;
}) {
  const packet = asRecord(value);
  const sources = asArray(packet.sources).map(asRecord).filter((source) => typeof source.title === "string");
  const research = asRecord(packet.research);
  const attempts = asArray(research.attempts).map(asRecord).filter((attempt) => typeof attempt.providerLabel === "string");
  const verifiedCount = typeof packet.verifiedIndependentSourceCount === "number" ? packet.verifiedIndependentSourceCount : 0;
  return (
    <div className="research-ledger">
      <header>
        <span><SearchCheck size={16} aria-hidden="true" />{sources.length} 条候选来源</span>
        <strong>{verifiedCount} 条可信独立来源</strong>
      </header>
      {sources.length > 0 ? <ol className="research-source-list">
        {sources.map((source, index) => {
          const title = String(source.title);
          const url = safeExternalUrl(source.url);
          const humanVerified = source.verificationStatus === "verified";
          const machineChecked = source.verificationStatus === "machine_checked";
          const sourceId = typeof source.id === "string" ? source.id : `source-${index + 1}`;
          const metadata = [source.providerLabel, source.publisher, source.publishedAt]
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
          return <li key={sourceId}>
            <span className="source-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="source-ledger-copy">
              <strong>{title}</strong>
              <small>{metadata.join(" · ") || "来源信息待补"}</small>
            </span>
            <em className={humanVerified ? "verified" : machineChecked ? "machine" : "unverified"}>
              {humanVerified ? "人工确认" : machineChecked ? "机器已检查" : "待检查"}
            </em>
            <button
              className="source-review-command"
              type="button"
              title={humanVerified ? "撤销人工确认" : "人工确认来源"}
              aria-label={`${humanVerified ? "撤销人工确认" : "人工确认来源"}：${title}`}
              disabled={readOnly || !url || reviewingSourceId === sourceId}
              onClick={() => onToggleVerification(index)}
            >
              {reviewingSourceId === sourceId ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
              <span>{humanVerified ? "撤销" : "确认"}</span>
            </button>
            {url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`打开来源：${title}`}><ExternalLink size={16} aria-hidden="true" /></a> : <span className="source-link-missing">无链接</span>}
          </li>;
        })}
      </ol> : <p className="artifact-preview-empty">还没有可审阅的来源。</p>}
      {attempts.length > 0 && <div className="research-attempts" aria-label="检索源状态">
        {attempts.map((attempt) => <span key={String(attempt.providerId)} className={attempt.status === "succeeded" ? "succeeded" : "failed"}>
          {String(attempt.providerLabel)} · {attempt.status === "succeeded" ? `${Number(attempt.resultCount) || 0} 条` : "失败"}
        </span>)}
      </div>}
    </div>
  );
}

function humanizeKey(value: string): string {
  return ({ title: "标题", hook: "开场承诺", rationale: "立项理由", verdict: "节目建议", targetMinutes: "目标时长", status: "状态", sources: "来源", gaps: "待补资料", claims: "事实条目", suggestedRoles: "建议角色", segments: "节目段落", cues: "音乐 Cue", silenceAllowed: "允许留白" } as Record<string, string>)[value] ?? value;
}

function previewValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "尚未生成" : value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key} ${String(item)}`).join(" · ");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value ?? "尚未生成");
}

function artifactLabel(kind: string): string {
  return ({
    "episode.brief": "本集简报",
    "episode-brief": "本集简报",
    "research.plan": "研究检索计划",
    "research.packet": "资料包",
    "source-packet": "资料包",
    "claim.ledger": "事实账本",
    "claim-ledger": "事实账本",
    "cast.plan": "动态角色方案",
    "cast-plan": "动态角色方案",
    "episode.blueprint": "节目蓝图",
    "episode-blueprint": "节目蓝图",
    "audio.emotional-arc": "情绪曲线",
    "emotional-arc": "情绪曲线",
    "script.segment": "分段脚本",
    segment: "分段脚本",
    "script.assembled": "整集脚本",
    "episode-script": "整集脚本",
    "release.copy": "发行文案",
    "voice.plan": "角色声音方案",
    "voice-plan": "角色声音方案",
    "music.cue-sheet": "配乐与留白",
    "music-cue-sheet": "配乐与留白",
    "audio.master": "混音母带",
    "audio-master": "混音母带",
    "visual.pack": "封面与视觉包",
    "visual-pack": "封面与视觉包",
    "publish.package": "发布包",
    "publish-package": "发布包",
  } as Record<string, string>)[kind] ?? "制作产物";
}

function musicPolicyLabel(policy: "minimal" | "narrative" | "immersive" | undefined): string {
  if (policy === "minimal") return "克制留白";
  if (policy === "narrative") return "叙事配乐";
  if (policy === "immersive") return "沉浸声景";
  return "按节目模板";
}

function executionLabel(node: WorkflowNode): string {
  if (node.status === "needs_human") return "核对结果";
  if (node.status === "succeeded" || node.status === "stale" || node.status === "failed") return "重新运行";
  return "运行步骤";
}

function findBlockingNodes(run: WorkflowRun, node: WorkflowNode): WorkflowNode[] {
  const candidates = [
    ...node.prerequisiteNodeIds.map((nodeId) => run.nodes.find((candidate) => candidate.id === nodeId)),
    ...node.inputArtifactIds.map((artifactId) => run.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId))),
  ].filter((candidate): candidate is WorkflowNode => Boolean(candidate && candidate.status !== "succeeded"));
  return candidates.filter((candidate, index) => candidates.findIndex((item) => item.id === candidate.id) === index);
}

function assetRegistrationReady(run: WorkflowRun, node: WorkflowNode): boolean {
  if (["pending", "running", "awaiting_spend_approval"].includes(node.status)) return false;
  if (node.prerequisiteNodeIds.some((id) => run.nodes.find((candidate) => candidate.id === id)?.status !== "succeeded")) return false;
  return node.inputArtifactIds.every((artifactId) => {
    const producer = run.nodes.find((candidate) => candidate.outputArtifactIds.includes(artifactId));
    return !producer || producer.status === "succeeded";
  });
}

function audioMediaPreview(value: unknown): { url: string; releaseReady: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const mediaUrl = data.mediaUrl;
  if (typeof mediaUrl !== "string" || !mediaUrl.startsWith("/media/")) return undefined;
  if (data.previewKind === "local_table_read" && data.releaseReady === false) return { url: studioPath(mediaUrl), releaseReady: false };
  if (data.releaseReady === true) return { url: studioPath(mediaUrl), releaseReady: true };
  return undefined;
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function formatLoudness(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(1)} LUFS` : "响度待测";
}

function formatTruePeak(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(1)} dBTP` : "峰值待测";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
