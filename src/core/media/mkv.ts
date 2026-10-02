// Reads Matroska files (.mkv, .webm, .mka): the audio tracks and length, and the frames of one
// audio track. Specification: https://www.matroska.org/technical/elements.html
//
// A Matroska file is a tree of elements, each an ID, a size and a payload. This reader walks it
// in one pass. It steps into the few containers it cares about, reads the fields it needs, and
// skips everything else by its size, so the video itself is never decoded.

import { type AacConfig, type AudioCodec, type AudioOutput, aacConfigFrom, audioFile, parseAacConfig } from "./audio.ts";
import { type BlobReader, readText, readUint } from "./reader.ts";
import type { MediaInfo } from "./media.ts";

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageIETF: 0x22b59d,
  Name: 0x536e,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  BlockGroup: 0xa0,
  Block: 0xa1,
  SimpleBlock: 0xa3,
};

// Elements whose children we read. Every other element is skipped whole.
const CONTAINERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);

const AUDIO_TRACK_TYPE = 2;

type Track = {
  number: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string | null;
  name: string | null;
  sampleRate: number;
  channels: number;
};

export async function probeMkv(reader: BlobReader): Promise<MediaInfo> {
  const { tracks, durationSeconds } = await walk(reader, null);
  return {
    durationSeconds,
    audioTracks: audioTracksOf(tracks).map((track) => ({
      language: track.language,
      name: track.name,
      codec: codecOf(track.codecId) ?? track.codecId,
      canExtract: codecOf(track.codecId) !== null,
    })),
  };
}

// The frames of the audio track at `position` (0 for the first audio track), as a playable file.
export async function extractMkvAudio(reader: BlobReader, position: number): Promise<AudioOutput> {
  const header = await walk(reader, null);
  const track = audioTracksOf(header.tracks)[position];
  if (!track) throw new Error(`there is no audio track ${position + 1}`);
  const codec = codecOf(track.codecId);
  if (codec === null) throw new Error(`audio in ${track.codecId} cannot be copied out yet`);

  const { frames } = await walk(reader, track.number);
  let aac: AacConfig | undefined;
  if (codec === "aac") aac = track.codecPrivate ? parseAacConfig(track.codecPrivate) : aacConfigFrom(track.sampleRate, track.channels);
  return audioFile(codec, frames, track.codecPrivate, aac);
}

function audioTracksOf(tracks: Track[]): Track[] {
  return tracks.filter((track) => track.type === AUDIO_TRACK_TYPE);
}

function codecOf(codecId: string): AudioCodec | null {
  if (codecId.startsWith("A_AAC")) return "aac";
  if (codecId === "A_MPEG/L3") return "mp3";
  if (codecId === "A_AC3") return "ac3";
  if (codecId === "A_EAC3") return "eac3";
  if (codecId === "A_FLAC") return "flac";
  return null;
}

