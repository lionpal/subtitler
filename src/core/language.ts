// Where a subtitle line may be broken, which depends on the language.
//
// Languages written with spaces between words break at a space. Japanese, Chinese and Thai are
// written without them, and a break between two characters can land in the middle of a word or
// phrase. For those we use BudouX, Google's line-breaking model, trained on where a reader expects
// a phrase to end (src/core/vendor/budoux). It splits ハイターが二日酔いで役に立たなかった
// into ハイターが | 二日酔いで | 役に | 立たなかった. The few other languages written without
// spaces (Lao, Khmer, Burmese, Tibetan) use the word segmenter built into JavaScript.

import { model as japanese } from "./vendor/budoux/models/ja.ts";
import { model as thai } from "./vendor/budoux/models/th.ts";
import { model as simplifiedChinese } from "./vendor/budoux/models/zh-hans.ts";
import { model as traditionalChinese } from "./vendor/budoux/models/zh-hant.ts";
import { Parser } from "./vendor/budoux/parser.ts";

export type LanguageRules = {
  // Positions in `text` where a new line may start, and among them the best ones: right after
  // punctuation, which a break uses when it can.
  lineStarts(text: string): { allowed: Set<number>; preferred: Set<number> };
};

const BUDOUX_MODELS: Record<string, Record<string, Record<string, number>>> = {
  ja: japanese,
  zh: simplifiedChinese,
  yue: traditionalChinese, // Cantonese is usually written in traditional characters
  th: thai,
};
const SEGMENTED_BY_JAVASCRIPT = new Set(["lo", "km", "my", "bo"]);

export function rulesFor(language: string | null): LanguageRules {
  if (language !== null && language in BUDOUX_MODELS) return phrases(new Parser(BUDOUX_MODELS[language]));
  if (language !== null && SEGMENTED_BY_JAVASCRIPT.has(language)) return words(language);
  return spaced;
}

const spaced: LanguageRules = {
  lineStarts(text) {
    const allowed = new Set<number>();
    for (let i = 1; i < text.length; i++) {
      if (text[i - 1] === " " && text[i] !== " ") allowed.add(i);
    }
    return withPreferred(text, allowed);
  },
};

function phrases(parser: Parser): LanguageRules {
  return { lineStarts: (text) => withPreferred(text, new Set(parser.parseBoundaries(text))) };
}

function words(language: string): LanguageRules {
  const segmenter = new Intl.Segmenter(language, { granularity: "word" });
  return {
    lineStarts(text) {
      const allowed = new Set([...segmenter.segment(text)].map((segment) => segment.index).filter((index) => index > 0));
      return withPreferred(text, allowed);
    },
  };
}

// The allowed starts that follow punctuation (Unicode's own "punctuation" category), ignoring spaces.
function withPreferred(text: string, allowed: Set<number>) {
  const preferred = new Set([...allowed].filter((index) => /\p{P}$/u.test(text.slice(0, index).trimEnd())));
  return { allowed, preferred };
}
