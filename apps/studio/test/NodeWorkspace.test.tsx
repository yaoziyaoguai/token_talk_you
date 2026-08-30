import { createSeedSnapshot } from "@token-talk/domain";
import { reviseArtifact } from "@token-talk/workflow";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";

const NOW = "2026-08-29T00:00:00.000Z";

describe("NodeWorkspace execution", () => {
  it("runs the selected workflow node from the Web workbench", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    const node = run?.nodes.find((item) => item.id === "source-packet");
    if (!run || !node) throw new Error("seed node missing");
    const onExecuteNode = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={onExecuteNode} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "重新运行" }));

    expect(onExecuteNode).toHaveBeenCalledWith("source-packet");
  });

  it("shows the generated table-read in an audio player", () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-audio", {
      status: "preview_ready",
      previewKind: "local_table_read",
      mediaUrl: "/media/run/table-read.m4a",
      releaseReady: false,
    }, NOW);
    const node = run.nodes.find((item) => item.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const { container } = render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} />);

    expect(screen.getByText("桌读预听")).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute("src", "/media/run/table-read.m4a");
  });

  it("does not offer a second execution while the persisted node is running", () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    const node = run?.nodes.find((item) => item.id === "source-packet");
    if (!run || !node) throw new Error("seed node missing");
    node.status = "running";

    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} />);

    expect(screen.getByRole("button", { name: "正在运行" })).toBeDisabled();
  });

  it("renders a research packet as a source ledger instead of flattened JSON", () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-sources", {
      status: "needs_research",
      verifiedIndependentSourceCount: 0,
      sources: [{
        id: "source-one",
        title: "可审阅的研究来源",
        url: "https://example.com/source",
        providerLabel: "Crossref 公共元数据",
        publisher: "Example Press",
        publishedAt: "2025-03-02",
        verificationStatus: "unverified",
      }],
      research: {
        attempts: [
          { providerId: "crossref-public", providerLabel: "Crossref 公共元数据", status: "succeeded", resultCount: 1 },
          { providerId: "wikipedia-zh", providerLabel: "中文维基百科", status: "failed", resultCount: 0, error: "HTTP 503" },
        ],
      },
    }, NOW);
    const node = run.nodes.find((item) => item.id === "source-packet");
    if (!node) throw new Error("source node missing");

    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} />);

    expect(screen.getByRole("link", { name: "打开来源：可审阅的研究来源" })).toHaveAttribute("href", "https://example.com/source");
    expect(screen.getByText("0 条可信独立来源")).toBeInTheDocument();
    expect(screen.getByText("Crossref 公共元数据 · 1 条")).toBeInTheDocument();
    expect(screen.getByText("中文维基百科 · 失败")).toBeInTheDocument();
  });

  it("delegates source verification to the trusted server action", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-sources", {
      status: "needs_research",
      verifiedIndependentSourceCount: 1,
      sources: [
        { id: "source-one", title: "机器检查来源", url: "https://one.example/source", verificationStatus: "machine_checked", machineCheckedAt: NOW, provenanceGroup: "domain:one.example", verificationMethod: "safe_https_metadata", responseContentType: "text/html", responseSha256: "a".repeat(64) },
        { id: "source-two", title: "第二来源", url: "https://two.example/source", verificationStatus: "unverified" },
      ],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "source-packet");
    if (!node) throw new Error("source node missing");
    const onReviewResearchSource = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onReviewResearchSource={onReviewResearchSource} onExecuteNode={async () => undefined} />);

    expect(screen.getByText("机器已检查")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "人工确认来源：第二来源" }));

    expect(onReviewResearchSource).toHaveBeenCalledWith("artifact-sources", "source-two", true);
  });

  it("edits the episode transcript line by line instead of exposing JSON as the primary control", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-script", {
      status: "assembled_draft",
      title: initialRun.title,
      lines: [{ segmentId: "opening", speaker: "引导者", text: "旧台词", claimIds: ["claim-1"] }],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "showrunner-assembly");
    if (!node) throw new Error("assembly node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={async () => undefined} />);

    const user = userEvent.setup();
    expect(screen.queryByText("高级：编辑结构化数据")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("第 1 句台词"));
    await user.type(screen.getByLabelText("第 1 句台词"), "这是一句可以直接编辑的逐字稿。");
    await user.click(screen.getByRole("button", { name: "保存逐字稿" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-script", expect.objectContaining({
      status: "draft",
      estimatedCharacters: 15,
      lines: [expect.objectContaining({ speaker: "引导者", text: "这是一句可以直接编辑的逐字稿。", claimIds: ["claim-1"] })],
    }));
  });

  it("locks script chapters and regenerates only an unlocked chapter", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-segment-1", {
      status: "draft",
      lockedSegmentIds: ["segment-1"],
      lines: [
        { segmentId: "segment-1", speaker: "主持", text: "保留开场", claimIds: [] },
        { segmentId: "segment-2", speaker: "来宾", text: "可以重写", claimIds: [] },
      ],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "segment-room-1");
    if (!node) throw new Error("segment node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    const onExecuteNode = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={onExecuteNode} />);

    expect(screen.getByRole("button", { name: "重新生成章节 1" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "重新生成章节 2" }));
    expect(onExecuteNode).toHaveBeenCalledWith("segment-room-1", { segmentId: "segment-2" });

    await userEvent.setup().click(screen.getByRole("button", { name: "锁定章节 2" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "保存逐字稿" }));
    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-segment-1", expect.objectContaining({
      lockedSegmentIds: ["segment-1", "segment-2"],
    }));
  });

  it("edits a topic-derived cast without assuming a fixed two-person format", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    const node = run?.nodes.find((item) => item.id === "cast-plan");
    if (!run || !node) throw new Error("cast node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={async () => undefined} />);

    const user = userEvent.setup();
    expect(screen.getByLabelText("角色连续性")).toHaveValue("dynamic");
    await user.clear(screen.getByLabelText("第 1 个角色名"));
    await user.type(screen.getByLabelText("第 1 个角色名"), "问题拆解者");
    await user.click(screen.getByRole("button", { name: "保存角色方案" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-cast", expect.objectContaining({
      policy: "dynamic",
      roles: expect.arrayContaining([expect.objectContaining({ name: "问题拆解者" })]),
    }));
  });

  it("builds an editable chapter blueprint before script generation", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-blueprint", {
      status: "draft",
      targetMinutes: 30,
      segments: [
        { id: "opening", title: "提出问题", minutes: 10, purpose: "建立听众承诺" },
        { id: "evidence", title: "证据与分歧", minutes: 10, purpose: "检验关键论点" },
        { id: "closing", title: "判断边界", minutes: 10, purpose: "收束并保留问题" },
      ],
    }, NOW);
    data.runs[0] = run;
    const node = run?.nodes.find((item) => item.id === "episode-blueprint");
    if (!run || !node) throw new Error("blueprint node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={async () => undefined} />);

    const user = userEvent.setup();
    const title = screen.getByRole("textbox", { name: "第 2 章标题" });
    await user.clear(title);
    await user.type(title, "证据、反例与分歧");
    await user.click(screen.getByRole("button", { name: "保存节目蓝图" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-blueprint", expect.objectContaining({
      status: "draft",
      targetMinutes: 30,
      segments: expect.arrayContaining([expect.objectContaining({ id: "evidence", title: "证据、反例与分歧", minutes: 10 })]),
    }));
  });

  it("edits release title, summary, Show Notes, and keywords without exposing JSON", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    const node = run?.nodes.find((item) => item.id === "release-editorial");
    if (!run || !node) throw new Error("release editorial node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={async () => undefined} />);

    const user = userEvent.setup();
    expect(screen.queryByText("高级：编辑结构化数据")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("发行单集摘要"));
    await user.type(screen.getByLabelText("发行单集摘要"), "一段经过发行编辑确认的新摘要。");
    await user.clear(screen.getByLabelText("发行关键词"));
    await user.type(screen.getByLabelText("发行关键词"), "判断,认知科学");
    await user.click(screen.getByRole("button", { name: "保存发行文案" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-release-copy", expect.objectContaining({
      status: "ready",
      summary: "一段经过发行编辑确认的新摘要。",
      keywords: ["判断", "认知科学"],
    }));
  });

  it("saves a per-role voice configuration without creating another manual gate", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-voices", {
      status: "ready",
      confirmed: false,
      characters: 8_800,
      roles: ["问题引导者"],
      selections: [{ role: "问题引导者", providerId: "local-macos-say", voiceId: "preview-steady", use: "preview_only" }],
      candidates: [
        {
          providerId: "local-macos-say",
          label: "系统桌读预听",
          estimatedCostCny: 0,
          configured: true,
          releaseUse: "preview_only",
          voices: [
            { id: "preview-steady", label: "普通话 · 平稳" },
            { id: "preview-bright", label: "普通话 · 明快" },
          ],
        },
        { providerId: "alibaba-qwen-tts", label: "Qwen3-TTS Flash", estimatedCostCny: 0.7, configured: false, releaseUse: "terms_review", freeQuota: "开通后 90 天 11 万字符" },
      ],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "voice-casting");
    if (!node) throw new Error("voice node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    const onExecuteNode = vi.fn(async () => undefined);
    const onDirtyChange = vi.fn();
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={onExecuteNode} onDirtyChange={onDirtyChange} />);

    expect(screen.getByText("约 ¥0.70")).toBeInTheDocument();
    expect(screen.getByText("开通后 90 天 11 万字符")).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "问题引导者：声音" }), "preview-bright");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "保存声音配置" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-voices", expect.objectContaining({ confirmed: true, status: "ready" }));
    expect(onExecuteNode).not.toHaveBeenCalled();
  });

  it("binds a paid render to an explicit one-attempt cost authorization", async () => {
    const data = createSeedSnapshot(NOW);
    const run = data.runs[0];
    const node = run?.nodes.find((item) => item.id === "audio-mix");
    if (!run || !node) throw new Error("audio node missing");
    const required = {
      providerId: "elevenlabs-v3",
      modelId: "eleven_v3",
      billing: "metered" as const,
      estimatedCostCny: 6.34,
      remainingBudgetCny: 18,
      authorization: "required" as const,
      attemptsUsed: 0,
    };
    const onLoadExecutionPreview = vi.fn()
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce({ ...required, authorization: "active", maxAttempts: 1, expiresAt: "2026-08-29T00:30:00.000Z" });
    const onAuthorizeSpend = vi.fn(async () => undefined);
    render(<NodeWorkspace
      data={data}
      run={run}
      node={node}
      onReviseArtifact={async () => undefined}
      onExecuteNode={async () => undefined}
      onLoadExecutionPreview={onLoadExecutionPreview}
      onAuthorizeSpend={onAuthorizeSpend}
    />);

    expect(await screen.findByText("¥6.34")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新运行" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /确认当前脚本与角色声音已获授权/ }));
    await userEvent.setup().click(screen.getByRole("button", { name: "授权本次生成" }));

    expect(onAuthorizeSpend).toHaveBeenCalledWith("audio-mix", 6.34);
    expect(await screen.findByText("已授权")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新运行" })).toBeEnabled();
  });

  it("lets the sound director audition licensed music or keep a cue silent", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-cues", {
      status: "ready",
      confirmed: false,
      libraryAssetCount: 1,
      cues: [{
        id: "closing",
        label: "结尾余味",
        purpose: "结论说完后再进入",
        durationSeconds: 7,
        selection: { action: "silence" },
        choices: [
          { action: "silence", title: "留白", score: 100, reason: "保留节目呼吸" },
          { action: "asset", assetId: "music-one", title: "低密度钢琴", mediaUrl: "/media/music-library/music-one.mp3", score: 86, reason: "情绪匹配 · 能量 1" },
        ],
      }],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "music-cue-sheet");
    if (!node) throw new Error("music node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    const onExecuteNode = vi.fn(async () => undefined);
    const { container } = render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={onExecuteNode} />);

    expect(screen.getByText("保留节目呼吸")).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByLabelText("声音选择"), "music-one");
    expect(container.querySelector("audio")).toHaveAttribute("src", "/media/music-library/music-one.mp3");
    await userEvent.setup().click(screen.getByRole("button", { name: "保存音乐配置" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-cues", expect.objectContaining({ status: "ready", confirmed: true }));
    expect(onExecuteNode).not.toHaveBeenCalled();
  });

  it("owns audio decode failures and lets the editor retry", async () => {
    const user = userEvent.setup();
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-audio", {
      status: "preview_ready",
      previewKind: "local_table_read",
      mediaUrl: "/media/run/broken.m4a",
      releaseReady: false,
    }, NOW);
    const node = run.nodes.find((item) => item.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const { container } = render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} />);

    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByRole("alert")).toHaveTextContent("音频载入失败");
    await user.click(screen.getByRole("button", { name: "重新载入" }));
    expect(container.querySelector("audio")).toHaveAttribute("src", "/media/run/broken.m4a");
  });

  it("turns release-master registration into a rights-confirmed business action", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-audio", {
      status: "preview_ready",
      previewKind: "local_table_read",
      mediaUrl: "/media/run/table-read.m4a",
      releaseReady: false,
    }, NOW);
    const node = run.nodes.find((item) => item.id === "audio-mix");
    if (!node) throw new Error("audio node missing");
    const onRegisterReleaseMaster = vi.fn(async () => undefined);
    render(<NodeWorkspace
      data={data}
      run={run}
      node={node}
      onReviseArtifact={async () => undefined}
      onExecuteNode={async () => undefined}
      onRegisterReleaseMaster={onRegisterReleaseMaster}
    />);

    const user = userEvent.setup();
    const file = new File(["fake wav"], "episode-master.wav", { type: "audio/wav" });
    await user.upload(screen.getByLabelText("选择发行母带"), file);
    await user.type(screen.getByLabelText("权利人或授权主体"), "Token Talk 编辑部");
    for (const checkbox of screen.getAllByRole("checkbox")) await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "登记发行母带" }));

    expect(onRegisterReleaseMaster).toHaveBeenCalledWith(file, {
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
      voiceConsentConfirmed: true,
      musicRightsConfirmed: true,
    });
    expect(screen.getByLabelText("权利人或授权主体")).toHaveValue("");
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText("高级：编辑结构化数据")).not.toBeInTheDocument();
  });

  it("shows cover art as visual media and validates rights before registration", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-visuals", {
      status: "needs_provider",
      direction: "单一主体，缩略图仍可辨认",
      covers: [],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "visual-pack");
    if (!node) throw new Error("visual node missing");
    const onRegisterCover = vi.fn(async () => undefined);
    render(<NodeWorkspace
      data={data}
      run={run}
      node={node}
      onReviseArtifact={async () => undefined}
      onExecuteNode={async () => undefined}
      onRegisterCover={onRegisterCover}
    />);

    expect(screen.getByText("单一主体，缩略图仍可辨认")).toBeInTheDocument();
    const user = userEvent.setup();
    const file = new File([new Uint8Array([137, 80, 78, 71])], "episode-cover.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("选择单集封面"), file);
    await user.type(screen.getByLabelText("封面内容描述"), "一束红色声波穿过深色纸张");
    await user.type(screen.getByLabelText("封面权利人或授权主体"), "Token Talk 编辑部");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "登记单集封面" }));

    expect(onRegisterCover).toHaveBeenCalledWith(file, {
      altText: "一束红色声波穿过深色纸张",
      rightsOwner: "Token Talk 编辑部",
      licenseBasis: "owned",
      commercialUseConfirmed: true,
    });
    expect(screen.getByLabelText("封面内容描述")).toHaveValue("");
    expect(screen.getByLabelText("封面权利人或授权主体")).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText("高级：编辑结构化数据")).not.toBeInTheDocument();
  });

  it("edits the Codex cover and chapter-art brief without rewriting registered media fields", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-visuals", {
      status: "brief_ready",
      coverBrief: { concept: "旧概念", imagePrompt: "Old prompt", altText: "旧封面描述" },
      chapterArtBriefs: [{ segmentId: "opening", title: "提出问题", concept: "旧章节概念", imagePrompt: "Old chapter prompt", altText: "旧章节描述" }],
      covers: [],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "visual-pack");
    if (!node) throw new Error("visual node missing");
    const onReviseArtifact = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={onReviseArtifact} onExecuteNode={async () => undefined} />);

    const user = userEvent.setup();
    const concept = screen.getByRole("textbox", { name: "核心概念" });
    await user.clear(concept);
    await user.type(concept, "证据被逐层展开");
    await user.click(screen.getByRole("button", { name: "保存视觉 Brief" }));

    expect(onReviseArtifact).toHaveBeenCalledWith("artifact-visuals", expect.objectContaining({
      status: "brief_ready",
      covers: [],
      coverBrief: expect.objectContaining({ concept: "证据被逐层展开" }),
      chapterArtBriefs: [expect.objectContaining({ segmentId: "opening", concept: "旧章节概念" })],
    }));
  });

  it("requires an explicit final cover selection", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-visuals", {
      status: "needs_selection",
      covers: [
        { id: "cover-one", mediaUrl: "/media/release-assets/cover-one.png", width: 1400, height: 1400, altText: "红色声波" },
        { id: "cover-two", mediaUrl: "/media/release-assets/cover-two.png", width: 1400, height: 1400, altText: "绿色声波" },
      ],
    }, NOW);
    const node = run.nodes.find((item) => item.id === "visual-pack");
    if (!node) throw new Error("visual node missing");
    const onSelectCover = vi.fn(async () => undefined);
    render(<NodeWorkspace
      data={data}
      run={run}
      node={node}
      onReviseArtifact={async () => undefined}
      onExecuteNode={async () => undefined}
      onSelectCover={onSelectCover}
    />);

    expect(screen.getByText("2 张待选择")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "设为发行封面" })[1]!);
    expect(onSelectCover).toHaveBeenCalledWith("cover-two");
  });

  it("shows the real release-package contents, publication ledger, and server-generated download", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-publish", {
      schemaVersion: 1,
      status: "release_ready",
      releaseReady: true,
      episode: { runId: initialRun.id, title: initialRun.title, seriesId: initialRun.seriesId, targetMinutes: 38, generatedAt: NOW },
      audio: { mediaUrl: "/media/release-assets/master.wav", sha256: "a".repeat(64) },
      cover: { mediaUrl: "/media/release-assets/cover.png", sha256: "b".repeat(64) },
      transcript: { format: "speaker_lines", lineCount: 12, lines: [] },
      chapters: [{ id: "opening", title: "开场", startSeconds: 0, durationSeconds: 180 }],
      sources: [{ id: "source-one", title: "来源一", url: "https://one.example/report" }, { id: "source-two", title: "来源二", url: "https://two.example/report" }],
      disclosures: { aiAssisted: true, automatedAudioAudit: true, cast: [], voices: [], musicCues: [], rights: {} },
      checksums: { audioSha256: "a".repeat(64), coverSha256: "b".repeat(64) },
      audioAuditArtifactVersionId: "artifact-audio-audit-v1",
    }, NOW);
    const node = run.nodes.find((item) => item.id === "publish-package");
    if (!node) throw new Error("publish node missing");
    node.status = "succeeded";
    run.status = "release_ready";
    const onRegisterPublication = vi.fn()
      .mockRejectedValueOnce(new Error("网络在响应前中断"))
      .mockResolvedValueOnce(undefined);

    const view = render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} onRegisterPublication={onRegisterPublication} />);

    expect(screen.getByText("12 句逐字稿")).toBeInTheDocument();
    expect(screen.getByText("1 个章节")).toBeInTheDocument();
    expect(screen.getByText("2 个已核验来源")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载发行清单" })).toHaveAttribute("href", `/api/runs/${run.id}/release-package`);

    fireEvent.change(screen.getByLabelText("发布平台"), { target: { value: "小宇宙" } });
    fireEvent.change(screen.getByLabelText("外部节目 ID"), { target: { value: "episode-guid-1" } });
    fireEvent.change(screen.getByLabelText("公开节目链接"), { target: { value: "https://www.xiaoyuzhoufm.com/episode/example" } });
    fireEvent.change(screen.getByLabelText("发布时间"), { target: { value: "2026-08-28T07:30" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "确认已发布" }));
    expect(screen.getByRole("alert")).toHaveTextContent("网络在响应前中断");
    await userEvent.setup().click(screen.getByRole("button", { name: "确认已发布" }));
    expect(onRegisterPublication).toHaveBeenCalledWith(expect.objectContaining({
      status: "published",
      platform: "小宇宙",
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      publishedAt: new Date("2026-08-28T07:30").toISOString(),
      requestId: expect.any(String),
    }));
    expect(onRegisterPublication.mock.calls[1]?.[0].requestId).toBe(onRegisterPublication.mock.calls[0]?.[0].requestId);

    const publishedRun = structuredClone(run);
    publishedRun.status = "completed";
    publishedRun.publicationRecords.push({
      id: "publication-1",
      requestId: "publish-request-001",
      platform: "小宇宙",
      status: "published",
      externalEpisodeId: "episode-guid-1",
      episodeUrl: "https://www.xiaoyuzhoufm.com/episode/example",
      releasePackageVersionId: "artifact-publish-v2",
      releasePackageSha256: "c".repeat(64),
      audioSha256: "a".repeat(64),
      coverSha256: "b".repeat(64),
      publishedAt: "2026-08-28T00:00:00.000Z",
      registeredAt: NOW,
    });
    const publishedNode = publishedRun.nodes.find((item) => item.id === "publish-package");
    if (!publishedNode) throw new Error("published node missing");
    view.rerender(<NodeWorkspace data={data} run={publishedRun} node={publishedNode} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} onRegisterPublication={onRegisterPublication} />);
    expect(screen.getByText("已发布")).toBeInTheDocument();
    expect(screen.getByText("小宇宙")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已锁定" })).toBeDisabled();
    expect(screen.getByText("本集制作已锁定")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 小宇宙 已发布节目" })).toHaveAttribute("href", "https://www.xiaoyuzhoufm.com/episode/example");
    expect(screen.getByRole("link", { name: "下载发行清单" })).toBeInTheDocument();

    const staleRun = structuredClone(run);
    staleRun.status = "active";
    const staleNode = staleRun.nodes.find((item) => item.id === "publish-package");
    if (!staleNode) throw new Error("stale publish node missing");
    staleNode.status = "stale";
    staleNode.staleReason = "上游内容已更新";
    view.rerender(<NodeWorkspace data={data} run={staleRun} node={staleNode} onReviseArtifact={async () => undefined} onExecuteNode={async () => undefined} />);

    expect(screen.getByText("发布包已失效")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载发行清单" })).not.toBeInTheDocument();
  });

  it("runs audio quality audit without a browser playback attestation", async () => {
    const data = createSeedSnapshot(NOW);
    const initialRun = data.runs[0];
    if (!initialRun) throw new Error("seed run missing");
    const run = reviseArtifact(initialRun, "artifact-audio", {
      status: "release_candidate",
      mediaUrl: "/media/run/final.m4a",
      releaseReady: true,
    }, NOW);
    const node = run.nodes.find((item) => item.id === "audio-audit");
    if (!node) throw new Error("audio audit node missing");
    node.status = "ready";
    const onExecuteNode = vi.fn(async () => undefined);
    render(<NodeWorkspace data={data} run={run} node={node} onReviseArtifact={async () => undefined} onExecuteNode={onExecuteNode} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "运行步骤" }));

    expect(onExecuteNode).toHaveBeenCalledWith("audio-audit");
  });
});
