import type { EpisodeCandidate } from "@token-talk/domain";
import type { CandidateInbox, StudioBootstrap } from "../shared/api.js";
import {
  AudioLines,
  ListMusic,
  PanelsTopLeft,
  Radio,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StudioApi } from "./api.js";
import { EpisodeStudio, recommendedNode } from "./components/EpisodeStudio.js";
import { EpisodeStartDialog } from "./components/EpisodeStartDialog.js";
import { ProviderView } from "./components/ProviderView.js";
import { SeriesView } from "./components/SeriesView.js";
import { StudioCommandBar } from "./components/StudioCommandBar.js";
import { TodayView } from "./components/TodayView.js";

type ViewId = "today" | "production" | "formats" | "resources";

interface AppProps {
  initialData?: StudioBootstrap;
  initialInbox?: CandidateInbox;
}

const navItems = [
  { id: "today", label: "选题", icon: Radio },
  { id: "production", label: "制作", icon: PanelsTopLeft },
  { id: "formats", label: "节目", icon: ListMusic },
] as const;

const CANDIDATE_SYNC_INTERVAL_MS = 60_000;

export function App({ initialData, initialInbox }: AppProps) {
  const [view, setView] = useState<ViewId>(() => readLocationState().view);
  const [data, setData] = useState<StudioBootstrap | undefined>(initialData);
  const [inbox, setInbox] = useState<CandidateInbox | undefined>(initialInbox);
  const [bootError, setBootError] = useState<string>();
  const [bootAttempt, setBootAttempt] = useState(0);
  const [candidateLoadError, setCandidateLoadError] = useState<string>();
  const [candidateActionError, setCandidateActionError] = useState<string>();
  const [candidateLoading, setCandidateLoading] = useState(!initialInbox);
  const [adoptingId, setAdoptingId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState(() => {
    const requested = readLocationState().runId;
    return initialData?.runs.some((run) => run.id === requested) ? requested : initialData?.runs[0]?.id;
  });
  const [selectedNodeId, setSelectedNodeId] = useState(() => readLocationState().nodeId);
  const [focusedCandidateId, setFocusedCandidateId] = useState<string>();
  const [focusedSeriesId, setFocusedSeriesId] = useState(() => readLocationState().seriesId);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>();
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [productionDirty, setProductionDirty] = useState(false);
  const candidateRequestInFlight = useRef(false);

  useEffect(() => {
    StudioApi.configureLocalSession(data?.mutationToken);
  }, [data?.mutationToken]);

  useEffect(() => {
    if (initialData) return;
    setBootError(undefined);
    StudioApi.loadBootstrap().then((value) => {
      setData(value);
      const requested = readLocationState().runId;
      setSelectedRunId(value.runs.some((run) => run.id === requested) ? requested : value.runs[0]?.id);
    }).catch((reason: unknown) => {
      setBootError(reason instanceof Error ? reason.message : "无法载入 Studio 数据");
    });
  }, [bootAttempt, initialData]);

  useEffect(() => {
    const restoreLocation = () => {
      if (!confirmDiscardProductionDraft()) {
        writeLocationState({
          view,
          ...(view === "production" && selectedRunId ? { runId: selectedRunId } : {}),
          ...(view === "production" && selectedNodeId ? { nodeId: selectedNodeId } : {}),
          ...(view === "formats" && focusedSeriesId ? { seriesId: focusedSeriesId } : {}),
        });
        return;
      }
      const location = readLocationState();
      setView(location.view);
      setSelectedRunId(location.runId);
      setSelectedNodeId(location.nodeId);
      setFocusedSeriesId(location.seriesId);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [focusedSeriesId, productionDirty, selectedNodeId, selectedRunId, view]);

  const loadCandidates = useCallback(async (refresh: boolean, silent = false) => {
    if (candidateRequestInFlight.current) return;
    candidateRequestInFlight.current = true;
    if (!silent) setCandidateLoading(true);
    setCandidateLoadError(undefined);
    try {
      setInbox(await StudioApi.loadCandidates(refresh));
    } catch (reason) {
      setCandidateLoadError(reason instanceof Error ? reason.message : "无法载入今日选题");
    } finally {
      candidateRequestInFlight.current = false;
      if (!silent) setCandidateLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialInbox || !data?.mutationToken) return;
    void loadCandidates(false);
  }, [data?.mutationToken, initialInbox, loadCandidates]);

  useEffect(() => {
    const syncCachedCandidates = () => {
      if (!data?.mutationToken) return;
      void loadCandidates(false, true);
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") syncCachedCandidates();
    };
    const timer = window.setInterval(syncCachedCandidates, CANDIDATE_SYNC_INTERVAL_MS);
    window.addEventListener("focus", syncCachedCandidates);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncCachedCandidates);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [data?.mutationToken, loadCandidates]);

  if (bootError) return <div className="boot-state error" role="alert"><strong>Studio 没有成功打开</strong><span>{bootError}</span><button className="secondary-command" type="button" onClick={() => setBootAttempt((value) => value + 1)}>重新连接</button></div>;
  if (!data) return <div className="boot-state">正在打开 Token Talk Studio…</div>;
  const selectedRun = data.runs.find((run) => run.id === selectedRunId) ?? data.runs[0];
  const selectedOpportunity = data.opportunities.find((opportunity) => opportunity.id === selectedOpportunityId);
  const historicalCandidates = inbox?.freshness?.status === "fallback"
    || inbox?.collector?.state === "degraded"
    || inbox?.collector?.state === "error"
    || Boolean(candidateLoadError && inbox);

  async function reviseRunArtifact(artifactId: string, value: unknown) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.reviseArtifact(selectedRun.id, artifactId, value);
    setData((current) => current ? {
      ...current,
      updatedAt: revisedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate),
    } : current);
  }

  async function executeRunNode(nodeId: string, input?: Parameters<typeof StudioApi.executeNode>[2]) {
    if (!selectedRun) return;
    const executedRun = await StudioApi.executeNode(selectedRun.id, nodeId, input);
    setData((current) => current ? {
      ...current,
      updatedAt: executedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === executedRun.id ? executedRun : candidate),
    } : current);
  }

  async function continueRunAgentLoop() {
    if (!selectedRun) throw new Error("当前节目不可用");
    const executedNodeIds: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const result = await StudioApi.continueAgentLoop(selectedRun.id);
      executedNodeIds.push(...result.executedNodeIds);
      setData((current) => current ? {
        ...current,
        updatedAt: result.run.updatedAt,
        runs: current.runs.map((candidate) => candidate.id === result.run.id ? result.run : candidate),
      } : current);
      if (result.reason === "continue_available_work") continue;
      if (result.stoppedAtNodeId) setSelectedNodeId(result.stoppedAtNodeId);
      return { ...result, executedNodeIds };
    }
    throw new Error("自动制作超过单轮 40 个步骤，已停止以避免无界循环。");
  }

  async function loadExecutionPreview(nodeId: string) {
    if (!selectedRun) throw new Error("当前节目不可用");
    return StudioApi.loadExecutionPreview(selectedRun.id, nodeId);
  }

  async function authorizeRunNodeSpend(nodeId: string, maxCostCny: number) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.authorizeNodeSpend(selectedRun.id, nodeId, {
      maxCostCny,
      maxAttempts: 1,
      termsConfirmed: true,
    });
    setData((current) => current ? {
      ...current,
      updatedAt: revisedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate),
    } : current);
  }

  async function reconcileRunCost(receiptId: string, actualCostCny: number, note: string, providerInvoiceId?: string) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.reconcileExecutionCost(selectedRun.id, receiptId, { actualCostCny, note, ...(providerInvoiceId ? { providerInvoiceId } : {}) });
    setData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerReleaseMaster(file: File, metadata: Parameters<typeof StudioApi.registerReleaseMaster>[2]) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.registerReleaseMaster(selectedRun.id, file, metadata);
    setData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerCover(file: File, metadata: Parameters<typeof StudioApi.registerCover>[2]) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.registerCover(selectedRun.id, file, metadata);
    setData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function selectCover(coverId: string) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.selectCover(selectedRun.id, coverId);
    setData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerPublication(input: Parameters<typeof StudioApi.registerPublication>[1]) {
    if (!selectedRun) return;
    const result = await StudioApi.registerPublication(selectedRun.id, input);
    setData((current) => current ? {
      ...current,
      updatedAt: result.run.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === result.run.id ? result.run : candidate),
      opportunities: result.opportunity
        ? current.opportunities.map((candidate) => candidate.id === result.opportunity?.id ? result.opportunity : candidate)
        : current.opportunities,
    } : current);
  }

  async function createSeries(input: Parameters<typeof StudioApi.createSeries>[0]) {
    const series = await StudioApi.createSeries(input);
    setData((current) => current ? { ...current, series: [...current.series, series] } : current);
    try {
      setInbox(await StudioApi.loadCandidates(false));
      setCandidateLoadError(undefined);
    } catch (reason) {
      setCandidateLoadError(reason instanceof Error ? reason.message : "新系列已创建，但下一期提案暂未刷新");
    }
  }

  async function reviewResearchSource(artifactId: string, sourceId: string, verified: boolean) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.reviewResearchSource(selectedRun.id, artifactId, sourceId, verified);
    setData((current) => current ? {
      ...current,
      updatedAt: revisedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate),
    } : current);
  }

  async function adoptCandidate(candidate: EpisodeCandidate) {
    setAdoptingId(candidate.id);
    setCandidateActionError(undefined);
    try {
      const adopted = await StudioApi.adoptCandidate(candidate.id, candidate.verification.status === "review_required");
      mergeAdoptedOpportunity(adopted.opportunity);
      setSelectedOpportunityId(adopted.opportunity.id);
    } catch (reason) {
      setCandidateActionError(reason instanceof Error ? reason.message : "无法采用这个选题");
    } finally {
      setAdoptingId(undefined);
    }
  }

  async function adoptCustom(input: Parameters<typeof StudioApi.adoptCustom>[0]): Promise<boolean> {
    setAdoptingId("custom");
    setCandidateActionError(undefined);
    try {
      const adopted = await StudioApi.adoptCustom(input);
      mergeAdoptedOpportunity(adopted.opportunity);
      setSelectedOpportunityId(adopted.opportunity.id);
      return true;
    } catch (reason) {
      setCandidateActionError(reason instanceof Error ? reason.message : "无法采用这个自定义选题");
      return false;
    } finally {
      setAdoptingId(undefined);
    }
  }

  async function startEpisode(input: Parameters<typeof StudioApi.startEpisode>[1]) {
    if (!selectedOpportunity) return;
    if (!confirmDiscardProductionDraft()) return;
    setStartPending(true);
    setStartError(undefined);
    try {
      const started = await StudioApi.startEpisode(selectedOpportunity.id, input);
      const nodeId = recommendedNode(started.run)?.id;
      setData(await StudioApi.loadBootstrap());
      setSelectedRunId(started.run.id);
      setSelectedNodeId(nodeId);
      setSelectedOpportunityId(undefined);
      setView("production");
      writeLocationState({ view: "production", runId: started.run.id, nodeId });
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : "无法启动节目制作");
    } finally {
      setStartPending(false);
    }
  }

  function openProduction(runId: string, requestedNodeId?: string) {
    if (view === "production" && !confirmDiscardProductionDraft()) return;
    const run = data?.runs.find((candidate) => candidate.id === runId);
    const nodeId = run?.nodes.some((node) => node.id === requestedNodeId) ? requestedNodeId : run ? recommendedNode(run)?.id : undefined;
    setSelectedRunId(runId);
    setSelectedNodeId(nodeId);
    setView("production");
    scrollWorkbenchTop();
    writeLocationState({ view: "production", runId, nodeId });
  }

  function openCandidate(candidate: EpisodeCandidate) {
    if (!confirmDiscardProductionDraft()) return;
    setFocusedCandidateId(candidate.id);
    setView("today");
    scrollWorkbenchTop();
    writeLocationState({ view: "today" });
  }

  function openSeries(seriesId: string) {
    if (!confirmDiscardProductionDraft()) return;
    setFocusedSeriesId(seriesId);
    setView("formats");
    scrollWorkbenchTop();
    writeLocationState({ view: "formats", seriesId });
  }

  function navigate(viewId: ViewId) {
    if (viewId !== "production" && !confirmDiscardProductionDraft()) return;
    setView(viewId);
    scrollWorkbenchTop();
    if (viewId === "formats") setFocusedSeriesId(undefined);
    if (viewId === "production" && selectedRun) {
      const nodeId = selectedNodeId && selectedRun.nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : recommendedNode(selectedRun)?.id;
      setSelectedNodeId(nodeId);
      writeLocationState({ view: viewId, runId: selectedRun.id, nodeId });
      return;
    }
    writeLocationState({ view: viewId });
  }

  function selectRun(runId: string) {
    if (runId !== selectedRunId && !confirmDiscardProductionDraft()) return;
    const run = data?.runs.find((candidate) => candidate.id === runId);
    const nodeId = run ? recommendedNode(run)?.id : undefined;
    setSelectedRunId(runId);
    setSelectedNodeId(nodeId);
    writeLocationState({ view: "production", runId, nodeId });
  }

  function selectNode(nodeId: string) {
    if (!selectedRun) return;
    setSelectedNodeId(nodeId);
    writeLocationState({ view: "production", runId: selectedRun.id, nodeId });
  }

  function mergeAdoptedOpportunity(opportunity: StudioBootstrap["opportunities"][number]) {
    setData((current) => current ? {
      ...current,
      updatedAt: opportunity.adoptedAt,
      opportunities: [opportunity, ...current.opportunities.filter((candidate) => candidate.id !== opportunity.id)],
    } : current);
  }

  function confirmDiscardProductionDraft(): boolean {
    if (view !== "production" || !productionDirty) return true;
    const discard = window.confirm("当前制作步骤有未保存的结构化草稿。放弃修改并离开吗？");
    if (discard) setProductionDirty(false);
    return discard;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark"><AudioLines size={22} /></span>
          <span><strong>Token Talk</strong><small>PODCAST STUDIO</small></span>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={view === item.id ? "active" : ""} type="button" key={item.id} aria-label={item.label} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>
                <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button className={`resource-nav${view === "resources" ? " active" : ""}`} type="button" aria-label="打开声音与音乐" aria-current={view === "resources" ? "page" : undefined} onClick={() => navigate("resources") }>
            <Settings2 size={17} aria-hidden="true" /><span>声音与音乐</span>
          </button>
          <div className="local-status"><span /><div><strong>本地工作区</strong><small>{data.runs.length} 个节目记录</small></div></div>
        </div>
      </aside>

      <main className="main-canvas">
        <StudioCommandBar data={data} inbox={inbox} historicalCandidates={historicalCandidates} onOpenRun={openProduction} onOpenCandidate={openCandidate} onOpenSeries={openSeries} onOpenOpportunity={setSelectedOpportunityId} />
        {view === "today" && <TodayView data={data} inbox={inbox} loading={candidateLoading} loadError={candidateLoadError} actionError={candidateActionError} adoptingId={adoptingId} onRefresh={() => loadCandidates(true)} onDismissActionError={() => setCandidateActionError(undefined)} onAdopt={adoptCandidate} onAdoptCustom={adoptCustom} onConfigureOpportunity={setSelectedOpportunityId} onOpenProduction={openProduction} focusCandidateId={focusedCandidateId} />}
        {view === "formats" && <SeriesView data={data} inbox={inbox} historicalCandidates={historicalCandidates} loading={candidateLoading} loadError={candidateLoadError} actionError={candidateActionError} adoptingId={adoptingId} onAdopt={adoptCandidate} onDismissActionError={() => setCandidateActionError(undefined)} onRefresh={() => loadCandidates(true)} onOpenProduction={openProduction} onCreateSeries={createSeries} focusSeriesId={focusedSeriesId} />}
        {view === "resources" && <ProviderView data={data} />}
        {view === "production" && selectedRun ? (
          <div className="production-view">
            <label className="run-switcher"><span>当前节目</span><select aria-label="选择制作中的节目" value={selectedRun.id} onChange={(event) => selectRun(event.target.value)}>{data.runs.map((run) => <option value={run.id} key={run.id}>{run.title}</option>)}</select></label>
            <EpisodeStudio data={data} run={selectedRun} selectedNodeId={selectedNodeId} onSelectNode={selectNode} onReviseArtifact={reviseRunArtifact} onReviewResearchSource={reviewResearchSource} onExecuteNode={executeRunNode} onContinueAgentLoop={continueRunAgentLoop} onLoadExecutionPreview={loadExecutionPreview} onAuthorizeSpend={authorizeRunNodeSpend} onReconcileCost={reconcileRunCost} onRegisterReleaseMaster={registerReleaseMaster} onRegisterCover={registerCover} onSelectCover={selectCover} onRegisterPublication={registerPublication} onDirtyChange={setProductionDirty} />
          </div>
        ) : view === "production" ? <div className="empty-state"><span>采用一个选题后，制作现场会出现在这里。</span><button className="primary-command" type="button" onClick={() => navigate("today")}>去选题</button></div> : null}
      </main>
      {selectedOpportunity ? <EpisodeStartDialog data={data} opportunity={selectedOpportunity} pending={startPending} error={startError} onClose={() => setSelectedOpportunityId(undefined)} onStart={startEpisode} /> : null}
    </div>
  );
}

function scrollWorkbenchTop(): void {
  window.scrollTo({ top: 0, left: 0 });
}

function readLocationState(): { view: ViewId; runId?: string; nodeId?: string; seriesId?: string } {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const view: ViewId = requestedView === "production" || requestedView === "formats" || requestedView === "resources" ? requestedView : "today";
  const runId = params.get("run") || undefined;
  const nodeId = params.get("node") || undefined;
  const seriesId = params.get("series") || undefined;
  return { view, ...(runId ? { runId } : {}), ...(nodeId ? { nodeId } : {}), ...(seriesId ? { seriesId } : {}) };
}

function writeLocationState(state: { view: ViewId; runId?: string; nodeId?: string | undefined; seriesId?: string }): void {
  const url = new URL(window.location.href);
  url.search = "";
  if (state.view !== "today") url.searchParams.set("view", state.view);
  if (state.view === "production" && state.runId) url.searchParams.set("run", state.runId);
  if (state.view === "production" && state.nodeId) url.searchParams.set("node", state.nodeId);
  if (state.view === "formats" && state.seriesId) url.searchParams.set("series", state.seriesId);
  window.history.pushState(null, "", url);
}
