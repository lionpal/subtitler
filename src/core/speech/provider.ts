// What a speech-to-text service has to do: turn audio into words, each with the time it was
// spoken. Subtitles are built from those times, so a service that only returns text will not do.
// ElevenLabs Scribe (elevenlabs.ts) is the first; another service is one more file like it.

import type { Word } from "../srt.ts";

export type Transcript = {
  language: string; // the spoken language as the service names it, e.g. "jpn" or "ja"
  words: Word[];
};

export type SpeechToText = {
  name: string; // shown to the user, e.g. "ElevenLabs Scribe v2"
  transcribe(audio: Blob, fileName: string, options: { language?: string; onRetry?: (message: string) => void }): Promise<Transcript>;
  // Reads whatever the estimate needs (for ElevenLabs, your plan and credits) and returns a
  // function that describes the cost of so many seconds of audio.
  costEstimator(): Promise<(seconds: number) => string>;
};
