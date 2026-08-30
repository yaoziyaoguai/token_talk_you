# Token Talk Design

**Date:** 2026-08-28
**Status:** Approved for implementation
**Product surface:** Web Studio only

## 1. Product Definition

Token Talk is an AI-native podcast Creative OS used to create and operate a portfolio of real, recurring shows. It is not a text-to-speech wrapper and it is not an audio adaptation of VideoFactory.

The factory must support content with different lifecycles through explicit Production Recipes:

- fast-moving episodes built from current topics;
- recurring editorial series with a stable promise and cast;
- durable book and research programs;
- later, custom or commissioned productions.

Every publishable episode must be traceable from editorial intent and sources through cast, script, audio, music, artwork, review, and distribution artifacts.

## 2. Product Principles

1. **Shows before automation.** Automation is valuable only when it produces programs people would choose to follow.
2. **Podcast-native production.** Dialogue, listening attention, emotional pacing, silence, voice consistency, and series memory are first-class domain concerns.
3. **Factory and portfolio are one system.** The factory operates multiple shows; a show is not a one-off generation preset.
4. **Human editorial control.** AI proposes and produces, while humans can edit, lock, reject, regenerate, and approve at meaningful boundaries.
5. **Evidence before fluency.** Factual claims retain source links and review status even after they become natural dialogue.
6. **Audio is authored.** Music and sound are directed through a cue system, not attached as a final generic background track.
7. **Web is the product.** The operator experience is a browser-based Studio. Maintenance scripts may exist, but there is no parallel user-facing CLI.
8. **Free is a rights-and-quota state, not a price label.** A provider is usable only when its commercial terms, attribution, quota lifecycle, and voice consent are known.

## 3. Scope Boundaries

### In scope

- series and Production Recipe management;
- topic inbox and opportunity adoption;
- source-grounded episode planning;
- recipe-selected production capabilities and dynamic on-air casting;
- long-form segment planning and composition;
- editable run nodes with immutable execution evidence;
- voice, music cue, mix, and audio quality workflows;
- show and episode artwork artifacts;
- publish packages and learning records;
- a local-first Web Studio for operating the system.

### Out of scope for the first vertical slice

- automatic publishing to third-party platforms;
- multi-user permissions and cloud tenancy;
- a public creator SaaS offering;
- live call-in or real-time interactive podcasting;
- training proprietary foundation models;
- copying VideoFactory's video scene, asset, render, or visual-review graph.

## 4. What VideoFactory Contributes

VideoFactory is prior art for engineering discipline, not a source architecture to copy wholesale.

### Concepts that may be re-derived

- engineering loops with objective, success criteria, evidence, status, and learnings;
- runs composed of explicit nodes;
- versioned inputs and outputs;
- artifacts with provenance and hashes;
- human interventions and downstream invalidation;
- provider-independent execution receipts;
- spend authorization for paid work;
- node-level structured editing and regeneration.

### Concepts that must be replaced

- short-video script and shot assumptions;
- visual grammar, scene assets, frame review, and video rendering nodes;
- platform-specific trend and publishing logic;
- a single short script as the central production artifact;
- UI structures organized around previewing vertical video.

Token Talk owns a clean podcast domain and does not import VideoFactory packages.

## 5. Domain Model

### Editorial portfolio

- `ContentProduct`: lifecycle and business intent, such as rapid, recurring, durable, or custom.
- `ProductionRecipe`: versioned workflow policy, quality gates, budget, freshness, music policy, and provider preferences.
- `SeriesBible`: audience, promise, editorial pillars, format, cast pool, source policy, sonic identity, visual identity, and memory.
- `EpisodeOpportunity`: a candidate topic with origin, urgency, relevance, evidence readiness, and editorial decision.
- `EpisodeBrief`: the adopted editorial contract for one episode.

### Dynamic role orchestration

Production and performance are separate concerns, but neither is a fixed global cast.

`ProductionCapability` describes work the factory can perform, such as editing, research, casting, episode architecture, Showrunner assembly, fact checking, voice direction, music direction, visual editing, or publishing. A Production Recipe selects only the capabilities needed for that program format and may bind different Agent implementations to them.

`CastPolicy` belongs to a Series Bible or Production Recipe. It can require a recurring host, prefer continuity when suitable, permit a fully episode-specific cast, or constrain the number and types of speakers. A series may therefore have fixed characters, a mixed recurring/guest model, or no fixed characters at all.

`OnAirRole` is proposed for a specific episode from its topic, format, audience, evidence, and desired conversational dynamics. It includes editorial function, position, knowledge boundary, speaking rhythm, vocabulary, conversational habits, relationship to other speakers, prohibited behavior, and performance direction. It becomes a reusable series character only after an explicit editorial decision.

`CastPlan` records how many speakers the episode needs, which roles appear, why each was selected, their function in each segment, the intended agreement or tension between them, and whether any role comes from series continuity.

### Knowledge and long-form structure

