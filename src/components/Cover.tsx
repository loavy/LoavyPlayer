import { convertFileSrc } from "@tauri-apps/api/core";
import { Music } from "lucide-react";

type Props = {
  path?: string | null;
  title?: string;
  size?: "sm" | "md" | "lg";
};

export function Cover({ path, title, size = "md" }: Props) {
  if (path) {
    return <img className={`cover ${size}`} src={convertFileSrc(path)} alt={title || "Album cover"} loading="lazy" />;
  }

  return (
    <div className={`cover placeholder ${size}`} aria-label="No cover">
      <Music size={size === "sm" ? 16 : 26} />
    </div>
  );
}
