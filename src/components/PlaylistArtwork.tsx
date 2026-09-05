import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState, type CSSProperties } from "react";
import type { PlaylistAppearance } from "../lib/playlistAppearance";

export function playlistStyle(appearance: PlaylistAppearance): CSSProperties {
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(appearance.color.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return { "--playlist-color": appearance.color, "--playlist-ink": luminance > .179 ? "#0d1914" : "#ffffff" } as CSSProperties;
}

export function PlaylistArtwork({ appearance, fallback, className = "" }: {
  appearance: PlaylistAppearance; fallback?: string | null; className?: string;
}) {
  const path = appearance.coverPath || fallback;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  const initials = appearance.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return <span className={`playlistArtwork ${className}`} style={playlistStyle(appearance)}>
    {path && !failed
      ? <img src={convertFileSrc(path)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <span className="playlistGeneratedArt" aria-hidden="true"><i /><b>{initials || "LP"}</b><small>LOAVY / COLLECTION</small></span>}
  </span>;
}

export function PlaylistBanner({ appearance }: { appearance: PlaylistAppearance }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [appearance.bannerPath]);
  return <div className="playlistBanner" aria-hidden="true">
    {appearance.bannerPath && !failed && <img src={convertFileSrc(appearance.bannerPath)} alt="" style={{ objectPosition: `center ${appearance.bannerPosition}%` }} onError={() => setFailed(true)} />}
  </div>;
}
