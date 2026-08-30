# Token Talk Provider And Cost Landscape

**Verified:** 2026-08-28
**Purpose:** Inform provider adapters, audio bake-offs, budget routing, and rights checks. Prices and quotas are volatile and must be represented as dated catalog data rather than permanent code constants.

## 1. Decision Summary

Token Talk should not choose one universal provider. It needs a capability catalog and a routing policy that separates:

- zero-cash local verification;
- economical Chinese production;
- balanced recurring production;
- premium expressive episodes;
- research-only candidates that cannot be shipped commercially.

The first implementation should support local deterministic substitutes for every paid capability and real adapters only where they materially improve a publishable episode. Provider selection remains an editorial decision until a controlled Chinese podcast bake-off produces evidence.

## 2. Voice Providers

| Provider | Current economics | Useful characteristics | Important constraints | Initial role |
|---|---|---|---|---|
| macOS `say` | Local, no API charge | Always-available chain verification on macOS | Not publication quality; limited performance control | Test fallback |
| Alibaba Qwen/CosyVoice API | Qwen3 TTS international prices are around CNY 0.95–1.00 per 10,000 input characters; China-region voice enrollment and voice design include limited introductory quotas | Chinese voice design, voice cloning, realtime and long-text options | Product, region, and model use different billing units; clone artifacts remain provider-bound | Economy/balanced bake-off |
| Volcengine Doubao Speech | Listed TTS price CNY 5 per 10,000 characters and voice clone synthesis CNY 8 per 10,000 characters; current free quotas list 5,000 TTS characters and 10 cloned voices | Chinese expressivity, emotion, voice replication, podcast-oriented products | Free quota is small; billing and voice-clone consent must be tracked separately | Balanced Chinese bake-off |
| Tencent Cloud TTS | One-time 8 million-character general-TTS trial package, valid three months; long-text API is excluded from that free package | Large evaluation quota and Chinese infrastructure | Trial is one-time, expires, and does not cover long-text synthesis | Economy evaluation |
| Google Cloud TTS | Standard: first 4M characters/month free then USD 4/M; WaveNet: first 1M free then USD 16/M | Broad voice/language catalog, SSML, long audio | Expressive podcast quality needs listening tests; billing counts submitted characters and markup | Economy baseline |
| Amazon Polly | Standard USD 4/M, Neural USD 16/M, Generative USD 30/M; introductory free tiers vary by voice class | Stable API, caching/replay, speech marks | Free tier duration and account eligibility matter; Chinese performance needs evaluation | Economy baseline |
| OpenAI GPT-4o Mini TTS | USD 0.60/M text input tokens and USD 12/M audio output tokens | Natural language performance instructions; simple API | 2,000-token input limit requires chunking; no API free tier | Balanced candidate |
| ElevenLabs | Flash/Conversational USD 0.05 per 1K characters; v3/Multilingual USD 0.10 per 1K; free account includes 10K characters | Expressive performance, audio tags, broad languages, voice design/cloning, long-form model | Free output is non-commercial with attribution; paid plan is required for commercial use | Premium candidate |

