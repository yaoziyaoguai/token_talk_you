# Token Talk UI System

## Product Context

Token Talk is an internal-first AI-native podcast production studio. The interface helps an editorial team discover topics, commission episodes, manage series, supervise research and production, review rights and cost, and learn from published work.

The first-screen memory should be: **this feels like a real podcast newsroom, not an AI model dashboard**.

## Aesthetic Direction

**Editorial broadcast console**: quiet, precise, and work-focused, with a small amount of live signal energy.

- Use strong editorial type hierarchy and disciplined alignment.
- Keep the working canvas light so scripts, evidence, and decisions remain readable.
- Use the dark navigation rail as the stable studio frame.
- Use color to communicate editorial action and production state, not decoration.
- Let waveform-like rhythm, cover art, and timed production states carry the podcast identity.

## Research Synthesis

- Riverside and Descript: borrow the persistent connection between speaker, transcript, waveform, and timeline. Audio should remain visible while the editor makes semantic decisions. Riverside explicitly couples speaker-colored transcripts, timeline editing, audio cleanup, and reusable intro/outro assets; Descript's 2026 Podcast Studio adds multitrack speech, music, and SFX around one transcript.
- Adobe Podcast: borrow source-aware multitrack thinking. Speech, music, ambience, and evidence are different production materials, not one opaque audio file. Its 2026 Studio update automatically synchronizes speaker tracks into one transcript while retaining independent track control.
- Wondercraft and ElevenLabs Studio: borrow the single-context relationship between script, assigned voices, music, sound effects, generation history, and timeline comments, while keeping editorial approval explicit. Individual paragraphs and clips must remain regenerable and lockable instead of forcing an entire episode rerun.
- Spotify for Creators: borrow the loop between episode performance and the next editorial decision. New versus returning listeners, retention, discovery source, comments, and above-baseline episodes should become series memory rather than a detached analytics dashboard.
- Ableton Live: borrow the sense of time continuity and launchable working states. A production action should visibly change the timeline or signal state.
- BoardUI and HeroUI: borrow information density, complete control states, and restrained application shells.
- beUI and Fluid Functionalism: motion must explain focus, progress, selection, playback, or state change.
- ThreeUI: do not use 3D in the primary workbench. Immersive rendering can later serve episode visuals or promotional experiences.

## Typography

- Latin and numbers: Manrope Variable, 200-800.
- Chinese: Noto Sans SC Variable, 100-900.
- Use tabular numerals for scores, time, cost, and progress.
- Page titles: 32-38px, 700-760 weight.
- Panel titles: 15-20px, 650-720 weight.
- Operational copy: 12-14px, generous line height.

## Color

- Ink: `#171B19`
- Navigation: `#111513`
- Canvas: `#F4F6F2`
- Surface: `#FFFFFF`
- Line: `#DDE2DC`
- Editorial signal: `#F05A3F`
- Production blue: `#316BE8`
- Approved green: `#23856D`
- Attention amber: `#8A5200`

Avoid gradients. Avoid single-hue screens. Warm red is for editorial commitment, blue for system action, green for verified or ready states, and amber for review or rights attention.

## Spacing

- Base unit: 4px.
- Main rhythm: 8, 12, 16, 24, 32, 48.
- Repeated work rows stay compact; page headers and major transitions get more air.
- Maximum card radius: 8px. Buttons and controls: 6px.

## Layout

- Desktop: fixed navigation rail plus a flexible editorial canvas.
- Topic desk: stable split view with a scannable candidate list and a detailed editorial decision pane.
- Episode studio: one continuous step rail and one main artifact workspace. Constraints, receipts, provider/model IDs, and version hashes stay in a collapsed production record.
- Mobile: bottom navigation, horizontal stage rail, and single-column detail views. The topic-entry tabs precede the compact signal monitor so a selectable hotspot remains visible in the first viewport.

## Motion

- Duration: 140-240ms.
- Easing: `cubic-bezier(.2,.8,.2,1)`.
- Hover movement is limited to 1-2px and never changes layout dimensions.
- Loading indicators, live signal waveforms, progress, selected rows, dialogs, and status transitions may animate.
- Continuous animation is reserved for an active listening, generation, rendering, or playback state. A decorative idle screen stays still.
- Motion never invents activity: the waveform becomes dynamic only while refreshing, AI editing, or playing audio.
- Respect `prefers-reduced-motion`.

## Decisions Log

