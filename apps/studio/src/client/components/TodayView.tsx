import type { EpisodeCandidate } from "@token-talk/domain";
import type { CandidateInbox, StudioBootstrap } from "../../shared/api.js";
import {
  ArrowRight,
  BookOpenText,
  BrainCircuit,
  CircleCheck,
  ExternalLink,
  Flame,
  Headphones,
  LibraryBig,
  PenLine,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SignalWave } from "./SignalWave.js";
import { StudioOverview } from "./StudioOverview.js";

type EntryMode = "trend" | "series" | "custom";
type VerdictFilter = "all" | EpisodeCandidate["verdict"];

interface TodayViewProps {
  data: StudioBootstrap;
  inbox: CandidateInbox | undefined;
  loading: boolean;
  loadError: string | undefined;
  actionError: string | undefined;
  adoptingId: string | undefined;
  onRefresh: () => Promise<void>;
  onDismissActionError: () => void;
  onAdopt: (candidate: EpisodeCandidate) => Promise<void>;
  onAdoptCustom: (input: { requestId: string; title: string; hook: string; targetMinutes: number }) => Promise<boolean>;
  onConfigureOpportunity: (opportunityId: string) => void;
  onOpenProduction: (runId: string, nodeId?: string) => void;
  focusCandidateId?: string | undefined;
}

const categoryLabels: Record<EpisodeCandidate["category"], string> = {
  ai_tech: "AI 与科技",
  business: "商业与经济",
  culture: "文化",
  science: "科学",
  society: "社会",
  books: "读书",
  education: "教育",
  health: "健康",
  life: "生活",
  world: "国际",
  other: "综合",
};

const verdictLabels: Record<EpisodeCandidate["verdict"], string> = {
  rapid_brief: "热点深谈",
  deep_discussion: "深度圆桌",
  series_episode: "系列正片",
  research_first: "先做研究",
  skip: "暂不生产",
};

const platformLabels: Record<string, string> = {
  weibo: "微博",
  baidu: "百度",
  zhihu: "知乎",
  bilibili: "B 站",
  "36kr": "36氪",
  ithome: "IT之家",
  sspai: "少数派",
  thepaper: "澎湃",
  douyin: "抖音",
  toutiao: "今日头条",
  "hacker-news": "Hacker News",
  wikipedia: "中文维基",
};

