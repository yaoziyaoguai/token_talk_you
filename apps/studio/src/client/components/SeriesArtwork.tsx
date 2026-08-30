import { AudioLines } from "lucide-react";
import { useEffect, useState } from "react";

interface SeriesArtworkProps {
  seriesId?: string;
  title: string;
  compact?: boolean;
}

export function SeriesArtwork({ seriesId, title, compact = false }: SeriesArtworkProps) {
  const [failed, setFailed] = useState(false);
  const palette = artworkPalette(seriesId ?? title);
  const sizes = compact
    ? "(max-width: 520px) 88px, (max-width: 820px) 112px, 164px"
    : "(max-width: 520px) calc(100vw - 64px), (max-width: 820px) 320px, 280px";

  useEffect(() => setFailed(false), [seriesId]);

  return (
    <span className={`series-artwork${compact ? " compact" : ""}`} style={{ "--art-primary": palette[0], "--art-secondary": palette[1], "--art-accent": palette[2] } as React.CSSProperties}>
      {seriesId && !failed ? (
        <img
          src={`./covers/${seriesId}.560.png`}
          srcSet={`./covers/${seriesId}.224.png 224w, ./covers/${seriesId}.560.png 560w`}
          sizes={sizes}
          alt=""
          decoding="async"
          loading={compact ? "eager" : "lazy"}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="series-artwork-fallback" aria-hidden="true"><i /><i /><i /><AudioLines size={compact ? 24 : 38} /></span>
      )}
      <span className="series-artwork-type" aria-hidden="true"><b>TOKEN</b><b>TALK</b></span>
      <span className="sr-only">{title} 系列封面</span>
    </span>
  );
}

function artworkPalette(key: string): [string, string, string] {
  const palettes: [string, string, string][] = [
    ["#1948d8", "#f25f48", "#79d6ae"],
    ["#14735f", "#f2b323", "#eb5545"],
    ["#6b46c1", "#f06a45", "#79c9d0"],
    ["#b7372f", "#245bc7", "#f1c84c"],
  ];
  const hash = [...key].reduce((value, character) => value + character.codePointAt(0)!, 0);
  return palettes[hash % palettes.length] ?? palettes[0]!;
}
