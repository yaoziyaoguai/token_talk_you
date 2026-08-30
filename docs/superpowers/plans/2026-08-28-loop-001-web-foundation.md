# Loop 001 Web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent, local-first Token Talk Web Studio that exposes series, Recipes, provider economics, episode nodes, artifact versions, stale propagation, and Loop evidence.

**Architecture:** A TypeScript pnpm workspace keeps podcast entities in `packages/domain`, run semantics and JSON persistence in `packages/workflow`, and the Fastify/React product surface in `apps/studio`. The browser consumes one typed bootstrap contract and edits artifacts through Fastify; the server owns persistence and downstream invalidation.

**Tech Stack:** TypeScript 5.9, pnpm, Zod 4, React 19, Vite 8, Fastify 5, Lucide React, Vitest 4, Testing Library, Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-08-28-token-talk-design.md`

## Global Constraints

- The browser-based Studio is the only user product; do not add a user-facing CLI.
- Do not import or copy VideoFactory packages or source files.
- On-air roles default to episode-level dynamic casting; recurring characters are optional Series policy.
- Provider data must distinguish cash price, free quota, commercial rights, attribution, consent requirements, and verification date.
- Paid execution requires authorization bound to exact input versions, provider/model, attempt count, and maximum cost.
- Store local data under ignored `workspace/`; commit schemas and seed fixtures, not runtime data.
- Write each behavior test first and observe the expected failure before implementation.

## File Structure

- `package.json`: workspace scripts and shared development dependencies.
- `pnpm-workspace.yaml`: workspace membership.
- `tsconfig.base.json`: strict TypeScript defaults and ESM settings.
- `.gitignore`: dependencies, builds, test output, and local workspace data.
- `packages/domain/src/model.ts`: Zod schemas and inferred domain types.
- `packages/domain/src/seed.ts`: two approved Recipes, initial providers, one Series, and Loop seed data.
- `packages/domain/src/index.ts`: public domain exports.
- `packages/domain/test/domain.test.ts`: dynamic casting, provider rights, Recipe, and seed invariants.
- `packages/workflow/src/run.ts`: artifact versioning and downstream stale propagation.
- `packages/workflow/src/repository.ts`: atomic JSON snapshot persistence.
- `packages/workflow/src/index.ts`: public workflow exports.
- `packages/workflow/test/run.test.ts`: version and invalidation behavior.
- `packages/workflow/test/repository.test.ts`: restart persistence behavior.
- `apps/studio/src/shared/api.ts`: browser/server request and response schemas.
- `apps/studio/src/server/studio-service.ts`: application composition and use cases.
- `apps/studio/src/server/create-server.ts`: Fastify routes.
- `apps/studio/src/server/main.ts`: Web server process entry.
- `apps/studio/src/client/api.ts`: typed browser client.
- `apps/studio/src/client/App.tsx`: operator shell and view routing.
- `apps/studio/src/client/components/TodayView.tsx`: inbox, active run, approval, and cost overview.
- `apps/studio/src/client/components/SeriesView.tsx`: Series Bible and dynamic Cast Policy view.
- `apps/studio/src/client/components/EpisodeStudio.tsx`: phase/node workspace and artifact inspector.
- `apps/studio/src/client/components/ProviderView.tsx`: capability, free quota, cost, and rights matrix.
- `apps/studio/src/client/styles.css`: responsive operational visual system.
- `apps/studio/test/server.test.ts`: API persistence and invalidation tests.
- `apps/studio/test/App.test.tsx`: operator navigation and visible state tests.
- `apps/studio/test/setup.ts`: DOM test setup.
- `apps/studio/e2e/studio.spec.ts`: desktop/mobile complete operator checks.
- `playwright.config.ts`: local Web test server and viewport projects.

---

### Task 1: Workspace And Podcast Domain

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/model.ts`
- Create: `packages/domain/src/seed.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/test/domain.test.ts`

**Interfaces:**
- Produces: `StudioSnapshotSchema`, `SeriesBibleSchema`, `ProductionRecipeSchema`, `ProviderProfileSchema`, `EngineeringLoopSchema`, and inferred TypeScript types.
- Produces: `createSeedSnapshot(now?: string): StudioSnapshot`.

- [ ] **Step 1: Add workspace configuration and install dependencies**

Create the root pnpm workspace with scripts:

```json
{
  "name": "token-talk",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm --filter @token-talk/studio dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:e2e": "playwright test"
  }
}
```

