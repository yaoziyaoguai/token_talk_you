import { createSeedSnapshot } from "@token-talk/domain";
import { reviseArtifact } from "@token-talk/workflow";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import { StudioApi } from "../src/client/api.js";
import { StudioCommandBar } from "../src/client/components/StudioCommandBar.js";
import type { AgentLoopJob } from "../src/shared/api.js";

const NOW = "2026-08-28T00:00:00.000Z";
const EMPTY_INBOX = { items: [], fetchedAt: NOW, warnings: [], sources: [] };

describe("Token Talk operator shell", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    StudioApi.configureLocalSession(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("loads candidates when bootstrap data is injected without an inbox", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(EMPTY_INBOX), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    render(<App initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-candidate-mutation-token-000001" }} />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/candidates", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })));
    await waitFor(() => expect(screen.queryByText("本地总编正在阅读跨平台信号")).not.toBeInTheDocument());
  });

  it("waits for the cold-start mutation token before loading candidates", async () => {
    const bootstrap = { ...createSeedSnapshot(NOW), mutationToken: "app-cold-start-mutation-token-000001" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/bootstrap") {
        return new Response(JSON.stringify(bootstrap), { status: 200, headers: { "content-type": "application/json" } });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("x-token-talk-token")).toBe(bootstrap.mutationToken);
      return new Response(JSON.stringify(EMPTY_INBOX), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "今天聊什么？" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/candidates", expect.objectContaining({ method: "POST" })));
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(["/api/bootstrap", "/api/candidates"]);
  });

  it("syncs the server candidate cache without forcing external collection from the browser", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(EMPTY_INBOX), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    try {
      render(<App
        initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-candidate-sync-token-000000001" }}
        initialInbox={EMPTY_INBOX}
      />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith("/api/candidates?cached=true", expect.objectContaining({ method: "POST" }));
      expect(fetcher.mock.calls.some(([input]) => String(input).includes("refresh=true"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues an explicit refresh behind an in-flight cache sync", async () => {
    vi.useFakeTimers();
    let resolveCached: ((response: Response) => void) | undefined;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveCached = resolve;
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(EMPTY_INBOX), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    try {
      render(<App
        initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-candidate-refresh-queue-token-01" }}
        initialInbox={EMPTY_INBOX}
      />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "刷新热点信号" }));
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveCached?.(new Response(JSON.stringify(EMPTY_INBOX), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
        await Promise.resolve();
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenLastCalledWith("/api/candidates?refresh=true", expect.objectContaining({ method: "POST" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls a cold fallback briefly until the first trend snapshot is ready", async () => {
    vi.useFakeTimers();
    const fallbackInbox = {
      ...EMPTY_INBOX,
      freshness: { status: "fallback" as const, lastSuccessfulAt: NOW, attemptedAt: NOW },
      collector: { state: "degraded" as const, cadenceSeconds: 300, consecutiveFailures: 1 },
    };
    const readyInbox = {
      ...EMPTY_INBOX,
      freshness: { status: "current" as const, lastSuccessfulAt: NOW },
      collector: { state: "ready" as const, cadenceSeconds: 300, consecutiveFailures: 0 },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(readyInbox), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    try {
      render(<App
        initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-candidate-warmup-token-0000001" }}
        initialInbox={fallbackInbox}
      />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith("/api/candidates?cached=true", expect.objectContaining({ method: "POST" }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds cold fallback cache polling when no trend snapshot becomes ready", async () => {
    vi.useFakeTimers();
    const fallbackInbox = {
      ...EMPTY_INBOX,
      freshness: { status: "fallback" as const, lastSuccessfulAt: NOW, attemptedAt: NOW },
      collector: { state: "degraded" as const, cadenceSeconds: 300, consecutiveFailures: 1 },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fallbackInbox), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    try {
      render(<App
        initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-candidate-warmup-limit-token-01" }}
        initialInbox={fallbackInbox}
      />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      expect(fetcher).toHaveBeenCalledTimes(20);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      expect(fetcher).toHaveBeenCalledTimes(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns bootstrap failure with an accessible retry path", async () => {
    const user = userEvent.setup();
    let bootstrapAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/bootstrap")) {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ ...createSeedSnapshot(NOW), mutationToken: "app-retry-mutation-token-000000001" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(EMPTY_INBOX), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Studio 没有成功打开");
    await user.click(screen.getByRole("button", { name: "重新连接" }));
    expect(await screen.findByRole("heading", { name: "今天聊什么？" })).toBeInTheDocument();
    expect(bootstrapAttempts).toBe(2);
  });

  it("keeps the primary navigation focused and moves resources behind a secondary entry", async () => {
    const user = userEvent.setup();
    render(<App initialData={createSeedSnapshot(NOW)} initialInbox={EMPTY_INBOX} />);
    expect(screen.getByRole("heading", { name: "今天聊什么？" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /自定义创作/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "主导航" }).querySelectorAll("button")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "节目" }));
    expect(screen.getByRole("heading", { name: "让节目值得追更" })).toBeInTheDocument();
    expect(screen.getByText("按每期选题动态编排")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开声音与音乐" }));
    expect(screen.getByRole("heading", { name: "声音与音乐" })).toBeInTheDocument();
    await user.click(screen.getByText("高级：制作服务、价格与授权"));
    expect(screen.getAllByText("商用受限").length).toBeGreaterThan(0);
  });

  it("searches the real studio index and opens a production record", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.type(screen.getByRole("combobox", { name: "搜索节目、选题和制作记录" }), "思考");
    await user.click(screen.getByRole("option", { name: new RegExp(run.title) }));

    expect(screen.getByRole("heading", { name: run.title })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("run")).toBe(run.id);
  });

  it("announces the active search option and locates the selected series", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const first = data.series[0];
    if (!first) throw new Error("seed series missing");
    const second = { ...structuredClone(first), id: "series-oral-history", title: "AI 口述史", promise: "找到被技术变化遮住的个人经验" };
    data.series.push(second);
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    const search = screen.getByRole("combobox", { name: "搜索节目、选题和制作记录" });
    await user.type(search, "AI 口述史");
    expect(search).toHaveAttribute("aria-activedescendant", "studio-search-option-series-series-oral-history");
    expect(screen.getByText("1 个搜索结果")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /AI 口述史/ })).toHaveAttribute("tabindex", "-1");
    await user.click(screen.getByRole("option", { name: /AI 口述史/ }));

    expect(new URLSearchParams(window.location.search).get("series")).toBe(second.id);
    await waitFor(() => expect(document.getElementById(`series-${second.id}`)).toHaveFocus());
  });

  it("keeps search focus on the combobox and scrolls the active option into view", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const template = data.series[0];
    if (!template) throw new Error("seed series missing");
    data.series = Array.from({ length: 9 }, (_, index) => ({ ...structuredClone(template), id: `series-search-${index}`, title: `系列节目 ${index + 1}` }));
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    try {
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);
      const search = screen.getByRole("combobox", { name: "搜索节目、选题和制作记录" });
      await user.type(search, "系列节目");
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");

      expect(search).toHaveFocus();
      expect(search).toHaveAttribute("aria-activedescendant", "studio-search-option-series-series-search-8");
      expect(screen.getAllByRole("option")).toHaveLength(9);
      expect(screen.getAllByRole("option").every((option) => option.tabIndex === -1)).toBe(true);
      await waitFor(() => expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" }));
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
      else delete (Element.prototype as { scrollIntoView?: Element["scrollIntoView"] }).scrollIntoView;
    }
  });

  it("keeps or repairs the active search result when data refreshes", async () => {
    const user = userEvent.setup();
    const seed = createSeedSnapshot(NOW);
    const template = seed.series[0];
    if (!template) throw new Error("seed series missing");
    const callbacks = {
      onOpenRun: vi.fn(),
      onOpenCandidate: vi.fn(),
      onOpenSeries: vi.fn(),
      onOpenOpportunity: vi.fn(),
    };
    const data = { ...seed, series: Array.from({ length: 9 }, (_, index) => ({ ...structuredClone(template), id: `series-dynamic-${index}`, title: `动态结果 ${index + 1}` })) };
    const view = render(<StudioCommandBar data={data} inbox={EMPTY_INBOX} historicalCandidates={false} {...callbacks} />);
    const search = screen.getByRole("combobox", { name: "搜索节目、选题和制作记录" });
    await user.type(search, "动态结果");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", "studio-search-option-series-series-dynamic-8");

    view.rerender(<StudioCommandBar data={{ ...data, series: [data.series[0]!] }} inbox={EMPTY_INBOX} historicalCandidates={false} {...callbacks} />);
    await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", "studio-search-option-series-series-dynamic-0"));
    expect(screen.getByRole("option", { name: /动态结果 1/ })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps an unsaved production draft in place when navigation is cancelled", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App initialData={createSeedSnapshot(NOW)} initialInbox={EMPTY_INBOX} />);
    await user.click(screen.getByRole("button", { name: "制作" }));
    await user.click(screen.getByRole("button", { name: /节目蓝图/ }));
    await user.click(screen.getByRole("button", { name: "添加章节" }));
    fireEvent.change(screen.getByLabelText("第 1 章标题"), { target: { value: "尚未保存的章节" } });

    await user.click(screen.getByRole("button", { name: "节目" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "节目蓝图" })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "节目" }));
    expect(screen.getByRole("heading", { name: "让节目值得追更" })).toBeInTheDocument();
  });

  it("keeps an unsaved production draft in place when browser navigation is cancelled", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App initialData={createSeedSnapshot(NOW)} initialInbox={EMPTY_INBOX} />);
    await user.click(screen.getByRole("button", { name: "制作" }));
    await user.click(screen.getByRole("button", { name: /节目蓝图/ }));
    await user.click(screen.getByRole("button", { name: "添加章节" }));
    fireEvent.change(screen.getByLabelText("第 1 章标题"), { target: { value: "尚未保存的章节" } });

    window.history.pushState(null, "", "/?view=formats");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "节目蓝图" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("production");

    confirm.mockReturnValue(true);
    window.history.pushState(null, "", "/?view=formats");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "让节目值得追更" })).toBeInTheDocument();
  });

  it("does not replace an unsaved production draft while an Agent Loop job is polled", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      data.agentLoopJobs.push({
        id: "agent-loop-job-draft-guard-001",
        runId: run.id,
        idempotencyKey: "agent-loop-draft-guard-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      });
      const refreshed = structuredClone(data);
      refreshed.updatedAt = "2026-08-28T01:00:00.000Z";
      let resolveBootstrap: ((value: typeof refreshed) => void) | undefined;
      const loadBootstrap = vi.spyOn(StudioApi, "loadBootstrap").mockImplementation(() => new Promise((resolve) => {
        resolveBootstrap = resolve;
      }));
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: /节目蓝图/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(loadBootstrap).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "添加章节" }));
      const title = screen.getByLabelText("第 1 章标题");
      fireEvent.change(title, { target: { value: "轮询不能覆盖这段草稿" } });
      await act(async () => { resolveBootstrap?.(refreshed); });

      expect(title).toHaveValue("轮询不能覆盖这段草稿");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace a draft created while an Agent Loop job reaches its terminal state", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      run.status = "active";
      run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const runningJob = {
        id: "agent-loop-job-terminal-draft-001",
        runId: run.id,
        idempotencyKey: "agent-loop-terminal-draft-key-001",
        status: "running" as const,
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      vi.spyOn(StudioApi, "loadAgentLoopJob").mockResolvedValue({
        ...runningJob,
        status: "blocked",
        reason: "requires_input",
        stoppedAtNodeId: run.nodes[0]!.id,
      });
      const loadBootstrap = vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue(data);
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole("button", { name: /节目蓝图/ }));
      fireEvent.click(screen.getByRole("button", { name: "添加章节" }));
      const title = screen.getByLabelText("第 1 章标题");
      fireEvent.change(title, { target: { value: "终态也不能覆盖这段草稿" } });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });

      expect(loadBootstrap).toHaveBeenCalled();
      expect(title).toHaveValue("终态也不能覆盖这段草稿");
      loadBootstrap.mockClear();
      loadBootstrap.mockRejectedValueOnce(new Error("短暂网络故障"));
      vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "节目" }));
      await act(async () => { await Promise.resolve(); });
      expect(loadBootstrap).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(loadBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace a draft created after the terminal Agent Loop refresh starts", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "active";
    run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
    vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue({
      id: "agent-loop-job-terminal-race-001",
      runId: run.id,
      idempotencyKey: "agent-loop-terminal-race-key-001",
      status: "blocked",
      createdAt: NOW,
      updatedAt: NOW,
      executedNodeIds: [],
      stoppedAtNodeId: run.nodes[0]!.id,
      reason: "requires_input",
    });
    let resolveBootstrap: ((value: typeof data) => void) | undefined;
    const loadBootstrap = vi.spyOn(StudioApi, "loadBootstrap").mockImplementation(() => new Promise((resolve) => {
      resolveBootstrap = resolve;
    }));
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    fireEvent.click(screen.getByRole("button", { name: "制作" }));
    fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
    await waitFor(() => expect(loadBootstrap).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /节目蓝图/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加章节" }));
    const title = screen.getByLabelText("第 1 章标题");
    fireEvent.change(title, { target: { value: "终态刷新返回前的新草稿" } });
    await act(async () => { resolveBootstrap?.(data); });

    expect(title).toHaveValue("终态刷新返回前的新草稿");
  });

  it("refreshes series proposals immediately after a series is created", async () => {
    const user = userEvent.setup();
    let resolveCached: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/series") {
        return new Response(JSON.stringify({
          id: "series-new",
          creationRequestId: "series-create-request-000001",
          title: "AI 口述史",
          promise: "留下人的声音",
          audience: "技术与社会听众",
          castPolicy: { mode: "dynamic" },
          sonicBible: { musicPolicy: "minimal", palette: [], exclusions: [] },
          memory: [],
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (String(input) === "/api/candidates?cached=true") {
        return new Promise<Response>((resolve) => {
          resolveCached = resolve;
        });
      }
      return new Response(JSON.stringify(EMPTY_INBOX), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App initialData={{ ...createSeedSnapshot(NOW), mutationToken: "app-series-mutation-token-00000001" }} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "节目" }));
    await user.click(screen.getByRole("button", { name: "新建系列" }));
    await user.type(screen.getByLabelText("系列名称"), "AI 口述史");
    await user.type(screen.getByLabelText("每一期都要兑现的承诺"), "留下人的声音");
    await user.type(screen.getByLabelText("核心听众"), "技术与社会听众");
    await user.click(screen.getByRole("button", { name: "创建系列" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/candidates?cached=true", expect.objectContaining({ method: "POST" })));
    await user.click(screen.getByRole("button", { name: "选题" }));
    await user.click(screen.getByRole("button", { name: "刷新热点信号" }));
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("refresh=true"))).toBe(false);
    await act(async () => {
      resolveCached?.(new Response(JSON.stringify(EMPTY_INBOX), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await Promise.resolve();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/candidates?refresh=true", expect.objectContaining({ method: "POST" })));
    await user.click(screen.getByRole("button", { name: "节目" }));
    expect(screen.getByRole("heading", { name: "AI 口述史" })).toBeInTheDocument();
  });

  it("keeps views and production nodes addressable through browser history", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "制作" }));
    expect(new URLSearchParams(window.location.search).get("run")).toBe(run.id);

    await user.click(screen.getByRole("button", { name: /发布包/ }));
    expect(new URLSearchParams(window.location.search).get("node")).toBe("publish-package");

    await user.click(screen.getByRole("button", { name: "节目" }));
    expect(window.location.search).toBe("?view=formats");

    window.history.pushState(null, "", `/?view=production&run=${run.id}&node=publish-package`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: run.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发布包/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses one continuous production flow and keeps technical records collapsed", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    data.runs[0] = reviseArtifact(
      run,
      "artifact-blueprint",
      { chapters: 6, targetMinutes: 42 },
      "2026-08-28T01:00:00.000Z",
    );
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "制作" }));
    expect(screen.getByRole("list", { name: "本集制作进度" })).toHaveTextContent(/立项.*策划.*成稿.*成片.*发布/);
    expect(screen.queryByRole("tab", { name: "策划阶段" })).not.toBeInTheDocument();
    expect(screen.getByText("当前 artifact-blueprint-v2")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: /章节 1/ }));
    await user.click(screen.getByRole("button", { name: /发布包/ }));
    expect(screen.getByText("上游蓝图已更新，需要重新生成")).toBeInTheDocument();
    expect(screen.getByText("产物已失效")).toBeInTheDocument();
    await user.click(screen.getByText("制作记录与技术详情"));
    expect(screen.getByText("上游版本")).toBeInTheDocument();
    expect(screen.getByText("发布检查")).toBeInTheDocument();
  });

  it("keeps music in the finished-audio stage and automated quality audit in release", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    for (const node of run.nodes) {
      node.status = node.id === "audio-audit" ? "ready" : node.id === "publish-package" ? "pending" : "succeeded";
    }
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "制作" }));
    const journey = screen.getByRole("list", { name: "本集制作进度" });
    expect(screen.getByText("成片").closest("li")).toHaveClass("done");
    expect(screen.getByText("发布").closest("li")).toHaveClass("current");
    expect(journey).toContainElement(screen.getByText("发布"));
  });

  it("reuses the Agent Loop idempotency key after an uncertain start response", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "active";
    run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
    const start = vi.spyOn(StudioApi, "startAgentLoopJob")
      .mockRejectedValueOnce(new Error("请求超时，请重试"))
      .mockImplementationOnce(async (_runId, idempotencyKey) => ({
        id: "agent-loop-job-replayed-001",
        runId: run.id,
        idempotencyKey,
        status: "blocked",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
        stoppedAtNodeId: run.nodes[0]!.id,
        reason: "awaiting_spend_authorization",
      }));
    vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue({ ...data, mutationToken: "app-agent-loop-idempotency-token-001" });
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "制作" }));
    await user.click(screen.getByRole("button", { name: "继续制作" }));
    expect(await screen.findByText("请求超时，请重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续制作" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    expect(start.mock.calls[0]![1]).toBe(start.mock.calls[1]![1]);
  });

  it("adopts an active Agent Loop job started in another browser tab", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "active";
    run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
    const activeJob = {
      id: "agent-loop-job-other-tab-001",
      runId: run.id,
      idempotencyKey: "agent-loop-other-tab-key-001",
      status: "running" as const,
      createdAt: NOW,
      updatedAt: NOW,
      executedNodeIds: [],
    };
    vi.spyOn(StudioApi, "startAgentLoopJob").mockRejectedValue(new Error("这集节目已有自动制作作业正在运行。"));
    const latest = vi.spyOn(StudioApi, "loadLatestAgentLoopJob").mockResolvedValue(activeJob);
    vi.spyOn(StudioApi, "loadAgentLoopJob").mockResolvedValue({
      ...activeJob,
      status: "blocked",
      stoppedAtNodeId: run.nodes[0]!.id,
      reason: "requires_input",
    });
    vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue(data);
    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    await user.click(screen.getByRole("button", { name: "制作" }));
    await user.click(screen.getByRole("button", { name: "继续制作" }));

    await waitFor(() => expect(latest).toHaveBeenCalledWith(run.id));
    expect(await screen.findByText("自动流程已生成需要处理的产物。", {}, { timeout: 3_000 })).toBeInTheDocument();
  });

  it("focuses the stopped node when passive Agent Loop polling reaches a terminal state", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      const stoppedNode = run.nodes.find((node) => node.id === "script-audit");
      if (!stoppedNode) throw new Error("seed stopped node missing");
      const activeJob: AgentLoopJob = {
        id: "agent-loop-job-passive-terminal-001",
        runId: run.id,
        idempotencyKey: "agent-loop-passive-terminal-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      data.agentLoopJobs.push(activeJob);
      const terminalJob: AgentLoopJob = {
        ...activeJob,
        status: "blocked",
        reason: "requires_input",
        stoppedAtNodeId: stoppedNode.id,
        updatedAt: "2026-08-28T00:01:00.000Z",
      };
      vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue({ ...data, agentLoopJobs: [terminalJob] });
      window.history.replaceState(null, "", `/?view=production&run=${run.id}&node=${run.nodes[0]!.id}`);
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(500); });

      expect(screen.getByRole("button", { name: new RegExp(stoppedNode.label) })).toHaveAttribute("aria-pressed", "true");
      expect(new URLSearchParams(window.location.search).get("node")).toBe(stoppedNode.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling after a transient Agent Loop status failure", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      run.status = "active";
      run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const runningJob: AgentLoopJob = {
        id: "agent-loop-job-transient-poll-001",
        runId: run.id,
        idempotencyKey: "agent-loop-transient-poll-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      const loadJob = vi.spyOn(StudioApi, "loadAgentLoopJob")
        .mockRejectedValueOnce(new Error("短暂网络故障"))
        .mockResolvedValueOnce({
          ...runningJob,
          status: "blocked",
          reason: "requires_input",
          stoppedAtNodeId: run.nodes[0]!.id,
          updatedAt: "2026-08-28T00:01:00.000Z",
        });
      vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue(data);
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await act(async () => { await Promise.resolve(); });

      expect(loadJob).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("短暂网络故障")).not.toBeInTheDocument();
      expect(screen.getByText("自动流程已生成需要处理的产物。")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a terminal bootstrap state when exact Agent Loop polling stays unavailable", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      run.status = "active";
      run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const runningJob: AgentLoopJob = {
        id: "agent-loop-job-bootstrap-fallback-001",
        runId: run.id,
        idempotencyKey: "agent-loop-bootstrap-fallback-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      const terminalJob: AgentLoopJob = {
        ...runningJob,
        status: "blocked",
        reason: "requires_input",
        stoppedAtNodeId: run.nodes[0]!.id,
        updatedAt: "2026-08-28T00:01:00.000Z",
      };
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      vi.spyOn(StudioApi, "loadAgentLoopJob").mockRejectedValue(new Error("精确状态暂不可用"));
      vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue({ ...data, agentLoopJobs: [terminalJob] });
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByText("自动流程已生成需要处理的产物。")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "制作中" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies overlapping bootstrap progress when an exact job poll is unchanged", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      run.status = "active";
      run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const runningJob: AgentLoopJob = {
        id: "agent-loop-job-noop-poll-001",
        runId: run.id,
        idempotencyKey: "agent-loop-noop-poll-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      const progressed = structuredClone(data);
      progressed.runs[0]!.title = "中间节点进度已经同步";
      progressed.agentLoopJobs = [runningJob];
      let resolveBootstrap: ((value: typeof progressed) => void) | undefined;
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      vi.spyOn(StudioApi, "loadAgentLoopJob")
        .mockResolvedValueOnce(structuredClone(runningJob))
        .mockResolvedValueOnce({ ...runningJob, status: "cancelled", updatedAt: "2026-08-28T00:01:00.000Z" });
      vi.spyOn(StudioApi, "loadBootstrap").mockImplementation(() => new Promise((resolve) => {
        resolveBootstrap = resolve;
      }));
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await act(async () => { resolveBootstrap?.(progressed); });

      expect(screen.getByRole("heading", { name: "中间节点进度已经同步" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older Agent Loop poll overwrite a newer cancellation", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      const runningJob = {
        id: "agent-loop-job-stale-poll-001",
        runId: run.id,
        idempotencyKey: "agent-loop-stale-poll-key-001",
        status: "running" as const,
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      data.agentLoopJobs.push(runningJob);
      const staleBootstrap = structuredClone(data);
      let resolveBootstrap: ((value: typeof staleBootstrap) => void) | undefined;
      const loadBootstrap = vi.spyOn(StudioApi, "loadBootstrap").mockImplementation(() => new Promise((resolve) => {
        resolveBootstrap = resolve;
      }));
      const cancel = vi.spyOn(StudioApi, "cancelAgentLoopJob").mockResolvedValue({
        ...runningJob,
        status: "cancel_requested",
        cancelRequestedAt: "2026-08-28T00:01:00.000Z",
        updatedAt: "2026-08-28T00:01:00.000Z",
      });
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(loadBootstrap).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await act(async () => { await Promise.resolve(); });
      expect(cancel).toHaveBeenCalledWith(run.id, runningJob.id);
      expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();

      await act(async () => { resolveBootstrap?.(staleBootstrap); });
      expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an Agent Loop result and node focus scoped to its episode", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const firstRun = data.runs[0];
      if (!firstRun) throw new Error("seed run missing");
      firstRun.status = "active";
      firstRun.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const secondRun = structuredClone(firstRun);
      secondRun.id = "run-second-episode";
      secondRun.opportunityId = "opportunity-second-episode";
      secondRun.title = "第二集：不能收到第一集的完成消息";
      data.runs.push(secondRun);
      const runningJob = {
        id: "agent-loop-job-run-scope-001",
        runId: firstRun.id,
        idempotencyKey: "agent-loop-run-scope-key-001",
        status: "running" as const,
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      const stoppedNode = firstRun.nodes.find((node) => node.id === "script-audit");
      const recommendedSecondNode = secondRun.nodes.find((node) => node.status === "ready");
      if (!stoppedNode || !recommendedSecondNode) throw new Error("seed workflow nodes missing");
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      let resolveJob: ((value: AgentLoopJob) => void) | undefined;
      const loadJob = vi.spyOn(StudioApi, "loadAgentLoopJob").mockImplementation(() => new Promise((resolve) => {
        resolveJob = resolve;
      }));
      const terminalJob = {
        ...runningJob,
        status: "blocked" as const,
        reason: "requires_input" as const,
        stoppedAtNodeId: stoppedNode.id,
      };
      vi.spyOn(StudioApi, "loadBootstrap").mockResolvedValue({ ...data, agentLoopJobs: [terminalJob] });
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(screen.getByLabelText("选择制作中的节目"), { target: { value: secondRun.id } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(loadJob).toHaveBeenCalledWith(firstRun.id, runningJob.id);
      await act(async () => { resolveJob?.(terminalJob); });
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByRole("heading", { name: secondRun.title })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `${recommendedSecondNode.label} · 可执行` })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText("自动流程已生成需要处理的产物。")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a late exact-job poll undo a cancellation", async () => {
    vi.useFakeTimers();
    try {
      const data = createSeedSnapshot(NOW);
      const run = data.runs[0];
      if (!run) throw new Error("seed run missing");
      run.status = "active";
      run.nodes.forEach((node, index) => { node.status = index === 0 ? "ready" : "pending"; });
      const runningJob: AgentLoopJob = {
        id: "agent-loop-job-late-poll-001",
        runId: run.id,
        idempotencyKey: "agent-loop-late-poll-key-001",
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        executedNodeIds: [],
      };
      const cancellingJob: AgentLoopJob = {
        ...runningJob,
        status: "cancel_requested",
        updatedAt: "2026-08-28T00:01:00.000Z",
        cancelRequestedAt: "2026-08-28T00:01:00.000Z",
      };
      const cancelledJob: AgentLoopJob = {
        ...cancellingJob,
        status: "cancelled",
        updatedAt: "2026-08-28T00:02:00.000Z",
      };
      vi.spyOn(StudioApi, "startAgentLoopJob").mockResolvedValue(runningJob);
      let resolveOldPoll: ((value: AgentLoopJob) => void) | undefined;
      const loadJob = vi.spyOn(StudioApi, "loadAgentLoopJob")
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPoll = resolve; }))
        .mockResolvedValueOnce(cancelledJob);
      vi.spyOn(StudioApi, "cancelAgentLoopJob").mockResolvedValue(cancellingJob);
      let bootstrapJob = runningJob;
      vi.spyOn(StudioApi, "loadBootstrap").mockImplementation(async () => ({ ...data, agentLoopJobs: [bootstrapJob] }));
      render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

      fireEvent.click(screen.getByRole("button", { name: "制作" }));
      fireEvent.click(screen.getByRole("button", { name: "继续制作" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(loadJob).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();

      await act(async () => { resolveOldPoll?.(runningJob); });
      expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
      bootstrapJob = cancelledJob;
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText(/云端自动制作已停止/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the stopped Agent Loop node and reason after reloading", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    const stoppedNode = run.nodes.find((node) => node.id === "script-audit");
    if (!stoppedNode) throw new Error("seed stopped node missing");
    data.agentLoopJobs.push({
      id: "agent-loop-job-reload-terminal-001",
      runId: run.id,
      idempotencyKey: "agent-loop-reload-terminal-key-001",
      status: "blocked",
      createdAt: NOW,
      updatedAt: NOW,
      executedNodeIds: ["script-segment"],
      stoppedAtNodeId: stoppedNode.id,
      reason: "requires_input",
    });
    window.history.replaceState(null, "", `/?view=production&run=${run.id}`);

    render(<App initialData={data} initialInbox={EMPTY_INBOX} />);

    expect(screen.getByRole("button", { name: new RegExp(stoppedNode.label) })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("自动流程已生成需要处理的产物。")).toBeInTheDocument();
  });
});
