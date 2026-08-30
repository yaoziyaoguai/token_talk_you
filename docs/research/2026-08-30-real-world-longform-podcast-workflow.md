# Token Talk 长篇播客现实工作流映射

## 结论

Token Talk 不是把一段提示词直接送进 TTS。15–60 分钟乃至更长的节目，需要把编辑部、研究室、编剧室、声音后期和发行台的职责变成可追溯节点。Agent 负责产出和返修，确定性程序负责协议、时长、权利、成本和媒体检测；只有真实付费 TTS 前保留一次人工授权，但任何产物都可由人编辑并生成新版本。

这套结构借鉴 VideoFactory 的节点化、版本化、审计和部署思路，不复制视频分镜、镜头或成片逻辑。

## 现实职责与产品节点

| 现实职责 | Token Talk 节点 | 交付物 | 独立检查 |
| --- | --- | --- | --- |
| 总编 / Commissioning Editor | 选题机会 | 中心问题、听众承诺、立项理由 | 热点与耐用品分别评分 |
| 研究策划 | 研究检索计划 | 检索式、来源类型、证据缺口 | 查询数量和范围协议 |
| 助理制作人 | 前采与资料包 | 论文、图书、一手材料、Web 来源 | URL、元数据、独立来源去重 |
| 事实编辑 | 事实账本 | 可播 claim、限定语、来源引用 | 来源 ID 必须来自已核验资料包 |
| 独立事实审计 | 证据审计 | grounding、coverage、scope findings | Agent 隔离审计，失败后自动定向返修 |
| 选角导演 | 本期角色编排 | 动态角色、认知职责、说话方式、声音方向 | 系列固定角色不可被单集 Agent 篡改 |
| 节目制作人 / Story Editor | 叙事与章节蓝图 | 章节目的、张力、承接、分钟数 | 章节总时长 90%–110%，避免过密 |
| 声音设计师 | 情绪与声音曲线 | 情绪 beat、留白、声音意图 | 与章节逐一对齐 |
| 分段编剧 | 逐章写作 | 可桌读台词、claim 引用、表演与停顿 | 单章可锁定、编辑和重生成 |
| Showrunner / 故事编辑 | 整集故事编辑 | 连贯整集脚本 | 保留 segment、delivery、pause 元数据 |
| 桌读与脚本红队 | 脚本审计 / 返修 | 节奏、角色、事实、重复、收束 findings | 独立 Agent 审计后自动完整返修 |
| 发行编辑 | 标题、简介与 Show Notes | 标题、摘要、章节导航、关键词 | 只使用最终脚本和已核验来源 |
| 视觉编辑 | 单集封面与章节视觉 | 主封面 brief、逐章视觉 brief、登记资产 | 尺寸、透明通道、权利、校验值 |
| 声音导演 | 选角与声音试演 | 每角色音色和用途 | 角色覆盖、音色目录、声音授权 |
| 音乐监督 / Sound Designer | 音乐、声景与留白 | 创意 Cue、授权素材选择或 silence | 只有素材库登记资产可进入母带 |
| 对白编辑 / Mix Engineer | 对白剪辑与母带 | 桌读预览或发行母带 | 时长、校验值、内容有效性 |
| 技术 QC | 成片质量审计 | duration、LUFS、dBTP、transcript checks | 不合格自动阻断发布 |
| 发行制作人 | 发行包与章节清单 | 音频、封面、文案、来源、权利、章节 | 绑定当前音频审计版本和 SHA-256 |

## 长度如何改变工作流

- `15–25 分钟`：至少 3 章，适合热点深谈。研究和事实审计不能省，只缩小问题范围。
- `30–60 分钟`：3–6 章，按章节写作、锁定和返修；Showrunner 负责跨章论证与听感。
- `60–120 分钟`：最多约每 10 分钟一章，需要更明确的章节承接、阶段性结论和听觉休息。
- `120–240 分钟`：协议允许最多 24 章，但产品上应优先评估拆成系列或上下集。这是编辑判断，不由长度参数自动决定。

脚本目标按中文约 `220 字/分钟` 计算，Agent 返回必须处于目标的 `85%–120%`。桌读渲染必须计入每句停顿，并以真实媒体时长回写；不能用脚本文字估算冒充音频时长。

## 产品和开源项目吸收

