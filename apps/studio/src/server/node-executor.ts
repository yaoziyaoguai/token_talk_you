import type { WorkflowNode, WorkflowRun } from "@token-talk/domain";
import type { NodeExecutionOutcome } from "@token-talk/workflow";

export interface NodePlanningContext {
  run: WorkflowRun;
  node: WorkflowNode;
}

export interface NodeExecutionContext extends NodePlanningContext {
  attemptId: string;
  input?: { segmentId?: string | undefined };
  retryFeedback?: string;
  signal: AbortSignal;
}

export interface NodeExecutionPlan {
  providerId: string;
  modelId: string;
  billing: NodeExecutionOutcome["billing"];
  estimatedCostCny: number;
  timeoutMs?: number;
}

export interface NodeExecutor {
  plan?(context: NodePlanningContext): NodeExecutionPlan;
  execute(context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
  commit?(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<NodeExecutionOutcome>;
  discard?(context: Omit<NodeExecutionContext, "signal">, outcome: NodeExecutionOutcome): Promise<void>;
}
