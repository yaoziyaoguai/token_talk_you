import type { CSSProperties } from "react";

const waveform = [38, 62, 28, 78, 48, 92, 54, 34, 72, 44, 86, 58, 32, 66, 40, 82, 52, 26, 74, 46, 88, 56, 36, 70];

export function SignalWave({ active = false }: { active?: boolean }) {
  return <div className={`signal-wave${active ? " active" : ""}`} aria-hidden="true">{waveform.map((height, index) => <i key={`${height}-${index}`} style={{ "--wave-height": `${height}%`, "--wave-delay": `${index * -38}ms` } as CSSProperties} />)}</div>;
}
