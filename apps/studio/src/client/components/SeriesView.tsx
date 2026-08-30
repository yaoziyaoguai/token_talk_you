import type { EpisodeCandidate } from "@token-talk/domain";
import type { CandidateInbox, CreateSeriesInput, StudioBootstrap } from "../../shared/api.js";
import { AlertCircle, ArrowRight, BookOpenText, Clock3, Headphones, Music2, Plus, Radio, RefreshCw, Users, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SeriesArtwork } from "./SeriesArtwork.js";
import { nextActionNode } from "../production-state.js";

const castPolicyLabels = { dynamic: "按每期选题动态编排", recurring_with_guests: "固定主持与动态嘉宾", fixed: "固定阵容" } as const;
const musicPolicyLabels = { minimal: "克制留白", narrative: "叙事 Cue", immersive: "沉浸声景" } as const;

interface SeriesViewProps {
  data: StudioBootstrap;
  inbox: CandidateInbox | undefined;
  historicalCandidates: boolean;
  loading: boolean;
  loadError: string | undefined;
  actionError: string | undefined;
  adoptingId: string | undefined;
  onAdopt: (candidate: EpisodeCandidate) => Promise<void>;
  onDismissActionError: () => void;
  onRefresh: () => Promise<void> | void;
  onOpenProduction: (runId: string) => void;
  onCreateSeries: (input: CreateSeriesInput) => Promise<void>;
  focusSeriesId?: string | undefined;
}

