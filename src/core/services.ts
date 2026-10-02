// The services subtitle.lol can use, and the key each one needs. The web page builds its menus from
// these lists and the command line its key prompts, so a new service is added here once.

import { elevenLabsScribe } from "./speech/elevenlabs.ts";
import type { SpeechToText } from "./speech/provider.ts";
import { geminiTranslator } from "./translation/gemini.ts";
import type { Translator } from "./translation/provider.ts";

export type ApiKeyInfo = {
  name: string; // "ElevenLabs", "Gemini"
  variable: string; // the environment variable the command line reads, "ELEVENLABS_API_KEY"
  keysPage: string; // where to create a key
};

export const ELEVENLABS_KEY: ApiKeyInfo = {
  name: "ElevenLabs",
  variable: "ELEVENLABS_API_KEY",
  keysPage: "https://elevenlabs.io/app/settings/api-keys",
};

export const GEMINI_KEY: ApiKeyInfo = {
  name: "Gemini",
  variable: "GEMINI_API_KEY",
  keysPage: "https://aistudio.google.com/apikey",
};

export const SPEECH_SERVICES: { id: string; label: string; key: ApiKeyInfo; create(key: string): SpeechToText }[] = [
  { id: "scribe_v2", label: "ElevenLabs Scribe v2", key: ELEVENLABS_KEY, create: (key) => elevenLabsScribe(key, "scribe_v2") },
];

export const TRANSLATION_SERVICES: {
  id: string;
  label: string;
  key: ApiKeyInfo;
  create(key: string, onRetry?: (message: string) => void): Translator;
}[] = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    key: GEMINI_KEY,
    create: (key, onRetry) => geminiTranslator(key, "gemini-3.8-flash", onRetry),
  },
];

// Languages offered for translation, as two-letter codes.
export const TRANSLATION_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi", "nl", "pl", "tr", "vi", "id", "th"];
