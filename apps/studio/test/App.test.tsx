import { createSeedSnapshot } from "@token-talk/domain";
import { reviseArtifact } from "@token-talk/workflow";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import { StudioApi } from "../src/client/api.js";
import { StudioCommandBar } from "../src/client/components/StudioCommandBar.js";

const NOW = "2026-08-28T00:00:00.000Z";
const EMPTY_INBOX = { items: [], fetchedAt: NOW, warnings: [], sources: [] };

describe("Token Talk operator shell", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    StudioApi.configureLocalSession(undefined);
  });
  afterEach(() => {
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
      expect(fetcher).toHaveBeenCalledWith("/api/candidates", expect.objectContaining({ method: "POST" }));
      expect(fetcher.mock.calls.some(([input]) => String(input).includes("refresh=true"))).toBe(false);
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

  it("refreshes series proposals immediately after a series is created", async () => {
    const user = userEvent.setup();
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

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/candidates", expect.objectContaining({ method: "POST" })));
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
});
