import assert from "node:assert/strict";
import { test } from "node:test";
import { cuesToSrt, formatTime, wordsToCues, type Word } from "../src/core/srt.ts";

// Builds the word list ElevenLabs returns: words with spacing tokens between them.
function speech(...words: [text: string, start: number, end: number][]): Word[] {
  return words.flatMap(([text, start, end], i) => {
    const word: Word = { text, start, end, type: "word" };
    if (i === 0) return [word];
    const space: Word = { text: " ", start: words[i - 1][2], end: start, type: "spacing" };
    return [space, word];
  });
}

test("formats SRT timestamps", () => {
  assert.equal(formatTime(0), "00:00:00,000");
  assert.equal(formatTime(3723.5), "01:02:03,500");
  assert.equal(formatTime(59.9996), "00:01:00,000");
});

test("joins words into one cue and writes valid SRT", () => {
  const cues = wordsToCues(speech(["Hello", 1, 1.4], ["world.", 1.5, 2]), "en");
  assert.deepEqual(cues, [{ start: 0.8, end: 2, text: "Hello world." }]);
  assert.equal(cuesToSrt(cues, "en"), "1\n00:00:00,800 --> 00:00:02,000\nHello world.\n");
});

test("starts a new cue after a pause", () => {
  const cues = wordsToCues(speech(["One", 0, 0.5], ["two", 3, 3.5]), "en");
  assert.deepEqual(cues.map((cue) => cue.text), ["One", "two"]);
});

test("ends each cue before the next one starts", () => {
  // "Hi" is short, so it is stretched toward one second, but "there" starts sooner.
  const cues = wordsToCues(speech(["Hi", 0, 0.2], ["there", 0.9, 1.2]), "en");
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].end <= cues[i + 1].start);
  }
});

test("splits long text into cues of at most two 42-character lines", () => {
  const words = Array.from({ length: 60 }, (_, i) => ["word" + i, i * 0.3, i * 0.3 + 0.25] as [string, number, number]);
  const srt = cuesToSrt(wordsToCues(speech(...words), "en"), "en");
  for (const block of srt.trim().split("\n\n")) {
    const textLines = block.split("\n").slice(2);
    assert.ok(textLines.length <= 2, block);
    assert.ok(textLines.join(" ").length <= 84, block);
  }
});

test("ignores sound tags and words without timings", () => {
  const cues = wordsToCues(
    [
      { text: "(music)", start: 0, end: 2, type: "audio_event" },
      { text: "Speech", start: null, end: null, type: "word" },
      { text: "starts.", start: 3, end: 3.5, type: "word" },
    ],
    "en",
  );
  assert.deepEqual(cues.map((cue) => cue.text), ["starts."]);
});

test("joins Japanese characters without spaces and wraps them by width", () => {
  const text = "魔王を倒したからといって終わりじゃない。この先の人生の方が長いんだ。";
  const words: Word[] = [...text].map((character, i) => ({ text: character, start: i * 0.1, end: i * 0.1 + 0.08, type: "word" }));
  const srt = cuesToSrt(wordsToCues(words, "ja"), "ja");
  const textLines = srt.split("\n").filter((line) => line !== "" && !line.includes("-->") && !/^\d+$/.test(line));
  assert.ok(srt.includes("魔王を倒したからといって終わりじゃない。"), srt);
  for (const line of textLines) {
    assert.ok(!line.includes(" "), line);
    assert.ok([...line].length <= 21, line);
  }
});

// Japanese phrases as BudouX finds them; a break anywhere else would land inside one.
function japanesePhrases(text: string): string[] {
  return wordsToCues([...text].map((character, i) => ({ text: character, start: i * 0.1, end: i * 0.1 + 0.08, type: "word" as const })), "ja")
    .flatMap((cue) => cuesToSrt([cue], "ja").split("\n").slice(2))
    .filter((line) => line !== "");
}

test("wraps a Japanese line between phrases, not inside a word", () => {
  const lines = japanesePhrases("ハイターが二日酔いで役に立たなかったこともあったな。");
  assert.ok(lines.length === 2, lines.join(" / "));
  assert.ok(!lines.some((line) => line.startsWith("たなかった")), lines.join(" / "));
  assert.ok(lines.join("") === "ハイターが二日酔いで役に立たなかったこともあったな。");
});

test("cuts a slowly spoken Japanese sentence between phrases", () => {
  // Spoken slowly, so the six-second limit forces a cut partway through.
  const text = "それがかつてこの地に影を落とした悪を打ち取る勇者との短い旅の記憶。";
  const words: Word[] = [...text].map((character, i) => ({ text: character, start: i * 0.3, end: i * 0.3 + 0.25, type: "word" }));
  const cues = wordsToCues(words, "ja");
  assert.ok(cues.length > 1);
  const phraseEnds = ["それが", "かつて", "この", "地に", "影を", "落とした", "悪を", "打ち取る", "勇者との", "短い旅の"];
  for (const cue of cues.slice(0, -1)) assert.ok(phraseEnds.some((end) => cue.text.endsWith(end)), cue.text);
});

test("never breaks an English word in two, even when no space gives two short lines", () => {
  const text = "This series, The Story of the Sea, is about an old subject, almost 100 years old,";
  const words: Word[] = text.split(" ").flatMap((word, i) => {
    const spoken: Word = { text: word, start: i * 0.3, end: i * 0.3 + 0.25, type: "word" };
    return i === 0 ? [spoken] : [{ text: " ", start: i * 0.3 - 0.05, end: i * 0.3, type: "spacing" } as Word, spoken];
  });
  const srt = cuesToSrt(wordsToCues(words, "en"), "en");
  for (const line of srt.split("\n").filter((line) => /[a-z]/.test(line))) {
    for (const piece of line.split(" ")) assert.ok(text.split(" ").includes(piece), `"${piece}" is not a whole word in: ${line}`);
  }
});