- NotebookLM 证明了“来源约束 + 可定制长度 + 可交互主持”是用户可理解的产品形态，但双主持只是它的默认形式，不应成为 Token Talk 的角色模型。[NotebookLM Audio Overviews](https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews/)
- Wondercraft、Descript 和 Riverside 的共同价值是直接编辑最终产物、时间线/转录稿与媒体联动，而不是把模型清单暴露给用户。[Wondercraft](https://www.wondercraft.ai/)、[Descript Podcasting](https://www.descript.com/podcasting)、[Riverside Podcast Maker](https://riverside.com/tools/podcast-maker)
- Auphonic 展示了自动电平、降噪、ducking、响度和批量发布可以成为确定性后期服务；Token Talk 当前先用本地 FFmpeg 覆盖响度和峰值，后续可把 Auphonic 作为可选适配器，而非必需付费依赖。[Auphonic Features](https://auphonic.com/features)
- LangChain Multi-modal Researcher 和 Orpheus Podcast 展示了检索到多说话人脚本的开源链路；Token Talk 额外增加证据账本、独立审计、可编辑版本和发行门禁。[LangChain Multi-modal Researcher](https://github.com/langchain-ai/multi-modal-researcher)、[Orpheus Podcast](https://github.com/sebastianboehler/orpheus-podcast)
- FireRedTTS2、Voice Studio 和 tts-fun 可用于评估本地多说话人声音、长音频与免费预演，但模型许可、声音克隆授权和中文自然度必须逐项验证，不能因为开源就默认可商用。[FireRedTTS2](https://github.com/FireRedTeam/FireRedTTS2)、[Voice Studio](https://github.com/msrbuilds/voice-studio)、[tts-fun](https://github.com/sgb-io/tts-fun)

## 发行标准

- Apple 建议整体响度约 `-16 dB LKFS ±1 dB`，true peak 不超过 `-1 dBFS`。Token Talk 用完整母带运行 FFmpeg EBU R128/loudnorm 测量，并在音频审计节点阻断超限文件。[Apple Audio Requirements](https://podcasters.apple.com/support/893-audio-requirements)
- RSS 音频最终应为 MP3 或 AAC；内部可登记 WAV/M4A/MP3 母带，但面向具体托管平台的转码和 RSS 提交仍属于发布适配器职责。[Apple RSS Requirements](https://podcasters.apple.com/support/823-podcast-requirements)
- Podcasting 2.0 JSON Chapters 使用 `application/json+chapters`，章节按 `startTime` 升序。发布包现在生成 1.2.0 数据，并提供可公开托管的章节 endpoint。[JSON Chapters](https://podcasting2.org/docs/podcast-namespace/examples/chapters/jsonChapters)
- WebVTT 是跨平台逐字稿的首选，支持 `<v>` 说话人标签。当前发布包明确标记 `requires_forced_alignment`，不会用按字数估算的伪时间戳冒充最终 VTT；后续接入本地 Whisper/forced alignment 后再开放导出。[Transcript Formats](https://podcasting2.org/docs/podcast-namespace/examples/transcripts/transcripts)

## 免费资源策略

- 研究发现：OpenAlex、Crossref、Open Library、arXiv、Wikipedia、Hacker News 公共接口，先用元数据和公开摘要建立可复查资料包。
- 本地生产：Codex 订阅承担规划、编剧和独立审计；FFmpeg/ffprobe 承担媒体测量；macOS `say` 只做零成本桌读预览。
- 音乐：本地素材库只接受已登记权利的资产；没有可用资产时自动选择 silence，不把“免费试听”当作商业授权。
- 声音：开源 TTS 只作为待验证供应路径；正式发行前仍要确认模型许可、声音权利和角色声音一致性。

## 尚未伪装完成的边界

1. 正式 TTS 仍需一个已配置且授权清晰的供应商或自部署模型；当前真实跑通的是本地桌读，不是发行声音。
2. 图像 Agent 已生成可编辑视觉 brief，但没有配置正式图像生成 API，因此真实封面仍需登记后才能发布。
3. WebVTT 需要对最终母带做 forced alignment；当前系统诚实地保留为发行适配器待办，没有生成伪时间轴。
4. 小宇宙、Apple、Spotify 或自有 RSS 的实际上传 API 尚未接入；系统已生成发布清单并记录外部发布结果，但不会擅自向外发布。
