// Subtitling one video, from start to finish, the same way on the command line and on the web page:
// look at what the file holds and what is already done, copy out the audio track, transcribe it
// (or reuse the transcript saved last time), write the .srt, and translate it if asked.

import { baseName, CACHE_FOLDER, type Folder } from "./folder.ts";
import { extractAudio, type MediaInfo, probeMedia } from "./media/media.ts";
import type { SpeechToText, Transcript } from "./speech/provider.ts";
import { cuesToSrt, wordsToCues } from "./srt.ts";
import type { Translator } from "./translation/provider.ts";
import { buildGlossary, type GlossaryEntry, languageName, translateLines } from "./translation/translate.ts";

const MAX_UPLOAD_BYTES = 5 * 1000 ** 3; // the ElevenLabs limit for one file

export type Video = { folder: Folder; name: string };

// Everything known about a video before any work is done on it.
export type Prepared = {
  video: Video;
  info: MediaInfo;
  track: number; // which audio track to use, 0 for the first
  language: string | null; // two-letter code of the speech, when known before transcribing
  saved: Transcript | null; // the transcript paid for on an earlier run, if any
  subtitles: string[]; // languages of the .srt files already next to it; "" for a plain .srt
};

export type Choices = {
  audioLanguage: string | null; // for videos with several audio tracks
  language: string | null; // the spoken language, when the user sets it
};

export type Settings = {
  speech: SpeechToText;
  translation: { translator: Translator; to: string } | null;
};

// The steps of the work, in order, so a page can show each one as it happens.
export type Step = "audio" | "transcribe" | "subtitles" | "glossary" | "translate";
export type Report = (step: Step, message: string) => void;

type SavedTranscript = {
  sourceBytes: number; // size of the video it came from, to notice a replaced file
  service: string; // which speech-to-text service made it
  transcript: Transcript;
};

export async function prepare(video: Video, choices: Choices): Promise<Prepared> {
  const file = await video.folder.open(video.name);
  const info = await probeMedia(file).catch(() => ({ durationSeconds: null, audioTracks: [] }));
  const tracks = info.audioTracks;
  const wanted = tracks.findIndex((t) => twoLetterLanguage(t.language) === choices.audioLanguage);
  const track = wanted >= 0 ? wanted : 0;
  const language = choices.language ?? twoLetterLanguage(tracks[track]?.language) ?? null;
  return {
    video,
    info,
    track,
    language,
    saved: await readSavedTranscript(video, track, file.size),
    subtitles: await subtitleLanguages(video),
  };
}

// The audio languages to offer when some of the videos have more than one track.
export function audioLanguagesOffered(infos: MediaInfo[]): (string | null)[] {
  const several = infos.filter((info) => info.audioTracks.length > 1);
  return [...new Set(several.flatMap((info) => info.audioTracks.map((t) => twoLetterLanguage(t.language))))];
}

// Done means a subtitle in the language we would write (any subtitle when that is not known until
// ElevenLabs hears it), and the translation too when one is asked for.
export function isDone(prepared: Prepared, translateTo: string | null): boolean {
  const has = (language: string | null) =>
    language === null ? prepared.subtitles.length > 0 : prepared.subtitles.includes(language);
  return has(prepared.language) && (translateTo === null || has(translateTo));
}

export type Status = { text: string; color: "green" | "yellow" | "plain" };

export function describeStatus(prepared: Prepared, translateTo: string | null): Status {
  const existing = prepared.subtitles.map((code) => code || "srt").join(", ");
  if (isDone(prepared, translateTo)) return { text: `✓ subtitles: ${existing}`, color: "green" };
  if (prepared.saved) return { text: "transcribed, .srt missing (free to rebuild)", color: "yellow" };
  if (existing) return { text: `subtitles: ${existing}`, color: "plain" };
  return { text: "", color: "plain" };
}

// Seconds of audio that would be paid for, for the cost estimate.
export function secondsToTranscribe(prepared: Prepared): number {
  return prepared.saved ? 0 : (prepared.info.durationSeconds ?? 0);
}

