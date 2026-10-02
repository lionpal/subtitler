// Reads MP4 and QuickTime files (.mp4, .m4v, .mov, .m4a): the audio tracks and length, and the
// frames of one audio track. Specification: ISO/IEC 14496-12 (the "ISO base media file format").
//
// An MP4 file is a list of boxes, each a size, a four-letter type and a payload. All the
// information is in the "moov" box; the audio and video themselves are in "mdat". Each track has
// tables saying where its frames are in the file and how big each one is, so copying one track out
// is a matter of reading those tables and then the frames.

import { type AudioCodec, type AudioOutput, audioFile, parseAacConfig } from "./audio.ts";
import { type BlobReader, readText, readUint } from "./reader.ts";
import type { MediaInfo } from "./media.ts";

type Box = { type: string; start: number; end: number }; // start and end of the payload

type Track = {
  handler: string;
  language: string | null;
  codec: AudioCodec | null;
  sampleEntry: string;
  codecPrivate: Uint8Array | null;
  sampleSizes: number[];
  samplesPerChunk: { firstChunk: number; samples: number }[];
  chunkOffsets: number[];
};

export async function probeMp4(reader: BlobReader): Promise<MediaInfo> {
  const { durationSeconds, tracks } = await readMovie(reader);
  return {
    durationSeconds,
    audioTracks: tracks
      .filter((track) => track.handler === "soun")
      .map((track) => ({ language: track.language, name: null, codec: track.codec ?? track.sampleEntry, canExtract: track.codec !== null })),
  };
}

export async function extractMp4Audio(reader: BlobReader, position: number): Promise<AudioOutput> {
  const track = (await readMovie(reader)).tracks.filter((t) => t.handler === "soun")[position];
  if (!track) throw new Error(`there is no audio track ${position + 1}`);
  if (track.codec === null) throw new Error(`audio in ${track.sampleEntry} cannot be copied out yet`);

  // Walk the chunks in order. Each chunk is a run of frames stored back to back at its offset.
  const frames: Uint8Array[] = [];
  let sample = 0;
  for (let chunk = 0; chunk < track.chunkOffsets.length; chunk++) {
    let offset = track.chunkOffsets[chunk];
    for (let i = 0; i < samplesInChunk(track, chunk + 1) && sample < track.sampleSizes.length; i++, sample++) {
      const size = track.sampleSizes[sample];
      frames.push((await reader.read(offset, size)).slice());
      offset += size;
    }
  }

  const aac = track.codec === "aac" && track.codecPrivate ? parseAacConfig(track.codecPrivate) : undefined;
  return audioFile(track.codec, frames, track.codecPrivate, aac);
}

// "stsc" lists runs of chunks that hold the same number of frames, by the first chunk of each run.
function samplesInChunk(track: Track, chunkNumber: number): number {
  let samples = 0;
  for (const run of track.samplesPerChunk) {
    if (run.firstChunk > chunkNumber) break;
    samples = run.samples;
  }
  return samples;
}

async function readMovie(reader: BlobReader): Promise<{ durationSeconds: number | null; tracks: Track[] }> {
  // "moov" can come before or after the media data, so look along the top-level boxes for it.
  let moov: Box | null = null;
  for (let position = 0; position < reader.size; ) {
    const box = await readBoxHeader(reader, position, reader.size);
    if (box.type === "moov") {
      moov = box;
      break;
    }
    position = box.end;
  }
  if (moov === null) throw new Error("this MP4 file has no track information (it may be fragmented, which is not supported yet)");

  const movie = new BlobLike(await reader.read(moov.start, moov.end - moov.start), moov.start);
  let durationSeconds: number | null = null;
  const tracks: Track[] = [];

  for (const box of await children(movie, moov)) {
    if (box.type === "mvhd") durationSeconds = readMovieDuration(await movie.bytes(box));
    if (box.type === "trak") tracks.push(await readTrack(movie, box));
  }
  return { durationSeconds, tracks };
}

async function readTrack(movie: BlobLike, trak: Box): Promise<Track> {
  const track: Track = {
    handler: "",
    language: null,
    codec: null,
    sampleEntry: "",
    codecPrivate: null,
    sampleSizes: [],
    samplesPerChunk: [],
    chunkOffsets: [],
  };
  const mdia = await child(movie, trak, "mdia");
  if (!mdia) return track;

  const mdhd = await child(movie, mdia, "mdhd");
  if (mdhd) track.language = readLanguage(await movie.bytes(mdhd));
  const hdlr = await child(movie, mdia, "hdlr");
  if (hdlr) track.handler = readText((await movie.bytes(hdlr)).subarray(8, 12));

  const stbl = await descend(movie, mdia, ["minf", "stbl"]);
  if (!stbl || track.handler !== "soun") return track;

  for (const box of await children(movie, stbl)) {
    const bytes = await movie.bytes(box);
    if (box.type === "stsd") readSampleDescription(track, bytes, box.start, movie);
    if (box.type === "stsz") track.sampleSizes = readSampleSizes(bytes);
    if (box.type === "stsc") track.samplesPerChunk = readSamplesPerChunk(bytes);
    if (box.type === "stco") track.chunkOffsets = readTable(bytes, 4);
    if (box.type === "co64") track.chunkOffsets = readTable(bytes, 8);
  }
  return track;
}

