#!/usr/bin/env node
// subtitle.lol on the command line: pick videos in the current folder and write an .srt next to each.
// The work itself is in src/core/pipeline.ts, shared with the web page. This file reads the
// options, shows the lists in the terminal and prints what happens.

import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Folder, isMediaName } from "../core/folder.ts";
import { ApiError, errorMessage } from "../core/http.ts";
import {
  audioLanguagesOffered,
  describeStatus,
  formatDuration,
  isDone,
  prepare,
  type Prepared,
  secondsToTranscribe,
  subtitle,
  twoLetterLanguage,
} from "../core/pipeline.ts";
import { DEFAULT_SCRIBE_MODEL, elevenLabsScribe } from "../core/speech/elevenlabs.ts";
import { DEFAULT_GEMINI_MODEL, geminiTranslator } from "../core/translation/gemini.ts";
import { languageName } from "../core/translation/translate.ts";
import { type ApiKey, findApiKey, forgetSavedKey, KEY_FILE } from "./key.ts";
import { type ApiKeyInfo, ELEVENLABS_KEY as ELEVENLABS, GEMINI_KEY as GEMINI } from "../core/services.ts";
import { record, say, warn } from "./log.ts";
import { nodeFolder } from "./node-folder.ts";
import { pickMany, pickOne } from "./picker.ts";

const HELP = `
Usage: subtitler [options] [files...]

Run it in a folder of videos, such as a Plex library folder. It lists them,
you pick which to subtitle, and it writes a subtitle file such as
Episode 1.en.srt next to Episode 1.mp4, where Plex and most players find it.

Name files to list only those, e.g. subtitler Episode* or subtitler "Season 1"/*.mkv

Options:
  --all              skip the picker; subtitle every video that has no .srt yet
  --audio <code>     for videos with several audio tracks, the language to use, e.g. ja
                     (default: ask, or the first track when there is no terminal)
  --language <code>  spoken language, e.g. en or fr (default: the track's language
                     tag, or detect it)
  --model <id>       ElevenLabs model (default: scribe_v2)
  --translate <code> also write a translation, e.g. --translate en writes
                     Episode 1.en.srt from Episode 1.ja.srt, using Gemini
  --translate-model <id>  Gemini model (default: gemini-3.8-flash)
  --concurrency <n>  files worked on at once (default: 2)
  -h, --help         show this help

The first run asks for your ElevenLabs API key (and Gemini's, to translate)
and saves it in .env next to the program. ELEVENLABS_API_KEY and GEMINI_API_KEY
in the environment are used instead when set.
`;

