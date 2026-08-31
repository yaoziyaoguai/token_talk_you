# Loop 002: Cloud Codex Agent Runtime

- Date: 2026-08-29
- Status: deployment authorized; cloud ship and end-to-end verification in progress
- Branch: `codex/token-talk-loop`
- Objective: make the Alibaba Cloud deployment the production runtime for Token Talk, with Codex-backed semantic nodes, bounded autonomous audit-and-repair loops, editable node versions, and one mandatory human gate before paid TTS.

## Production Boundary

- Local macOS is for implementation, automated tests, browser dogfood, and zero-cash audio previews.
- The production Web Studio, workflow state, media workspace, schedulers, and Codex task execution run on Alibaba Cloud.
- Production semantic work uses a dedicated Token Talk Codex broker on the host. The Web container reaches it only through a Unix socket and a fixed task allowlist.
- The broker reuses the host's authenticated Codex CLI runtime, but has its own socket, task protocol, workspace, queue, timeout, and systemd service.
- GitHub Actions verifies and deploys application code. It does not copy ChatGPT credentials and does not require Codex for a normal deployment.

## Agent Loop

Selected semantic nodes run a bounded loop:

1. A producer Agent creates a schema-constrained candidate.
2. Deterministic validators reject malformed, ungrounded, incomplete, over-budget, or unsafe output.
3. An independent auditor Agent returns structured findings without inheriting the producer's session.
4. A repair Agent receives only the candidate, accepted evidence, and findings, then creates a new version.
5. The auditor runs again until the node passes or reaches its configured attempt limit.

Every attempt persists the effective input versions, output version, task kind, prompt version, provider/model identity, findings, timestamps, stop reason, and cost class. The loop never retries an ambiguous paid call.

The Web request does not own the loop lifetime. Starting a loop creates a persisted server job with an idempotency key; browsers poll monotonic, `no-store` job state and may reconnect from another tab or after refresh. Studio serializes all jobs through one host-Codex queue. If the service restarts while a node receipt is still running, the node and every active or queued job for that episode stop at `interrupted_execution` for reconciliation instead of continuing from uncertain state.

## Human Interaction

- Every creator-facing node remains editable at any time.
- A human edit creates a new immutable `human` version, re-runs the node audit, and marks dependent outputs stale.
- Autonomous nodes do not stop for routine editorial review. Unresolved findings accumulate as blockers for the final lock.
- The only mandatory human gate is the release TTS lock: review and edit the final script, cast, pronunciation, music direction, rights, residual findings, and exact estimated TTS cost, then authorize one paid generation attempt.
- TTS output continues through deterministic media checks and an automated audio audit. No second routine approval is inserted unless a check fails.

## Verified Cloud Facts

Read-only inspection of the `aliyun` host confirmed:

- Ubuntu Linux with Docker 29 and systemd 249.
- The existing VideoFactory broker runs as `vf-codex`, communicates through a group-restricted Unix socket, and reports a healthy bounded queue.
- The service uses Codex CLI `0.149.1`, authenticated with ChatGPT, `high` reasoning effort, concurrency 1, and a 285-second task timeout.
- Token Talk keeps the same single-task host boundary but gives each schema-bounded Codex task up to 720 seconds so long-form research, script generation, and independent audits do not fail at the former VideoFactory-sized timeout.
- The host has about 7.1 GiB RAM and 5.9 GiB free on a 40 GiB root volume. Token Talk must bound broker concurrency, image size, task scratch data, media retention, and Docker layers.

## Success Criteria

- [x] A Token Talk broker accepts only versioned, schema-bounded podcast task kinds over a group-restricted Unix socket.
- [x] Broker prompts, output schemas, model settings, and tool policy are server-owned; task payloads cannot inject CLI flags or arbitrary system prompts.
- [x] Studio can discover broker health and run at least cast, blueprint, segmented script, script audit/repair, music direction, cover brief, and release copy tasks through it.
- [x] At least the long-script path demonstrates an independent Agent audit, automatic repair, bounded stopping, and persisted findings.
- [x] Every creator-facing node exposes meaningful editable input/output fields and immutable generated/human/audited versions.
- [x] Human edits invalidate only dependent work and automatically re-enter validation/audit without requiring a separate approval click.
- [x] The workflow has exactly one mandatory human spend gate before release TTS, bound to exact script, voice, rights, provider, model, estimate, and one attempt.
- [x] TTS, FFmpeg/ffprobe checks, loudness, duration, hashes, rights completeness, and release checks remain deterministic where possible.
- [x] Docker, systemd, Nginx, backup, retention, health check, GitHub Actions deployment, and rollback assets are tested locally without reading production secrets.
- [ ] After explicit production-change approval, GitHub Actions deploys to Alibaba Cloud and a real cloud Codex task is verified end to end from the Web workflow.

## Stop Conditions

- Never deploy or mutate the production host without an explicit production-change approval.
- Never send paid TTS before the bound one-attempt authorization exists.
- Never silently replace an unavailable cloud Codex task with a local model in an existing production run.
- Never let an audit loop exceed its task-specific attempt cap or reuse the producer session as the auditor.
- Never mark a node passed when deterministic validation or a critical audit finding remains unresolved.

## Loop Events

| Phase | Status | Evidence |
| --- | --- | --- |
| discover | completed | VideoFactory graph/query, broker and deployment review, read-only Alibaba Cloud runtime inspection |
| plan | completed | This loop contract and the architecture decisions in `DESIGN.md` |
| implement | completed locally | Token Talk broker, Agent loop, editable versions, TTS lock, release editorial, Podcasting 2.0 package, loudness QC, and deployment assets |
| verify | completed locally | 290 unit/integration tests, 4 desktop/mobile E2E tests, typecheck, production build, Compose validation and bundle smoke passed; the hardened Linux image built and ran as non-root with a read-only root filesystem; eSpeak NG generated Mandarin audio and FFmpeg/ffprobe produced and measured AAC/M4A output |
| review | completed locally | Real 30-minute Codex episode path, browser visual audit at 1440 and 390 px, code boundary review, shell syntax, YAML and deployment configuration checks |
| ship | in progress | Production change is authorized; GitHub Actions deployment, public health checks and zero-cash cloud Agent Loop evidence remain required |
| learn | completed locally | Long-form role mapping, release standards, provider constraints, real-run findings and operating limits recorded in design and research notes |

## Local Verification

- `pnpm test`: 290 tests passed across Agent protocol, domain, workflow, broker and Studio.
- `pnpm typecheck && pnpm build`: passed; the browser bundle no longer imports Node-only crypto code.
- `pnpm test:e2e`: four desktop/mobile workflow and locked-chapter cases passed.
- `bash scripts/smoke-production-build.sh`: production bundle, health endpoint, SPA fallback and forged Host rejection passed.
- `docker-compose ... config`: production Compose configuration parsed successfully without reading production secrets.
- `docker build`: passed with the Alibaba Cloud Debian mirror, including the production image health check and the Linux Mandarin table-read media chain.