export function TodayView({
  data,
  inbox,
  loading,
  loadError,
  actionError,
  adoptingId,
  onRefresh,
  onDismissActionError,
  onAdopt,
  onAdoptCustom,
  onConfigureOpportunity,
  onOpenProduction,
  focusCandidateId,
}: TodayViewProps) {
  const [mode, setMode] = useState<EntryMode>("trend");
  const [selectedId, setSelectedId] = useState<string>();
  const [category, setCategory] = useState<EpisodeCandidate["category"] | "all">("all");
  const [verdict, setVerdict] = useState<VerdictFilter>("all");
  const [platform, setPlatform] = useState("all");
  const [suggestedFocusId, setSuggestedFocusId] = useState<string>();
  const [customTitle, setCustomTitle] = useState("");
  const [customAngle, setCustomAngle] = useState("");
  const [customDuration, setCustomDuration] = useState("30");
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia?.("(max-width: 820px)").matches ?? false);
  const customRequestId = useRef(createRequestId());
  const detailRef = useRef<HTMLElement>(null);
  const focusCustomEntry = useRef(false);

  const modeItems = useMemo(
    () => (inbox?.items ?? []).filter((item) => item.origin === mode),
    [inbox?.items, mode],
  );
  const categories = useMemo(() => countBy(modeItems, (item) => item.category), [modeItems]);
  const verdicts = useMemo(() => countBy(modeItems, (item) => item.verdict), [modeItems]);
  const platforms = useMemo(
    () => [...new Set(modeItems.flatMap((item) => candidatePlatforms(item)))],
    [modeItems],
  );
  const visibleItems = useMemo(
    () => modeItems
      .filter((item) => category === "all" || item.category === category)
      .filter((item) => verdict === "all" || item.verdict === verdict)
      .filter((item) => platform === "all" || candidatePlatforms(item).includes(platform)),
    [category, modeItems, platform, verdict],
  );
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const historicalSnapshot = inbox?.freshness?.status === "fallback"
    || inbox?.collector?.state === "degraded"
    || inbox?.collector?.state === "error"
    || Boolean(loadError && inbox);
  const trendEditorialMode = editorialSourceMode((inbox?.items ?? []).filter((item) => item.origin === "trend"));

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 820px)");
    if (!media) return;
    const updateLayout = () => setCompactLayout(media.matches);
    updateLayout();
    media.addEventListener?.("change", updateLayout);
    return () => media.removeEventListener?.("change", updateLayout);
  }, []);

  useEffect(() => {
    const focused = (inbox?.items ?? []).find((item) => item.id === focusCandidateId);
    if (!focused) return;
    setMode(focused.origin);
    setSelectedId(focused.id);
    setCategory("all");
    setVerdict("all");
    setPlatform("all");
    setSuggestedFocusId(focused.id);
  }, [focusCandidateId, inbox?.items]);

  useEffect(() => {
    if (mode !== "custom" || !focusCustomEntry.current) return;
    focusCustomEntry.current = false;
    focusCustomPanel();
  }, [mode]);

  useEffect(() => {
    if (!suggestedFocusId || selected?.id !== suggestedFocusId) return;
    setSuggestedFocusId(undefined);
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      document.getElementById("topic-entry-panel")?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    });
  }, [selected?.id, suggestedFocusId]);

  async function submitCustom(event: React.FormEvent) {
    event.preventDefault();
    const adopted = await onAdoptCustom({
      requestId: customRequestId.current,
      title: customTitle.trim(),
      hook: customAngle.trim(),
      targetMinutes: Number.parseInt(customDuration, 10),
    });
    if (adopted) customRequestId.current = createRequestId();
  }

  function selectCandidate(candidateId: string) {
    setSelectedId(candidateId);
    if (!(window.matchMedia?.("(max-width: 980px)").matches ?? false)) return;
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      detailRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    });
  }

  function openSuggestedCandidate(candidate: EpisodeCandidate) {
    onDismissActionError();
    setMode(candidate.origin);
    setSelectedId(candidate.id);
    setCategory("all");
    setVerdict("all");
    setPlatform("all");
    setSuggestedFocusId(candidate.id);
  }

  function navigateTabs(event: React.KeyboardEvent<HTMLElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const modes: EntryMode[] = ["trend", "series", "custom"];
    const current = modes.indexOf(mode);
    const next = event.key === "Home" ? modes[0]
      : event.key === "End" ? modes[modes.length - 1]
        : modes[(current + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length];
    if (!next) return;
    onDismissActionError();
    setMode(next);
    window.requestAnimationFrame(() => document.getElementById(`entry-tab-${next}`)?.focus());
  }

  function resetCandidateFilters() {
    setCategory("all");
    setVerdict("all");
    setPlatform("all");
  }

  function openCustomEntry() {
    onDismissActionError();
    focusCustomEntry.current = true;
    if (mode === "custom") {
      focusCustomEntry.current = false;
      focusCustomPanel();
    } else {
      setMode("custom");
    }
  }

  function focusCustomPanel() {
    window.requestAnimationFrame(() => {
      const panel = document.getElementById("topic-entry-panel");
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      panel?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      panel?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  }

  return (
    <div className="view-stack today-editorial">
      {!compactLayout ? <StudioOverview data={data} inbox={inbox} loading={loading} loadError={loadError} onRefresh={onRefresh} onOpenProduction={onOpenProduction} onOpenCandidate={openSuggestedCandidate} onConfigureOpportunity={onConfigureOpportunity} onStartCustom={openCustomEntry} /> : null}

      <section className="entry-launcher" aria-labelledby="entry-launcher-title">
        <header><div><p className="eyebrow">快捷开始</p><h2 id="entry-launcher-title">从哪里开始这期节目</h2></div><small>三种入口，共用同一条研究与制作流程</small></header>
        <div className="entry-tabs" role="tablist" aria-label="选题入口" onKeyDown={navigateTabs}>
          <EntryTab id="entry-tab-trend" controls="topic-entry-panel" active={mode === "trend"} icon={<Flame size={18} />} label="热点机会" note="把实时信号变成节目命题" count={(inbox?.items ?? []).filter((item) => item.origin === "trend").length} onClick={() => { onDismissActionError(); setMode("trend"); }} />
          <EntryTab id="entry-tab-series" controls="topic-entry-panel" active={mode === "series"} icon={<LibraryBig size={18} />} label="系列选题" note="让听众愿意继续追更" count={(inbox?.items ?? []).filter((item) => item.origin === "series").length} onClick={() => { onDismissActionError(); setMode("series"); }} />
          <EntryTab id="entry-tab-custom" controls="topic-entry-panel" active={mode === "custom"} icon={<PenLine size={18} />} label="自定义创作" note="从自己的问题和资料开始" onClick={() => { onDismissActionError(); setMode("custom"); }} />
        </div>
      </section>

      {mode === "custom" ? (
        <section id="topic-entry-panel" className="custom-editorial" role="tabpanel" aria-labelledby="entry-tab-custom">
          <div className="custom-editorial-intro">
            <span className="custom-signal-mark"><Headphones size={28} aria-hidden="true" /></span>
            <p className="eyebrow">原创节目</p>
            <h2 id="custom-title">不追热点，也可以做耐听的节目</h2>
            <p>提出一个真正想回答的问题。它会进入同一套研究、动态角色、声音试演和主编审核流程。</p>
          </div>
          <form onSubmit={(event) => void submitCustom(event)}>
            <label><span>节目命题</span><input required value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} placeholder="例如：AI 助手会让人更会思考吗？" /></label>
            <label><span>这期真正要追问什么</span><textarea required value={customAngle} onChange={(event) => setCustomAngle(event.target.value)} placeholder="写下冲突、反例、听众困境或尚未解决的问题" /></label>
            <label><span>目标时长</span><select value={customDuration} onChange={(event) => setCustomDuration(event.target.value)}><option value="15">15 分钟聚焦讨论</option><option value="30">30 分钟深谈</option><option value="45">45 分钟专题</option><option value="60">60 分钟特别节目</option><option value="90">90 分钟长篇</option><option value="120">120 分钟深度特辑</option><option value="180">180 分钟长篇纪实</option><option value="240">240 分钟特别企划</option></select></label>
            {actionError ? <p className="custom-error" role="alert">{actionError}</p> : null}
            <button className="primary-command" type="submit" disabled={!customTitle.trim() || !customAngle.trim() || Boolean(adoptingId)}>{adoptingId === "custom" ? "正在立项…" : "立项并进入策划"}<ArrowRight size={16} /></button>
          </form>
        </section>
      ) : (
        <section id="topic-entry-panel" className={`candidate-workspace${loading ? " is-refreshing" : ""}`} role="tabpanel" aria-labelledby={`entry-tab-${mode}`} aria-label={mode === "trend" ? "热点候选" : "系列候选"} aria-busy={loading}>
          <header className="candidate-toolbar">
            <div>
              <p className="eyebrow">{mode === "trend" ? trendEditorialMode === "ai" ? "AI 总编候选箱" : trendEditorialMode === "mixed" ? "规则与 AI 候选" : "总编候选箱" : "系列经营"}</p>
              <h2>{mode === "trend" ? "不是热搜榜，是今天的节目候选" : "下一期为什么值得回来听"}</h2>
              <p>{mode === "trend" ? trendEditorialMode === "ai" ? "跨平台聚类后，由本地 AI 总编提出命题；发现信号不等于事实证据。" : trendEditorialMode === "mixed" ? "规则与本地 AI 分别提出命题，每条候选保留实际来源；发现信号不等于事实证据。" : "跨平台聚类后，由规则总编提出命题；发现信号不等于事实证据。" : "系列承诺保持稳定，本期角色、声音与结构随题目重新编排。"}</p>
            </div>
            {mode === "trend" && inbox ? <SignalStatus inbox={inbox} loading={loading} refreshFailed={Boolean(loadError)} /> : <span className="signal-summary">{data.series.length} 个连载系列</span>}
          </header>

          {mode === "trend" && inbox ? <TrendPulse inbox={inbox} loading={loading} historical={historicalSnapshot} /> : null}

          {modeItems.length > 0 ? (
            <div className="candidate-filters" aria-label="候选筛选">
              <div className="filter-group verdict-filter">
                <button type="button" className={verdict === "all" ? "active" : ""} onClick={() => setVerdict("all")}>全部 <span>{modeItems.length}</span></button>
                {(["deep_discussion", "rapid_brief", "research_first", "skip"] as const).map((item) => verdicts[item] ? (
                  <button key={item} type="button" className={verdict === item ? "active" : ""} onClick={() => setVerdict(item)}>{verdictLabels[item]} <span>{verdicts[item]}</span></button>
                ) : null)}
              </div>
              <details className="candidate-filter-more">
                <summary>更多筛选{category !== "all" || platform !== "all" ? " · 已启用" : ""}</summary>
                <div>
                  <label><span>主题</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="all">全部主题</option>{(Object.keys(categoryLabels) as EpisodeCandidate["category"][]).map((item) => categories[item] ? <option key={item} value={item}>{categoryLabels[item]} · {categories[item]}</option> : null)}</select></label>
                  <label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="all">全部平台</option>{platforms.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></label>
                </div>
              </details>
            </div>
          ) : null}

          {loadError ? <div className="inline-error" role="alert">{loadError}<button type="button" onClick={() => void onRefresh()}>重试采集</button></div> : null}
          {actionError ? <div className="inline-error" role="alert">{actionError}<button type="button" onClick={onDismissActionError}>关闭</button></div> : null}
          {inbox?.warnings.length ? <details className="source-warning"><summary><ShieldAlert size={14} />{inbox.warnings.length} 条采集或 AI 降级信息</summary><ul>{inbox.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
          {loading && visibleItems.length === 0 ? <div className="candidate-loading" role="status" aria-live="polite"><SignalWave active /><strong>本地总编正在阅读跨平台信号</strong><span>先聚类，再判断对话价值、资料深度和系列潜力</span></div> : null}
          {!loading && !loadError && visibleItems.length === 0 ? <div className="candidate-loading"><BookOpenText size={22} /><strong>{modeItems.length ? "当前筛选没有候选" : mode === "trend" ? "暂时没有可靠的热点提案" : "这个系列还没有下一期提案"}</strong><span>{modeItems.length ? "清除筛选，回到完整候选箱。" : "也可以从一个自己真正关心的问题开始。"}</span><button className="secondary-command" type="button" onClick={modeItems.length ? resetCandidateFilters : openCustomEntry}>{modeItems.length ? "清除筛选" : "自主创作"}</button></div> : null}

          {visibleItems.length > 0 ? (
            <div className="candidate-body">
              <div className="candidate-list" aria-label="候选列表">
                {visibleItems.map((item, index) => (
                  <button key={item.id} className={selected?.id === item.id ? "active" : ""} style={{ "--candidate-accent": categoryColor(item.category), "--candidate-order": Math.min(index, 8) } as React.CSSProperties} type="button" aria-pressed={selected?.id === item.id} aria-label={`${item.title}，${verdictLabels[item.verdict]}，编辑潜力 ${Math.round(item.score.overall)} 分`} onClick={() => selectCandidate(item.id)}>
                    <span className="candidate-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="candidate-copy">
                      <span className="candidate-copy-top"><small>{categoryLabels[item.category]} · {candidatePlatforms(item).map(platformLabel).join(" + ")}</small><em>{verdictLabels[item.verdict]}</em></span>
                      <strong>{item.title}</strong>
                      <span>{item.editorial?.centralQuestion ?? `${verdictLabels[item.verdict]} · ${item.targetMinutes.min}–${item.targetMinutes.max} 分钟`}</span>
                    <span className="candidate-signal-meta">{!historicalSnapshot && momentumLabel(item) ? <small className="momentum-label">{momentumLabel(item)}</small> : null}<small>{item.editorial?.signalCount ?? item.evidence.length} 条信号</small><small>{candidatePlatforms(item).length} 个平台</small><small>{item.targetMinutes.min}–{item.targetMinutes.max} 分钟</small></span>
                    </span>
                    <output className="candidate-score"><strong>{Math.round(item.score.overall)}</strong><small>编辑潜力</small><i><b style={{ height: `${item.score.overall}%` }} /></i></output>
                  </button>
                ))}
              </div>
              {selected ? <CandidateDetail key={candidateVersionKey(selected)} detailRef={detailRef} candidate={selected} historical={historicalSnapshot} adopting={adoptingId === selected.id} disabled={Boolean(adoptingId)} onAdopt={onAdopt} /> : null}
            </div>
          ) : null}
        </section>
      )}

      {compactLayout ? <StudioOverview data={data} inbox={inbox} loading={loading} loadError={loadError} onRefresh={onRefresh} onOpenProduction={onOpenProduction} onOpenCandidate={openSuggestedCandidate} onConfigureOpportunity={onConfigureOpportunity} onStartCustom={openCustomEntry} /> : null}
    </div>
  );
}

function EntryTab({ id, controls, active, icon, label, note, count, onClick }: { id: string; controls: string; active: boolean; icon: React.ReactNode; label: string; note: string; count?: number; onClick: () => void }) {
  return <button id={id} type="button" role="tab" aria-controls={controls} aria-selected={active} tabIndex={active ? 0 : -1} className={active ? "active" : ""} onClick={onClick}><span className="entry-tab-icon">{icon}</span><span className="entry-tab-copy"><strong>{label}</strong><small>{note}</small></span>{count !== undefined ? <output>{count}</output> : null}</button>;
}

function SignalStatus({ inbox, loading, refreshFailed }: { inbox: CandidateInbox; loading: boolean; refreshFailed: boolean }) {
  const available = inbox.sources.filter((source) => source.status === "ready");
  const degraded = inbox.sources.filter((source) => source.status === "degraded");
  const editorialMode = editorialSourceMode(inbox.items.filter((item) => item.origin === "trend"));
  const fallback = inbox.freshness?.status === "fallback";
  const collector = inbox.collector;
  const collectorFailed = collector?.state === "degraded" || collector?.state === "error";
  const empty = inbox.sources.length === 0;
  const unavailable = inbox.sources.length > 0 && inbox.sources.every((source) => source.status === "unavailable");
  const degradedOnly = !available.length && degraded.length > 0;
  const label = loading ? "正在更新候选"
    : collector?.state === "collecting" ? "后台正在采集"
    : refreshFailed ? "当前采集失败"
    : collector?.state === "error" ? "后台采集中断"
    : collector?.state === "degraded" ? "后台采集降级"
    : fallback ? "当前采集降级"
    : empty ? "等待首次采集"
      : unavailable ? "当前没有可用采集链路"
        : degradedOnly ? "采集链路降级"
          : collector?.state === "ready" ? "热点持续采集中"
            : editorialMode === "ai" ? "AI 总编在线" : editorialMode === "mixed" ? "规则与 AI 已汇合" : "规则总编在线";
  const note = loading ? `当前展示 ${formatTime(inbox.fetchedAt)} 保存的候选，本轮采集完成后会自动更新`
    : collector?.state === "collecting" ? `当前仍展示 ${formatTime(inbox.fetchedAt)} 保存的候选`
    : refreshFailed ? `显示 ${formatTime(inbox.fetchedAt)} 保存的候选，历史涨跌已隐藏`
    : collectorFailed ? `${collector?.message ?? "后台采集未完成"} · 最近成功 ${formatTime(collector?.lastSuccessfulAt ?? inbox.fetchedAt)}`
    : fallback ? `沿用 ${formatTime(inbox.freshness!.lastSuccessfulAt)} 快照，历史涨跌已隐藏`
    : empty ? "还没有收到任何来源状态"
      : unavailable ? `本轮采集未获得可靠热点 · 尝试于 ${formatTime(inbox.fetchedAt)}`
        : degradedOnly ? `${degraded.length} 条来源仅提供降级结果 · 更新于 ${formatTime(inbox.fetchedAt)}`
          : `${available.length} 条采集链路${degraded.length ? ` · ${degraded.length} 条降级` : ""} · 更新于 ${formatTime(inbox.fetchedAt)}${collector?.nextAttemptAt ? ` · 下次 ${formatTime(collector.nextAttemptAt)}` : ""}`;
  return <div className={`signal-status${refreshFailed || collectorFailed || fallback || unavailable || empty || degradedOnly ? " fallback" : ""}`}><span><i />{label}</span><small>{note}</small></div>;
}

function TrendPulse({ inbox, loading, historical }: { inbox: CandidateInbox; loading: boolean; historical: boolean }) {
  const items = inbox.items.filter((item) => item.origin === "trend");
  const availableSources = inbox.sources.filter((source) => source.status !== "unavailable").length;
  const crossPlatform = items.filter((item) => candidatePlatforms(item).length > 1).length;
  const researchFirst = items.filter((item) => item.verdict === "research_first").length;
  const unavailable = inbox.sources.length > 0 && inbox.sources.every((source) => source.status === "unavailable");
  const tracked = historical || unavailable ? 0 : items.filter((item) => item.editorial?.momentum && item.editorial.momentum.state !== "unknown").length;
  return (
    <section className="trend-pulse" aria-label="热点信号摘要">
      <div className={`trend-scan${loading ? " active" : ""}`} aria-hidden="true"><i /></div>
      <div className="pulse-metrics">
        <PulseMetric value={rawSignalCount(inbox)} label="原始发现信号" note="只用于发现，不等于事实" />
        <PulseMetric value={trendPlatformCount(inbox)} label="覆盖平台" note={`${availableSources}/${inbox.sources.length} 条来源链路可用`} />
        <PulseMetric value={crossPlatform} label="跨平台议题" note="同题信号被聚合后再判断" />
        <PulseMetric value={tracked} label={historical ? "历史轨迹已隐藏" : unavailable ? "暂无趋势轨迹" : "已形成轨迹"} note={historical || unavailable ? "恢复采集后再判断涨跌" : `${researchFirst} 条需先研究再生产`} />
      </div>
      <div className="source-health" aria-label="热点来源状态">
        <span className="source-health-label">信号源</span>
        <div>{inbox.sources.map((source) => <span key={source.id} className={`source-chip ${source.status}`}><i /><strong>{source.label}</strong><small>{source.status === "ready" ? `${source.count} 条` : source.status === "degraded" ? `降级 · ${source.count} 条` : "不可用"}</small></span>)}</div>
      </div>
    </section>
  );
}

function PulseMetric({ value, label, note }: { value: number; label: string; note: string }) {
  return <div><strong>{value}</strong><span>{label}</span><small>{note}</small></div>;
}

function CandidateDetail({ detailRef, candidate, historical, adopting, disabled, onAdopt }: { detailRef: React.RefObject<HTMLElement | null>; candidate: EpisodeCandidate; historical: boolean; adopting: boolean; disabled: boolean; onAdopt: (candidate: EpisodeCandidate) => Promise<void> }) {
  const [confirmed, setConfirmed] = useState(candidate.verification.status === "ready");
  const [reviewedEvidence, setReviewedEvidence] = useState<Set<string>>(() => new Set());
  const blocked = candidate.verdict === "skip" || candidate.verification.status === "blocked";
  const needsSignalReview = candidate.verification.status === "review_required" && candidate.evidence.length > 0;
  const editorial = candidate.editorial;
  return (
    <article ref={detailRef} className="candidate-detail" tabIndex={-1} aria-label={`选题详情：${candidate.title}`}>
      <header>
        <div className="candidate-tags"><span>{verdictLabels[candidate.verdict]}</span><em><BrainCircuit size={12} />{editorial?.provider === "local_ai" ? "本地 AI 总编" : editorial?.provider === "series" ? "系列策划" : "规则总编"}</em>{!historical && momentumLabel(candidate) ? <em className="momentum-tag">{momentumLabel(candidate)}</em> : null}</div>
        <strong><small>排序参考</small>{Math.round(candidate.score.overall)}</strong>
      </header>
      <h3>{candidate.title}</h3>
      <div className="editorial-spectrum" aria-label="编辑判断光谱">
        <SpectrumScore label="受众" value={candidate.score.audienceRelevance} />
        <SpectrumScore label="对话" value={candidate.score.conversationPotential} />
        <SpectrumScore label="深度" value={candidate.score.longformDepth} />
        <SpectrumScore label="新鲜度" value={candidate.score.freshness} />
      </div>
      <div className="episode-question">
        <span>本集核心命题</span>
        <blockquote>{editorial?.centralQuestion ?? candidate.hook}</blockquote>
      </div>
      <div className="editorial-brief">
        <section><span>{historical ? "快照当时为何值得关注" : "为什么是现在"}</span><p>{historical ? "当前采集已降级，以下判断来自上次成功快照，不代表此刻仍在上升。" : editorial?.whyNow ?? candidate.rationale}</p></section>
        <section><span>听众带走什么</span><p>{editorial?.listenerPromise ?? candidate.hook}</p></section>
      </div>
      <div className="signal-evidence-strip">
        <div><span>发现信号</span><strong>{editorial?.signalCount ?? candidate.evidence.length} 条</strong></div>
        <SignalWave />
        <div className="platform-chips">{candidatePlatforms(candidate).map((item) => <span key={item}>{platformLabel(item)}</span>)}</div>
      </div>
      <div className="editorial-verdict"><Sparkles size={16} /><span><small>总编建议</small><strong>{verdictLabels[candidate.verdict]} · {candidate.targetMinutes.min}–{candidate.targetMinutes.max} 分钟</strong></span></div>
      <div className="editorial-reasons">
        <span>为什么进入候选箱</span>
        <ul>{(editorial?.selectionReasons ?? [candidate.rationale]).map((reason) => <li key={reason}>{reason}</li>)}</ul>
      </div>
      <details className="evidence-list">
        <summary>查看 {candidate.evidence.length} 条原始发现信号</summary>
        {candidate.evidence.length > 0 ? candidate.evidence.map((item) => <a key={item.id} className={reviewedEvidence.has(item.id) ? "reviewed" : ""} href={item.url} target="_blank" rel="noreferrer" onClick={() => setReviewedEvidence((current) => new Set(current).add(item.id))}><span><strong>{item.title}</strong><small>{item.source} · {item.signal}</small></span><ExternalLink size={14} /></a>) : <p>当前没有外部信号，资料编辑将在立项后建立来源账本。</p>}
      </details>
      <div className={`verification ${candidate.verification.status}`}><ShieldAlert size={16} /><span><strong>{candidate.verification.status === "ready" ? "可进入策划" : candidate.verification.status === "blocked" ? "事实门槛未满足" : "当前只有发现信号"}</strong><small>{candidate.verification.reason}</small></span></div>
      {candidate.verification.status === "review_required" ? <label className="verification-confirm"><input type="checkbox" checked={confirmed} disabled={needsSignalReview && reviewedEvidence.size === 0} onChange={(event) => setConfirmed(event.target.checked)} /><CircleCheck size={15} /><span>{needsSignalReview && reviewedEvidence.size === 0 ? "先打开至少一条原始信号，再确认进入研究" : `已打开 ${reviewedEvidence.size} 条信号；我理解立项不等于事实已确认`}</span></label> : null}
      <button className="primary-command adopt-command" type="button" disabled={disabled || historical || blocked || !confirmed} onClick={() => void onAdopt(candidate)}>{adopting ? "正在保存编辑判断…" : historical ? "刷新信号后再采用" : blocked ? "等待补齐事实来源" : candidate.verdict === "research_first" ? "采用为研究机会" : "采用并进入策划"}<ArrowRight size={16} /></button>
      <div className="role-preview"><span>本期认知角色</span><div>{candidate.suggestedRoles.map((role) => <em key={role}>{role}</em>)}</div></div>
      <details className="score-details"><summary>查看排序依据</summary><div className="score-grid" aria-label="候选评分">
        <Score label="受众" value={candidate.score.audienceRelevance} />
        <Score label="对话" value={candidate.score.conversationPotential} />
        <Score label="资料" value={candidate.score.evidenceDepth} />
        <Score label="深度" value={candidate.score.longformDepth} />
      </div></details>
    </article>
  );
}

function SpectrumScore({ label, value }: { label: string; value: number }) {
  return <span><small>{label}</small><i><b style={{ width: `${value}%` }} /></i><strong>{Math.round(value)}</strong></span>;
}

function Score({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{Math.round(value)}</strong><i><b style={{ width: `${value}%` }} /></i></div>;
}

function candidatePlatforms(candidate: EpisodeCandidate): string[] {
  return candidate.editorial?.signalPlatforms ?? [candidate.platform];
}

function candidateVersionKey(candidate: EpisodeCandidate): string {
  return [candidate.id, candidate.generatedAt, candidate.verification.status, ...candidate.evidence.map((evidence) => evidence.id)].join(":");
}

function editorialSourceMode(candidates: EpisodeCandidate[]): "ai" | "mixed" | "rules" {
  const aiCount = candidates.filter((candidate) => candidate.editorial?.provider === "local_ai").length;
  if (aiCount === 0) return "rules";
  return aiCount === candidates.length ? "ai" : "mixed";
}

function momentumLabel(candidate: EpisodeCandidate): string | undefined {
  const momentum = candidate.editorial?.momentum;
  if (!momentum || momentum.state === "unknown") return undefined;
  if (momentum.state === "rising") return `上升 ${Math.max(0, momentum.rankDelta ?? 0)} 位`;
  if (momentum.state === "falling") return `回落 ${Math.abs(momentum.rankDelta ?? 0)} 位`;
  if (momentum.state === "new") return "新入榜";
  if (momentum.state === "steady") return "排名稳定";
  return "信号分化";
}

function trendPlatformCount(inbox: CandidateInbox | undefined): number {
  return new Set((inbox?.items ?? []).filter((item) => item.origin === "trend").flatMap(candidatePlatforms)).size;
}

function rawSignalCount(inbox: CandidateInbox | undefined): number {
  return (inbox?.sources ?? []).reduce((total, source) => total + source.count, 0);
}

function platformLabel(value: string): string {
  return platformLabels[value] ?? value;
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Partial<Record<K, number>> {
  return items.reduce<Partial<Record<K, number>>>((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function categoryColor(category: EpisodeCandidate["category"]): string {
  return ({
    ai_tech: "#4f75ff",
    business: "#ffcc33",
    culture: "#ff6b56",
    science: "#62c8a3",
    society: "#ff6b56",
    books: "#62c8a3",
    education: "#4f75ff",
    health: "#62c8a3",
    life: "#ffcc33",
    world: "#4f75ff",
    other: "#b7beb9",
  } as const)[category];
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