async function main(): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      audio: { type: "string" },
      language: { type: "string" },
      model: { type: "string", default: DEFAULT_SCRIBE_MODEL },
      translate: { type: "string" },
      "translate-model": { type: "string", default: DEFAULT_GEMINI_MODEL },
      concurrency: { type: "string", default: "2" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (flags.help) {
    console.log(HELP.trim());
    return 0;
  }
  record(`--- started in ${process.cwd()} with arguments: ${process.argv.slice(2).join(" ") || "(none)"}`);

  const concurrency = Number(flags.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    warn(`--concurrency must be a whole number of at least 1, not "${flags.concurrency}"`);
    return 1;
  }
  const translateTo = twoLetterLanguage(flags.translate);
  if (flags.translate && translateTo === null) {
    warn(`--translate needs a language code such as en or fr, not "${flags.translate}"`);
    return 1;
  }

  const elevenLabsKey = await findApiKey(ELEVENLABS);
  if (elevenLabsKey === null) return missingKey(ELEVENLABS);
  record(elevenLabsKey.savedInFile ? `using the ElevenLabs key saved in ${KEY_FILE}` : "using ELEVENLABS_API_KEY");
  let geminiKey: ApiKey | null = null;
  if (translateTo !== null) {
    geminiKey = await findApiKey(GEMINI);
    if (geminiKey === null) return missingKey(GEMINI);
  }

  const videos = findVideos(positionals);
  if (typeof videos === "string") {
    warn(videos);
    return 1;
  }

  // Look inside every video first: its length, its audio tracks, what is already done.
  const choices = { audioLanguage: twoLetterLanguage(flags.audio), language: twoLetterLanguage(flags.language) };
  let prepared = await Promise.all(videos.map((video) => prepare(video, choices)));
  const speech = elevenLabsScribe(elevenLabsKey.value, flags.model);
  const estimateCost = await speech.costEstimator();

  // An anime .mkv often has a Japanese and an English soundtrack. Choose one language for all of them.
  const offered = audioLanguagesOffered(prepared.map((p) => p.info));
  if (offered.length > 0 && choices.audioLanguage === null) {
    if (!process.stdin.isTTY || flags.all) {
      say("Some videos have several audio tracks; using the first. Choose another with --audio, e.g. --audio ja.");
    } else {
      const names = offered.map((code) => (code === null ? "Untagged track" : `${languageName(code)} (${code})`));
      const picked = await pickOne("Some videos have more than one audio track. Which language?", names);
      if (picked === null) return 0;
      choices.audioLanguage = offered[picked];
      prepared = await Promise.all(videos.map((video) => prepare(video, choices)));
    }
  }
  record(`audio language: ${choices.audioLanguage ?? "first track"}`);

  const describeWork = (selected: number[]) => {
    const seconds = selected.reduce((sum, i) => sum + secondsToTranscribe(prepared[i]), 0);
    return `${formatDuration(seconds)} to transcribe\n${estimateCost(seconds)}`;
  };

  // Decide what to work on.
  let chosen: number[];
  if (flags.all) {
    chosen = prepared.flatMap((p, i) => (isDone(p, translateTo) ? [] : [i]));
  } else if (!process.stdin.isTTY) {
    warn("Not an interactive terminal, so there is no picker. Use --all to subtitle every video without an .srt.");
    return 1;
  } else {
    const rows = prepared.map((p) => {
      const status = describeStatus(p, translateTo);
      const tracks = p.info.audioTracks;
      const note = [
        p.info.durationSeconds === null ? "" : formatDuration(p.info.durationSeconds),
        tracks.length > 1 ? `audio: ${tracks.map((t) => twoLetterLanguage(t.language) ?? "?").join(", ")}` : "",
        status.text,
      ];
      return { label: label(p), note: note.filter(Boolean).join(" · "), color: status.color, selected: false };
    });
    const footer = (selected: number[]) => `${selected.length} selected · ${describeWork(selected)}`;
    const picked = await pickMany("Pick the files to subtitle (green ones are done)", rows, footer);
    if (picked === null) {
      record("quit from the picker");
      return 0;
    }
    chosen = picked;
  }

  record(`chosen: ${chosen.map((i) => label(prepared[i])).join(", ") || "(none)"}`);
  if (chosen.length === 0) {
    say("Nothing to do.");
    return 0;
  }
  say(`${chosen.length} ${chosen.length === 1 ? "file" : "files"} · ${describeWork(chosen).replace("\n", " · ")}`);
  process.on("SIGINT", () => {
    say("\nStopped. Finished subtitles are kept; run again to do the rest.");
    process.exit(130);
  });

  const settings = {
    speech,
    translation:
      translateTo && geminiKey
        ? { translator: geminiTranslator(geminiKey.value, flags["translate-model"], (m: string) => say(`… Gemini: ${m}`)), to: translateTo }
        : null,
  };

  const queue = [...chosen];
  const failures: string[] = [];
  let stopEverything = false;

  async function worker() {
    while (queue.length > 0 && !stopEverything) {
      const item = prepared[queue.shift()!];
      const name = label(item);
      const startedAt = Date.now();
      try {
        const how = await subtitle(item, settings, (_step, message) => say(`… ${name}: ${message}`));
        say(`✓ ${name}: ${how} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      } catch (error) {
        failures.push(name);
        say(`✗ ${name}: ${errorMessage(error)}`);
        if (error instanceof Error && error.stack) record(error.stack);
        // A rejected key will fail every other file the same way.
        if (error instanceof ApiError && error.isKeyProblem && !stopEverything) {
          stopEverything = true;
          const [service, key] = error.service === "Gemini" ? [GEMINI, geminiKey] : [ELEVENLABS, elevenLabsKey];
          if (key?.savedInFile) {
            forgetSavedKey(service);
            say(`${service.name} rejected the saved key, so it was removed from ${KEY_FILE}. Run again to enter a new one.`);
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const done = chosen.length - failures.length - queue.length;
  say(`\n${done} of ${chosen.length} done.`);
  if (failures.length > 0 || queue.length > 0) {
    say("Run again to retry. Files that finished are skipped.");
    return 1;
  }
  return 0;
}

// The videos named on the command line (Episode* also matches Episode*.srt, so other files are skipped),
// or every video in the current folder. Returns a message when there are none.
function findVideos(paths: string[]): { folder: Folder; name: string }[] | string {
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length > 0) return `No such file: ${missing.join(", ")}`;

  const files =
    paths.length > 0
      ? [...new Set(paths.map((path) => resolve(path)))]
      : readdirSync(process.cwd()).map((name) => join(process.cwd(), name));
  const videos = files
    .filter((path) => isMediaName(basename(path)) && statSync(path).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (videos.length === 0) {
    return paths.length > 0 ? "None of those are video or audio files." : `No video or audio files in ${process.cwd()}`;
  }

  // One Folder per directory, shared by the videos in it.
  const folders = new Map<string, Folder>();
  return videos.map((path) => {
    const directory = dirname(path);
    if (!folders.has(directory)) folders.set(directory, nodeFolder(directory, directory.replace(homedir(), "~")));
    return { folder: folders.get(directory)!, name: basename(path) };
  });
}

// How a video is shown: its path from the current folder when it is inside it, otherwise its name
// first, so a long folder path cut off at the edge of the terminal still shows which file it is.
function label(prepared: Prepared): string {
  const { folder, name } = prepared.video;
  const directory = folder.label.replace(/^~/, homedir());
  const path = relative(process.cwd(), join(directory, name));
  return path.startsWith("..") ? `${name} (in ${folder.label})` : path;
}

function missingKey(service: ApiKeyInfo): number {
  warn(`No ${service.name} API key. Create one at ${service.keysPage}, then either`);
  warn(`run subtitler in a terminal and paste it when asked, or set ${service.variable}.`);
  return 1;
}

main().then(
  (exitCode) => process.exit(exitCode),
  (error) => {
    warn(errorMessage(error));
    if (error instanceof Error && error.stack) record(error.stack);
    process.exit(1);
  },
);