Install Zod plus the exact toolchain from the plan header. Add `workspace/`, `dist/`, `coverage/`, `playwright-report/`, and `test-results/` to `.gitignore`.

- [ ] **Step 2: Write the failing domain test**

```typescript
import { describe, expect, it } from "vitest";
import { createSeedSnapshot, ProviderProfileSchema, SeriesBibleSchema } from "../src/index.js";

describe("podcast domain", () => {
  it("defaults a series to episode-derived casting without a fixed cast", () => {
    const series = SeriesBibleSchema.parse({
      id: "series-1",
      title: "Token Talk 读书会",
      promise: "把一本书谈成值得继续追问的问题",
      audience: "希望深入理解一本书的中文听众",
      castPolicy: { mode: "dynamic" },
      sonicBible: { musicPolicy: "narrative", palette: ["prepared-piano"] },
      memory: [],
    });
    expect(series.castPolicy.mode).toBe("dynamic");
    expect(series.castPolicy.recurringRoleIds).toEqual([]);
  });

  it("does not treat a free quota as commercial permission", () => {
    const provider = ProviderProfileSchema.parse({
      id: "voice-free",
      capability: "voice.synthesize",
      label: "Free Voice",
      deployment: "external",
      billing: { type: "free", unit: "character", rate: 0, currency: "USD" },
      quota: { amount: 10000, unit: "character", renewal: "monthly" },
      rights: { commercialUse: "restricted", attributionRequired: true },
      verifiedAt: "2026-08-28",
      availability: { status: "needs_config", reason: "API key required" },
    });
    expect(provider.billing.type).toBe("free");
    expect(provider.rights.commercialUse).toBe("restricted");
  });

  it("seeds distinct rapid and deep-reading recipes", () => {
    const snapshot = createSeedSnapshot("2026-08-28T00:00:00.000Z");
    expect(snapshot.recipes.map((recipe) => recipe.id)).toEqual([
      "rapid-topic-v1",
      "deep-reading-v1",
    ]);
    expect(snapshot.recipes[0].targetMinutes).not.toEqual(snapshot.recipes[1].targetMinutes);
  });
});
```

- [ ] **Step 3: Run the domain test and verify RED**

Run: `pnpm --filter @token-talk/domain test`

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 4: Implement the domain schemas and seed**

Define strict Zod schemas for:

```typescript
type CastPolicy = {
  mode: "dynamic" | "recurring_with_guests" | "fixed";
  recurringRoleIds: string[];
  minSpeakers?: number;
  maxSpeakers?: number;
};

type ProviderRights = {
  commercialUse: "allowed" | "restricted" | "unknown";
  attributionRequired: boolean;
  licenseUrl?: string;
  voiceConsentRequired?: boolean;
};

type ProductionRecipe = {
  id: "rapid-topic-v1" | "deep-reading-v1" | string;
  label: string;
  contentProduct: "rapid" | "recurring" | "durable" | "custom";
  targetMinutes: { min: number; max: number };
  musicPolicy: "minimal" | "narrative" | "immersive";
  budgetPolicy: "local" | "economy" | "balanced" | "premium";
  capabilityIds: string[];
};
```

Seed both Recipes, one dynamic-cast book Series, dated provider profiles for local `say`, Alibaba Qwen TTS, Doubao TTS, ElevenLabs TTS, internal music, Stable Audio, Brave Search, and GPT Image, plus one active Loop record.

- [ ] **Step 5: Run the domain test and verify GREEN**

Run: `pnpm --filter @token-talk/domain test`

Expected: 3 tests pass.

- [ ] **Step 6: Commit the domain foundation**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .gitignore packages/domain
git commit -m "feat: define podcast domain and provider catalog"
```

### Task 2: Versioned Runs And Persistent Snapshot

**Files:**
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/run.ts`
- Create: `packages/workflow/src/repository.ts`
- Create: `packages/workflow/src/index.ts`
- Test: `packages/workflow/test/run.test.ts`
- Test: `packages/workflow/test/repository.test.ts`

**Interfaces:**
- Consumes: `StudioSnapshot`, `WorkflowRun`, `Artifact`, and schemas from `@token-talk/domain`.
- Produces: `reviseArtifact(run, artifactId, data, now): WorkflowRun`.
- Produces: `JsonStudioRepository.open(root, seedFactory)`, `load()`, and `save(snapshot)`.

- [ ] **Step 1: Write the failing stale-propagation test**

