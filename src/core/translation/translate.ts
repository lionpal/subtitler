// Translates subtitle lines with a language model, in two steps:
//
// 1. A glossary. The model reads the whole episode and lists every name and special term (people,
//    places, spells, items) with the form the official translation uses, if it knows the show.
//    Names are where machine translation goes wrong most visibly, and speech recognition mishears
//    them too, so the glossary also records misheard spellings found in the transcript. It is
//    saved with the videos, where you can correct it, and later episodes start from it.
// 2. The lines, in batches, each request carrying the glossary and the lines just before it.
//    The answer must give exactly one translation for every line id, or the batch is asked again.

import type { Translator } from "./provider.ts";

export type GlossaryEntry = {
  source: string; // the correct spelling in the spoken language, e.g. "聖都"
  translation: string; // e.g. "holy city"
  kind: "person" | "place" | "group" | "title" | "magic" | "item" | "other";
  heardAs: string[]; // misheard spellings in the transcript, e.g. ["生徒"]
  foundAt: string; // the web page the translation came from, or "" if the model answered from memory
};

export type TranslationContext = {
  title: string; // the video's file name, which usually names the show
  from: string; // language code, e.g. "ja"
  to: string; // e.g. "en"
};

const BATCH_SIZE = 50;
const LINES_OF_CONTEXT = 8;
const BATCHES_AT_ONCE = 4;

const GLOSSARY_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          translation: { type: "string" },
          kind: { type: "string", enum: ["person", "place", "group", "title", "magic", "item", "other"] },
          heardAs: { type: "array", items: { type: "string" } },
          foundAt: { type: "string" },
        },
        required: ["source", "translation", "kind", "heardAs", "foundAt"],
      },
    },
  },
  required: ["entries"],
};

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
      },
    },
  },
  required: ["lines"],
};

export async function buildGlossary(
  translator: Translator,
  lines: string[],
  context: TranslationContext,
  known: GlossaryEntry[],
): Promise<GlossaryEntry[]> {
  const from = languageName(context.from);
  const to = languageName(context.to);
  const instructions = [
    `These are subtitles of "${context.title}", transcribed from ${from} speech by speech recognition.`,
    `List every proper noun and special term in them: people, places, groups, titles, spells, items.`,
    `For each, search for the ${to} form the official ${to} release uses and give the page you found it on in foundAt. If there is none, give the usual romanization and leave foundAt empty.`,
    `Speech recognition mishears names and terms. Put the correct ${from} spelling in source. In heardAs, list the wrong spellings that appear in these subtitles instead of it, or nothing.`,
    known.length > 0 ? `The known entries are already checked; keep them as they are and add any that are missing.` : "",
  ].join("\n");
  const request = JSON.stringify({ known, subtitles: lines });

  const answer = (await translator.generateJson(instructions, request, GLOSSARY_SCHEMA, { webSearch: true })) as {
    entries: GlossaryEntry[];
  };
  return mergeGlossaries(known, answer.entries);
}

export async function translateLines(
  translator: Translator,
  lines: string[],
  context: TranslationContext,
  glossary: GlossaryEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const from = languageName(context.from);
  const to = languageName(context.to);
  const instructions = [
    `Translate subtitles of "${context.title}" from ${from} to ${to}.`,
    `Each line is one subtitle on screen. Give exactly one translation for every id in "translate", short enough to read at a glance.`,
    `A sentence can run across several lines; translate each line so that, read in order, they form natural ${to}.`,
    `Use the glossary for every name and term. The ${from} came from speech recognition; where a word is misheard, translate what was meant.`,
    `Add no quotation marks or notes of your own.`,
    `"before" holds the lines just ahead, for context only.`,
  ].join("\n");

  // Batches go out a few at a time. Each carries the source lines before it as context, so they
  // do not depend on each other's answers.
  const batchStarts = range(0, Math.ceil(lines.length / BATCH_SIZE)).map((n) => n * BATCH_SIZE);
  const translations: string[] = new Array(lines.length);
  let done = 0;

  async function translateFrom(first: number) {
    const ids = range(first, Math.min(first + BATCH_SIZE, lines.length));
    const request = JSON.stringify({
      glossary: glossary.map(({ source, translation, heardAs }) => ({ source, translation, heardAs })),
      before: lines.slice(Math.max(0, first - LINES_OF_CONTEXT), first),
      translate: ids.map((id) => ({ id, text: lines[id] })),
    });

    // Ask again if any line comes back missing or empty.
    let batch = await translateBatch(translator, instructions, request, ids);
    if (batch === null) batch = await translateBatch(translator, instructions, request, ids);
    if (batch === null) throw new Error(`${translator.name} left out some lines between ${first + 1} and ${first + ids.length}`);

    ids.forEach((id, i) => (translations[id] = batch[i]));
    done += ids.length;
    onProgress?.(done, lines.length);
  }

  const queue = [...batchStarts];
  const worker = async () => {
    while (queue.length > 0) await translateFrom(queue.shift()!);
  };
  await Promise.all(range(0, BATCHES_AT_ONCE).map(worker));
  return translations;
}

// The translations in id order, or null if any line is missing or empty.
async function translateBatch(translator: Translator, instructions: string, request: string, ids: number[]): Promise<string[] | null> {
  const answer = (await translator.generateJson(instructions, request, TRANSLATION_SCHEMA)) as {
    lines: { id: number; text: string }[];
  };
  const byId = new Map(answer.lines.map((line) => [line.id, line.text.trim()]));
  const texts = ids.map((id) => byId.get(id) ?? "");
  return texts.every((text) => text !== "") ? texts : null;
}

// Entries already in the glossary win, so a correction you made is never replaced.
function mergeGlossaries(known: GlossaryEntry[], found: GlossaryEntry[]): GlossaryEntry[] {
  const merged = [...known];
  for (const entry of found) {
    if (!merged.some((existing) => existing.source === entry.source)) merged.push(entry);
  }
  return merged;
}

// "ja" -> "Japanese"
export function languageName(code: string): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