// Does the work, reporting each step as it starts, and says how it went, e.g. "transcribed,
// translated to English".
export async function subtitle(prepared: Prepared, settings: Settings, report: Report): Promise<string> {
  const { video } = prepared;
  let transcript = prepared.saved;
  let how = "rebuilt from the saved transcript (no charge)";

  if (transcript !== null) {
    report("transcribe", "using the transcript saved last time, at no charge");
  } else {
    const file = await video.folder.open(video.name);
    const trackInfo = prepared.info.audioTracks[prepared.track];

    let upload: Blob = file;
    let uploadName = video.name;
    if (trackInfo?.canExtract) {
      report("audio", `copying out the ${trackInfo.language ? languageName(twoLetterLanguage(trackInfo.language)!) + " " : ""}audio`);
      const audio = await extractAudio(file, prepared.track);
      if (audio) {
        upload = audio.bytes;
        uploadName = `${baseName(video.name)}.${audio.extension}`;
      }
    }
    if (upload === file && prepared.track > 0) {
      throw new Error(`audio track ${prepared.track + 1} is ${trackInfo?.codec}, which cannot be copied out yet`);
    }
    if (upload.size > MAX_UPLOAD_BYTES) throw new Error("larger than the 5 GB ElevenLabs limit");

    report("transcribe", `transcribing with ${settings.speech.name}`);
    transcript = await settings.speech.transcribe(upload, uploadName, {
      language: prepared.language ?? undefined,
      onRetry: (message) => report("transcribe", message),
    });

    // Save the transcript first. If anything after this fails, the next run starts from it for free.
    const saved: SavedTranscript = { sourceBytes: file.size, service: settings.speech.name, transcript };
    await video.folder.writeText(savedTranscriptPath(video, prepared.track), JSON.stringify(saved));
    how = "transcribed";
  }

  const language = twoLetterLanguage(prepared.language ?? transcript.language) ?? transcript.language;
  const cues = wordsToCues(transcript.words, language);
  if (cues.length === 0) throw new Error("no speech found");
  const name = srtName(video.name, language);
  await video.folder.writeText(name, cuesToSrt(cues, language));
  report("subtitles", `${cues.length} subtitles written to ${name}`);

  const translation = settings.translation;
  if (translation && translation.to !== language && !prepared.subtitles.includes(translation.to)) {
    const context = { title: baseName(video.name), from: language, to: translation.to };
    const lines = cues.map((cue) => cue.text);
    report("glossary", `finding names and terms with ${translation.translator.name}`);
    const glossary = await updateGlossary(video.folder, lines, context, translation.translator);
    report("glossary", glossary.length === 1 ? "1 name or term" : `${glossary.length} names and terms`);
    report("translate", `translating into ${languageName(translation.to)}`);
    const translated = await translateLines(translation.translator, lines, context, glossary, (done, total) =>
      report("translate", `${done} of ${total} lines translated`),
    );
    const translatedCues = cues.map((cue, i) => ({ ...cue, text: translated[i] }));
    const translatedName = srtName(video.name, translation.to);
    await video.folder.writeText(translatedName, cuesToSrt(translatedCues, translation.to));
    report("translate", `written to ${translatedName}`);
    how += `, translated to ${languageName(translation.to)}`;
  }
  return how;
}

// The names and terms for one language pair, shared by every video in a folder so a series keeps
// the same names from episode to episode. It is a plain JSON file you can correct by hand; entries
// already in it are kept as they are. Videos in the same folder add to it one at a time.
const glossaryUpdates = new Map<string, Promise<GlossaryEntry[]>>();

function updateGlossary(
  folder: Folder,
  lines: string[],
  context: { title: string; from: string; to: string },
  translator: Translator,
): Promise<GlossaryEntry[]> {
  const path = `${CACHE_FOLDER}/glossary.${context.from}-${context.to}.json`;
  const key = `${folder.label}/${path}`;
  const next = (glossaryUpdates.get(key) ?? Promise.resolve([]))
    .catch(() => [])
    .then(async () => {
      const text = await folder.readText(path);
      const known: GlossaryEntry[] = text ? JSON.parse(text) : [];
      const glossary = await buildGlossary(translator, lines, context, known);
      await folder.writeText(path, JSON.stringify(glossary, null, 2) + "\n");
      return glossary;
    });
  glossaryUpdates.set(key, next);
  return next;
}

// Plex, VLC and IINA load "Episode 1.en.srt" next to "Episode 1.mp4" by themselves, and the
// language code is how Plex labels the track.
function srtName(videoName: string, language: string): string {
  const code = twoLetterLanguage(language);
  return code ? `${baseName(videoName)}.${code}.srt` : `${baseName(videoName)}.srt`;
}

// "Episode 1.en.srt" gives "en", a plain "Episode 1.srt" gives "".
async function subtitleLanguages(video: Video): Promise<string[]> {
  const name = baseName(video.name);
  return (await video.folder.list()).flatMap((other) => {
    if (!other.startsWith(name + ".") || !other.endsWith(".srt")) return [];
    const middle = other.slice(name.length + 1, -".srt".length);
    if (middle === "") return [""];
    const code = /^[a-z]{2,3}$/.test(middle) ? twoLetterLanguage(middle) : null;
    return code ? [code] : [];
  });
}

// Transcripts of the first audio track keep the plain name; other tracks get their number.
function savedTranscriptPath(video: Video, track: number): string {
  return `${CACHE_FOLDER}/${video.name}${track > 0 ? `.track${track}` : ""}.json`;
}

// The saved transcript, or null if there is none or the video has since changed.
async function readSavedTranscript(video: Video, track: number, sourceBytes: number): Promise<Transcript | null> {
  try {
    const text = await video.folder.readText(savedTranscriptPath(video, track));
    if (text === null) return null;
    const saved = JSON.parse(text) as SavedTranscript;
    if (saved.sourceBytes !== sourceBytes) return null;
    // Transcripts saved by the first version kept ElevenLabs' own field name.
    const transcript = saved.transcript as Transcript & { language_code?: string };
    return { language: transcript.language ?? transcript.language_code ?? "", words: transcript.words };
  } catch {
    return null; // unreadable: treat as missing and transcribe again
  }
}

// "jpn" -> "ja", "eng" -> "en". Plex and ElevenLabs both read two-letter codes. A language with no
// two-letter code keeps its three letters; "und" (undetermined) and anything unreadable become null.
export function twoLetterLanguage(code: string | null | undefined): string | null {
  if (!code || code === "und") return null;
  try {
    return new Intl.Locale(code).language;
  } catch {
    return null;
  }
}

// 4712 -> "1h 18m"
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