export function SeriesView({ data, inbox, historicalCandidates, loading, loadError, actionError, adoptingId, onAdopt, onDismissActionError, onRefresh, onOpenProduction, onCreateSeries, focusSeriesId }: SeriesViewProps) {
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [title, setTitle] = useState("");
  const [promise, setPromise] = useState("");
  const [audience, setAudience] = useState("");
  const [castMode, setCastMode] = useState<CreateSeriesInput["castPolicy"]["mode"]>("dynamic");
  const [castRoles, setCastRoles] = useState("");
  const [musicPolicy, setMusicPolicy] = useState<CreateSeriesInput["musicPolicy"]>("minimal");
  const createRequestId = useRef(newRequestId());

  useEffect(() => {
    if (!focusSeriesId) return;
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`series-${focusSeriesId}`);
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      element?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      element?.focus({ preventScroll: true });
    });
  }, [focusSeriesId]);

  async function submitSeries(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setCreatePending(true);
      setCreateError(undefined);
      const roles = parseSeriesRoles(castRoles);
      await onCreateSeries({
        requestId: createRequestId.current,
        title: title.trim(),
        promise: promise.trim(),
        audience: audience.trim(),
        castPolicy: { mode: castMode, recurringRoleIds: roles.map((role) => role.id), roles },
        musicPolicy,
      });
      createRequestId.current = newRequestId();
      setCreating(false);
      setTitle("");
      setPromise("");
      setAudience("");
      setCastMode("dynamic");
      setCastRoles("");
      setMusicPolicy("minimal");
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "无法创建系列，请重试");
    } finally {
      setCreatePending(false);
    }
  }

  return (
    <div className="view-stack formats-view">
      <header className="view-header series-page-header">
        <div><p className="eyebrow">节目资产</p><h1>让节目值得追更</h1><p className="header-summary">系列不是模板仓库。它保存栏目承诺、声音气质和听众记忆，再把下一期变成一个新的问题。</p></div>
        <div className="series-header-actions"><span className="series-count"><strong>{data.series.length}</strong><small>个连载系列</small></span><button className="primary-command" type="button" onClick={() => setCreating(true)}><Plus size={15} />新建系列</button></div>
      </header>

      {creating ? <section className="series-create-workbench" aria-labelledby="series-create-title">
        <header><div><p className="eyebrow">新节目</p><h2 id="series-create-title">定义系列承诺</h2></div><button className="icon-command" type="button" title="关闭新建系列" aria-label="关闭新建系列" onClick={() => setCreating(false)}><X size={17} /></button></header>
        <form onSubmit={(event) => void submitSeries(event)}>
          <label><span>系列名称</span><input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="series-wide-field"><span>每一期都要兑现的承诺</span><input required maxLength={240} value={promise} onChange={(event) => setPromise(event.target.value)} /></label>
          <label className="series-wide-field"><span>核心听众</span><input required maxLength={240} value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
          <label><span>角色策略</span><select value={castMode} onChange={(event) => setCastMode(event.target.value as typeof castMode)}><option value="dynamic">每期动态编排</option><option value="recurring_with_guests">固定主持与动态嘉宾</option><option value="fixed">固定阵容</option></select></label>
          <label><span>音乐策略</span><select value={musicPolicy} onChange={(event) => setMusicPolicy(event.target.value as typeof musicPolicy)}><option value="minimal">克制留白</option><option value="narrative">叙事 Cue</option><option value="immersive">沉浸声景</option></select></label>
          {castMode !== "dynamic" ? <label className="series-wide-field"><span>{castMode === "fixed" ? "固定角色" : "常驻角色"}</span><input required value={castRoles} placeholder="例如：主持人、书评人（用逗号分隔）" onChange={(event) => setCastRoles(event.target.value)} /></label> : null}
          {createError ? <p className="field-error series-wide-field" role="alert">{createError}</p> : null}
          <footer className="series-wide-field"><span>{castMode === "dynamic" ? "每一期按具体选题重新安排角色和声音。" : castMode === "fixed" ? "每一期沿用这些角色，声音仍需逐一确认授权。" : "常驻角色保留，本期嘉宾按选题动态增加。"}</span><button className="primary-command" type="submit" disabled={createPending || !title.trim() || !promise.trim() || !audience.trim() || (castMode !== "dynamic" && parseSeriesRoles(castRoles).length === 0)}>{createPending ? "正在创建" : "创建系列"}</button></footer>
        </form>
      </section> : null}

      {actionError ? <div className="inline-error series-action-error" role="alert">{actionError}<button type="button" onClick={onDismissActionError}>关闭</button></div> : null}

      <section className="series-programs" aria-label="连载系列">
        {data.series.map((series) => {
          const candidates = (inbox?.items ?? []).filter((candidate) => candidate.origin === "series" && candidate.seriesId === series.id);
          const runs = data.runs.filter((run) => run.seriesId === series.id);
          const activeRun = runs.find((run) => !["release_ready", "completed"].includes(run.status)) ?? runs[0];
          return (
            <article id={`series-${series.id}`} className={`series-program${series.id === focusSeriesId ? " focused" : ""}`} key={series.id} tabIndex={-1}>
              <div className="series-cover-stage">
                <SeriesArtwork seriesId={series.id} title={series.title} />
                <span className="series-issue">SERIES · {String(runs.length + 1).padStart(2, "0")}</span>
              </div>

              <div className="series-identity">
                <span className="series-live"><i />正在连载</span>
                <h2>{series.title}</h2>
                <blockquote>{series.promise}</blockquote>
                <p>{series.audience}</p>
                <div className="series-policy">
                  <span><Users size={15} />{castPolicyLabels[series.castPolicy.mode]}</span>
                  <span><Music2 size={15} />{musicPolicyLabels[series.sonicBible.musicPolicy]}</span>
                </div>
                <div className="sonic-palette" aria-label="系列声音色板">
                  <small>声音色板</small>
                  {series.sonicBible.palette.length > 0 ? series.sonicBible.palette.map((tone, index) => <span key={tone}><i style={{ "--tone-index": index } as React.CSSProperties} />{tone}</span>) : <em>不固定音色，每期按内容选择</em>}
                </div>
                {activeRun ? (
                  <button className="series-current-run" type="button" onClick={() => onOpenProduction(activeRun.id)}>
                    <Headphones size={18} /><span><small>{activeRun.status === "release_ready" ? "发行就绪" : activeRun.status === "completed" ? "最近发布" : describeSeriesRun(activeRun)}</small><strong>{activeRun.title}</strong></span><ArrowRight size={17} />
                  </button>
                ) : null}
              </div>

              <div className="series-commission">
                <header><span><Radio size={16} />下一期委约</span><small>{candidates.length ? `${candidates.length} 个策划提案` : "等待策划提案"}</small></header>
                {historicalCandidates && candidates.length ? <div className="series-candidate-snapshot" role="status"><AlertCircle size={15} /><span>显示上次保存的提案，本轮刷新未完成；立项前请重新核对时效。</span></div> : null}
                {candidates.length ? candidates.map((candidate) => (
                  <button key={candidate.id} type="button" disabled={Boolean(adoptingId)} onClick={() => void onAdopt(candidate)}>
                    <span className="commission-episode">EP {String(candidate.episodeNumber ?? 0).padStart(2, "0")}</span>
                    <span><strong>{candidate.title}</strong><small>{candidate.hook}</small></span>
                    <span className="commission-action">{adoptingId === candidate.id ? "立项中" : historicalCandidates ? "复核后立项" : "立项"}<ArrowRight size={15} /></span>
                  </button>
                )) : loading ? (
                  <div className="series-commission-empty" role="status" aria-live="polite"><RefreshCw className="is-spinning" size={21} /><span><strong>正在策划下一期</strong><small>总编正在把新信号和系列承诺放在一起判断。</small></span></div>
                ) : loadError ? (
                  <div className="series-commission-empty error" role="alert"><AlertCircle size={21} /><span><strong>下一期提案没有载入</strong><small>{loadError}</small></span><button className="secondary-command" type="button" onClick={() => void onRefresh()}>重新采集</button></div>
                ) : (
                  <div className="series-commission-empty"><BookOpenText size={21} /><span><strong>暂时没有合适的下一期</strong><small>刷新今日选题后，这里会出现延续栏目承诺的新命题。</small></span><button className="secondary-command" type="button" onClick={() => void onRefresh()}>刷新提案</button></div>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <section className="format-list" aria-labelledby="format-title">
        <div className="section-heading compact"><h2 id="format-title">可执行节目格式</h2><span>{data.recipes.length}</span></div>
        {data.recipes.map((recipe) => <article key={recipe.id}><div><BookOpenText size={19} /><span><strong>{recipe.label}</strong><small>{recipe.description}</small></span></div><div><span><Clock3 size={14} />{recipe.targetMinutes.min}–{recipe.targetMinutes.max} 分钟</span><span>{musicPolicyLabels[recipe.musicPolicy]}</span><span>预计 ¥{recipe.estimatedCostCny?.min ?? 0}–{recipe.estimatedCostCny?.max ?? 0}</span></div></article>)}
      </section>
    </div>
  );
}

function newRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `series-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseSeriesRoles(value: string): CreateSeriesInput["castPolicy"]["roles"] {
  const names = [...new Set(value.split(/[,，、\n]/).map((name) => name.trim()).filter(Boolean))].slice(0, 8);
  return names.map((name, index) => ({
    id: `series-role-${index + 1}`,
    name,
    responsibility: index === 0 ? "维持栏目承诺并推进本期问题" : "从稳定立场回应证据与反例",
  }));
}

function describeSeriesRun(run: StudioBootstrap["runs"][number]): string {
  const node = nextActionNode(run);
  if (node?.status === "failed" || node?.status === "stale") return "需要处理";
  if (node?.status === "running") return "正在执行";
  if (node?.status === "needs_human") return "执行待核对";
  if (node?.status === "awaiting_spend_approval") return "等待成本授权";
  if (node?.status === "ready") return "可以继续";
  return "制作记录";
}