```typescript
it("marks every dependent node stale when a locked planning artifact changes", () => {
  const run = createSeedSnapshot(NOW).runs[0];
  const revised = reviseArtifact(run, "artifact-blueprint", { title: "新的节目蓝图" }, NOW_LATER);
  expect(revised.artifacts.find((item) => item.id === "artifact-blueprint")?.versions).toHaveLength(2);
  expect(revised.nodes.find((item) => item.id === "segment-room-1")?.status).toBe("stale");
  expect(revised.nodes.find((item) => item.id === "publish-package")?.status).toBe("stale");
  expect(revised.nodes.find((item) => item.id === "episode-blueprint")?.status).toBe("succeeded");
});
```

- [ ] **Step 2: Run the run test and verify RED**

Run: `pnpm --filter @token-talk/workflow test -- run.test.ts`

Expected: FAIL because `reviseArtifact` is missing.

- [ ] **Step 3: Implement immutable artifact revision and graph invalidation**

Create a new artifact version whose ID and SHA-256 are derived from canonical JSON. Keep prior versions. Starting from nodes whose `inputArtifactIds` contain the changed artifact, traverse their output artifacts and recursively mark dependent nodes `stale`. Do not mark the producer of the edited artifact stale.

- [ ] **Step 4: Run the run test and verify GREEN**

Run: `pnpm --filter @token-talk/workflow test -- run.test.ts`

Expected: stale propagation test passes.

- [ ] **Step 5: Write the failing restart-persistence test**

```typescript
it("reopens the most recently saved snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-talk-"));
  const first = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
  const snapshot = await first.load();
  snapshot.series[0].title = "重启后仍然存在";
  await first.save(snapshot);

  const reopened = await JsonStudioRepository.open(root, () => createSeedSnapshot(NOW));
  expect((await reopened.load()).series[0].title).toBe("重启后仍然存在");
});
```

- [ ] **Step 6: Run the repository test and verify RED**

Run: `pnpm --filter @token-talk/workflow test -- repository.test.ts`

Expected: FAIL because `JsonStudioRepository` is missing.

- [ ] **Step 7: Implement atomic JSON persistence**

Validate loaded and saved snapshots with `StudioSnapshotSchema`. Write `studio.json.tmp`, fsync/close it, then rename to `studio.json`. Seed only when no persisted snapshot exists.

- [ ] **Step 8: Run all workflow tests and verify GREEN**

Run: `pnpm --filter @token-talk/workflow test`

Expected: all workflow tests pass.

- [ ] **Step 9: Commit workflow semantics**

```bash
git add packages/workflow
git commit -m "feat: persist versioned podcast runs"
```

### Task 3: Studio Service And HTTP Contract

