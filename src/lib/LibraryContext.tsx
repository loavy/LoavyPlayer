import { createContext, useContext, type ReactNode } from "react";

export type NoticeTone = "info" | "success" | "error";

export type LibraryActions = {
  refreshLibrary: () => Promise<void>;
  openArtist: (artist: string) => void;
  openAlbum: (album: string) => void;
  notify: (message: string, tone?: NoticeTone) => void;
};

const LibraryActionsContext = createContext<LibraryActions | null>(null);

export function LibraryActionsProvider({ value, children }: { value: LibraryActions; children: ReactNode }) {
  return <LibraryActionsContext.Provider value={value}>{children}</LibraryActionsContext.Provider>;
}

export function useLibraryActions() {
  const value = useContext(LibraryActionsContext);
  if (!value) throw new Error("Library actions must be used inside LibraryActionsProvider.");
  return value;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
