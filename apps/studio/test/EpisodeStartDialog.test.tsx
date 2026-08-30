import { createSeedSnapshot, EpisodeCandidateSchema, EpisodeOpportunitySchema } from "@token-talk/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EpisodeStartDialog } from "../src/client/components/EpisodeStartDialog.js";

const NOW = "2026-08-29T01:00:00.000Z";

describe("EpisodeStartDialog", () => {
  it("owns keyboard focus, exposes async errors, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<EpisodeStartDialog
      data={createSeedSnapshot(NOW)}
      opportunity={opportunity()}
      pending={false}
      error="启动工作流失败"
      onClose={onClose}
      onStart={async () => undefined}
    />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("启动工作流失败");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the modal stable while the start request is pending", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<EpisodeStartDialog
      data={createSeedSnapshot(NOW)}
      opportunity={opportunity()}
      pending
      error={undefined}
      onClose={onClose}
      onStart={async () => undefined}
    />);

    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "稍后再做" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not submit an empty numeric intent or display NaN", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn(async () => undefined);
    render(<EpisodeStartDialog
      data={createSeedSnapshot(NOW)}
      opportunity={opportunity()}
      pending={false}
      error={undefined}
      onClose={() => undefined}
      onStart={onStart}
    />);

    await user.clear(screen.getByRole("spinbutton", { name: "现金上限" }));
    expect(screen.getByText(/上限 待填写/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动节目制作" })).toBeDisabled();
    expect(onStart).not.toHaveBeenCalled();
  });
});

function opportunity() {
  const candidate = EpisodeCandidateSchema.parse({
    id: "candidate-dialog",
    origin: "custom",
    title: "AI 助手会让人更会思考吗？",
    hook: "从反例开始讨论。",
    rationale: "主编提案",
    category: "other",
    platform: "主编提案",
    suggestedRoles: ["本期主持", "观点挑战者"],
    verdict: "deep_discussion",
    targetMinutes: { min: 25, max: 40 },
    score: { overall: 80, audienceRelevance: 80, conversationPotential: 85, evidenceDepth: 50, longformDepth: 86, freshness: 60, seriesFit: 75, feasibility: 88, risk: 20 },
    evidence: [],
    verification: { status: "ready", reason: "原创命题", independentSources: 0 },
    generatedAt: NOW,
  });
  return EpisodeOpportunitySchema.parse({
    id: "opportunity-dialog",
    candidateId: candidate.id,
    title: candidate.title,
    origin: candidate.origin,
    verdict: candidate.verdict,
    evidence: [],
    candidate,
    adoptedAt: NOW,
    status: "adopted",
  });
}