- `SourcePacket`: normalized sources with origin, date, excerpts, trust notes, and usage constraints.
- `ClaimLedger`: factual claims, supporting or contradicting sources, confidence, review state, and script references.
- `EpisodeBlueprint`: hook, promise, emotional arc, chapters, segments, cast participation, claims, and target duration.
- `Segment`: an independently researchable, writable, reviewable unit.
- `EpisodeScript`: the Showrunner-composed whole, preserving segment lineage.
- `SeriesMemory`: prior claims, recurring positions, callbacks, unresolved questions, and optional recurring-character development.

### Audio and visual production

- `VoiceProfile`: provider-independent performance direction plus provider-specific bindings.
- `SonicBible`: series theme, instrument palette, sound texture, music policy, recurring motifs, and exclusions.
- `EmotionalArc`: time-ordered narrative energy and emotion targets.
- `MusicCue`: purpose, placement, duration, mood, energy, loop behavior, dialogue constraints, and silence alternative.
- `MusicCandidate`: licensed or generated candidate with audio features, provenance, and rights metadata.
- `AuditionMix`: comparable render of the same dialogue with one candidate or silence.
- `AudioTimeline`: dialogue, music, ambience, sound effects, fades, ducking, and automation decisions.
- `AudioMaster`: final render plus technical review report.
- `VisualIdentity`: series-level visual rules.
- `VisualPack`: show cover, episode cover, chapter cards, and social excerpts.
- `MusicRightsLedger`: source, license, generator, prompt, version, and allowed usage for every selected cue.
- `PublishPackage`: audio, artwork, title, description, show notes, citations, transcript, chapters, disclosures, and rights ledger.

## 6. Production Architecture

### Phase A: Editorial Planning Run

The planning run is a stable graph:

1. `episode-brief`
2. `research-plan`
3. `source-packet`
4. `claim-ledger`
5. `cast-plan`
6. `episode-blueprint`
7. `emotional-arc`
8. `planning-review`

The operator edits and locks the planning outputs. A locked blueprint determines the production graph; changing it invalidates dependent production artifacts.

### Phase B: Production Run

The production run is created from the locked blueprint:

1. one `segment-room` per segment, executable in parallel;
2. `showrunner-assembly`;
3. `fact-review`;
4. `continuity-review`;
5. `dialogue-performance-plan`;
6. `release-editorial` for title, summary, Show Notes, and keywords;
7. `voice-render`;
8. `music-cue-sheet`;
9. `music-candidates` and `audition-mixes`;
10. `music-director-review`;
11. `audio-mix`;
12. `audio-technical-review` with full-master loudness and true-peak measurement;
13. `visual-pack`;
14. `audio-audit`;
15. `publish-package` with Podcasting 2.0 chapter data.

The initial implementation uses two explicit runs instead of a dynamic DAG. This preserves segment-level editability and parallelism without requiring a general workflow engine to mutate its graph while running.

## 7. Music Direction

Music policy belongs to the Production Recipe and can be:

- `minimal`: intro, outro, and transitions only;
- `narrative`: cue-based underscore around selected beats;
- `immersive`: sustained adaptive beds where editorially justified.

Music selection starts from a cue brief rather than a track search. Candidates pass deterministic filters for provenance, allowed use, duration, loopability, vocal presence, and dialogue interference. Semantic ranking may then consider mood, energy, instrumentation, pace, and series identity.

The Studio presents A/B/C audition mixes and a silence option against the same dialogue excerpt. The system defaults to silence or rights-registered assets; an editor may replace or remove each cue without becoming a mandatory gate. Dialogue remains primary; mixing applies configurable ducking, fades, and technical quality checks.

## 8. Web Studio

The Web Studio is an operational application, not a landing page. Its first-level navigation is:

- `Today`: editorial inbox, active runs, approvals, failures, and spend decisions;
- `Series`: Series Bibles, optional cast policy and recurring characters, sonic identity, visual identity, and memory;
- `Episodes`: opportunities, briefs, planning runs, and production runs;
- `Studio`: node workspace, structured inputs and outputs, evidence, regeneration, and stale-state handling;
- `Audio`: script, cast lanes, waveform timeline, music cues, audition mixes, and automated audio audit;
- `Assets`: covers, chapter cards, transcripts, and publish packages;
- `Settings`: providers, models, voices, music sources, budget, and local capabilities.

The first vertical slice implements a focused operator shell containing Today, Series, Episodes, and a unified Episode Studio. Audio and evidence views are embedded in the Episode Studio before becoming separate advanced workspaces.

## 9. Technical Shape

- TypeScript-first control plane.
- React and Vite for the browser Studio.
- Fastify for local HTTP APIs and static application serving.
- Zod schemas at persistence, API, provider, and artifact boundaries.
- Local versioned JSON records and content-addressed artifact files for the first vertical slice.
- Provider interfaces for research, language generation, TTS, music retrieval/generation, image generation, and audio review.
- FFmpeg-backed audio assembly behind an `AudioRenderer` boundary.
- Vitest for domain, workflow, API, and component tests.
- Playwright for the first complete Web workflow and responsive visual verification.

