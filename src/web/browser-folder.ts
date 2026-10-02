// A Folder (see src/core/folder.ts) for a video chosen on the web page. The page cannot write next to
// the video, so subtitles are offered as downloads, and the saved transcript and the glossary are
// kept in the browser's own storage, so choosing the same video again does not pay for it twice.

import type { Folder } from "../core/folder.ts";

export function chosenFileFolder(file: File, onSubtitle: (name: string, text: string) => void): Folder {
  const written = new Map<string, string>();
  return {
    label: "this browser",
    async list() {
      return [file.name, ...written.keys()];
    },
    async open(name) {
      if (name !== file.name) throw new Error(`${name} is not the chosen file`);
      return file;
    },
    async readText(path) {
      return written.get(path) ?? (await browserStore("get", path));
    },
    async writeText(path, text) {
      if (path.endsWith(".srt")) {
        written.set(path, text);
        onSubtitle(path, text);
      } else {
        await browserStore("put", path, text);
      }
    },
  };
}

// A small key-value store in IndexedDB, which every browser has, for saved transcripts and the
// glossary when there is no folder to keep them in.
function browserStore(action: "get" | "put", key: string, value?: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("subtitler", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("files");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const store = opening.result.transaction("files", action === "get" ? "readonly" : "readwrite").objectStore("files");
      const request = action === "get" ? store.get(key) : store.put(value, key);
      request.onsuccess = () => resolve(action === "get" ? ((request.result as string | undefined) ?? null) : null);
      request.onerror = () => reject(request.error);
    };
  });
}
