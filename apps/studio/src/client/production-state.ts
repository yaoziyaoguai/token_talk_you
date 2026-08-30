import type { WorkflowNode, WorkflowRun } from "@token-talk/domain/model";

const priorities: WorkflowNode["status"][] = [
  "failed",
  "running",
  "needs_human",
  "stale",
  "awaiting_spend_approval",
  "ready",
];

export function nextActionNode(run: WorkflowRun): WorkflowNode | undefined {
  if (run.status === "failed") return run.nodes.find((node) => node.status === "failed");
  return priorities.map((status) => run.nodes.find((node) => node.status === status)).find(Boolean);
}

export function describeRunStage(run: WorkflowRun): { label: string; tone: string; node: WorkflowNode | undefined } {
  const node = nextActionNode(run);
  if (run.status === "release_ready") return { label: "发行就绪", tone: "completed", node: undefined };
  if (run.status === "completed") return { label: "最近完成", tone: "completed", node: undefined };
  if (run.nodes.length > 0 && run.nodes.every((candidate) => candidate.status === "succeeded")) {
    return { label: "制作完成", tone: "completed", node: undefined };
  }
  if (node?.status === "running") return { label: "正在执行", tone: "running", node };
  if (node?.status === "needs_human") return { label: "执行待核对", tone: "human", node };
  if (node?.status === "failed") return { label: "需要处理", tone: "blocked", node };
  if (node?.status === "stale") return { label: "等待更新", tone: "blocked", node };
  if (node?.status === "awaiting_spend_approval") return { label: "等待预算确认", tone: "human", node };
  if (node?.status === "ready") return { label: "可以继续", tone: "ready", node };
  return { label: "等待制作调度", tone: "idle", node: undefined };
}

export function productionJourney(run: WorkflowRun): Array<{ label: string; state: "done" | "current" | "waiting" }> {
  const groups = [
    { label: "立项", nodes: [] as WorkflowNode[] },
    { label: "策划", nodes: run.nodes.filter((node) => node.phase === "planning") },
    { label: "成稿", nodes: run.nodes.filter((node) => node.capability.startsWith("script.")) },
    { label: "成片", nodes: run.nodes.filter((node) => ["voice.synthesize", "music.plan", "audio.render", "image.generate"].includes(node.capability)) },
    { label: "发布", nodes: run.nodes.filter((node) => node.capability === "audio.audit" || node.capability === "publish.package") },
  ];
  let currentFound = false;
  return groups.map((group, index) => {
    const completed = index === 0 || (group.nodes.length > 0 && group.nodes.every((node) => node.status === "succeeded"));
    if (!currentFound && completed) return { label: group.label, state: "done" };
    if (!currentFound) {
      currentFound = true;
      return { label: group.label, state: "current" };
    }
    return { label: group.label, state: "waiting" };
  });
}
