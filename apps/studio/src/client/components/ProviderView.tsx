import type { ProviderProfile } from "@token-talk/domain";
import type { MusicAsset, StudioBootstrap, VoiceCatalog } from "../../shared/api.js";
import { ChevronDown, Headphones, LibraryBig, LoaderCircle, Mic2, Music2, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { StudioApi, studioPath } from "../api.js";

const jobs = [
  { label: "资料研究", capability: "research.search" },
  { label: "声音演员", capability: "voice.synthesize" },
  { label: "配乐素材", capability: "music.retrieve" },
  { label: "音乐生成", capability: "music.generate" },
  { label: "封面生成", capability: "image.generate" },
] as const;

export function ProviderView({ data }: { data: StudioBootstrap }) {
  const [musicAssets, setMusicAssets] = useState<MusicAsset[]>([]);
  const [musicLoading, setMusicLoading] = useState(true);
  const [musicError, setMusicError] = useState<string>();
  const [addingMusic, setAddingMusic] = useState(false);
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState("");
  const [mood, setMood] = useState<MusicAsset["mood"]>("reflective");
  const [energy, setEnergy] = useState(2);
  const [bpm, setBpm] = useState("");
  const [tags, setTags] = useState("");
  const [licenseBasis, setLicenseBasis] = useState<MusicAsset["license"]["basis"]>("owned");
  const [sourceUrl, setSourceUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalog>();
  const [voiceLoading, setVoiceLoading] = useState(true);
  const [voiceError, setVoiceError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void StudioApi.loadMusicAssets().then((library) => {
      if (!cancelled) setMusicAssets(library.assets);
    }).catch((reason: unknown) => {
      if (!cancelled) setMusicError(reason instanceof Error ? reason.message : "无法读取音乐素材库");
    }).finally(() => {
      if (!cancelled) setMusicLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void StudioApi.loadVoiceCatalog().then((catalog) => {
      if (!cancelled) setVoiceCatalog(catalog);
    }).catch((reason: unknown) => {
      if (!cancelled) setVoiceError(reason instanceof Error ? reason.message : "无法读取声音目录");
    }).finally(() => {
      if (!cancelled) setVoiceLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function addMusic(event: FormEvent) {
    event.preventDefault();
    if (!file || !rightsConfirmed) return;
    try {
      setAddingMusic(true);
      setMusicError(undefined);
      const asset = await StudioApi.addMusicAsset(file, {
        title,
        mood,
        energy,
        ...(bpm ? { bpm: Number(bpm) } : {}),
        tags,
        licenseBasis,
        ...(sourceUrl ? { sourceUrl } : {}),
        commercialUseConfirmed: true,
      });
      setMusicAssets((current) => [asset, ...current.filter((candidate) => candidate.id !== asset.id)]);
      setFile(undefined);
      setTitle("");
      setSourceUrl("");
      setTags("");
      setRightsConfirmed(false);
      setFileInputKey((value) => value + 1);
    } catch (reason) {
      setMusicError(reason instanceof Error ? reason.message : "无法加入音乐素材");
    } finally {
      setAddingMusic(false);
    }
  }

  const externalLicense = ["cc0", "royalty_free", "other"].includes(licenseBasis);
  return (
    <div className="view-stack resources-view">
      <header className="view-header"><div><p className="eyebrow">节目资源</p><h1>声音与音乐</h1><p className="header-summary">集中试听节目可用的声音与配乐，每一项都保留用途和授权依据。</p></div></header>

      <section className="resource-section voice-library-section">
        <div className="section-heading compact"><h2>节目声音库</h2><span>{voiceLoading ? "读取中" : `${voiceCatalog?.voices.length ?? 0} 个账户音色`}</span></div>
        <div className="voice-library-ledger">
          <header><Mic2 size={17} /><span><strong>桌读声音</strong><small>零现金、仅用于检查脚本与节奏</small></span><em>本机可用</em></header>
          <div className="local-voice-list">{["Tingting", "Eddy", "Flo", "Reed"].map((voice) => <span key={voice}><Headphones size={14} />{voice}<small>非发行母带</small></span>)}</div>
          <header><Mic2 size={17} /><span><strong>发行声音候选</strong><small>来自当前 ElevenLabs 账户，制作时按角色选择</small></span><em>{voiceCatalog?.warning ? "目录不可用" : voiceCatalog?.configured ? "目录已验证" : "未配置"}</em></header>
          {voiceCatalog?.voices.length ? <div className="account-voice-list">{voiceCatalog.voices.map((voice) => <article key={voice.voiceId}><span><strong>{voice.name}</strong><small>{voiceMeta(voice)}</small></span>{voice.previewUrl ? <audio controls preload="none" src={voice.previewUrl} aria-label={`试听声音：${voice.name}`}>当前浏览器无法播放音频。</audio> : <em>暂无试听</em>}</article>)}</div> : voiceLoading ? <div className="voice-catalog-state"><LoaderCircle className="is-spinning" size={17} />正在读取账户音色</div> : <div className="voice-catalog-state"><Headphones size={17} /><span>{voiceCatalog?.warning ?? voiceError ?? "配置发行声音服务后，这里会显示可选音色；本地桌读仍然可用。"}</span></div>}
          {voiceCatalog?.configured && voiceCatalog.voices.length > 0 ? <p className="voice-rights-note">账户可用不等于自动获得全部商业权利，登记母带时仍需确认音色与声音复刻授权。</p> : null}
        </div>
      </section>

      <section className="resource-section music-library-section">
        <div className="section-heading compact"><h2>节目音乐库</h2><span>{musicLoading ? "读取中" : `${musicAssets.length} 条已登记素材`}</span></div>
        <div className="music-library-workbench">
          <form className="music-asset-form" onSubmit={(event) => void addMusic(event)}>
            <div className="music-form-heading"><LibraryBig size={17} /><span><strong>加入自有音乐</strong><small>文件、授权和声音标签一起登记</small></span></div>
            <label><span>音频文件</span><input key={fileInputKey} type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" required onChange={(event) => setFile(event.target.files?.[0])} /></label>
            <label><span>素材名称</span><input value={title} required maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
            <div className="music-form-pair">
              <label><span>情绪</span><select value={mood} onChange={(event) => setMood(event.target.value as MusicAsset["mood"])}><option value="curious">好奇</option><option value="reflective">沉思</option><option value="warm">温暖</option><option value="tense">张力</option><option value="neutral">中性</option></select></label>
              <label><span>能量</span><select value={energy} onChange={(event) => setEnergy(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>
            <div className="music-form-pair">
              <label><span>BPM</span><input type="number" min="40" max="240" value={bpm} placeholder="可选" onChange={(event) => setBpm(event.target.value)} /></label>
              <label><span>授权依据</span><select value={licenseBasis} onChange={(event) => setLicenseBasis(event.target.value as MusicAsset["license"]["basis"])}><option value="owned">自有版权</option><option value="commissioned">委托创作</option><option value="cc0">CC0</option><option value="royalty_free">免版税许可</option><option value="other">其他许可</option></select></label>
            </div>
            <label><span>标签</span><input value={tags} placeholder="钢琴, 转场, 低密度" onChange={(event) => setTags(event.target.value)} /></label>
            <label><span>授权来源</span><input type="url" value={sourceUrl} required={externalLicense} placeholder={externalLicense ? "https://..." : "可选"} onChange={(event) => setSourceUrl(event.target.value)} /></label>
            <label className="rights-confirm"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /><span>我确认该文件可用于 Token Talk 的商业播客制作</span></label>
            <button className="primary-command" type="submit" disabled={!file || !title.trim() || !rightsConfirmed || addingMusic}>{addingMusic ? <LoaderCircle className="is-spinning" size={15} /> : <Plus size={15} />}{addingMusic ? "正在登记" : "加入音乐库"}</button>
          </form>
          <div className="music-asset-list" aria-busy={musicLoading}>
            {musicAssets.map((asset) => <article key={asset.id}>
              <div className="music-asset-index"><Music2 size={16} /></div>
              <div className="music-asset-copy"><strong>{asset.title}</strong><span>{moodLabel(asset.mood)} · 能量 {asset.energy}{asset.bpm ? ` · ${asset.bpm} BPM` : ""}</span><small>{licenseLabel(asset.license.basis)} · {formatFileSize(asset.bytes)}</small></div>
              <audio aria-label={`试听：${asset.title}`} controls preload="none" src={studioPath(asset.mediaUrl)}>当前浏览器无法播放音频。</audio>
            </article>)}
            {!musicLoading && musicAssets.length === 0 ? <div className="music-empty"><Music2 size={20} /><span><strong>还没有可用音乐</strong><small>Cue 会默认选择留白，不会调用来源不明的音乐。</small></span></div> : null}
          </div>
        </div>
        {musicError ? <p className="field-error" role="alert">{musicError}</p> : null}
      </section>

      <details className="advanced-providers">
        <summary><SlidersHorizontal size={16} />高级：制作服务、价格与授权<ChevronDown size={16} /></summary>
        <div className="advanced-provider-list">{data.providers.map((provider) => <div key={provider.id}><span><strong>{provider.label}</strong><small>{provider.description}</small></span><span>{capabilityLabel(provider.capability)}</span><span>{billingLabel(provider)}</span><span>{rightsLabel(provider)}</span></div>)}</div>
      </details>
    </div>
  );
}

function moodLabel(value: MusicAsset["mood"]): string {
  return ({ curious: "好奇", reflective: "沉思", warm: "温暖", tense: "张力", neutral: "中性" })[value];
}

function licenseLabel(value: MusicAsset["license"]["basis"]): string {
  return ({ owned: "自有版权", commissioned: "委托创作", cc0: "CC0", royalty_free: "免版税许可", other: "其他许可" })[value];
}

function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function capabilityLabel(capability: string): string {
  return jobs.find((job) => job.capability === capability)?.label ?? capability;
}

function billingLabel(provider: ProviderProfile): string {
  if (provider.billing.type === "local_compute") return "本地计算";
  if (provider.billing.rate === 0) return "免费";
  const symbol = provider.billing.currency === "CNY" ? "¥" : "$";
  return `${symbol}${provider.billing.rate}/${provider.billing.unitSize.toLocaleString()}`;
}

function rightsLabel(provider: ProviderProfile): string {
  if (provider.rights.commercialUse === "allowed") return "允许商用";
  if (provider.rights.commercialUse === "restricted") return "商用受限";
  return "条款待确认";
}

function voiceMeta(voice: VoiceCatalog["voices"][number]): string {
  const category = ({ premade: "预设音色", cloned: "复刻音色", generated: "生成音色", professional: "专业音色", high_quality: "录音室音色" } as Record<string, string>)[voice.category ?? ""];
  const useCase = ({ narration: "旁白", conversational: "对话", social_media: "短内容", characters_animation: "角色表达", news: "资讯" } as Record<string, string>)[voice.labels.use_case ?? ""];
  const language = ({ zh: "中文", en: "英语", ja: "日语", ko: "韩语" } as Record<string, string>)[voice.labels.language ?? ""] ?? voice.labels.language;
  return [language, voice.labels.accent, useCase, category].filter(Boolean).join(" · ") || "账户可用音色";
}
