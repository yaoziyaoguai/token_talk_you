# Loop 001: Token Talk Web Foundation

- Date: 2026-08-28
- Status: completed
- Branch: `codex/loop-000-token-talk-foundation`
- Objective: establish a persistent, traceable Web production foundation for a podcast-native AI studio.

## Success Criteria

- [x] Series, Production Recipe, Provider, Run, Node, Artifact Version, cost, and rights metadata are inspectable in Web Studio.
- [x] Series casting defaults to episode-derived dynamic roles; recurring and fixed casts remain explicit optional policies.
- [x] Planning and production are separate Run views, with long-form work decomposed into inspectable nodes.
- [x] Revising a planning artifact creates an immutable version and recursively marks dependent production nodes stale while preserving the exact input versions previously consumed.
- [x] Provider free quota, commercial rights, consent requirements, estimated cost, authorization, actual cost, and receipts are separate concepts.
- [x] Desktop and mobile browser workflows show stale reasons, input versions, and execution evidence without horizontal overflow.
- [x] The user-facing product is Web-only; no Token Talk CLI was added.

## Loop Events

| Phase | Result | Evidence |
| --- | --- | --- |
| discover | Completed | VideoFactory architecture review, podcast workflow analysis, and dated provider research |
| plan | Completed | `docs/superpowers/plans/2026-08-28-loop-001-web-foundation.md` |
| implement | Completed | Domain schemas, JSON repository, stale propagation, Fastify API, and React Studio |
| verify | Completed | 13 Vitest tests, 2 Playwright projects, typecheck, and production build |
| review | Completed | Specification boundary and visual evidence review at 1440x960 and 390x844 |
| ship | Completed | Local Web Studio on `http://127.0.0.1:4310` |
| learn | Completed | Findings below captured for the next production loop |

## Verification

All commands exited 0 after Vitest was configured to keep Playwright specifications outside its test boundary.

```text
pnpm typecheck
pnpm test          # 5 files, 13 tests passed
pnpm build         # Vite production client built; all package checks passed
pnpm test:e2e      # desktop and mobile projects passed
git diff --check
```

The browser test changes the episode blueprint through the real API, reloads the persisted snapshot, and then confirms the publish node shows `上游蓝图已更新，需要重新生成`. It also checks that the document has no horizontal overflow, the desktop columns do not overlap, and the mobile navigation reaches the bottom of its viewport.

## Scope Review

- No code or runtime dependency was copied from VideoFactory. Token Talk retained only useful architectural ideas: versioned runs, nodes, artifacts, provenance, bounded spend gates, and Loop evidence.
- The workflow is podcast-specific: source and claim ledgers, dynamic casting, episode blueprint, emotional arc, segmented writing, showrunner assembly, music cue sheet, audio mix, visual pack, automated audio audit, and publish package.
- Provider records are dated and model cost, free quota, commercial rights, attribution, and voice consent independently. A free quota never implies permission to publish commercially.
- The Studio uses real SHA-256 content hashes, exact consumed input-version references, local JSON persistence, and atomic replacement. It does not read secrets and no paid external call is executed in this loop.

## Known Limitations

Loop 001 is the production control foundation, not a complete episode renderer. Search, LLM writing, TTS, music generation/retrieval, cover generation, audio mixing, RSS publishing, spend authorization actions, and Execution Receipt creation still need real adapters and integration tests. Provider prices and terms are snapshots and must be reverified before external calls or commercial release.

## Learnings

1. Long-form podcast generation should lock and version intermediate editorial decisions instead of asking one model to generate an entire episode in one pass.
2. A Series may create continuity, but its cast policy cannot silently force every episode into the same number or type of speakers.
3. Music is an editorial system: Sonic Bible, emotional arc, cue sheet, audition alternatives, silence, and a rights ledger belong in the graph before audio rendering.
4. Cost control must bind authorization to exact input versions, provider/model choices, attempts, and a maximum amount; estimates and actual receipts remain separate.
5. Web readiness must include the API endpoint. Waiting only for the Vite page allowed the client to race the Fastify process during browser tests.
