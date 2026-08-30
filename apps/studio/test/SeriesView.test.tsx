import { createSeedSnapshot, EpisodeCandidateSchema } from "@token-talk/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SeriesView } from "../src/client/components/SeriesView.js";

const NOW = "2026-08-29T01:00:00.000Z";

describe("SeriesView", () => {
  it("keeps a historical series proposal available but marks it for review", async () => {
    const user = userEvent.setup();
    const candidate = EpisodeCandidateSchema.parse({
      id: "candidate-series-deep-reading-2",
      origin: "series",
      title: "《有限与无限的游戏》：为什么有些胜利会让游戏结束？",
      hook: "把人生当成比赛，可能正是问题本身。",
      rationale: "延续栏目承诺",
      category: "books",
      platform: "Token Talk 读书会",
      seriesId: "series-deep-reading",
      episodeNumber: 2,
      suggestedRoles: ["本期主持", "观点挑战者"],
      verdict: "series_episode",
      targetMinutes: { min: 30, max: 48 },
      score: { overall: 82, audienceRelevance: 78, conversationPotential: 84, evidenceDepth: 62, longformDepth: 90, freshness: 58, seriesFit: 96, feasibility: 82, risk: 18 },
      evidence: [],
      verification: { status: "ready", reason: "可立项", independentSources: 0 },
      editorial: { whyNow: "下一期", centralQuestion: "什么值得继续？", listenerPromise: "形成长期判断", selectionReasons: ["延续栏目承诺"], signalPlatforms: ["Token Talk 读书会"], signalCount: 1, provider: "series" },
      generatedAt: NOW,
    });
    const onAdopt = vi.fn(async () => undefined);

    render(<SeriesView
      data={createSeedSnapshot(NOW)}
      inbox={{ items: [candidate], fetchedAt: NOW, warnings: [], sources: [] }}
      historicalCandidates
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onAdopt={onAdopt}
      onDismissActionError={() => undefined}
      onRefresh={() => undefined}
      onOpenProduction={() => undefined}
      onCreateSeries={async () => undefined}
    />);

    expect(screen.getByText("下一期委约")).toBeInTheDocument();
    expect(screen.getByText(/显示上次保存的提案/)).toBeInTheDocument();
    expect(screen.getByText("复核后立项")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /有限与无限的游戏/ }));
    expect(onAdopt).toHaveBeenCalledWith(candidate);
  });

  it("distinguishes a failed proposal refresh from a genuinely empty series", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(async () => undefined);
    render(<SeriesView
      data={createSeedSnapshot(NOW)}
      inbox={undefined}
      historicalCandidates={false}
      loading={false}
      loadError="热点信号源暂时不可用"
      actionError={undefined}
      adoptingId={undefined}
      onAdopt={async () => undefined}
      onDismissActionError={() => undefined}
      onRefresh={onRefresh}
      onOpenProduction={() => undefined}
      onCreateSeries={async () => undefined}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("热点信号源暂时不可用");
    await user.click(screen.getByRole("button", { name: "重新采集" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("labels a finished run as history instead of current production", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    if (!run) throw new Error("seed run missing");
    run.status = "completed";
    render(<SeriesView
      data={data}
      inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [] }}
      historicalCandidates={false}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onAdopt={async () => undefined}
      onDismissActionError={() => undefined}
      onRefresh={() => undefined}
      onOpenProduction={() => undefined}
      onCreateSeries={async () => undefined}
    />);

    expect(screen.getByText("最近发布")).toBeInTheDocument();
    expect(screen.queryByText("当前制作")).not.toBeInTheDocument();
  });

  it("keeps a failed commissioning action visible", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<SeriesView
      data={createSeedSnapshot(NOW)}
      inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [] }}
      historicalCandidates={false}
      loading={false}
      loadError={undefined}
      actionError="无法采用这个系列选题"
      adoptingId={undefined}
      onAdopt={async () => undefined}
      onDismissActionError={onDismiss}
      onRefresh={() => undefined}
      onOpenProduction={() => undefined}
      onCreateSeries={async () => undefined}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("无法采用这个系列选题");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("creates a series from a complete editorial brief", async () => {
    const user = userEvent.setup();
    const onCreateSeries = vi.fn(async () => undefined);
    render(<SeriesView
      data={createSeedSnapshot(NOW)}
      inbox={{ items: [], fetchedAt: NOW, warnings: [], sources: [] }}
      historicalCandidates={false}
      loading={false}
      loadError={undefined}
      actionError={undefined}
      adoptingId={undefined}
      onAdopt={async () => undefined}
      onDismissActionError={() => undefined}
      onRefresh={() => undefined}
      onOpenProduction={() => undefined}
      onCreateSeries={onCreateSeries}
    />);

    await user.click(screen.getByRole("button", { name: "新建系列" }));
    await user.type(screen.getByLabelText("系列名称"), "AI 口述史");
    await user.type(screen.getByLabelText("每一期都要兑现的承诺"), "让技术变化留下人的声音");
    await user.type(screen.getByLabelText("核心听众"), "关注技术与社会的人");
    await user.selectOptions(screen.getByLabelText("角色策略"), "recurring_with_guests");
    await user.type(screen.getByLabelText("常驻角色"), "口述史主持人");
    await user.selectOptions(screen.getByLabelText("音乐策略"), "narrative");
    await user.click(screen.getByRole("button", { name: "创建系列" }));

    expect(onCreateSeries).toHaveBeenCalledWith({
      requestId: expect.any(String),
      title: "AI 口述史",
      promise: "让技术变化留下人的声音",
      audience: "关注技术与社会的人",
      castPolicy: {
        mode: "recurring_with_guests",
        recurringRoleIds: ["series-role-1"],
        roles: [{ id: "series-role-1", name: "口述史主持人", responsibility: "维持栏目承诺并推进本期问题" }],
      },
      musicPolicy: "narrative",
    });
  });
});
