import type { WorkflowNode } from "@token-talk/domain/model";
import type { AgentLoopResult, ExecuteNodeInput, NodeExecutionPreview, RegisterCoverMetadata, RegisterPublicationInput, RegisterReleaseMasterMetadata, StudioBootstrap, WorkflowRun } from "../../shared/api.js";
import { AlertTriangle, Check, Circle, CircleDot, LoaderCircle, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NodeWorkspace } from "./NodeWorkspace.js";
import { SeriesArtwork } from "./SeriesArtwork.js";
import { nextActionNode, productionJourney } from "../production-state.js";

interface EpisodeStudioProps {
  data: StudioBootstrap;
  run: WorkflowRun;
  selectedNodeId?: string | undefined;
  onSelectNode?: (nodeId: string) => void;
  onReviseArtifact: (artifactId: string, value: unknown) => Promise<void>;
  onReviewResearchSource: (artifactId: string, sourceId: string, verified: boolean) => Promise<void>;
  onExecuteNode: (nodeId: string, input?: ExecuteNodeInput) => Promise<void>;
  onContinueAgentLoop?: (() => Promise<AgentLoopResult>) | undefined;
  onLoadExecutionPreview: (nodeId: string) => Promise<NodeExecutionPreview>;
  onAuthorizeSpend: (nodeId: string, maxCostCny: number) => Promise<void>;
  onReconcileCost: (receiptId: string, actualCostCny: number, note: string, providerInvoiceId?: string) => Promise<void>;
  onRegisterReleaseMaster: (file: File, metadata: RegisterReleaseMasterMetadata) => Promise<void>;
  onRegisterCover: (file: File, metadata: RegisterCoverMetadata) => Promise<void>;
  onSelectCover: (coverId: string) => Promise<void>;
  onRegisterPublication?: ((input: RegisterPublicationInput) => Promise<void>) | undefined;
  onDirtyChange?: (dirty: boolean) => void;
}

const statusLabels: Record<WorkflowNode["status"], string> = {
  pending: "等待",
  ready: "可执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  needs_human: "待核对",
  stale: "已失效",
  awaiting_spend_approval: "等待授权",
};

const runStatus = {
  active: { label: "制作中", tone: "active" },
  needs_human: { label: "执行待核对", tone: "needs-human" },
  release_ready: { label: "发行就绪", tone: "completed" },
  completed: { label: "已发布", tone: "completed" },
  failed: { label: "需要处理", tone: "failed" },
} as const;

