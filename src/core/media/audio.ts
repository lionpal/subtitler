// Turns the audio frames copied out of a video into a file ElevenLabs can read, without
// re-encoding them. Each codec has its own simple file format:
//   AAC   an .aac file, each frame behind a 7-byte ADTS header that says how to play it
//   MP3, AC-3, E-AC-3   frames one after another, which is already a valid file
//   FLAC  the codec's own header, then the frames

export type AudioCodec = "aac" | "mp3" | "ac3" | "eac3" | "flac";

export type AudioOutput = { bytes: Blob; extension: string };

export function audioFile(codec: AudioCodec, frames: Uint8Array[], codecPrivate: Uint8Array | null, aac?: AacConfig): AudioOutput {
  switch (codec) {
    case "aac": {
      if (!aac) throw new Error("AAC audio without its configuration");
      const parts = frames.flatMap((frame) => [adtsHeader(aac, frame.length), frame]);
      return { bytes: new Blob(parts as BlobPart[]), extension: "aac" };
    }
    case "flac":
      // In both MKV and MP4 the stored header starts with "fLaC" and is the start of a .flac file.
      return { bytes: new Blob([codecPrivate ?? new Uint8Array(0), ...frames] as BlobPart[]), extension: "flac" };
    default:
      return { bytes: new Blob(frames as BlobPart[]), extension: codec };
  }
}

export type AacConfig = { objectType: number; frequencyIndex: number; channels: number };

const AAC_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Reads the AudioSpecificConfig stored with AAC audio (ISO 14496-3, 1.6.2.1).
export function parseAacConfig(bytes: Uint8Array): AacConfig {
  let bit = 0;
  const take = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value = (value << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  let objectType = take(5);
  if (objectType === 31) objectType = 32 + take(6);
  let frequencyIndex = take(4);
  if (frequencyIndex === 15) frequencyIndex = nearestFrequencyIndex(take(24));
  const channels = take(4);
  // HE-AAC files describe the low-complexity core first and the extension after it. ADTS can only
  // describe the core, and players find the extension in the audio itself.
  if (objectType === 5 || objectType === 29) {
    let extensionIndex = take(4);
    if (extensionIndex === 15) extensionIndex = nearestFrequencyIndex(take(24));
    objectType = take(5);
  }
  return { objectType: objectType >= 1 && objectType <= 4 ? objectType : 2, frequencyIndex, channels };
}

// For MKV files that name the AAC profile and sample rate but store no configuration.
export function aacConfigFrom(sampleRate: number, channels: number): AacConfig {
  return { objectType: 2, frequencyIndex: nearestFrequencyIndex(sampleRate), channels };
}

function nearestFrequencyIndex(rate: number): number {
  let best = 0;
  AAC_FREQUENCIES.forEach((frequency, i) => {
    if (Math.abs(frequency - rate) < Math.abs(AAC_FREQUENCIES[best] - rate)) best = i;
  });
  return best;
}

// The 7-byte ADTS header (ISO 13818-7, 6.2) for one AAC frame of `length` bytes.
function adtsHeader(config: AacConfig, length: number): Uint8Array {
  const total = length + 7;
  const profile = config.objectType - 1;
  return new Uint8Array([
    0xff,
    0xf1, // sync word, MPEG-4, no checksum
    (profile << 6) | (config.frequencyIndex << 2) | (config.channels >> 2),
    ((config.channels & 3) << 6) | (total >> 11),
    (total >> 3) & 0xff,
    ((total & 7) << 5) | 0x1f,
    0xfc,
  ]);
}
