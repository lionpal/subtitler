// What is in a video file, and its audio copied out, for any container we can read. Works on a
// Blob, so the same code runs in Node and in the browser.

import type { AudioOutput } from "./audio.ts";
import { extractMkvAudio, probeMkv } from "./mkv.ts";
import { extractMp4Audio, probeMp4 } from "./mp4.ts";
import { BlobReader, readText, readUint } from "./reader.ts";

export type AudioTrackInfo = {
  language: string | null; // as the file writes it, e.g. "jpn"
  name: string | null; // a title some files give a track, e.g. "Commentary"
  codec: string;
  canExtract: boolean; // false for codecs we cannot copy out yet; the whole file is sent instead
};

export type MediaInfo = {
  durationSeconds: number | null;
  audioTracks: AudioTrackInfo[];
};

type Container = "mkv" | "mp4" | "other";

// Recognizes the file by its first bytes.
async function containerOf(reader: BlobReader): Promise<Container> {
  const start = await reader.read(0, 12);
  if (readUint(start, 0, 4) === 0x1a45dfa3) return "mkv";
  if (["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(readText(start.subarray(4, 8)))) return "mp4";
  return "other";
}

// For other files (an .mp3, a .wav, an .avi) we know nothing, and ElevenLabs gets the file as it is.
export async function probeMedia(file: Blob): Promise<MediaInfo> {
  const reader = new BlobReader(file);
  const container = await containerOf(reader);
  if (container === "mkv") return probeMkv(reader);
  if (container === "mp4") return probeMp4(reader);
  return { durationSeconds: null, audioTracks: [] };
}

// The audio track at `position` (0 is the first audio track) as a small audio-only file, or null
// when it cannot be copied out and the whole file should be sent instead.
export async function extractAudio(file: Blob, position: number): Promise<AudioOutput | null> {
  const reader = new BlobReader(file);
  const container = await containerOf(reader);
  const info = container === "mkv" ? await probeMkv(reader) : container === "mp4" ? await probeMp4(reader) : null;
  if (info === null || !info.audioTracks[position]?.canExtract) return null;
  return container === "mkv" ? extractMkvAudio(reader, position) : extractMp4Audio(reader, position);
}
