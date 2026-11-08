import { convertFileSrc } from "@tauri-apps/api/core";
import { Music } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

type Props = {
  path?: string | null;
  title?: string;
  size?: "sm" | "md" | "lg";
};

export function Cover({ path, title, size = "md" }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  if (path && !failed) {
    return <img className={`cover ${size}`} src={convertFileSrc(path)} alt={title || "Album cover"} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  }

  return (
    <div className={`cover placeholder ${size}`} role="img" aria-label={title ? `${title}, no cover` : "No cover"} style={{ "--cover-hue": [...(title || "Loavy")].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) % 360, 0) } as CSSProperties}>
      <Music size={size === "sm" ? 16 : 26} />
    </div>
  );
}
