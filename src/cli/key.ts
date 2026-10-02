// Finds an API key. The environment comes first; otherwise the key saved in .env next to the
// program; otherwise it asks once and saves the answer there.
// .env is in .gitignore and is created readable only by you.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { ApiKeyInfo } from "../core/services.ts";

export const KEY_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

export type ApiKey = { value: string; savedInFile: boolean };

export async function findApiKey(service: ApiKeyInfo): Promise<ApiKey | null> {
  const fromEnvironment = process.env[service.variable];
  if (fromEnvironment) return { value: fromEnvironment, savedInFile: false };

  const saved = readSavedKeys()[service.variable];
  if (saved) return { value: saved, savedInFile: true };

  if (!process.stdin.isTTY) return null;

  console.log(`Paste your ${service.name} API key (from ${service.keysPage}).`);
  const value = (await askHidden("Key: ")).trim();
  if (value === "") return null;

  writeSavedKeys({ ...readSavedKeys(), [service.variable]: value });
  console.log(`Saved to ${KEY_FILE}, so you won't be asked again.\n`);
  return { value, savedInFile: true };
}

export function forgetSavedKey(service: ApiKeyInfo): void {
  const keys = readSavedKeys();
  delete keys[service.variable];
  writeSavedKeys(keys);
}

function readSavedKeys(): Record<string, string> {
  if (!existsSync(KEY_FILE)) return {};
  return parseEnv(readFileSync(KEY_FILE, "utf8")) as Record<string, string>;
}

function writeSavedKeys(keys: Record<string, string>): void {
  const lines = Object.entries(keys).map(([variable, value]) => `${variable}=${value}\n`);
  writeFileSync(KEY_FILE, lines.join(""), { mode: 0o600 });
}

// Reads a line without showing what is typed, so the key does not stay in the scrollback.
function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve) => {
    let typed = "";

    function finish(result: string) {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      resolve(result);
    }

    function onData(chunk: string) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(typed);
        if (character === "\u0003") return finish(""); // Ctrl-C
        if (character === "\u007f") typed = typed.slice(0, -1); // Backspace
        else typed += character;
      }
    }

    input.on("data", onData);
  });
}
