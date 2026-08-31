import type { EpisodeCandidate } from "@token-talk/domain";
import type { AgentLoopJob, CandidateInbox, StudioBootstrap } from "../shared/api.js";
import {
  AudioLines,
  ListMusic,
  PanelsTopLeft,
  Radio,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
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
const CANDIDATE_WARMUP_SYNC_INTERVAL_MS = 1_000;
const CANDIDATE_WARMUP_SYNC_LIMIT = 20;

export function App({ initialData, initialInbox }: AppProps) {
  const [view, setView] = useState<ViewId>(() => readLocationState().view);
  const [data, setData] = useState<StudioBootstrap | undefined>(initialData);
  const dataRef = useRef<StudioBootstrap | undefined>(initialData);
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
  const [selectedNodeId, setSelectedNodeId] = useState(() => {
    const location = readLocationState();
    const runId = initialData?.runs.some((run) => run.id === location.runId) ? location.runId : initialData?.runs[0]?.id;
    return restoredAgentLoopNodeId(initialData, runId, location.nodeId);
  });
  const [focusedCandidateId, setFocusedCandidateId] = useState<string>();
  const [focusedSeriesId, setFocusedSeriesId] = useState(() => readLocationState().seriesId);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>();
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [productionDirty, setProductionDirty] = useState(false);
  const [agentLoopRefreshPending, setAgentLoopRefreshPending] = useState(false);
  const candidateRequestInFlight = useRef(false);
  const candidateActiveRefresh = useRef(false);
  const candidateRefreshQueued = useRef(false);
  const candidateCacheSyncQueued = useRef(false);
  const candidateWarmupAttempts = useRef(0);
  const agentLoopStartKeys = useRef(new Map<string, string>());
  const dataEpoch = useRef(0);
  const productionDirtyRef = useRef(productionDirty);
  const pendingAgentLoopTarget = useRef<{ runId: string; nodeId?: string } | undefined>(undefined);
  const commitData = useCallback((next: SetStateAction<StudioBootstrap | undefined>) => {
    const current = dataRef.current;
    const resolved = typeof next === "function"
      ? (next as (value: StudioBootstrap | undefined) => StudioBootstrap | undefined)(current)
      : next;
    if (Object.is(current, resolved)) return;
    dataRef.current = resolved;
    dataEpoch.current += 1;
    setData(resolved);
  }, []);
  const updateProductionDirty = useCallback((dirty: boolean) => {
    productionDirtyRef.current = dirty;
    setProductionDirty(dirty);
  }, []);
  const activeAgentLoopJobSignature = data?.agentLoopJobs
    .filter((job) => ["queued", "running", "cancel_requested"].includes(job.status))
    .map((job) => `${job.id}:${job.status}`)
    .join(",") ?? "";

  useEffect(() => {
    StudioApi.configureLocalSession(data?.mutationToken);
  }, [data?.mutationToken]);

  useEffect(() => {
    if (productionDirty || !agentLoopRefreshPending) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const requestedAtEpoch = dataEpoch.current;
      try {
        const bootstrap = await StudioApi.loadBootstrap();
        if (cancelled || productionDirtyRef.current) return;
        if (requestedAtEpoch !== dataEpoch.current) {
          timer = window.setTimeout(() => void refresh(), 2_000);
          return;
        }
        commitData(bootstrap);
        const target = pendingAgentLoopTarget.current;
        if (target && target.runId === selectedRunId && target.nodeId) setSelectedNodeId(target.nodeId);
        pendingAgentLoopTarget.current = undefined;
        setAgentLoopRefreshPending(false);
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentLoopRefreshPending, commitData, productionDirty, selectedRunId]);

  useEffect(() => {
    if (initialData) return;
    setBootError(undefined);
    StudioApi.loadBootstrap().then((value) => {
      commitData(value);
      const location = readLocationState();
      const runId = value.runs.some((run) => run.id === location.runId) ? location.runId : value.runs[0]?.id;
      setSelectedRunId(runId);
      setSelectedNodeId(restoredAgentLoopNodeId(value, runId, location.nodeId));
    }).catch((reason: unknown) => {
      setBootError(reason instanceof Error ? reason.message : "无法载入 Studio 数据");
    });
  }, [bootAttempt, commitData, initialData]);

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
      setSelectedNodeId(restoredAgentLoopNodeId(data, location.runId, location.nodeId));
      setFocusedSeriesId(location.seriesId);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [data, focusedSeriesId, productionDirty, selectedNodeId, selectedRunId, view]);

  const loadCandidates = useCallback(async (refresh: boolean, silent = false, cached = false, queueIfBusy = false) => {
    if (candidateRequestInFlight.current) {
      if (refresh && !candidateActiveRefresh.current) {
        candidateRefreshQueued.current = true;
        setCandidateLoading(true);
      } else if (queueIfBusy && !candidateRefreshQueued.current) {
        candidateCacheSyncQueued.current = true;
        setCandidateLoading(true);
      }
      return;
    }
    candidateRequestInFlight.current = true;
    let request = { refresh, silent, cached };
    try {
      while (request) {
        candidateActiveRefresh.current = request.refresh;
        if (!request.silent) setCandidateLoading(true);
        setCandidateLoadError(undefined);
        try {
          setInbox(await StudioApi.loadCandidates(request.refresh, request.cached));
        } catch (reason) {
          setCandidateLoadError(reason instanceof Error ? reason.message : "无法载入今日选题");
        }
        if (candidateRefreshQueued.current) {
          candidateRefreshQueued.current = false;
          candidateCacheSyncQueued.current = false;
          request = { refresh: true, silent: false, cached: false };
        } else if (candidateCacheSyncQueued.current) {
          candidateCacheSyncQueued.current = false;
          request = { refresh: false, silent: false, cached: true };
        } else {
          break;
        }
      }
    } finally {
      candidateActiveRefresh.current = false;
      candidateRequestInFlight.current = false;
      setCandidateLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialInbox || !data?.mutationToken) return;
    void loadCandidates(false);
  }, [data?.mutationToken, initialInbox, loadCandidates]);

  useEffect(() => {
    const syncCachedCandidates = () => {
      if (!data?.mutationToken) return;
      void loadCandidates(false, true, true);
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

  const trendCandidateCount = inbox?.items.filter((candidate) => candidate.origin === "trend").length ?? 0;
  useEffect(() => {
    const waitingForFirstTrendSnapshot = Boolean(
      data?.mutationToken
      && inbox
      && trendCandidateCount === 0
      && inbox.freshness?.status === "fallback",
    );
    if (!waitingForFirstTrendSnapshot) {
      candidateWarmupAttempts.current = 0;
      return;
    }
    const timer = window.setInterval(() => {
      if (candidateRequestInFlight.current) return;
      if (candidateWarmupAttempts.current >= CANDIDATE_WARMUP_SYNC_LIMIT) {
        window.clearInterval(timer);
        return;
      }
      candidateWarmupAttempts.current += 1;
      void loadCandidates(false, true, true);
    }, CANDIDATE_WARMUP_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [data?.mutationToken, inbox, loadCandidates, trendCandidateCount]);

  useEffect(() => {
    if (!activeAgentLoopJobSignature) return;
    let cancelled = false;
    let timer: number | undefined;
    const syncAgentLoop = async () => {
      const requestedAtEpoch = dataEpoch.current;
      try {
        const bootstrap = await StudioApi.loadBootstrap();
        if (!cancelled && !productionDirtyRef.current && requestedAtEpoch === dataEpoch.current) {
          const activeJobIds = new Set(dataRef.current?.agentLoopJobs
            .filter((job) => ["queued", "running", "cancel_requested"].includes(job.status))
            .map((job) => job.id));
          const stoppedJob = [...bootstrap.agentLoopJobs].reverse().find((job) =>
            activeJobIds.has(job.id)
            && !["queued", "running", "cancel_requested"].includes(job.status)
            && job.stoppedAtNodeId);
          commitData(bootstrap);
          const stoppedRunId = stoppedJob?.runId;
          const stoppedNodeId = stoppedJob?.stoppedAtNodeId;
          if (stoppedRunId && stoppedRunId === selectedRunId && stoppedNodeId) {
            setSelectedNodeId(stoppedNodeId);
            const location = readLocationState();
            if (location.view === "production" && location.runId === stoppedRunId) {
              writeLocationState({ view: "production", runId: stoppedRunId, nodeId: stoppedNodeId });
            }
          }
        }
      } catch {
        // 云端作业继续执行；短暂轮询失败不应把制作流程标记为失败。
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void syncAgentLoop(), 2_000);
      }
    };
    timer = window.setTimeout(() => void syncAgentLoop(), 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeAgentLoopJobSignature, commitData, productionDirty, selectedRunId]);

  useEffect(() => {
    for (const [runId] of agentLoopStartKeys.current) {
      const latest = [...(data?.agentLoopJobs ?? [])].reverse().find((job) => job.runId === runId);
      if (latest && !["queued", "running", "cancel_requested"].includes(latest.status)) {
        agentLoopStartKeys.current.delete(runId);
      }
    }
  }, [data?.agentLoopJobs]);

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
    commitData((current) => current ? {
      ...current,
      updatedAt: revisedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate),
    } : current);
  }

  async function executeRunNode(nodeId: string, input?: Parameters<typeof StudioApi.executeNode>[2]) {
    if (!selectedRun) return;
    const executedRun = await StudioApi.executeNode(selectedRun.id, nodeId, input);
    commitData((current) => current ? {
      ...current,
      updatedAt: executedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === executedRun.id ? executedRun : candidate),
    } : current);
  }

  async function continueRunAgentLoop() {
    if (!selectedRun) throw new Error("当前节目不可用");
    const runId = selectedRun.id;
    const idempotencyKey = agentLoopStartKeys.current.get(runId) ?? agentLoopRequestId();
    agentLoopStartKeys.current.set(runId, idempotencyKey);
    let job: AgentLoopJob;
    try {
      job = await StudioApi.startAgentLoopJob(runId, idempotencyKey);
    } catch (startError) {
      let latest: AgentLoopJob;
      try {
        latest = await StudioApi.loadLatestAgentLoopJob(runId);
      } catch {
        throw startError;
      }
      const active = ["queued", "running", "cancel_requested"].includes(latest.status);
      if (latest.idempotencyKey !== idempotencyKey && !active) throw startError;
      job = latest;
    }
    mergeAgentLoopJob(job);
    while (["queued", "running", "cancel_requested"].includes(job.status)) {
      await delay(1_500);
      try {
        job = await StudioApi.loadAgentLoopJob(runId, job.id);
      } catch {
        // 作业属于服务端；短暂网络故障只能延迟观察，不能终止或重复启动它。
        const persisted = dataRef.current?.agentLoopJobs.find((candidate) => candidate.id === job.id && candidate.runId === runId);
        if (persisted) job = persisted;
        continue;
      }
      mergeAgentLoopJob(job);
    }
    agentLoopStartKeys.current.delete(runId);
    pendingAgentLoopTarget.current = { runId, ...(job.stoppedAtNodeId ? { nodeId: job.stoppedAtNodeId } : {}) };
    setAgentLoopRefreshPending(true);
    return {
      run: selectedRun,
      executedNodeIds: job.executedNodeIds,
      ...(job.stoppedAtNodeId ? { stoppedAtNodeId: job.stoppedAtNodeId } : {}),
      reason: job.status === "cancelled"
        ? "cancelled" as const
        : job.reason === "interrupted_execution"
          ? "requires_input" as const
          : job.reason ?? "failed" as const,
    };
  }

  async function cancelRunAgentLoop() {
    if (!selectedRun) return;
    const job = [...(data?.agentLoopJobs ?? [])].reverse().find((candidate) =>
      candidate.runId === selectedRun.id && ["queued", "running", "cancel_requested"].includes(candidate.status));
    if (!job) return;
    mergeAgentLoopJob(await StudioApi.cancelAgentLoopJob(selectedRun.id, job.id));
  }

  function mergeAgentLoopJob(job: AgentLoopJob) {
    commitData((current) => {
      if (!current) return current;
      const jobs = mergeMonotonicAgentLoopJob(current.agentLoopJobs, job);
      return jobs === current.agentLoopJobs ? current : { ...current, updatedAt: job.updatedAt, agentLoopJobs: jobs };
    });
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
    commitData((current) => current ? {
      ...current,
      updatedAt: revisedRun.updatedAt,
      runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate),
    } : current);
  }

  async function reconcileRunCost(receiptId: string, actualCostCny: number, note: string, providerInvoiceId?: string) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.reconcileExecutionCost(selectedRun.id, receiptId, { actualCostCny, note, ...(providerInvoiceId ? { providerInvoiceId } : {}) });
    commitData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerReleaseMaster(file: File, metadata: Parameters<typeof StudioApi.registerReleaseMaster>[2]) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.registerReleaseMaster(selectedRun.id, file, metadata);
    commitData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerCover(file: File, metadata: Parameters<typeof StudioApi.registerCover>[2]) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.registerCover(selectedRun.id, file, metadata);
    commitData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function selectCover(coverId: string) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.selectCover(selectedRun.id, coverId);
    commitData((current) => current ? { ...current, updatedAt: revisedRun.updatedAt, runs: current.runs.map((candidate) => candidate.id === revisedRun.id ? revisedRun : candidate) } : current);
  }

  async function registerPublication(input: Parameters<typeof StudioApi.registerPublication>[1]) {
    if (!selectedRun) return;
    const result = await StudioApi.registerPublication(selectedRun.id, input);
    commitData((current) => current ? {
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
    commitData((current) => current ? { ...current, series: [...current.series, series] } : current);
    await loadCandidates(false, true, true, true);
  }

  async function reviewResearchSource(artifactId: string, sourceId: string, verified: boolean) {
    if (!selectedRun) return;
    const revisedRun = await StudioApi.reviewResearchSource(selectedRun.id, artifactId, sourceId, verified);
    commitData((current) => current ? {
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
      commitData(await StudioApi.loadBootstrap());
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
    const nodeId = restoredAgentLoopNodeId(data, runId, requestedNodeId);
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
    const nodeId = restoredAgentLoopNodeId(data, runId);
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
    commitData((current) => current ? {
      ...current,
      updatedAt: opportunity.adoptedAt,
      opportunities: [opportunity, ...current.opportunities.filter((candidate) => candidate.id !== opportunity.id)],
    } : current);
  }

  function confirmDiscardProductionDraft(): boolean {
    if (view !== "production" || !productionDirty) return true;
    const discard = window.confirm("当前制作步骤有未保存的结构化草稿。放弃修改并离开吗？");
    if (discard) updateProductionDirty(false);
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
            <EpisodeStudio key={selectedRun.id} data={data} run={selectedRun} selectedNodeId={selectedNodeId} onSelectNode={selectNode} onReviseArtifact={reviseRunArtifact} onReviewResearchSource={reviewResearchSource} onExecuteNode={executeRunNode} onContinueAgentLoop={continueRunAgentLoop} onCancelAgentLoop={cancelRunAgentLoop} onLoadExecutionPreview={loadExecutionPreview} onAuthorizeSpend={authorizeRunNodeSpend} onReconcileCost={reconcileRunCost} onRegisterReleaseMaster={registerReleaseMaster} onRegisterCover={registerCover} onSelectCover={selectCover} onRegisterPublication={registerPublication} onDirtyChange={updateProductionDirty} />
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function agentLoopRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `agent-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function restoredAgentLoopNodeId(
  data: StudioBootstrap | undefined,
  runId: string | undefined,
  requestedNodeId?: string,
): string | undefined {
  const run = data?.runs.find((candidate) => candidate.id === runId);
  if (!run) return undefined;
  if (requestedNodeId && run.nodes.some((node) => node.id === requestedNodeId)) return requestedNodeId;
  const latestJob = [...(data?.agentLoopJobs ?? [])].reverse().find((job) => job.runId === run.id);
  if (latestJob?.stoppedAtNodeId && run.nodes.some((node) => node.id === latestJob.stoppedAtNodeId)) {
    return latestJob.stoppedAtNodeId;
  }
  return recommendedNode(run)?.id;
}

function mergeMonotonicAgentLoopJob(jobs: AgentLoopJob[], incoming: AgentLoopJob): AgentLoopJob[] {
  const current = jobs.find((job) => job.id === incoming.id);
  if (current && sameAgentLoopJob(current, incoming)) return jobs;
  if (current && !isNewerAgentLoopJob(current, incoming)) return jobs;
  return [...jobs.filter((job) => job.id !== incoming.id), incoming];
}

function sameAgentLoopJob(left: AgentLoopJob, right: AgentLoopJob): boolean {
  return left.id === right.id
    && left.runId === right.runId
    && left.idempotencyKey === right.idempotencyKey
    && left.status === right.status
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.cancelRequestedAt === right.cancelRequestedAt
    && left.currentNodeId === right.currentNodeId
    && left.stoppedAtNodeId === right.stoppedAtNodeId
    && left.reason === right.reason
    && left.errorMessage === right.errorMessage
    && left.executedNodeIds.length === right.executedNodeIds.length
    && left.executedNodeIds.every((nodeId, index) => nodeId === right.executedNodeIds[index]);
}

function isNewerAgentLoopJob(current: AgentLoopJob, incoming: AgentLoopJob): boolean {
  const terminal = new Set<AgentLoopJob["status"]>(["cancelled", "completed", "blocked", "failed"]);
  if (terminal.has(current.status)) return false;
  const phase: Record<AgentLoopJob["status"], number> = {
    queued: 0,
    running: 1,
    cancel_requested: 2,
    cancelled: 3,
    completed: 3,
    blocked: 3,
    failed: 3,
  };
  if (phase[incoming.status] < phase[current.status]) return false;
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt);
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
