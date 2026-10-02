// Turns ElevenLabs' word timings into SubRip (.srt) subtitles.

import { type LanguageRules, rulesFor } from "./language.ts";

export type Word = {
  text: string;
  start: number | null;
  end: number | null;
  type: "word" | "spacing" | "audio_event";
};

export type Cue = {
  start: number; // seconds
  end: number; // seconds
  text: string;
};

type SpokenWord = {
  text: string;
  start: number;
  end: number;
  spaceBefore: boolean; // false between Japanese or Chinese characters, which have no spaces
};

// Readability rules, roughly following broadcast subtitle guidelines. Lengths are in columns:
// a Japanese or Chinese character takes two, so a line holds 42 Latin letters or 21 kanji.
const MAX_LINE_WIDTH = 42;
const MAX_CUE_WIDTH = MAX_LINE_WIDTH * 2; // two lines per cue
const MAX_CUE_SECONDS = 6;
const MIN_CUE_SECONDS = 1;
const PAUSE_SECONDS = 0.8; // a silence this long starts a new cue
const LONG_PAUSE_SECONDS = 2; // and a silence this long always does
const MIN_SENTENCE_CUE_WIDTH = 30; // end a cue at a full stop once it has this much text
const MIN_PAUSE_CUE_WIDTH = 6; // a pause does not split off less text than this
// Every cue starts this much before its first word. See "Timing" in the README for where the
// number comes from.
const LEAD_IN_SECONDS = 0.2;

// A sentence ends at a character Unicode marks as ending one: . ? ! 。 ？ ！ and their kin,
// optionally followed by a closing quote or bracket.
const ENDS_SENTENCE = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}"']?$/u;
const ENDS_WITH_PUNCTUATION = /\p{P}$/u;

// `language` is the two-letter code of the speech, which decides where lines may break.
export function wordsToCues(words: Word[], language: string | null): Cue[] {
  const rules = rulesFor(language);
  // Keep spoken words, remembering where ElevenLabs put a space so the text joins back correctly.
  const spoken: SpokenWord[] = [];
  let sawSpace = false;
  for (const word of words) {
    if (word.type === "spacing") {
      sawSpace = true;
    } else if (word.type === "word" && word.start !== null && word.end !== null) {
      spoken.push({ text: word.text.trim(), start: word.start, end: word.end, spaceBefore: sawSpace });
      sawSpace = false;
    }
  }

  const groups: SpokenWord[][] = [];
  let current: SpokenWord[] = [];

  for (const word of spoken) {
    if (current.length > 0) {
      const first = current[0];
      const last = current[current.length - 1];
      // A sung note held in the middle of a word also looks like a pause, so a short pause only
      // ends a cue once it has a few characters or ends in punctuation.
      const gap = word.start - last.end;
      const isAfterPause =
        gap > LONG_PAUSE_SECONDS ||
        (gap > PAUSE_SECONDS &&
          (displayWidth(joinWords(current)) >= MIN_PAUSE_CUE_WIDTH || ENDS_WITH_PUNCTUATION.test(last.text)));
      const isTooLong = displayWidth(joinWords([...current, word])) > MAX_CUE_WIDTH;
      const isTooSlow = word.end - first.start > MAX_CUE_SECONDS;
      if (isAfterPause || isTooLong || isTooSlow) {
        // Japanese arrives one character at a time, so the cut may land inside a word. Move it
        // back to the last place a reader would expect a break, if there is one.
        const cut = isAfterPause ? current.length : lastGoodBreak([...current, word], rules);
        groups.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }

    current.push(word);

    const endsSentence = ENDS_SENTENCE.test(word.text);
    if (endsSentence && displayWidth(joinWords(current)) >= MIN_SENTENCE_CUE_WIDTH) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const cues = groups.map((group) => {
    const start = Math.max(0, group[0].start - LEAD_IN_SECONDS);
    const end = Math.max(group[group.length - 1].end, start + MIN_CUE_SECONDS);
    return { start, end, text: joinWords(group) };
  });

  // A cue must end before the next one starts, or players show both at once.
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  }

  return cues;
}

// `language` is the language of the cues' text, which decides where lines may break.
export function cuesToSrt(cues: Cue[], language: string | null): string {
  const rules = rulesFor(language);
  return cues
    .map((cue, i) => {
      const number = i + 1;
      const timing = `${formatTime(cue.start)} --> ${formatTime(cue.end)}`;
      return `${number}\n${timing}\n${splitIntoTwoLines(cue.text, rules)}\n`;
    })
    .join("\n");
}

// Where to cut `words` (all but the last of which make the cue so far) so the cue ends at a natural
// break: the last one the language allows, a short silence, or punctuation. Returns how many words
// stay in the cue; if there is no natural break, all of them do.
function lastGoodBreak(words: SpokenWord[], rules: LanguageRules): number {
  const text = joinWords(words);
  const { allowed } = rules.lineStarts(text);
  const starts = wordStarts(words);
  for (let i = words.length - 1; i > 0; i--) {
    const silence = words[i].start - words[i - 1].end > 0.25;
    if (allowed.has(starts[i]) || silence || ENDS_WITH_PUNCTUATION.test(words[i - 1].text)) return i;
  }
  return words.length - 1;
}

// Where each word starts in joinWords(words).
function wordStarts(words: SpokenWord[]): number[] {
  const starts: number[] = [];
  let position = 0;
  words.forEach((word, i) => {
    if (i > 0 && word.spaceBefore) position += 1;
    starts.push(position);
    position += word.text.length;
  });
  return starts;
}

function joinWords(words: SpokenWord[]): string {
  return words.map((word, i) => (i > 0 && word.spaceBefore ? " " : "") + word.text).join("");
}

// Columns a text takes on screen: two for each Japanese, Chinese or Korean character.
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += WIDE.test(character) ? 2 : 1;
  return width;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u;

// Breaks a long cue into two lines near the middle, at a place the language allows, preferring one
// right after punctuation and one that leaves both lines short enough. With no allowed place at
// all (one very long word), the cue stays on one line.
function splitIntoTwoLines(text: string, rules: LanguageRules): string {
  if (displayWidth(text) <= MAX_LINE_WIDTH) return text;

  const { allowed, preferred } = rules.lineStarts(text);
  const firstLine = (i: number) => text.slice(0, i).trimEnd();
  const secondLine = (i: number) => text.slice(i).trimStart();
  const fits = (i: number) => displayWidth(firstLine(i)) <= MAX_LINE_WIDTH && displayWidth(secondLine(i)) <= MAX_LINE_WIDTH;
  const tiers = [[...preferred].filter(fits), [...allowed].filter(fits), [...allowed]];
  const candidates = tiers.find((tier) => tier.length > 0);
  if (candidates === undefined) return text;

  // Within the first tier that has any, take the break closest to the middle.
  const half = displayWidth(text) / 2;
  const distance = (i: number) => Math.abs(displayWidth(firstLine(i)) - half);
  const best = candidates.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return `${firstLine(best)}\n${secondLine(best)}`;
}

// 3723.5 seconds -> "01:02:03,500"
export function formatTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  const ms = totalMs % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}
