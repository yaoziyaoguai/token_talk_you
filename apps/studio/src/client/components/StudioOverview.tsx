import type { EpisodeCandidate } from "@token-talk/domain";
import type { CandidateInbox, StudioBootstrap } from "../../shared/api.js";
import { ArrowRight, CircleAlert, Flame, Headphones, LibraryBig, PenLine, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { describeRunStage, nextActionNode, productionJourney } from "../production-state.js";
import { SeriesArtwork } from "./SeriesArtwork.js";
import { SignalWave } from "./SignalWave.js";

interface StudioOverviewProps {
  data: StudioBootstrap;
  inbox: CandidateInbox | undefined;
  loading: boolean;
  loadError: string | undefined;
  onRefresh: () => Promise<void>;
  onOpenProduction: (runId: string, nodeId?: string) => void;
  onOpenCandidate: (candidate: EpisodeCandidate) => void;
  onConfigureOpportunity: (opportunityId: string) => void;
  onStartCustom: () => void;
}

const actionStatuses = new Set(["failed", "needs_human", "stale", "awaiting_spend_approval", "ready"]);

export function StudioOverview({ data, inbox, loading, loadError, onRefresh, onOpenProduction, onOpenCandidate, onConfigureOpportunity, onStartCustom }: StudioOverviewProps) {
  const recentRuns = [...data.runs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const activeRuns = recentRuns.filter((run) => !["release_ready", "completed"].includes(run.status));
  const focusedRun = [...activeRuns].sort((left, right) => runPriority(left) - runPriority(right) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? recentRuns[0];
  const adopted = data.opportunities.filter((opportunity) => opportunity.status === "adopted");
  const tasks = activeRuns.flatMap((run) => run.nodes
    .filter((node) => actionStatuses.has(node.status))
    .map((node) => ({ run, node })))
    .sort((left, right) => nodePriority(left.node.status) - nodePriority(right.node.status) || Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
  const workItems = [
    ...tasks.map(({ run, node }) => ({ id: `${run.id}:${node.id}`, title: node.label, note: run.title, kind: "node" as const, action: () => onOpenProduction(run.id, node.id) })),
    ...adopted.map((opportunity) => ({ id: opportunity.id, title: "配置制作意图", note: opportunity.title, kind: "opportunity" as const, action: () => onConfigureOpportunity(opportunity.id) })),
  ];
  const visibleWorkItems = workItems.slice(0, 2);
  const overflowWorkItems = workItems.slice(2);
  const sourceState = signalServiceState(inbox, loading, loadError);
  const rawSignals = (inbox?.sources ?? []).reduce((total, source) => total + source.count, 0);
  const candidateCount = (inbox?.items ?? []).filter((item) => item.origin === "trend").length;
  const journey = focusedRun ? productionJourney(focusedRun) : [];
  const completedNodes = focusedRun?.nodes.filter((node) => node.status === "succeeded").length ?? 0;
  const progress = focusedRun ? Math.round(completedNodes / Math.max(1, focusedRun.nodes.length) * 100) : 0;
  const spent = focusedRun ? focusedRun.executionReceipts.reduce((total, receipt) => total + (receipt.actualCostCny ?? receipt.estimatedCostCny), 0) : 0;
  const costPending = focusedRun?.executionReceipts.some((receipt) => receipt.billing === "metered" && receipt.status !== "running" && receipt.actualCostCny === undefined) ?? false;
  const budget = focusedRun?.productionIntent?.maxCostCny;
  const historicalSignals = inbox?.freshness?.status === "fallback"
    || inbox?.collector?.state === "degraded"
    || inbox?.collector?.state === "error"
    || Boolean(loadError && inbox);
  const editorialMode = editorialSourceMode((inbox?.items ?? []).filter((candidate) => candidate.origin === "trend"));
  const suggestions = buildEditorialSuggestions({
    inbox,
    loadError,
    focusedRun,
    onRefresh,
    onOpenCandidate,
    onOpenProduction,
    onStartCustom,
  });

  return (
    <section className="studio-overview" aria-labelledby="studio-overview-title">
      <header className="overview-header">
        <div><p className="eyebrow">{formatDate(new Date())} · 编辑控制台</p><h1 id="studio-overview-title">今天聊什么？</h1><p>热点、系列与原创进入同一条制作线；先看真实阻塞，再做下一步。</p></div>
        <div className="overview-actions">
          <span className={`overview-signal-state ${sourceState.state}`} role="status"><i />{sourceState.headline}</span>
          <button className="secondary-command" type="button" onClick={onStartCustom}><PenLine size={15} />自主创作</button>
          <button className="icon-command" type="button" disabled={loading} title="刷新热点信号" aria-label="刷新热点信号" onClick={() => void onRefresh()}><RefreshCw size={16} className={loading ? "is-spinning" : ""} /></button>
        </div>
      </header>

      <div className="overview-metrics" aria-label="工作台实时指标">
        <OverviewMetric value={activeRuns.length} label="在制单集" note={focusedRun ? `当前：${describeRunStage(focusedRun).label}` : "暂无在制节目"} tone="blue" />
        <OverviewMetric value={workItems.length} label="需要处理" note={`${tasks.length} 个制作步骤 · ${adopted.length} 个待立项`} tone="coral" />
        <OverviewMetric value={rawSignals} label={historicalSignals ? "历史信号" : "发现信号"} note={historicalSignals ? `${candidateCount} 个旧提案待复核` : `${candidateCount} 个节目提案`} tone="mint" />
        <OverviewMetric value={data.series.length} label="连载系列" note="角色与声音策略按系列保存" tone="amber" />
      </div>

      <div className="overview-grid">
        <section className="recent-production" aria-labelledby="recent-production-title">
          <header><div><p className="eyebrow">最近制作</p><h2 id="recent-production-title">节目队列</h2></div><span>{recentRuns.length} 集</span></header>
          <div className="recent-run-list">
            {recentRuns.slice(0, 4).map((run) => {
              const stage = describeRunStage(run);
              const done = run.nodes.filter((node) => node.status === "succeeded").length;
              return <button type="button" key={run.id} aria-label={`打开节目：${run.title}，${stage.label}`} onClick={() => onOpenProduction(run.id)}>
                <span className="recent-run-art"><SeriesArtwork seriesId={run.seriesId} title={run.title} compact /></span>
                <span className="recent-run-copy"><small className={`run-stage ${stage.tone}`}><i />{stage.label}</small><strong>{run.title}</strong><em>{stage.node ? `下一步：${stage.node.label}` : "查看制作记录"}</em><span><b style={{ width: `${Math.round(done / Math.max(1, run.nodes.length) * 100)}%` }} /></span></span>
                <ArrowRight size={15} />
              </button>;
            })}
            {!recentRuns.length ? <div className="overview-empty"><Headphones size={20} /><span>采用一个选题后，节目会进入这里。</span></div> : null}
          </div>
        </section>

        <section className="production-monitor" aria-labelledby="production-monitor-title">
          <header><div><p className="eyebrow">连续制作</p><h2 id="production-monitor-title">{focusedRun?.title ?? "还没有在制节目"}</h2></div>{focusedRun ? <span className={`run-stage ${describeRunStage(focusedRun).tone}`}><i />{describeRunStage(focusedRun).label}</span> : null}</header>
          {focusedRun ? <>
            <ol className="overview-journey" aria-label="当前节目制作进度">{journey.map((stage, index) => <li className={stage.state} key={stage.label}><span>{index + 1}</span><strong>{stage.label}</strong></li>)}</ol>
            <div className="production-signal"><SignalWave active={nextActionNode(focusedRun)?.status === "running"} /><div><strong>{nextActionNode(focusedRun)?.label ?? "本集流程已完成"}</strong><small>{nextActionNode(focusedRun)?.status === "needs_human" ? "外部执行结果未知，需要核对执行回执" : nextActionNode(focusedRun)?.status === "failed" ? "执行失败，需查看原因后重试" : "进度来自已保存的节点状态"}</small></div></div>
            <div className="production-progress"><span><b style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div>
            <dl className="production-facts"><div><dt>完成步骤</dt><dd>{completedNodes}/{focusedRun.nodes.length}</dd></div><div><dt>费用占用</dt><dd>{costPending ? "待对账 · " : ""}¥{spent.toFixed(2)}</dd></div><div><dt>单集上限</dt><dd>{budget === undefined ? "未设置" : `¥${budget.toFixed(2)}`}</dd></div></dl>
            <button className="production-open-command" type="button" onClick={() => onOpenProduction(focusedRun.id)}>进入本集制作<ArrowRight size={15} /></button>
          </> : <div className="overview-empty"><Headphones size={22} /><span>先从热点、系列或自己的问题立项。</span></div>}
        </section>

        <aside className="operations-rail" aria-label="总编建议与今日待办">
          <section className="editorial-suggestions"><header><div><h2>{editorialMode === "ai" ? "AI 总编建议" : editorialMode === "mixed" ? "联合总编建议" : "总编建议"}</h2><small>{editorialMode === "ai" ? "AI 结合当前信号与制作状态排序" : editorialMode === "mixed" ? "规则与 AI 候选保留各自来源" : "当前由规则总编结合真实状态排序"}</small></div><Sparkles size={15} aria-hidden="true" /></header><div>
            {suggestions.map((suggestion) => <SuggestionButton key={suggestion.id} suggestion={suggestion} />)}
          </div></section>
          <section className="today-tasks"><header><h2>今日待办</h2><span>{workItems.length}</span></header><div>
            {visibleWorkItems.map((item) => <TaskButton key={item.id} item={item} />)}
            {overflowWorkItems.length ? <details className="task-overflow"><summary>查看其余 {overflowWorkItems.length} 项</summary><div>{overflowWorkItems.map((item) => <TaskButton key={item.id} item={item} />)}</div></details> : null}
            {!workItems.length ? <div className="operations-empty"><ShieldCheck size={17} /><span>当前没有等待处理的事项</span></div> : null}
          </div></section>
        </aside>
      </div>
    </section>
  );
}

function OverviewMetric({ value, label, note, tone }: { value: number; label: string; note: string; tone: string }) {
  return <div className={`overview-metric ${tone}`}><strong>{value}</strong><span>{label}</span><small>{note}</small></div>;
}

function TaskButton({ item }: { item: { title: string; note: string; kind: "node" | "opportunity"; action: () => void } }) {
  return <button type="button" onClick={item.action}>{item.kind === "node" ? <CircleAlert size={15} /> : <PenLine size={15} />}<span><strong>{item.title}</strong><small>{item.note}</small></span><ArrowRight size={14} /></button>;
}

interface EditorialSuggestion {
  id: string;
  icon: React.ReactNode;
  title: string;
  note: string;
  tone: "coral" | "blue" | "mint";
  action: () => void;
}

function SuggestionButton({ suggestion }: { suggestion: EditorialSuggestion }) {
  return <button className={suggestion.tone} type="button" onClick={suggestion.action}><span>{suggestion.icon}</span><span><strong>{suggestion.title}</strong><small>{suggestion.note}</small></span><ArrowRight size={14} /></button>;
}

function buildEditorialSuggestions({
  inbox,
  loadError,
  focusedRun,
  onRefresh,
  onOpenCandidate,
  onOpenProduction,
  onStartCustom,
}: {
  inbox: CandidateInbox | undefined;
  loadError: string | undefined;
  focusedRun: StudioBootstrap["runs"][number] | undefined;
  onRefresh: () => Promise<void>;
  onOpenCandidate: (candidate: EpisodeCandidate) => void;
  onOpenProduction: (runId: string, nodeId?: string) => void;
  onStartCustom: () => void;
}): EditorialSuggestion[] {
  const available = (inbox?.items ?? []).filter((candidate) => candidate.verdict !== "skip" && candidate.verification.status !== "blocked");
  const topTrend = [...available].filter((candidate) => candidate.origin === "trend").sort((left, right) => right.score.overall - left.score.overall)[0];
  const topSeries = [...available].filter((candidate) => candidate.origin === "series").sort((left, right) => right.score.overall - left.score.overall)[0];
  const nextNode = focusedRun ? nextActionNode(focusedRun) : undefined;
  const historical = inbox?.freshness?.status === "fallback"
    || inbox?.collector?.state === "degraded"
    || inbox?.collector?.state === "error"
    || Boolean(loadError && inbox);
  const suggestions: EditorialSuggestion[] = [];

  if (topTrend && !historical) suggestions.push({
    id: `trend:${topTrend.id}`,
    icon: <Flame size={16} aria-hidden="true" />,
    title: `优先审阅：${topTrend.title}`,
    note: `${editorialProviderLabel(topTrend)} · ${Math.round(topTrend.score.overall)} 分编辑潜力 · ${candidateVerdictLabel(topTrend.verdict)}`,
    tone: "coral",
    action: () => onOpenCandidate(topTrend),
  });
  if (historical) suggestions.push({
    id: "refresh-signals",
    icon: <RefreshCw size={16} aria-hidden="true" />,
    title: "先恢复热点采集",
    note: "当前候选来自历史快照，采用前需要重新确认",
    tone: "coral",
    action: () => void onRefresh(),
  });
  if (nextNode && focusedRun) suggestions.push({
    id: `run:${focusedRun.id}:${nextNode.id}`,
    icon: <Headphones size={16} aria-hidden="true" />,
    title: `继续制作：${nextNode.label}`,
    note: focusedRun.title,
    tone: "blue",
    action: () => onOpenProduction(focusedRun.id, nextNode.id),
  });
  if (topSeries) suggestions.push({
    id: `series:${topSeries.id}`,
    icon: <LibraryBig size={16} aria-hidden="true" />,
    title: `安排追更：${topSeries.title}`,
    note: topSeries.editorial?.listenerPromise ?? "沿用系列承诺，按本期选题动态编排角色",
    tone: "mint",
    action: () => onOpenCandidate(topSeries),
  });
  if (!suggestions.length) suggestions.push({
    id: "custom",
    icon: <PenLine size={16} aria-hidden="true" />,
    title: "从自己的问题开始",
    note: "原创选题也会进入研究、动态角色和声音审核流程",
    tone: "blue",
    action: onStartCustom,
  });
  return suggestions.slice(0, 2);
}

function candidateVerdictLabel(verdict: EpisodeCandidate["verdict"]): string {
  return ({ rapid_brief: "适合热点深谈", deep_discussion: "适合深度圆桌", series_episode: "适合系列正片", research_first: "需要先做研究", skip: "暂不生产" } as const)[verdict];
}

function editorialProviderLabel(candidate: EpisodeCandidate): string {
  return candidate.editorial?.provider === "local_ai" ? "本地 AI 总编" : candidate.editorial?.provider === "series" ? "系列策划" : candidate.editorial?.provider === "human" ? "主编提案" : "规则总编";
}

function editorialSourceMode(candidates: EpisodeCandidate[]): "ai" | "mixed" | "rules" {
  const aiCount = candidates.filter((candidate) => candidate.editorial?.provider === "local_ai").length;
  if (aiCount === 0) return "rules";
  return aiCount === candidates.length ? "ai" : "mixed";
}

function signalServiceState(inbox: CandidateInbox | undefined, loading: boolean, loadError: string | undefined): { state: "ready" | "attention" | "error"; headline: string } {
  if (loading) return { state: "attention", headline: "正在采集" };
  if (loadError) return { state: "error", headline: "信号同步失败" };
  if (!inbox) return { state: "attention", headline: "等待信号" };
  if (inbox.collector?.state === "collecting") return { state: "attention", headline: "后台采集中" };
  if (inbox.collector?.state === "error") return { state: "error", headline: "后台采集中断" };
  if (inbox.collector?.state === "degraded") return { state: "attention", headline: "后台采集降级" };
  if (inbox.freshness?.status === "fallback") return { state: "attention", headline: "沿用历史快照" };
  if (inbox.sources.length === 0) return { state: "attention", headline: "等待首次采集" };
  const ready = inbox.sources.filter((source) => source.status === "ready").length;
  const degraded = inbox.sources.filter((source) => source.status === "degraded").length;
  if (ready > 0 && degraded > 0) return { state: "attention", headline: "部分信号降级" };
  if (ready > 0) return { state: "ready", headline: "信号已同步" };
  if (degraded > 0) return { state: "attention", headline: "采集降级" };
  return { state: "error", headline: "采集暂不可用" };
}

function runPriority(run: StudioBootstrap["runs"][number]): number {
  const status = nextActionNode(run)?.status ?? (["release_ready", "completed"].includes(run.status) ? "succeeded" : "pending");
  return ({ failed: 0, needs_human: 1, stale: 2, awaiting_spend_approval: 3, ready: 4, running: 5, pending: 6, succeeded: 7 } as Record<string, number>)[status] ?? 8;
}

function nodePriority(status: StudioBootstrap["runs"][number]["nodes"][number]["status"]): number {
  return ({ failed: 0, needs_human: 1, stale: 2, awaiting_spend_approval: 3, ready: 4, running: 5, pending: 6, succeeded: 7 } as Record<string, number>)[status] ?? 8;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
}