export function EpisodeStudio({ data, run, selectedNodeId: controlledSelectedNodeId, onSelectNode, onReviseArtifact, onReviewResearchSource, onExecuteNode, onContinueAgentLoop, onLoadExecutionPreview, onAuthorizeSpend, onReconcileCost, onRegisterReleaseMaster, onRegisterCover, onSelectCover, onRegisterPublication, onDirtyChange }: EpisodeStudioProps) {
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState(() => recommendedNode(run)?.id);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [agentLoopState, setAgentLoopState] = useState<"idle" | "running">("idle");
  const [agentLoopMessage, setAgentLoopMessage] = useState<string>();
  const selectedNodeId = controlledSelectedNodeId ?? localSelectedNodeId;
  const selectedNode = run.nodes.find((node) => node.id === selectedNodeId) ?? recommendedNode(run) ?? run.nodes[0];
  const workflowComplete = run.nodes.length > 0 && run.nodes.every((node) => node.status === "succeeded");
  const status = workflowComplete && !["release_ready", "completed"].includes(run.status)
    ? { label: "制作完成", tone: "completed" }
    : runStatus[run.status];
  const journey = useMemo(() => productionJourney(run), [run]);
  const series = data.series.find((candidate) => candidate.id === run.seriesId);
  const recipe = data.recipes.find((candidate) => candidate.id === run.recipeId);
  const completedNodes = run.nodes.filter((node) => node.status === "succeeded").length;
  const progress = Math.round(completedNodes / Math.max(1, run.nodes.length) * 100);
  const spent = run.executionReceipts.reduce((total, receipt) => total + (receipt.actualCostCny ?? receipt.estimatedCostCny), 0);
  const costPending = run.executionReceipts.some((receipt) => receipt.billing === "metered" && receipt.status !== "running" && receipt.actualCostCny === undefined);
  const reportDirty = useCallback((dirty: boolean) => {
    setWorkspaceDirty(dirty);
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  useEffect(() => {
    if (controlledSelectedNodeId === undefined) setLocalSelectedNodeId(recommendedNode(run)?.id);
    reportDirty(false);
  }, [controlledSelectedNodeId, reportDirty, run.id]);

  useEffect(() => {
    const preventAccidentalClose = (event: BeforeUnloadEvent) => {
      if (!workspaceDirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventAccidentalClose);
    return () => window.removeEventListener("beforeunload", preventAccidentalClose);
  }, [workspaceDirty]);

  useEffect(() => {
    if (controlledSelectedNodeId === undefined && !run.nodes.some((node) => node.id === selectedNodeId)) {
      setLocalSelectedNodeId(recommendedNode(run)?.id);
    }
  }, [controlledSelectedNodeId, run.id, run.nodes, selectedNodeId]);

  function selectNode(nodeId: string) {
    if (nodeId !== selectedNode?.id && workspaceDirty && !window.confirm("当前步骤有未保存的结构化草稿。放弃修改并切换步骤吗？")) return;
    reportDirty(false);
    if (onSelectNode) onSelectNode(nodeId);
    else setLocalSelectedNodeId(nodeId);
  }

  async function continueProduction() {
    if (!onContinueAgentLoop) return;
    if (workspaceDirty) {
      setAgentLoopMessage("请先保存或放弃当前草稿，再继续自动制作。");
      return;
    }
    try {
      setAgentLoopState("running");
      const result = await onContinueAgentLoop();
      const labels: Record<AgentLoopResult["reason"], string> = {
        continue_available_work: "已完成当前步骤，继续自动制作。",
        completed_available_work: result.executedNodeIds.length ? `已完成 ${result.executedNodeIds.length} 个自动步骤。` : "当前没有可继续的自动步骤。",
        awaiting_spend_authorization: "已停在付费声音生成前，等待成本授权。",
        requires_input: "自动流程已生成需要处理的产物。",
        failed: "自动流程在异常节点停止，请查看该节点的执行记录。",
        repair_limit: "自动返修达到本轮上限，请查看审计结果。",
      };
      setAgentLoopMessage(labels[result.reason]);
    } catch (reason) {
      setAgentLoopMessage(reason instanceof Error ? reason.message : "继续自动制作失败，请重试。");
    } finally {
      setAgentLoopState("idle");
    }
  }

  return (
    <div className="episode-view">
      <header className="episode-header">
        <div className="episode-title-lockup">
          <span className="episode-cover"><SeriesArtwork seriesId={run.seriesId} title={run.title} compact /></span>
          <div><p className="eyebrow">本集制作</p><h1>{run.title}</h1><div className="episode-context"><span>{series?.title ?? "独立节目"}</span><span>{recipe?.label ?? "自定义流程"}</span><span>{run.productionIntent?.targetMinutes ?? recipe?.targetMinutes.max ?? 0} 分钟</span></div></div>
        </div>
        <div className="episode-run-summary">
          <span className={`status-badge ${status.tone}`}>{status.label}</span>
          <button className="primary-command episode-continue-command" type="button" disabled={!onContinueAgentLoop || agentLoopState === "running" || workflowComplete || run.status === "completed"} onClick={() => void continueProduction()}>{agentLoopState === "running" ? <LoaderCircle className="is-spinning" size={15} /> : <Play size={15} />}{agentLoopState === "running" ? "制作中" : workflowComplete ? "制作完成" : "继续制作"}</button>
          <dl><div><dt>进度</dt><dd>{progress}%</dd></div><div><dt>已完成</dt><dd>{completedNodes}/{run.nodes.length}</dd></div><div><dt>费用占用</dt><dd>{costPending ? "待对账 · " : ""}¥{spent.toFixed(2)}</dd></div></dl>
          {agentLoopMessage ? <small className="agent-loop-message" role="status">{agentLoopMessage}</small> : null}
        </div>
      </header>

      <ol className="episode-journey" aria-label="本集制作进度">
        {journey.map((stage, index) => <li key={stage.label} className={stage.state}><span>{index + 1}</span><strong>{stage.label}</strong></li>)}
      </ol>

      <section className="episode-studio" aria-label="本集连续制作流程">
        <nav className="node-rail" aria-label="本集制作步骤">
          <p className="rail-heading">本集流程</p>
          {run.nodes.map((node, index) => {
            const previous = run.nodes[index - 1];
            return <div className="node-rail-entry" key={node.id}>
              {(!previous || previous.phase !== node.phase) ? <span className="node-phase-label">{node.phase === "planning" ? "内容策划" : "声音与发布"}</span> : null}
              <button
                type="button"
                className={node.id === selectedNode?.id ? "active" : ""}
                aria-pressed={node.id === selectedNode?.id}
                aria-label={`${node.label} · ${statusLabels[node.status]}`}
                onClick={() => selectNode(node.id)}
              >
                <span className={`node-state ${node.status}`} aria-hidden="true"><NodeStatusIcon status={node.status} /></span>
                <span className="node-copy"><strong>{node.label}</strong><small>{statusLabels[node.status]}</small></span>
              </button>
            </div>;
          })}
        </nav>

        {selectedNode ? (
          <NodeWorkspace
            key={`${run.id}:${selectedNode.id}`}
            data={data}
            run={run}
            node={selectedNode}
            onReviseArtifact={onReviseArtifact}
            onReviewResearchSource={onReviewResearchSource}
            onExecuteNode={onExecuteNode}
            onLoadExecutionPreview={onLoadExecutionPreview}
            onAuthorizeSpend={onAuthorizeSpend}
            onReconcileCost={onReconcileCost}
            onRegisterReleaseMaster={onRegisterReleaseMaster}
            onRegisterCover={onRegisterCover}
            onSelectCover={onSelectCover}
            onRegisterPublication={onRegisterPublication}
            onNavigateToNode={selectNode}
            onDirtyChange={reportDirty}
          />
        ) : <div className="empty-state">这期节目还没有制作步骤</div>}
      </section>
    </div>
  );
}

export function recommendedNode(run: WorkflowRun): WorkflowNode | undefined {
  return nextActionNode(run) ?? [...run.nodes].reverse().find((node) => node.status === "succeeded");
}

function NodeStatusIcon({ status }: { status: WorkflowNode["status"] }) {
  if (status === "succeeded") return <Check size={13} />;
  if (status === "running") return <LoaderCircle size={13} />;
  if (status === "stale" || status === "failed") return <AlertTriangle size={13} />;
  if (status === "needs_human" || status === "awaiting_spend_approval") return <CircleDot size={13} />;
  return <Circle size={13} />;
}