// The first sample entry says the codec ("mp4a", "ac-3", ...) and holds its configuration.
function readSampleDescription(track: Track, stsd: Uint8Array, _start: number, _movie: BlobLike): void {
  const entry = stsd.subarray(8); // after version, flags and entry count
  track.sampleEntry = readText(entry.subarray(4, 8));
  // An audio sample entry has 28 bytes of fields before its own boxes. QuickTime's versions 1
  // and 2 add 16 and 36 more.
  const version = readUint(entry, 16, 2);
  const boxesStart = 8 + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const entryEnd = readUint(entry, 0, 4);

  for (let position = boxesStart; position + 8 <= entryEnd; ) {
    const size = readUint(entry, position, 4);
    const type = readText(entry.subarray(position + 4, position + 8));
    const payload = entry.subarray(position + 8, position + size);
    if (type === "esds") readEsds(track, payload);
    if (type === "dfLa") track.codecPrivate = concat(new TextEncoder().encode("fLaC"), payload.subarray(4));
    if (size < 8) break;
    position += size;
  }

  if (track.sampleEntry === "ac-3") track.codec = "ac3";
  if (track.sampleEntry === "ec-3") track.codec = "eac3";
  if (track.sampleEntry === "fLaC") track.codec = "flac";
  if (track.sampleEntry === ".mp3") track.codec = "mp3";
}

// "esds" holds MPEG-4 descriptors: which codec (0x40 is AAC, 0x69 and 0x6B are MP3) and, for
// AAC, its configuration. Each descriptor is a tag, a length and the contents.
function readEsds(track: Track, esds: Uint8Array): void {
  let position = 4; // version and flags
  while (position < esds.length) {
    const tag = esds[position++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = esds[position++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (tag === 0x03) {
      // ES descriptor: an id, then flags saying which optional fields follow. Its children come next.
      const flags = esds[position + 2];
      position += 3;
      if (flags & 0x80) position += 2;
      if (flags & 0x40) position += 1 + esds[position];
      if (flags & 0x20) position += 2;
      continue;
    }
    if (tag === 0x04) {
      const objectType = esds[position];
      if (objectType === 0x40 || objectType === 0x66 || objectType === 0x67) track.codec = "aac";
      if (objectType === 0x69 || objectType === 0x6b) track.codec = "mp3";
      position += 13; // the rest of the decoder config; its child, the codec configuration, is next
      continue;
    }
    if (tag === 0x05) track.codecPrivate = esds.slice(position, position + length);
    position += length;
  }
}

function readSampleSizes(stsz: Uint8Array): number[] {
  const fixedSize = readUint(stsz, 4, 4);
  const count = readUint(stsz, 8, 4);
  if (fixedSize !== 0) return new Array(count).fill(fixedSize);
  return Array.from({ length: count }, (_, i) => readUint(stsz, 12 + i * 4, 4));
}

function readSamplesPerChunk(stsc: Uint8Array): { firstChunk: number; samples: number }[] {
  const count = readUint(stsc, 4, 4);
  return Array.from({ length: count }, (_, i) => ({
    firstChunk: readUint(stsc, 8 + i * 12, 4),
    samples: readUint(stsc, 12 + i * 12, 4),
  }));
}

function readTable(bytes: Uint8Array, width: number): number[] {
  const count = readUint(bytes, 4, 4);
  return Array.from({ length: count }, (_, i) => readUint(bytes, 8 + i * width, width));
}

function readMovieDuration(mvhd: Uint8Array): number | null {
  const version = mvhd[0];
  const timescale = version === 1 ? readUint(mvhd, 20, 4) : readUint(mvhd, 12, 4);
  const duration = version === 1 ? readUint(mvhd, 24, 8) : readUint(mvhd, 16, 4);
  return timescale > 0 ? duration / timescale : null;
}

// Three letters packed into 15 bits, each letter minus 0x60. "und" means not set.
function readLanguage(mdhd: Uint8Array): string | null {
  const offset = mdhd[0] === 1 ? 32 : 20;
  const packed = readUint(mdhd, offset, 2);
  if (packed < 0x400) return null; // an old QuickTime number code, not letters
  const code = [10, 5, 0].map((shift) => String.fromCharCode(((packed >> shift) & 0x1f) + 0x60)).join("");
  return code === "und" ? null : code;
}

// --- Walking boxes ------------------------------------------------------------------------------

async function readBoxHeader(source: { read(offset: number, length: number): Promise<Uint8Array> }, position: number, limit: number): Promise<Box> {
  const header = await source.read(position, 16);
  let size = readUint(header, 0, 4);
  const type = readText(header.subarray(4, 8));
  let headerSize = 8;
  if (size === 1) {
    size = readUint(header, 8, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - position; // runs to the end
  }
  if (size < headerSize) throw new Error("this MP4 file is damaged");
  return { type, start: position + headerSize, end: position + size };
}

async function children(movie: BlobLike, parent: Box): Promise<Box[]> {
  const boxes: Box[] = [];
  for (let position = parent.start; position + 8 <= parent.end; ) {
    const box = await readBoxHeader(movie, position, parent.end);
    boxes.push(box);
    position = box.end;
  }
  return boxes;
}

async function child(movie: BlobLike, parent: Box, type: string): Promise<Box | null> {
  return (await children(movie, parent)).find((box) => box.type === type) ?? null;
}

async function descend(movie: BlobLike, parent: Box, path: string[]): Promise<Box | null> {
  let box: Box | null = parent;
  for (const type of path) {
    if (box === null) return null;
    box = await child(movie, box, type);
  }
  return box;
}

// The "moov" box, already in memory, read with the same offsets as the file.
class BlobLike {
  private data: Uint8Array;
  private base: number;
  constructor(data: Uint8Array, base: number) {
    this.data = data.slice();
    this.base = base;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset - this.base, offset - this.base + length);
  }
  async bytes(box: Box): Promise<Uint8Array> {
    return this.read(box.start, box.end - box.start);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}