**Files:**
- Create: `apps/studio/package.json`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/tsconfig.client.json`
- Create: `apps/studio/tsconfig.server.json`
- Create: `apps/studio/src/shared/api.ts`
- Create: `apps/studio/src/server/studio-service.ts`
- Create: `apps/studio/src/server/create-server.ts`
- Create: `apps/studio/src/server/main.ts`
- Test: `apps/studio/test/server.test.ts`

**Interfaces:**
- Consumes: `JsonStudioRepository`, `reviseArtifact`, and domain schemas.
- Produces: `StudioBootstrapSchema`, `CreateSeriesInputSchema`, and `ReviseArtifactInputSchema`.
- Produces HTTP: `GET /api/bootstrap`, `POST /api/series`, `PUT /api/runs/:runId/artifacts/:artifactId`.

- [ ] **Step 1: Write the failing API test**

```typescript
it("persists a series and exposes stale downstream nodes after an artifact revision", async () => {
  const app = await createStudioServer({ workspaceRoot: root, now: () => NOW });
  const created = await app.inject({
    method: "POST",
    url: "/api/series",
    payload: {
      title: "今天值得谈",
      promise: "把热点变成有来有回的讨论",
      audience: "关注科技与文化的中文听众",
      castPolicy: { mode: "dynamic" },
      musicPolicy: "minimal",
    },
  });
  expect(created.statusCode).toBe(201);

  const revised = await app.inject({
    method: "PUT",
    url: "/api/runs/run-deep-reading/artifacts/artifact-blueprint",
    payload: { data: { title: "重新锁定的蓝图" } },
  });
  expect(revised.statusCode).toBe(200);
  expect(revised.json().nodes.find((node: { id: string }) => node.id === "publish-package").status).toBe("stale");

  const reopened = await createStudioServer({ workspaceRoot: root, now: () => NOW });
  const bootstrap = await reopened.inject({ method: "GET", url: "/api/bootstrap" });
  expect(bootstrap.json().series.some((series: { title: string }) => series.title === "今天值得谈")).toBe(true);
});
```

- [ ] **Step 2: Run the API test and verify RED**

Run: `pnpm --filter @token-talk/studio test -- server.test.ts`

Expected: FAIL because the server modules do not exist.

- [ ] **Step 3: Implement the service and routes**

`StudioService` owns repository loading/saving. Reject invalid payloads with status 400 and `{ code, message, issues }`. Return the complete validated bootstrap snapshot, the created Series Bible, or the revised Workflow Run. The route layer contains no domain policy.

- [ ] **Step 4: Run the API test and verify GREEN**

Run: `pnpm --filter @token-talk/studio test -- server.test.ts`

Expected: API test passes with no warning output.

- [ ] **Step 5: Commit the server surface**

```bash
git add apps/studio/package.json apps/studio/tsconfig*.json apps/studio/src/shared apps/studio/src/server apps/studio/test/server.test.ts
git commit -m "feat: expose Token Talk studio API"
```

### Task 4: Web Operator Shell

**Files:**
- Create: `apps/studio/index.html`
- Create: `apps/studio/vite.config.ts`
- Create: `apps/studio/src/client/main.tsx`
- Create: `apps/studio/src/client/api.ts`
- Create: `apps/studio/src/client/App.tsx`
- Create: `apps/studio/src/client/components/TodayView.tsx`
- Create: `apps/studio/src/client/components/SeriesView.tsx`
- Create: `apps/studio/src/client/components/ProviderView.tsx`
- Create: `apps/studio/src/client/styles.css`
- Create: `apps/studio/test/setup.ts`
- Test: `apps/studio/test/App.test.tsx`

**Interfaces:**
- Consumes: `StudioBootstrap` from `src/shared/api.ts`.
- Produces: `App({ initialData? })` with Today, Series, Episodes, and Providers navigation.
- Produces: `StudioApi.loadBootstrap()`.

- [ ] **Step 1: Write the failing operator-shell test**

```tsx
it("moves between the daily control surface, series policy, and provider economics", async () => {
  const user = userEvent.setup();
  render(<App initialData={createSeedSnapshot(NOW)} />);
  expect(screen.getByRole("heading", { name: "今日制作" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "系列" }));
  expect(screen.getByText("完全动态")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "能力与成本" }));
  expect(screen.getByText("商用受限")).toBeInTheDocument();
  expect(screen.getByText("免费额度不等于商用授权")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `pnpm --filter @token-talk/studio test -- App.test.tsx`

Expected: FAIL because `App` does not exist.

- [ ] **Step 3: Implement the operator shell**

Use a fixed-width icon rail on desktop and bottom navigation on mobile. Today is the initial screen and contains compact operational bands for active production, required decisions, Loop status, expected/authorized cost, and recent evidence. Series shows Cast Policy as dynamic, recurring-with-guests, or fixed without implying a global cast. Provider View is a dense comparison table with filters for capability and rights.

Use Lucide icons for navigation and action controls. Use white/near-white work surfaces, ink text, coral status emphasis, teal success, amber spend warnings, and limited blue for selected navigation. Cards use at most 8px radius and are reserved for repeated runs/providers; page sections remain unframed bands.

- [ ] **Step 4: Run the component test and verify GREEN**

Run: `pnpm --filter @token-talk/studio test -- App.test.tsx`

Expected: operator-shell test passes.

- [ ] **Step 5: Commit the Web shell**

```bash
git add apps/studio/index.html apps/studio/vite.config.ts apps/studio/src/client apps/studio/test/setup.ts apps/studio/test/App.test.tsx
git commit -m "feat: add Web production control surface"
```

### Task 5: Episode Node Workspace

**Files:**
- Create: `apps/studio/src/client/components/EpisodeStudio.tsx`
- Create: `apps/studio/src/client/components/NodeWorkspace.tsx`
- Modify: `apps/studio/src/client/App.tsx`
- Modify: `apps/studio/src/client/api.ts`
- Modify: `apps/studio/src/client/styles.css`
- Modify: `apps/studio/test/App.test.tsx`

**Interfaces:**
- Consumes: `WorkflowRun`, artifact versions, provider profiles, and `StudioApi.reviseArtifact()`.
- Produces: planning/production phase rail, selected node workspace, artifact history, cost/rights evidence, and stale labels.

- [ ] **Step 1: Add the failing node-workspace test**

```tsx
it("shows planning and production separately and explains stale output", async () => {
  const user = userEvent.setup();
  render(<App initialData={createSeedSnapshot(NOW)} />);
  await user.click(screen.getByRole("button", { name: "单集" }));
  expect(screen.getByRole("tab", { name: "策划 Run" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "制作 Run" })).toBeInTheDocument();

  await user.click(screen.getByText("发布包"));
  expect(screen.getByText("上游蓝图已更新，需要重新生成")).toBeInTheDocument();
  expect(screen.getByText("输入版本")).toBeInTheDocument();
  expect(screen.getByText("执行证据")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `pnpm --filter @token-talk/studio test -- App.test.tsx`

Expected: FAIL because the Episode Studio is absent.

- [ ] **Step 3: Implement the node workspace**

The desktop layout uses stable columns: 264px node rail, flexible artifact workspace, and 320px evidence inspector. The node rail groups planning and production nodes and never changes width with status labels. The workspace shows structured output, version history, and a revision action only for artifacts attached to the selected node. The inspector shows capability, logical production role, provider/model, input versions, cost estimate/authorization/actual, commercial rights, and receipt timestamps.

Mobile uses one column with a horizontal phase selector and a node drawer. Ensure all buttons retain stable dimensions and all long provider/license text wraps.

- [ ] **Step 4: Run component tests and verify GREEN**

Run: `pnpm --filter @token-talk/studio test -- App.test.tsx`

Expected: all component tests pass.

- [ ] **Step 5: Commit the Episode Studio**

```bash
git add apps/studio/src/client apps/studio/test/App.test.tsx
git commit -m "feat: add editable episode node workspace"
```

### Task 6: Browser Verification And Loop Evidence

**Files:**
- Create: `playwright.config.ts`
- Create: `apps/studio/e2e/studio.spec.ts`
- Create: `docs/loops/001-web-foundation.md`
- Modify: `package.json`
- Modify: `apps/studio/package.json`

**Interfaces:**
- Consumes: running Fastify/Vite Studio and seeded local snapshot.
- Produces: desktop/mobile screenshots and the completed Loop evidence record.

- [ ] **Step 1: Write the failing Playwright workflow**

```typescript
test("operator inspects a dynamic series, provider rights, and stale publish node", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日制作" })).toBeVisible();
  await page.getByRole("button", { name: "系列" }).click();
  await expect(page.getByText("完全动态")).toBeVisible();
  await page.getByRole("button", { name: "能力与成本" }).click();
  await expect(page.getByText("免费额度不等于商用授权")).toBeVisible();
  await page.getByRole("button", { name: "单集" }).click();
  await page.getByText("发布包").click();
  await expect(page.getByText("上游蓝图已更新，需要重新生成")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("studio.png"), fullPage: true });
});
```

- [ ] **Step 2: Run Playwright and verify RED**

Run: `pnpm test:e2e`

Expected: FAIL until the test server and browser configuration are complete.

- [ ] **Step 3: Configure desktop and mobile Web tests**

Configure Playwright projects at 1440x960 and 390x844. Start the Studio with a temporary `TOKEN_TALK_WORKSPACE` directory. Add screenshot assertions for non-overlapping navigation, node rail, workspace, and inspector. Use `view_image` to inspect both screenshots and correct visual defects before proceeding.

- [ ] **Step 4: Record Loop 001 evidence**

Create `docs/loops/001-web-foundation.md` with objective, success criteria, phase events, evidence commands, status, known limitations, and learnings. Do not mark it completed until every command below passes.

- [ ] **Step 5: Run complete verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
git diff --check
```

Expected: all commands exit 0, Vitest reports no failed tests, Vite/Fastify build succeeds, and both Playwright projects pass.

- [ ] **Step 6: Review against the specification**

Confirm the implementation has no user-facing CLI, no VideoFactory imports, dynamic casting as the default, dated provider rights/pricing metadata, persistent artifact versions, recursive stale propagation, visible cost authorization, desktop/mobile evidence, and a Loop learning entry. Fix every mismatch before committing.

- [ ] **Step 7: Commit verified Loop 001**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts apps/studio docs/loops/001-web-foundation.md
git commit -m "feat: complete Token Talk Web foundation loop"
```