- 2026-08-29: Chose an editorial production aesthetic instead of a generic SaaS dashboard.
- 2026-08-29: Kept Three.js out of the core workbench because the product is an operational tool, not an immersive showcase.
- 2026-08-29: Kept providers and models in advanced configuration; normal screens show editorial intent, quality, rights, time, and cost.
- 2026-08-29: Reframed the first screen as an on-air editorial console: live signal monitor, filtered candidate feed, editorial question, listener promise, evidence track, and an explicit adoption gate.
- 2026-08-29: Rejected marketing-page spectacle. Visual energy comes from real podcast materials and stateful motion rather than ornamental animation.
- 2026-08-29: Bound production motion to actual node execution. A running indicator must correspond to a persisted execution attempt and receipt.
- 2026-08-29: Added local multi-role table reads as a zero-cash preview, explicitly separated from release-ready voice, mix, and rights approval.
- 2026-08-29: Source health is editorial information. Ready, degraded, unavailable, and last-good fallback states must remain visible instead of being flattened into a model score.
- 2026-08-29: Made program artwork a first-viewport production signal. The current episode cover, persisted workflow progress, and next action share one functional "on deck" surface.
- 2026-08-29: Adopted a cultural-journal visual language for durable series: generated bitmap cover art, weight-driven editorial headlines, cobalt/coral/mint accents, and hard-edged print composition. The bundled Noto Sans SC font keeps line breaks deterministic across platforms.
- 2026-08-29: Series pages are commissioning surfaces, not settings pages. A series must expose its audience promise, cast policy, sonic palette, current production, and next episode proposals in one view.
- 2026-08-29: Category color may accelerate scanning, but never replace text labels or evidence. Continuous motion remains bound to collection, execution, or playback.
- 2026-08-29: Run labels must describe persisted truth: executing, waiting for editor, ready, blocked, or completed. Only executing states animate.
- 2026-08-29: Series art uses distinct editorial covers at 224px and 560px. Unknown series receive a deterministic multi-color fallback rather than one generic placeholder.
- 2026-08-29: Rebuilt the topic surface as an editorial signal room. Source health, raw discovery volume, platform coverage, cross-platform clustering, and research gates are visible before a candidate is adopted.
- 2026-08-29: Trend movement requires two persisted snapshots. A single snapshot may say a topic is currently ranked, but may never claim that it is rising or spreading.
- 2026-08-29: Trend snapshots are immutable and local. The Studio retains the latest 2,016 successful captures so a five-minute cadence has roughly seven days of rank history without unbounded disk growth.
- 2026-08-29: Motion follows podcast semantics: collection scan, candidate arrival, editorial selection, execution, rendering, or playback. Idle decoration remains still and reduced-motion disables transitions.
- 2026-08-29: Paid generation is authorized at the episode node, not in a provider dashboard. Authorization binds the current input versions, provider, model, exact estimated cash, one attempt, and a 30-minute window; unknown provider charges block further paid work until reconciled.
- 2026-08-30: Provider research and executable capability are different states. Qwen and Doubao remain visible for cost comparison but cannot be selected until an adapter exists; the current release path supports cross-platform zero-cash table reads and configured ElevenLabs v3 dialogue rendering.
- 2026-08-29: Long-form external dialogue is split below the provider's reliable request limit, but remains one persisted node attempt. Redirects are rejected, audio responses are bounded, cancellations propagate, and partial or ambiguous billing is never silently retried.
- 2026-08-29: Music enters through a rights-registered local library. Every asset stores a hash, decodable duration, mood, energy, optional BPM and tags, plus commercial-use basis and provenance before it can appear in a Cue.
- 2026-08-29: Each music Cue offers silence first. AI ranking may use mood, energy, series palette and exclusions; selections are editable but default to a zero-rights-risk silence plan so they never create a manual gate.
- 2026-08-29: Cue mixing uses bounded fades and records asset IDs. The resulting audio remains a preview until rights registration and automated release-audio checks pass.
- 2026-08-29: Reduced the product shell to three primary destinations: Topic, Production, and Shows. Voice and music are a secondary production resource, not a competing homepage workflow.
- 2026-08-29: Production is one visible editorial journey from commission to release. Internal planning/production phase boundaries no longer become user navigation.
- 2026-08-29: Technical metadata is evidence, not the product's first language. Provider/model identifiers, input hashes, receipts, structured JSON, and price comparisons remain available on demand but collapsed by default.
- 2026-08-29: Automated audio audit binds the active audio version and checks the release master, checksum, duration and transcript before a release package can be generated.
- 2026-08-29: Release media is a protected business action, not editable JSON. A master must be decodable, rights-confirmed and bound to current upstream versions; replacement invalidates the automated audio audit. A cover must be a decodable, opaque, square JPG/PNG with recorded commercial-use provenance.
- 2026-08-29: Episode artwork follows Apple Podcasts RSS interoperability constraints: 1400-3000px square JPG/PNG, with 3000px preferred and no alpha channel. See https://podcasters.apple.com/support/5516-episode-art-template.
- 2026-08-29: Legacy and current artifact identifiers map to one editorial vocabulary. Internal names such as `audio-master` and `visual-pack` never appear as normal workspace labels.
- 2026-08-29: The first screen is an operational editorial console, not a vanity dashboard. Its metrics come from persisted runs, action nodes, source captures, and adopted opportunities; fabricated weekly growth and decorative analytics are prohibited.
- 2026-08-29: Global search indexes real production records, episode candidates, series, and pending commissions. Selecting a result must open the corresponding workflow instead of acting as a visual-only command box.
- 2026-08-29: Recent production, connected episode stages, editor tasks, provider health, cash usage, and artwork share one first-viewport console. The candidate signal room remains the detailed commissioning surface directly below it.
- 2026-08-29: The first-viewport side rail prioritizes actionable editorial recommendations and persisted work over provider configuration. A recommendation must open the exact candidate or production node it names; model and price detail stays in the secondary resource view.
- 2026-08-29: Topic entry remains one three-way tab set, now framed as a single quick-start decision. It must not become three separate competing homepage workflows.
- 2026-08-29: A release package is a server-generated, immutable manifest, not a claim that an external platform was published. It locks master and cover checksums, transcript, chapters, source-verification tier, cast/voice/music disclosures, and the active automated audio-audit version; any upstream revision disables the previous download.
- 2026-08-29: Release chapters are rejected when their total duration differs from the registered master by more than 15% (with a 60-second floor). This keeps exported chapter metadata tied to the audio that the editor actually heard.
- 2026-08-29: The 60-second chapter tolerance only permits an unchaptered tail; no chapter may extend beyond the registered master. Replacing the master invalidates the previous automated audio audit and release package.
- 2026-08-29: External publication is an immutable ledger entry, not a manually toggled status. Every attempt binds the active release-package version and master/cover checksums; failures leave the episode release-ready, while the first verified public URL moves it to published and locks production assets. Additional platforms remain registerable against the same package.
- 2026-08-29: Hotspot collection belongs to the Studio server lifecycle, not to an open browser tab. The server collects on a five-minute cadence, coalesces overlapping requests, backs off after failures, and exposes its last successful snapshot; browsers poll only the local cache unless an editor explicitly requests a refresh.
- 2026-08-29: Production runs on Alibaba Cloud; local macOS is an implementation, test, and zero-cash preview environment. Production semantic nodes use a dedicated host Codex broker through a group-restricted Unix socket, never a local Ollama fallback hidden behind the same run.
- 2026-08-30: Public research has a separate machine-check tier: a source verifier pins HTTPS to a public DNS address, rejects redirects and oversized payloads, retains only page metadata plus a content fingerprint, and never claims editorial fact verification. Codex may create claims only with source IDs from this tier and must preserve a spoken qualifier.
- 2026-08-29: High-value semantic nodes use bounded Agent loops: a producer creates a candidate, deterministic checks run, an independent auditor emits structured findings, and a repair Agent creates a new version before re-audit. Producer and auditor never share a session, and unresolved critical findings block the node after the attempt cap.
- 2026-08-29: Human editing and human approval are separate concepts. Every creator-facing node may be edited at any time and a human version re-enters audit while invalidating dependent work; the only mandatory human approval is the exact-version, one-attempt spend gate immediately before release TTS.
- 2026-08-29: GitHub Actions verifies, builds, deploys, health-checks, and rolls back Token Talk, but it does not receive the host ChatGPT login. The cloud Codex identity remains isolated in a low-privilege systemd service, and the Web container can submit only allowlisted schema-bounded tasks.
- 2026-08-30: Long-form release copy is a first-class Agent node after script repair. Its title, summary, Show Notes, and keywords remain directly editable and become versioned inputs to the immutable release package.
- 2026-08-30: Release-master QC measures the complete file with FFmpeg EBU R128/loudnorm. Automated audio audit enforces Apple-compatible `-16 ±1 LUFS` integrated loudness and a `-1 dBTP` true-peak ceiling in addition to duration, checksum, rights, and transcript checks.
- 2026-08-30: Release packages contain Podcasting 2.0 JSON Chapters 1.2 data and expose a CORS-enabled `application/json+chapters` endpoint. WebVTT stays marked `requires_forced_alignment` until real final-master alignment exists; estimated timestamps are not treated as accessibility output.
- 2026-08-30: Episode artwork defaults to an image-only editorial subject without baked-in title or logo. Platform UI carries title typography, while registered artwork retains alt text, rights, dimensions, and checksum.
- 2026-08-31: An Agent Loop is a persisted server-owned job; the browser starts or observes it but does not own its lifetime. Refreshes, closed tabs, and transient network failures must not duplicate work. Status and the currently executing node are persisted, monotonic, and uncached; one Studio queue serializes cloud Codex use, and a restart during node execution blocks the job for receipt and cost reconciliation instead of retrying an ambiguous result. A free research deadline may be retried within its infrastructure cap, but it must not invoke or consume a semantic repair round.
