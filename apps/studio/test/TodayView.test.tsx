import { createSeedSnapshot, EpisodeCandidateSchema } from "@token-talk/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../src/client/components/TodayView.js";

const NOW = "2026-08-29T01:00:00.000Z";

afterEach(() => vi.unstubAllGlobals());

describe("TodayView adoption gate", () => {
  it("turns the hotspot inbox into an auditable signal desk", () => {
    const candidate = EpisodeCandidateSchema.parse({
      ...reviewCandidate(),
      editorial: {
        ...reviewCandidate().editorial,
        signalPlatforms: ["weibo", "zhihu"],
        signalCount: 3,
        momentum: { state: "rising", rankDelta: 5, comparedAt: "2026-08-29T00:55:00.000Z" },
      },
      evidence: [
        ...reviewCandidate().evidence,
        {
          id: "signal-bank-zhihu",
          source: "知乎 · DailyHot",
          platform: "zhihu",
          title: "银行服务变化后，用户最关心什么",
          url: "https://example.com/bank-zhihu",
          observedAt: NOW,
          signal: "榜单第 4 位",
        },
      ],
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{
        items: [candidate],
        fetchedAt: NOW,
        warnings: [],
        sources: [
          { id: "newsnow", label: "NewsNow 中文热榜", count: 21, status: "ready" },
          { id: "dailyhot", label: "DailyHot 中文热榜", count: 16, status: "degraded" },
        ],
      }}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getAllByText("37").length).toBeGreaterThan(0);
    expect(screen.getByText("原始发现信号")).toBeInTheDocument();
    expect(screen.getByText("跨平台议题")).toBeInTheDocument();
    expect(screen.getByText("NewsNow 中文热榜")).toBeInTheDocument();
    expect(screen.getByText("DailyHot 中文热榜")).toBeInTheDocument();
    expect(screen.getByText("降级 · 16 条")).toBeInTheDocument();
    expect(screen.getAllByText("上升 5 位").length).toBeGreaterThan(0);
    expect(screen.getByText("总编候选箱")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "总编建议" })).toBeInTheDocument();
    expect(screen.queryByText("AI 总编候选箱")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI 总编建议" })).not.toBeInTheDocument();
    expect(screen.queryByText(/正在上升/)).not.toBeInTheDocument();
  });

  it("exposes a real refresh state without hiding the last successful candidates", () => {
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(reviewCandidate())}
      loading
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByLabelText("热点候选")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByText("银行服务变化后，普通人该关注什么？").length).toBeGreaterThan(0);
    expect(screen.getAllByText("正在采集").length).toBeGreaterThan(0);
    expect(screen.getByText("正在更新候选")).toBeInTheDocument();
    expect(screen.queryByText("规则总编在线")).not.toBeInTheDocument();
  });

  it("turns the highest-value live candidate into an actionable editor suggestion", async () => {
    const user = userEvent.setup();
    const ordinary = reviewCandidate();
    const priority = EpisodeCandidateSchema.parse({
      ...ordinary,
      id: "candidate-priority",
      title: "AI 搜索正在改变内容发现吗？",
      score: { ...ordinary.score, overall: 91 },
      editorial: { ...ordinary.editorial, centralQuestion: "搜索入口变化后，内容为何被发现？", provider: "local_ai" },
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{ ...inbox(ordinary), items: [ordinary, priority] }}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    await user.click(screen.getByRole("button", { name: /优先审阅：AI 搜索正在改变内容发现吗/ }));
    expect(screen.getByText("规则与 AI 候选")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "联合总编建议" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^AI 搜索正在改变内容发现吗？.*编辑潜力 91 分$/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "AI 搜索正在改变内容发现吗？" })).toBeInTheDocument();
    expect(screen.getAllByText("搜索入口变化后，内容为何被发现？")).toHaveLength(2);
  });

  it("preserves the editor's active candidate and filters across a successful refresh", async () => {
    const user = userEvent.setup();
    const first = reviewCandidate();
    const second = EpisodeCandidateSchema.parse({ ...first, id: "candidate-book-refresh", title: "刷新后仍在看的读书选题", category: "books", platform: "Token Talk 读书会" });
    const common = {
      data: createSeedSnapshot(NOW),
      loading: false,
      loadError: undefined,
      actionError: undefined,
      adoptingId: undefined,
      onRefresh: async () => undefined,
      onDismissActionError: () => undefined,
      onAdopt: async () => undefined,
      onAdoptCustom: async () => true,
      onConfigureOpportunity: () => undefined,
      onOpenProduction: () => undefined,
    };
    const view = render(<TodayView {...common} inbox={{ ...inbox(first), items: [first, second] }} />);

    await user.click(screen.getByText("更多筛选"));
    await user.selectOptions(screen.getByLabelText("主题"), "books");
    expect(screen.getByRole("button", { name: /刷新后仍在看的读书选题/ })).toHaveAttribute("aria-pressed", "true");

    view.rerender(<TodayView {...common} inbox={{ ...inbox(first), fetchedAt: "2026-08-29T01:05:00.000Z", items: [first, second] }} />);
    expect(screen.getByLabelText("主题")).toHaveValue("books");
    expect(screen.getByRole("button", { name: /刷新后仍在看的读书选题/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("resets the adoption gate when the same candidate id returns with stricter verification", () => {
    const ready = EpisodeCandidateSchema.parse({ ...reviewCandidate(), verification: { status: "ready", reason: "已核验", independentSources: 2 } });
    const common = {
      data: createSeedSnapshot(NOW), loading: false, loadError: undefined, actionError: undefined, adoptingId: undefined,
      onRefresh: async () => undefined, onDismissActionError: () => undefined, onAdopt: async () => undefined,
      onAdoptCustom: async () => true, onConfigureOpportunity: () => undefined, onOpenProduction: () => undefined,
    };
    const view = render(<TodayView {...common} inbox={inbox(ready)} />);
    expect(screen.getByRole("button", { name: "采用为研究机会" })).toBeEnabled();

    view.rerender(<TodayView {...common} inbox={inbox(reviewCandidate())} />);
    expect(screen.getByRole("button", { name: "采用为研究机会" })).toBeDisabled();
  });

  it("describes the persisted production state without inventing active work", () => {
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(reviewCandidate())}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getAllByText("制作完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("ON DECK · 制作中")).not.toBeInTheDocument();
  });

  it("keeps a failed branch above simultaneous running and editor-waiting branches", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "failed";
    run.nodes[0]!.status = "failed";
    run.nodes[1]!.status = "running";
    run.nodes[2]!.status = "needs_human";
    render(<TodayView
      data={data}
      inbox={inbox(reviewCandidate())}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByRole("button", { name: new RegExp(`打开节目：${run.title}，需要处理`) })).toBeInTheDocument();
  });

  it("announces a collection failure instead of claiming signals are synchronized", () => {
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={undefined}
      loading={false}
      loadError="采集服务暂时不可用"
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByText("信号同步失败")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("采集服务暂时不可用");
    expect(screen.queryByText("暂时没有可靠的热点提案")).not.toBeInTheDocument();
  });

  it("does not claim synchronization when the first collection has no available source", () => {
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{ items: [], fetchedAt: NOW, warnings: ["all sources unavailable"], sources: [{ id: "newsnow", label: "NewsNow", count: 0, status: "unavailable" }] }}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByText("采集暂不可用")).toBeInTheDocument();
    expect(screen.getByText("当前没有可用采集链路")).toBeInTheDocument();
    expect(screen.getByText("暂无趋势轨迹")).toBeInTheDocument();
    expect(screen.queryByText("信号已同步")).not.toBeInTheDocument();
    expect(screen.queryByText("规则总编在线")).not.toBeInTheDocument();
  });

  it("keeps the overview and signal desk consistent for empty and degraded-only source states", () => {
    const common = {
      data: createSeedSnapshot(NOW),
      loading: false,
      loadError: undefined,
      actionError: undefined,
      adoptingId: undefined,
      onRefresh: async () => undefined,
      onDismissActionError: () => undefined,
      onAdopt: async () => undefined,
      onAdoptCustom: async () => true,
      onConfigureOpportunity: () => undefined,
      onOpenProduction: () => undefined,
    };
    const view = render(<TodayView {...common} inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [] }} />);

    expect(screen.getAllByText("等待首次采集").length).toBeGreaterThan(0);
    expect(screen.getByText("暂时没有可靠的热点提案")).toBeInTheDocument();
    expect(screen.queryByText("信号已同步")).not.toBeInTheDocument();

    view.rerender(<TodayView {...common} inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [{ id: "fallback-source", label: "降级来源", count: 2, status: "degraded" }] }} />);
    expect(screen.getByText("采集降级")).toBeInTheDocument();
    expect(screen.getByText("采集链路降级")).toBeInTheDocument();
    expect(screen.queryByText("信号已同步")).not.toBeInTheDocument();
  });

  it("counts every actionable step and opens ordinary and overflow tasks at their exact node", async () => {
    const user = userEvent.setup();
    const onOpenProduction = vi.fn();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "failed";
    run.nodes.forEach((node) => { node.status = "pending"; });
    run.nodes.slice(0, 6).forEach((node) => { node.status = "needs_human"; });
    const candidate = reviewCandidate();
    data.opportunities = Array.from({ length: 3 }, (_, index) => ({
      id: `opportunity-${index + 1}`,
      candidateId: `${candidate.id}-${index + 1}`,
      title: `待立项 ${index + 1}`,
      origin: candidate.origin,
      verdict: candidate.verdict,
      evidence: candidate.evidence,
      candidate: { ...candidate, id: `${candidate.id}-${index + 1}`, title: `待立项 ${index + 1}` },
      adoptedAt: NOW,
      status: "adopted" as const,
    }));
    render(<TodayView
      data={data}
      inbox={inbox(candidate)}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={onOpenProduction}
    />);

    expect(screen.getByText("6 个制作步骤 · 3 个待立项")).toBeInTheDocument();
    expect(screen.getByText("查看其余 7 项")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: new RegExp(run.nodes[1]!.label) }));
    expect(onOpenProduction).toHaveBeenLastCalledWith(run.id, run.nodes[1]!.id);

    await user.click(screen.getByText("查看其余 7 项"));
    await user.click(screen.getByRole("button", { name: new RegExp(run.nodes[5]!.label) }));
    expect(onOpenProduction).toHaveBeenLastCalledWith(run.id, run.nodes[5]!.id);
  });

  it("keeps mobile DOM order aligned with the visible topic-first layout", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 820px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(reviewCandidate())}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    const tabs = screen.getByRole("tablist", { name: "选题入口" });
    const overview = screen.getByRole("heading", { name: "今天聊什么？" }).closest("section");
    expect(tabs.compareDocumentPosition(overview!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("sorts the recent production list by update time instead of blocker severity", () => {
    const data = createSeedSnapshot("2026-08-28T00:00:00.000Z");
    const oldFailure = data.runs[0];
    if (!oldFailure) throw new Error("seed run missing");
    oldFailure.status = "failed";
    oldFailure.updatedAt = "2026-08-28T00:00:00.000Z";
    oldFailure.nodes[0]!.status = "failed";
    const recent = structuredClone(oldFailure);
    recent.id = "run-recent";
    recent.title = "今天刚更新的节目";
    recent.status = "active";
    recent.updatedAt = NOW;
    recent.nodes.forEach((node) => { node.status = "pending"; });
    recent.nodes[0]!.status = "ready";
    data.runs.push(recent);
    const { container } = render(<TodayView
      data={data}
      inbox={inbox(reviewCandidate())}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(container.querySelector(".recent-run-list > button")?.textContent).toContain(recent.title);
  });

  it("moves focus into custom creation when opened from the overview", async () => {
    const user = userEvent.setup();
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(reviewCandidate())}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    await user.click(screen.getByRole("button", { name: "自主创作" }));
    await waitFor(() => expect(screen.getByLabelText("节目命题")).toHaveFocus());
    expect(screen.getByRole("option", { name: "240 分钟特别企划" })).toHaveValue("240");
  });

  it("keeps keyboard tab changes and empty-state creation on the same clean focus path", async () => {
    const user = userEvent.setup();
    const onDismissActionError = vi.fn();
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [{ id: "newsnow", label: "NewsNow", count: 0, status: "ready" }] }}
      loading={false}
      loadError={undefined}
      actionError="上一入口的错误"
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={onDismissActionError}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    screen.getByRole("tab", { name: /热点机会/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onDismissActionError).toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /热点机会/ }));
    await user.click(within(screen.getByLabelText("热点候选")).getByRole("button", { name: "自主创作" }));
    await waitFor(() => expect(screen.getByLabelText("节目命题")).toHaveFocus());
  });

  it("labels fallback candidates as historical and hides stale momentum", () => {
    const candidate = EpisodeCandidateSchema.parse({
      ...reviewCandidate(),
      editorial: {
        ...reviewCandidate().editorial,
        momentum: { state: "rising", rankDelta: 5, comparedAt: "2026-08-29T00:55:00.000Z" },
      },
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{
        ...inbox(candidate),
        freshness: { status: "fallback", lastSuccessfulAt: NOW, attemptedAt: "2026-08-29T02:00:00.000Z" },
        sources: [{ id: "newsnow", label: "NewsNow", count: 0, status: "unavailable" }],
      }}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByText("当前采集降级")).toBeInTheDocument();
    expect(screen.getByText("历史信号")).toBeInTheDocument();
    expect(screen.getAllByText("历史轨迹已隐藏").length).toBeGreaterThan(0);
    expect(screen.getByText("快照当时为何值得关注")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新信号后再采用" })).toBeDisabled();
    expect(screen.queryByText("上升 5 位")).not.toBeInTheDocument();
  });

  it("labels retained candidates as historical when the latest refresh fails", () => {
    const candidate = EpisodeCandidateSchema.parse({
      ...reviewCandidate(),
      editorial: {
        ...reviewCandidate().editorial,
        momentum: { state: "rising", rankDelta: 5, comparedAt: "2026-08-29T00:55:00.000Z" },
      },
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(candidate)}
      loading={false}
      loadError="本轮热点刷新失败"
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getByText("当前采集失败")).toBeInTheDocument();
    expect(screen.getByText("历史信号")).toBeInTheDocument();
    expect(screen.getAllByText("历史轨迹已隐藏").length).toBeGreaterThan(0);
    expect(screen.getByText("快照当时为何值得关注")).toBeInTheDocument();
    expect(screen.queryByText("AI 总编在线")).not.toBeInTheDocument();
    expect(screen.queryByText("上升 5 位")).not.toBeInTheDocument();
  });

  it("marks the successful cache as historical when background collection degrades", () => {
    const candidate = EpisodeCandidateSchema.parse({
      ...reviewCandidate(),
      editorial: {
        ...reviewCandidate().editorial,
        momentum: { state: "rising", rankDelta: 5, comparedAt: "2026-08-29T00:55:00.000Z" },
      },
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={{
        ...inbox(candidate),
        freshness: { status: "current", lastSuccessfulAt: NOW },
        collector: {
          state: "degraded",
          cadenceSeconds: 300,
          consecutiveFailures: 1,
          lastAttemptAt: "2026-08-29T01:05:00.000Z",
          lastSuccessfulAt: NOW,
          nextAttemptAt: "2026-08-29T01:15:00.000Z",
          message: "NewsNow 暂时不可用",
        },
      }}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    expect(screen.getAllByText("后台采集降级").length).toBeGreaterThan(1);
    expect(screen.getByText(/NewsNow 暂时不可用 · 最近成功/)).toBeInTheDocument();
    expect(screen.getByText("历史信号")).toBeInTheDocument();
    expect(screen.getAllByText("历史轨迹已隐藏").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "刷新信号后再采用" })).toBeDisabled();
    expect(screen.queryByText("上升 5 位")).not.toBeInTheDocument();
  });

  it("requires opening a discovery signal and explicit confirmation before research adoption", async () => {
    const user = userEvent.setup();
    const candidate = reviewCandidate();
    const onAdopt = vi.fn(async () => undefined);
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(candidate)}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={onAdopt}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);

    const adopt = screen.getByRole("button", { name: /采用为研究机会/ });
    expect(adopt).toBeDisabled();
    await user.click(screen.getByText(/查看 1 条原始发现信号/));
    await user.click(screen.getByRole("link", { name: /银行服务调整/ }));
    const confirmation = screen.getByRole("checkbox");
    expect(confirmation).toBeEnabled();
    await user.click(confirmation);
    expect(adopt).toBeEnabled();
    await user.click(adopt);
    expect(onAdopt).toHaveBeenCalledWith(candidate);
  });

  it("never enables a blocked candidate", () => {
    const candidate = EpisodeCandidateSchema.parse({
      ...reviewCandidate(),
      id: "candidate-blocked",
      verification: { status: "blocked", reason: "等待独立事实来源", independentSources: 0 },
    });
    render(<TodayView
      data={createSeedSnapshot(NOW)}
      inbox={inbox(candidate)}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onRefresh={async () => undefined}
      onDismissActionError={() => undefined}
      onAdopt={async () => undefined}
      onAdoptCustom={async () => true}
      onConfigureOpportunity={() => undefined}
      onOpenProduction={() => undefined}
    />);
    expect(screen.getByRole("button", { name: /等待补齐事实来源/ })).toBeDisabled();
  });
});

