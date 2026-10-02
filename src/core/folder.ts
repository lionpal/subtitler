// A folder of videos, as the rest of the code sees it. The command line implements it with Node's
// file functions (src/cli/node-folder.ts), and the web page with the chosen file and the browser's
// storage (src/web/browser-folder.ts). Everything else is the same code in both.

export type Folder = {
  label: string; // how the folder is shown, e.g. "~/Videos"
  list(): Promise<string[]>; // names of the files directly inside it
  open(name: string): Promise<Blob>; // a file's contents, read lazily
  // Paths are relative to the folder, e.g. "Episode 1.en.srt" or ".subtitler/Episode 1.mkv.json".
  readText(path: string): Promise<string | null>; // null when there is no such file
  writeText(path: string, text: string): Promise<void>; // creates folders; never leaves half a file
};

export const CACHE_FOLDER = ".subtitler";

const MEDIA_EXTENSIONS = new Set([
  "mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "ts",
  "mp3", "m4a", "wav", "flac", "ogg", "opus", "aac", "mka",
]);

export function isMediaName(name: string): boolean {
  return !name.startsWith(".") && MEDIA_EXTENSIONS.has(extensionOf(name));
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// "Episode 1.mkv" -> "Episode 1"
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
