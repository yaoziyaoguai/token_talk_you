import { expect, test } from "@playwright/test";

test("operator follows one editorial path while technical records stay secondary", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天聊什么？" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /热点机会/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /系列选题/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button")).toHaveCount(3);

  const bootstrap = await page.request.get("/api/bootstrap");
  const { mutationToken } = await bootstrap.json() as { mutationToken: string };
  const candidateStatus = await page.evaluate(async (token) => {
    const response = await fetch("/api/candidates", {
      method: "POST",
      headers: { "x-token-talk-token": token },
    });
    return response.status;
  }, mutationToken);
  expect(candidateStatus).toBe(200);

  await page.getByRole("button", { name: "节目", exact: true }).click();
  await expect(page.getByText("按每期选题动态编排")).toBeVisible();

  await page.getByRole("button", { name: "打开声音与音乐" }).click();
  await expect(page.getByRole("heading", { name: "声音与音乐" })).toBeVisible();
  await page.getByText("高级：制作服务、价格与授权").click();
  await expect(page.getByText("商用受限").first()).toBeVisible();

  const response = await page.request.put("/api/runs/run-deep-reading/artifacts/artifact-blueprint", {
    headers: { "x-token-talk-token": mutationToken },
    data: { data: { chapters: 6, targetMinutes: 42 } },
  });
  expect(response.ok()).toBe(true);

  await page.reload();
  await page.getByRole("button", { name: "选题", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今天聊什么？" })).toBeVisible();
  await page.getByRole("button", { name: "制作", exact: true }).click();
  await expect(page.getByRole("list", { name: "本集制作进度" })).toContainText("发布");
  await page.getByRole("button", { name: /发布包/ }).click();
  await expect(page.getByText("上游蓝图已更新，需要重新生成")).toBeVisible();
  await expect(page.getByText("产物已失效")).toBeVisible();
  await expect(page.getByText("上游版本")).toBeHidden();
  await page.getByText("制作记录与技术详情").click();
  await expect(page.getByText("上游版本")).toBeVisible();

  const horizontalExtent = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(horizontalExtent.document).toBeLessThanOrEqual(horizontalExtent.viewport);

  if (testInfo.project.name === "desktop") {
    const [rail, workspace] = await Promise.all([
      page.locator(".node-rail").boundingBox(),
      page.locator(".node-workspace").boundingBox(),
    ]);
    expect(rail && workspace).toBeTruthy();
    expect((rail?.x ?? 0) + (rail?.width ?? 0)).toBeLessThanOrEqual(workspace?.x ?? 0);
  } else {
    await page.screenshot({ path: testInfo.outputPath("studio-production-mobile.png") });
    await page.getByRole("button", { name: "选题", exact: true }).click();
    await expect(page.getByRole("heading", { name: "今天聊什么？" })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const navigation = await page.locator(".sidebar").boundingBox();
    const [entryTabs, overview] = await Promise.all([
      page.locator(".entry-tabs").boundingBox(),
      page.locator(".studio-overview").boundingBox(),
    ]);
    expect(navigation).toBeTruthy();
    expect(Math.round((navigation?.y ?? 0) + (navigation?.height ?? 0))).toBe(page.viewportSize()?.height);
    expect(entryTabs && overview).toBeTruthy();
    expect((entryTabs?.y ?? 0) + (entryTabs?.height ?? 0)).toBeLessThanOrEqual(overview?.y ?? 0);
  }

  await page.screenshot({
    path: testInfo.outputPath(`studio-${testInfo.project.name}.png`),
  });
});

test("script room protects locked chapters while keeping every line editable", async ({ page }, testInfo) => {
  await page.goto("/");
  const bootstrap = await page.request.get("/api/bootstrap");
  const { mutationToken } = await bootstrap.json() as { mutationToken: string };
  const headers = { "x-token-talk-token": mutationToken };
  const blueprint = await page.request.put("/api/runs/run-deep-reading/artifacts/artifact-blueprint", {
    headers,
    data: { data: { status: "draft", targetMinutes: 12, segments: [
      { id: "segment-1", title: "直觉为什么如此诱人", minutes: 5, purpose: "建立问题", claimIds: [], tension: "速度与可靠性", handoff: "转入证据" },
      { id: "segment-2", title: "证据如何改变判断", minutes: 7, purpose: "展开分歧", claimIds: [], tension: "经验与统计", handoff: "保留结论边界" },
    ] } },
  });
  expect(blueprint.ok()).toBe(true);
  const script = await page.request.put("/api/runs/run-deep-reading/artifacts/artifact-segment-1", {
    headers,
    data: { data: { status: "draft", lockedSegmentIds: ["segment-1"], lines: [
      { segmentId: "segment-1", speaker: "问题引导者", text: "我们先不急着赞美直觉，先看它为什么让人如此信服。", claimIds: [] },
      { segmentId: "segment-1", speaker: "事实编辑", text: "速度带来的是确定感，但确定感本身还不是证据。", claimIds: [] },
      { segmentId: "segment-2", speaker: "问题引导者", text: "当经验和统计发生冲突时，我们应该把哪一个放在前面？", claimIds: [] },
      { segmentId: "segment-2", speaker: "事实编辑", text: "关键不是消灭直觉，而是知道什么时候必须停下来核验。", claimIds: [] },
    ] } },
  });
  expect(script.ok()).toBe(true);

  await page.goto("/?view=production&run=run-deep-reading&node=segment-room-1");
  await expect(page.getByRole("heading", { name: "章节 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成章节 1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重新生成章节 2" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "解锁章节 1" })).toBeVisible();
  await expect(page.getByLabel("第 4 句台词")).toHaveValue("关键不是消灭直觉，而是知道什么时候必须停下来核验。");
  const horizontalExtent = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(horizontalExtent.document).toBeLessThanOrEqual(horizontalExtent.viewport);
  await page.screenshot({ path: testInfo.outputPath(`script-room-${testInfo.project.name}.png`) });
});