function reviewCandidate() {
  return EpisodeCandidateSchema.parse({
    id: "candidate-bank",
    origin: "trend",
    title: "银行服务变化后，普通人该关注什么？",
    hook: "先分清已经确认和仍需核验的信息。",
    rationale: "影响普通家庭；存在可核验分歧",
    category: "business",
    platform: "微博",
    suggestedRoles: ["事实核验者", "普通家庭观察者"],
    verdict: "research_first",
    targetMinutes: { min: 15, max: 25 },
    score: { overall: 72, audienceRelevance: 82, conversationPotential: 78, evidenceDepth: 0, longformDepth: 74, freshness: 90, seriesFit: 68, feasibility: 58, risk: 52 },
    evidence: [{ id: "signal-bank", source: "微博 · NewsNow", platform: "weibo", title: "银行服务调整引发讨论", url: "https://example.com/bank", observedAt: NOW, signal: "榜单第 1 位" }],
    verification: { status: "review_required", reason: "当前只有发现信号", independentSources: 0 },
    editorial: { whyNow: "讨论正在升温。", centralQuestion: "哪些信息已经确认？", listenerPromise: "分清事实与传闻。", selectionReasons: ["影响普通家庭"], signalPlatforms: ["weibo"], signalCount: 1, provider: "rules" },
    generatedAt: NOW,
  });
}

function inbox(candidate: ReturnType<typeof reviewCandidate>) {
  return { items: [candidate], fetchedAt: NOW, warnings: [], sources: [{ id: "newsnow", label: "NewsNow", count: 1, status: "ready" as const }] };
}
