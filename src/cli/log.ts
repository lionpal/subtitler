// Everything shown on screen is also appended to subtitler.log, next to the program itself,
// with a timestamp on each line. The API key is never written to it.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOG_PATH = fileURLToPath(new URL("../../subtitler.log", import.meta.url));

export function say(message: string): void {
  console.log(message);
  record(message);
}

export function warn(message: string): void {
  console.error(message);
  record(message);
}

// Writes to the log only, for details that would clutter the screen.
export function record(message: string): void {
  const time = new Date().toISOString();
  const lines = message.split("\n").map((line) => `${time} ${line}`);
  try {
    appendFileSync(LOG_PATH, lines.join("\n") + "\n");
  } catch {
    // A log that cannot be written (a read-only install, say) should not stop the work.
  }
}
