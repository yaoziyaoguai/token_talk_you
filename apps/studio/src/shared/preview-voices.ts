export const PREVIEW_VOICES = [
  { id: "preview-steady", label: "普通话 · 平稳", macosVoice: "Tingting", linuxRate: 150, linuxPitch: 42 },
  { id: "preview-bright", label: "普通话 · 明快", macosVoice: "Flo (中文（中国大陆）)", linuxRate: 165, linuxPitch: 62 },
  { id: "preview-deep", label: "普通话 · 沉稳", macosVoice: "Reed (中文（中国大陆）)", linuxRate: 142, linuxPitch: 32 },
  { id: "preview-warm", label: "普通话 · 温和", macosVoice: "Eddy (中文（中国大陆）)", linuxRate: 154, linuxPitch: 54 },
] as const;

export const PREVIEW_VOICE_IDS = new Set<string>(PREVIEW_VOICES.map((voice) => voice.id));
