import type { EpisodeCandidate } from "@token-talk/domain";
import type { CandidateInbox, StudioBootstrap } from "../../shared/api.js";
import { ArrowUpRight, FileAudio, LibraryBig, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface StudioCommandBarProps {
  data: StudioBootstrap;
  inbox: CandidateInbox | undefined;
  historicalCandidates: boolean;
  onOpenRun: (runId: string) => void;
  onOpenCandidate: (candidate: EpisodeCandidate) => void;
  onOpenSeries: (seriesId: string) => void;
  onOpenOpportunity: (opportunityId: string) => void;
}

interface SearchResult {
  id: string;
  kind: "制作" | "选题" | "系列" | "待立项";
  title: string;
  note: string;
  action: () => void;
}

export function StudioCommandBar({ data, inbox, historicalCandidates, onOpenRun, onOpenCandidate, onOpenSeries, onOpenOpportunity }: StudioCommandBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeResultId, setActiveResultId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchStudio(query, data, inbox, historicalCandidates, { onOpenRun, onOpenCandidate, onOpenSeries, onOpenOpportunity }), [data, historicalCandidates, inbox, onOpenCandidate, onOpenOpportunity, onOpenRun, onOpenSeries, query]);
  const activeIndex = Math.max(0, results.findIndex((result) => result.id === activeResultId));
  const activeResult = results[activeIndex];

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const closeSearch = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", focusSearch);
    window.addEventListener("pointerdown", closeSearch);
    return () => {
      window.removeEventListener("keydown", focusSearch);
      window.removeEventListener("pointerdown", closeSearch);
    };
  }, []);

  useEffect(() => {
    setActiveResultId((current) => results.some((result) => result.id === current) ? current : results[0]?.id);
  }, [results]);

  useEffect(() => {
    if (!open || !activeResult) return;
    document.getElementById(searchOptionId(activeResult.id))?.scrollIntoView?.({ block: "nearest" });
  }, [activeResult, open]);

  function choose(result: SearchResult) {
    result.action();
    setQuery("");
    setOpen(false);
  }

  function handleKeys(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") choose(activeResult ?? results[0]!);
    else {
      const nextIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      setActiveResultId(results[nextIndex]!.id);
    }
  }

  return (
    <div className="workspace-topbar">
      <div className="studio-search" ref={rootRef}>
        <Search size={17} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          value={query}
          aria-label="搜索节目、选题和制作记录"
          aria-autocomplete="list"
          aria-expanded={open && query.trim().length > 0}
          aria-controls="studio-search-results"
          aria-activedescendant={open && activeResult ? searchOptionId(activeResult.id) : undefined}
          placeholder="搜索节目、选题、制作记录…"
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={handleKeys}
        />
        {query ? <button type="button" title="清除搜索" aria-label="清除搜索" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><X size={15} /></button> : null}
        {open && query.trim() ? (
          <div id="studio-search-results" className="studio-search-results" role="listbox">
            {results.length ? results.map((result, index) => (
              <button id={searchOptionId(result.id)} key={result.id} type="button" role="option" tabIndex={-1} aria-selected={result.id === activeResult?.id} className={result.id === activeResult?.id ? "active" : ""} onMouseEnter={() => setActiveResultId(result.id)} onClick={() => choose(result)}>
                <span className={`search-result-icon ${result.kind}`}>{result.kind === "制作" ? <FileAudio size={16} /> : result.kind === "系列" ? <LibraryBig size={16} /> : <Sparkles size={16} />}</span>
                <span><small>{result.kind}</small><strong>{result.title}</strong><em>{result.note}</em></span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            )) : <p>没有匹配的节目、选题或制作记录</p>}
          </div>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">{open && query.trim() ? results.length ? `${results.length} 个搜索结果` : "没有搜索结果" : ""}</span>
      </div>
      <div className="topbar-state"><i /><span><strong>本地编辑部</strong><small>{data.runs.filter((run) => !["release_ready", "completed"].includes(run.status)).length} 集在制</small></span></div>
    </div>
  );
}

function searchStudio(
  query: string,
  data: StudioBootstrap,
  inbox: CandidateInbox | undefined,
  historicalCandidates: boolean,
  actions: Pick<StudioCommandBarProps, "onOpenRun" | "onOpenCandidate" | "onOpenSeries" | "onOpenOpportunity">,
): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return [];
  const matches = (parts: Array<string | undefined>) => parts.some((part) => part?.toLocaleLowerCase("zh-CN").includes(needle));
  return [
    ...data.runs.filter((run) => matches([run.title, data.series.find((series) => series.id === run.seriesId)?.title])).map((run) => ({ id: `run:${run.id}`, kind: "制作" as const, title: run.title, note: run.status === "release_ready" ? "发行就绪" : run.status === "completed" ? "已发布" : "打开连续制作流程", action: () => actions.onOpenRun(run.id) })),
    ...(inbox?.items ?? []).filter((candidate) => matches([candidate.title, candidate.hook, candidate.editorial?.centralQuestion])).map((candidate) => ({ id: `candidate:${candidate.id}`, kind: "选题" as const, title: candidate.title, note: historicalCandidates ? candidate.origin === "trend" ? "历史热点候选 · 立项前复核" : "历史系列候选 · 立项前复核" : candidate.origin === "trend" ? "热点候选" : "系列候选", action: () => actions.onOpenCandidate(candidate) })),
    ...data.series.filter((series) => matches([series.title, series.promise, series.audience])).map((series) => ({ id: `series:${series.id}`, kind: "系列" as const, title: series.title, note: series.promise, action: () => actions.onOpenSeries(series.id) })),
    ...data.opportunities.filter((opportunity) => opportunity.status === "adopted" && matches([opportunity.title])).map((opportunity) => ({ id: `opportunity:${opportunity.id}`, kind: "待立项" as const, title: opportunity.title, note: "编辑判断已保存，等待配置制作意图", action: () => actions.onOpenOpportunity(opportunity.id) })),
  ].slice(0, 9);
}

function searchOptionId(resultId: string): string {
  return `studio-search-option-${resultId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
