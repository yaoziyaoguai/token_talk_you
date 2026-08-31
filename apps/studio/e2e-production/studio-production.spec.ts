import { expect, test, type Page, type Request } from "@playwright/test";

test("all production work surfaces remain usable through the public ingress", async ({ page }, testInfo) => {
  const runtime = observeRuntime(page);
  const response = await page.goto("./");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "今天聊什么？" })).toBeVisible();

  const bootstrapResponse = await page.request.get("./api/bootstrap");
  expect(bootstrapResponse.ok()).toBe(true);
  const bootstrap = await bootstrapResponse.json() as ProductionBootstrap;
  expect(bootstrap.runs.length).toBeGreaterThan(0);
  expect(bootstrap.providers.length).toBeGreaterThan(0);

  await expect(page.getByRole("tab", { name: /热点机会/ })).toBeVisible();
  await expect(page.locator(".candidate-list button").first()).toBeVisible();
  expect(await page.locator(".candidate-list button").count()).toBeGreaterThan(0);
  await page.locator(".candidate-list button").first().click();
  await expect(page.locator(".candidate-detail")).toBeVisible();
  const evidence = page.locator(".candidate-detail details").filter({ hasText: "原始发现信号" });
  if (await evidence.count()) await evidence.first().click();
  const scoreDetails = page.locator(".candidate-detail details").filter({ hasText: "排序依据" });
  if (await scoreDetails.count()) await scoreDetails.first().click();

  const moreFilters = page.locator(".candidate-filter-more");
  if (await moreFilters.count()) {
    await moreFilters.click();
    for (const select of await moreFilters.locator("select").all()) {
      const options = await select.locator("option").count();
      if (options > 1) {
        await select.selectOption({ index: 1 });
        await select.selectOption({ index: 0 });
      }
    }
  }

  await page.getByRole("tab", { name: /系列选题/ }).click();
  await expect(page.getByRole("heading", { name: "下一期为什么值得回来听" })).toBeVisible();
  await page.getByRole("tab", { name: /自定义创作/ }).click();
  await expect(page.getByRole("heading", { name: "不追热点，也可以做耐听的节目" })).toBeVisible();
  await page.getByLabel("节目命题").fill("生产验收：长篇节目入口");
  await page.getByLabel("这期真正要追问什么").fill("长篇播客如何保持证据、结构与声音的一致性？");
  await page.getByLabel("目标时长").selectOption("240");
  await expect(page.getByLabel("目标时长")).toHaveValue("240");

  await page.getByRole("button", { name: "节目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "让节目值得追更" })).toBeVisible();
  await page.getByRole("button", { name: "新建系列" }).click();
  await expect(page.getByRole("heading", { name: "定义系列承诺" })).toBeVisible();
  await page.getByLabel("系列名称").fill("生产验收系列草稿");
  await page.getByLabel("每一期都要兑现的承诺").fill("每期给出一个可核验、可争论的长期答案");
  await page.getByLabel("核心听众").fill("愿意持续追更深度内容的听众");
  await page.getByLabel("角色策略").selectOption("recurring_with_guests");
  await page.getByLabel("常驻角色").fill("主持人, 事实编辑");
  await page.getByLabel("音乐策略").selectOption("immersive");
  await expect(page.getByRole("button", { name: "创建系列" })).toBeEnabled();
  await page.getByRole("button", { name: "关闭新建系列" }).click();

  await page.getByRole("button", { name: "打开声音与音乐" }).click();
  await expect(page.getByRole("heading", { name: "声音与音乐" })).toBeVisible();
  await expect(page.getByText("桌读声音")).toBeVisible();
  await expect(page.locator(".voice-catalog-state, .account-voice-list")).toBeVisible();
  await page.getByText("高级：制作服务、价格与授权").click();
  expect(await page.locator(".advanced-provider-list > div").count()).toBe(bootstrap.providers.length);

  await page.getByRole("button", { name: "制作", exact: true }).click();
  await expect(page.getByLabel("选择制作中的节目")).toBeVisible();
  for (const run of bootstrap.runs) {
    await page.getByLabel("选择制作中的节目").selectOption(run.id);
    await expect(page.getByRole("heading", { name: run.title, exact: true })).toBeVisible();
    for (const node of run.nodes) {
      await page.getByRole("navigation", { name: "本集制作步骤" }).getByRole("button", { name: new RegExp(`^${escapeRegExp(node.label)} ·`) }).click();
      await expect(page.locator(".node-workspace").getByRole("heading", { name: node.label, exact: true })).toBeVisible();
      const audit = page.locator(".production-audit");
      if (!(await audit.getAttribute("open"))) await audit.locator("summary").click();
      await expect(audit.getByRole("heading", { name: "本集约束" })).toBeVisible();
    }
  }

  const query = bootstrap.runs[0]!.title;
  await page.getByLabel("搜索节目、选题和制作记录").fill(query);
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.getByRole("option").first().click();
  await expect(page.getByRole("heading", { name: query, exact: true })).toBeVisible();

  const extent = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(extent.document).toBeLessThanOrEqual(extent.viewport);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.failedApiRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`production-${testInfo.project.name}.png`), fullPage: true });
});

