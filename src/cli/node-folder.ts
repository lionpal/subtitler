// A Folder (see src/core/folder.ts) backed by Node's file functions.

import { existsSync, mkdirSync, openAsBlob, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Folder } from "../core/folder.ts";

export function nodeFolder(path: string, label: string): Folder {
  return {
    label,
    async list() {
      return readdirSync(path).filter((name) => statSync(join(path, name)).isFile());
    },
    async open(name) {
      // openAsBlob reads from disk as it is used, so a large video is never loaded whole.
      return openAsBlob(join(path, name));
    },
    async readText(relative) {
      const file = join(path, relative);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    async writeText(relative, text) {
      // Write to a temporary name, then rename, so a crash halfway leaves the old file or none.
      const file = join(path, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.partial`, text);
      renameSync(`${file}.partial`, file);
    },
  };
}