Primary sources: [Alibaba Model Studio pricing](https://help.aliyun.com/en/model-studio/model-pricing), [Volcengine Ark pricing](https://www.volcengine.com/product/ark), [Tencent Cloud free quota](https://cloud.tencent.com/document/product/1073/78325), [Google TTS pricing](https://cloud.google.com/text-to-speech/pricing/), [Amazon Polly pricing](https://aws.amazon.com/polly/pricing/), [OpenAI GPT-4o Mini TTS](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts), [ElevenLabs API pricing](https://elevenlabs.io/pricing/api), and [ElevenLabs commercial-use explanation](https://elevenlabs.io/docs/overview/capabilities/text-to-speech).

## 3. Local Voice Candidates

Local inference eliminates per-call cash cost but does not eliminate compute, operations, model-license, or voice-consent costs.

- **CosyVoice:** repository code carries Apache-2.0, making it a strong Chinese local candidate. Each exact downloaded model artifact still needs a recorded license check before publication. [Repository license](https://github.com/FunAudioLLM/CosyVoice/blob/main/LICENSE)
- **Kokoro 82M:** Apache-2.0 and lightweight, but the referenced model is English-focused, so it is useful for infrastructure experiments rather than the Chinese default. [Model card](https://huggingface.co/hexgrad/Kokoro-82M)
- **IndexTTS2:** permits broad use under its own license with additional licensing thresholds for very large businesses. It is a Chinese bake-off candidate, not an assumed unrestricted dependency. [Model license](https://github.com/index-tts/index-tts/blob/main/LICENSE)
- **F5-TTS:** code is MIT, but official pretrained weights are CC-BY-NC because of the training data. Those weights must not be used for a commercial Token Talk release. [Official repository](https://github.com/SWivid/F5-TTS)
- **Fish Speech:** the current public research license explicitly requires a separate agreement for commercial use, including internal business operations. [Current license](https://github.com/fishaudio/fish-speech/blob/main/LICENSE)

## 4. Music And Sound Providers

| Provider/source | Current economics | Rights posture | Initial role |
|---|---|---|---|
| Internal approved library | Local storage and editing only | Rights are known per asset | Default intros, stingers, beds, and recurring themes |
| Freesound API | API access with per-item Creative Commons metadata | Must filter and retain CC0/Attribution terms; NonCommercial assets cannot enter commercial packages | Sound effects and ambience |
| Eleven Music API | USD 0.15 per generated minute on current API pricing | Paid plans provide broad commercial use, subject to tier-specific exclusions | Premium bespoke cue candidate |
| Stability Stable Audio API | Stable Audio 3.0 costs 26 credits; one credit is USD 0.01 | Community license permits commercial use below the stated revenue threshold; Enterprise terms apply above it | Balanced generated cue candidate |
| Stable Audio local weights | Local compute | Same Stability license and registration/revenue conditions must be recorded | Optional local generated cues |
| MusicGen official weights | Local compute | CC-BY-NC 4.0 weights | Research only, never a commercial default |

Primary sources: [Freesound API](https://freesound.org/docs/api/), [Freesound license fields](https://freesound.org/docs/api/resources_apiv2.html?highlight=license), [Eleven Music API](https://elevenlabs.io/eleven-music-api), [ElevenLabs API pricing](https://elevenlabs.io/pricing/api), [Stability API pricing](https://platform.stability.ai/pricing), [Stability Community License](https://stability.ai/license), and [AudioCraft model-weight license](https://github.com/facebookresearch/audiocraft).

Music cost is driven by candidates, not only selected duration. A five-minute final underscore may require three ten-minute candidate generations and several audition mixes. Cost estimation must therefore use requested generation minutes and attempt count, not final timeline duration.

## 5. Research And Image Inputs

- Brave Search currently charges USD 5 per 1,000 search requests with USD 5 recurring monthly credit. The credit requires product attribution and payment details. [Brave Search API](https://brave.com/search/api/)
- Exa currently provides USD 10 recurring monthly credit; standard search is USD 7 per 1,000 requests and content retrieval is charged separately. [Exa pricing](https://exa.ai/pricing?tab=api)
- OpenAI GPT Image 1.5 lists 1024-square outputs from USD 0.009 low quality to USD 0.133 high quality. [OpenAI image pricing](https://developers.openai.com/api/docs/models/gpt-image-1.5)
- Stability API starts accounts with 25 credits and lists Stable Image Core at 3 credits, with one credit equal to USD 0.01. [Stability API pricing](https://platform.stability.ai/pricing)
- Volcengine currently lists Seedream images around CNY 0.20–0.25 each and model-specific free image quotas. [Volcengine Ark pricing](https://www.volcengine.com/product/ark)

Search snippets do not grant republication rights to source content. Token Talk stores citations and brief evidence extracts, not wholesale scraped articles.

## 6. Provider Catalog Contract

Every catalog entry needs these facts:

- capability and provider/model identity;
- local, subscription, free, or metered deployment;
- billing unit and provider-specific usage calculator;
- configured rate, currency, and `verifiedAt` timestamp;
- free-quota amount, scope, renewal, eligibility, and expiration;
- Chinese support, long-form behavior, performance controls, and known limits;
- commercial-use state, attribution requirement, license URL, and geographic constraints;
- voice-cloning support and consent requirements;
- data-retention notes and runtime requirements;
- current availability and reason when unavailable.

Rates must remain editable in the Web Studio because provider prices and quotas change. Free quota consumption is tracked separately from list price.

## 7. Budget Routing

Token Talk exposes four policies:

- `local`: no metered API calls; local research imports, local TTS candidates, internal music, FFmpeg, and local artwork substitutes;
- `economy`: free quota and low-cost providers, with no automatic paid fallback;
- `balanced`: economical defaults with selective premium voice, research, music, or artwork nodes;
- `premium`: best approved provider per capability within an explicit episode ceiling.

Each Episode Run has a cash ceiling and each metered node receives a spend authorization bound to:

- exact input artifact versions;
- provider and model;
- usage estimate and billing unit;
- maximum attempts;
- maximum authorized amount;
- expiration and approver.

Changing script text, voice, cue duration, candidate count, model, or attempt limit invalidates the authorization.

Execution receipts record estimates, actual provider-reported or configured-rate costs, failed metered attempts, free-quota consumption, and local compute time. The Cost Studio shows totals by episode, series, capability, provider, recipe, and successful publish minute.

## 8. Cost-Control Techniques

1. Generate planning and low-fidelity auditions with local or economical providers before premium rendering.
2. Lock script segments before TTS; regenerate only affected segments.
3. Cache TTS by normalized text, voice binding, performance direction, provider model, and seed.
4. Preserve provider-supported free regenerations only when the exact input contract qualifies.
5. Generate short music auditions before full cues.
6. Reuse approved series themes and stingers instead of generating them per episode.
7. Generate cover contact sheets at economical quality; render high quality only for selected directions.
8. Keep search query budgets and source caps per segment.
9. Display best-case, expected, and authorized-maximum episode costs before production.

## 9. Required Audio Bake-Off

No provider becomes a default from marketing claims. Token Talk will run a blind comparison using the same Chinese samples:

- neutral host introduction;
- excited but credible hot-topic opening;
- restrained emotional passage;
- skeptical interruption and follow-up;
- numbers, English terms, names, and difficult pronunciation;
- long paragraph and cross-chunk continuity;
- two roles with intentionally distinct tempo and stance.

For each provider/model/voice, capture cost, latency, retries, pronunciation failures, long-form drift, available controls, and rights status. Human reviewers score naturalness, intelligibility, role fit, emotional restraint, fatigue, and consistency. The winning route may differ by Recipe and role.