test("a zero-cash original episode reaches the automatic production loop", async ({ page }, testInfo) => {
  test.setTimeout(100 * 60_000);
  test.skip(testInfo.project.name !== "production-desktop", "The mutating production journey runs once.");
  test.skip(process.env.TOKEN_TALK_ALLOW_PRODUCTION_MUTATION !== "1", "Production mutation requires explicit authorization.");
  const runtime = observeRuntime(page);
  const title = `生产验收 ${new Date().toISOString().replace(/[:.]/g, "-")}`;

  await page.goto("./");
  await page.getByRole("tab", { name: /自定义创作/ }).click();
  await page.getByLabel("节目命题").fill(title);
  await page.getByLabel("这期真正要追问什么").fill("当 AI 能快速生成内容时，深度播客应该如何守住事实、分歧和听感？");
  await page.getByLabel("目标时长").selectOption("15");
  await page.getByRole("button", { name: "立项并进入策划" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "确认本集怎么做" })).toBeVisible();
  await dialog.getByLabel("目标时长").fill("15");
  await dialog.getByLabel("音乐策略").selectOption("minimal");
  await dialog.getByLabel("现金上限").fill("0");
  await dialog.getByRole("button", { name: "启动节目制作" }).click();

  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "继续制作" }).click();
  await expect(page.locator(".agent-loop-message")).toBeVisible({ timeout: 90 * 60_000 });
  await expect(page.getByRole("button", { name: "制作中" })).toBeHidden({ timeout: 90 * 60_000 });

  const bootstrapResponse = await page.request.get("./api/bootstrap");
  expect(bootstrapResponse.ok()).toBe(true);
  const bootstrap = await bootstrapResponse.json() as ProductionBootstrap;
  const run = bootstrap.runs.find((candidate) => candidate.title === title);
  expect(run).toBeTruthy();
  expect(run!.productionIntent?.maxCostCny).toBe(0);
  for (const nodeId of ["source-packet", "claim-ledger", "cast-plan", "episode-blueprint", "showrunner-assembly", "release-editorial", "visual-pack", "voice-casting", "music-cue-sheet"]) {
    expect(run!.nodes.find((node) => node.id === nodeId)?.status, `${nodeId} should complete before paid voice generation`).toBe("succeeded");
  }
  expect(run!.executionReceipts.some((receipt) => receipt.errorMessage?.includes("节点执行超过"))).toBe(false);
  expect(run!.executionReceipts.every((receipt) => receipt.billing !== "metered" || receipt.actualCostCny === 0)).toBe(true);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.failedApiRequests).toEqual([]);
});

function observeRuntime(page: Page): { pageErrors: string[]; failedApiRequests: string[] } {
  const pageErrors: string[] = [];
  const failedApiRequests = new Map<Request, string>();
  const responseStatuses = new WeakMap<Request, number>();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const request = response.request();
    responseStatuses.set(request, response.status());
    const recorded = failedApiRequests.get(request);
    if (recorded?.endsWith(": net::ERR_ABORTED") && successfulReadAbort(request, response.status())) {
      failedApiRequests.delete(request);
    }
  });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.includes("/api/")) return;
    const failure = request.failure()?.errorText ?? "failed";
    if (failure === "net::ERR_ABORTED" && successfulReadAbort(request, responseStatuses.get(request))) return;
    failedApiRequests.set(request, `${request.method()} ${request.url()}: ${failure}`);
  });
  return {
    pageErrors,
    get failedApiRequests() { return [...failedApiRequests.values()]; },
  };
}

function successfulReadAbort(request: Request, status: number | undefined): boolean {
  return request.method() === "GET" && status !== undefined && status >= 200 && status < 300;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ProductionBootstrap {
  providers: Array<{ id: string }>;
  runs: Array<{
    id: string;
    title: string;
    productionIntent?: { maxCostCny: number };
    executionReceipts: Array<{ billing: string; actualCostCny?: number; errorMessage?: string }>;
    nodes: Array<{ id: string; label: string; status: string }>;
  }>;
}