The project starts as a small pnpm workspace with focused packages rather than a framework-heavy platform:

- `apps/studio`: React client, Fastify server, and HTTP contracts;
- `packages/domain`: podcast entities, schemas, and editorial policies;
- `packages/workflow`: run semantics, artifact lineage, and node execution;
- `packages/audio`: cue planning contracts and FFmpeg rendering boundary.

## 10. Capability Catalog And Cost Control

Token Talk maintains a dated `CapabilityCatalog` instead of hardcoding one vendor per node. Capabilities include research search and retrieval, editorial reasoning, structured writing, TTS, voice design or cloning, music retrieval or generation, sound effects, image generation, transcription, audio rendering, and audio review.

Each `ProviderProfile` records capability, model, availability, deployment kind, billing unit, current configured rate, free-quota lifecycle, languages, long-form limits, performance controls, latency, commercial-use status, attribution, license URL, voice-consent requirements, data handling, runtime requirements, and `verifiedAt`.

Providers use their own usage calculators. Token Talk must not assume that all Chinese characters, punctuation, SSML, audio minutes, or failed attempts are billed identically.

The Web Studio offers `local`, `economy`, `balanced`, and `premium` routing policies. A Recipe provides defaults, while an Episode Brief can set a stricter cash ceiling. Paid nodes require a `SpendAuthorization` bound to exact input versions, provider, model, usage estimate, attempt limit, and maximum amount. Any relevant change invalidates that authorization.

Every attempt produces an `ExecutionReceipt` containing estimated cost, authorized maximum, actual provider-reported or configured-rate cost, billing unit, free-quota consumption, failed metered attempts, and local compute time. Cost views group spend by episode, series, capability, provider, Recipe, and successful publish minute.

Local and free candidates remain subject to license checks. The initial provider shortlist and its verified 2026-08-28 economics are recorded in [`docs/research/2026-08-28-provider-cost-landscape.md`](../../research/2026-08-28-provider-cost-landscape.md).

## 11. Loop Engineering

Every loop records:

- `objective`;
- observable `successCriteria`;
- phase events for `discover`, `plan`, `implement`, `verify`, `review`, `ship`, and `learn`;
- evidence references to tests, screenshots, artifacts, or exported packages;
- `active`, `completed`, `blocked`, or `skipped` status.

Loop records are visible inside the Web Studio. There is no user-facing loop CLI.

### Planned loops

1. `loop-000-architecture-transfer`: approved design, implementation plan, and explicit VideoFactory reuse/reject matrix.
2. `loop-001-web-foundation`: persistent domain records, Web shell, series setup, and visible loop evidence.
3. `loop-002-editorial-os`: topic inbox through adopted Episode Brief.
4. `loop-003-podcast-intelligence`: sources, claims, cast, blueprint, and planning lock.
5. `loop-004-longform-script-room`: segment production, Showrunner assembly, fact and continuity review.
6. `loop-005-audio-visual-studio`: voices, cue sheet, audition selection, mix, QC, and visual pack.
7. `loop-006-publish-and-learn`: final review, publish package, and feedback into Recipe and Series Memory.

## 12. First End-to-End Acceptance

The system is not considered end-to-end until the Web Studio can produce and inspect both:

1. a `rapid-topic-v1` episode targeting 8–12 minutes with freshness and source-quality gates;
2. a `deep-reading-v1` episode targeting 30–45 minutes with multiple segments, a topic-derived Cast Plan, series memory, claims, cue-based music direction, and chapter artifacts. Recurring characters are required only when the selected Series Bible asks for them.

For both samples, an operator must be able to:

- see every production node and its status;
- inspect and edit structured inputs and outputs;
- verify sources and claim references;
- understand why the cast and music were selected;
- inspect the estimated, authorized, and actual cost of each metered attempt;
- see whether every voice, music, and sound artifact is cleared for the intended use;
- audition or remove music cues;
- regenerate a segment without regenerating unrelated work;
- inspect the automated audio-audit result and rerun it after any master replacement;
- export a publish package with audio, artwork, transcript, chapters, citations, disclosures, and rights metadata.

## 13. Loop 001 Success Criteria

The first implementation loop is complete only when:

- the Web Studio starts locally and exposes no user-facing CLI workflow;
- an operator can create and reopen a Series Bible;
- the two initial Production Recipes are visible and distinct;
- the Capability Catalog distinguishes local, free-quota, subscription, and metered providers with dated rights and pricing metadata;
- an Episode Run shows expected and authorized-maximum cost before any metered execution;
- an example episode exposes planning and production phases as node workspaces;
- run events, artifacts, versions, and evidence survive a server restart;
- changing a locked planning artifact marks dependent outputs stale;
- automated domain, API, and Web component tests pass;
- Playwright screenshots show a usable desktop and mobile operator workflow without overlapping content;
- the loop record contains verification evidence and a short learning entry.