// One pass over the file. Without `collectTrack` it stops at the first cluster, which is after the
// track list; with it, it reads to the end and gathers that track's frames.
async function walk(reader: BlobReader, collectTrack: number | null) {
  const tracks: Track[] = [];
  const frames: Uint8Array[] = [];
  let timecodeScale = 1_000_000;
  let duration: number | null = null;

  let position = 0;
  while (position < reader.size) {
    const header = await reader.read(position, 12);
    if (header.length < 2) break;
    const id = readId(header);
    const size = readSize(header, id.length);
    const payloadStart = position + id.length + size.length;

    if (CONTAINERS.has(id.value)) {
      if (id.value === ID.Cluster && collectTrack === null) break;
      if (id.value === ID.TrackEntry) tracks.push(newTrack());
      position = payloadStart; // step inside
      continue;
    }
    if (size.value === null) throw new Error("this Matroska file has an element of unknown size where one is not allowed");

    const current = tracks[tracks.length - 1];
    switch (id.value) {
      case ID.TimecodeScale:
        timecodeScale = readUint(await reader.read(payloadStart, size.value));
        break;
      case ID.Duration:
        duration = readFloat(await reader.read(payloadStart, size.value));
        break;
      case ID.TrackNumber:
        if (current) current.number = readUint(await reader.read(payloadStart, size.value));
        break;
      case ID.TrackType:
        if (current) current.type = readUint(await reader.read(payloadStart, size.value));
        break;
      case ID.CodecID:
        if (current) current.codecId = readText(await reader.read(payloadStart, size.value));
        break;
      case ID.CodecPrivate:
        if (current) current.codecPrivate = (await reader.read(payloadStart, size.value)).slice();
        break;
      case ID.Language:
        if (current && current.language === null) current.language = readText(await reader.read(payloadStart, size.value));
        break;
      case ID.LanguageIETF:
        if (current) current.language = readText(await reader.read(payloadStart, size.value));
        break;
      case ID.Name:
        if (current) current.name = readText(await reader.read(payloadStart, size.value));
        break;
      case ID.SamplingFrequency:
        if (current) current.sampleRate = readFloat(await reader.read(payloadStart, size.value));
        break;
      case ID.Channels:
        if (current) current.channels = readUint(await reader.read(payloadStart, size.value));
        break;
      case ID.SimpleBlock:
      case ID.Block:
        if (collectTrack !== null) {
          // The track number comes first, so a block of another track is skipped unread.
          const start = await reader.read(payloadStart, 8);
          const track = readSize(start, 0);
          if (track.value === collectTrack) frames.push(...splitLaces(await reader.read(payloadStart, size.value), track.length));
        }
        break;
    }
    position = payloadStart + size.value;
  }

  const durationSeconds = duration === null ? null : (duration * timecodeScale) / 1e9;
  return { tracks, frames, durationSeconds };
}

function newTrack(): Track {
  return { number: 0, type: 0, codecId: "", codecPrivate: null, language: null, name: null, sampleRate: 0, channels: 0 };
}

// A block holds one frame, or several "laced" together with their sizes up front.
// https://www.matroska.org/technical/notes.html#block-lacing
function splitLaces(block: Uint8Array, trackNumberLength: number): Uint8Array[] {
  const flags = block[trackNumberLength + 2];
  let position = trackNumberLength + 3;
  const lacing = flags & 0x06;
  if (lacing === 0) return [block.slice(position)];

  const count = block[position++] + 1;
  const sizes: number[] = [];
  if (lacing === 0x02) {
    // Xiph lacing: each size is a run of bytes added together, ending at a byte under 255.
    for (let i = 0; i < count - 1; i++) {
      let frameSize = 0;
      let byte: number;
      do {
        byte = block[position++];
        frameSize += byte;
      } while (byte === 255);
      sizes.push(frameSize);
    }
  } else if (lacing === 0x06) {
    // EBML lacing: the first size, then each next size as a signed difference from the last.
    const first = readSize(block, position);
    sizes.push(first.value!);
    position += first.length;
    for (let i = 1; i < count - 1; i++) {
      const difference = readSize(block, position);
      const bias = 2 ** (7 * difference.length - 1) - 1;
      sizes.push(sizes[i - 1] + (difference.value! - bias));
      position += difference.length;
    }
  } else {
    // Fixed lacing: every frame the same size.
    const each = (block.length - position) / count;
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }

  const frames: Uint8Array[] = [];
  for (const frameSize of sizes) {
    frames.push(block.slice(position, position + frameSize));
    position += frameSize;
  }
  frames.push(block.slice(position));
  return frames;
}

// Element IDs keep their length marker: 0x1A45DFA3 is read as 0x1A45DFA3.
function readId(bytes: Uint8Array): { value: number; length: number } {
  const length = vintLength(bytes[0]);
  return { value: readUint(bytes, 0, length), length };
}

// Sizes drop the marker bit. All ones means "unknown size".
function readSize(bytes: Uint8Array, offset: number): { value: number | null; length: number } {
  const length = vintLength(bytes[offset]);
  let value = bytes[offset] & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    if (bytes[offset + i] !== 0xff) allOnes = false;
  }
  return { value: allOnes ? null : value, length };
}

// The number of leading zero bits in the first byte, plus one.
function vintLength(firstByte: number): number {
  for (let length = 1; length <= 8; length++) {
    if (firstByte & (0x80 >> (length - 1))) return length;
  }
  throw new Error("this does not look like a Matroska file");
}

function readFloat(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}
