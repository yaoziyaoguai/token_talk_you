import { createSeedSnapshot } from "@token-talk/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpisodeStudio } from "../src/client/components/EpisodeStudio.js";

const NOW = "2026-08-29T00:00:00.000Z";

function props(data: ReturnType<typeof createSeedSnapshot>, run: ReturnType<typeof createSeedSnapshot>["runs"][number]) {
  return {
    data,
    run,
    onReviseArtifact: async () => undefined,
    onReviewResearchSource: async () => undefined,
    onExecuteNode: async () => undefined,
    onLoadExecutionPreview: async () => ({
      providerId: "local-production-engine",
      modelId: "test-preview-v1",
      billing: "local_compute" as const,
      estimatedCostCny: 0,
      remainingBudgetCny: 0,
      authorization: "not_required" as const,
      attemptsUsed: 0,
    }),
    onAuthorizeSpend: async () => undefined,
    onReconcileCost: async () => undefined,
    onRegisterReleaseMaster: async () => undefined,
    onRegisterCover: async () => undefined,
    onSelectCover: async () => undefined,
  };
}

describe("EpisodeStudio", () => {
  afterEach(() => vi.restoreAllMocks());
  it("returns to the new episode's recommended task when switching runs", () => {
    const data = createSeedSnapshot(NOW);
    const first = data.runs[0];
    if (!first) throw new Error("seed run missing");
    const second = structuredClone(first);
    second.id = "run-second";
    second.title = "第二期";
    for (const node of second.nodes) node.status = node.id === "source-packet" ? "failed" : "pending";

    const view = render(<EpisodeStudio {...props(data, first)} />);
    fireEvent.click(screen.getByRole("button", { name: /发布包/ }));
    expect(screen.getByRole("heading", { name: "发布包" })).toBeInTheDocument();

    view.rerender(<EpisodeStudio {...props(data, second)} />);
    expect(screen.getByRole("heading", { name: "资料包" })).toBeInTheDocument();
  });

  it("marks every journey stage done when the selected run is fully complete", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");

    render(<EpisodeStudio {...props(data, run)} />);

    expect(screen.getByText("策划").closest("li")).toHaveClass("done");
    expect(screen.getByText("成稿").closest("li")).toHaveClass("done");
    expect(screen.getByText("成片").closest("li")).toHaveClass("done");
    expect(screen.getByText("发布").closest("li")).toHaveClass("done");
  });

  it("clears node-local review and rights state when the run changes", () => {
    const data = createSeedSnapshot(NOW);
    const first = structuredClone(data.runs[0]);
    if (!first) throw new Error("seed run missing");
    for (const node of first.nodes) node.status = "succeeded";
    first.nodes.find((node) => node.id === "audio-mix")!.status = "needs_human";
    first.nodes.find((node) => node.id === "audio-audit")!.status = "pending";
    first.nodes.find((node) => node.id === "publish-package")!.status = "pending";
    const second = structuredClone(first);
    second.id = "run-second-same-node";

    const view = render(<EpisodeStudio {...props(data, first)} />);
    fireEvent.change(screen.getByLabelText("权利人或授权主体"), { target: { value: "上一期编辑部" } });
    expect(screen.getByLabelText("权利人或授权主体")).toHaveValue("上一期编辑部");

    view.rerender(<EpisodeStudio {...props(data, second)} />);
    expect(screen.getByLabelText("权利人或授权主体")).toHaveValue("");
  });

  it("does not discard an unsaved blueprint when switching steps without confirmation", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EpisodeStudio {...props(data, run)} />);
    fireEvent.click(screen.getByRole("button", { name: /节目蓝图/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加章节" }));
    fireEvent.change(screen.getByLabelText("第 1 章标题"), { target: { value: "尚未保存的章节" } });

    fireEvent.click(screen.getByRole("button", { name: /资料包/ }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "节目蓝图" })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /资料包/ }));
    expect(screen.getByRole("heading", { name: "资料包" })).toBeInTheDocument();
  });

  it("shows and can stop a server-owned Agent Loop job after a page reload", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    data.agentLoopJobs.push({
      id: "agent-loop-job-visible-001",
      runId: run.id,
      idempotencyKey: "agent-loop-visible-key-001",
      status: "running",
      createdAt: NOW,
      updatedAt: NOW,
      executedNodeIds: ["source-packet"],
      currentNodeId: "evidence-audit",
    });
    const onCancelAgentLoop = vi.fn(async () => undefined);

    const view = render(<EpisodeStudio {...props(data, run)} onCancelAgentLoop={onCancelAgentLoop} />);

    expect(screen.getByRole("button", { name: "制作中" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("证据审计");
    expect(screen.getByRole("status")).toHaveTextContent("关闭或刷新页面不会中断");
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(onCancelAgentLoop).toHaveBeenCalledOnce());

    data.agentLoopJobs[0] = { ...data.agentLoopJobs[0]!, status: "cancelled", updatedAt: "2026-08-28T00:01:00.000Z" };
    view.rerender(<EpisodeStudio {...props(data, run)} onCancelAgentLoop={onCancelAgentLoop} />);
    expect(screen.queryByText(/正在等待当前节点安全收尾/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("云端自动制作已停止");
  });

  it("restores a persisted Agent Loop blocker after a page reload", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    data.agentLoopJobs.push({
      id: "agent-loop-job-blocked-001",
      runId: run.id,
      idempotencyKey: "agent-loop-blocked-key-001",
      status: "blocked",
      createdAt: NOW,
      updatedAt: NOW,
      executedNodeIds: ["source-packet"],
      stoppedAtNodeId: "audio-render",
      reason: "awaiting_spend_authorization",
    });

    render(<EpisodeStudio {...props(data, run)} />);

    expect(screen.getByRole("status")).toHaveTextContent("等待成本授权");
  });
});
